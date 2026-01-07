import config from './config/index.cjs';
import discord from 'discord.js';
import { HttpClient } from './utils.js';
import { YoutubeClient } from './api/youtube.js';
import { BroadcastService } from './services/broadcast.js';
import { ChatService } from './services/chat.js';
import { ControlService } from './services/control.js';
import { DiscordService } from './services/discord.js';
import { DonationAlertsService } from './services/alerts.js';
import { TwitchService } from './services/twitch.js';
import { WebSocketService } from './services/web.js';
import { YoutubeService } from './services/youtube.js';

const backendClient = new HttpClient(config.API_OPTIONS);
const youtubeClient = new YoutubeClient(config.YOUTUBE);
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

let donationAlertsService;
const chatService = new ChatService({
    config,
    backendClient,
    getLastSongText: (fallback) => (donationAlertsService ? donationAlertsService.getLastSongText(fallback) : fallback),
});
const twitchService = new TwitchService({ config, chatService, discordClient });
const broadcastService = new BroadcastService({
    config,
    twitchClient: twitchService.client,
    youtubeClient,
});

donationAlertsService = new DonationAlertsService({ config, broadcastService });

const webSocketService = new WebSocketService({ config, discordClient });
const discordService = new DiscordService({
    config,
    backendClient,
    chatService,
    webSocketService,
    discordClient,
});
const youtubeService = new YoutubeService({ config, youtubeClient, chatService });
// const controlService = new ControlService({ config });

const main = () => {
    webSocketService.start();
    donationAlertsService.start();
    chatService.updateData();
    youtubeService.start();
    twitchService.start();
    discordService.start();
};

main();
