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
import { setLogSink } from '../utils/log.js';
import {
    APP_SETTING_KEYS, DEFAULT_ONBOARDING_RULES, describeGeminiKey, getGeminiKey, getMediaStorageConfig, getMetaLoginSettings, getOnboardingDefaultRules, getYouTubeApiKey,
    isSecretSetting, META_CONFIG_ID_PATTERN, parseOnboardingRules,
} from './appSettings.js';

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

describe('onboarding.default_rules: the content rules a tenant created by the operator starts with (D9)', () => {
    it('is the no-women rule when nothing is saved, and asks for exactly that key', async () => {
        const asked = storeHolds(null);
        assert.deepEqual(await getOnboardingDefaultRules(), ['no_women_imagery']);
        assert.deepEqual(asked, ['onboarding.default_rules']);
        assert.deepEqual([...DEFAULT_ONBOARDING_RULES], ['no_women_imagery']);
    });

    it('takes what is saved: a rule, no repeats, or an empty list that means "none" and not "the default"', async () => {
        storeHolds({ value: '["no_women_imagery","no_women_imagery"]', is_secret: false });
        assert.deepEqual(await getOnboardingDefaultRules(), ['no_women_imagery']);
        storeHolds({ value: '[]', is_secret: false });
        assert.deepEqual(await getOnboardingDefaultRules(), []);
    });

    it('falls back to the default, loudly, for a value it cannot read: a typo must not silently drop the pre-ticked rule', async () => {
        const lines: string[] = [];
        const previous = setLogSink((_level, line) => lines.push(line));
        try {
            for (const bad of ['not json', '"no_women_imagery"', '{"a":1}', '["no_women_imagery","something_else"]', '[1]']) {
                storeHolds({ value: bad, is_secret: false });
                assert.deepEqual(await getOnboardingDefaultRules(), ['no_women_imagery'], bad);
            }
        } finally {
            setLogSink(previous);
        }
        assert.equal(lines.filter((l) => l.includes('onboarding.default_rules_unreadable')).length, 5);
    });

    it('hands out a copy: a caller that edits its rules does not edit the default', async () => {
        storeHolds(null);
        const rules = await getOnboardingDefaultRules();
        rules.push('no_women_imagery');
        assert.deepEqual(await getOnboardingDefaultRules(), ['no_women_imagery']);
        assert.deepEqual([...DEFAULT_ONBOARDING_RULES], ['no_women_imagery']);
    });

    it('parseOnboardingRules is null for anything that is not a list of known presets', () => {
        assert.deepEqual(parseOnboardingRules('[]'), []);
        assert.deepEqual(parseOnboardingRules('["no_women_imagery"]'), ['no_women_imagery']);
        for (const raw of ['', 'x', 'null', '7', '{}', '["x"]', '[null]']) assert.equal(parseOnboardingRules(raw), null, raw);
    });
});

/**
 * The API key that reads public YouTube data for the onboarding draft (03 §1). It is a secret: stored encrypted, never shown. With
 * none saved the YouTube source is skipped, so "none" must be an answer and not an error.
 */
describe('getYouTubeApiKey', () => {
    const SAVED_KEY = 'AIzaSyD-saved-in-settings-0123456789abcdefghij';
    let savedEnv: string | undefined;
    beforeEach(() => { savedEnv = process.env.YOUTUBE_API_KEY; });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.YOUTUBE_API_KEY;
        else process.env.YOUTUBE_API_KEY = savedEnv;
    });

    it('is a secret setting, under its own name', () => {
        assert.equal(APP_SETTING_KEYS.youtubeApiKey, 'youtube.api_key');
        assert.equal(isSecretSetting(APP_SETTING_KEYS.youtubeApiKey), true);
    });

    it('answers with the saved key, decrypted, over YOUTUBE_API_KEY', async () => {
        process.env.YOUTUBE_API_KEY = 'AIza-the-environment-one';
        const asked = storeHolds({ value: encryptSecret(SAVED_KEY), is_secret: true });
        assert.deepEqual(await getYouTubeApiKey(), { key: SAVED_KEY, source: 'database' });
        assert.deepEqual(asked, ['youtube.api_key']);
    });

    it('falls back to YOUTUBE_API_KEY, trimmed, while nothing is saved', async () => {
        process.env.YOUTUBE_API_KEY = '  AIza-the-environment-one \n';
        storeHolds(null);
        assert.deepEqual(await getYouTubeApiKey(), { key: 'AIza-the-environment-one', source: 'env' });
    });

    it('is null when there is no key anywhere, and a blank env var is not a key', async () => {
        for (const env of [undefined, '', '   ']) {
            if (env === undefined) delete process.env.YOUTUBE_API_KEY;
            else process.env.YOUTUBE_API_KEY = env;
            storeHolds(null);
            assert.equal(await getYouTubeApiKey(), null, JSON.stringify(env));
        }
    });
});

