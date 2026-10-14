/**
 * Who an Instagram sender is: the Graph call, the mapping, and the best-effort, throttled step the DM pipeline and the inbox share.
 *
 * Nothing here touches Meta or Postgres. `metaHttp.get` stands in for graph.facebook.com and `pool.query` for the database, and either
 * throws on a call a test did not arrange: `.env` holds live production credentials, so a test that reached the network would be
 * looking up a real customer.
 *
 * What the owner asked of it, as tests: success; a failure is logged and never blocks (`refreshSenderProfile` resolves, whatever
 * happened, including a database that has not had v40 applied); and the throttle (first contact, then at most once a day).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import {
    API_VERSION, fetchInstagramUserProfile, GRAPH_BASE, MetaApiError, PROFILE_FIELDS, PROFILE_FIELDS_BASIC, PROFILE_TIMEOUT_MS,
    ProfileUnavailableError, mapInstagramUserProfile, type InstagramUserProfile,
} from './instagram.js';
import {
    CLAIM_PROFILE_SQL, PROFILE_REFRESH_SECONDS, PROFILE_RETRY_SECONDS, PROFILE_STALE_MS, PROFILE_WAIT_MS, refreshSenderProfile, settleWithin,
    STORE_PROFILE_SQL,
} from './senderProfile.js';

const TOKEN = 'EAAGtest-token';
const CONV = '33333333-3333-4333-8333-333333333333';

interface Logged { level: string; line: string }
let logged: Logged[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { logged.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// ─── The Graph call ──────────────────────────────────────────────────────────────────────────
interface Recorded { url: string; config: any }
let calls: Recorded[] = [];
let onGet: (url: string, config: any) => Promise<any>;
const originalGet = metaHttp.get;

beforeEach(() => {
    logged = [];
    calls = [];
    onGet = async (url) => { throw new Error(`no GET was arranged for ${url}`); };
    (metaHttp as any).get = (url: string, config: any) => { calls.push({ url, config }); return onGet(url, config); };
});
afterEach(() => { (metaHttp as any).get = originalGet; });

/** Code 100 by default, which `withRetry` refuses to retry, so a failing test does not sit through a real backoff. */
function metaError(code = 100, message = 'Bad thing', status = 400) {
    return Object.assign(new Error(message), { response: { status, data: { error: { code, message } } } });
}

/** The reference's own sample answer (messenger-platform/instagram/features/user-profile), plus the one field its sample leaves out. */
const DOC_SAMPLE = {
    name: 'Peter Chang', username: 'peter_chang_live', profile_pic: 'https://cdn.example.test/p.jpg',
    follower_count: 1234, is_user_follow_business: false, is_business_follow_user: true, is_verified_user: false,
};

describe('mapInstagramUserProfile', () => {
    it('maps every documented field', () => {
        assert.deepEqual(mapInstagramUserProfile(DOC_SAMPLE), {
            name: 'Peter Chang', username: 'peter_chang_live', profilePic: 'https://cdn.example.test/p.jpg',
            followerCount: 1234, followsBusiness: false, businessFollows: true, verified: false,
        });
    });

    it('leaves a field null when Meta did not send it, never a guess (the sample has no is_verified_user)', () => {
        const { is_verified_user: _omitted, ...sample } = DOC_SAMPLE;
        assert.equal(mapInstagramUserProfile(sample).verified, null);
        assert.deepEqual(mapInstagramUserProfile({ username: 'a' }), {
            name: null, username: 'a', profilePic: null, followerCount: null, followsBusiness: null, businessFollows: null, verified: null,
        });
    });

    it('trusts nothing: wrong types are null, a picture is an http(s) URL or nothing, text is trimmed and capped', () => {
        const mapped = mapInstagramUserProfile({
            name: `  ${'x'.repeat(300)}  `, username: 5, profile_pic: 'javascript:alert(1)', follower_count: '12',
            is_user_follow_business: 'yes', is_business_follow_user: 1, is_verified_user: null,
        });
        assert.equal(mapped.name!.length, 255);
        assert.equal(mapped.username, null);
        assert.equal(mapped.profilePic, null);
        assert.equal(mapped.followerCount, null);
        assert.equal(mapped.followsBusiness, null);
        assert.equal(mapped.businessFollows, null);
        for (const pic of ['data:image/png;base64,AAA', '//cdn.test/a.png', '/a.png', '   ']) assert.equal(mapInstagramUserProfile({ profile_pic: pic }).profilePic, null, pic);
        assert.equal(mapInstagramUserProfile({ profile_pic: ' HTTP://cdn.test/a.png ' }).profilePic, 'HTTP://cdn.test/a.png');
        for (const count of [-1, 1.5, NaN, Infinity, 2_147_483_648]) assert.equal(mapInstagramUserProfile({ follower_count: count }).followerCount, null, String(count));
        assert.equal(mapInstagramUserProfile({ follower_count: 0 }).followerCount, 0, 'zero followers is a count');
    });

    it('maps a body that is not an object to all nulls', () => {
        for (const body of [null, undefined, 'x', 7, []]) {
            assert.deepEqual(mapInstagramUserProfile(body), {
                name: null, username: null, profilePic: null, followerCount: null, followsBusiness: null, businessFollows: null, verified: null,
            });
        }
    });
});

