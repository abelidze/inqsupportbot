About InqSuppotBot
==================

InqSuppotBot is a chatbot integrated with dialogflow as backend and discord / twitch / socket.io (for website) as frontend.

Code is pretty nasty and dirty and highly needs refactor.


How it works
------------

This bot uses multiple requests flows - redis / socket.io, twitch and discord.<br />
Twitch / Discord integration is simple - it redirects all request to dialogflow, takes response and sends answer.

Redis / Socket.IO integration otherwise is more complex.<br />
To make it working you must provide:
1. Configured redis-server / redis service; it must be integrated with your website to pass request to bot;<br />
It was made this way for using website's auth / ban system.<br />
Socket.IO is served on 'localhost:9090'.
2. API-server that has `/api/ban` and `/api/unban` endpoints.
It can be accessed by agent-users in specific discord channel.
3. Discord-channel with users whose answer questions if dialogflow's fallback intent was triggered.

Important note: after fallback was triggered bot starts 'private chat' - during specified period of time all
messages from client would be redirected to discord. It is usefull for providing better UX and prevents
dialogflow from answering dialog specific questions without context.

After message was redirected to discord you can answer with following syntax:<br/>
`#<dialog_id> /<command> @<intent_name> <actual_answer>`

* dialog_id - provided in initial message;
* command - one of: `ban`, `unban`, `close`;
* intent_name - name of intent for training bot.


Installation
------------

Download project as '.zip' archive and extract it to whatever you like directory or use `git`:
```sh
$ git clone https://github.com/abelidze/inqsupportbot.git
```


Requirements
------------

* Redis (for using with socker.io and your website)
* Node.JS 10.0+


Configuration
-------------

Before running you must do some work with configs.

1. First of all, to use dialogflow your must create and save service account key.
You can find more information on how to do it [here](https://cloud.google.com/iam/docs/creating-managing-service-account-keys).
2. After retriving .json service account key make configuration module: `mkdir config && touch index.js`
And place your `<ACCOUNT_KEY_FILENAME>.json` to `config`.
3. Fill `index.js` with:
```
const path = require('path')

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(path.join(__dirname, '<ACCOUNT_KEY_FILENAME>.json'));

module.exports = {
    API_OPTIONS: {
        baseUrl: '<APP_BASE_URL>',
        headers: {
            'User-Agent': 'Request-Promise',
            'Authorization': 'Bearer <ACCESS_TOKEN_FOR_YOUR_API>'
        },
        json: true
    },
    TWITCH_OPTIONS: {
        options: {
          debug: true
        },
        connection: {
          cluster: "aws",
          reconnect: true
        },
        identity: {
            username: "<TWITCH_BOT_ACCOUNT_NAME>",
            password: "<TWITCH_OAUTH_TOKEN>"
        },
        channels: ['<TWITCH_CHANNEL_NAME_1>', '<TWITCH_CHANNEL_NAME_2>', ...],
        logger: {
            info: function () {},
            warn: function () {},
            error: function (err) {
                console.error('TwitchError:', err);
            }
        }
    },
    REDIS_HOST: '<REDIS_HOST>',
    REDIS_PORT: REDIS_PORT,
    DISCORD_TOKEN: '<DISCORD_BOT_TOKEN>',
    PROJECT_ID: '<DIALOGFLOW_PROJECT_ID>',
    CHANNEL: '<DISCORD_CHANNEL_SNOWFLAKE_ID>',
}

```

* ACCOUNT_KEY_FILENAME - filename of your service account .json key;
* DIALOGFLOW_PROJECT_ID - project id of your dialogflow application, can be found inside .json service key file;
* APP_BASE_URL - your website url, used for `/api/ban/` and `/api/unban/` API methods;
* TWITCH_BOT_ACCOUNT_NAME - account username for your twitch-bot;
* TWITCH_OAUTH_TOKEN - Twitch OAuth token, more info [here](https://twitchapps.com/tmi/);
* TWITCH_CHANNEL_NAME_x - channels where you want make your bot to work;
* REDIS_HOST - redis-server host, used for website integration;
* REDIS_PORT - redis-server port, used for website integration;
* DISCORD_BOT_TOKEN - your discord bot secret token, used for all discord integrations;
* DISCORD_CHANNEL_SNOWFLAKE_ID - currently discord bot can serve only one channel by its id.


Running
-------

> **Simple Node.JS**

```sh
npm install && node server.js
# or
yarn install && node server.js
```

> **Shell script with auto-restart**

```sh
npm install && ./loopbot.sh
# or
yarn install && ./loopbot.sh
```

> **With run script**

```sh
npm install && npm run start
# or
yarn install && yarn start
```

> **Dockerfile**

```sh
docker build .
```


Contact
-------

Developers on Telegram:

[![https://t.me/Abelidze](https://img.shields.io/badge/%E2%9E%A4Telegram-@Abelidze-DD2200.svg?style=flat-square&&colorA=2D233B)](https://t.me/Abelidze)


License
-------
InqSupportBot is open-sourced software licensed under the [Apache-2.0 License](https://opensource.org/licenses/Apache-2.0).

#### Disclaimer

This program is provided "AS IS" without warranty of any kind.