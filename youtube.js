const OAuth2 = require('./oauth');
const axios = require('axios');
const getYoutube = Symbol('getYoutube');
const postYoutube = Symbol('postYoutube');
const streamData = Symbol('streamData');
const urlsYoutube = Symbol('urlsYoutube');
const timers = Symbol('timers');
const resetStreamData = Symbol('resetStreamData');
const processMessages = Symbol('processMessages');
const checkCredentials = Symbol('checkCredentials');
const chatPolling = Symbol('chatPolling');
const runMaster = Symbol('runMaster');

class Youtube extends OAuth2 {
    constructor(params) {
        if (typeof params !== 'object') {
            throw new Error('YouTube params must be object');
        }
        super(params, 'https://accounts.google.com/o/oauth2/', 'auth');

        this[streamData] = {
            key: params.key,
            livedt: params.livedt || 300000,
            chatdt: params.chatdt || 15000,
            liveId: params.liveId || null,
            chatId: params.chatId || null,
            channelId: params.channelId || '',
            autoSearch: params.autoSearch && true,
            isOnline: false,
            pageToken: '',
        };

        this[urlsYoutube] = {
            channels: 'channels',
            chats: 'liveChat/messages',
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
        if (code) {
            self.connect(code)
                .then(function () {
                    self[timers].master = setTimeout(self[runMaster].bind(self), 10, true);
                    self.emit('ready');
                })
                .catch(function (err) {
                    self.emit('error', err);
                });
        } else if (self.getCredentials().refreshToken) {
            self.reconnect(self.getCredentials().refreshToken)
                .then(function () {
                    self[timers].master = setTimeout(self[runMaster].bind(self), 10, true);
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

    stop() {
        if (this[timers].master) {
            clearTimeout(this[timers].master);
            this[timers].master = null;
            this.emit('stopped');
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

    async liveStream() {
        let url = this[urlsYoutube].live;
        let params = {
            part: 'id,snippet,contentDetails',
            broadcastType: 'all',
            broadcastStatus: 'active',
            key: this[streamData].key
        };

        let result = await this[getYoutube](url, params);
        if (result.items[0])
            this[streamData].liveId = result.items[0].snippet.liveChatId;

        return result;  
    }

    async liveChat() {
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
        console.log('[YouTube] Searching stream...');
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
        }

        return result;
    }

    async searchChat() {
        if (!this[streamData].liveId) {
            throw new Error('liveId is undefined, searching chat is impossible');
        }
        console.log('[YouTube] Searching liveChat...');

        let url = this[urlsYoutube].videos;
        let params = {
            part: 'liveStreamingDetails',
            key: this[streamData].key,
            id: this[streamData].liveId,
        };

        let result = await this[getYoutube](url, params);
        if (result.items && result.items.length > 0) {
            this[streamData].chatId = result.items[0].liveStreamingDetails.activeLiveChatId;
        }

        return result;
    }

    [resetStreamData]() {
        this[streamData].pageToken = null;
        this[streamData].liveId = null;
        this[streamData].chatId = null;
        this[streamData].isOnline = false;
    }

    async [runMaster](bootstrap = false) {
        let self = this;

        try {
            await self[checkCredentials]();

            if (!self[streamData].liveId && (bootstrap || self[streamData].autoSearch)) {
                await self.searchStream();
            }

            if (self[streamData].liveId && !self[streamData].chatId) {
                await self.searchChat();
            }

            if (self[streamData].isOnline && (!self[streamData].liveId || !self[streamData].chatId)) {
                self.stop();
            } else if (!self[streamData].isOnline && self[streamData].liveId && self[streamData].chatId) {
                self.emit('online', this[streamData].key);
                self[timers].chat = setTimeout(self[chatPolling].bind(self), self[streamData].chatdt, true);
            }
        } catch (err) {
            self.emit('error', err);
        }
        if (bootstrap || self[timers].master) {
            self[timers].master = setTimeout(self[runMaster].bind(self), self[streamData].livedt);
        }
    }

    async [chatPolling](bootstrap = false) {
        let self = this;

        await self.liveChat()
            .then(function (chat) {
                if (chat.offlineAt) {
                    if (self[streamData].isOnline) {
                        self.emit('offline', this[streamData].key);
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

    async [checkCredentials]() {
        let self = this;
        let credentials = self.getCredentials();
        return await new Promise(function (resolve, reject) {
                if (credentials.expiresTime < Date.now() / 1000) {
                    return self.reconnect(credentials.refreshToken)
                        .then(function () {
                            resolve();
                        })
                        .catch(function (err) {
                            reject(err);
                        });
                }
                return resolve();
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

    async [postYoutube](url, params, data) {
        let result = await this.axiosYoutube({
            method: 'POST',
            url: url,
            data: data,
            params: params,
            headers: {Authorization: `Bearer ${this.getCredentials().accessToken}`}
        });

        return result.data;
    }

    async [getYoutube](url, params) {
        let result = await this.axiosYoutube({
            method: 'GET',
            url: url,
            params: params,
            headers: {Authorization: `Bearer ${this.getCredentials().accessToken}`}
        });

        return result.data;
    }
}

module.exports = {
    client: Youtube,
}