describe('fetchInstagramUserProfile — the Instagram User Profile API', () => {
    it('is GET /{IGSID}?fields=… on graph.facebook.com with the Page token as a Bearer header, like the DM send', async () => {
        onGet = async () => ({ data: DOC_SAMPLE });
        const profile = await fetchInstagramUserProfile('17841400003051', TOKEN);

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, `${GRAPH_BASE}/17841400003051`);
        assert.ok(calls[0]!.url.startsWith('https://graph.facebook.com/'), 'not graph.instagram.com: the reference names the Page-token host');
        assert.ok(calls[0]!.url.includes(`/${API_VERSION}/`));
        assert.equal(calls[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(calls[0]!.config.timeout, PROFILE_TIMEOUT_MS);
        assert.ok(PROFILE_TIMEOUT_MS < 10_000, 'shorter than every other Graph call: it is looked up while a DM is answered');
        assert.equal(profile.username, 'peter_chang_live');
    });

    it('asks for exactly the seven fields the reference lists, and the basic three when the list is refused', () => {
        assert.deepEqual(PROFILE_FIELDS.split(','), [
            'name', 'username', 'profile_pic', 'follower_count', 'is_user_follow_business', 'is_business_follow_user', 'is_verified_user',
        ]);
        assert.deepEqual(PROFILE_FIELDS_BASIC.split(','), ['name', 'username', 'profile_pic']);
    });

    it('sends the field list as a query parameter', async () => {
        onGet = async () => ({ data: DOC_SAMPLE });
        await fetchInstagramUserProfile('1', TOKEN);
        assert.deepEqual(calls[0]!.config.params, { fields: PROFILE_FIELDS });
    });

    it('puts the id in the path as one segment, whatever it contains', async () => {
        onGet = async () => ({ data: DOC_SAMPLE });
        await fetchInstagramUserProfile('../me/accounts?x=1', TOKEN);
        assert.equal(calls[0]!.url, `${GRAPH_BASE}/..%2Fme%2Faccounts%3Fx%3D1`);
    });

    it('asks again with the three that identify the person when the full list is refused with code 100', async () => {
        let n = 0;
        onGet = async () => {
            n++;
            if (n === 1) throw metaError(100, '(#100) Tried accessing nonexisting field (is_verified_user)');
            return { data: { name: 'Sam', username: 'sam_dev', profile_pic: 'https://cdn.example.test/s.jpg' } };
        };
        const profile = await fetchInstagramUserProfile('1', TOKEN);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1]!.config.params, { fields: PROFILE_FIELDS_BASIC });
        assert.equal(profile.name, 'Sam');
        assert.equal(profile.followerCount, null, 'the basic answer has no count, and none is invented');
    });

    it('does not ask again for any other refusal: consent, a block, a dead token are not fixed by fewer fields', async () => {
        for (const [code, message] of [[190, 'Invalid OAuth access token'], [230, 'User consent is required to access user profile'], [10, 'Permission denied']] as const) {
            calls = [];
            onGet = async () => { throw metaError(code, message, code === 190 ? 401 : 400); };
            await assert.rejects(() => fetchInstagramUserProfile('1', TOKEN), (err: unknown) => {
                assert.ok(err instanceof MetaApiError);
                assert.equal(err.metaCode, code, 'Meta’s code survives, for whoever reads the log');
                return true;
            });
            assert.equal(calls.length, 1, String(code));
        }
    });

    it('fails when Meta answers and names nobody', async () => {
        onGet = async () => ({ data: { follower_count: 5 } });
        await assert.rejects(() => fetchInstagramUserProfile('1', TOKEN), ProfileUnavailableError);
        onGet = async () => ({ data: {} });
        await assert.rejects(() => fetchInstagramUserProfile('1', TOKEN), ProfileUnavailableError);
    });

    it('accepts an answer with a name and no username, or the reverse', async () => {
        onGet = async () => ({ data: { name: 'Sam' } });
        assert.equal((await fetchInstagramUserProfile('1', TOKEN)).name, 'Sam');
        onGet = async () => ({ data: { username: 'sam_dev' } });
        assert.equal((await fetchInstagramUserProfile('1', TOKEN)).username, 'sam_dev');
    });
});

