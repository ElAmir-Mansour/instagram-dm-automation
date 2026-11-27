/**
 * Linking a person's own Telegram chat to the platform's bot (`telegramLink.ts`, U3 SA-11).
 *
 * Telegram and the database are the stand-ins of `notifyTestSupport.ts`: no test here reaches Telegram or a person. Pinned, because each
 * is a way the wrong chat gets linked, a link cannot be completed, or a secret leaks:
 *
 *   - the link: needs the platform's bot token (TELEGRAM_BOT_MISSING) and an answer from `getMe` (TELEGRAM_UNREACHABLE); the address is the
 *     bot's own username and a 43-character code that fits Telegram's 64 and lives ten minutes, in a state bound to this tenant and user;
 *   - `confirm` links ONLY a private chat whose message is exactly `/start <code>`; someone else's code, a group chat and a chat that
 *     has not pressed Start yet all stay "not linked"; an expired or foreign state is 410 TELEGRAM_LINK_EXPIRED before Telegram is asked;
 *   - `getUpdates` is called WITHOUT an `offset` (an offset would acknowledge everybody else's pending messages);
 *   - the code is single use; a Start of an old code does not link;
 *   - the token and the chat id are in no answer, log line or audit row; unlinking deletes both.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { OAUTH_STATE_TTL_MS } from './oauthState.js';
import { readUserNotify, userNotifyKey } from './notifyPeople.js';
import { BOT_TOKEN, NotifyWorld } from './notifyTestSupport.js';
import { confirmLink, setPaused, startLink, TelegramLinkError, unlink } from './telegramLink.js';

const WHO = { creatorId: 'tenant-company', userId: 'u-sara' };
const SESSION = { userId: 'u-sara', role: 'user' };

let world: NotifyWorld;
beforeEach(() => { world = new NotifyWorld().withTelegram(); world.install(); });
afterEach(() => world.restore());

async function refused(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (err) {
        assert.ok(err instanceof TelegramLinkError, `a TelegramLinkError, got ${String(err)}`);
        return err.code;
    }
    assert.fail('expected a refusal');
}

// ─── The link ──────────────────────────────────────────────────────────────────────────────────────────────

describe('startLink', () => {
    it('answers the bot\'s own address with a one-time code that fits Telegram\'s limit', async () => {
        const link = await startLink(WHO);
        const [, code] = /^https:\/\/t\.me\/autoreply_pro_bot\?start=([A-Za-z0-9_-]+)$/.exec(link.url) ?? [];
        assert.ok(code, link.url);
        assert.equal(code!.length, 43);
        assert.ok(code!.length <= 64, 'Telegram\'s start parameter is at most 64 characters');
        assert.equal(world.lastNonce, code, 'the code is the stored state');
        assert.ok(!JSON.stringify(link).includes(BOT_TOKEN));
    });

    it('TELEGRAM_BOT_MISSING when the platform has no bot token: nothing is asked of Telegram or stored', async () => {
        world.settings = {};
        assert.equal(await refused(startLink(WHO)), 'TELEGRAM_BOT_MISSING');
        assert.deepEqual(world.gets, []);
        assert.equal(world.states.size, 0);
    });

    it('TELEGRAM_UNREACHABLE when Telegram does not answer, and no state is left behind', async () => {
        world.getMe = () => { throw Object.assign(new Error(`connect ETIMEDOUT /bot${BOT_TOKEN}/getMe`), { code: 'ECONNABORTED' }); };
        assert.equal(await refused(startLink(WHO)), 'TELEGRAM_UNREACHABLE');
        assert.equal(world.states.size, 0);
        assert.ok(!world.logs.join('\n').includes(BOT_TOKEN.split(':')[1]!), 'the token\'s secret half is in no log line (the error\'s own text carried it)');
    });

    it('A LINK TOKEN EXPIRES: the state is minted for ten minutes, bound to this tenant and user, and spent never earlier than its code', async () => {
        const before = Date.now();
        const link = await startLink(WHO);
        const state = world.states.get(world.lastNonce)!;
        assert.equal(state.platform, 'telegram');
        assert.equal(state.creatorId, WHO.creatorId);
        assert.equal(state.userId, WHO.userId);
        const ttl = state.expiresAt.getTime() - before;
        assert.ok(ttl >= OAUTH_STATE_TTL_MS - 5_000 && ttl <= OAUTH_STATE_TTL_MS + 5_000, `ten minutes, not ${ttl} ms`);
        assert.equal(OAUTH_STATE_TTL_MS, 10 * 60 * 1000);
        assert.ok(Date.parse(link.expiresAt) - before <= OAUTH_STATE_TTL_MS + 5_000, 'and the answer says so');

        // An hour later the same code opens nothing, before Telegram is even asked.
        state.expiresAt = new Date(Date.now() - 1000);
        world.pressStart(world.lastNonce);
        world.gets.length = 0;
        assert.equal(await refused(confirmLink(WHO, world.lastNonce, SESSION)), 'TELEGRAM_LINK_EXPIRED');
        assert.deepEqual(world.gets, [], 'an expired code never reaches Telegram');
        assert.equal((await readUserNotify(WHO.userId)).telegram, null, 'and nothing is linked');
    });

    it('the liveness check itself asks the database for an unspent, unexpired state of this purpose, tenant and user', () => {
        const source = readFileSync('src/services/oauthState.ts', 'utf8');
        const fn = source.slice(source.indexOf('export async function isOAuthStateLive'), source.indexOf('function openPayload'));
        assert.match(fn, /expires_at > NOW\(\)/);
        assert.match(fn, /used_at IS NULL/);
        assert.match(fn, /platform = \$2 AND creator_id = \$3 AND user_id IS NOT DISTINCT FROM \$4::uuid/);
    });
});

// ─── The handshake ──────────────────────────────────────────────────────────────────────────────────────────

describe('confirmLink', () => {
    async function started(): Promise<string> {
        await startLink(WHO);
        world.gets.length = 0;
        world.posts.length = 0;
        return world.lastNonce;
    }

    it('before the person has pressed Start it is "not yet", and keeps nothing', async () => {
        const code = await started();
        assert.deepEqual(await confirmLink(WHO, code, SESSION), { linked: false });
        assert.equal((await readUserNotify(WHO.userId)).telegram, null);
    });

    it('links the PRIVATE chat that sent exactly "/start <code>": the first name is shown back, the code is spent, a confirmation goes to the chat', async () => {
        const code = await started();
        world.pressStart(code, { id: 987654321, first_name: 'Sara' });
        const answer = await confirmLink(WHO, code, SESSION);
        assert.deepEqual(answer, { linked: true, name: 'Sara' });

        const doc = JSON.parse(world.settings[userNotifyKey(WHO.userId)]!);
        assert.deepEqual([doc.v, doc.telegram.chatId, doc.telegram.name, doc.telegram.paused], [1, '987654321', 'Sara', false]);
        assert.ok(world.states.get(code)!.usedAt, 'the code is spent');
        assert.equal(world.posts.length, 1);
        assert.equal(world.posts[0]!.body['chat_id'], '987654321');
        assert.equal(world.audits.filter((a) => a.action === 'notify.telegram_link').length, 1);
        assert.deepEqual(world.audits[0]!.detail, { user_id: WHO.userId }, 'the audit row names the person and not the chat');
    });

    it('is single use: the same Start cannot link a second time, and an old code opens nothing', async () => {
        const code = await started();
        world.pressStart(code);
        await confirmLink(WHO, code, SESSION);
        assert.equal(await refused(confirmLink(WHO, code, SESSION)), 'TELEGRAM_LINK_EXPIRED');
    });

    it('calls getUpdates WITHOUT an offset, for the message updates only', async () => {
        const code = await started();
        await confirmLink(WHO, code, SESSION);
        const call = world.gets.find((g) => g.url.endsWith('/getUpdates'));
        assert.ok(call, 'it asked Telegram');
        assert.ok(!('offset' in (call!.config?.['params'] ?? {})), 'an offset would acknowledge other people\'s pending messages');
        assert.equal(call!.config?.['params'].allowed_updates, JSON.stringify(['message']));
        assert.equal(call!.config?.['params'].limit, 100);
    });

    it('someone else\'s code, a code with extra text, and a group chat all stay "not linked"', async () => {
        const code = await started();
        world.pressStart('A'.repeat(43), { id: 111 });
        world.updates.push({ update_id: 90, message: { chat: { id: 222, type: 'private' }, from: { first_name: 'X' }, text: `/start ${code} extra` } });
        world.updates.push({ update_id: 91, message: { chat: { id: -100333, type: 'supergroup' }, from: { first_name: 'Y' }, text: `/start ${code}` } });
        world.updates.push({ update_id: 92, edited_message: { chat: { id: 444, type: 'private' }, text: `/start ${code}` } });
        assert.deepEqual(await confirmLink(WHO, code, SESSION), { linked: false });
        assert.equal((await readUserNotify(WHO.userId)).telegram, null);
        assert.ok(!world.states.get(code)!.usedAt, 'and the code is not spent');
    });

    it('a state minted for another person or another workspace is "expired" to this one', async () => {
        const code = await started();
        assert.equal(await refused(confirmLink({ ...WHO, userId: 'u-other' }, code, { userId: 'u-other' })), 'TELEGRAM_LINK_EXPIRED');
        assert.equal(await refused(confirmLink({ ...WHO, creatorId: 'tenant-other' }, code, SESSION)), 'TELEGRAM_LINK_EXPIRED');
    });

    it('a body that is not one of our codes never reaches the database or Telegram', async () => {
        world.gets.length = 0;
        world.executed.length = 0;
        for (const bad of [undefined, null, 12, '', "x' OR 1=1 --", 'a'.repeat(200), ['x']]) {
            assert.equal(await refused(confirmLink(WHO, bad, SESSION)), 'TELEGRAM_LINK_EXPIRED');
        }
        assert.deepEqual(world.executed, []);
        assert.deepEqual(world.gets, []);
    });

    it('a Telegram that refuses (for example a 409 because the bot has a webhook) is TELEGRAM_UNREACHABLE, scrubbed', async () => {
        const code = await started();
        world.getUpdatesAnswer = () => {
            throw Object.assign(new Error(`Request failed ${BOT_TOKEN}`), { response: { status: 409, data: { description: `Conflict: can't use getUpdates while a webhook is active /bot${BOT_TOKEN}` } } });
        };
        assert.equal(await refused(confirmLink(WHO, code, SESSION)), 'TELEGRAM_UNREACHABLE');
        const poll = world.logged.find((l) => l.event === 'notify.telegram_link_poll_failed');
        assert.equal(poll?.['status'], 409);
        assert.ok(!world.logs.join('\n').includes(BOT_TOKEN), 'the token is in no log line');
    });

    it('the token and the chat id are in no answer, log line or audit row', async () => {
        const code = await started();
        world.pressStart(code, { id: 555000111 });
        const answer = await confirmLink(WHO, code, SESSION);
        const out = JSON.stringify([answer, world.logs, world.audits]);
        assert.ok(!out.includes(BOT_TOKEN) && !out.includes('555000111'));
    });
});

// ─── Pause and unlink ───────────────────────────────────────────────────────────────────────────────────────

describe('pausing and unlinking', () => {
    async function linked(): Promise<void> {
        await startLink(WHO);
        world.pressStart(world.lastNonce, { id: 777 });
        await confirmLink(WHO, world.lastNonce, SESSION);
        world.audits.length = 0;
        world.writes.length = 0;
    }

    it('pause keeps the link and stops the notices; resume brings them back; nothing linked has nothing to pause', async () => {
        assert.equal(await setPaused(WHO, true), false);
        await linked();
        assert.equal(await setPaused(WHO, true), true);
        assert.equal((await readUserNotify(WHO.userId)).telegram?.paused, true);
        assert.equal((await readUserNotify(WHO.userId)).telegram?.chatId, '777');
        await setPaused(WHO, false);
        assert.equal((await readUserNotify(WHO.userId)).telegram?.paused, false);
    });

    it('unlink deletes the row (the chat id and the name with it), audits the person, and is idempotent', async () => {
        await linked();
        await unlink(WHO, SESSION);
        assert.ok(!(userNotifyKey(WHO.userId) in world.settings), 'nothing of the person is kept');
        assert.deepEqual(world.writes, [{ key: userNotifyKey(WHO.userId), value: null }]);
        assert.deepEqual(world.audits.map((a) => a.action), ['notify.telegram_unlink']);
        assert.ok(!JSON.stringify(world.audits).includes('777'));
        await unlink(WHO, SESSION);
        assert.equal(world.audits.length, 1, 'a second unlink writes nothing');
    });
});
