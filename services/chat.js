import dialogflow from 'dialogflow';
import OpenAI from 'openai';
import { choose, normalizeMemoryText, template } from '../utils.js';
import { MemoryService } from './memory.js';
import { WebSearchService } from './search.js';

const CHANNEL_CONTEXT_LIMIT = 8;
const USER_THREAD_LIMIT = 8;
const WEB_SEARCH_TOOL_PATTERN = /^\[WEB_SEARCH\]\s*(.+)$/i;
const CHAT_AUTHOR_PREFIX_PATTERN = /^@[\p{L}\p{N}_.-]{1,32}\s*[:：]\s*/u;
const DEFAULT_AI_TIMEOUT_MS = 60000;
const WEB_SEARCH_TOOL_NAME = 'web_search';

const parseTimeoutMs = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class ChatService {
    constructor({ config, backendClient, getLastSongText }) {
        this.config = config;
        this.backendClient = backendClient;
        this.getLastSongText = getLastSongText;
        this.commands = [];
        this.streamerData = {};
        this.channelContext = {};
        this.promptContext = {
            channelWindow: CHANNEL_CONTEXT_LIMIT,
            userWindow: USER_THREAD_LIMIT,
        };
        this.backendToolSupport = {};
        this.webSearch = new WebSearchService({ config });
        this.memory = new MemoryService({ config });
        this.questionThrottle = {
            users: {},
            limit: 5000,
            memory: 20,
        };

        this.dialogClient = new dialogflow.SessionsClient();
        this.brainClient = new OpenAI({
            apiKey: this.#ai().key,
            baseURL: this.#ai().url,
            project: this.#ai().project,
            timeout: parseTimeoutMs(process.env.AI_TIMEOUT_MS, DEFAULT_AI_TIMEOUT_MS),
        });
    }

    resetQuestionThrottle() {
        this.questionThrottle.users = {};
    }

    getStreamerData() {
        return this.streamerData;
    }

    async updateData(isLooped = true) {
        try {
            await this.#refreshCommands();
            const token = await this.#getTwitchToken();
            if (token) {
                await this.#refreshStreamData(token);
            }
        } catch (fatal) {
            console.error('[updateData:FATAL]', fatal?.code || fatal?.message || fatal);
        } finally {
            if (isLooped) {
                setTimeout(() => this.updateData(), this.config.DATA_POLLING_INTERVAL);
            }
        }
    }

    async questionHandler(channel, uuid, username, msg, callback, options = {}) {
        const promptChannel = this.#resolvePromptChannel(channel, options);
        let tokens = null;
        let isCommand = false;
        this.#aichatRememberChannel(channel, username, msg);
        for (const cmd of this.commands) {
            if ((tokens = msg.match(cmd.regex)) !== null) {
                tokens[tokens.length - 1] = cmd.answer.replace(/{\s*query\s*}/i, tokens[tokens.length - 1].trim());
                if (!cmd.use_backend) {
                    callback({
                        text: tokens[tokens.length - 1].trim(),
                        intent: 'cmd',
                        action: 'cmd',
                        command: true,
                    });
                    return true;
                }
                isCommand = true;
                break;
            }
        }

        const timestamp = Date.now();
        if (this.questionThrottle.users[uuid] === undefined) {
            this.questionThrottle.users[uuid] = {
                throttle: timestamp - this.questionThrottle.limit * 2,
                chat: this.#aichatCreate(channel, promptChannel),
                lastPrompt: null,
                lastRawMessage: null,
                username,
            };
        }

        const userdata = this.questionThrottle.users[uuid];
        if (userdata.chat.channel !== channel || userdata.chat.promptChannel !== promptChannel) {
            userdata.chat = this.#aichatCreate(channel, promptChannel);
        }
        userdata.username = username;
        const streamer = this.config.TWITCH.streamers[promptChannel];
        tokens = tokens || (options.forceTrigger ? [msg] : (streamer && msg.match(streamer.regex) ? [msg] : null));
        const memoryMessage = isCommand || tokens === null ? msg : tokens[tokens.length - 1].trim();
        this.memory.rememberUserMessage({ channel, uuid, username, message: memoryMessage });
        if (tokens == null) {
            this.#aichatMessage(userdata.chat, username, msg);
            return false;
        }

        const message = tokens[tokens.length - 1].trim();
        userdata.lastPrompt = message;
        userdata.lastRawMessage = msg;
        if (message === this.config.BOT_SONG) {
            const song = this.getLastSongText(null);
            if (song != null) {
                callback({
                    text: song,
                    intent: 'cmd',
                    action: 'cmd',
                    command: true,
                });
                return true;
            }
        }

        const isDirectMessage = options.forceTrigger || isCommand;
        if (timestamp - userdata.throttle < this.questionThrottle.limit) {
            setTimeout(
                () => this.#aichatProcess(channel, uuid, callback, isDirectMessage),
                timestamp - userdata.throttle + 500,
            );
            this.#aichatMessage(userdata.chat, username, msg);
            return false;
        }

        if (msg.search(/^[!\/]/) !== -1 && message.length < 2) {
            await this.updateData(false);
            callback({
                text: `Есть вопрос? Напиши в чате ${(msg.match(/^![^\s]+/i) || ['!bot'])[0]} ТВОЙ_ВОПРОС`,
                intent: 'cmd',
                action: 'cmd',
                command: isCommand,
            });
            return true;
        }

        if (message.length < 2) {
            return false;
        }

        userdata.throttle = timestamp;
        this.#aichatMessage(userdata.chat, username, msg);
        this.#aichatProcess(channel, uuid, callback, isDirectMessage);
        return true;
    }

    isIgnorableAnswer(answer) {
        return answer.action === 'input.unknown'
            || answer.intent.startsWith('smalltalk')
            || (!answer.command && answer.intent.startsWith('private'));
    }

    #resolvePromptChannel(channel, options = {}) {
        const promptChannel = String(options.promptChannel || '').trim();
        if (promptChannel.length > 0) {
            return promptChannel;
        }

        if (this.config.TWITCH?.streamers?.[channel]) {
            return channel;
        }

        const fallback = String(this.config.TWITCH?.channels?.[0] || '').trim();
        if (fallback.length > 0) {
            return fallback.startsWith('#') ? fallback.slice(1) : fallback;
        }

        return channel;
    }

    #ai() {
        return this.config.BOT_BACKEND[this.config.BOT_AI];
    }

    async #refreshCommands() {
        try {
            const data = await this.backendClient.get('/api/commands');
            if (Array.isArray(data)) {
                this.commands = data.map((cmd) => ({
                    ...cmd,
                    regex: new RegExp(`^${cmd.regex}(.*)`, 'i'),
                }));
            }
        } catch (err) {
            if (err?.data) {
                console.error('[ApiError]', err?.status, err?.data);
            } else {
                console.error('[ApiError]', err?.message || err);
            }
        }
    }

    async #getTwitchToken() {
        try {
            const url = 'https://id.twitch.tv/oauth2/token';
            const params = new URLSearchParams({
                client_id: this.config.TWITCH_CLIENT_ID,
                client_secret: this.config.TWITCH_SECRET,
                grant_type: 'client_credentials',
            });
            const response = await fetch(`${url}?${params.toString()}`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok) {
                throw Object.assign(new Error('Token request failed'), { data, status: response.status });
            }
            return data.access_token;
        } catch (error) {
            console.error('[Twitch OAuth]', 'Failed to get token:', error?.data || error?.message || error);
            return null;
        }
    }

    async #refreshStreamData(token) {
        const channels = this.config.TWITCH.channels.map((channel) =>
            channel.startsWith('#') ? channel.slice(1) : channel
        );

        for (const channel of channels) {
            try {
                const streamer = this.config.TWITCH.streamers[channel] || { };
                const data = await this.#getStreamData(this.config.TWITCH_CLIENT_ID, token, channel);
                this.streamerData[channel] = {
                    ...data,
                    bio: streamer.bio || '',
                    clip: this.getLastSongText(null) || '-',
                    age: typeof streamer.age === 'number'
                        ? ~~((Date.now() - streamer.age) / 31557600000)
                        : (streamer.age || '?'),
                };
            } catch (error) {
                console.error('[Stream Error]', channel, error?.data || error?.message || error);
            }
        }
    }

    async #getStreamData(clientId, token, streamer) {
        const url = new URL('https://api.twitch.tv/helix/streams');
        url.searchParams.set('user_login', streamer);
        const response = await fetch(url, {
            headers: {
                'Client-ID': clientId,
                Authorization: `Bearer ${token}`,
            },
        });
        const data = await response.json();
        if (!response.ok) {
            throw Object.assign(new Error('Stream data request failed'), { data, status: response.status });
        }
        const bot = this.config.BOT_NAME;
        const username = data.data?.[0]?.user_name || streamer;
        const game = data.data?.[0]?.game_name || 'стрим оффлайн';
        const title = data.data?.[0]?.title || 'стрим оффлайн';
        const today = this.#getToday().toGMTString();
        const viewers = data.data?.[0]?.viewer_count || 0;
        return { bot, streamer, username, game, title, today, viewers };
    }

    #getToday() {
        return new Date(Date.now());
    }

    #aichatChannelCreate(channel) {
        return {
            bump: 0,
            size: 0,
            channel,
            skipPrune: true,
            data: [],
        };
    }

    #aichatRememberChannel(channel, username, message) {
        if (!this.channelContext[channel]) {
            this.channelContext[channel] = this.#aichatChannelCreate(channel);
        }
        this.#aichatMessage(this.channelContext[channel], username, message);
        if (this.channelContext[channel].size > this.promptContext.channelWindow) {
            this.channelContext[channel].data.shift();
            this.channelContext[channel].size = this.channelContext[channel].data.length;
        }
    }

    #aichatCreate(channel, promptChannel = channel) {
        return {
            bump: 0,
            size: 0,
            channel,
            promptChannel,
            data: [{
                role: this.#ai().system,
                content: template(this.config.BOT_CONTEXT, this.streamerData[promptChannel]),
            }],
        };
    }

    #aichatMessage(chat, username, message, count) {
        for (let i = 0; i < (count || 0); i += 1) {
            chat.data.pop();
        }
        if (!chat.skipPrune && chat.data.length > this.questionThrottle.memory / 2) {
            chat.data.splice(1, 2);
        }
        if (username === this.#ai().system) {
            chat.data.push({ role: this.#ai().system, content: message });
        } else if (username === this.config.BOT_NAME) {
            chat.data.push({
                role: 'assistant',
                content: message,
            });
        } else {
            chat.data.push({
                role: 'user',
                content: `@${username}: ${message}`,
            });
        }
        chat.size += 1;
    }

    #aichatIsEmpty(chat) {
        return chat.bump >= chat.size;
    }

    #aichatBump(chat) {
        chat.data[0].content = template(this.config.BOT_CONTEXT, this.streamerData[chat.promptChannel || chat.channel]);
        chat.bump = chat.size;
    }

    #aichatRecentDialog(chat) {
        return chat.data.slice(1).slice(-this.promptContext.userWindow);
    }

    #aichatBuildChannelContext(channel, recentDialog) {
        const dialogLines = new Set(recentDialog.map((item) => item.content));
        const lines = (this.channelContext[channel]?.data || [])
            .filter((item) => item.role !== this.#ai().system && !dialogLines.has(item.content))
            .slice(-this.promptContext.channelWindow)
            .map((item) => item.content);

        if (lines.length === 0) {
            return null;
        }

        return [
            'Recent shared channel context. This is background for the reply, not a separate request:',
            ...lines,
        ].join('\n');
    }

    async #aichatBuildMessages(channel, uuid, memoryQuery, username, isDirectMessage = false) {
        const userdata = this.questionThrottle.users[uuid];
        this.#aichatBump(userdata.chat);
        const recentDialog = this.#aichatRecentDialog(userdata.chat);
        const messages = [{
            role: this.#ai().system,
            content: userdata.chat.data[0].content,
        }];

        const webToolInstruction = this.#aichatBuildWebSearchToolInstruction();
        if (webToolInstruction) {
            messages.push({ role: this.#ai().system, content: webToolInstruction });
        }

        const channelContext = this.#aichatBuildChannelContext(channel, recentDialog);
        if (channelContext) {
            messages.push({ role: this.#ai().system, content: channelContext });
        }

        const memoryContext = await this.memory.buildContext({
            uuid,
            username,
            query: memoryQuery,
            recentDialog,
        });
        if (memoryContext) {
            messages.push({ role: this.#ai().system, content: memoryContext });
        }

        const dialog = [...recentDialog]; 
        if (!isDirectMessage && dialog.length > 0) {
            const lastMessage = dialog.pop(); 
            lastMessage.content = [
                '[АКТУАЛЬНЫЙ ВОПРОС - ОТВЕЧАЙ ТОЛЬКО НА НЕГО]',
                lastMessage.content,
                '[НАПОМИНАНИЕ ПРАВИЛ: Не повторяй вопрос в ответе. Если не знаешь ответ — выдай ровно слово [IDK]. Держи свой токсичный стиль.]'
            ].join('\n');
            dialog.push(lastMessage);
        }

        return [...messages, ...dialog];
    }

    #aichatCleanupOutput(output) {
        const botPrefixPattern = new RegExp(`^@?${escapeRegExp(this.config.BOT_NAME)}\\s*[:：]\\s*`, 'i');
        return String(output || '')
            .replace(/\(\[.+\]\s*\(http.+\)\)/i, '')
            .replace(/\[(.+)\]\s*\(http.+\)/i, '$1')
            .replace(botPrefixPattern, '')
            .replace(CHAT_AUTHOR_PREFIX_PATTERN, '')
            .trim();
    }

    #aichatBuildWebSearchToolInstruction() {
        if (!this.webSearch.isEnabled()) {
            return null;
        }

        return [
            'IMPORTANT: WEB_SEARCH tool.',
            'Use the available web_search tool whenever you need current or external factual information to answer correctly.',
            'If your backend cannot call tools natively, reply with exactly one line in this format and nothing else:',
            '[WEB_SEARCH] concise search query',
            'If the existing context is enough, answer normally.',
        ].join('\n');
    }

    #aichatBuildNativeTools() {
        if (!this.webSearch.isEnabled()) {
            return [];
        }

        return [{
            type: 'function',
            function: {
                name: WEB_SEARCH_TOOL_NAME,
                description: 'Search the web for current or external information that is missing from the chat context.',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        query: {
                            type: 'string',
                            description: 'A concise search engine query for the missing information.',
                        },
                    },
                    required: ['query'],
                },
            },
        }];
    }

    #aichatNativeToolsEnabled() {
        if (!this.webSearch.isEnabled()) {
            return false;
        }

        return this.backendToolSupport[this.config.BOT_AI] !== false;
    }

    #aichatMarkNativeToolsUnsupported() {
        this.backendToolSupport[this.config.BOT_AI] = false;
    }

    #aichatLooksLikeToolSupportError(error) {
        const message = String(error?.message || error?.data?.error?.message || error || '').toLowerCase();
        return (
            message.includes('tool_choice')
            || message.includes('tool_calls')
            || message.includes('tools')
            || message.includes('function calling')
            || message.includes('function call')
            || message.includes('unknown parameter')
            || message.includes('extra fields not permitted')
            || message.includes('not supported')
        );
    }

    #aichatParseToolRequest(output) {
        const match = String(output || '').trim().match(WEB_SEARCH_TOOL_PATTERN);
        if (!match) {
            return null;
        }

        const query = normalizeMemoryText(match[1], 140);
        if (query.length < 3) {
            return null;
        }

        return {
            tool: 'WEB_SEARCH',
            query,
        };
    }

    #aichatParseNativeToolRequest(message) {
        const toolCall = (message?.tool_calls || []).find((call) =>
            call?.type === 'function'
            && String(call?.function?.name || '').toLowerCase() === WEB_SEARCH_TOOL_NAME
        );
        if (!toolCall) {
            return null;
        }

        let args = {};
        try {
            args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
            args = {};
        }

        const query = normalizeMemoryText(args.query || args.q || '', 140);
        if (query.length < 3) {
            return null;
        }

        return {
            tool: 'WEB_SEARCH',
            query,
            toolCallId: toolCall.id,
        };
    }

    #aichatIsUnknownOutput(output) {
        return typeof output !== 'string'
            || output.length === 0
            || output.includes('[IDK]')
            || output.includes('не могу обсуждать');
    }

    async #aichatGenerate(messages, allowNativeTools = true) {
        const request = {
            model: this.#ai().model,
            messages,
        };
        const tools = allowNativeTools ? this.#aichatBuildNativeTools() : [];

        try {
            if (tools.length > 0 && this.#aichatNativeToolsEnabled()) {
                request.tools = tools;
                request.tool_choice = 'auto';
            }

            const response = await this.brainClient.chat.completions.create(request);
            const message = choose(response.choices).message || {};
            return {
                output: this.#aichatCleanupOutput(message.content),
                toolRequest: this.#aichatParseNativeToolRequest(message) || this.#aichatParseToolRequest(message.content),
                assistantMessage: message,
            };
        } catch (error) {
            if (
                request.tools
                && this.#aichatLooksLikeToolSupportError(error)
            ) {
                this.#aichatMarkNativeToolsUnsupported();
                const response = await this.brainClient.chat.completions.create({
                    model: this.#ai().model,
                    messages,
                });
                const message = choose(response.choices).message || {};
                return {
                    output: this.#aichatCleanupOutput(message.content),
                    toolRequest: this.#aichatParseToolRequest(message.content),
                    assistantMessage: message,
                };
            }
            throw error;
        }
    }

    async #aichatRunWebSearchTool(channel, query) {
        console.log(`[WebSearch][${channel}] ${query}`);
        const webContext = await this.webSearch.buildContext(query);
        if (!webContext) {
            return [
                `WEB_SEARCH results for "${query}": no reliable results found.`,
                'No additional web searches are available in this turn. Answer from the existing context or reply with [IDK].',
            ].join('\n');
        }
        return [
            `WEB_SEARCH results for "${webContext.query}":`,
            webContext.context,
            'No additional web searches are available in this turn. Use these results if helpful and answer the user directly.',
        ].join('\n');
    }

    async #aichatProcess(channel, uuid, callback, isDirectMessage) {
        const userdata = this.questionThrottle.users[uuid];
        if (!userdata || this.#aichatIsEmpty(userdata.chat)) {
            return;
        }

        const memoryQuery = userdata.lastPrompt;
        const rawPrompt = userdata.lastRawMessage;
        const username = userdata.username;
        const messages = await this.#aichatBuildMessages(channel, uuid, memoryQuery, username, isDirectMessage);

        try {
            let { output, toolRequest, assistantMessage } = await this.#aichatGenerate(messages);
            if (toolRequest?.tool === 'WEB_SEARCH') {
                const toolResult = await this.#aichatRunWebSearchTool(channel, toolRequest.query);
                if (toolRequest.toolCallId) {
                    ({ output, toolRequest, assistantMessage } = await this.#aichatGenerate([
                        ...messages,
                        {
                            role: 'assistant',
                            content: assistantMessage?.content || '',
                            tool_calls: assistantMessage?.tool_calls,
                        },
                        {
                            role: 'tool',
                            tool_call_id: toolRequest.toolCallId,
                            content: toolResult,
                        },
                    ], false));
                } else {
                    ({ output, toolRequest } = await this.#aichatGenerate([
                        ...messages,
                        { role: 'assistant', content: output },
                        { role: this.#ai().system, content: toolResult },
                    ], false));
                }
            }
            if (this.#aichatIsUnknownOutput(output)) {
                const data = userdata.chat.data;
                console.log(`[OpenAI][${channel}] ${output || '[IDK]'} | ${data[data.length - 1].content}`);
                return;
            }

            this.#aichatMessage(userdata.chat, this.config.BOT_NAME, output);
            this.#aichatRememberChannel(channel, this.config.BOT_NAME, output);
            this.memory.rememberConversationTurn({
                channel,
                uuid,
                username,
                prompt: rawPrompt || memoryQuery,
                answer: output,
            });

            callback({
                text: output,
                action: 'cmd',
                intent: 'cmd',
                command: true,
            });
        } catch (error) {
            console.log('[ChatError]', error);
        }
    }

    aichatDialog(uuid, message, callback) {
        this.dialogClient
            .detectIntent({
                session: this.dialogClient.sessionPath(this.config.DIALOGFLOW_PROJECT, uuid),
                queryInput: {
                    text: {
                        text: message.substring(0, 255),
                        languageCode: 'ru-RU',
                    },
                },
            })
            .then((responses) => {
                const result = responses[0].queryResult;
                const msg = {
                    text: result.fulfillmentText,
                    action: result.action,
                    intent: result.intent.displayName,
                    command: false,
                };
                if (result.fulfillmentMessages && result.fulfillmentMessages.length > 0) {
                    msg.text = result.fulfillmentMessages[result.fulfillmentMessages.length - 1].text.text[0];
                }

                if (msg.intent.search('clip') !== -1) {
                    msg.text = this.getLastSongText(msg.text);
                }

                callback(msg);
            })
            .catch((err) => {
                console.error('[DialogError]', err);
            });
    }
}
