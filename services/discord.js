import discord from 'discord.js';
import shortid from 'shortid';
import storage from '../storage.js'
import { sleep } from '../utils.js';

const MAX_DELAY_MS = 60_000;
const BASE_DELAY_MS = 2_000;

export class DiscordService {
    constructor({ config, backendClient, chatService, webSocketService, discordClient }) {
        this.config = config;
        this.api = backendClient;
        this.chat = chatService;
        this.ws = webSocketService;
        this.client = discordClient || new discord.Client({
            intents: [
                discord.GatewayIntentBits.Guilds,
                discord.GatewayIntentBits.GuildMembers,
                discord.GatewayIntentBits.GuildMessages,
                discord.GatewayIntentBits.GuildMessageReactions,
                discord.GatewayIntentBits.GuildVoiceStates,
                discord.GatewayIntentBits.MessageContent,
                discord.GatewayIntentBits.DirectMessages,
                discord.GatewayIntentBits.DirectMessageTyping,
            ],
            partials: [
                discord.Partials.GuildMember,
                discord.Partials.Message,
                discord.Partials.Channel,
                discord.Partials.Reaction,
                discord.Partials.User,
            ],
        });
        this.attempts = 0;
    }

    start() {
        this.client.once(discord.Events.ClientReady, (client) => {
            console.log('[Discord] Hi, %s!', client.user.tag);
            for (const id of storage.rooms.keys()) {
                client.channels.fetch(id).then((channel) => {
                    if (channel.members.size < 1) {
                        this.#removeRoom(channel);
                    }
                }).catch(e => storage.rooms.delete(id));
            }
        });

        this.client.on(discord.Events.Error, (err) => {
            console.error('[Discord]', err);
        });

        this.client.on(discord.Events.MessageCreate, (message) => this.#handleMessage(message));

        this.client.on(discord.Events.VoiceStateUpdate, (before, after) => this.#handleVoiceUpdates(before, after));

        this.client.on(discord.Events.UserUpdate, async (before, after) => this.#onUsernameUpdate(before, after));

        this.client.on(discord.Events.GuildMemberUpdate, (before, after) => this.#onNicknameUpdate(before, after));

        this.client.on(discord.Events.GuildMemberAdd, (member) => this.#onMemberJoined(member));

        this.client.on(discord.Events.GuildMemberRemove, (member) => this.#onMemberLeft(member));

        this.#loginWithRetry(this.config.DISCORD.TOKEN);
    }

    #isFatalLoginError(err) {
        const msg = String(err?.message || '');
        return (
            msg.includes('TOKEN_INVALID')
            || msg.includes('An invalid token was provided')
            || err?.code === 50035
        );
    }

    #backoffDelay(attempt) {
        const expo = BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
        const jitter = Math.floor(Math.random() * 1000);
        return Math.min(MAX_DELAY_MS, expo + jitter);
    }

    async #loginWithRetry(token) {
        for (;;) {
            try {
                this.attempts += 1;
                await this.client.login(token);
                console.log('[Discord] Logged in after', this.attempts, 'attempt(s).');
                this.attempts = 0;
                return;
            } catch (err) {
                if (this.#isFatalLoginError(err)) {
                    console.error('[DiscordLogin:FATAL]', err?.message || err);
                    return;
                }
                const delay = this.#backoffDelay(this.attempts);
                console.error(
                    `[DiscordLogin:RETRY] attempt=${this.attempts} in ${delay}ms →`,
                    err?.code || err?.message || err,
                );
                await sleep(delay);
            }
        }
    }

    async #createRoom(state) {
        const room = storage.rooms.findIndex('user', state.id);
        if (room !== null) {
            try {
                this.#saveRoom(await state.guild.channels.fetch(room));
            } catch (err) {
                storage.rooms.delete(room);
            }
        }
        const channelData = storage.channels.get(state.channelId).ensure(state.id, { name: "{user}'s Room" });
        channelData.name = channelData.name.replace('{user}', state.member.user.globalName.substr(0, 32));
        channelData.type = discord.ChannelType.GuildVoice;
        channelData.parent = state.channel.parent;
        state.guild.channels.create(channelData).then((voice) => {
            voice.permissionOverwrites.edit(state.id, {
                Connect: true,
                ViewChannel: true,
                ManageChannels: true,
                ManageRoles: true,
            });
            state.setChannel(voice);
            storage.rooms.set(voice.id, {
                user: state.id,
                master: state.channelId,
            });
        }).catch(e => console.log("Couldn't create room", e));
    }

    #saveRoom(channel) {
        const { user, master } = storage.rooms.get(channel.id);
        storage.channels.get(master).set(user, {
            name: channel.name,
            bitrate: channel.bitrate,
            userLimit: channel.userLimit,
            nsfw: channel.nsfw,
            rtcRegion: channel.rtcRegion,
            videoQualityMode: channel.videoQualityMode,
            permissionOverwrites: channel.permissionOverwrites.cache.toJSON().map((entry) => {
                const permission = entry.toJSON();
                permission.allow = permission.allow.bitfield;
                permission.deny = permission.deny.bitfield;
                return permission;
            }),
        });
    }

    #removeRoom(channel) {
        channel.delete().then((voice) => {
            this.#saveRoom(voice);
            storage.rooms.delete(voice.id);
        }).catch(e => console.log("Couldn't delete room", e));
    }

