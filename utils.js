export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const choose = (choices) => choices[Math.floor(Math.random() * choices.length)];

export const template = (source, tags) => {
    if (tags === undefined) {
        return source;
    }
    let result = source;
    for (const prop in tags) {
        result = result.replace(new RegExp(`{${prop}}`, 'g'), tags[prop]);
    }
    return result;
};

export const toFormUrlEncoded = (data) => new URLSearchParams(data).toString();

export const buildUrl = (baseURL, path, params = {}) => {
    const url = baseURL ? new URL(path, baseURL) : new URL(path);
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            return;
        }
        url.searchParams.set(key, value);
    });
    return url;
};

const parseResponseBody = (text) => {
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        return text;
    }
};

export const request = async (url, options = {}) => {
    const response = await fetch(url, options);
    const data = await response.text();
    if (!response.ok) {
        const error = new Error(`Request failed with status ${response.status}`);
        error.status = response.status;
        error.data = data;
        error.response = { status: response.status, data };
        throw error;
    }
    return { data, response };
};

export const fetchJson = async (url, options = {}) => {
    const { data } = await request(url, options);
    return parseResponseBody(data);
};

export const fetchText = async (url, options = {}) => {
    const { data } = await request(url, options);
    return data;
};

export const fetchForm = async (url, data, options = {}) => {
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...options.headers,
    };
    return fetchJson(url, {
        ...options,
        method: 'POST',
        headers,
        body: toFormUrlEncoded(data),
    });
};

export class HttpClient {
    constructor({ baseURL = '', headers = {}, params = {} } = {}) {
        this.baseURL = baseURL;
        this.headers = headers;
        this.params = params;
    }

    async request(path, { method = 'GET', params, headers, body } = {}) {
        const url = buildUrl(this.baseURL, path, { ...this.params, ...params });
        const mergedHeaders = { ...this.headers, ...headers };
        const options = { method, headers: mergedHeaders };
        if (body !== undefined) {
            if (
                typeof body === 'string'
                || body instanceof URLSearchParams
                || body instanceof FormData
            ) {
                options.body = body;
            } else {
                options.body = JSON.stringify(body);
                options.headers = {
                    'Content-Type': 'application/json',
                    ...options.headers,
                };
            }
        }
        return fetchJson(url, options);
    }

    get(path, options = {}) {
        return this.request(path, { ...options, method: 'GET' });
    }

    post(path, body, options = {}) {
        return this.request(path, { ...options, method: 'POST', body });
    }
}
