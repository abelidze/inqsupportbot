const OAuth2 = require('./oauth');
const axios = require('axios');
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

class Youtube extends OAuth2 {
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
            if (typeof params.ownerCredentials == 'function') {
                params.ownerCredentials = params.ownerCredentials();
                this[streamData].ownerCredentialsUpdater = params.ownerCredentials;
            }
            this[streamData].ownerCredentials = new OAuth2(
                    params.ownerCredentials,
                    'https://accounts.google.com/o/oauth2/',
                    'auth'
                );
            this[streamData].ownerCredentials.on('credentials', (c => { this.emit('credentials', c); }).bind(this));
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

        this.axiosYoutube = axios.create({
            baseURL: 'https://www.googleapis.com/youtube/v3/'
        });

        this.on('online', function () { this[streamData].isOnline = true; });
        this.on('offline', function () { this[streamData].isOnline = false; });
    }

    login(code) {
        let self = this;

        if (typeof self[streamData].ownerCredentialsUpdater == 'function') {
            self[streamData].updateCredentials( self[streamData].ownerCredentialsUpdater() );
        }

        if (code) {
            self.connect(code)
                .then(function () {
                    self[timers].master = setTimeout(self[runMaster].bind(self), 100, true);
                    self.emit('ready');
                })
                .catch(function (err) {
                    self.emit('error', err);
                });
        } else if (self.getCredentials().refreshToken) {
            self.check()
                .then(function () {
                    self[timers].master = setTimeout(self[runMaster].bind(self), 100, true);
                    self.emit('ready');
                })
                .catch(function (err) {
                    if (err.response && err.response.status >= 400 && err.response.status < 500) {
                        self.emit('login');
                    } else {
                        self.emit('error', err);
                    }
                });
        } else {
            self.emit('login');
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
        return super.authorizationUrl() + '&access_type=offline&approval_prompt=force';
    }

    getStreamData() {
        return this[streamData];
    }

    async runImmediate() {
        this.stop(true);
        return await this[runMaster](true, true);
    }

    async getChannel() {
        let url = this[urlsYoutube].channels;
        let params = {
            part: 'snippet,contentDetails,brandingSettings,invideoPromotion,statistics',
            mine: true,
            key: this[streamData].key
        };

        let result = await this[getYoutube](url, params);
        this[streamData].channelId = result.items[0].id;

        return result;
    }

    async getViewers() {
        let url = `https://www.youtube.com/live_stats?v=${this[streamData].liveId}`;
        let result = await axios.get(url);
        return result.data;
    }

    async sendMessage(message) {
        let url = this[urlsYoutube].chats;
        let params = {
            part: 'snippet',
            fields: 'snippet',//,kind,authorDetails',
            key: this[streamData].key,
        }
        let data = {
            snippet: {
                type: 'textMessageEvent',
                textMessageDetails: {
                    messageText: message
                },
                liveChatId: this[streamData].chatId
            }
        }

        return await this[postYoutube](url, params, data);
    }

    async searchStream() {
        let self = this;
        console.log('[YouTube]', 'Searching stream...');
        return await new Promise(async function (resolve, reject) {
                if (self[streamData].ownerCredentials) {
                    try {
                        await self[BROADCAST]();
                        return resolve();
                    } catch (err) {
                        if (err.response && err.response.data.error.code == 403) {
                            return reject(err);
                        }
                        self.emit('error', err);
                    }
                }

                if (self[streamData].playlistId) {
                    try {
                        await self[PLAYLIST]();
                        return resolve();
                    } catch (err) {
                        if (err.response && err.response.data.error.code == 403) {
                            return reject(err);
                        }
                        self.emit('error', err);
                    }
                }

                if (self[streamData].channelId) {
                    try {
                        await self[SEARCH]();
                        return resolve();
                    } catch (err) {
                        if (err.response && err.response.data.error.code == 403) {
                            return reject(err);
                        }
                        self.emit('error', err);
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

        let url = this[urlsYoutube].videos;
        let params = {
            part: 'liveStreamingDetails',
            id: this[streamData].liveId,
            key: this[streamData].key,
        };

        let result = await this[getYoutube](url, params);
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

        let url = this[urlsYoutube].chats;
        let params = {
            part: 'snippet,authorDetails',
            key: this[streamData].key,
            liveChatId: this[streamData].chatId,
            pageToken: this[streamData].pageToken,
        };

        return await this[getYoutube](url, params);
    }

    [resetStreamData]() {
        this[streamData].liveId = null;
        this[streamData].chatId = null;
        this[streamData].pageToken = null;
        this[streamData].isOnline = false;
    }

    async [runMaster](bootstrap = false, raise = false) {
        let self = this;

        try {
            if (!self[streamData].liveId && (bootstrap || self[streamData].autoSearch)) {
                await self.searchStream();
            }

            if (self[streamData].liveId && !self[streamData].chatId) {
                await self.searchChat();
            }

            if (self[streamData].isOnline && (!self[streamData].liveId || !self[streamData].chatId)) {
                self.stop();
            } else if (!self[streamData].isOnline && self[streamData].liveId && self[streamData].chatId) {
                self.emit('online', self[streamData].key);
                self[timers].chat = setTimeout(self[chatPolling].bind(self), self[streamData].chatdt, true);
            }
        } catch (err) {
            if (raise) {
                throw err;
            }
            self.emit('error', err);
        }
        if (bootstrap || self[timers].master) {
            self[timers].master = setTimeout(self[runMaster].bind(self), self[streamData].livedt);
        }
    }

    async [chatPolling](bootstrap = false) {
        let self = this;

        await self.getLiveChat()
            .then(function (chat) {
                if (chat.offlineAt) {
                    if (self[streamData].isOnline) {
                        self[streamData].isOnline = false;
                        self.emit('offline', self[streamData].key);
                    }
                    self[resetStreamData]();
                    return;
                }

                self[streamData].pageToken = chat.nextPageToken;
                if (!bootstrap) {
                    self[processMessages](chat.items);
                }

                if (self[timers].chat) {
                    self[timers].chat = setTimeout(
                            self[chatPolling].bind(self),
                            Math.max(chat.pollingIntervalMillis || 0, self[streamData].chatdt),
                            bootstrap && chat.pageInfo.totalResults > chat.pageInfo.resultsPerPage
                        );
                }
            })
            .catch(function (err) {
                    self.emit('error', err);
                    if (self[streamData].isOnline) {
                        self[streamData].chatId = null;
                    }
                });
    }

    async [processMessages](messages) {
        if (!messages || messages.length == 0) {
            return;
        }
        for (let msg of messages) {
            if (!msg.snippet || !msg.snippet.displayMessage) continue;
            this.emit('message', msg.snippet, msg.authorDetails);
        }
    }

    async [MANUAL]() {
        return new Promise((resolve, reject) => { resolve() });
    }

    async [PLAYLIST]() {
        let url = this[urlsYoutube].playlist;
        let params = {
            part: 'contentDetails',
            maxResults: 1,
            playlistId: this[streamData].playlistId,
            key: this[streamData].key
        };

        let result = await this[getYoutube](url, params);
        if (result.items && result.items.length > 0) {
            this[streamData].liveId = result.items[0].contentDetails.videoId;
        } else {
            console.log('[YouTube]', 'liveStream not found via PLAYLIST');
        }
        return result;
    }

    async [SEARCH]() {
        let url = this[urlsYoutube].search;
        let params = {
            part: 'id',
            channelId: this[streamData].channelId,
            eventType: 'live',
            type: 'video',
            key: this[streamData].key
        };

        let result = await this[getYoutube](url, params);
        if (result.items && result.items.length > 0) {
            this[streamData].liveId = result.items[0].id.videoId;
        } else {
            console.log('[YouTube]', 'liveStream not found via SEARCH');
        }
        return result;
    }

    async [BROADCAST]() {
        let url = this[urlsYoutube].live;
        let params = {
            part: 'snippet',
            broadcastType: 'all',
            broadcastStatus: 'active',
            fields: 'items(id,snippet/liveChatId)',
            key: this[streamData].key
        };

        let result = await this[getYoutube](url, params, this[streamData].ownerCredentials);
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
        if (oauth === null) {
            oauth = this;
        }
        await oauth.check();

        let result = await this.axiosYoutube({
            method: 'POST',
            url: url,
            data: data,
            params: params,
            headers: {Authorization: `Bearer ${oauth.getCredentials().accessToken}`}
        });

        return result.data;
    }

    async [getYoutube](url, params, oauth = null) {
        if (oauth === null) {
            oauth = this;
        }
        await oauth.check();

        let result = await this.axiosYoutube({
            method: 'GET',
            url: url,
            params: params,
            headers: {Authorization: `Bearer ${oauth.getCredentials().accessToken}`}
        });

        return result.data;
    }
}

module.exports = {
    client: Youtube,
}