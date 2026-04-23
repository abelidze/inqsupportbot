import TelegramBot from 'node-telegram-bot-api';

const DEFAULT_POLL_TIMEOUT_SEC = 30;
const DEFAULT_POLL_INTERVAL_MS = 300;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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
                    allowed_updates: ['message'],
                },
            },
        });

        this.bot.on('message', (message) => {
            void this.#handleMessage(message);
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

    async #handleMessage(message) {
        const text = this.#extractText(message);
        const from = message?.from;
        if (!message || !from || from.is_bot || text.trim().length === 0) {
            return;
        }

        const isPrivateChat = message.chat?.type === 'private';
        const isCommand = this.#isCommand(text);
        const isReplyToBot = message.reply_to_message?.from?.id === this.botUser?.id;
        const mentionsBot = this.#mentionsBot(message, text);
        if (!isPrivateChat && !isCommand && !isReplyToBot && !mentionsBot) {
            return;
        }

        const username = this.#getUsername(from);
        if (username.match(this.config.IGNORE)) {
            return;
        }

        const normalizedText = this.#normalizeText(text);
        if (normalizedText.length === 0) {
            return;
        }

        await this.chatService.questionHandler(
            `telegram:${message.chat.id}`,
            `tg:${message.chat.id}:${from.id}`,
            username,
            normalizedText,
            (answer) => {
                if (this.chatService.isIgnorableAnswer(answer)) {
                    return;
                }

                this.#sendMessage(message.chat.id, answer.text, message.message_id).catch((error) => {
                    console.error('[Telegram]', error?.response?.body || error?.message || error);
                });
            },
            {
                forceTrigger: isPrivateChat || isReplyToBot || mentionsBot,
                promptChannel: this.#resolvePromptChannel(message.chat),
            },
        );
    }

    #extractText(message) {
        return String(message?.text || message?.caption || '');
    }

    #getUsername(user) {
        return String(
            user.username
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

    #isCommand(text) {
        const normalized = String(text || '').trim();
        if (normalized.startsWith('!')) {
            return true;
        }

        if (!normalized.startsWith('/')) {
            return false;
        }

        const command = normalized.match(/^\/([^\s]+)/)?.[1] || '';
        if (!command.includes('@')) {
            return command.length > 0;
        }

        const [, target] = command.split('@');
        return target?.toLowerCase() === String(this.botUser?.username || '').toLowerCase();
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

    async #sendMessage(chatId, text, replyToMessageId) {
        const message = String(text || '').trim().slice(0, TELEGRAM_MAX_MESSAGE_LENGTH);
        if (message.length === 0 || !this.bot) {
            return;
        }

        const options = {
            disable_web_page_preview: true,
            allow_sending_without_reply: true,
        };

        if (replyToMessageId) {
            options.reply_to_message_id = replyToMessageId;
        }

        await this.bot.sendMessage(chatId, message, options);
    }
}
