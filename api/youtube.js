import OAuth2 from './oauth.js';
import { buildUrl, fetchJson, fetchText } from '../utils.js';

const getYoutube = Symbol('getYoutube');
const postYoutube = Symbol('postYoutube');
const streamData = Symbol('streamData');
const urlsYoutube = Symbol('urlsYoutube');
const timers = Symbol('timers');
const resetStreamData = Symbol('resetStreamData');
const processMessages = Symbol('processMessages');
const chatPolling = Symbol('chatPolling');
const runMaster = Symbol('runMaster');
const MANUAL = Symbol('MANUAL');
const SEARCH = Symbol('SEARCH');
const PLAYLIST = Symbol('PLAYLIST');
const BROADCAST = Symbol('BROADCAST');

export class YoutubeClient extends OAuth2 {
    constructor(params) {
        if (typeof params !== 'object') {
            throw new Error('YouTube params must be object');
        }
        params.name = params.name || params.key;
        super(params, 'https://accounts.google.com/o/oauth2/', 'auth');

        this[streamData] = {
            key: params.key,
            livedt: params.livedt || 300000,
            chatdt: params.chatdt || 15000,
            liveId: params.liveId || null,
            chatId: params.chatId || null,
            channelId: params.channelId || null,
            playlistId: params.playlistId || null,
            ownerCredentials: null,
            autoSearch: params.autoSearch && true,
            isOnline: false,
            pageToken: '',
        };

        if (params.ownerCredentials) {
            if (typeof params.ownerCredentials === 'function') {
                params.ownerCredentials = params.ownerCredentials();
                this[streamData].ownerCredentialsUpdater = params.ownerCredentials;
            }
            this[streamData].ownerCredentials = new OAuth2(
                params.ownerCredentials,
                'https://accounts.google.com/o/oauth2/',
                'auth',
            );
            this[streamData].ownerCredentials.on('credentials', (c) => {
                this.emit('credentials', c);
            });
        }

        this[urlsYoutube] = {
            channels: 'channels',
            chats: 'liveChat/messages',
            playlist: 'playlistItems',
            search: 'search',
            videos: 'videos',
            live: 'liveBroadcasts',
        };

        this[timers] = {
            master: null,
            chat: null,
        };

        this.on('online', () => {
            this[streamData].isOnline = true;
        });
        this.on('offline', () => {
            this[streamData].isOnline = false;
        });
    }

    login(code) {
        if (typeof this[streamData].ownerCredentialsUpdater === 'function') {
            this[streamData].ownerCredentials.updateCredentials(this[streamData].ownerCredentialsUpdater());
        }

        if (code) {
            this.connect(code)
                .then(() => {
                    this[timers].master = setTimeout(this[runMaster].bind(this), 100, true);
                    this.emit('ready');
                })
                .catch((err) => {
                    this.emit('error', err);
                });
        } else if (this.getCredentials().refreshToken) {
            this.check()
                .then(() => {
                    this[timers].master = setTimeout(this[runMaster].bind(this), 100, true);
                    this.emit('ready');
                })
                .catch((err) => {
                    if (err.response && err.response.status >= 400 && err.response.status < 500) {
                        this.emit('login');
                    } else {
                        this.emit('error', err);
                    }
                });
        } else {
            this.emit('login');
        }
    }

    stop(silent = false) {
        if (this[timers].master) {
            clearTimeout(this[timers].master);
            this[timers].master = null;
            if (!silent) {
                this.emit('stopped', this[streamData].key);
            }
        }
        if (this[timers].chat) {
            clearTimeout(this[timers].chat);
            this[timers].chat = null;
        }
        if (this[streamData].isOnline) {
            this.emit('offline', this[streamData].key);
        }
        this[resetStreamData]();
    }

    authorizationUrl() {
        return `${super.authorizationUrl()}&access_type=offline&approval_prompt=force`;
    }

    getStreamData() {
        return this[streamData];
    }

    async runImmediate() {
        this.stop(true);
        return this[runMaster](true, true);
    }

