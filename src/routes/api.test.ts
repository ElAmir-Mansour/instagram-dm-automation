/**
 * The CSV export's tenant binding.
 *
 * GET /api/interactions/export runs above the auth boundary — a browser navigation cannot
 * carry an Authorization header — so it has no session to read a tenant from. The tenant
 * therefore travels in the download token as `<tenantId>~<one-shot token>`, where the token is
 * minted over a path key containing that same tenant id.
 *
 * What these tests are actually for: proving that rewriting the tenant half of that string
 * does not hand you another tenant's interactions. That is the one place in this codebase
 * where a tenant id is taken from a URL.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { consumeDownloadToken, createDownloadToken } from '../middleware/auth.js';
import {
    exportScopeFor, formatPublishedIds, parseExportDownload, publishedPlatforms,
    unsupportedPlatformCombination,
} from './api.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** What the authenticated half of the export hands to the dashboard. */
function mintDownload(tenantId: string): string {
    return `${tenantId}~${createDownloadToken(exportScopeFor(tenantId))}`;
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

describe('export download binding', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('round-trips the tenant it was minted for', () => {
        const parsed = parseExportDownload(mintDownload(TENANT_A));

        assert.ok(parsed);
        assert.equal(parsed.tenantId, TENANT_A);
        assert.equal(consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)), true);
    });

    it('refuses a token whose tenant half was swapped for another tenant', () => {
        // The attack this exists to stop: log in as A, edit the id in the URL, export B.
        const token = mintDownload(TENANT_A).split('~')[1];
        const parsed = parseExportDownload(`${TENANT_B}~${token}`);

        assert.ok(parsed);
        assert.equal(parsed.tenantId, TENANT_B, 'the id is taken at face value...');
        assert.equal(
            consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)),
            false,
            '...but the signature was made over tenant A, so it no longer verifies'
        );
    });

    it('still burns after a single use', () => {
        const parsed = parseExportDownload(mintDownload(TENANT_A))!;

        assert.equal(consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)), true);
        assert.equal(consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)), false);
    });

    it('rejects anything that is not <uuid>~<token>', () => {
        for (const raw of [
            undefined, null, 42, {}, '',
            'no-separator',
            '~leading-separator',
            `${TENANT_A}~`,                 // no token
            `not-a-uuid~${'a'.repeat(10)}`, // tenant half must be a uuid
        ]) {
            assert.equal(parseExportDownload(raw), null, `input ${JSON.stringify(raw)}`);
        }
    });

    it('keeps the tenant inside the signed path key', () => {
        // If two tenants shared a scope string, either token would verify for both.
        assert.notEqual(exportScopeFor(TENANT_A), exportScopeFor(TENANT_B));
        assert.equal(exportScopeFor(TENANT_A).includes(TENANT_A), true);
    });
});

/**
 * The partial-publish bug, which is the one on this branch with a consequence that cannot be
 * undone: a duplicate post on a live Instagram or Facebook account.
 *
 * `platform: 'both'` publishes Facebook first. A Facebook success followed by an Instagram
 * failure used to throw away the Facebook post id and record the row as FAILED — so the post
 * was live, the dashboard said it was not, and editing the row (which flips FAILED back to
 * PENDING) republished it to Facebook a second time.
 */
describe('publishedPlatforms', () => {
    it('reads back both ids from the string the publisher writes', () => {
        assert.deepEqual(publishedPlatforms('FB:123 | IG:456'), { fb: '123', ig: '456' });
    });

    it('reads back a single-platform publish', () => {
        assert.deepEqual(publishedPlatforms('FB:123'), { fb: '123', ig: null });
        assert.deepEqual(publishedPlatforms('IG:456'), { fb: null, ig: '456' });
    });

    it('handles the Facebook composite id format', () => {
        // Facebook returns page-scoped ids as `<pageId>_<postId>`, which contains an
        // underscore and no space — the id must survive intact or the skip check misfires.
        assert.deepEqual(publishedPlatforms('FB:102938_5566'), { fb: '102938_5566', ig: null });
    });

    it('finds nothing in an empty or absent value, so a fresh post publishes normally', () => {
        for (const raw of [null, undefined, '', 42, {}, 'FAILED']) {
            assert.deepEqual(publishedPlatforms(raw), { fb: null, ig: null },
                `input ${JSON.stringify(raw)}`);
        }
    });

    it('does not mistake an id containing FB: for a platform marker', () => {
        // `IG:` must be matched at a boundary, not anywhere in the string.
        assert.deepEqual(publishedPlatforms('IG:abcFB:def'), { fb: null, ig: 'abcFB:def' });
    });
});

describe('formatPublishedIds', () => {
    it('round-trips through publishedPlatforms', () => {
        for (const [fb, ig] of [['1', '2'], ['1', null], [null, '2']] as [string | null, string | null][]) {
            assert.deepEqual(publishedPlatforms(formatPublishedIds(fb, ig)), { fb, ig });
        }
    });

    it('is empty when nothing was published', () => {
        assert.equal(formatPublishedIds(null, null), '');
    });
});

describe('unsupportedPlatformCombination', () => {
    it('rejects a story aimed at Facebook, where it silently cannot work', () => {
        // `publishFacebookPost` throws on 'story' — Page stories need /photo_stories and
        // /video_stories, which this service does not implement. On `both`, Facebook runs
        // first, so the throw means Instagram is never attempted even though it would have
        // worked. Caught at create time instead of once a day in a cron log.
        assert.ok(unsupportedPlatformCombination('facebook', 'story'));
        assert.ok(unsupportedPlatformCombination('both', 'story'));
    });

    it('allows an Instagram story, which is implemented', () => {
        assert.equal(unsupportedPlatformCombination('instagram', 'story'), null);
    });

    it('allows every other combination unchanged', () => {
        for (const platform of ['instagram', 'facebook', 'both']) {
            for (const postType of ['image', 'video', 'reel']) {
                assert.equal(unsupportedPlatformCombination(platform, postType), null,
                    `${platform}/${postType}`);
            }
        }
    });
});
