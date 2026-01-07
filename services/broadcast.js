export class BroadcastService {
    constructor({ config, twitchClient, youtubeClient }) {
        this.config = config;
        this.twitchClient = twitchClient;
        this.youtubeClient = youtubeClient;
    }

    broadcastMessage(message) {
        if (message.twitch && this.twitchClient) {
            const msg = typeof message.twitch === 'function' ? message.twitch() : message.twitch;
            this.twitchClient.say(this.config.TWITCH.channels[0], msg);
        }
        if (message.youtube && this.youtubeClient?.getStreamData().isOnline) {
            const msg = typeof message.youtube === 'function' ? message.youtube() : message.youtube;
            this.youtubeClient
                .sendMessage(msg.substring(0, 199))
                .catch((err) => {
                    console.error(err.response?.data || err);
                });
        }
    }
}
