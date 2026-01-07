import io from 'socket.io-client';
import { choose } from '../utils.js';

export class DonationAlertsService {
    constructor({ config, broadcastService }) {
        this.config = config;
        this.broadcastService = broadcastService;
        this.client = io('wss://socket9.donationalerts.ru:443', {
            reconnection: true,
            reconnectionDelayMax: 5000,
            reconnectionDelay: 1000,
        });
    }

    start() {
        this.client.on('connect', () => {
            this.client.emit('add-user', { token: this.config.DALERTS.token, type: 'minor' });
            console.log('[DAlerts]', 'Connected!');
            setTimeout(() => this.getLastSongText(), 1000);
        });

        this.client.on('media', (data) => {
            const payload = typeof data === 'string' ? JSON.parse(data) : data;
            if (!payload || typeof payload.action === 'undefined') {
                return;
            }
            this.config.DALERTS.timestamp = Date.now();
            switch (payload.action) {
                case 'play':
                case 'receive-current-media':
                    this.config.DALERTS.songTitle = payload.media.title;
                    this.config.DALERTS.songUrl = null;
                    if (payload.media.sub_type && payload.media.sub_type === 'youtube') {
                        this.config.DALERTS.songUrl = `https://youtu.be/${payload.media.additional_data.video_id}`;
                    }
                    break;
                default:
                    break;
            }
            for (const bonus of this.config.DALERTS.specials) {
                this.#handleBonusMode(payload, bonus);
            }
        });
    }

    getLastSongText(fallback) {
        const timestamp = Date.now();
        if (timestamp - this.config.DALERTS.timestamp > this.config.DALERTS.cacheTimeout) {
            this.config.DALERTS.songTitle = null;
            this.config.DALERTS.songUrl = null;
            this.config.DALERTS.timestamp = timestamp;
        }

        if (this.config.DALERTS.songTitle) {
            return `${this.config.DALERTS.songTitle}${this.config.DALERTS.songUrl ? ` ${this.config.DALERTS.songUrl}` : ''}`;
        }
        this.client.emit('media', {
            token: this.config.DALERTS.token,
            message_data: { action: 'get-current-media', source: 'last_alerts_widget' },
        });
        return fallback;
    }

    #handleBonusMode(data, bonus) {
        switch (data.action) {
            case 'play':
            case 'receive-current-media':
                if (bonus.active || typeof data.media === 'undefined' || data.media.title.match(bonus.regex) === null) {
                    break;
                }
                const msgString = choose(this.config.DALERTS.messages);
                const msg = {};
                for (const key in bonus.message) {
                    msg[key] = msgString;
                }
                console.log('[DAlerts]', 'Bonus activated!');
                this.broadcastService.broadcastMessage(msg);
                bonus.active = true;
            case 'unpause':
                if (bonus.active && bonus.timeout == null) {
                    bonus.timeout = setTimeout(() => this.#bonusWorker(bonus), 8000);
                }
                break;

            case 'end':
            case 'skip':
            case 'stop':
                bonus.active = false;
            case 'pause':
                if (bonus.timeout != null) {
                    console.log('[DAlerts]', 'Bonus', data.action);
                    clearTimeout(bonus.timeout);
                    bonus.timeout = null;
                }
                break;
            default:
                break;
        }
    }

    #bonusWorker(bonus) {
        this.broadcastService.broadcastMessage(bonus.message);
        bonus.timeout = setTimeout(() => this.#bonusWorker(bonus), 8000 + Math.random() * 7000);
    }
}