    #handleVoiceUpdates(before, after) {
        if (before.channelId != null) {
            if (!this.config.DISCORD.MASTER_CHANNELS.includes(before.channelId)) {
                for (const id of this.config.DISCORD.LOGGING) {
                    before.guild.channels.fetch(id).then((channel) => {
                        channel.send({
                            content: `<@${before.id}> (${before.member.user.tag}) left voice channel ${before.channel.name}.`,
                            allowedMentions: {},
                        });
                    }).catch(_ => { });
                }
            }
            if (storage.rooms.has(before.channelId) && before.channel.members.size < 1) {
                this.#removeRoom(before.channel);
            }
        }
        if (after.channelId != null) {
            if (this.config.DISCORD.MASTER_CHANNELS.includes(after.channelId)) {
                this.#createRoom(after);
            } else {
                for (const id of this.config.DISCORD.LOGGING) {
                    after.guild.channels.fetch(id).then((channel) => {
                        channel.send({
                            content: `<@${after.id}> (${after.member.user.tag}) joined voice channel ${after.channel.name}.`,
                            allowedMentions: {},
                        });
                    }).catch(_ => { });
                }
            }
        }
    }

    async #onUsernameUpdate(before, after) {
        if (before.displayName == after.displayName) {
            return;
        }
        for (const id of this.config.DISCORD.LOGGING) {
            after.client.channels.fetch(id).then(async (channel) => {
                const member = await channel.guild.members.fetch(after.id);
                if (member) {
                    channel.send({
                        content: `<@${member.id}> (${member.user.tag}) renamed from ${before.displayName} to ${after.displayName}`,
                        allowedMentions: {},
                    });
                }
            }).catch(_ => { });
        }
    }

    #onNicknameUpdate(before, after) {
        if (before.displayName == after.displayName) {
            return;
        }
        for (const id of this.config.DISCORD.LOGGING) {
            after.guild.channels.fetch(id).then((channel) => {
                const log = `||${after.user.displayName}||`;
                if (before.nickname == null) {
                    channel.send({
                        content: `<@${after.id}> (${after.user.tag}) set a nickname ${after.nickname} ${log}`,
                        allowedMentions: {},
                    });
                } else if (after.nickname == null) {
                    channel.send({
                        content: `<@${after.id}> (${after.user.tag}) removed nickname ${before.nickname} ${log}`,
                        allowedMentions: {},
                    });
                } else {
                    channel.send({
                        content: `<@${after.id}> (${after.user.tag}) changed nickname from ${before.nickname} to ${after.nickname} ${log}`,
                        allowedMentions: {},
                    });
                }
            }).catch(_ => { });
        }
    }

    #onMemberJoined(member) {
        for (const id of this.config.DISCORD.LOGGING) {
            member.guild.channels.fetch(id).then((channel) => {
                channel.send({
                    content: `<@${member.id}> (${member.user.tag}) joined. ||${member.user.displayName}||`,
                    allowedMentions: {},
                });
            }).catch(_ => { });
        }
    }

    #onMemberLeft(member) {
        for (const id of this.config.DISCORD.LOGGING) {
            member.guild.channels.fetch(id).then((channel) => {
                channel.send({
                    content: `<@${member.id}> (${member.user.tag}) left. ||${member.user.displayName}||`,
                    allowedMentions: {},
                });
            }).catch(_ => { });
        }
    }

    async #handleMessage(message) {
        const msg = message.cleanContent.trim();
        if (
            !this.config.DISCORD.CHAT_CHANNELS.includes(message.channel.id)
            || message.author.tag === this.client.user.tag
        ) {
            return;
        }

        if (msg.search(/^[@!\/]/) !== -1) {
            await this.chat.questionHandler(
                'cepreu_inq',
                `d${message.author.id}`,
                message.author.username,
                msg,
                (answer) => {
                    if (answer.command) {
                        message.reply(answer.text);
                    }
                },
            );
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

        if (!shortid.isValid(id)) {
            message.reply('Собеседник не найден!');
            return;
        }

        const clientData = this.ws.getClientByShortId(id);
        if (!clientData) {
            message.reply('Собеседник не найден!');
            return;
        }

        const { uuid, client } = clientData;
        client.private.time = Date.now();

        if (intent) {
            // create / update intent...
        }

        if (answer.trim().length > 0) {
            const response = {
                message: {
                    type: 'text',
                    author: 'bot',
                    data: {
                        text: answer,
                    },
                },
            };

            if (!message.author.bot) {
                response.message.author = message.author.tag;
                response.author = {
                    id: message.author.tag,
                    name: message.author.username,
                    imageUrl: message.author.avatarURL(),
                };
            }

            Object.values(client.socks).forEach((sock) => {
                sock.emit('message', response);
            });
        }

        switch (command) {
            case 'ban':
                if (!message.member?.permissions?.has(discord.PermissionFlagsBits.BanMembers)) {
                    break;
                }
                this.api.get(`/api/ban/${uuid}`).then(() => {
                    console.log('User %s banned', uuid);
                    Object.values(client.socks).forEach((sock) => {
                        sock.emit('ban', {});
                    });
                    message.reply('Пользователь заблокирован!');
                }).catch(() => {
                    console.log('Can`t ban user %s', uuid);
                });
                break;

            case 'unban':
                if (!message.member?.permissions?.has(discord.PermissionFlagsBits.BanMembers)) {
                    break;
                }
                this.api.get(`/api/unban/${uuid}`).then(() => {
                    console.log('User %s unbanned', uuid);
                    Object.values(client.socks).forEach((sock) => {
                        sock.emit('unban', {});
                    });
                    message.reply('Пользователь разблокирован!');
                }).catch(() => {
                    console.log('Can`t unban user %s', uuid);
                });
                break;

            case 'close':
                client.private.time = 0;
                Object.values(client.socks).forEach((sock) => {
                    sock.emit('message', {
                        message: {
                            type: 'system',
                            data: {
                                text: 'Собеседник завершил беседу',
                            },
                        },
                    });
                });
                break;

            default:
                break;
        }
    }
}
