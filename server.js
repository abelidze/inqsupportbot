const config = require('./config');
const shortid = require('shortid');
const readline = require('readline');
const dialogflow = require('dialogflow');
const youtube = require('./youtube');
const discord = require('discord.js');
const twitch = require('tmi.js');
const cookie = require('cookie');
const redis = require('redis');
const axios = require('axios');
const OpenAI = require('openai');
const sio = require('socket.io').listen(9090);
const io = require('socket.io-client');
const fs = require('fs');

const $backend = axios.create(config.API_OPTIONS);

const alertsClient = io('wss://socket9.donationalerts.ru:443', {
        reconnection: true,
        reconnectionDelayMax: 5000,
        reconnectionDelay: 1000,
    });

const redisClient = redis.createClient({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASS,
    retry_strategy: config.REDIS_POLICY,
});

const AI = () => config.BOT_BACKEND[config.BOT_AI];
const brainClient = new OpenAI({ apiKey: AI().key, baseURL: AI().url, timeout: 10000 });
const dialogClient = new dialogflow.SessionsClient();

const discordClient = new discord.Client({
    intents: [
        discord.GatewayIntentBits.Guilds,
        discord.GatewayIntentBits.GuildMessages,
        discord.GatewayIntentBits.GuildMessageReactions,
        discord.GatewayIntentBits.MessageContent,
        discord.GatewayIntentBits.DirectMessages,
        discord.GatewayIntentBits.DirectMessageTyping
    ],
    partials: [
        discord.Partials.Message,
        discord.Partials.Channel,
        discord.Partials.Reaction
    ]
});
const twitchClient = new twitch.Client(config.TWITCH);
const youtubeClient = new youtube.client(config.YOUTUBE);

const questionThrottle = {
        users: {},
        limit: 5000,
        memory: 20,
    };

const uuidToClient = {};
const shortidToUuid = {};
let botCommands = [];
let streamerData = {};

const MAX_DELAY_MS = 60_000;
const BASE_DELAY_MS = 2_000;
let discordAttempts = 0;

// TODO: refactor for ES6+
// TODO: OOP is really needed
// TODO: improve expired sockets
// TODO: improve auth security (it's very nasty and bad at the moment)
// TODO: move regex-command for questionHandler to config
// BUG: YouTube switching not working on bootstrap with offline stream and exceeded quota

/**
 * WEBSITE
 */

sio.use(function (socket, next) {
    if (socket.handshake.headers.cookie || socket.request.headers.cookie) {
        return next();
    }
    next(new Error('Authentication error'));
});

sio.on('error', function (err) {
    console.error('[SocketError]', err);
});

