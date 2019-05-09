const config = require('./config');
const shortid = require('shortid');
const readline = require('readline');
const dialogflow = require('dialogflow');
const vkbot = require('./vkbot');
const youtube = require('./youtube');
const discord = require('discord.js');
const twitch = require('tmi.js');
const cookie = require('cookie');
const redis = require('redis');
const axios = require('axios');
const sio = require('socket.io').listen(9090);
const io = require('socket.io-client');
const fs = require('fs');

const $backend = axios.create(config.API_OPTIONS);

const alertsClient = io('wss://socket.donationalerts.ru:443', {
        reconnection: true,
        reconnectionDelayMax: 5000,
        reconnectionDelay: 1000,
    });

const redisClient = redis.createClient({ host: config.REDIS_HOST, port: config.REDIS_PORT });
const dialogClient = new dialogflow.SessionsClient();
const discordClient = new discord.Client();
const twitchClient = new twitch.client(config.TWITCH);
const vkontakteClient = new vkbot.client(config.VKBOT);
const youtubeClient = new Proxy(youtube, {
        clients: [],
        cursor: {
            index: 0
        },
        register(params) {
            this.clients.push( registerYoutube(new this.client(params)) );
        },
        next() {
            this.clients[this.cursor.index].stop();
            if (++this.cursor.index >= this.clients.length) {
                this.cursor.index = 0;
            }
            console.log(`[YouTube] Switch to ${this.clients[this.cursor.index].getStreamData().key}`);
            this.clients[this.cursor.index].login();
        },
        get(obj, key) {
            if (this[key] !== undefined) {
                return this[key];
            }
            if (this.clients.length > this.cursor.index && this.clients[this.cursor.index][key] !== undefined) {
                return this.clients[this.cursor.index][key];
            }
            if (obj[key] !== undefined) {
                return obj[key];
            }
            throw new Error(`[ProxyError] call to unknown method '${key}'`);
        }
    });
config.YOUTUBE.forEach(credential => youtubeClient.register(credential));

const questionThrottle = {
        users: {},
        limit: 5000
    };

const uuidToClient = {};
const shortidToUuid = {};
let botCommands = [];

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
            redis: redis.createClient({ host: config.REDIS_HOST, port: config.REDIS_PORT }),
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

                    const textChannel = await discordClient.channels.find(function (ch) {
                        return ch.id === config.CHANNEL;
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

            dialogClient
                .detectIntent({
                    session: client.session,
                    queryInput: {
                        text: {
                            text: tokens[2],
                            languageCode: 'ru-RU',
                        }
                    }
                })
                .then(function (responses) {
                    const result = responses[0].queryResult;
                    passToDiscord = (!result.intent || result.action == 'input.unknown');
                    if (!passToDiscord && result.fulfillmentMessages && result.fulfillmentMessages.length > 0) {
                        response.message.data.text = result.fulfillmentMessages[0].text.text[0];
                    } else {
                        response.message.data.text = result.fulfillmentText;
                    }
                })
                .catch(function (err) {
                    console.error('[DialogError]', err);
                    passToDiscord = true;
                })
                .finally(processDiscord);
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
    console.error('[RedisError] ', err);
});

/**
 * DISCORD
 */

discordClient.on('ready', function () {
    console.log('[Discord] Hi, %s!', discordClient.user.tag);
});

