import config from './config/index.cjs';
import { syncRemoteConfig } from './remote-config.js';

try {
    const result = await syncRemoteConfig(config);

    if (result.changed) {
        console.log('[ConfigSync] Remote chatbot config synced.');
    } else if (result.reason === 'unchanged') {
        console.log('[ConfigSync] Remote chatbot config is up to date.');
    } else if (result.reason === 'missing_base_url') {
        console.log('[ConfigSync] API base URL is not configured, using local chatbot config.');
    }
} catch (error) {
    console.warn('[ConfigSync] Unable to sync remote chatbot config:', error?.message || error);
}