sio.on('connection', function (socket) {
    socket.cookie = socket.handshake.headers.cookie || socket.request.headers.cookie;
    const uuid = cookie.parse(socket.cookie).uuid;
    if (uuid == undefined) {
        return;
    }

    let client = undefined;
    if (uuidToClient[uuid] !== undefined) {
        client = uuidToClient[uuid];
        if (client.destroy !== undefined) {
            clearTimeout(client.destroy);
            client.destroy = undefined;
        }
    } else {
        client = {
            id: shortid.generate(),
            session: dialogClient.sessionPath(config.DIALOGFLOW_PROJECT, uuid),
            socks: {},
            redis: redis.createClient({
                host: config.REDIS_HOST,
                port: config.REDIS_PORT,
                password: config.REDIS_PASS,
                retry_strategy: config.REDIS_POLICY,
            }),
            private: {
                time: 0,
                delay: 90000,
            },
            throttle: {
                count: 0,
                time: 0,
                limit: {
                    count: 3,
                    time: 10000,
                },
            },
        };
        shortidToUuid[client.id] = uuid;
        // console.log('[Dialog] %s connected', uuid);

        /// INIT REDIS
        client.redis.subscribe('ban.' + uuid);
        client.redis.subscribe('auth.' + uuid);
        client.redis.subscribe('message.' + uuid);

        client.redis.on('error', function (err) {
            console.error('[RedisError] ', err);
        });

        client.redis.on('message', function (channel, payload) {
            if (!channel.startsWith('message.')) {
                if (channel.startsWith('auth.')) {
                    Object.values(client.socks).forEach(function(sock) {
                        sock.emit('auth', {});
                    });
                } else if (channel.startsWith('ban.')) {
                    Object.values(client.socks).forEach(function(sock) {
                        sock.emit('ban', {});
                    });
                }
                return;
            }

            let timestamp = Date.now();
            if (timestamp - client.throttle.time > client.throttle.limit.time) {
                client.throttle.count = 0;
                client.throttle.time = timestamp;
            } else if (client.throttle.count >= client.throttle.limit.count) {
                const msg = {
                    message: {
                        type: 'system',
                        data: {
                            text: 'Превышен лимит сообщений. Подождите '
                                + Math.trunc(client.throttle.limit.time / 1000)
                                + ' секунд и повторите попытку.',
                        }
                    }
                };
                Object.values(client.socks).forEach(function(sock) {
                    sock.emit('message', msg);
                });
                return;
            }
            ++client.throttle.count;

            const tokens = payload.match(/(\[.*?\])?\s*(.+)/);

            if (tokens == null) {
                return;
            }

            let passToDiscord = false;
            let response = {
                message: {
                    type: 'text',
                    author: 'bot',
                    data: {
                        text: 'Сегодня я не доступен, передаю твой вопрос выше.'
                    }
                }
            };

            let processDiscord = async function(private = false) {
                    if (!private) {
                        Object.values(client.socks).forEach(function(sock) {
                            sock.emit('message', response);
                        });
                    }

                    if (!passToDiscord) {
                        return;
                    }

                    if (timestamp - client.private.time > client.private.delay) {
                        client.private.time = timestamp;
                    }

                    const textChannel = await discordClient.channels.cache.find(function (ch) {
                        return config.DISCORD_CHANNELS.includes(ch.id);
                    });

                    if (textChannel) {
                        await textChannel.send(
                                (private ? '' : '@everyone\n') + `#${client.id}\n${payload}`
                            );
                    }
                };

            if (timestamp - client.private.time < client.private.delay) {
                passToDiscord = true;
                processDiscord(true);
                return;
            }

            dialogClient.detectIntent({
                session: client.session,
                queryInput: {
                    text: {
                        text: tokens[2],
                        languageCode: 'ru-RU',
                    }
                }
            }).then(function (responses) {
                const result = responses[0].queryResult;
                passToDiscord = (!result.intent || result.action == 'input.unknown');
                if (!passToDiscord && result.fulfillmentMessages && result.fulfillmentMessages.length > 0) {
                    response.message.data.text = result.fulfillmentMessages[0].text.text[0];
                } else {
                    response.message.data.text = result.fulfillmentText;
                }
            }).catch(function (err) {
                console.error('[DialogError]', err);
                passToDiscord = true;
            }).finally(processDiscord);
        });
        /// END INIT REDIS
    }
    client.socks[socket.id] = socket;

    socket.on('disconnect', function () {
        delete client.socks[socket.id];
        if (Object.keys(client.socks).length == 0) {
            client.destroy = setTimeout(function () {
                client.redis.quit();
                delete uuidToClient[uuid];
                // console.log('[Dialog] %s destroyed', uuid);
            }, 120000);
        }
    });

    uuidToClient[uuid] = client;
});

/**
 * REDIS
 */

redisClient.on('message', function (channel, payload) {
    if (channel !== 'control') {
        return
    }

    switch (payload) {
        case 'reboot':
            process.exit();
            break;

        default:
            return;
    }
});

redisClient.on('error', function (err) {
    console.error('[RedisError]', err);
});

/**
 * DISCORD
 */

function isFatalLoginError(err) {
    const msg = String(err?.message || '');
    return (
        msg.includes('TOKEN_INVALID') ||
        msg.includes('An invalid token was provided') ||
        err?.code === 50035 // Invalid Form Body (covers some malformed-token cases)
    );
}

function backoffDelay(attempt) {
    const expo = BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * 1000);
    return Math.min(MAX_DELAY_MS, expo + jitter);
}

async function discordLoginWithRetry(client, token) {
    for (;;) {
        try {
            discordAttempts += 1;
            await client.login(token);
            console.log('[Discord] Logged in after', discordAttempts, 'attempt(s).');
            discordAttempts = 0;
            return;
        } catch (err) {
            if (isFatalLoginError(err)) {
                console.error('[DiscordLogin:FATAL]', err?.message || err);
                return;
            }
            const d = backoffDelay(discordAttempts);
            console.error(`[DiscordLogin:RETRY] attempt=${discordAttempts} in ${d}ms →`, err?.code || err?.message || err);
            await new Promise(r => setTimeout(r, d));
        }
    }
}

