export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const choose = (choices) => choices[Math.floor(Math.random() * choices.length)];

export const template = (source, tags) => {
    if (tags === undefined) {
        return source;
    }
    let result = source;
    for (const prop in tags) {
        result = result.replace(new RegExp(`{${prop}}`, 'g'), tags[prop]);
    }
    return result;
};

const CYRILLIC_PATTERN = /[А-Яа-яЁё]/;
const ruBoundary = (pattern) => new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${pattern})(?=$|[^\\p{L}\\p{N}_])`, 'iu');

const RUSSIAN_MEMORY_MARKERS = {
    preference: [
        ruBoundary('я\\s+(?:люблю|обожаю|предпочитаю|ненавижу|не\\s+люблю)'),
        ruBoundary('мне\\s+(?:нравится|не\\s+нравится|по\\s+душе)'),
        ruBoundary('мой\\s+(?:любимый|нелюбимый)'),
        ruBoundary('моя\\s+(?:любимая|нелюбимая)'),
        ruBoundary('мое\\s+(?:любимое|нелюбимое)'),
        ruBoundary('всегда'),
        ruBoundary('никогда'),
    ],
    decision: [
        ruBoundary('(?:мы|я)\\s+решил[аи]?'),
        ruBoundary('решили'),
        ruBoundary('давай(?:те)?'),
        ruBoundary('лучше'),
        ruBoundary('вместо'),
        ruBoundary('потому\\s+что'),
        ruBoundary('выбираю'),
        ruBoundary('буду\\s+(?:использовать|делать|играть|смотреть)'),
    ],
    problem: [
        ruBoundary('(?:ошибка|баг|проблема|краш|таймаут|лаг|лаги)'),
        ruBoundary('не\\s+работает'),
        ruBoundary('не\\s+отвечает'),
        ruBoundary('не\\s+запускается'),
        ruBoundary('сломал[ао]?сь?'),
        ruBoundary('зависает'),
    ],
    milestone: [
        ruBoundary('(?:починил[аи]?|починено|заработало|получилось|запустил[аи]?|сделал[аи]?|наш[её]л|готово)'),
        ruBoundary('разобрал(?:ся|ась|ись)'),
        ruBoundary('вышло'),
    ],
    emotional: [
        ruBoundary('(?:рад|рада|грустно|бесит|страшно|люблю|скучаю|злюсь|обидно|переживаю|ненавижу)'),
        ruBoundary('счастлив[а]?'),
        ruBoundary('устал[а]?'),
    ],
};

const RUSSIAN_MEMORY_TYPE_PRIORITY = ['preference', 'problem', 'decision', 'milestone', 'emotional'];

export const looksCyrillic = (text) => CYRILLIC_PATTERN.test(String(text || ''));

export const normalizeMemoryText = (text, limit = Infinity) => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(limit) || normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
};

const splitMemorySegments = (text) => {
    const normalized = normalizeMemoryText(text);
    if (!normalized) {
        return [];
    }

    return normalized
        .split(/(?:\n+|(?<=[.!?…])\s+)/u)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .slice(0, 6);
};

const scoreRussianMemoryType = (segment, markers) =>
    markers.reduce((score, marker) => score + (marker.test(segment) ? 1 : 0), 0);

export const extractRussianMemories = (text) => {
    if (!looksCyrillic(text)) {
        return [];
    }

    return splitMemorySegments(text)
        .map((segment) => {
            const scores = Object.fromEntries(
                Object.entries(RUSSIAN_MEMORY_MARKERS)
                    .map(([type, markers]) => [type, scoreRussianMemoryType(segment, markers)])
                    .filter(([, score]) => score > 0),
            );
            if (Object.keys(scores).length === 0) {
                return null;
            }

            const memoryType = RUSSIAN_MEMORY_TYPE_PRIORITY
                .slice()
                .sort((left, right) => (scores[right] || 0) - (scores[left] || 0))[0];
            return {
                content: segment,
                memory_type: memoryType,
                chunk_index: 0,
            };
        })
        .filter(Boolean)
        .map((memory, index) => ({ ...memory, chunk_index: index }));
};

export const extractChatUserMemories = (text, englishExtractor = () => []) => {
    const normalized = normalizeMemoryText(text);
    if (!normalized) {
        return [];
    }

    const extracted = [
        ...englishExtractor(normalized),
        ...extractRussianMemories(normalized),
    ];
    const seen = new Set();
    return extracted.filter((memory) => {
        const content = normalizeMemoryText(memory?.content);
        const memoryType = memory?.memory_type;
        if (!content || !memoryType) {
            return false;
        }
        const key = `${memoryType}:${content.toLowerCase()}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};

export const toFormUrlEncoded = (data) => new URLSearchParams(data).toString();

export const buildUrl = (baseURL, path, params = {}) => {
    const url = baseURL ? new URL(path, baseURL) : new URL(path);
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            return;
        }
        url.searchParams.set(key, value);
    });
    return url;
};

const parseResponseBody = (text) => {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        return text;
    }
};

export const request = async (url, options = {}) => {
    const response = await fetch(url, options);
    const data = await response.text();
    if (!response.ok) {
        const error = new Error(`Request failed with status ${response.status}`);
        error.status = response.status;
        error.data = data;
        error.response = { status: response.status, data };
        throw error;
    }
    return { data, response };
};

export const fetchJson = async (url, options = {}) => {
    const { data } = await request(url, options);
    return parseResponseBody(data);
};

export const fetchText = async (url, options = {}) => {
    const { data } = await request(url, options);
    return data;
};

export const fetchForm = async (url, data, options = {}) => {
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...options.headers,
    };
    return fetchJson(url, {
        ...options,
        method: 'POST',
        headers,
        body: toFormUrlEncoded(data),
    });
};

export class HttpClient {
    constructor({ baseURL = '', headers = {}, params = {} } = {}) {
        this.baseURL = baseURL;
        this.headers = headers;
        this.params = params;
    }

    async request(path, { method = 'GET', params, headers, body } = {}) {
        const url = buildUrl(this.baseURL, path, { ...this.params, ...params });
        const mergedHeaders = { ...this.headers, ...headers };
        const options = { method, headers: mergedHeaders };
        if (body !== undefined) {
            if (
                typeof body === 'string'
                || body instanceof URLSearchParams
                || body instanceof FormData
            ) {
                options.body = body;
            } else {
                options.body = JSON.stringify(body);
                options.headers = {
                    'Content-Type': 'application/json',
                    ...options.headers,
                };
            }
        }
        return fetchJson(url, options);
    }

    get(path, options = {}) {
        return this.request(path, { ...options, method: 'GET' });
    }

    post(path, body, options = {}) {
        return this.request(path, { ...options, method: 'POST', body });
    }
}
