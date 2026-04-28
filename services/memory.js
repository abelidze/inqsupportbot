import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mempalace from 'mempalace-node';
import { extractChatUserMemories, normalizeMemoryText } from '../utils.js';

const { createStore, extractMemories, setModel } = mempalace;

const DEFAULT_MEMORY_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'data',
);

const DEFAULT_MEMORY = {
    enabled: true,
    path: DEFAULT_MEMORY_PATH,
    model: 'multilingual',
    queryLimit: 3,
    queryCandidates: 9,
    queryContextTurns: 2,
    minQueryLength: 12,
    minMessageLength: 20,
    minSimilarity: 0.35,
    snippetLength: 180,
    maxExtractedMemories: 3,
    rememberConversationTurns: false,
    includeConversationTurnsInContext: false,
    conversationTurnMaxAgeDays: 7,
    debug: false,
};

const FACT_MEMORY_KIND = 'fact';
const TURN_MEMORY_KIND = 'turn';
const COMMAND_PREFIX_PATTERN = /^[!/][^\s]+\s*/u;
const AUTHOR_PREFIX_PATTERN = /^@[\p{L}\p{N}_.-]{1,32}\s*[:：]\s*/u;
const MENTION_PATTERN = /@[\p{L}\p{N}_.-]{1,32}/gu;
const QUESTION_START_PATTERN = /^(?:алло\s+)?(?:когда|где|кто|что|чего|как|почему|зачем|какой|какая|какое|какие|сколько|можно|можешь|будет|будут|есть\s+ли|when|where|who|what|why|how|can|could|should|is|are|do|does|did)\b/iu;
const QUESTION_HINT_PATTERN = /[?？]|(?:^|\s)(?:найди|ищи|поищи|скажи|расскажи|ответь|проверь|глянь|посмотри|загугли|search|find|tell|check|look\s+up)(?:$|\s)/iu;
const FILLER_PREFIX_PATTERN = /^(?:бот|алло|слышь|эй|чат|чатик|плиз|пожалуйста)[,\s:：-]+/iu;

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveNumber = (value, fallback) => {
    const parsed = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const mergeConfig = (config = {}) => {
    const memoryConfig = config.MEMORY || { };
    const sanitizedConfig = Object.fromEntries(
        Object.entries(memoryConfig).filter(([, value]) => value !== undefined)
    );
    const queryLimit = parsePositiveInt(sanitizedConfig.queryLimit, DEFAULT_MEMORY.queryLimit);
    return {
        ...DEFAULT_MEMORY,
        ...sanitizedConfig,
        queryLimit,
        queryCandidates: Math.max(
            queryLimit,
            parsePositiveInt(sanitizedConfig.queryCandidates, Math.max(queryLimit * 3, DEFAULT_MEMORY.queryCandidates)),
        ),
        queryContextTurns: parsePositiveInt(sanitizedConfig.queryContextTurns, DEFAULT_MEMORY.queryContextTurns),
        minQueryLength: parsePositiveInt(sanitizedConfig.minQueryLength, DEFAULT_MEMORY.minQueryLength),
        minMessageLength: parsePositiveInt(sanitizedConfig.minMessageLength, DEFAULT_MEMORY.minMessageLength),
        minSimilarity: parsePositiveNumber(sanitizedConfig.minSimilarity, DEFAULT_MEMORY.minSimilarity),
        snippetLength: parsePositiveInt(sanitizedConfig.snippetLength, DEFAULT_MEMORY.snippetLength),
        maxExtractedMemories: parsePositiveInt(
            sanitizedConfig.maxExtractedMemories,
            DEFAULT_MEMORY.maxExtractedMemories,
        ),
        conversationTurnMaxAgeDays: parsePositiveInt(
            sanitizedConfig.conversationTurnMaxAgeDays,
            DEFAULT_MEMORY.conversationTurnMaxAgeDays,
        ),
        debug: Boolean(sanitizedConfig.debug),
    };
};

export class MemoryService {
    constructor({ config }) {
        this.config = mergeConfig(config);
        this.botName = config.BOT_NAME || 'bot';
        this.store = this.#createStore();
        this.queue = Promise.resolve();
    }

    isEnabled() {
        return Boolean(this.config.enabled && this.store);
    }

    rememberUserMessage({ channel, uuid, username, message }) {
        const text = this.#prepareMemoryText(message);
        if (!this.isEnabled() || text.length < this.config.minMessageLength) {
            return;
        }

        if (this.#shouldSkipFactExtraction(text)) {
            this.#debug('Skipped noisy user memory:', message);
            return;
        }

        let extracted = [];
        try {
            const seen = new Set();
            extracted = extractChatUserMemories(text, extractMemories)
                .map((memory) => ({
                    room: memory.memory_type,
                    content: normalizeMemoryText(memory.content),
                }))
                .filter((memory) => {
                    if (
                        !memory.room
                        || memory.content.length < this.config.minMessageLength
                        || this.#shouldSkipFactExtraction(memory.content)
                    ) {
                        return false;
                    }

                    const key = `${memory.room}:${memory.content.toLowerCase()}`;
                    if (seen.has(key)) {
                        return false;
                    }
                    seen.add(key);
                    return true;
                })
                .slice(0, this.config.maxExtractedMemories);
        } catch (error) {
            console.error('[MemoryError] Failed to extract user memory:', error?.message || error);
            return;
        }

        if (extracted.length === 0) {
            this.#debug('No user memories extracted:', message);
            return;
        }

        this.#queue(async () => {
            for (const memory of extracted) {
                await this.store.upsert(
                    this.#memoryId(uuid, memory.room, memory.content),
                    memory.content,
                    this.#memoryMetadata({
                        channel,
                        uuid,
                        username,
                        room: memory.room,
                        kind: FACT_MEMORY_KIND,
                    }),
                );
            }
        });
    }

    rememberConversationTurn({ channel, uuid, username, prompt, answer }) {
        if (!this.config.rememberConversationTurns) {
            return;
        }

        const userPrompt = normalizeMemoryText(prompt, 320);
        const botAnswer = normalizeMemoryText(answer, 320);
        if (!this.isEnabled() || userPrompt.length < this.config.minMessageLength || botAnswer.length === 0) {
            return;
        }

        const document = `> ${userPrompt}\n${botAnswer}`;
        this.#queue(async () => {
            await this.#pruneOldConversationTurns(uuid);
            const room = `conversation:${this.#dateKey()}`;
            await this.store.upsert(
                this.#memoryId(uuid, room, document),
                document,
                this.#memoryMetadata({
                    channel,
                    uuid,
                    username,
                    room,
                    kind: TURN_MEMORY_KIND,
                    importance: 1,
                }),
            );
        });
    }

    async buildContext({ uuid, username, query, recentDialog = [] }) {
        const searchQuery = this.#buildSearchQuery(query, recentDialog);
        if (
            !this.isEnabled()
            || searchQuery.length < this.config.minQueryLength
            || this.store.count() === 0
        ) {
            return null;
        }

        try {
            const result = await this.store.query({
                queryText: searchQuery,
                nResults: this.config.queryCandidates,
                where: { wing: this.#memoryWing(uuid) },
            });
            const lines = this.#rankQueryResult(result)
                .slice(0, this.config.queryLimit)
                .map((memory) => `- [${memory.room}] ${this.#snippet(memory.document)}`);

            if (lines.length === 0) {
                return null;
            }

            return [
                `[User memory facts for @${username}]`,
                'Use these only if directly relevant to the current user request; otherwise ignore them.',
                ...lines,
            ].join('\n');
        } catch (error) {
            console.error('[MemoryError] Failed to load user memory:', error?.message || error);
            return null;
        }
    }

    close() {
        try {
            this.store?.close?.();
        } catch (error) {
            console.error('[MemoryError] Failed to close memory store:', error?.message || error);
        }
    }

    async flush() {
        await this.queue;
    }

    #createStore() {
        if (!this.config.enabled) {
            return null;
        }

        try {
            setModel(this.config.model);
            return createStore(this.config.path);
        } catch (error) {
            console.error('[MemoryError] Failed to initialize memory store:', error?.message || error);
            return null;
        }
    }

    #queue(task) {
        if (!this.store) {
            return;
        }

        this.queue = this.queue
            .then(() => task())
            .catch((error) => console.error('[MemoryError]', error?.message || error));
    }

    #memoryWing(uuid) {
        return `user_${String(uuid).toLowerCase().replace(/[^\w:-]+/g, '_')}`;
    }

    #memoryId(uuid, room, content) {
        return crypto
            .createHash('sha1')
            .update(`${uuid}:${room}:${content}`)
            .digest('hex');
    }

    #memoryMetadata({ channel, uuid, username, room, kind, importance }) {
        return {
            wing: this.#memoryWing(uuid),
            room,
            hall: channel,
            source_file: `chat:${channel}`,
            added_by: this.botName,
            filed_at: new Date().toISOString(),
            importance: importance ?? this.#memoryImportance(room),
            memory_kind: kind,
            username,
            channel,
            uuid,
        };
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
            default:
                return 1;
        }
    }

    #prepareMemoryText(text) {
        let normalized = normalizeMemoryText(text, 500)
            .replace(AUTHOR_PREFIX_PATTERN, '')
            .replace(COMMAND_PREFIX_PATTERN, '')
            .replace(MENTION_PATTERN, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        while (FILLER_PREFIX_PATTERN.test(normalized)) {
            normalized = normalized.replace(FILLER_PREFIX_PATTERN, '').trim();
        }

        return normalized;
    }

    #shouldSkipFactExtraction(text) {
        const normalized = normalizeMemoryText(text);
        if (!normalized) {
            return true;
        }
        return QUESTION_START_PATTERN.test(normalized) || QUESTION_HINT_PATTERN.test(normalized);
    }

    #buildSearchQuery(query, recentDialog) {
        const parts = [query];
        const recentLines = recentDialog
            .filter((item) => item?.role !== 'system')
            .map((item) => this.#prepareQueryText(item?.content))
            .filter(Boolean)
            .slice(-this.config.queryContextTurns);

        parts.push(...recentLines);
        const seen = new Set();
        return normalizeMemoryText(
            parts
                .map((part) => normalizeMemoryText(part))
                .filter((part) => {
                    const key = part.toLowerCase();
                    if (!part || seen.has(key)) {
                        return false;
                    }
                    seen.add(key);
                    return true;
                })
                .join(' '),
            320,
        );
    }

    #prepareQueryText(text) {
        return normalizeMemoryText(String(text || '')
            .replace(AUTHOR_PREFIX_PATTERN, '')
            .replace(MENTION_PATTERN, ' '), 180);
    }

    #rankQueryResult(result) {
        const docs = result.documents?.[0] || [];
        const metas = result.metadatas?.[0] || [];
        const distances = result.distances?.[0] || [];
        return docs
            .map((document, index) => {
                const metadata = metas[index] || {};
                if (this.#isConversationTurnMemory(metadata, document) && !this.config.includeConversationTurnsInContext) {
                    return null;
                }

                const cleanedDocument = this.#prepareMemoryText(document);
                if (!cleanedDocument || this.#shouldSkipFactExtraction(cleanedDocument)) {
                    return null;
                }

                const distance = distances[index];
                const similarity = Number.isFinite(distance) ? 1 - distance : 0;
                if (similarity < this.config.minSimilarity) {
                    return null;
                }

                const importance = Math.min(Number(metadata.importance) || 1, 5);
                return {
                    document: cleanedDocument,
                    room: metadata.room || 'memory',
                    similarity,
                    score: similarity + importance * 0.03 + this.#recencyBoost(metadata.filed_at),
                };
            })
            .filter(Boolean)
            .sort((left, right) => right.score - left.score);
    }

    #isConversationTurnMemory(metadata, document) {
        return metadata.memory_kind === TURN_MEMORY_KIND
            || String(metadata.room || '').startsWith('conversation:')
            || /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(String(metadata.room || ''))
            || /^>\s*/.test(String(document || ''));
    }

    #recencyBoost(filedAt) {
        const timestamp = Date.parse(filedAt || '');
        if (!Number.isFinite(timestamp)) {
            return 0;
        }

        const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
        if (ageDays > 30) {
            return 0;
        }
        return (30 - ageDays) / 30 * 0.05;
    }

    async #pruneOldConversationTurns(uuid) {
        if (!this.store?.get || !this.store?.delete) {
            return;
        }

        const cutoff = Date.now() - this.config.conversationTurnMaxAgeDays * 86400000;
        const memories = this.store.get({
            where: {
                $and: [
                    { wing: this.#memoryWing(uuid) },
                    { memory_kind: TURN_MEMORY_KIND },
                ],
            },
            limit: 100000,
        });

        for (const [index, id] of memories.ids.entries()) {
            const filedAt = Date.parse(memories.metadatas[index]?.filed_at || '');
            if (Number.isFinite(filedAt) && filedAt < cutoff) {
                this.store.delete(id);
            }
        }
    }

    #dateKey() {
        return new Date().toISOString().slice(0, 10);
    }

    #snippet(text) {
        return normalizeMemoryText(text, this.config.snippetLength);
    }

    #debug(...args) {
        if (this.config.debug) {
            console.log('[Memory]', ...args);
        }
    }
}
