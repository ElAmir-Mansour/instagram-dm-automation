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
import { describeGeminiKey, getGeminiKey, getMediaStorageConfig } from './appSettings.js';

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

/**
 * Where media goes: Settings first, then SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, each half on
 * its own. A wrong answer here is silent — uploads just keep landing in the 500MB database — so
 * each rule is pinned.
 */
describe('getMediaStorageConfig', () => {
    const SAVED_URL = 'https://saved1234.supabase.co';
    const SAVED_KEY = 'sb_secret_saved-in-settings-0123456789';
    let savedEnv: { url?: string; key?: string };

    /** app_settings holding exactly these keys. */
    function settingsHold(rows: Record<string, string>): void {
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            assert.match(sql, /FROM app_settings WHERE key = \$1/);
            const key = String(params[0]);
            if (!(key in rows)) return { rows: [], rowCount: 0 };
            const secret = key === 'storage.supabase_service_key';
            return { rows: [{ value: secret ? encryptSecret(rows[key]!) : rows[key], is_secret: secret }], rowCount: 1 };
        };
    }

    beforeEach(() => {
        savedEnv = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    });
    afterEach(() => {
        for (const [name, value] of [['SUPABASE_URL', savedEnv.url], ['SUPABASE_SERVICE_ROLE_KEY', savedEnv.key]] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    it('answers with what Settings saved, decrypted, over the environment', async () => {
        process.env.SUPABASE_URL = 'https://env5678.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_from-the-environment-000000';
        settingsHold({ 'storage.supabase_url': SAVED_URL, 'storage.supabase_service_key': SAVED_KEY });

        assert.deepEqual(await getMediaStorageConfig(), {
            url: SAVED_URL, key: SAVED_KEY, source: { url: 'database', key: 'database' },
        });
    });

    it('falls back to the environment, trimmed and normalised to an origin, while nothing is saved', async () => {
        process.env.SUPABASE_URL = '  https://env5678.supabase.co/storage/v1/ \n';
        process.env.SUPABASE_SERVICE_ROLE_KEY = '  sb_secret_from-the-environment-000000 ';
        settingsHold({});

        assert.deepEqual(await getMediaStorageConfig(), {
            url: 'https://env5678.supabase.co', key: 'sb_secret_from-the-environment-000000', source: { url: 'env', key: 'env' },
        });
    });

    it('takes each half from wherever it is set', async () => {
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_from-the-environment-000000';
        settingsHold({ 'storage.supabase_url': SAVED_URL });

        assert.deepEqual(await getMediaStorageConfig(), {
            url: SAVED_URL, key: 'sb_secret_from-the-environment-000000', source: { url: 'database', key: 'env' },
        });
    });

    it('is null with half a config, a blank env var, or a URL that is not https', async () => {
        settingsHold({ 'storage.supabase_url': SAVED_URL });
        assert.equal(await getMediaStorageConfig(), null, 'no key anywhere');

        settingsHold({ 'storage.supabase_service_key': SAVED_KEY });
        process.env.SUPABASE_URL = '   ';
        assert.equal(await getMediaStorageConfig(), null, 'a blank env var is not a URL');

        process.env.SUPABASE_URL = 'http://env5678.supabase.co';
        assert.equal(await getMediaStorageConfig(), null, 'plain http is refused');
    });
});
