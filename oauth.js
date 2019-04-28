const EventEmitter = require('events');
const axios = require('axios');
const credentialsOAuth = Symbol('credentialsOAuth');
const urlsOAuth = Symbol('urlsOAuth');
const postOAuth = Symbol('postOAuth');
const querystring = require('querystring');

class OAuth2 extends EventEmitter {
    constructor(credentials, urlBase, urlAuthorizate='authorize', urlToken='token', urlRevoke='revoke') {
        super();

        this[credentialsOAuth] = {
            name: credentials.name || 'token',
            clientId: credentials.clientId,
            clientSecret: credentials.clientSecret,
            redirectUrl: credentials.redirectUrl,
            scopes: credentials.scopes,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken || '',
            expiresIn: credentials.expiresIn || '',
            expiresTime: credentials.expiresTime || '',
        };

        this[urlsOAuth] = {
            base: urlBase,
            authorizate: urlAuthorizate,
            token: urlToken,
            revoke: urlRevoke
        };

        this.axiosOAuth = axios.create({
          baseURL: urlBase
        });

        this.axiosOAuth.defaults.headers.post['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    authorizationUrl() {
        return `${this[urlsOAuth].base}${this[urlsOAuth].authorizate}?response_type=code&client_id=${this[credentialsOAuth].clientId}&redirect_uri=${this[credentialsOAuth].redirectUrl}&scope=${this[credentialsOAuth].scopes}`;
    }

    updateCredentials(cred) {
        this[credentialsOAuth].name = cred.name;
        this[credentialsOAuth].accessToken = cred.accessToken;
        this[credentialsOAuth].refreshToken = cred.refreshToken;
        this[credentialsOAuth].expiresIn = cred.expiresIn;
        this[credentialsOAuth].expiresTime = cred.expiresTime;
    }

    getCredentials() {
        return {
            name: this[credentialsOAuth].name,
            accessToken: this[credentialsOAuth].accessToken,
            refreshToken: this[credentialsOAuth].refreshToken,
            expiresIn: this[credentialsOAuth].expiresIn,
            expiresTime: this[credentialsOAuth].expiresTime,
        };
    }

    connect(code) {
        let url = `${this[urlsOAuth].token}`;
        let data = {
            grant_type: 'authorization_code',
            client_id: this[credentialsOAuth].clientId,
            client_secret: this[credentialsOAuth].clientSecret,
            redirect_uri: this[credentialsOAuth].redirectUrl,
            code: code
        };

        return this[postOAuth](url, data).then((result) => {
            this[credentialsOAuth].accessToken = result.data.access_token;
            this[credentialsOAuth].refreshToken = result.data.refresh_token;
            this[credentialsOAuth].expiresIn = result.data.expires_in;
            this[credentialsOAuth].expiresTime = Math.floor(Date.now() / 1000) + result.data.expires_in;
            this.emit('credentials', this.getCredentials());

            return result;
        });
    }

    reconnect(refreshToken) {
        let url = `${this[urlsOAuth].token}`;
        let data = {
            grant_type: 'refresh_token',
            client_id: this[credentialsOAuth].clientId,
            client_secret: this[credentialsOAuth].clientSecret,
            refresh_token: refreshToken
        };

        return this[postOAuth](url, data).then((result) => {
            this[credentialsOAuth].accessToken = result.data.access_token;
            this[credentialsOAuth].refreshToken = result.data.refresh_token || refreshToken;
            this[credentialsOAuth].expiresIn = result.data.expires_in;
            this[credentialsOAuth].expiresTime = Math.floor(Date.now() / 1000) + result.data.expires_in;
            this.emit('credentials', this.getCredentials());

            return result;
        });
    }

    revoke() {
        let url = `${this[urlsOAuth].revoke}`;
        let data = {
            token: this[credentialsOAuth].accessToken
        };

        return this[postOAuth](url, data).then((result) => {
            this[credentialsOAuth].accessToken = '';
            this[credentialsOAuth].refreshToken = '';
            this[credentialsOAuth].expiresIn = '';
            this[credentialsOAuth].expiresTime = '';
            this.emit('credentials', this.getCredentials());

            return result;
        });
    }

    async check() {
        let self = this;
        return await new Promise(function (resolve, reject) {
                if (self[credentialsOAuth].expiresTime < Date.now() / 1000) {
                    return self.reconnect(self[credentialsOAuth].refreshToken)
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

    [postOAuth](url, data) {
        return this.axiosOAuth.post(url, querystring.stringify(data))
        .catch((err) => {
            console.log(`status: ${err.response.status}, url: ${err.response.config.url}, data: ${err.response.config.data}, message: ${JSON.stringify(err.response.data)}`);
            return Promise.reject(err);
        });
    }
}

module.exports = OAuth2;