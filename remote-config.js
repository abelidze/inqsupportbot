import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUrl } from './utils.js';

const DEFAULT_ENDPOINT = '/api/chat/config';
const DEFAULT_TIMEOUT_MS = 10000;

const CONFIG_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'config',
    'index.cjs',
);

const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

const looksLikeConfig = (content) => /\b(?:let|const|var)\s+config\s*=/.test(content);

const readLocalConfigContent = async (configPath = CONFIG_PATH) => {
    try {
        return await fs.readFile(configPath, 'utf8');
    } catch (error) {
        return '';
    }
};

export const getRemoteConfigSyncOptions = (config) => {
    const apiOptions = config?.API_OPTIONS || {};
    const headers = { ...(apiOptions.headers || {}) };

    if (process.env.CHATBOT_CONFIG_HOST_HEADER) {
        headers.Host = process.env.CHATBOT_CONFIG_HOST_HEADER;
    }

    return {
        baseURL: process.env.CHATBOT_CONFIG_BASE_URL
            || process.env.API_BASE_URL
            || apiOptions.baseURL
            || apiOptions.baseUrl
            || '',
        headers,
        params: { ...(apiOptions.params || {}) },
        endpoint: process.env.CHATBOT_CONFIG_ENDPOINT || DEFAULT_ENDPOINT,
        timeoutMs: parsePositiveInt(process.env.CHATBOT_CONFIG_SYNC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        configPath: process.env.CHATBOT_CONFIG_PATH || CONFIG_PATH,
    };
};

export const syncRemoteConfig = async (config) => {
    const options = getRemoteConfigSyncOptions(config);
    const localContent = await readLocalConfigContent(options.configPath);
    const localHash = localContent ? hashContent(localContent) : null;

    if (!options.baseURL) {
        return {
            changed: false,
            hash: localHash,
            reason: 'missing_base_url',
        };
    }

    const response = await fetch(buildUrl(options.baseURL, options.endpoint, options.params), {
        method: 'GET',
        headers: options.headers,
        signal: AbortSignal.timeout(options.timeoutMs),
    });
    const rawBody = await response.text();

    if (!response.ok) {
        const error = new Error(`Remote config request failed with status ${response.status}`);
        error.status = response.status;
        error.body = rawBody;
        throw error;
    }

    let payload = null;

    try {
        payload = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
        throw new Error('Remote config endpoint returned invalid JSON.');
    }

    if (!payload || typeof payload.content !== 'string' || !looksLikeConfig(payload.content)) {
        throw new Error('Remote config payload is missing a valid config body.');
    }

    const remoteHash = typeof payload.hash === 'string' && payload.hash
        ? payload.hash
        : hashContent(payload.content);

    if (remoteHash === localHash) {
        return {
            changed: false,
            hash: remoteHash,
            updatedAt: payload.updated_at || null,
            reason: 'unchanged',
        };
    }

    await fs.writeFile(options.configPath, payload.content, 'utf8');

    return {
        changed: true,
        hash: remoteHash,
        updatedAt: payload.updated_at || null,
        reason: 'updated',
    };
};
