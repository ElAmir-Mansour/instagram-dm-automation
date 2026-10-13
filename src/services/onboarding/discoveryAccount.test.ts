/**
 * Which account the platform reads other people's Instagram with (03 §1): the tenant `onboarding.discovery_creator_id` names, else the
 * owner's. The token comes out of the creator row decrypted, and a missing connection is `not_configured`, not a crash.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { encryptSecret } from '../../config/crypto.js';
import { pool } from '../../config/db.js';
import { invalidateTenantCache } from '../tenant.js';
import { resolveDiscoveryAccount } from './discoveryAccount.js';
import { PLATFORM_IG_ID, PLATFORM_TOKEN } from './fixtures/instagram.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NAMED = '22222222-2222-4222-8222-222222222222';
const TEST_ENCRYPTION_KEY = 'ab'.repeat(32);

interface Db {
    setting?: string | null;
    creators: Record<string, { instagram_page_id: string | null; page_access_token: string | null }>;
}

let original: typeof pool.query;
let savedKey: string | undefined;
let asked: string[] = [];

function install(db: Db): void {
    asked = [];
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        if (/FROM app_settings WHERE key = \$1/.test(sql)) {
            asked.push(String(params[0]));
            return db.setting ? { rows: [{ value: db.setting, is_secret: false }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/FROM creators ORDER BY created_at, id LIMIT 1/.test(sql)) return { rows: [{ id: OWNER }], rowCount: 1 };
        if (/FROM creators WHERE id = \$1/.test(sql)) {
            asked.push(`creator:${params[0]}`);
            const row = db.creators[String(params[0])];
            return row ? { rows: [{ id: String(params[0]), ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected query: ${sql}`);
    };
}

beforeEach(() => {
    original = pool.query;
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    invalidateTenantCache();
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = original;
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    invalidateTenantCache();
});

describe('resolveDiscoveryAccount', () => {
    it('defaults to the owner\'s tenant, and decrypts the token as the app does', async () => {
        install({ creators: { [OWNER]: { instagram_page_id: PLATFORM_IG_ID, page_access_token: encryptSecret(PLATFORM_TOKEN) } } });
        const result = await resolveDiscoveryAccount();
        assert.ok(result.ok);
        assert.deepEqual(result.value, { creatorId: OWNER, igUserId: PLATFORM_IG_ID, token: PLATFORM_TOKEN });
        assert.ok(asked.includes('onboarding.discovery_creator_id'));
    });

    it('uses the tenant the setting names, not the owner', async () => {
        install({ setting: NAMED, creators: { [NAMED]: { instagram_page_id: '17841411111111111', page_access_token: encryptSecret('EAAJ-the-named-tenants-token-0123456789-abcdefghijklmnop') } } });
        const result = await resolveDiscoveryAccount();
        assert.ok(result.ok);
        assert.equal(result.value.creatorId, NAMED);
        assert.equal(result.value.igUserId, '17841411111111111');
        assert.ok(!asked.includes(`creator:${OWNER}`));
    });

    it('falls back to the owner when the setting is not a tenant id', async () => {
        install({ setting: 'not-a-uuid', creators: { [OWNER]: { instagram_page_id: PLATFORM_IG_ID, page_access_token: PLATFORM_TOKEN } } });
        const result = await resolveDiscoveryAccount();
        assert.ok(result.ok);
        assert.equal(result.value.creatorId, OWNER);
        assert.equal(result.value.token, PLATFORM_TOKEN, 'a token stored before encryption landed still works');
    });

    it('is `not_configured` when that tenant has no Instagram account or no token, or does not exist', async () => {
        for (const creators of [
            { [OWNER]: { instagram_page_id: null, page_access_token: null } },
            { [OWNER]: { instagram_page_id: PLATFORM_IG_ID, page_access_token: null } },
            { [OWNER]: { instagram_page_id: null, page_access_token: encryptSecret(PLATFORM_TOKEN) } },
            {},
        ] as Db['creators'][]) {
            install({ creators });
            invalidateTenantCache();
            const result = await resolveDiscoveryAccount();
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'not_configured');
            assert.equal(result.error.retryable, false);
            assert.equal(result.error.source, 'instagram_discovery');
        }
    });
});
