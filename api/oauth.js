import EventEmitter from 'events';
import { fetchForm } from '../utils.js';

const credentialsOAuth = Symbol('credentialsOAuth');
const urlsOAuth = Symbol('urlsOAuth');
const postOAuth = Symbol('postOAuth');

class OAuth2 extends EventEmitter {
    constructor(credentials, urlBase, urlAuthorizate = 'authorize', urlToken = 'token', urlRevoke = 'revoke') {
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
            revoke: urlRevoke,
        };
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

    async connect(code) {
        const url = `${this[urlsOAuth].token}`;
        const data = {
            grant_type: 'authorization_code',
            client_id: this[credentialsOAuth].clientId,
            client_secret: this[credentialsOAuth].clientSecret,
            redirect_uri: this[credentialsOAuth].redirectUrl,
            code,
        };

        const result = await this[postOAuth](url, data);
        this[credentialsOAuth].accessToken = result.access_token;
        this[credentialsOAuth].refreshToken = result.refresh_token;
        this[credentialsOAuth].expiresIn = result.expires_in;
        this[credentialsOAuth].expiresTime = Math.floor(Date.now() / 1000) + result.expires_in;
        this.emit('credentials', this.getCredentials());

        return result;
    }

    async reconnect(refreshToken) {
        const url = `${this[urlsOAuth].token}`;
        const data = {
            grant_type: 'refresh_token',
            client_id: this[credentialsOAuth].clientId,
            client_secret: this[credentialsOAuth].clientSecret,
            refresh_token: refreshToken,
        };

        const result = await this[postOAuth](url, data);
        this[credentialsOAuth].accessToken = result.access_token;
        this[credentialsOAuth].refreshToken = result.refresh_token || refreshToken;
        this[credentialsOAuth].expiresIn = result.expires_in;
        this[credentialsOAuth].expiresTime = Math.floor(Date.now() / 1000) + result.expires_in;
        this.emit('credentials', this.getCredentials());

        return result;
    }

    async revoke() {
        const url = `${this[urlsOAuth].revoke}`;
        const data = {
            token: this[credentialsOAuth].accessToken,
        };

        const result = await this[postOAuth](url, data);
        this[credentialsOAuth].accessToken = '';
        this[credentialsOAuth].refreshToken = '';
        this[credentialsOAuth].expiresIn = '';
        this[credentialsOAuth].expiresTime = '';
        this.emit('credentials', this.getCredentials());

        return result;
    }

    async check() {
        if (this[credentialsOAuth].expiresTime < Date.now() / 1000) {
            await this.reconnect(this[credentialsOAuth].refreshToken);
        }
    }

    async [postOAuth](url, data) {
        try {
            const fullUrl = new URL(url, this[urlsOAuth].base);
            return await fetchForm(fullUrl, data);
        } catch (err) {
            console.log(
                `status: ${err.status}, url: ${err?.data?.url || url}, data: ${JSON.stringify(data)}, message: ${JSON.stringify(err.data)}`
            );
            return Promise.reject(err);
        }
    }
}

export default OAuth2;
