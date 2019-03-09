const config = require('./config');
const discord = require('discord.js');

const discordClient = new discord.Client();

console.log('ChatServer is starting...');

discordClient.on('ready', function () {
    console.log('Discord connected. Hi, %s!', discordClient.user.tag);
});

discordClient.on('error', function (err) {
    console.error('The WebSocket encountered an error:', err);
});

discordClient.login(config.DISCORD_TOKEN);