describe('the discovery account setting', () => {
    it('is named as docs/onboarding/02 says, and is not a secret: it is a tenant id', () => {
        assert.equal(APP_SETTING_KEYS.onboardingDiscoveryCreatorId, 'onboarding.discovery_creator_id');
        assert.equal(isSecretSetting(APP_SETTING_KEYS.onboardingDiscoveryCreatorId), false);
    });
});


describe('the Meta login settings (P26)', () => {
    /** Answer `app_settings` reads from a map of plain values. */
    function settingsHold(values: Record<string, string>): void {
        (pool as unknown as { query: unknown }).query = async (_sql: string, params: unknown[] = []) => {
            const value = values[String(params[0])];
            return { rows: value === undefined ? [] : [{ value, is_secret: false }], rowCount: value === undefined ? 0 : 1 };
        };
    }
    let envBefore: string | undefined;
    beforeEach(() => { envBefore = process.env.META_LOGIN_CONFIG_ID; delete process.env.META_LOGIN_CONFIG_ID; });
    afterEach(() => {
        if (envBefore === undefined) delete process.env.META_LOGIN_CONFIG_ID;
        else process.env.META_LOGIN_CONFIG_ID = envBefore;
    });

    it('are two keys, neither of them a secret: the switch and the configuration id', () => {
        assert.equal(APP_SETTING_KEYS.metaLoginEnabled, 'meta.login_enabled');
        assert.equal(APP_SETTING_KEYS.metaLoginConfigId, 'meta.login_config_id');
        assert.equal(isSecretSetting(APP_SETTING_KEYS.metaLoginEnabled), false);
        assert.equal(isSecretSetting(APP_SETTING_KEYS.metaLoginConfigId), false);
    });

    it('are OFF by default: nothing saved means a tenant cannot start a connection', async () => {
        settingsHold({});
        assert.deepEqual(await getMetaLoginSettings(), { enabled: false, configId: null, configIdSource: null, adsScopesEnabled: false });
    });

    it('turn on only for the exact value "true"', async () => {
        for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
            settingsHold({ 'meta.login_enabled': value });
            assert.equal((await getMetaLoginSettings()).enabled, false, JSON.stringify(value));
        }
        settingsHold({ 'meta.login_enabled': 'true' });
        assert.equal((await getMetaLoginSettings()).enabled, true);
    });

    it('read the configuration id from the database first, then META_LOGIN_CONFIG_ID, and say which', async () => {
        process.env.META_LOGIN_CONFIG_ID = '111111111111111';
        settingsHold({});
        assert.deepEqual(await getMetaLoginSettings(), { enabled: false, configId: '111111111111111', configIdSource: 'env', adsScopesEnabled: false });
        settingsHold({ 'meta.login_config_id': '222222222222222' });
        assert.deepEqual(await getMetaLoginSettings(), { enabled: false, configId: '222222222222222', configIdSource: 'database', adsScopesEnabled: false });
    });

    it('ignore a configuration id that is not one, with a log line, instead of sending it to Meta', async () => {
        const lines: string[] = [];
        const previous = setLogSink((_level, line) => { lines.push(line); });
        try {
            settingsHold({ 'meta.login_config_id': 'not-a-number' });
            assert.deepEqual(await getMetaLoginSettings(), { enabled: false, configId: null, configIdSource: null, adsScopesEnabled: false });
            assert.ok(lines.some((l) => /meta\.login_config_id_unreadable/.test(l)));
        } finally {
            setLogSink(previous);
        }
    });

    it('accept a configuration id of 6 to 30 digits and nothing else', () => {
        for (const ok of ['123456', '987654321098765', '1'.repeat(30)]) assert.ok(META_CONFIG_ID_PATTERN.test(ok), ok);
        for (const bad of ['', '12345', '1'.repeat(31), 'abc123456', '123 456', '123456\n', '-123456']) assert.equal(META_CONFIG_ID_PATTERN.test(bad), false, JSON.stringify(bad));
    });
});
