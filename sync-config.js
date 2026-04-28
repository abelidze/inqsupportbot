import config from './config/index.cjs';
import { syncRemoteConfig } from './remote-config.js';

try {
    const result = await syncRemoteConfig(config);

    if (result.changed) {
        console.log('[RemoteConfig] Remote chatbot config synced.');
    } else if (result.reason === 'unchanged') {
        console.log('[RemoteConfig] Remote chatbot config is up to date.');
    } else if (result.reason === 'missing_base_url') {
        console.log('[RemoteConfig] API base URL is not configured, using local chatbot config.');
    }
} catch (error) {
    console.warn('[RemoteConfig] Unable to sync remote chatbot config:', error?.message || error);
}
