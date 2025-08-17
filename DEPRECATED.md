For refactoring somewhere in future
===================================

Deprecated Youtube account switcher
-----------------------------------

```js
const youtubeClient = new Proxy(youtube, {
        clients: [],
        cursor: {
            index: 0
        },
        register(params) {
            this.clients.push( registerYoutube(new this.client(params)) );
        },
        next() {
            this.clients[this.cursor.index].stop();
            if (++this.cursor.index >= this.clients.length) {
                this.cursor.index = 0;
            }
            console.log(`[YouTube] Switch to ${this.clients[this.cursor.index].getStreamData().key}`);
            this.clients[this.cursor.index].login();
        },
        get(obj, key) {
            if (this[key] !== undefined) {
                return this[key];
            } else if (this.clients.length > this.cursor.index && this.clients[this.cursor.index][key] !== undefined) {
                return this.clients[this.cursor.index][key];
            } else if (obj[key] !== undefined) {
                return obj[key];
            }
            throw new Error(`[ProxyError] call to unknown method '${key}'`);
        }
    });
config.YOUTUBE.forEach(credential => youtubeClient.register(credential));
```

VKontakte integration
---------------------

It is broken after VK API update.

```js
const vkbot = require('./vkbot');
const vkontakteClient = new vkbot.client(config.VKBOT);

vkontakteClient.on('ready', function () {
    console.log('[VK] Hi!');
});

vkontakteClient.on('error', function (err) {
    console.error('[VKError]', err);
});

vkontakteClient.on('message_new', function (message) {
    const msg = message.text.trim();
    if (!msg) {
        return;
    }

    questionHandler('v' + message.from_id, msg.trim(), function (answer) {
            vkontakteClient.call(
                'messages.send',
                Object.assign(
                    message.from_id < 2000000000
                    ? { user_ids: (Array.isArray(message.from_id) ? message.from_id : [message.from_id]).join(',') }
                    : { peer_id: message.from_id },
                    { message: answer.text }
                ),
                vkontakteClient.getSettings().groupToken
            );
        });
});

vkontakteClient.on('video_comment_new', function (comment) {
    const msg = comment.text.trim();
    const groupId = -vkontakteClient.getSettings().groupId;
    if (comment.from_id == groupId) {
        return;
    }

    questionHandler('v' + comment.from_id, msg, function (answer) {
            if (ignoreAnswer(answer)) {
                return;
            }

            vkontakteClient.call(
                'video.createComment',
                {
                    from_group: 1,
                    owner_id: comment.video_owner_id,
                    video_id: comment.video_id,
                    message: answer.text,
                    reply_to_comment: comment.id
                }
            );
        });
});

vkontakteClient.login();
```