// ─── The step the pipeline takes ─────────────────────────────────────────────────────────────
interface Sent { sql: string; params: unknown[] }

const FRESH_PROFILE: InstagramUserProfile = {
    name: 'Sam Dev', username: 'sam_dev', profilePic: 'https://cdn.example.test/sam.jpg',
    followerCount: 4200, followsBusiness: true, businessFollows: false, verified: false,
};

/** Run `refreshSenderProfile` against a stubbed pool. `claim`: the rows the throttle's UPDATE returns ([] = throttled, a function may throw). */
async function run(opts: {
    claim?: () => unknown[];
    store?: () => unknown[];
    fetchProfile?: (igsid: string, token: string) => Promise<InstagramUserProfile>;
    token?: string | null;
    igsid?: string;
} = {}) {
    const sent: Sent[] = [];
    const fetched: Array<[string, string]> = [];
    const original = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/SET profile_checked_at = NOW\(\)/.test(sql)) return { rows: (opts.claim ?? (() => [{ id: CONV }]))() };
        if (/profile_fetched_at = NOW\(\)/.test(sql)) {
            return { rows: (opts.store ?? (() => [{ username: 'sam_dev', profile_name: 'Sam Dev', profile_fetched_at: new Date(0) }]))() };
        }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    try {
        const result = await refreshSenderProfile(
            { conversationId: CONV, igsid: opts.igsid ?? '17841400003051', token: opts.token === undefined ? TOKEN : opts.token },
            {
                fetchProfile: async (igsid, token) => {
                    fetched.push([igsid, token]);
                    return (opts.fetchProfile ?? (async () => FRESH_PROFILE))(igsid, token);
                },
            }
        );
        return { result, sent, fetched };
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
}