discordClient.on(discord.Events.ClientReady, function () {
    console.log('[Discord] Hi, %s!', discordClient.user.tag);
});

discordClient.on(discord.Events.MessageCreate, function (message) {
    const msg = message.cleanContent.trim();

    try {
        if (message.member?.permissions?.has(discord.PermissionFlagsBits.Administrator) && msg.match(config.YOUTUBE_TRIGGER)) {
            questionThrottle.users = { };
            setTimeout(function () {
                youtubeClient.runImmediate()
                    .then(function () {
                        if (!youtubeClient.getStreamData().liveId) {
                            message.reply('YouTube-стрим не найден!');
                        }
                    })
                    .catch(function (err) {
                        if (err.response && err.response.data) {
                            console.error('[DiscordYouTubeError]', err.response.data.error);
                        } else {
                            console.error('[DiscordYouTubeError]', err);
                        }
                        message.reply('YouTube-API отклонило запрос!');
                    });
                }, 15000);
            return;
        }
    } catch (err) {
        console.error('[DiscordYouTubeError]', err);
    }

    if (!config.DISCORD_CHANNELS.includes(message.channel.id) || message.author.tag == discordClient.user.tag) {
        return;
    }

    if (msg.search(/^[@!\/]/) !== -1) {
        questionHandler('cepreu_inq', 'd' + message.author.id, message.author.username, msg, function (answer) {
                if (answer.command) {
                    message.reply(answer.text);
                }
            });
        return;
    }

    if (!msg.startsWith('#')) {
        return;
    }

    const tokens = msg.match(/^\#([0-9a-zA-z\-_]+)\s*(\/([^\s]+))?\s*(\@([^\s]+))?\s*(.*)/);
    if (tokens == null) {
        return;
    }

    const id = tokens[1];
    const command = tokens[3];
    const intent = tokens[5];
    const answer = tokens[6];

    if (!shortid.isValid(id)
        || shortidToUuid[id] === undefined
        || uuidToClient[shortidToUuid[id]] === undefined)
    {
        message.reply('Собеседник не найден!');
        return;
    }

    let uuid = shortidToUuid[id];
    let client = uuidToClient[uuid];
    client.private.time = Date.now();

    if (intent) {
        // create / update intent...
    }

    if (answer.trim().length > 0) {
        let response = {
            message: {
                type: 'text',
                author: 'bot',
                data: {
                    text: answer
                }
            }
        };

        if (!message.author.bot) {
            response.message.author = message.author.tag;
            response.author = {
                id: message.author.tag,
                name: message.author.username,
                imageUrl: message.author.avatarURL(),
            };
        }

        Object.values(client.socks).forEach(function(sock) {
            sock.emit('message', response);
        });
    }

    switch (command) {
        case 'ban':
            if (!message.member?.permissions?.has(discord.PermissionFlagsBits.BanMembers)) {
                break;
            }
            $backend.get('/api/ban/' + uuid)
                .then(function () {
                    console.log('User %s banned', uuid);
                    Object.values(client.socks).forEach(function(sock) {
                       sock.emit('ban', {});
                    });
                    message.reply('Пользователь заблокирован!');
                })
                .catch(function () {
                    console.log('Can`t ban user %s', uuid);
                });
            break;

        case 'unban':
            if (!message.member?.permissions?.has(discord.PermissionFlagsBits.BanMembers)) {
                break;
            }
            $backend.get('/api/unban/' + shortidToUuid[id])
                .then(function () {
                    console.log('User %s unbanned', uuid);
                    Object.values(client.socks).forEach(function(sock) {
                       sock.emit('unban', {});
                    });
                    message.reply('Пользователь разблокирован!');
                })
                .catch(function () {
                    console.log('Can`t unban user %s', uuid);
                });
            break;

        case 'close':
            client.private.time = 0;
            const payload = {
                message: {
                    type: 'system',
                    data: {
                        text: 'Собеседник завершил беседу'
                    }
                }
            };
            Object.values(client.socks).forEach(function(sock) {
               sock.emit('message', payload);
            });
            break;
    }
});

discordClient.on(discord.Events.Error, function (err) {
    console.error('[DiscordError]', err);
});

/**
 * TWITCH
 */

twitchClient.on('connected', function (address, port) {
    console.log('[Twitch] Hi, %s!', twitchClient.getUsername());
});

twitchClient.on('chat', function (channel, tags, message, self) {
    const msg = message.trim();
    if (self || tags.username.match(config.IGNORE)) {
        return;
    }

    questionHandler(channel.substr(1), 't' + tags['user-id'], tags.username, msg, function (answer) {
            if (ignoreAnswer(answer)) {
                return;
            }
            twitchClient.say(channel, '@' + tags.username + ' ' + answer.text).catch(err => console.log('[TwitchSayError]', err));
        });
});

twitchClient.on('error', function (err) {
    console.error('[TwitchError]', err);
});

/**
 * DONATION ALERTS
 */

alertsClient.on('connect', () => {
    alertsClient.emit('add-user', { token: config.DALERTS.token, type: 'minor' });
    console.log('[DAlerts]', 'Connected!');
    setTimeout(getLastSongText, 1000);
});

// alerts.on('donation', function(data) { });
alertsClient.on('media', data => {
    if (typeof data === 'string') {
        data = JSON.parse(data);
    }
    if (!data || typeof data.action === 'undefined') {
        return;
    }
    config.DALERTS.timestamp = Date.now();
    switch (data.action) {
        case 'play':
        case 'receive-current-media':
            config.DALERTS.songTitle = data.media.title;
            config.DALERTS.songUrl = null;
            if (data.media.sub_type && data.media.sub_type == 'youtube') {
                config.DALERTS.songUrl = `https://youtu.be/${data.media.additional_data.video_id}`;
            }
            break;
    }
    for (let bonus of config.DALERTS.specials) {
        handleBonusMode(data, bonus);
    }
});

function getLastSongText(fallback) {
    const timestamp = Date.now();
    if (timestamp - config.DALERTS.timestamp > config.DALERTS.cacheTimeout) {
        config.DALERTS.songTitle = null;
        config.DALERTS.songUrl = null;
        config.DALERTS.timestamp = timestamp;
    }

    if (config.DALERTS.songTitle) {
        return `${config.DALERTS.songTitle} ${config.DALERTS.songUrl ? ' ' + config.DALERTS.songUrl : ''}`;
    }
    alertsClient.emit('media', {
        token: config.DALERTS.token,
        message_data: { action: 'get-current-media', source: 'last_alerts_widget' }
    });
    return fallback;
}

function handleBonusMode(data, bonus) {
    switch (data.action) {
        case 'play':
        case 'receive-current-media':
            if (bonus.active || typeof data.media === 'undefined' || data.media.title.match(bonus.regex) === null) {
                break;
            }
            const msgString = choose(config.DALERTS.messages);
            const msg = {};
            for (let key in bonus.message) {
                msg[key] = msgString;
            }
            console.log('[DAlerts]', 'Bonus activated!');
            broadcastMessage(msg);
            bonus.active = true;
        case 'unpause':
            if (bonus.active && bonus.timeout == null) {
                bonus.timeout = setTimeout(bonusWorker, 8000, bonus);
            }
            break;

        case 'end':
        case 'skip':
        case 'stop':
            bonus.active = false;
        case 'pause':
            if (bonus.timeout != null) {
                console.log('[DAlerts]', 'Bonus', data.action);
                clearTimeout(bonus.timeout);
                bonus.timeout = null;
            }
            break;
    }
}

function bonusWorker(bonus) {
    broadcastMessage(bonus.message);
    bonus.timeout = setTimeout(bonusWorker, 8000 + Math.random() * 7000, bonus);
}

/**
 * YOUTUBE
 */

youtubeClient.on('login', function () {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.question(
        '[Youtube] OAuth url: ' + this.authorizationUrl() + '\n',
        function (code) {
            youtubeClient.login(code);
            rl.close();
        });
    console.log('[Youtube] Enter your code: ');
});

youtubeClient.on('ready', function () {
    console.log('[Youtube] Hi!');
});

youtubeClient.on('credentials', function (credentials) {
    let name = credentials.name || youtubeClient.getStreamData().key;
    fs.writeFile(`config/${name}.json`, JSON.stringify(credentials), function () {});
    console.log(`[YouTube] Token updated for ${name}`);
});

youtubeClient.on('online', function (key) {
    console.log(`[YouTube] Stream connected, ${key}`);
});

youtubeClient.on('offline', function (key) {
    console.log(`[YouTube] Stream disconnected, ${key}`);
});

youtubeClient.on('stopped', function (key) {
    console.log(`[YouTube] Client stopped, ${key}`);
});

youtubeClient.on('message', function (message, user) {
    const msg = message.displayMessage.trim();

    if (user.displayName.match(config.IGNORE)) {
        // console.log('ignored', msg);
        return;
    }
    // console.log('[YouTube]', msg);

    questionHandler('cepreu_inq', 'y' + user.channelId, user.displayName, msg, function (answer) {
            if (ignoreAnswer(answer)) {
                return;
            }
            youtubeClient.sendMessage(('@' + user.displayName + ' ' + answer.text).substr(0, 199))
                .catch(function (err) {
                    console.error(err.response.data);
                });
        });
});

youtubeClient.on('error', function (err) {
    if (err.response && err.response.data) {
        if (!err.response.data.error) {
            console.error('[YouTubeError]', err.response.data);
            return;
        }
        // if (err.response.data.error.code == 403) --> quota exceeded
        if (err.response.data.error.message) {
            console.error('[YouTubeError]', err.response.data.error.message);
            return;
        }
    }
    console.error('[YouTubeError]', err);
});

async function getToken(clientId, clientSecret) {
    try {
        const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials'
            }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('[Token Error]', error.response?.data || error.message);
        throw error;
    }
}

