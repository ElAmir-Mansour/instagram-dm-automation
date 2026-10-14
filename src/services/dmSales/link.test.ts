/**
 * The seam that decides what a sales reply's link is (`link.ts`): a tracked `/r/<code>` link on our own domain, and the offer's own address only
 * when the tracked one cannot be made.
 *
 * `pool.query` answers on the SQL it is handed. What is pinned: the domain is the saved public address and never anything a request said, the
 * code is the one the table hands back, the target stored is the offer's address as typed (so a referral parameter reaches the shop), and a
 * failure of ANY kind costs the customer nothing but the click count.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { linkFor } from './link.js';

const CONVERSATION = { id: 'conv-1', creatorId: 'creator-1' };
const OFFER = { id: 'plan', url: ' https://shop.example/product?ref=AB12CD ' };

let original: typeof pool.query;
let originalBase: string | undefined;
let asked: { sql: string; params: any[] }[];
let logged: { level: string; event: string; [k: string]: unknown }[];
let restoreSink: () => void;

/** `settings`: what `app_settings` holds by key; `tracked`: the row (or error) the `tracked_links` insert gives. */
function database(settings: Record<string, string>, tracked: { code: string } | Error): void {
    (pool as any).query = async (sql: string, params: any[] = []) => {
        asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/FROM app_settings WHERE key/.test(sql)) {
            const value = settings[params[0]];
            return { rows: value === undefined ? [] : [{ value, is_secret: false }], rowCount: value === undefined ? 0 : 1 };
        }
        if (/INSERT INTO tracked_links/.test(sql)) {
            if (tracked instanceof Error) throw tracked;
            return { rows: [tracked], rowCount: 1 };
        }
        throw new Error(`no result arranged for SQL:\n${sql}`);
    };
}

beforeEach(() => {
    original = pool.query;
    originalBase = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    asked = [];
    logged = [];
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => { setLogSink(previous); };
});
afterEach(() => {
    (pool as any).query = original;
    if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = originalBase;
    restoreSink();
});

describe('linkFor', () => {
    it('is the public address, /r/, and the code the table hands back', async () => {
        database({ 'app.public_base_url': 'https://app.example' }, { code: 'Ab12Cd34Ef' });
        assert.equal(await linkFor(OFFER, CONVERSATION), 'https://app.example/r/Ab12Cd34Ef');
    });

    it('stores the offer\'s own address, as typed (trimmed), for this tenant, offer and conversation: so the referral parameter reaches the shop', async () => {
        database({ 'app.public_base_url': 'https://app.example' }, { code: 'Ab12Cd34Ef' });
        await linkFor(OFFER, CONVERSATION);
        const insert = asked.find((a) => /INSERT INTO tracked_links/.test(a.sql))!;
        assert.deepEqual(insert.params.slice(1), ['creator-1', 'plan', 'https://shop.example/product?ref=AB12CD', 'conv-1']);
        assert.match(insert.params[0], /^[0-9A-Za-z]{10}$/, 'a fresh ten-character code is offered');
    });

    it('takes the domain from the saved setting, then PUBLIC_BASE_URL, and never from a request: a DM has none', async () => {
        database({}, { code: 'Ab12Cd34Ef' });
        process.env.PUBLIC_BASE_URL = 'https://from-env.example/';
        assert.equal(await linkFor(OFFER, CONVERSATION), 'https://from-env.example/r/Ab12Cd34Ef', 'a trailing slash on the origin is not doubled');
        database({ 'app.public_base_url': 'https://saved.example' }, { code: 'Ab12Cd34Ef' });
        assert.equal(await linkFor(OFFER, CONVERSATION), 'https://saved.example/r/Ab12Cd34Ef', 'the saved setting wins');
    });

    it('sends the offer\'s own address, untracked and logged, when no public address is set: no code is minted for a link nobody could open', async () => {
        database({}, { code: 'Ab12Cd34Ef' });
        assert.equal(await linkFor(OFFER, CONVERSATION), 'https://shop.example/product?ref=AB12CD');
        assert.equal(asked.filter((a) => /INSERT INTO tracked_links/.test(a.sql)).length, 0);
        assert.deepEqual(logged.map((l) => [l.level, l.event, l.reason]), [['warn', 'dm.tracked_link_failed', 'no_public_base_url']]);
    });

    it('sends the offer\'s own address, untracked and logged, when the table cannot make the link', async () => {
        database({ 'app.public_base_url': 'https://app.example' }, Object.assign(new Error('relation "tracked_links" does not exist'), { code: '42P01' }));
        assert.equal(await linkFor(OFFER, CONVERSATION), 'https://shop.example/product?ref=AB12CD');
        assert.equal(logged.length, 1);
        assert.deepEqual([logged[0]!.level, logged[0]!.event, logged[0]!.offer_id, logged[0]!.conversation_id], ['warn', 'dm.tracked_link_failed', 'plan', 'conv-1']);
    });

    it('does the same for an address a tracked link may not point to (the service refuses it): the customer still gets what the owner typed', async () => {
        database({ 'app.public_base_url': 'https://app.example' }, { code: 'Ab12Cd34Ef' });
        const odd = { id: 'plan', url: 'ftp://shop.example/x' };
        assert.equal(await linkFor(odd, CONVERSATION), 'ftp://shop.example/x');
        assert.equal(logged[0]!.event, 'dm.tracked_link_failed');
    });
});