describe('refreshSenderProfile — success', () => {
    it('claims the attempt, looks the sender up with the tenant’s token, and stores what Meta said', async () => {
        const { result, sent, fetched } = await run();
        assert.equal(result.outcome, 'refreshed');
        assert.ok(result.profile);
        assert.deepEqual(fetched, [['17841400003051', TOKEN]]);
        assert.equal(sent.length, 2, 'the claim, then the write');
        assert.match(sent[0]!.sql, /^UPDATE conversations SET profile_checked_at = NOW\(\)/);
        assert.deepEqual(sent[0]!.params, [CONV, PROFILE_RETRY_SECONDS, PROFILE_REFRESH_SECONDS]);
        assert.deepEqual(sent[1]!.params, [
            CONV, 'sam_dev', 'Sam Dev', 'https://cdn.example.test/sam.jpg', 4200, true, false, false,
        ]);
    });

    it('writes the handle where the inbox reads it, `conversations.username`, which no code wrote before', async () => {
        const { sent } = await run();
        assert.match(sent[1]!.sql, /SET username = COALESCE\(\$2, username\)/);
    });

    it('a partial answer fills what it has and never blanks what an earlier one found', () => {
        // The statement itself is the guarantee, so it is pinned: every column is `COALESCE(new, old)`.
        for (const column of ['username', 'profile_name', 'profile_pic_url', 'follower_count', 'is_user_follow_business', 'is_business_follow_user', 'is_verified_user']) {
            assert.match(STORE_PROFILE_SQL, new RegExp(`${column} = COALESCE\\(\\$\\d+(::\\w+)?, ${column}\\)`), column);
        }
        assert.match(STORE_PROFILE_SQL, /profile_fetched_at = NOW\(\)/);
    });

    it('sends null for a field Meta left out, so the COALESCE keeps the old value', async () => {
        const { sent } = await run({ fetchProfile: async () => ({ ...FRESH_PROFILE, followerCount: null, verified: null, profilePic: null }) });
        assert.deepEqual(sent[1]!.params, [CONV, 'sam_dev', 'Sam Dev', null, null, true, false, null]);
    });
});

describe('refreshSenderProfile — a failure is logged and never blocks', () => {
    it('a lookup Meta refuses resolves as failed: it does not throw, writes nothing, and says why without the person’s details', async () => {
        const { result, sent } = await run({
            fetchProfile: async () => { throw new MetaApiError('Profile Lookup Failed: User consent is required (Code: 230)', metaError(230, 'User consent is required')); },
        });
        assert.equal(result.outcome, 'failed');
        assert.equal(result.profile, undefined);
        assert.equal(sent.length, 1, 'the claim only: nothing was stored');
        const line = logged.find((l) => /dm\.profile_failed/.test(l.line));
        assert.ok(line, 'dm.profile_failed was logged');
        assert.equal(line!.level, 'warn');
        const fields = JSON.parse(line!.line);
        assert.equal(fields.conversation_id, CONV);
        assert.equal(fields.meta_code, 230);
        assert.ok(!line!.line.includes(TOKEN), 'never the token');
    });

    it('never logs the sender’s name, handle or picture, even in the message of the error', async () => {
        await run({ fetchProfile: async () => { throw new Error('Meta said no'); } });
        const all = logged.map((l) => l.line).join('\n');
        for (const pii of ['Sam Dev', 'sam_dev', 'cdn.example.test']) assert.ok(!all.includes(pii), pii);
    });

    it('a database that cannot take the claim (the columns are not there until v40 is applied) is a failure, not a throw, and Meta is not asked', async () => {
        const { result, fetched } = await run({ claim: () => { throw Object.assign(new Error('column "profile_checked_at" does not exist'), { code: '42703' }); } });
        assert.equal(result.outcome, 'failed');
        assert.equal(fetched.length, 0);
        assert.ok(logged.some((l) => /dm\.profile_failed/.test(l.line)));
    });

    it('a write that fails after a good lookup is a failure too, and still does not throw', async () => {
        const { result } = await run({ store: () => { throw new Error('connection terminated'); } });
        assert.equal(result.outcome, 'failed');
    });

    it('an update that touches no row (the thread was deleted meanwhile) is a failure, not a success', async () => {
        const { result } = await run({ store: () => [] });
        assert.equal(result.outcome, 'failed');
    });

    it('does nothing at all without a token or an id: no SQL, no call', async () => {
        for (const over of [{ token: null }, { token: '' }, { igsid: '' }] as const) {
            const { result, sent, fetched } = await run(over);
            assert.equal(result.outcome, 'skipped');
            assert.equal(sent.length + fetched.length, 0);
        }
    });
});