async function getStreamData(clientId, token, streamer) {
    try {
        const response = await axios.get(`https://api.twitch.tv/helix/streams?user_login=${streamer}`, {
            headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` }
        });
        const bot = config.BOT_NAME;
        const username = response.data.data[0]?.user_name || streamer;
        const game = response.data.data[0]?.game_name || 'стрим оффлайн';
        const title = response.data.data[0]?.title || 'стрим оффлайн';
        const today = new Date(Date.now()).toISOString();
        const viewers = response.data.data[0]?.viewer_count || 0;
        return { bot, streamer, username, game, title, today, viewers };
    } catch (error) {
        console.error('[Stream Error]', error.response?.data || error.message);
        throw error;
    }
}

async function updateData(isLooped=true) {
    try {
        // refresh commands from backend (keep its own try/catch to avoid masking)
        try {
            const response = await $backend.get('/api/commands');
            if (Array.isArray(response.data)) {
                botCommands = response.data.map(cmd => ({
                    ...cmd,
                    regex: new RegExp(`^${cmd.regex}(.*)`, 'i'),
                }));
            }
        } catch (err) {
            if (err.response) console.error('[ApiError]', err.response?.status, err.response?.data);
            else console.error('[ApiError]', err.message || err);
        }

        // Twitch token (network can fail → catch!)
        let token;
        try {
            token = await getToken(config.TWITCH_CLIENT_ID, config.TWITCH_SECRET);
        } catch (e) {
            console.error('[Twitch OAuth]', 'Failed to get token:', e?.code || e?.message || e);
            token = null; // skip stream polling this round
        }

        const channels = config.TWITCH.channels.map(x => x.startsWith('#') ? x.slice(1) : x);

        if (token) {
            for (const channel of channels) {
                try {
                    const data = await getStreamData(config.TWITCH_CLIENT_ID, token, channel);
                    streamerData[channel] = {
                        ...data,
                        bio: config.TWITCH.bio[channel] || '',
                        clip: getLastSongText(null) || '-',
                        age: typeof config.TWITCH.ages[channel] === 'number'
                            ? ~~((Date.now() - config.TWITCH.ages[channel]) / 31557600000)
                            : (config.TWITCH.ages[channel] || '?'),
                    };
                } catch (error) {
                    console.error('[Stream Error]', channel, error?.code || error?.message || error);
                    // continue to next channel
                }
            }
        }
    } catch (fatal) {
        // Defensive catch for any unexpected path
        console.error('[updateData:FATAL]', fatal?.code || fatal?.message || fatal);
    } finally {
        if (isLooped) {
            setTimeout(updateData, config.DATA_POLLING_INTERVAL);
        }
    }
}

function template(source, tags) {
    if (tags === undefined) {
        return source;
    }
    let s = source;
    for(const prop in tags) {
        s = s.replace(new RegExp('{'+ prop +'}','g'), tags[prop]);
    }
    return s;
}

function aichatCreate(channel, summary) {
    const chat = { bump: 0, size: 0, channel: channel, data: [{ role: AI().system, content: template(config.BOT_CONTEXT, streamerData[channel]) }] };
    if (summary !== undefined) {
        chat.data.push({ role: 'assistant', content: `@InqSupportBot: ${summary}` });
    }
    return chat;
}

function aichatMessage(chat, username, message, count) {
    for (let i = 0; i < (count || 0); i++) {
        chat.data.pop();
    }
    if (chat.data.length > questionThrottle.memory / 2) {
        chat.data.splice(1, 2);
    }
    if (username == AI().system) {
        chat.data.push({ role: AI().system, content: message });
    } else {
        chat.data.push({ role: username == config.BOT_NAME ? 'assistant' : 'user', content: `@${username}: ${message}` });
    }
    chat.size += 1;
}

function aichatIsEmpty(chat) {
    return chat.bump >= chat.size;
}

function aichatBump(chat) {
    chat.data[0].content = template(config.BOT_CONTEXT, streamerData[chat.channel]);
    chat.bump = chat.size;
    // console.log(chat.data);
}

function aichatProcess(channel, uuid, callback, isDirectMessage) {
    if (aichatIsEmpty(questionThrottle.users[uuid].chat)) {
        return;
    }
    aichatBump(questionThrottle.users[uuid].chat);
    const messages = isDirectMessage
        ? questionThrottle.users[uuid].chat.data
        : [{ role: AI().system, content: config.BOT_PRIVATE }, ...questionThrottle.users[uuid].chat.data];
    brainClient.chat.completions.create({
        model: AI().model,
        // search_parameters: { mode: 'off' },
        messages: messages,
    }).then(response => {
        const output = choose(response.choices).message.content.replace(/\(\[.+\]\s*\(http.+\)\)/i, '').replace(/\[(.+)\]\s*\(http.+\)/i, '$1').trim();
        if (output.length == 0 || output.indexOf('[IDK]') !== -1) {
            const data = questionThrottle.users[uuid].chat.data;
            console.log(`[OpenAI][${channel}] ${output} | ${data[data.length - 1].content}`);
            return;
        }

        aichatMessage(questionThrottle.users[uuid].chat, config.BOT_NAME, output);

        // if (output.length > 400) {
        //     aichatMessage(questionThrottle.users[uuid].chat, AI().system, config.BOT_COMPRESS);
        //     aichatBump(questionThrottle.users[uuid].chat);
        //     console.log(`[OpenAI][${channel}] COMPRESS | ${output}`);
        //     brainClient.chat.completions.create({
        //         model: AI().model,
        //         // search_parameters: { mode: 'off' },
        //         messages: questionThrottle.users[uuid].chat.data,
        //     }).then(function(response) {
        //         const summary = response.choices[0].message.content;
        //         aichatMessage(questionThrottle.users[uuid].chat, config.BOT_NAME, summary, 2);
        //         aichatBump(questionThrottle.users[uuid].chat);
        //         callback({ text: summary, action: 'cmd', intent: 'cmd', command: true });
        //     }).catch(error => console.log('[ChatError]', error));
        //     return;
        // }

        if (questionThrottle.users[uuid].chat.size > questionThrottle.memory) {
            aichatMessage(questionThrottle.users[uuid].chat, AI().system, config.BOT_MEMORY);
            aichatBump(questionThrottle.users[uuid].chat);
            brainClient.chat.completions.create({
                model: AI().model,
                // search_parameters: { mode: 'off' },
                messages: questionThrottle.users[uuid].chat.data,
            }).then(function(response) {
                const summary = choose(response.choices).message.content;
                questionThrottle.users[uuid].chat = aichatCreate(channel, summary);
                console.log(`[OpenAI][${channel}] MEMOIZE | ${summary}`);
            }).catch(error => console.log('[ChatError]', error));
        }
        callback({
            text: output.replace(/\[LINK_TO_WARBORNE\]/i, 'https://r.qoolandgames.com/warborne/index?allianceId=494&invitationCode=7XZn39KO'),
            action: 'cmd',
            intent: 'cmd',
            command: true
        });
    }).catch(error => console.log('[ChatError]', error));
}

function aichatDialog(uuid, message, callback) {
    dialogClient.detectIntent({
        session: dialogClient.sessionPath(config.DIALOGFLOW_PROJECT, uuid),
        queryInput: {
            text: {
                text: message.substr(0, 255),
                languageCode: 'ru-RU',
            }
        }
    }).then(function (responses) {
        const result = responses[0].queryResult;
        let msg = {
                text: result.fulfillmentText,
                action: result.action,
                intent: result.intent.displayName,
                command: isCommand,
            };
        if (result.fulfillmentMessages && result.fulfillmentMessages.length > 0) {
            msg.text = result.fulfillmentMessages[result.fulfillmentMessages.length - 1].text.text[0];
        }

        if (msg.intent.search('clip') !== -1) {
            msg.text = getLastSongText(msg.text);
        }

        callback(msg);
    }).catch(function (err) {
        console.error('[DialogError]', err);
    });

}

/**
 * Handle message and get intent from dialogflow
 *
 * @param uuid     object   Unique id for this dialog
 * @param message  string   Message text
 * @param callback function Callback for sending response, function (msg) { ... }
 */
function questionHandler(channel, uuid, username, msg, callback) {
    let tokens = null;
    let isCommand = false;

    for (let cmd of botCommands) {
        if ((tokens = msg.match(cmd.regex)) !== null) {
            tokens[tokens.length - 1] = cmd.answer.replace(/{\s*query\s*}/i, tokens[tokens.length - 1].trim());
            if (!cmd.use_backend) {
                callback({
                        text: tokens[tokens.length - 1].trim(),
                        intent: 'cmd',
                        action: 'cmd',
                        command: true,
                    });
                return true;
            }
            isCommand = true;
            break;
        }
    }

    const timestamp = Date.now();
    if (questionThrottle.users[uuid] === undefined) {
        questionThrottle.users[uuid] = { throttle: timestamp - questionThrottle.limit * 2, chat: aichatCreate(channel) };
    }
    const userdata = questionThrottle.users[uuid];

    tokens = tokens || (msg.match(config.TWITCH.regex[channel]) ? [ msg ] : null);
    if (tokens == null) {
        aichatMessage(userdata.chat, username, msg);
        return false;
    }

    const message = tokens[tokens.length - 1].trim();

    if (message == config.BOT_SONG) {
        const song = getLastSongText(null);
        if (song != null) {
            callback({
                    text: song,
                    intent: 'cmd',
                    action: 'cmd',
                    command: true,
                });
            return true;
        }
    }

    if (timestamp - userdata.throttle < questionThrottle.limit) {
        setTimeout(() => aichatProcess(channel, uuid, callback, isCommand), timestamp - userdata.throttle + 500);
        aichatMessage(userdata.chat, username, message);
        return false;
    }

    if (msg.search(/^[!\/]/) !== -1 && message.length < 2) {
        updateData(false);
        callback({
                text: `Есть вопрос? Напиши в чате ${(msg.match(/^![^\s]+/i) || ['!bot'])[0]} ТВОЙ_ВОПРОС`,
                intent: 'cmd',
                action: 'cmd',
                command: isCommand,
            });
        return true;
    }

    if (message.length < 2) {
        return false;
    }

    questionThrottle.users[uuid].throttle = timestamp;
    aichatMessage(questionThrottle.users[uuid].chat, username, message);
    aichatProcess(channel, uuid, callback, isCommand);
    return true;
}

function broadcastMessage(message) {
    let msg = '';
    if (message.twitch) {
        msg = typeof message.twitch === 'function' ? message.twitch() : message.twitch;
        twitchClient.say(config.TWITCH.channels[0], msg);
    }
    if (message.youtube && youtubeClient.getStreamData().isOnline) {
        msg = typeof message.youtube === 'function' ? message.youtube() : message.youtube;
        youtubeClient.sendMessage(msg.substr(0, 199))
            .catch(function (err) {
                console.error(err.response.data);
            });
    }
}

function ignoreAnswer(answer) {
    return answer.action == 'input.unknown'
        || answer.intent.startsWith('smalltalk')
        || (!answer.command && answer.intent.startsWith('private'));
}

function choose(choices) {
    return choices[ Math.floor(Math.random() * choices.length) ];
}

function main() {
    updateData();
    redisClient.subscribe('control');
    youtubeClient.login();
    twitchClient.connect().catch(err => console.error('[TwitchConnectError]', err?.code || err?.message || err));
    discordLoginWithRetry(discordClient, config.DISCORD_TOKEN);
}

main();
