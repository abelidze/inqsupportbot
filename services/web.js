import cookie from 'cookie';
import dialogflow from 'dialogflow';
import redis from 'redis';
import shortid from 'shortid';
import socketIo from 'socket.io';

export class WebSocketService {
    constructor({ config, discordClient }) {
        this.config = config;
        this.discordClient = discordClient;
        this.uuidToClient = {};
        this.shortidToUuid = {};
        this.dialogClient = new dialogflow.SessionsClient();
        this.server = socketIo(9090, { serveClient: false });
    }

    start() {
        this.server.use((socket, next) => {
            if (socket.handshake.headers.cookie || socket.request.headers.cookie) {
                return next();
            }
            return next(new Error('Authentication error'));
        });

        this.server.on('error', (err) => {
            console.error('[SocketError]', err);
        });

        this.server.on('connection', (socket) => {
            this.#handleConnection(socket);
        });
    }

    getClientByShortId(id) {
        if (!shortid.isValid(id)) {
            return null;
        }
        const uuid = this.shortidToUuid[id];
        if (!uuid || !this.uuidToClient[uuid]) {
            return null;
        }
        return { uuid, client: this.uuidToClient[uuid] };
    }

    #createRedisClient() {
        return redis.createClient({
            host: this.config.REDIS_HOST,
            port: this.config.REDIS_PORT,
            password: this.config.REDIS_PASS,
            retry_strategy: this.config.REDIS_POLICY,
        });
    }

    #handleConnection(socket) {
        socket.cookie = socket.handshake.headers.cookie || socket.request.headers.cookie;
        const uuid = cookie.parse(socket.cookie).uuid;
        if (uuid == undefined) {
            return;
        }

        let client = undefined;
        if (this.uuidToClient[uuid] !== undefined) {
            client = this.uuidToClient[uuid];
            if (client.destroy !== undefined) {
                clearTimeout(client.destroy);
                client.destroy = undefined;
            }
        } else {
            client = this.#createNewClient(uuid);
        }

        client.socks[socket.id] = socket;

        socket.on('disconnect', () => {
            delete client.socks[socket.id];
            if (Object.keys(client.socks).length === 0) {
                client.destroy = setTimeout(() => {
                    client.redis.quit();
                    delete this.uuidToClient[uuid];
                }, 120000);
            }
        });

        this.uuidToClient[uuid] = client;
    }

    #createNewClient(uuid) {
        const client = {
            id: shortid.generate(),
            session: this.dialogClient.sessionPath(this.config.DIALOGFLOW_PROJECT, uuid),
            socks: {},
            redis: this.#createRedisClient(),
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

        this.shortidToUuid[client.id] = uuid;

        client.redis.subscribe(`ban.${uuid}`);
        client.redis.subscribe(`auth.${uuid}`);
        client.redis.subscribe(`message.${uuid}`);

        client.redis.on('error', (err) => {
            console.error('[RedisError] ', err);
        });

        client.redis.on('message', (channel, payload) => {
            this.#handleRedisMessage(client, channel, payload);
        });

        return client;
    }

    #handleRedisMessage(client, channel, payload) {
        if (!channel.startsWith('message.')) {
            if (channel.startsWith('auth.')) {
                Object.values(client.socks).forEach((sock) => {
                    sock.emit('auth', {});
                });
            } else if (channel.startsWith('ban.')) {
                Object.values(client.socks).forEach((sock) => {
                    sock.emit('ban', {});
                });
            }
            return;
        }

        const timestamp = Date.now();
        if (timestamp - client.throttle.time > client.throttle.limit.time) {
            client.throttle.count = 0;
            client.throttle.time = timestamp;
        } else if (client.throttle.count >= client.throttle.limit.count) {
            const msg = {
                message: {
                    type: 'system',
                    data: {
                        text: `Превышен лимит сообщений. Подождите ${Math.trunc(
                            client.throttle.limit.time / 1000,
                        )} секунд и повторите попытку.`,
                    },
                },
            };
            Object.values(client.socks).forEach((sock) => {
                sock.emit('message', msg);
            });
            return;
        }
        client.throttle.count += 1;

        const tokens = payload.match(/(\[.*?\])?\s*(.+)/);

        if (tokens == null) {
            return;
        }

        let passToDiscord = false;
        const response = {
            message: {
                type: 'text',
                author: 'bot',
                data: {
                    text: 'Сегодня я не доступен, передаю твой вопрос выше.',
                },
            },
        };

        const processDiscord = async (isPrivate = false) => {
            if (!isPrivate) {
                Object.values(client.socks).forEach((sock) => {
                    sock.emit('message', response);
                });
            }

            if (!passToDiscord) {
                return;
            }

            if (timestamp - client.private.time > client.private.delay) {
                client.private.time = timestamp;
            }

            const textChannel = await this.discordClient.channels.cache.find((ch) =>
                this.config.DISCORD.CHAT_CHANNELS.includes(ch.id),
            );

            if (textChannel) {
                await textChannel.send(
                    `${isPrivate ? '' : '@everyone\n'}#${client.id}\n${payload}`,
                );
            }
        };

        if (timestamp - client.private.time < client.private.delay) {
            passToDiscord = true;
            processDiscord(true);
            return;
        }

        this.dialogClient
            .detectIntent({
                session: client.session,
                queryInput: {
                    text: {
                        text: tokens[2],
                        languageCode: 'ru-RU',
                    },
                },
            })
            .then((responses) => {
                const result = responses[0].queryResult;
                passToDiscord = !result.intent || result.action === 'input.unknown';
                if (
                    !passToDiscord
                    && result.fulfillmentMessages
                    && result.fulfillmentMessages.length > 0
                ) {
                    response.message.data.text = result.fulfillmentMessages[0].text.text[0];
                } else {
                    response.message.data.text = result.fulfillmentText;
                }
            })
            .catch((err) => {
                console.error('[DialogError]', err);
                passToDiscord = true;
            })
            .finally(() => {
                processDiscord();
            });
    }
}
