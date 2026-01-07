import config from './config/index.cjs';
import storage from './storage.js'
import discord from 'discord.js';
import { AppTokenAuthProvider, StaticAuthProvider, RefreshingAuthProvider, exchangeCode } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import { EventSubHttpListener } from '@twurple/eventsub-http';
import { NgrokAdapter } from '@twurple/eventsub-ngrok';

console.log('ChatServer is starting...');

const discordClient = new discord.Client({
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

async function createRoom(state) {
    const room = storage.rooms.findIndex('user', state.id);
    if (room !== null) {
        try {
            saveRoom(await state.guild.channels.fetch(room));
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

function saveRoom(channel) {
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

function removeRoom(channel) {
    channel.delete().then((voice) => {
        saveRoom(voice);
        storage.rooms.delete(voice.id);
    }).catch(e => console.log("Couldn't delete room", e));
}

discordClient.once(discord.Events.ClientReady, (client) => {
    console.log('[Discord] Hi, %s!', discordClient.user.tag);

    for (const id of storage.rooms.keys()) {
        client.channels.fetch(id).then((channel) => {
            if (channel.members.size < 1) {
                removeRoom(channel);
            }
        }).catch(e => storage.rooms.delete(id));
    }
});

discordClient.on(discord.Events.UserUpdate, async (before, after) => {
    if (before.displayName == after.displayName) {
        return;
    }
    for (const id of config.DISCORD.LOGGING) {
        after.client.channels.fetch(id).then(async (channel) => {
            const member = await channel.guild.members.fetch(after.id);
            if (member) {
                channel.send({
                    content: `<@${member.id}> (${member.user.tag}) renamed from ${before.displayName} to ${after.displayName}`,
                    allowedMentions: {},
                });
            }
        }).catch(console.log);
    }
});

discordClient.on(discord.Events.GuildMemberUpdate, async (before, after) => {
    if (before.displayName == after.displayName) {
        return;
    }
    for (const id of config.DISCORD.LOGGING) {
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
        }).catch(console.log);
    }
});

discordClient.on(discord.Events.GuildMemberAdd, (member) => {
    for (const id of config.DISCORD.LOGGING) {
        member.guild.channels.fetch(id).then((channel) => {
            channel.send({
                content: `<@${member.id}> (${member.user.tag}) joined. ||${member.user.displayName}||`,
                allowedMentions: {},
            });
        }).catch(console.log);
    }
});

discordClient.on(discord.Events.GuildMemberRemove, (member) => {
    for (const id of config.DISCORD.LOGGING) {
        member.guild.channels.fetch(id).then((channel) => {
            channel.send({
                content: `<@${member.id}> (${member.user.tag}) left. ||${member.user.displayName}||`,
                allowedMentions: {},
            });
        }).catch(console.log);
    }
});

discordClient.on(discord.Events.VoiceStateUpdate, (before, after) => {
    if (before.channelId != null) {
        if (!config.DISCORD.MASTER_CHANNELS.includes(before.channelId)) {
            for (const id of config.DISCORD.LOGGING) {
                before.guild.channels.fetch(id).then((channel) => {
                    channel.send({
                        content: `<@${before.id}> (${before.member.user.tag}) left voice channel ${before.channel.name}.`,
                        allowedMentions: {},
                    });
                }).catch(console.log);
            }
        }
        if (storage.rooms.has(before.channelId) && before.channel.members.size < 1) {
            removeRoom(before.channel);
        }
    }

    if (after.channelId != null) {
        if (config.DISCORD.MASTER_CHANNELS.includes(after.channelId)) {
            createRoom(after);
        } else {
            for (const id of config.DISCORD.LOGGING) {
                after.guild.channels.fetch(id).then((channel) => {
                    channel.send({
                        content: `<@${after.id}> (${after.member.user.tag}) joined voice channel ${after.channel.name}.`,
                        allowedMentions: {},
                    });
                }).catch(console.log);
            }
        }
    }
});

discordClient.on(discord.Events.Error, (err) => {
    console.error('The WebSocket encountered an error:', err);
});

discordClient.login(config.DISCORD.TOKEN);


async function oauthProvider() {
    const auth = new RefreshingAuthProvider({ clientId: config.TWITCH_CLIENT_ID, clientSecret: config.TWITCH_SECRET });
    auth.onRefresh((user, data) => storage.auth.set('twitch', data));
    let tokenData = { };
    if (storage.auth.has('twitch')) {
        tokenData = storage.auth.get('twitch');
    } else if (config.TWITCH_CODE) {
        tokenData = await exchangeCode(config.TWITCH_CLIENT_ID, config.TWITCH_SECRET, config.TWITCH_CODE, config.TWITCH_REDIRECT);
        storage.auth.set('twitch', tokenData)
    } else {
        const url = 'https://id.twitch.tv/oauth2/authorize';
        const params = new URLSearchParams({
            client_id: config.TWITCH_CLIENT_ID,
            redirect_uri: config.TWITCH_REDIRECT,
            response_type: 'code',
            scope: [
                'channel:bot',
                'channel:manage:broadcast',
                'chat:edit',
                'chat:read'
            ]
        });
        console.log(`[Twitch] Follow ${url}?${params.toString().replaceAll('%2C', '+')} to authorize Twitch`);
        process.exit(0);
    }
    await auth.addUserForToken(tokenData);
    return auth;
}

const twitchApi = new ApiClient({
    authProvider: new AppTokenAuthProvider(config.TWITCH_CLIENT_ID, config.TWITCH_SECRET),
    logger: config.TWITCH.logger,
});
const twitchSub = new EventSubHttpListener({
    apiClient: twitchApi,
    adapter: new NgrokAdapter({
        ngrokConfig: {
            authtoken: config.NGROK
        }
    }),
    secret: config.TWITCH_SECRET,
});
const twitchChat = new ChatClient({
    authProvider: new StaticAuthProvider(config.TWITCH_CLIENT_ID, config.TWITCH_TOKEN),
    channels: config.TWITCH.channels,
});

twitchChat.onAuthenticationSuccess(async () => {
    console.log('[Twitch] Hi, %s!', twitchChat.irc.currentNick);
    for (const [ username, settings ] of Object.entries(config.TWITCH.streamers)) {
        if (!settings.notification) {
            continue;
        }
        const user = await twitchApi.users.getUserByName(username);
        if (user) {
            const stream = await user.getStream();
            console.log(`[Twitch] ${user.displayName} is ${stream ? 'LIVE' : 'OFFLINE'}`);

            // twitchSub.onStreamOnline(user, async () => {
            //     const streamer = config.TWITCH.streamers[user.name];
            //     if (streamer?.notification?.discord) {
            //         const textChannel = await discordClient.channels.fetch(streamer.notification.discord);
            //         if (textChannel) {
            //             const message = config.TWITCH.defaultMessage;
            //             await textChannel.send(message.replace('{twitch}', `https://twitch.tv/${user.name}`));
            //         }
            //     }
            //     console.log(`[Twitch] ${user.displayName} is LIVE`);
            // });

            // twitchSub.onStreamOffline(user, async () => {
            //     console.log(`[Twitch] ${user.displayName} is OFFLINE`);
            // });
        }
    }

    const subs = await twitchApi.eventSub.getSubscriptions();
    // for (let i = 2; i < subs.data.length; i++) {
    //     await subs.data[i].unsubscribe();
    // }
    console.log('SUBSCRIPTIONS', subs.data.map(x =>
        `ID: ${x.id}, Cost: ${x.cost}, Type: ${x.type}, Status: ${x.status}, Condition: ${JSON.stringify(x.condition)}`));
});

twitchChat.onMessage((channel, user, text, msg) => {
    console.log('[%s]: %s', user, text);
    // const { data: [follow] } = await apiClient.channels.getChannelFollowers(broadcasterId, msg.userInfo.userId);
    // twitchChat.say(channel, `@${user} You are not following!`);
});

twitchSub.start();
twitchChat.connect();