    async getChannel() {
        const url = this[urlsYoutube].channels;
        const params = {
            part: 'snippet,contentDetails,brandingSettings,invideoPromotion,statistics',
            mine: true,
            key: this[streamData].key,
        };

        const result = await this[getYoutube](url, params);
        this[streamData].channelId = result.items[0].id;

        return result;
    }

    async getViewers() {
        const url = `https://www.youtube.com/live_stats?v=${this[streamData].liveId}`;
        return fetchText(url);
    }

    async sendMessage(message) {
        const url = this[urlsYoutube].chats;
        const params = {
            part: 'snippet',
            fields: 'snippet',
            key: this[streamData].key,
        };
        const data = {
            snippet: {
                type: 'textMessageEvent',
                textMessageDetails: {
                    messageText: message,
                },
                liveChatId: this[streamData].chatId,
            },
        };

        return this[postYoutube](url, params, data);
    }

    async searchStream() {
        console.log('[YouTube]', 'Searching stream...');
        return new Promise(async (resolve, reject) => {
            if (this[streamData].ownerCredentials) {
                try {
                    await this[BROADCAST]();
                    return resolve();
                } catch (err) {
                    if (err.response && err.response.data.error.code === 403) {
                        return reject(err);
                    }
                    this.emit('error', err);
                }
            }

            if (this[streamData].playlistId) {
                try {
                    await this[PLAYLIST]();
                    return resolve();
                } catch (err) {
                    if (err.response && err.response.data.error.code === 403) {
                        return reject(err);
                    }
                    this.emit('error', err);
                }
            }

            if (this[streamData].channelId) {
                try {
                    await this[SEARCH]();
                    return resolve();
                } catch (err) {
                    if (err.response && err.response.data.error.code === 403) {
                        return reject(err);
                    }
                    this.emit('error', err);
                }
            }
            return reject(new Error('No video_id provider is available'));
        });
    }

    async searchChat() {
        if (!this[streamData].liveId) {
            throw new Error('liveId is undefined, searching chat is impossible');
        }
        console.log('[YouTube]', 'Searching liveChat...');

        const url = this[urlsYoutube].videos;
        const params = {
            part: 'liveStreamingDetails',
            id: this[streamData].liveId,
            key: this[streamData].key,
        };

        const result = await this[getYoutube](url, params);
        if (result.items && result.items.length > 0 && result.items[0].liveStreamingDetails) {
            const details = result.items[0].liveStreamingDetails;
            if (details.actualStartTime && details.actualEndTime === undefined) {
                this[streamData].chatId = details.activeLiveChatId;
                console.log('[YouTube]', this[streamData].liveId, this[streamData].chatId);
            } else {
                console.log('[YouTube]', 'liveChat was found, but must be rejected');
                this[resetStreamData]();
            }
        } else {
            this[resetStreamData]();
            console.log('[YouTube]', 'liveChat not found');
        }

        return result;
    }

    async getLiveChat() {
        if (!this[streamData].chatId) {
            throw new Error('chatId is undefined, getting chat is impossible');
        }

        const url = this[urlsYoutube].chats;
        const params = {
            part: 'snippet,authorDetails',
            key: this[streamData].key,
            liveChatId: this[streamData].chatId,
            pageToken: this[streamData].pageToken,
        };

        return this[getYoutube](url, params);
    }

    [resetStreamData]() {
        this[streamData].liveId = null;
        this[streamData].chatId = null;
        this[streamData].pageToken = null;
        this[streamData].isOnline = false;
    }

    async [runMaster](bootstrap = false, raise = false) {
        try {
            if (!this[streamData].liveId && (bootstrap || this[streamData].autoSearch)) {
                await this.searchStream();
            }

            if (this[streamData].liveId && !this[streamData].chatId) {
                await this.searchChat();
            }

            if (this[streamData].isOnline && (!this[streamData].liveId || !this[streamData].chatId)) {
                this.stop();
            } else if (!this[streamData].isOnline && this[streamData].liveId && this[streamData].chatId) {
                this.emit('online', this[streamData].key);
                this[timers].chat = setTimeout(this[chatPolling].bind(this), this[streamData].chatdt, true);
            }
        } catch (err) {
            if (raise) {
                throw err;
            }
            this.emit('error', err);
        }
        if (bootstrap || this[timers].master) {
            this[timers].master = setTimeout(this[runMaster].bind(this), this[streamData].livedt);
        }
    }

