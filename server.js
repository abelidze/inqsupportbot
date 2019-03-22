const config = require('./config');
const shortid = require('shortid');
const dialogflow = require('dialogflow');
const discord = require('discord.js');
const twitch = require('tmi.js');
const cookie = require('cookie');
const redis = require('redis');
const io = require('socket.io').listen(9090);
const rp = require('request-promise');

const $backend = rp.defaults(config.API_OPTIONS);

const dialogClient = new dialogflow.SessionsClient();
const discordClient = new discord.Client();
const twitchClient = new twitch.client(config.TWITCH_OPTIONS);

let requestThrottle = {
        users: {},
        limit: 5000
    };

let uuidToClient = {};
let shortidToUuid = {};

console.log('ChatServer is starting...');

// TODO: OOP is really needed
// TODO: improve expired sockets
// TODO: improve auth security (it's very nasty and bad at the moment)
// TODO: move regex-command for questionHandler to config

io.on('connection', function (socket) {
    const uuid = cookie.parse(socket.handshake.headers.cookie).uuid;
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
            session: dialogClient.sessionPath(config.PROJECT_ID, uuid),
            socks: {},
            redis: redis.createClient({ host:'redis', port: 8060 }),
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
        console.log('Dialog: %s connected', uuid);

        /// INIT REDIS
        client.redis.subscribe('ban.' + uuid);
        client.redis.subscribe('auth.' + uuid);
        client.redis.subscribe('message.' + uuid);

        client.redis.on('error', function (err) {
            console.error('RedisError: ', err);
        });

        client.redis.on('message', function (channel, message) {
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
                                (private ? '' : '@everyone\n') + `#${client.id}\n${message}`
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
                            text: message,
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
                    console.error('DialogError:', err);
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
                console.log('Dialog: %s destroyed', uuid);
            }, 120000);
        }
    });

    uuidToClient[uuid] = client;
});

discordClient.on('ready', function () {
    console.log('Discord connected. Hi, %s!', discordClient.user.tag);
});

discordClient.on('message', function (message) {
    if (message.channel.id !== config.CHANNEL || message.author.tag == discordClient.user.tag) {
        return;
    }

    const msg = message.cleanContent.trim();

    if (msg.startsWith('!')) {
        questionHandler('d' + message.author.id, msg, function (answer) {
                message.reply(answer.text);
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
    console.error('DiscordError:', err);
});

twitchClient.on("connected", function (address, port) {
    console.log('Twitch connected. Hi, %s!', twitchClient.getUsername());
});

twitchClient.on("chat", function (channel, user, message, self) {
    if (self && !message.startsWith('!')) {
        return;
    }

    questionHandler('t' + user['user-id'], message.trim(), function (answer) {
            if (answer.action == 'input.unknown') {
                return;
            }
            twitchClient.say(channel, '@' + user['username'] + ' ' + answer.text);
        });
});

twitchClient.on("error", function (err) {
    console.error('TwitchError:', err);
});

/**
 * Handle message and get intent from dialogflow
 *
 * @param uuid     object   Unique id for this dialog
 * @param message  string   Message text
 * @param callback function Callback for sending response, function (msg) { ... }
 */
function questionHandler(uuid, message, callback) {
    const tokens = message.match(/^\!(инк|inq|инкусик|бот|bot)\s*(.*)/i);
    if (tokens == null) {
        return;
    }

    const timestamp = Date.now();
    const throttle = requestThrottle.users[uuid];
    if (throttle && timestamp - throttle < requestThrottle.limit) {
        return;
    }

    if (tokens[2].length == 0) {
        callback('Есть вопрос? Напиши в чате !' + tokens[1] + ' ТВОЙ_ВОПРОС');
        return;
    }

    requestThrottle.users[uuid] = timestamp;

    dialogClient
        .detectIntent({
            session: dialogClient.sessionPath(config.PROJECT_ID, uuid),
            queryInput: {
                text: {
                    text: tokens[2],
                    languageCode: 'ru-RU',
                }
            }
        })
        .then(function (responses) {
            const result = responses[0].queryResult;
            let msg = {
                    text: result.fulfillmentText,
                    action: result.action
                };

            if (!result.fulfillmentMessages || result.fulfillmentMessages.length == 0) {
                callback(msg);
                return;
            }
            msg.text = result.fulfillmentMessages[result.fulfillmentMessages.length - 1].text.text[0];
            callback(msg);
        })
        .catch(function (err) {
            console.error('DialogError:', err);
        });
}

discordClient.login(config.DISCORD_TOKEN);
twitchClient.connect();
