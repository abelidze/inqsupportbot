import { AppTokenAuthProvider, StaticAuthProvider } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import { EventSubHttpListener, ReverseProxyAdapter } from '@twurple/eventsub-http';
import { NgrokAdapter } from '@twurple/eventsub-ngrok';

export class TwitchService {
    constructor({ config, chatService, discordClient }) {
        this.config = config;
        this.chatService = chatService;
        this.api = new ApiClient({
            authProvider: new AppTokenAuthProvider(config.TWITCH_CLIENT_ID, config.TWITCH_SECRET),
            logger: config.TWITCH.logger,
        });
        let adapter = null;
        if (config.TWITCH.eventsub) {
            adapter = new ReverseProxyAdapter({
                hostName: config.TWITCH.eventsub.host,
                pathPrefix: config.TWITCH.eventsub.path,
                usePathPrefixInHandlers: true,
                port: 8443,
            });
        } else {
            adapter = new NgrokAdapter({
                port: 8443,
                ngrokConfig: {
                    authtoken: config.NGROK
                },
            });
        }
        this.events = new EventSubHttpListener({
            adapter,
            apiClient: this.api,
            secret: config.TWITCH_SECRET,
        });
        this.chat = new ChatClient({
            authProvider: new StaticAuthProvider(config.TWITCH_CLIENT_ID, config.TWITCH_TOKEN),
            channels: config.TWITCH.channels,
        });
        this.discordClient = discordClient;
    }

    start() {
        this.chat.onAuthenticationSuccess(async () => {
            console.log('[Twitch] Hi, %s!', this.chat.irc.currentNick);
            for (const [ username, settings ] of Object.entries(this.config.TWITCH.streamers)) {
                if (!settings.notification) {
                    continue;
                }
                const user = await this.api.users.getUserByName(username);
                if (user) {
                    const stream = await user.getStream();
                    console.log(`[Twitch] ${user.displayName} is ${stream ? 'LIVE' : 'OFFLINE'}`);

                    this.events.onStreamOnline(user, async () => {
                        const streamer = this.config.TWITCH.streamers[user.name];
                        if (this.discordClient && streamer?.notification?.discord) {
                            const textChannel = await this.discordClient.channels.fetch(streamer.notification.discord);
                            if (textChannel) {
                                const message = this.config.TWITCH.defaultMessage;
                                await textChannel.send(message.replace('{twitch}', `https://twitch.tv/${user.name}`));
                            }
                        }
                        console.log(`[Twitch] ${user.displayName} is LIVE`);
                    });

                    this.events.onStreamOffline(user, async () => {
                        console.log(`[Twitch] ${user.displayName} is OFFLINE`);
                    });
                }
            }

            const subs = await this.api.eventSub.getSubscriptions();
            console.log('[Twitch] SUBSCRIPTIONS', subs.data.map(x =>
                `ID: ${x.id}, Cost: ${x.cost}, Type: ${x.type}, Status: ${x.status}, Condition: ${JSON.stringify(x.condition)}`));
        });

        this.chat.onMessage((channel, user, text, msg) => {
            if (user == this.chat.irc.currentNick || user.match(this.config.IGNORE)) {
                return;
            }
            this.chatService.questionHandler(
                channel.substring(1),
                `t${msg.userInfo.userId}`,
                user,
                text.trim(),
                (answer) => {
                    if (this.chatService.isIgnorableAnswer(answer)) {
                        return;
                    }
                    this.chat.say(channel, `@${user} ${answer.text}`).catch((err) => {
                        console.log('[Twitch]', err);
                    });
                },
            );
        });

        this.chat.onDisconnect((_, err) => {
            if (err) {
                console.error('[Twitch]', err);
            }
        });

        this.events.start();
        this.chat.connect();
    }
}