    async [chatPolling](bootstrap = false) {
        await this.getLiveChat()
            .then((chat) => {
                if (chat.offlineAt) {
                    if (this[streamData].isOnline) {
                        this[streamData].isOnline = false;
                        this.emit('offline', this[streamData].key);
                    }
                    this[resetStreamData]();
                    return;
                }

                this[streamData].pageToken = chat.nextPageToken;
                if (!bootstrap) {
                    this[processMessages](chat.items);
                }

                if (this[timers].chat) {
                    this[timers].chat = setTimeout(
                        this[chatPolling].bind(this),
                        Math.max(chat.pollingIntervalMillis || 0, this[streamData].chatdt),
                        bootstrap && chat.pageInfo.totalResults > chat.pageInfo.resultsPerPage,
                    );
                }
            })
            .catch((err) => {
                this.emit('error', err);
                if (this[streamData].isOnline) {
                    this[streamData].chatId = null;
                }
            });
    }

    async [processMessages](messages) {
        if (!messages || messages.length === 0) {
            return;
        }
        for (const msg of messages) {
            if (!msg.snippet || !msg.snippet.displayMessage) {
                continue;
            }
            this.emit('message', msg.snippet, msg.authorDetails);
        }
    }

    async [MANUAL]() {
        return new Promise((resolve) => {
            resolve();
        });
    }

    async [PLAYLIST]() {
        const url = this[urlsYoutube].playlist;
        const params = {
            part: 'contentDetails',
            maxResults: 1,
            playlistId: this[streamData].playlistId,
            key: this[streamData].key,
        };

        const result = await this[getYoutube](url, params);
        if (result.items && result.items.length > 0) {
            this[streamData].liveId = result.items[0].contentDetails.videoId;
        } else {
            console.log('[YouTube]', 'liveStream not found via PLAYLIST');
        }
        return result;
    }

    async [SEARCH]() {
        const url = this[urlsYoutube].search;
        const params = {
            part: 'id',
            channelId: this[streamData].channelId,
            eventType: 'live',
            type: 'video',
            key: this[streamData].key,
        };

        const result = await this[getYoutube](url, params);
        if (result.items && result.items.length > 0) {
            this[streamData].liveId = result.items[0].id.videoId;
        } else {
            console.log('[YouTube]', 'liveStream not found via SEARCH');
        }
        return result;
    }

    async [BROADCAST]() {
        const url = this[urlsYoutube].live;
        const params = {
            part: 'snippet',
            broadcastType: 'all',
            broadcastStatus: 'active',
            fields: 'items(id,snippet/liveChatId)',
            key: this[streamData].key,
        };

        const result = await this[getYoutube](url, params, this[streamData].ownerCredentials);
        if (result.items && result.items.length > 0) {
            this[streamData].liveId = result.items[0].id;
            this[streamData].chatId = result.items[0].snippet.liveChatId;
        } else {
            this[streamData].liveId = null;
            this[streamData].chatId = null;
            console.log('[YouTube]', 'liveStream not found via BROADCAST');
        }

        return result;
    }

    async [postYoutube](url, params, data, oauth = null) {
        const auth = oauth || this;
        await auth.check();

        const fullUrl = buildUrl('https://www.googleapis.com/youtube/v3/', url, params);
        return fetchJson(fullUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${auth.getCredentials().accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
    }

    async [getYoutube](url, params, oauth = null) {
        const auth = oauth || this;
        await auth.check();

        const fullUrl = buildUrl('https://www.googleapis.com/youtube/v3/', url, params);
        return fetchJson(fullUrl, {
            headers: { Authorization: `Bearer ${auth.getCredentials().accessToken}` },
        });
    }
}
