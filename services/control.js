import redis from 'redis';

export class ControlService {
    constructor({ config }) {
        this.config = config;
        this.client = redis.createClient({
            host: config.REDIS_HOST,
            port: config.REDIS_PORT,
            password: config.REDIS_PASS,
            retry_strategy: config.REDIS_POLICY,
        });
    }

    start() {
        this.client.on('message', (channel, payload) => {
            if (channel !== 'control') {
                return;
            }

            if (payload === 'reboot') {
                process.exit();
            }
        });

        this.client.on('error', (err) => {
            console.error('[RedisError]', err);
        });

        this.client.subscribe('control');
    }
}
