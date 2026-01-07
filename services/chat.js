import dialogflow from 'dialogflow';
import OpenAI from 'openai';
import { choose, template } from '../utils.js';

export class ChatService {
    constructor({ config, backendClient, getLastSongText }) {
        this.config = config;
        this.backendClient = backendClient;
        this.getLastSongText = getLastSongText;
        this.commands = [];
        this.streamerData = {};
        this.questionThrottle = {
            users: {},
            limit: 5000,
            memory: 20,
        };

        this.dialogClient = new dialogflow.SessionsClient();
        this.brainClient = new OpenAI({
            apiKey: this.#ai().key,
            baseURL: this.#ai().url,
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
            };
        }

        const streamer = this.config.TWITCH.streamers[channel];
        const userdata = this.questionThrottle.users[uuid];
        tokens = tokens || (streamer && msg.match(streamer.regex) ? [msg] : null);
        if (tokens == null) {
            this.#aichatMessage(userdata.chat, username, msg);
            return false;
        }

        const message = tokens[tokens.length - 1].trim();
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
            this.#aichatMessage(userdata.chat, username, message);
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

        this.questionThrottle.users[uuid].throttle = timestamp;
        this.#aichatMessage(this.questionThrottle.users[uuid].chat, username, message);
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

    #aichatCreate(channel, summary) {
        const chat = {
            bump: 0,
            size: 0,
            channel,
            data: [{
                role: this.#ai().system,
                content: template(this.config.BOT_CONTEXT, this.streamerData[channel])
            }],
        };
        if (summary !== undefined) {
            chat.data.push({ role: 'assistant', content: `@InqSupportBot: ${summary}` });
        }
        return chat;
    }

    #aichatMessage(chat, username, message, count) {
        for (let i = 0; i < (count || 0); i += 1) {
            chat.data.pop();
        }
        if (chat.data.length > this.questionThrottle.memory / 2) {
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

    #aichatProcess(channel, uuid, callback, isDirectMessage) {
        if (this.#aichatIsEmpty(this.questionThrottle.users[uuid].chat)) {
            return;
        }
        this.#aichatBump(this.questionThrottle.users[uuid].chat);
        const messages = isDirectMessage
            ? this.questionThrottle.users[uuid].chat.data
            : [{ role: this.#ai().system, content: this.config.BOT_PRIVATE }, ...this.questionThrottle.users[uuid].chat.data];

        this.brainClient.chat.completions
            .create({
                model: this.#ai().model,
                messages,
            })
            .then((response) => {
                const output = choose(response.choices).message.content
                    .replace(/\(\[.+\]\s*\(http.+\)\)/i, '')
                    .replace(/\[(.+)\]\s*\(http.+\)/i, '$1')
                    .trim();
                if (output.length === 0 || output.includes('[IDK]')) {
                    const data = this.questionThrottle.users[uuid].chat.data;
                    console.log(`[OpenAI][${channel}] ${output} | ${data[data.length - 1].content}`);
                    return;
                }

                this.#aichatMessage(this.questionThrottle.users[uuid].chat, this.config.BOT_NAME, output);

                if (this.questionThrottle.users[uuid].chat.size > this.questionThrottle.memory) {
                    this.#aichatMessage(this.questionThrottle.users[uuid].chat, this.#ai().system, this.config.BOT_MEMORY);
                    this.#aichatBump(this.questionThrottle.users[uuid].chat);
                    this.brainClient.chat.completions
                        .create({
                            model: this.#ai().model,
                            messages: this.questionThrottle.users[uuid].chat.data,
                        })
                        .then((summaryResponse) => {
                            const summary = choose(summaryResponse.choices).message.content;
                            this.questionThrottle.users[uuid].chat = this.#aichatCreate(channel, summary);
                            console.log(`[OpenAI][${channel}] MEMOIZE | ${summary}`);
                        })
                        .catch((error) => console.log('[ChatError]', error));
                }

                callback({
                    text: output.replace(
                        /\[LINK_TO_WARBORNE\]/i,
                        'https://r.qoolandgames.com/warborne/index?allianceId=494&invitationCode=7XZn39KO',
                    ),
                    action: 'cmd',
                    intent: 'cmd',
                    command: true,
                });
            })
            .catch((error) => console.log('[ChatError]', error));
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
