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
import { exportScopeFor, parseExportDownload } from './api.js';

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
