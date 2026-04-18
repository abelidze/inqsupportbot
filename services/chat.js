import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dialogflow from 'dialogflow';
import mempalace from 'mempalace-node';
import OpenAI from 'openai';
import { choose, template } from '../utils.js';

const { createStore, extractMemories, setModel } = mempalace;
const CHAT_MEMORY_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'data',
    'mempalace',
    'chat-users',
);
const MEMORY_COLLECTION = 'chat_user_memories';
const CHANNEL_CONTEXT_LIMIT = 8;
const USER_THREAD_LIMIT = 8;
const MEMORY_QUERY_LIMIT = 3;
const MEMORY_MIN_QUERY_LENGTH = 12;
const MEMORY_MIN_SIMILARITY = 0.35;
const MEMORY_SNIPPET_LIMIT = 180;
const MEMORY_MIN_MESSAGE_LENGTH = 20;
const MAX_EXTRACTED_MEMORIES = 3;

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
            memoryHits: MEMORY_QUERY_LIMIT,
        };
        this.userMemoryStore = this.#createUserMemoryStore();
        this.userMemoryQueue = Promise.resolve();
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
            timeout: 10000,
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

    async questionHandler(channel, uuid, username, msg, callback) {
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
                chat: this.#aichatCreate(channel),
                lastPrompt: null,
                lastRawMessage: null,
                username,
            };
        }

        const streamer = this.config.TWITCH.streamers[channel];
        const userdata = this.questionThrottle.users[uuid];
        userdata.username = username;
        tokens = tokens || (streamer && msg.match(streamer.regex) ? [msg] : null);
        const memoryMessage = isCommand
            ? msg
            : (tokens === null ? msg : tokens[tokens.length - 1].trim());
        this.#rememberUserMemories(channel, uuid, username, memoryMessage);
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

        if (timestamp - userdata.throttle < this.questionThrottle.limit) {
            setTimeout(
                () => this.#aichatProcess(channel, uuid, callback, isCommand),
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
        this.#aichatProcess(channel, uuid, callback, isCommand);
        return true;
    }

    isIgnorableAnswer(answer) {
        return answer.action === 'input.unknown'
            || answer.intent.startsWith('smalltalk')
            || (!answer.command && answer.intent.startsWith('private'));
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
        const today = new Date(Date.now()).toISOString();
        const viewers = data.data?.[0]?.viewer_count || 0;
        return { bot, streamer, username, game, title, today, viewers };
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

    #aichatCreate(channel) {
        return {
            bump: 0,
            size: 0,
            channel,
            data: [{
                role: this.#ai().system,
                content: template(this.config.BOT_CONTEXT, this.streamerData[channel]),
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
        } else {
            chat.data.push({
                role: username === this.config.BOT_NAME ? 'assistant' : 'user',
                content: `@${username}: ${message}`,
            });
        }
        chat.size += 1;
    }

    #aichatIsEmpty(chat) {
        return chat.bump >= chat.size;
    }

    #aichatBump(chat) {
        chat.data[0].content = template(this.config.BOT_CONTEXT, this.streamerData[chat.channel]);
        chat.bump = chat.size;
    }

    #createUserMemoryStore() {
        try {
            setModel('multilingual');
            return createStore(CHAT_MEMORY_PATH, MEMORY_COLLECTION);
        } catch (error) {
            console.error('[MemoryError] Failed to initialize memory store:', error?.message || error);
            return null;
        }
    }

    #queueUserMemoryWrite(task) {
        if (!this.userMemoryStore) {
            return;
        }

        this.userMemoryQueue = this.userMemoryQueue
            .then(() => task())
            .catch((error) => console.error('[MemoryError]', error?.message || error));
    }

    #memoryWing(uuid) {
        return `user_${String(uuid).toLowerCase().replace(/[^\w:-]+/g, '_')}`;
    }

    #memoryNormalizeText(text, limit = 500) {
        const normalized = String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (normalized.length <= limit) {
            return normalized;
        }
        return `${normalized.slice(0, limit - 3)}...`;
    }

    #memorySnippet(text, limit = MEMORY_SNIPPET_LIMIT) {
        return this.#memoryNormalizeText(text, limit);
    }

    #memoryImportance(room) {
        switch (room) {
            case 'preference':
            case 'decision':
                return 5;
            case 'milestone':
            case 'emotional':
                return 4;
            case 'problem':
                return 3;
            case 'conversation':
                return 2;
            default:
                return 1;
        }
    }

    #memoryId(uuid, room, content) {
        return crypto
            .createHash('sha1')
            .update(`${uuid}:${room}:${content}`)
            .digest('hex');
    }

    #memoryMetadata(channel, uuid, username, room) {
        return {
            wing: this.#memoryWing(uuid),
            room,
            hall: channel,
            source_file: `chat:${channel}`,
            added_by: this.config.BOT_NAME,
            filed_at: new Date().toISOString(),
            importance: this.#memoryImportance(room),
            username,
            channel,
            uuid,
        };
    }

    #rememberUserMemories(channel, uuid, username, message) {
        const text = this.#memoryNormalizeText(message);
        if (!this.userMemoryStore || text.length < MEMORY_MIN_MESSAGE_LENGTH) {
            return;
        }

        let extracted = [];
        try {
            const seen = new Set();
            extracted = extractMemories(text)
                .map((memory) => ({
                    room: memory.memory_type,
                    content: this.#memoryNormalizeText(memory.content),
                }))
                .filter((memory) => {
                    if (memory.content.length < MEMORY_MIN_MESSAGE_LENGTH) {
                        return false;
                    }
                    const key = `${memory.room}:${memory.content.toLowerCase()}`;
                    if (seen.has(key)) {
                        return false;
                    }
                    seen.add(key);
                    return true;
                })
                .slice(0, MAX_EXTRACTED_MEMORIES);
        } catch (error) {
            console.error('[MemoryError] Failed to extract user memory:', error?.message || error);
            return;
        }

        if (extracted.length === 0) {
            return;
        }

        this.#queueUserMemoryWrite(async () => {
            for (const memory of extracted) {
                await this.userMemoryStore.upsert(
                    this.#memoryId(uuid, memory.room, memory.content),
                    memory.content,
                    this.#memoryMetadata(channel, uuid, username, memory.room),
                );
            }
        });
    }

    #rememberConversationTurn(channel, uuid, username, prompt, answer) {
        const userPrompt = this.#memoryNormalizeText(prompt, 320);
        const botAnswer = this.#memoryNormalizeText(answer, 320);
        if (!this.userMemoryStore || userPrompt.length < MEMORY_MIN_MESSAGE_LENGTH || botAnswer.length === 0) {
            return;
        }

        const document = `@${username}: ${userPrompt}\n@${this.config.BOT_NAME}: ${botAnswer}`;
        this.#queueUserMemoryWrite(async () => {
            await this.userMemoryStore.upsert(
                this.#memoryId(uuid, 'conversation', document),
                document,
                this.#memoryMetadata(channel, uuid, username, 'conversation'),
            );
        });
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

    async #aichatBuildUserMemoryContext(uuid, username, query) {
        const searchQuery = this.#memoryNormalizeText(query, 320);
        if (
            !this.userMemoryStore
            || searchQuery.length < MEMORY_MIN_QUERY_LENGTH
            || this.userMemoryStore.count() === 0
        ) {
            return null;
        }

        try {
            const result = await this.userMemoryStore.query({
                queryText: searchQuery,
                nResults: this.promptContext.memoryHits,
                where: { wing: this.#memoryWing(uuid) },
            });
            const docs = result.documents?.[0] || [];
            const metas = result.metadatas?.[0] || [];
            const distances = result.distances?.[0] || [];
            const lines = docs
                .map((doc, index) => {
                    const similarity = 1 - (distances[index] || 1);
                    if (similarity < MEMORY_MIN_SIMILARITY) {
                        return null;
                    }
                    const room = metas[index]?.room || 'memory';
                    return `- [${room}] ${this.#memorySnippet(doc)}`;
                })
                .filter(Boolean);

            if (lines.length === 0) {
                return null;
            }

            return [
                `Relevant long-term memory about @${username}. Use it only if it helps answer naturally:`,
                ...lines,
            ].join('\n');
        } catch (error) {
            console.error('[MemoryError] Failed to load user memory:', error?.message || error);
            return null;
        }
    }

    async #aichatBuildMessages(channel, uuid, isDirectMessage, memoryQuery, username) {
        const userdata = this.questionThrottle.users[uuid];
        this.#aichatBump(userdata.chat);
        const recentDialog = this.#aichatRecentDialog(userdata.chat);
        const messages = [{
            role: this.#ai().system,
            content: userdata.chat.data[0].content,
        }];

        if (!isDirectMessage) {
            messages.push({ role: this.#ai().system, content: this.config.BOT_PRIVATE });
        }

        const channelContext = this.#aichatBuildChannelContext(channel, recentDialog);
        if (channelContext) {
            messages.push({ role: this.#ai().system, content: channelContext });
        }

        const userMemoryContext = await this.#aichatBuildUserMemoryContext(uuid, username, memoryQuery);
        if (userMemoryContext) {
            messages.push({ role: this.#ai().system, content: userMemoryContext });
        }

        return [...messages, ...recentDialog];
    }

    async #aichatProcess(channel, uuid, callback, isDirectMessage) {
        const userdata = this.questionThrottle.users[uuid];
        if (!userdata || this.#aichatIsEmpty(userdata.chat)) {
            return;
        }

        const memoryQuery = userdata.lastPrompt;
        const rawPrompt = userdata.lastRawMessage;
        const username = userdata.username;
        const messages = await this.#aichatBuildMessages(channel, uuid, isDirectMessage, memoryQuery, username);

        try {
            const response = await this.brainClient.chat.completions.create({
                model: this.#ai().model,
                messages,
            });
            const output = (choose(response.choices).message.content || '')
                .replace(/\(\[.+\]\s*\(http.+\)\)/i, '')
                .replace(/\[(.+)\]\s*\(http.+\)/i, '$1')
                .trim();
            if (output.length === 0 || output.includes('[IDK]') || output.includes('не могу обсуждать')) {
                const data = userdata.chat.data;
                console.log(`[OpenAI][${channel}] ${output} | ${data[data.length - 1].content}`);
                return;
            }

            this.#aichatMessage(userdata.chat, this.config.BOT_NAME, output);
            this.#aichatRememberChannel(channel, this.config.BOT_NAME, output);
            this.#rememberConversationTurn(channel, uuid, username, rawPrompt || memoryQuery, output);

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
