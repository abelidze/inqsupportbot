import { stringify } from 'querystring';
import OAuth2 from './oauth.js';
import { buildUrl, fetchJson } from '../utils.js';

const settings = Symbol('settings');
const apiGet = Symbol('apiGet');
const apiPost = Symbol('apiPost');
const taskQueues = Symbol('taskQueues');
const executeQueue = Symbol('executeQueue');
const processQueue = Symbol('processQueue');
const resetSettings = Symbol('resetSettings');
const polling = Symbol('polling');

export class PollingError extends Error { }

export class VkClient extends OAuth2 {
    constructor(params) {
        if (typeof params !== 'object') {
            throw new Error('VkClient params must be object');
        }
        super(params, 'https://oauth.vk.com/', 'authorize', 'access_token');

        this[settings] = {
            apiVersion: '5.92',
            groupToken: params.groupToken || null,
            groupId: params.groupId || null,
        };

        this[taskQueues] = {};
    }

    login(refreshToken, code) {
        setInterval(this[executeQueue].bind(this), 100);
        if (this[settings].groupToken) {
            this[polling]();
        }
        this.emit('ready');
    }

    getSettings() {
        return this[settings];
    }

    getCredentials() {
        const credentials = super.getCredentials();
        credentials.groupToken = this[settings].groupToken;
        credentials.channelId = this[settings].channelId;
        return credentials;
    }

    authorizationUrl() {
        return `${super.authorizationUrl()}&display=page&revoke=1&v=${this[settings].apiVersion}`;
    }

    async call(method, args, token) {
        const accessToken = token || this.getCredentials().accessToken;
        if (!this[taskQueues][accessToken]) {
            this[taskQueues][accessToken] = [];
        }
        return new Promise((resolve, reject) => {
            this[taskQueues][accessToken].push({
                code: `API.${method}(${JSON.stringify({
                    v: this[settings].apiVersion,
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
        for (const token in this[taskQueues]) {
            this[processQueue](this[taskQueues][token], token);
            this[taskQueues][token] = [];
        }
    }

    async [processQueue](methods, token) {
        for (let i = 0, j = Math.ceil(methods.length / 25); i < j; i += 1) {
            const slicedMethods = methods.slice(i * 25, i * 25 + 25);

            this[apiPost]('execute', {
                code: `return [ ${slicedMethods.map((item) => item.code)} ];`,
                access_token: token,
            })
                .then(({ response, execute_errors = [] }) => {
                    let errorIndex = -1;
                    response.forEach((body, index) => {
                        if (body === false) {
                            slicedMethods[index].reject(execute_errors[++errorIndex]);
                        } else {
                            slicedMethods[index].resolve(body);
                        }
                    });
                })
                .catch((err) => {
                    this.emit('error', err);
                });
        }
    }

    async [polling](ts) {
        try {
            if (!this[settings].groupId) {
                const { response } = await this[apiGet]('groups.getById', {
                    access_token: this[settings].groupToken,
                });
                this[settings].groupId = response[0].id;
            }

            if (!this.pollingParams) {
                const { response } = await this[apiGet]('groups.getLongPollServer', {
                    group_id: this[settings].groupId,
                    access_token: this[settings].groupToken,
                }).catch((err) => {
                    this.emit('error', err);
                    if (err.error_code === 15) {
                        process.exit(1);
                    }
                });
                this.pollingParams = response;
            }

            const url = buildUrl(this.pollingParams.server, '', {
                ...this.pollingParams,
                ts,
                act: 'a_check',
                wait: 25,
            });
            const body = await fetchJson(url).catch(() => {
                throw new PollingError();
            });

            if (!body.failed) {
                body.updates.forEach(({ type, object: update }) => {
                    if (!update) {
                        return;
                    }
                    this.emit(type, update);
                });
                return this[polling](body.ts);
            }

            switch (body.failed) {
                case 1:
                    return this[polling](body.ts);
                case 2:
                case 3:
                    this.pollingParams = null;
                    return this[polling]();
                default:
                    this.emit('error', `Listening Error: ${JSON.stringify(body)}`);
                    this.pollingParams = null;
                    return this[polling]();
            }
        } catch (e) {
            if (e instanceof PollingError) {
                this.emit('error', 'PollingError');
                this.pollingParams = null;
                return this[polling]();
            }
            throw e;
        }
    }

    async [apiPost](url, data) {
        const payload = Object.assign(
            {
                v: this[settings].apiVersion,
                access_token: data.access_token || this.getCredentials().accessToken,
            },
            data,
        );

        const result = await fetchJson('https://api.vk.com/method/' + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: stringify(payload),
        });
        if (result.error) {
            throw new Error(result.error);
        }

        return result;
    }

    async [apiGet](url, params) {
        const query = Object.assign(
            {
                v: this[settings].apiVersion,
                access_token: params.access_token || this.getCredentials().accessToken,
            },
            params,
        );
        const fullUrl = buildUrl('https://api.vk.com/method/', url, query);
        return fetchJson(fullUrl);
    }
}
