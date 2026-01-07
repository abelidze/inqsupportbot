import fs from 'fs';
import readline from 'readline';

export class YoutubeService {
    constructor({ config, youtubeClient, chatService }) {
        this.config = config;
        this.youtubeClient = youtubeClient;
        this.chatService = chatService;
    }

    start() {
        this.youtubeClient.on('login', () => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

            rl.question(`[Youtube] OAuth url: ${this.youtubeClient.authorizationUrl()}\n`, (code) => {
                this.youtubeClient.login(code);
                rl.close();
            });
            console.log('[Youtube] Enter your code: ');
        });

        this.youtubeClient.on('ready', () => {
            console.log('[Youtube] Hi!');
        });

        this.youtubeClient.on('credentials', (credentials) => {
            const name = credentials.name || this.youtubeClient.getStreamData().key;
            fs.writeFile(`config/${name}.json`, JSON.stringify(credentials), () => {});
            console.log(`[YouTube] Token updated for ${name}`);
        });

        this.youtubeClient.on('online', (key) => {
            console.log(`[YouTube] Stream connected, ${key}`);
        });

        this.youtubeClient.on('offline', (key) => {
            console.log(`[YouTube] Stream disconnected, ${key}`);
        });

        this.youtubeClient.on('stopped', (key) => {
            console.log(`[YouTube] Client stopped, ${key}`);
        });

        this.youtubeClient.on('message', (message, user) => {
            const msg = message.displayMessage.trim();

            if (user.displayName.match(this.config.IGNORE)) {
                return;
            }

            this.chatService.questionHandler(
                'cepreu_inq',
                `y${user.channelId}`,
                user.displayName,
                msg,
                (answer) => {
                    if (this.chatService.isIgnorableAnswer(answer)) {
                        return;
                    }
                    this.youtubeClient
                        .sendMessage((`@${user.displayName} ${answer.text}`).substring(0, 199))
                        .catch((err) => {
                            console.error(err.response?.data || err);
                        });
                },
            );
        });

        this.youtubeClient.on('error', (err) => {
            if (err.response && err.response.data) {
                if (!err.response.data.error) {
                    console.error('[YouTubeError]', err.response.data);
                    return;
                }
                if (err.response.data.error.message) {
                    console.error('[YouTubeError]', err.response.data.error.message);
                    return;
                }
            }
            console.error('[YouTubeError]', err);
        });

        this.youtubeClient.login();
    }
}
