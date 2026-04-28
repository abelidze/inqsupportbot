import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';

const DEFAULT_WEB_SEARCH = {
    enabled: true,
    searxngUrl: 'https://searx.perennialte.ch/',
    format: 'json',
    maxResults: 3,
    fetchTimeoutMs: 5000,
    searchTimeoutMs: 5000,
    pageFetchTimeoutMs: 12000,
    readerTimeoutMs: 15000,
    readerFallbackEnabled: true,
    readerBaseUrl: 'https://r.jina.ai/',
    maxContentLength: 900,
    maxContextLength: 2800,
    minQueryLength: 8,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraParams: {
        language: 'all',
    },
};

export class WebSearchService {
    constructor({ config }) {
        const webConfig = config.WEB_SEARCH || {};
        const sanitizedConfig = Object.fromEntries(
            Object.entries(webConfig).filter(([, value]) => value !== undefined)
        );
        const fetchTimeoutMs = this.#parsePositiveInt(
            sanitizedConfig.fetchTimeoutMs,
            DEFAULT_WEB_SEARCH.fetchTimeoutMs,
        );
        const pageFetchTimeoutMs = this.#parsePositiveInt(
            sanitizedConfig.pageFetchTimeoutMs,
            Math.max(fetchTimeoutMs, DEFAULT_WEB_SEARCH.pageFetchTimeoutMs),
        );
        this.config = {
            ...DEFAULT_WEB_SEARCH,
            ...sanitizedConfig,
            fetchTimeoutMs,
            searchTimeoutMs: this.#parsePositiveInt(sanitizedConfig.searchTimeoutMs, fetchTimeoutMs),
            pageFetchTimeoutMs,
            readerTimeoutMs: this.#parsePositiveInt(
                sanitizedConfig.readerTimeoutMs,
                Math.max(pageFetchTimeoutMs, DEFAULT_WEB_SEARCH.readerTimeoutMs),
            ),
            extraParams: {
                ...DEFAULT_WEB_SEARCH.extraParams,
                ...(webConfig.extraParams || {}),
            },
        };
    }

    isEnabled() {
        return Boolean(this.config.enabled && this.config.searxngUrl);
    }

    async buildContext(question) {
        const query = this.#buildSearchQuery(question);
        if (!this.isEnabled() || query.length < this.config.minQueryLength) {
            return null;
        }

        const results = await this.search(query);
        if (results.length === 0) {
            return null;
        }

        const fetchedResults = await Promise.all(
            results
                .slice(0, this.config.maxResults)
                .map((result) => this.#fetchResultContent(result)),
        );

        const sections = [];
        let totalLength = 0;
        for (const [index, result] of fetchedResults.entries()) {
            const section = this.#buildResultSection(index, result);
            if (!section) {
                continue;
            }
            if (sections.length > 0 && totalLength + section.length > this.config.maxContextLength) {
                break;
            }
            sections.push(section);
            totalLength += section.length;
        }

        if (sections.length === 0) {
            return null;
        }

        return {
            query,
            context: [
                'Current web research for the user question. Use these facts only if they help answer accurately.',
                'Do not mention that you performed a web search unless the user explicitly asks.',
                `Search query: ${query}`,
                ...sections,
            ].join('\n\n'),
        };
    }

    async search(query) {
        const searchUrl = new URL('search', this.#normalizeBaseUrl(this.config.searxngUrl));
        searchUrl.searchParams.set('q', query);
        searchUrl.searchParams.set('language', 'ru');
        searchUrl.searchParams.set('safesearch', 0);
        if (this.config.format) {
            searchUrl.searchParams.set('format', this.config.format);
        }
        for (const [key, value] of Object.entries(this.config.extraParams || {})) {
            if (value !== undefined && value !== null && value !== '') {
                searchUrl.searchParams.set(key, String(value));
            }
        }

        try {
            const response = await fetch(searchUrl, {
                headers: {
                    'user-agent': this.config.userAgent,
                    accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
                },
                signal: AbortSignal.timeout(this.config.searchTimeoutMs),
            });
            if (!response.ok) {
                return [];
            }

            const contentType = response.headers.get('content-type') || '';
            if (this.config.format === 'json' && contentType.includes('json')) {
                const data = await response.json();
                return this.#normalizeResults((data.results || []).map((result) => ({
                    url: result.url,
                    title: result.title,
                    snippet: result.content || result.snippet || '',
                })));
            }

            const html = await response.text();
            return this.#parseHtmlResults(html);
        } catch (error) {
            console.error('[WebSearchError]', error?.message || error);
            return [];
        }
    }

    #normalizeBaseUrl(baseUrl) {
        return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    }

    #normalizeResults(results) {
        const seen = new Set();
        return results.filter((result) => {
            const url = this.#normalizeResultUrl(result.url);
            if (!url) {
                return false;
            }
            const key = url.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            result.url = url;
            result.title = this.#trim(this.#normalizeText(result.title || ''), 160);
            result.snippet = this.#trim(this.#normalizeText(result.snippet || ''), 320);
            return true;
        });
    }

    #normalizeResultUrl(value) {
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol)) {
                return null;
            }
            url.hash = '';
            return url.toString();
        } catch {
            return null;
        }
    }

    #parseHtmlResults(html) {
        const $ = cheerio.load(html);
        const results = [];
        $('article.result').each((_, element) => {
            const title = $(element).find('h3').first().text().trim();
            const snippet = $(element).find('.content').first().text().trim();
            const href = $(element).find('a.url_wrapper').attr('href')
                || $(element).find('a').first().attr('href');
            results.push({ url: href, title, snippet });
        });
        return this.#normalizeResults(results);
    }

    async #fetchResultContent(result) {
        const content = await this.#fetchWebContent(result.url);
        return {
            ...result,
            content: content || result.snippet,
        };
    }

    async #fetchWebContent(url) {
        const directContent = await this.#fetchDirectWebContent(url);
        if (directContent) {
            return directContent;
        }

        if (this.config.readerFallbackEnabled) {
            const readerContent = await this.#fetchReaderContent(url);
            if (readerContent) {
                return readerContent;
            }
        }

        return '';
    }

    async #fetchDirectWebContent(url) {
        try {
            const response = await fetch(url, {
                headers: {
                    'user-agent': this.config.userAgent,
                    accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
                    'accept-language': 'ru,en;q=0.9,*;q=0.8',
                    'accept-encoding': 'identity',
                },
                signal: AbortSignal.timeout(this.config.pageFetchTimeoutMs),
            });
            if (!response.ok) {
                return '';
            }

            const contentType = response.headers.get('content-type') || '';
            const rawContent = await response.text();
            return this.#extractReadableText(rawContent, url, contentType);
        } catch (error) {
            return '';
        }
    }

    async #fetchReaderContent(url) {
        try {
            const readerUrl = this.#buildReaderUrl(url);
            const response = await fetch(readerUrl, {
                headers: {
                    'user-agent': this.config.userAgent,
                    accept: 'text/plain,*/*;q=0.8',
                    'accept-language': 'ru,en;q=0.9,*;q=0.8',
                    'x-respond-with': 'text',
                },
                signal: AbortSignal.timeout(this.config.readerTimeoutMs),
            });
            if (!response.ok) {
                return '';
            }

            const text = this.#cleanReaderText(await response.text());
            return this.#trim(text, this.config.maxContentLength);
        } catch {
            return '';
        }
    }

    #buildReaderUrl(url) {
        const baseUrl = this.config.readerBaseUrl.endsWith('/')
            ? this.config.readerBaseUrl
            : `${this.config.readerBaseUrl}/`;
        return `${baseUrl}${url}`;
    }

    #cleanReaderText(text) {
        const normalized = String(text || '').trim();
        const marker = 'Markdown Content:';
        const markerIndex = normalized.indexOf(marker);
        if (markerIndex === -1) {
            return normalized;
        }
        return normalized.slice(markerIndex + marker.length).trim();
    }

    #stripNonContentHtml(html) {
        const $ = cheerio.load(String(html || ''));
        $('script, style, noscript, svg, canvas, iframe, object, embed, link[rel="stylesheet"]').remove();
        $('[style]').removeAttr('style');
        return $.html();
    }

    #extractReadableText(rawContent, url, contentType) {
        const text = String(rawContent || '');
        if (text.length === 0) {
            return '';
        }

        const looksLikeHtml = contentType.includes('html') || /<(html|body|article|main|p)\b/i.test(text);
        if (!looksLikeHtml) {
            return this.#trim(this.#normalizeText(text), this.config.maxContentLength);
        }

        const contentHtml = this.#stripNonContentHtml(text);
        try {
            const virtualConsole = new VirtualConsole();
            virtualConsole.on('error', () => {});
            const dom = new JSDOM(contentHtml, {
                url,
                virtualConsole,
            });
            const article = new Readability(dom.window.document).parse();
            const content = this.#normalizeText(article?.textContent || '');
            if (content.length > 0) {
                return this.#trim(content, this.config.maxContentLength);
            }
        } catch {
            // Some pages ship CSS that trips jsdom/cssstyle. Cheerio fallback below still extracts text.
        }

        const $ = cheerio.load(contentHtml);
        return this.#trim(this.#normalizeText($('body').text() || $.text()), this.config.maxContentLength);
    }

    #buildSearchQuery(question) {
        return this.#trim(
            this.#normalizeText(question)
                .replace(/^@[\w.-]+\s*[:,-]?\s*/i, '')
                .replace(/^[!/?]+/, '')
                .replace(/\s+/g, ' '),
            140,
        );
    }

    #buildResultSection(index, result) {
        const title = result.title || result.url;
        const host = this.#getHost(result.url);
        const snippet = result.snippet || '';
        const content = result.content || '';
        if (!snippet && !content) {
            return null;
        }

        const lines = [`[${index + 1}] ${title}${host ? ` (${host})` : ''}`];
        if (snippet) {
            lines.push(`Snippet: ${snippet}`);
        }
        if (content && content !== snippet) {
            lines.push(`Page extract: ${content}`);
        }
        return lines.join('\n');
    }

    #getHost(value) {
        try {
            return new URL(value).hostname;
        } catch {
            return '';
        }
    }

    #normalizeText(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    #parsePositiveInt(value, fallback) {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    #trim(text, limit) {
        const normalized = this.#normalizeText(text);
        if (normalized.length <= limit) {
            return normalized;
        }

        const sliced = normalized.slice(0, limit);
        const lastBoundary = Math.max(
            sliced.lastIndexOf('. '),
            sliced.lastIndexOf('! '),
            sliced.lastIndexOf('? '),
            sliced.lastIndexOf(' '),
        );
        if (lastBoundary > limit * 0.6) {
            return `${sliced.slice(0, lastBoundary).trim()}...`;
        }
        return `${sliced.trim()}...`;
    }
}
