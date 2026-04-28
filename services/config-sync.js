import { syncRemoteConfig } from '../remote-config.js';

const DEFAULT_POLL_INTERVAL_MS = 15000;

const parseIntervalMs = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export class ConfigSyncService {
    constructor({ config }) {
        this.config = config;
        this.pollIntervalMs = parseIntervalMs(
            process.env.CHATBOT_CONFIG_SYNC_INTERVAL_MS,
            DEFAULT_POLL_INTERVAL_MS,
        );
        this.timer = null;
    }

    async start() {
        await this.#poll(true);
    }

    async #poll(isInitial = false) {
        try {
            const result = await syncRemoteConfig(this.config);

            if (result.changed) {
                console.log('[RemoteConfig] New remote config detected, restarting bot.');
                process.exit(0);
                return;
            }

            if (isInitial && result.reason === 'missing_base_url') {
                console.log('[RemoteConfig] Remote config sync disabled: API base URL is missing.');
            }
        } catch (error) {
            console.warn('[RemoteConfig] Remote config check failed:', error?.message || error);
        }

        this.timer = setTimeout(() => {
            void this.#poll();
        }, this.pollIntervalMs);
    }
}