describe('refreshSenderProfile — the throttle', () => {
    it('does not call Meta when the claim finds the sender looked up recently', async () => {
        const { result, sent, fetched } = await run({ claim: () => [] });
        assert.equal(result.outcome, 'throttled');
        assert.equal(fetched.length, 0, 'no call to Meta');
        assert.equal(sent.length, 1, 'one statement, and it was the claim');
    });

    it('is first contact, then once a day: a day after a success, an hour after an attempt that found nothing', () => {
        assert.equal(PROFILE_REFRESH_SECONDS, 24 * 60 * 60);
        assert.equal(PROFILE_RETRY_SECONDS, 60 * 60);
        assert.equal(PROFILE_STALE_MS, PROFILE_REFRESH_SECONDS * 1000, 'the inbox refreshes a profile on the day the server would allow it');
    });

    it('takes the attempt in ONE statement, so two DMs a second apart ask Meta once between them', () => {
        assert.match(CLAIM_PROFILE_SQL, /^UPDATE conversations\s+SET profile_checked_at = NOW\(\)\s+WHERE id = \$1/);
        assert.match(CLAIM_PROFILE_SQL, /profile_checked_at IS NULL/, 'first contact is always due');
        assert.match(CLAIM_PROFILE_SQL, /CASE WHEN profile_fetched_at IS NULL THEN \$2::float8 ELSE \$3::float8 END/, 'an hour while none has worked, a day after');
        assert.match(CLAIM_PROFILE_SQL, /RETURNING id/, 'no row back is how a caller learns it is throttled');
    });

    it('a failure counts as an attempt, because the claim is taken BEFORE the call', async () => {
        const order: string[] = [];
        const original = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            order.push(/profile_checked_at = NOW/.test(sql) ? 'claim' : 'store');
            return { rows: [{ id: CONV }] };
        };
        try {
            await refreshSenderProfile({ conversationId: CONV, igsid: '1', token: TOKEN }, {
                fetchProfile: async () => { order.push('meta'); throw new Error('boom'); },
            });
        } finally {
            (pool as unknown as { query: unknown }).query = original;
        }
        assert.deepEqual(order, ['claim', 'meta']);
    });
});

describe('settleWithin — how long a DM’s job waits for the lookup that started beside it', () => {
    it('returns as soon as the lookup is done, without waiting out the limit', async () => {
        const started = Date.now();
        await settleWithin(new Promise((resolve) => setTimeout(resolve, 10)), 5_000);
        assert.ok(Date.now() - started < 1_000);
    });

    it('stops waiting at the limit when the lookup is slower, and the lookup keeps going', async () => {
        let finished = false;
        const slow = new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 150));
        const started = Date.now();
        await settleWithin(slow, 20);
        assert.ok(Date.now() - started < 120, 'it did not wait for the slow one');
        assert.equal(finished, false, 'which is still running');
        await slow;
    });

    it('never rejects, whatever the task does', async () => {
        await assert.doesNotReject(() => settleWithin(Promise.reject(new Error('boom')), 50));
    });

    it('is five seconds in the pipeline: a profile never holds a finished DM for long', () => {
        assert.equal(PROFILE_WAIT_MS, 5_000);
    });
});

describe('migration v40 and the statements agree', () => {
    const sql = readFileSync('src/config/migration_v40_conversation_profile.sql', 'utf8');
    const code = sql.replace(/--[^\n]*/g, '');

    it('adds every column the claim and the write name, each idempotently, to `conversations` and nothing else', () => {
        const added = [...code.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)];
        assert.ok(added.every((m) => m[1] === 'conversations'));
        const columns = new Set(added.map((m) => m[2]));
        const named = new Set([...(CLAIM_PROFILE_SQL + STORE_PROFILE_SQL).matchAll(/\b(profile_\w+|follower_count|is_\w+)\b/g)].map((m) => m[1]));
        for (const column of named) assert.ok(columns.has(column!), `${column} is used by senderProfile.ts and not added by the migration`);
        assert.equal(added.length, 8);
        assert.ok(!/CREATE TABLE/i.test(code), 'no new table, so no RLS to forget');
    });

    it('changes no existing row and drops nothing, and gives up in five seconds rather than queue a DM behind it', () => {
        assert.ok(!/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(code));
        assert.match(code, /SET LOCAL lock_timeout = '5s'/);
        assert.ok(!/DEFAULT/i.test(code.replace(/COMMENT[\s\S]*$/, '')), 'a column with no default is catalog-only: nothing is rewritten');
    });
});
