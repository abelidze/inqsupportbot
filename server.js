const config = require('./config');
const shortid = require('shortid');
const dialogflow = require('dialogflow');
const discord = require('discord.js');
const cookie = require('cookie');
const redis = require('redis');
const io = require('socket.io').listen(9090);

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
    uuidToClient[uuid] = socket;

    const redisClient = redis.createClient({ port: 8060 });
    redisClient.subscribe('message.' + uuid);

    redisClient.on("error", function (err) {
        console.error("RedisError: ", err);
    });

    redisClient.on('message', function (channel, message) {
        if (!channel.startsWith('message.')) {
            return null;
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
            .finally(async function () {
                socket.emit(channel.split('.')[0], response);
                if (!passToDiscord) return;

                const textChannel = await discordClient.channels.find(function (ch) {
                    return ch.name === config.CHANNEL;
                });

                if (textChannel) {
                    const id = shortid.generate();
                    shortidToUuid[id] = uuid;
                    await textChannel.send(`#${id}\n${message}`);
                }
            });
    });

    socket.on('disconnect', function () {
        redisClient.quit();
    });
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

    const tokens = message.cleanContent.match(/^\#([0-9a-zA-z-_]+)\s*(\@([^\s]+))?\s+([^]*)/);
    if (tokens == null) {
        return;
    }

    const id = tokens[1];
    const intent = tokens[3];
    const answer = tokens[4];

    if (answer.trim().length == 0) {
        return;
    }

    if (!shortid.isValid(id)
        || shortidToUuid[id] === undefined
        || uuidToClient[shortidToUuid[id]] === undefined)
    {
        message.reply('Собеседник не найден!');
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

    uuidToClient[shortidToUuid[id]].emit('message', response);
});

discordClient.login(config.DISCORD_TOKEN);