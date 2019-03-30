const OAuth2 = require('./oauth');
const axios = require('axios');
const getYoutube = Symbol('getYoutube');
const getViewers = Symbol('getViewers');
const postYoutube = Symbol('postYoutube');
const streamData = Symbol('streamData');
const urlsYoutube = Symbol('urlsYoutube');
const resetStreamData = Symbol('resetStreamData');
const processMessages = Symbol('processMessages');
const chatPolling = Symbol('chatPolling');
const runMaster = Symbol('runMaster');

class Youtube extends OAuth2 {
	constructor(params) {
		super(params.clientId, params.clientSecret, params.redirectUrl, params.scopes, params.accessToken || '', 'https://accounts.google.com/o/oauth2/', 'auth');

		this[streamData] = {
			key: params.key,
			livedt:  params.livedt || 300000,
			chatdt:  params.chatdt || 20000,
			liveId: params.liveId || '',
			chatId: params.chatId || '',
			channelId: params.channelId || '',
			pageToken: '',
		};
		
		this[urlsYoutube] = {
			channels: 'channels',
			chats: 'liveChat/messages',
			search: 'search',
			videos: 'videos',
			live: 'liveBroadcasts',
		};

		this.axiosYoutube = axios.create({
		  baseURL: 'https://www.googleapis.com/youtube/v3/'
		});
	}

	login(refreshToken, code) {
		let self = this;
		if (refreshToken) {
			self.reconnect(refreshToken)
				.then(function () {
					self[runMaster]();
					self.emit('ready');
				})
				.catch(function (err) {
					if (err.response.status >= 400 && err.response.status < 500) {
						self.emit('login');
					} else {
						self.emit('error', err);
					}
				});
		} else if (code) {
			self.connect(code)
				.then(function () {
					self[runMaster]();
					self.emit('ready');
				})
				.catch(function (err) {
					self.emit('error', err);
				});
		} else {
			self.emit('login');
		}
	}

	getCredentials() {
		let credentials = super.getCredentials();
		credentials.liveId = this[streamData].liveId;
		credentials.channelId = this[streamData].channelId;

		return credentials;
	}

	authorizationUrl() {
		return super.authorizationUrl() + '&access_type=offline&approval_prompt=force';
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
		return await this[getViewers]();
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

	async searchChat() {
		let url = this[urlsYoutube].videos;
		let params = {
			part: 'liveStreamingDetails',
			key: this[streamData].key,
			id: this[streamData].liveId,
		};

		let result = await this[getYoutube](url, params);
		if (result.items[0])
			this[streamData].chatId = result.items[0].liveStreamingDetails.activeLiveChatId;

		return result;	
	}
	
	async searchStream() {
		let url = this[urlsYoutube].search;
		let params = {
			part: 'snippet',
			channelId: this[streamData].channelId,
			eventType: 'live',
			type: 'video',
			key: this[streamData].key
		};

		let result = await this[getYoutube](url, params);
		if (result.items[0])
			this[streamData].liveId = result.items[0].id.videoId;

		return result;
	}

	[resetStreamData]() {
		this[streamData].pageToken = '';
		this[streamData].liveId = '';
	}

	[chatPolling](bootstrap = false) {
		let self = this;
		self.liveChat()
			.then(function (chat) {
				if (chat.pollingIntervalMillis) {
					self[streamData].pageToken = chat.nextPageToken;
					if (!bootstrap) {
						self[processMessages](chat.items);
					}
					setTimeout(
						self[chatPolling].bind(self),
						Math.max(chat.pollingIntervalMillis, self[streamData].chatdt),
						bootstrap && chat.pageInfo.totalResults > chat.pageInfo.resultsPerPage
					);
				}
			})
			.catch(function () {
				self.searchStream()
					.catch(function () {
						self[resetStreamData]();
						self.emit('offline');
					});
			})
	}
	async [runMaster]() {
		let self = this;
		let credentials = self.getCredentials();
		if (credentials.expiresTime < Date.now() / 1000) {
			await self.reconnect(credentials.refreshToken)
				.catch(function (err) {
					self.emit('error', err);
				});
		}
		if (!self[streamData].liveId) {
			self.searchStream()
				.then(function () {
					if (!self[streamData].liveId) return;
					return self.searchChat();
				})
				.then(function () {
					self.emit('online');
					self[chatPolling](true);
				})
				.catch(function (err) {
					self.emit('error', err);
				});
		}
		setTimeout(self[runMaster].bind(self), self[streamData].livedt);
	}

	async [processMessages](messages) {
		if (messages.length == 0) {
			return;
		}
		for (let msg of messages) {
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

	async [getViewers]() {
		let url = `https://www.youtube.com/live_stats?v=${this[streamData].liveId}`;
		let result = await require('axios').get(url);
		return result.data;
	}
}

module.exports = {
	client: Youtube,
}