import TelegramBot from 'node-telegram-bot-api';

const DEFAULT_POLL_TIMEOUT_SEC = 30;
const DEFAULT_POLL_INTERVAL_MS = 300;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post'];

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class TelegramService {
    constructor({ config, chatService }) {
        this.config = config;
        this.chatService = chatService;
        this.bot = null;
        this.botUser = null;
    }

    start() {
        const token = String(this.config.TELEGRAM?.TOKEN || '').trim();
        if (token.length === 0) {
            return;
        }

        void this.#startBot(token);
    }

    async #startBot(token) {
        const pollTimeoutSec = parsePositiveInt(
            this.config.TELEGRAM?.POLL_TIMEOUT_SEC,
            DEFAULT_POLL_TIMEOUT_SEC,
        );
        this.bot = new TelegramBot(token, {
            polling: {
                autoStart: false,
                interval: DEFAULT_POLL_INTERVAL_MS,
                params: {
                    timeout: pollTimeoutSec,
                    allowed_updates: TELEGRAM_ALLOWED_UPDATES,
                },
            },
        });

        this.bot.on('message', (message) => {
            void this.#handleMessage(message);
        });

        this.bot.on('edited_message', (message) => {
            void this.#handleMessage(message);
        });

        this.bot.on('channel_post', (message) => {
            void this.#handleMessage(message, { isChannelPost: true });
        });

        this.bot.on('polling_error', (error) => {
            console.error('[Telegram]', error?.response?.body || error?.message || error);
        });

        this.bot.on('error', (error) => {
            console.error('[Telegram]', error?.response?.body || error?.message || error);
        });

        try {
            this.botUser = await this.bot.getMe();
            await this.bot.startPolling();
            console.log('[Telegram] Hi, @%s!', this.botUser?.username || this.botUser?.id);
        } catch (error) {
            console.error('[Telegram]', error?.response?.body || error?.message || error);
        }
    }

    async #handleMessage(message, options = {}) {
        const text = this.#extractText(message);
        const actor = this.#getActor(message);
        if (!message || !actor || this.#isBotActor(actor) || text.trim().length === 0) {
            return;
        }

        const isPrivateChat = message.chat?.type === 'private';
        const isChannelPost = options.isChannelPost || message.chat?.type === 'channel';
        const isCommand = this.#isCommand(message, text);
        const isReplyToBot = message.reply_to_message?.from?.id === this.botUser?.id;
        const mentionsBot = this.#mentionsBot(message, text);
        if (!isPrivateChat && !isCommand && !isReplyToBot && !mentionsBot) {
            return;
        }

        const username = this.#getUsername(actor);
        if (username.match(this.config.IGNORE)) {
            return;
        }

        const normalizedText = this.#normalizeText(text);
        const routedText = isCommand ? this.#normalizeCommandText(message, text) : normalizedText;
        if (routedText.length === 0) {
            return;
        }

        await this.chatService.questionHandler(
            `telegram:${message.chat.id}`,
            `tg:${message.chat.id}:${this.#getActorId(actor, message)}`,
            username,
            routedText,
            (answer) => {
                if (this.chatService.isIgnorableAnswer(answer)) {
                    return;
                }

                this.#sendMessage(message.chat.id, answer.text, message).catch((error) => {
                    console.error('[Telegram]', error?.response?.body || error?.message || error);
                });
            },
            {
                forceTrigger: isPrivateChat || isChannelPost || isReplyToBot || mentionsBot,
                promptChannel: this.#resolvePromptChannel(message.chat),
            },
        );
    }

    #extractText(message) {
        return String(message?.text || message?.caption || '');
    }

    #getActor(message) {
        return message?.from || message?.sender_chat || message?.chat || null;
    }

    #isBotActor(actor) {
        return actor?.is_bot === true;
    }

    #getActorId(actor, message) {
        return actor?.id || message?.chat?.id || 'unknown';
    }

    #getUsername(user) {
        return String(
            user.username
            || user.title
            || [user.first_name, user.last_name].filter(Boolean).join(' ')
            || user.id,
        ).trim();
    }

    #getEntities(message) {
        return Array.isArray(message?.entities)
            ? message.entities
            : (Array.isArray(message?.caption_entities) ? message.caption_entities : []);
    }

    #mentionsBot(message, text) {
        const botId = this.botUser?.id;
        const botUsername = String(this.botUser?.username || '').toLowerCase();
        if (!botId && botUsername.length === 0) {
            return false;
        }

        return this.#getEntities(message).some((entity) => {
            if (entity?.type === 'text_mention') {
                return entity.user?.id === botId;
            }

            if (entity?.type !== 'mention' || botUsername.length === 0) {
                return false;
            }

            const mention = text.slice(entity.offset, entity.offset + entity.length);
            return mention.slice(1).toLowerCase() === botUsername;
        });
    }

    #isCommand(message, text) {
        const normalized = String(text || '').trim();
        if (normalized.startsWith('!')) {
            return true;
        }

        return this.#getSlashCommand(message, text) !== null;
    }

    #normalizeText(text) {
        let normalized = String(text || '').trim();
        const botUsername = String(this.botUser?.username || '').trim();
        if (botUsername.length > 0) {
            normalized = normalized.replace(
                new RegExp(`^([!/][^\\s@]+)@${escapeRegExp(botUsername)}\\b`, 'i'),
                '$1',
            );
            normalized = normalized.replace(
                new RegExp(`(^|\\s)@${escapeRegExp(botUsername)}\\b`, 'ig'),
                ' ',
            );
        }

        return normalized.replace(/\s+/g, ' ').trim();
    }

    #normalizeCommandText(message, text) {
        const slashCommand = this.#getSlashCommand(message, text);
        if (slashCommand) {
            return `!${slashCommand.name}${slashCommand.rest ? ` ${slashCommand.rest}` : ''}`;
        }

        const normalized = this.#normalizeText(text);
        if (!normalized.startsWith('/')) {
            return normalized;
        }

        return normalized.replace(/^\/([^\s/@]+)(?:@[^\s]+)?/, '!$1');
    }

    #getSlashCommand(message, text) {
        const raw = String(text || '');
        const start = raw.search(/\S/);
        if (start === -1 || raw[start] !== '/') {
            return null;
        }

        const entity = this.#getEntities(message).find((item) =>
            item?.type === 'bot_command' && item.offset === start
        );
        const commandText = entity
            ? raw.slice(entity.offset, entity.offset + entity.length)
            : raw.slice(start).match(/^\/[^\s]+/)?.[0];

        if (!commandText || !this.#commandTargetsThisBot(commandText)) {
            return null;
        }

        const name = commandText.slice(1).split('@')[0];
        if (name.length === 0) {
            return null;
        }

        const rest = raw.slice(start + commandText.length).trim();
        return { name, rest };
    }

    #commandTargetsThisBot(commandText) {
        const [, target] = String(commandText || '').split('@');
        if (!target) {
            return true;
        }

        return target.toLowerCase() === String(this.botUser?.username || '').toLowerCase();
    }

    #resolvePromptChannel(chat) {
        const contexts = this.config.TELEGRAM?.CHAT_CONTEXTS || {};
        const keys = [
            String(chat?.id || ''),
            String(chat?.username || ''),
            chat?.username ? `@${chat.username}` : '',
            String(chat?.title || ''),
        ].filter(Boolean);

        for (const key of keys) {
            const promptChannel = String(contexts[key] || '').trim();
            if (promptChannel.length > 0) {
                return promptChannel;
            }
        }

        return String(this.config.TELEGRAM?.DEFAULT_CHANNEL || '').trim();
    }

    async #sendMessage(chatId, text, sourceMessage) {
        const message = String(text || '').trim().slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
        if (message.length === 0 || !this.bot) {
            return;
        }

        const options = {
            disable_web_page_preview: true,
        };

        if (sourceMessage?.is_topic_message && sourceMessage?.message_thread_id) {
            options.message_thread_id = sourceMessage.message_thread_id;
        }

        if (sourceMessage?.message_id) {
            options.reply_parameters = {
                message_id: sourceMessage.message_id,
                allow_sending_without_reply: true,
            };
        }

        try {
            await this.bot.sendMessage(chatId, message, options);
        } catch (error) {
            if (!options.reply_parameters && !options.message_thread_id) {
                throw error;
            }

            await this.bot.sendMessage(chatId, message, {
                disable_web_page_preview: true,
            });
        }
    }
}
