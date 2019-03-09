const config = require('./config');
const shortid = require('shortid');
const dialogflow = require('dialogflow');
const discord = require('discord.js');
const cookie = require('cookie');
const redis = require('redis');
const io = require('socket.io').listen(9090);
const rp = require('request-promise');

const $backend = rp.defaults(config.API_OPTIONS);

const dialogClient = new dialogflow.SessionsClient();
const discordClient = new discord.Client();

let uuidToClient = {};
let shortidToUuid = {};

console.log('ChatServer is starting...');

// TODO: OOP is really needed
// TODO: expired sockets

io.on('connection', function (socket) {
    const uuid = cookie.parse(socket.handshake.headers.cookie).uuid;
    const sessionPath = dialogClient.sessionPath(config.PROJECT_ID, uuid);
    console.log('Dialog: %s connected', uuid);

    if (uuidToClient[uuid] !== undefined && Object.keys(uuidToClient[uuid].socks).length > 0) {
        uuidToClient[uuid].socks[socket.id] = socket;
        return;
    }

    let client = {
        id: shortid.generate(),
        socks: {},
        redis: redis.createClient({ port: 8060 }),
        private: {
            time: 0,
            delay: 60000,
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
    client.socks[socket.id] = socket;
    shortidToUuid[client.id] = uuid;

    client.redis.subscribe('ban.' + uuid);
    client.redis.subscribe('auth.' + uuid);
    client.redis.subscribe('message.' + uuid);

    client.redis.on('error', function (err) {
        console.error('RedisError: ', err);
    });

    client.redis.on('message', function (channel, message) {
        if (!channel.startsWith('message.')) {
            if (channel.startsWith('auth.')) {
                socket.emit('auth', {});
            } else if (channel.startsWith('ban.')) {
                socket.emit('ban', {});
            }
            return;
        }

        let timestamp = Date.now();
        if (timestamp - client.throttle.time > client.throttle.limit.time) {
            client.throttle.count = 0;
            client.throttle.time = timestamp;
        } else if (client.throttle.count >= client.throttle.limit.count) {
            socket.emit(channel.split('.')[0], {
                type: 'system',
                data: {
                    text: 'Превышен лимит сообщений. Подождите '
                        + Math.trunc(client.throttle.limit.time / 1000)
                        + ' секунд и повторите попытку.',
                }
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
                    socket.emit(channel.split('.')[0], response);
                }

                if (!passToDiscord) {
                    return;
                }

                if (timestamp - client.private.time > client.private.delay) {
                    client.private.time = timestamp;
                }

                const textChannel = await discordClient.channels.find(function (ch) {
                    return ch.name === config.CHANNEL;
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
                session: sessionPath,
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
                response.message.data.text = result.fulfillmentText;
            })
            .catch(function (err) {
                console.error('DialogError:', err);
                passToDiscord = true;
            })
            .finally(processDiscord);
    });

    socket.on('disconnect', function () {
        delete client.socks[socket.id];
        if (Object.keys(client.socks).length == 0) {
            client.redis.quit();
        }
    });

    uuidToClient[uuid] = client;
});

discordClient.on('ready', function () {
    console.log('Discord connected. Hi, %s!', discordClient.user.tag);
});

discordClient.on('message', function (message) {
    if (message.channel.name !== config.CHANNEL
        || message.author.tag == discordClient.user.tag
        || !message.cleanContent.startsWith('#'))
    {
        return;
    }

    const tokens = message.cleanContent.match(/^\#([0-9a-zA-z\-_]+)\s*(\/([^\s]+))?\s*(\@([^\s]+))?\s*(.*)/);
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

    switch (command) {
        case 'ban':
            $backend.get('/api/ban/' + uuid)
                .then(function () {
                    console.log('User %s banned', uuid);
                    Object.values(client.socks).forEach(function(sock) {
                       sock.emit('ban', {});
                    });
                })
                .catch(function () {
                    console.log('Can`t ban user %s', uuid);
                });
            break;

        case 'unban':
            $backend.get('/api/unban/' + shortidToUuid[id])
                .then(function () {
                    console.log('User %s unbanned', uuid);
                    Object.values(client.socks).forEach(function(sock) {
                       sock.emit('unban', {});
                    });
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

    if (answer.trim().length == 0) {
        return;
    }

    if (intent) {
        // create / update intent...
    }

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
});

discordClient.login(config.DISCORD_TOKEN);