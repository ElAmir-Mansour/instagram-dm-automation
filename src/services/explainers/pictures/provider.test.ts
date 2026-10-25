/**
 * The image provider as the app reads and saves it (T038-T050): `explainers.image_provider` in `app_settings`, the token encrypted inside it and
 * shown back as its last four characters and nothing more, and the rules a platform admin's save is held to. The pool answers by SQL; the
 * encryption is the real one (`src/config/crypto.ts`) under a test key.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { decryptSecret, encryptSecret } from '../../../config/crypto.js';
import { setLogSink } from '../../../utils/log.js';
import { installFakeDb, type FakeDb } from '../../monteur/testDb.js';
import { ExplainerError } from '../errors.js';
import {
    DEFAULT_DAILY_CAP, DEFAULT_IMAGE_PROVIDER_MODEL, DEFAULT_UNITS_PER_PICTURE, describeImageProvider, getImageProvider, parseImageProviderConfig,
    parseImageProviderPatch, readImageProviderConfig, saveImageProvider, setImageProviderFetch, type ImageProviderConfig,
} from './provider.js';

const KEY = 'explainers.image_provider';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-Zk3Qw9Lm2Xp7Vb5Nc8Rt1Yh4Ud6Sg0Jf';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let savedKey: string | undefined;
let lines: string[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const previous = setLogSink((_level, line) => { lines.push(line); });
    restoreSink = () => setLogSink(previous);
});
after(() => {
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    restoreSink?.();
});

const stored = (over: Partial<ImageProviderConfig> = {}): ImageProviderConfig => ({
    provider: 'cloudflare', account_id: ACCOUNT, token_enc: encryptSecret(TOKEN), model: DEFAULT_IMAGE_PROVIDER_MODEL, daily_cap: 80, units_per_picture: 110, ...over,
});

describe('parseImageProviderConfig', () => {
    it('reads what the admin saved: provider, account, the encrypted token, model, daily cap and units a picture', () => {
        const config = stored({ daily_cap: 60, units_per_picture: 120 });
        assert.deepEqual(parseImageProviderConfig(JSON.stringify(config)), config);
    });

    it('fills a missing model, cap or unit cost with the defaults (a row edited by hand keeps working)', () => {
        const parsed = parseImageProviderConfig(JSON.stringify({ provider: 'cloudflare', account_id: ACCOUNT, token_enc: 'enc:v1:x:y:z' }));
        assert.deepEqual(parsed, {
            provider: 'cloudflare', account_id: ACCOUNT, token_enc: 'enc:v1:x:y:z', model: DEFAULT_IMAGE_PROVIDER_MODEL,
            daily_cap: DEFAULT_DAILY_CAP, units_per_picture: DEFAULT_UNITS_PER_PICTURE,
        });
        assert.deepEqual([DEFAULT_DAILY_CAP, DEFAULT_UNITS_PER_PICTURE, DEFAULT_IMAGE_PROVIDER_MODEL], [80, 110, '@cf/black-forest-labs/flux-2-klein-4b']);
    });

    it('replaces a cap or a unit cost that cannot be one (negative, fractional cap, not a number, absurd) with the default, not with a surprise', () => {
        for (const daily_cap of [-1, 1.5, 'many', null, 100_000]) {
            assert.equal(parseImageProviderConfig(JSON.stringify({ ...stored(), daily_cap }))!.daily_cap, DEFAULT_DAILY_CAP, String(daily_cap));
        }
        for (const units_per_picture of [0, -5, 'x', null, 1_000_000]) {
            assert.equal(parseImageProviderConfig(JSON.stringify({ ...stored(), units_per_picture }))!.units_per_picture, DEFAULT_UNITS_PER_PICTURE, String(units_per_picture));
        }
    });

    it('allows a cap of 0, which switches drawing off, and a fractional unit cost', () => {
        const parsed = parseImageProviderConfig(JSON.stringify({ ...stored(), daily_cap: 0, units_per_picture: 109.5 }))!;
        assert.equal(parsed.daily_cap, 0);
        assert.equal(parsed.units_per_picture, 109.5);
    });

    it('is null for nothing, for text that is not JSON or not an object, an unknown provider, a bad account id or model, and a missing token', () => {
        for (const raw of [
            null, undefined, '', 'not json', '[]', '"cloudflare"', '42',
            JSON.stringify({ ...stored(), provider: 'openai' }),
            JSON.stringify({ ...stored(), provider: undefined }),
            JSON.stringify({ ...stored(), account_id: '../../x' }),
            JSON.stringify({ ...stored(), account_id: '' }),
            JSON.stringify({ ...stored(), token_enc: '' }),
            JSON.stringify({ ...stored(), token_enc: undefined }),
            JSON.stringify({ ...stored(), token_enc: 42 }),
        ]) {
            assert.equal(parseImageProviderConfig(raw as string | null | undefined), null, String(raw));
        }
    });

    it('keeps the default model when the stored one could change where the request goes', () => {
        assert.equal(parseImageProviderConfig(JSON.stringify({ ...stored(), model: '@cf/../..' }))!.model, DEFAULT_IMAGE_PROVIDER_MODEL);
    });
});

describe('the stored provider', () => {
    let db: FakeDb;
    let rows: Map<string, string>;
    let writes: { key: string; value: string; secret: boolean; by: string | null }[];

    beforeEach(() => {
        lines = [];
        rows = new Map();
        writes = [];
        db = installFakeDb();
        db.routes.push(
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: rows.has(p[0]) ? [{ value: rows.get(p[0]), is_secret: false }] : [] })],
            [/^INSERT INTO app_settings /, (p) => { rows.set(p[0], p[1]); writes.push({ key: p[0], value: p[1], secret: p[2], by: p[3] }); return { rows: [], rowCount: 1 }; }],
            [/^DELETE FROM app_settings WHERE key = \$1$/, (p) => { rows.delete(p[0]); return { rows: [], rowCount: 1 }; }],
        );
    });
    afterEach(() => { db.restore(); setImageProviderFetch(undefined); });

    describe('readImageProviderConfig', () => {
        it('reads the one platform-wide setting, and is null when nothing is saved', async () => {
            assert.equal(await readImageProviderConfig(), null);
            rows.set(KEY, JSON.stringify(stored()));
            assert.deepEqual(await readImageProviderConfig(), stored({ token_enc: JSON.parse(rows.get(KEY)!).token_enc }));
            assert.deepEqual(db.ran(/FROM app_settings/).map((s) => s.params), [[KEY], [KEY]]);
        });
    });

    describe('getImageProvider', () => {
        it('is null while nothing is set up, and while what is saved cannot be used', async () => {
            assert.equal(await getImageProvider(), null);
            rows.set(KEY, 'not json');
            assert.equal(await getImageProvider(), null);
        });

        it('is the Cloudflare provider with the saved cap and unit cost, drawing with the DECRYPTED token in the Authorization header', async () => {
            rows.set(KEY, JSON.stringify(stored({ daily_cap: 70, units_per_picture: 115 })));
            const calls: { url: string; headers: Headers }[] = [];
            setImageProviderFetch(async (url, init) => {
                calls.push({ url, headers: new Headers(init.headers) });
                return new Response(JSON.stringify({ result: { image: PNG.toString('base64') }, success: true, errors: [] }), { status: 200 });
            });
            const provider = await getImageProvider();
            assert.ok(provider);
            assert.equal(provider.id, 'cloudflare');
            assert.equal(provider.model, DEFAULT_IMAGE_PROVIDER_MODEL);
            assert.equal(provider.dailyCap, 70);
            assert.equal(provider.unitsPerPicture, 115);
            await provider.draw({ prompt: 'p', width: 256, height: 256, seed: 1 });
            assert.equal(calls[0]!.headers.get('authorization'), `Bearer ${TOKEN}`);
            assert.ok(calls[0]!.url.includes(`/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`));
        });

        it('says so, with 502 EXPLAINER_PROVIDER_ERROR, when the saved token cannot be read (the encryption key changed), and never prints it', async () => {
            const garbled = `${encryptSecret(TOKEN).slice(0, -6)}AAAAAA`;
            rows.set(KEY, JSON.stringify(stored({ token_enc: garbled })));
            await assert.rejects(getImageProvider(), (err: unknown) => {
                assert.ok(err instanceof ExplainerError);
                assert.equal(err.code, 'EXPLAINER_PROVIDER_ERROR');
                assert.equal(err.status, 502);
                assert.match(err.message, /cannot be read/);
                assert.match(err.message, /Save the token again/);
                assert.equal(err.message.includes(TOKEN) || err.message.includes(garbled), false);
                return true;
            });
            assert.equal(lines.some((line) => line.includes(TOKEN) || line.includes(garbled)), false);
        });
    });

    describe('describeImageProvider', () => {
        it('is null when nothing is saved', () => {
            assert.equal(describeImageProvider(null), null);
        });

        it('shows the account, the model, the cap and the unit cost, and the token as its last four characters only', () => {
            const view = describeImageProvider(stored({ daily_cap: 60, units_per_picture: 120 }));
            assert.deepEqual(view, {
                provider: 'cloudflare', account_id: ACCOUNT, token_last4: TOKEN.slice(-4), model: DEFAULT_IMAGE_PROVIDER_MODEL, daily_cap: 60, units_per_picture: 120,
            });
        });

        it('carries neither the token nor its encrypted form: not in any field, not anywhere in the JSON', () => {
            const config = stored();
            const text = JSON.stringify(describeImageProvider(config));
            assert.equal(text.includes(TOKEN), false);
            assert.equal(text.includes(config.token_enc), false);
            assert.equal(text.includes('enc:v1'), false);
            assert.equal(text.includes(TOKEN.slice(-8)), false, 'not even a longer tail than the four it promises');
            assert.equal(Object.keys(describeImageProvider(config)!).includes('token_enc'), false);
        });

        it('shows no last four when the token cannot be read or is too short to show any of it, and does not throw', () => {
            assert.equal(describeImageProvider(stored({ token_enc: 'enc:v1:aaaa:bbbb:cccc' }))!.token_last4, null);
            assert.equal(describeImageProvider(stored({ token_enc: encryptSecret('short') }))!.token_last4, null);
        });
    });

    describe('parseImageProviderPatch', () => {
        const body = { account_id: ACCOUNT, token: TOKEN, daily_cap: 80, units_per_picture: 110 };
        const problems = (result: ReturnType<typeof parseImageProviderPatch>): string[] => (result.ok ? [] : result.problems);

        it('takes the account, the token, the cap and the unit cost of a first save, and lists what it sets', () => {
            const parsed = parseImageProviderPatch(body, null);
            assert.deepEqual(parsed, { ok: true, patch: body, changed: ['account_id', 'token', 'daily_cap', 'units_per_picture'] });
        });

        it('wants the account and the token the first time, and says both', () => {
            assert.equal(problems(parseImageProviderPatch({ daily_cap: 80 }, null)).length, 2);
            assert.match(problems(parseImageProviderPatch({ account_id: ACCOUNT }, null)).join(' '), /token/i);
            assert.match(problems(parseImageProviderPatch({ token: TOKEN }, null)).join(' '), /account/i);
        });

        it('lets later saves leave the token (and the account) out: omitted means unchanged', () => {
            const parsed = parseImageProviderPatch({ daily_cap: 50 }, stored());
            assert.deepEqual(parsed, { ok: true, patch: { daily_cap: 50 }, changed: ['daily_cap'] });
            assert.deepEqual(parseImageProviderPatch({ account_id: ACCOUNT, daily_cap: 50 }, stored()), { ok: true, patch: { account_id: ACCOUNT, daily_cap: 50 }, changed: ['daily_cap'] });
        });

        it('trims a pasted token and account id, and counts a token that was sent as changed', () => {
            const parsed = parseImageProviderPatch({ account_id: ` ${ACCOUNT}\n`, token: `  ${TOKEN}\n` }, stored());
            assert.deepEqual(parsed, { ok: true, patch: { account_id: ACCOUNT, token: TOKEN }, changed: ['token'] });
        });

        it('refuses an account id that is not letters and digits, and a token with spaces in it or too short or too long', () => {
            for (const account_id of ['', '../../x', `${ACCOUNT}/x`, 'has space', 'abc', 42, null]) {
                assert.ok(problems(parseImageProviderPatch({ ...body, account_id }, null)).some((p) => /account/i.test(p)), String(account_id));
            }
            for (const token of ['Bearer ' + TOKEN, 'two words in a token that is long enough', 'short', 'x'.repeat(201), 42, null, '']) {
                assert.ok(problems(parseImageProviderPatch({ ...body, token }, null)).some((p) => /token/i.test(p)), String(token));
            }
        });

        it('refuses a cap that is not a whole number from 0 to 1000, and a unit cost that is not above 0 and up to 10000', () => {
            for (const daily_cap of [-1, 1001, 1.5, '80', NaN, Infinity]) {
                assert.ok(problems(parseImageProviderPatch({ ...body, daily_cap }, null)).some((p) => /daily_cap/.test(p)), String(daily_cap));
            }
            for (const units_per_picture of [0, -1, 10_001, '110', NaN]) {
                assert.ok(problems(parseImageProviderPatch({ ...body, units_per_picture }, null)).some((p) => /units_per_picture/.test(p)), String(units_per_picture));
            }
            assert.equal(parseImageProviderPatch({ ...body, daily_cap: 0 }, null).ok, true);
            assert.equal(parseImageProviderPatch({ ...body, daily_cap: 1000, units_per_picture: 10_000 }, null).ok, true);
            assert.equal(parseImageProviderPatch({ ...body, units_per_picture: 0.5 }, null).ok, true);
        });

        it('reports every problem at once, and refuses a body that is not an object', () => {
            assert.equal(problems(parseImageProviderPatch({ account_id: '', token: '', daily_cap: -1, units_per_picture: 0 }, null)).length, 4);
            for (const bad of [null, [], 'x', 42]) assert.equal(parseImageProviderPatch(bad, null).ok, false, String(bad));
        });

        it('treats a field that is null, or text that is blank, as left out: a form that always sends every field does not overwrite the token', () => {
            for (const blank of [null, undefined, '', '   ', '\n']) {
                assert.deepEqual(parseImageProviderPatch({ token: blank, account_id: blank, daily_cap: 60 }, stored()), { ok: true, patch: { daily_cap: 60 }, changed: ['daily_cap'] }, JSON.stringify(blank));
            }
            assert.deepEqual(parseImageProviderPatch({ daily_cap: null, units_per_picture: null }, stored()), { ok: true, patch: {}, changed: [] });
        });

        it('accepts the answer of GET sent back (provider, model, token_last4), and refuses a model or a provider that is not the saved one, or a key it does not know', () => {
            const view = { provider: 'cloudflare', account_id: ACCOUNT, token_last4: 'zzzz', model: DEFAULT_IMAGE_PROVIDER_MODEL, daily_cap: 50, units_per_picture: 110 };
            assert.deepEqual(parseImageProviderPatch(view, stored()), { ok: true, patch: { account_id: ACCOUNT, daily_cap: 50, units_per_picture: 110 }, changed: ['daily_cap'] });
            assert.ok(problems(parseImageProviderPatch({ ...body, model: '@cf/evil/model' }, null)).some((p) => /model/.test(p)), 'the model is not for the admin to change');
            assert.ok(problems(parseImageProviderPatch({ ...body, provider: 'openai' }, null)).some((p) => /provider/.test(p)));
            assert.ok(problems(parseImageProviderPatch({ ...body, dailycap: 5 }, null)).some((p) => /dailycap/.test(p)), 'a typo is reported, not ignored');
        });

        it('lists a field as changed only when its value is not what is saved', () => {
            const parsed = parseImageProviderPatch({ account_id: ACCOUNT, daily_cap: 80, units_per_picture: 111 }, stored());
            assert.deepEqual(parsed.ok && parsed.changed, ['units_per_picture']);
        });
    });

    describe('saveImageProvider', () => {
        it('writes one setting row: not a secret row, the token inside it encrypted, and no plaintext anywhere in what is sent', async () => {
            const saved = await saveImageProvider({ account_id: ACCOUNT, token: TOKEN, daily_cap: 80, units_per_picture: 110 }, ADMIN);
            assert.equal(writes.length, 1);
            const [write] = writes;
            assert.equal(write!.key, KEY);
            assert.equal(write!.secret, false);
            assert.equal(write!.by, ADMIN);
            assert.equal(write!.value.includes(TOKEN), false, 'the plaintext never reaches the database');
            const row = JSON.parse(write!.value);
            assert.deepEqual(Object.keys(row), ['provider', 'account_id', 'token_enc', 'model', 'daily_cap', 'units_per_picture']);
            assert.match(row.token_enc, /^enc:v1:/);
            assert.equal(decryptSecret(row.token_enc), TOKEN);
            assert.deepEqual({ ...row, token_enc: '…' }, { provider: 'cloudflare', account_id: ACCOUNT, token_enc: '…', model: DEFAULT_IMAGE_PROVIDER_MODEL, daily_cap: 80, units_per_picture: 110 });
            assert.deepEqual(saved, row);
        });

        it('leaves the saved token exactly as it is when the save sends none, and changes only what it sends', async () => {
            const before = stored({ daily_cap: 80 });
            rows.set(KEY, JSON.stringify(before));
            const saved = await saveImageProvider({ daily_cap: 40 }, ADMIN);
            assert.equal(saved.token_enc, before.token_enc, 'the same ciphertext: nothing was decrypted and encrypted again');
            assert.deepEqual({ ...saved, daily_cap: 80 }, before);
            assert.equal(saved.daily_cap, 40);
            assert.equal(JSON.parse(rows.get(KEY)!).daily_cap, 40);
        });

        it('replaces the token when a new one is sent, and keeps the model that was saved', async () => {
            rows.set(KEY, JSON.stringify(stored({ model: '@cf/black-forest-labs/flux-2-klein-9b' })));
            const saved = await saveImageProvider({ token: 'a-brand-new-token-0123456789abcdef' }, ADMIN);
            assert.equal(decryptSecret(saved.token_enc), 'a-brand-new-token-0123456789abcdef');
            assert.equal(saved.model, '@cf/black-forest-labs/flux-2-klein-9b');
        });

        it('refuses a first save with no token, and logs nothing that holds a token', async () => {
            await assert.rejects(saveImageProvider({ account_id: ACCOUNT }, ADMIN), /token/i);
            assert.equal(writes.length, 0);
            await saveImageProvider({ account_id: ACCOUNT, token: TOKEN }, ADMIN);
            assert.equal(lines.some((line) => line.includes(TOKEN)), false);
        });
    });
});

describe('setImageProviderFetch', () => {
    it('swaps the fetch every provider is built with, and gives back the one it replaced (tests only)', () => {
        const a = async () => new Response('a');
        const b = async () => new Response('b');
        assert.equal(setImageProviderFetch(a), undefined);
        assert.equal(setImageProviderFetch(b), a);
        assert.equal(setImageProviderFetch(undefined), b);
    });
});
