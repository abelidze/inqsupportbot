const { stringify } = require('querystring');
const OAuth2 = require('./oauth');
const axios = require('axios');
const settings = Symbol('settings');
const apiGet = Symbol('apiGet');
const apiPost = Symbol('apiPost');
const taskQueues = Symbol('taskQueues');
const executeQueue = Symbol('executeQueue');
const processQueue = Symbol('processQueue');
const resetSettings = Symbol('resetSettings');
const polling = Symbol('polling');


class PollingError extends Error { }

class VkBot extends OAuth2 {
    constructor(params) {
        if (typeof params !== 'object') {
            throw new Error('VkBot params must be object');
        }
        super(params, 'https://oauth.vk.com/', 'authorize', 'access_token');

        this[settings] = {
            apiVersion: '5.92',
            groupToken: params.groupToken || null,
            groupId: params.groupId || null,
        };

        this[taskQueues] = {};

        this.axiosVk = axios.create({
          baseURL: 'https://api.vk.com/method/'
        });
    }

    login(refreshToken, code) {
        let self = this;
        setInterval(this[executeQueue].bind(this), 100);
        if (this[settings].groupToken) {
            self[polling]();
        }
        this.emit('ready');
        // if (refreshToken) {
        //     self.reconnect(refreshToken)
        //         .then(function () {
        //             self[polling]();
        //             self.emit('ready');
        //         })
        //         .catch(function (err) {
        //             if (err.response.status >= 400 && err.response.status < 500) {
        //                 self.emit('login');
        //             } else {
        //                 self.emit('error', err);
        //             }
        //         });
        // } else if (code) {
        //     self.connect(code)
        //         .then(function () {
        //             self[polling]();
        //             self.emit('ready');
        //         })
        //         .catch(function (err) {
        //             self.emit('error', err);
        //         });
        // } else {
        //     self.emit('login');
        // }
    }

    getSettings() {
        return this[settings];
    }

    getCredentials() {
        let credentials = super.getCredentials();
        credentials.groupToken = this[settings].groupToken;
        credentials.channelId = this[settings].channelId;

        return credentials;
    }

    authorizationUrl() {
        return super.authorizationUrl() + '&display=page&revoke=1&v=' + this[settings].apiVersion;
    }

    async call(method, args, token) {
        let self = this;
        token = token || self.getCredentials().accessToken;
        if (!self[taskQueues][token]) {
            self[taskQueues][token] = [];
        }
        return await new Promise(function(resolve, reject) {
                self[taskQueues][token].push({
                    code: `API.${method}(${JSON.stringify({
                        v: self[settings].apiVersion,
                        ...args,
                    })})`,
                    resolve,
                    reject,
                });
            });
    }

    [resetSettings]() {
        this[settings].groupId = null;
    }

    [executeQueue]() {
        for (let token in this[taskQueues]) {
            this[processQueue](this[taskQueues][token], token);
            this[taskQueues][token] = [];
        }
    }

    async [processQueue](methods, token) {
        let self = this;
        for (let i = 0, j = Math.ceil(methods.length / 25); i < j; ++i) {
            const slicedMethods = methods.slice(i * 25, i * 25 + 25);

            self[apiPost]('execute', {
                code: `return [ ${slicedMethods.map(item => item.code)} ];`,
                access_token: token,
            })
            .then(function ({ response, execute_errors = [] }) {
                let errorIndex = -1;
                response.forEach(function (body, index) {
                    if (body === false) {
                        slicedMethods[index].reject(execute_errors[++errorIndex]);
                    } else {
                        slicedMethods[index].resolve(body);
                    }
                });
            })
            .catch(function (err) {
                self.emit('error', err);
            });
        }
    }

    async [polling](ts) {
        let self = this;
        try {
            if (!this[settings].groupId) {
                const { response } = await this[apiGet]('groups.getById', {
                        access_token: self[settings].groupToken,
                    });
                this[settings].groupId = response[0].id;
            }

            if (!self.pollingParams) {
                const { response } = await self[apiGet]('groups.getLongPollServer', {
                        group_id: self[settings].groupId,
                        access_token: self[settings].groupToken,
                    })
                    .catch(function (err) {
                        self.emit('error', err);
                        if (err.error_code === 15) {
                            process.exit(1);
                        }
                    });
                self.pollingParams = response;
            }

            const { data: body } = await axios.get(self.pollingParams.server, {
                    params: {
                        ...self.pollingParams,
                        ts,
                        act: 'a_check',
                        wait: 25,
                    },
                })
                .catch(() => {
                    throw new PollingError();
                });

            if (!body.failed) {
                body.updates.forEach(function ({ type, object: update }) {
                    if (!update) return;
                    self.emit(type, update);
                });
                return self[polling](body.ts);
            }

            switch (body.failed) {
                case 1:
                    return self[polling](body.ts);
                case 2:
                case 3:
                    self.pollingParams = null;
                    return self[polling]();
                default:
                    self.emit('error', `Listening Error: ${JSON.stringify(body)}`);
                    self.pollingParams = null;
                    return self[polling]();
            }
        } catch (e) {
            if (e instanceof PollingError) {
                console.log('PollingError');
                self.pollingParams = null;
                return self[polling]();
            } else {
                throw e;
            }
        }
    }

    async [apiPost](url, data) {
        data = Object.assign(
            {
                v: this[settings].apiVersion,
                access_token: data.access_token || this.getCredentials().accessToken,
            },
            data
        );

        let result = await this.axiosVk.post(url, stringify(data));
        if (result.data.error) {
            throw new Error(result.data);
        }

        return result.data;
    }

    async [apiGet](url, params) {
        params = Object.assign(
            {
                v: this[settings].apiVersion,
                access_token: params.access_token || this.getCredentials().accessToken,
            },
            params
        );

        let result = await this.axiosVk({
            method: 'GET',
            url: url,
            params: params,
        });

        return result.data;
    }
}

module.exports = {
    client: VkBot,
}