discordClient.on('message', function (message) {
    const msg = message.cleanContent.trim();
    if (message.member && message.member.hasPermission('ADMINISTRATOR') && msg.match(config.YOUTUBE_TRIGGER)) {
        setTimeout(function () {
            youtubeClient.runImmediate()
                .then(function () {
                    if (!youtubeClient.getStreamData().liveId) {
                        message.reply('YouTube-стрим не найден!');
                    }
                })
                .catch(function (err) {
                    if (err.response) {
                        if (err.response.data.error.code == 403) {
                            setTimeout(youtubeClient.next.bind(youtubeClient), 3000);
                            return;
                        } else {
                            console.error('[YouTubeError]', err.response.data.error);
                        }
                    } else {
                        console.error('[YouTubeError]', err);
                    }
                    message.reply('YouTube-API отклонило запрос!');
                });
            }, 15000);
        return;
    }

    if (message.channel.id !== config.CHANNEL || message.author.tag == discordClient.user.tag) {
        return;
    }

    if (msg.search(/^[@!\/]/) !== -1) {
        questionHandler('d' + message.author.id, msg, function (answer) {
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
                imageUrl: message.author.avatarURL,
            };
        }

        Object.values(client.socks).forEach(function(sock) {
            sock.emit('message', response);
        });
    }

    switch (command) {
        case 'ban':
            if (!message.member.hasPermission('BAN_MEMBERS')) {
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
            if (!message.member.hasPermission('BAN_MEMBERS')) {
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

discordClient.on('error', function (err) {
    console.error('[DiscordError]', err);
});

/**
 * TWITCH
 */

twitchClient.on('connected', function (address, port) {
    console.log('[Twitch] Hi, %s!', twitchClient.getUsername());
});

twitchClient.on('chat', function (channel, user, message, self) {
    const msg = message.trim();
    if (self || user['username'].match(config.IGNORE)) {
        return;
    }

    questionHandler('t' + user['user-id'], msg, function (answer) {
            if (ignoreAnswer(answer)) {
                return;
            }
            twitchClient.say(channel, '@' + user['username'] + ' ' + answer.text);
        });
});

twitchClient.on('error', function (err) {
    console.error('[TwitchError]', err);
});

/**
 * VKONTAKTE
 */

vkontakteClient.on('ready', function () {
    console.log('[VK] Hi!');
});

vkontakteClient.on('error', function (err) {
    console.error('[VKError]', err);
});

vkontakteClient.on('message_new', function (message) {
    const msg = message.text.trim();
    if (!msg) {
        return;
    }

    questionHandler('v' + message.from_id, msg.trim(), function (answer) {
            vkontakteClient.call(
                'messages.send',
                Object.assign(
                    message.from_id < 2000000000
                    ? { user_ids: (Array.isArray(message.from_id) ? message.from_id : [message.from_id]).join(',') }
                    : { peer_id: message.from_id },
                    { message: answer.text }
                ),
                vkontakteClient.getSettings().groupToken
            );
        });
});

vkontakteClient.on('video_comment_new', function (comment) {
    const msg = comment.text.trim();
    const groupId = -vkontakteClient.getSettings().groupId;
    if (comment.from_id == groupId) {
        return;
    }

    questionHandler('v' + comment.from_id, msg, function (answer) {
            if (ignoreAnswer(answer)) {
                return;
            }

            vkontakteClient.call(
                'video.createComment',
                {
                    from_group: 1,
                    owner_id: comment.video_owner_id,
                    video_id: comment.video_id,
                    message: answer.text,
                    reply_to_comment: comment.id
                }
            );
        });
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
        return `${config.DALERTS.songTitle} ${config.DALERTS.songUrl ? ' ' + config.DALERTS.songUrl : ''}\n5 последних заказов: https://inq.page.link/clip`;
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

function registerYoutube(client) {
    client.on('login', function () {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        rl.question(
            '[Youtube] OAuth url: ' + this.authorizationUrl() + '\n',
            function (code) {
                client.login(code);
                rl.close();
            });
        console.log('[Youtube] Enter your code: ');
    });

    client.on('ready', function () {
        console.log('[Youtube] Hi!');
    });

    client.on('credentials', function (credentials) {
        let name = credentials.name || client.getStreamData().key;
        fs.writeFile(`config/${name}.json`, JSON.stringify(credentials), function () {});
        console.log(`[YouTube] Token updated for ${name}`);
    });

    client.on('online', function (key) {
        console.log(`[YouTube] Stream connected, ${key}`);
    });

    client.on('offline', function (key) {
        console.log(`[YouTube] Stream disconnected, ${key}`);
    });

    client.on('stopped', function (key) {
        console.log(`[YouTube] Client stopped, ${key}`);
    });

    client.on('message', function (message, user) {
        const msg = message.displayMessage.trim();

        if (user.displayName.match(config.IGNORE)) {
            // console.log('ignored', msg);
            return;
        }
        // console.log('[YouTube]', msg);

        questionHandler('y' + user.channelId, msg, function (answer) {
                if (ignoreAnswer(answer)) {
                    return;
                }
                client.sendMessage(('@' + user.displayName + ' ' + answer.text).substr(0, 199))
                    .catch(function (err) {
                        console.error(err.response.data);
                    });
            });
    });

    client.on('error', function (err) {
        if (err.response && err.response.data) {
            if (!err.response.data.error) {
                console.error('[YouTubeError]', err.response.data);
                return;
            }
            if (err.response.data.error.code == 403) {
                setTimeout(youtubeClient.next.bind(youtubeClient), 2000);
            }
            if (err.response.data.error.message) {
                console.error('[YouTubeError]', err.response.data.error.message);
                return;
            }
        }
        console.error('[YouTubeError]', err);
    });

    return client;
}

function updateCommands(isLooped=true) {
    $backend.get('/api/commands')
        .then(function (response) {
            if (Array.isArray(response.data)) {
                botCommands = [];
                for (let cmd of response.data) {
                    cmd.regex = new RegExp(`^${cmd.regex}(.*)`, 'i');
                    botCommands.push(cmd);
                }
            }
        })
        .catch(function (err) {
            if (err.response) {
                console.error('[ApiError]', err.response);
            } else if (err.message) {
                console.error('[ApiError]', err.message);
            } else if (err.errno) {
                console.error('[ApiError]', err.errno);
            } else {
                console.error('[ApiError]', err);
            }
        });
    if (isLooped) {
        setTimeout(updateCommands, config.COMMAND_INTERVAL);
    }
}

/**
 * Handle message and get intent from dialogflow
 *
 * @param uuid     object   Unique id for this dialog
 * @param message  string   Message text
 * @param callback function Callback for sending response, function (msg) { ... }
 */
function questionHandler(uuid, msg, callback) {
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

    tokens = tokens || msg.match(config.REGEX);
    if (tokens == null) {
        return false;
    }

    const message = tokens[tokens.length - 1].trim();
    const timestamp = Date.now();
    const throttle = questionThrottle.users[uuid];
    if (throttle && timestamp - throttle < questionThrottle.limit) {
        return false;
    }

    if (msg.search(/^[!\/]/) !== -1 && message.length < 2) {
        updateCommands(false);
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

    questionThrottle.users[uuid] = timestamp;

    dialogClient
        .detectIntent({
            session: dialogClient.sessionPath(config.DIALOGFLOW_PROJECT, uuid),
            queryInput: {
                text: {
                    text: message.substr(0, 255),
                    languageCode: 'ru-RU',
                }
            }
        })
        .then(function (responses) {
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
        })
        .catch(function (err) {
            console.error('[DialogError]', err);
        });
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

updateCommands();
redisClient.subscribe('control');
twitchClient.connect();
discordClient.login(config.DISCORD_TOKEN);
youtubeClient.login();
vkontakteClient.login();