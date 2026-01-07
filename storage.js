import config from './config/index.cjs';
import Enmap from 'enmap';

export default {
    auth: new Enmap({ name: 'auth' }),
    rooms: new Enmap({ name: 'rooms' }),
    channels: new Map(config.DISCORD.MASTER_CHANNELS.map(id => [id, new Enmap({ name: `master_${id}` })])),
};
