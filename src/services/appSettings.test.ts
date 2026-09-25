/**
 * The platform's Gemini key: which one answers, and what the Operations screen is told.
 *
 * One key serves every tenant's DM replies and the Studio, so both halves are claims worth
 * pinning: the saved key must win over GEMINI_API_KEY the moment it is saved, and the status
 * the dashboard reads must never carry the key itself.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { describeGeminiKey, getGeminiKey } from './appSettings.js';

const TEST_ENCRYPTION_KEY = 'cd'.repeat(32);
const SAVED = 'AIza.fake.saved-on-operations.test';

let saved: { env?: string; enc?: string };
let original: typeof pool.query;

/** Answer the one app_settings read with `row` (or nothing), recording what was asked. */
function storeHolds(row: { value: string; is_secret: boolean } | null): string[] {
    const asked: string[] = [];
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        assert.match(sql, /FROM app_settings WHERE key = \$1/);
        asked.push(String(params[0]));
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    };
    return asked;
}

beforeEach(() => {
    saved = { env: process.env.GEMINI_API_KEY, enc: process.env.TOKEN_ENCRYPTION_KEY };
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    original = pool.query;
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original;
    for (const [name, value] of [['GEMINI_API_KEY', saved.env], ['TOKEN_ENCRYPTION_KEY', saved.enc]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('getGeminiKey', () => {
    it('answers with the saved key, decrypted, over GEMINI_API_KEY', async () => {
        process.env.GEMINI_API_KEY = 'AIza-the-environment-one';
        const asked = storeHolds({ value: encryptSecret(SAVED), is_secret: true });

        assert.deepEqual(await getGeminiKey(), { key: SAVED, source: 'database' });
        assert.deepEqual(asked, ['gemini.api_key']);
    });

    it('falls back to GEMINI_API_KEY, trimmed, while nothing is saved', async () => {
        process.env.GEMINI_API_KEY = '  AIza-the-environment-one \n';
        storeHolds(null);

        assert.deepEqual(await getGeminiKey(), { key: 'AIza-the-environment-one', source: 'env' });
    });

    it('is null when there is no key anywhere — a blank env var is not a key', async () => {
        for (const env of [undefined, '', '   ']) {
            if (env === undefined) delete process.env.GEMINI_API_KEY;
            else process.env.GEMINI_API_KEY = env;
            storeHolds(null);
            assert.equal(await getGeminiKey(), null, JSON.stringify(env));
        }
    });
});

describe('describeGeminiKey', () => {
    it('reports a saved key by a masked hint only', async () => {
        process.env.GEMINI_API_KEY = 'AIza-the-environment-one';
        storeHolds({ value: encryptSecret(SAVED), is_secret: true });

        const status = await describeGeminiKey();
        assert.equal(status.source, 'database');
        assert.equal(status.envFallback, true);
        assert.ok(status.preview && status.preview.startsWith('AIz') && status.preview.endsWith('st'));
        assert.ok(!JSON.stringify(status).includes(SAVED), 'the key itself must never be in the status');
        assert.ok(!JSON.stringify(status).includes('environment-one'), 'nor the env key');
    });

    it('reports the env key as present, and never previews it', async () => {
        process.env.GEMINI_API_KEY = 'AIza-the-environment-one';
        storeHolds(null);

        assert.deepEqual(await describeGeminiKey(), { source: 'env', preview: null, envFallback: true });
    });

    it('says when there is nothing to fall back to', async () => {
        delete process.env.GEMINI_API_KEY;
        storeHolds({ value: encryptSecret(SAVED), is_secret: true });
        assert.equal((await describeGeminiKey()).envFallback, false);

        storeHolds(null);
        assert.deepEqual(await describeGeminiKey(), { source: null, preview: null, envFallback: false });
    });
});
