/**
 * `issueInvite` and its helpers, moved out of `src/routes/admin.ts` unchanged (U3, contract §3.1) so the workspace owner's Team routes can make a
 * link the same way. What is pinned:
 *
 *   - **Nothing changed for the admin.** The default is `actor: 'admin'`: the same audit row (`invite.create`, facts and `via`, never the link), the same
 *     funnel event, the same answer. (`adminCreateTenant.test.ts` and `invites.test.ts` cover the routes through it; this is the function itself.)
 *   - **`opts.actor: 'tenant'`** changes one thing: the actor of the funnel's `invite_created` event. A reset link writes no event at all.
 *   - **The public address is resolved BEFORE the invite is written**, so a deployment that cannot build a link leaves no invite behind.
 *   - **The refusals the invite service throws** are answered as the status and body the dashboard reads (`answerInviteFailure`), and anything else is a 500.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import { setLogSink } from '../utils/log.js';
import { AUDIT_ACTIONS } from './audit.js';
import { InviteError } from './invites.js';
import { answerInviteFailure, inviteAuditDetail, issueInvite, requestOrigin, shareable } from './inviteIssue.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';

let db: FakeDb;
let settings: Record<string, string>;
let invites: Array<Record<string, any>>;
let audits: Array<{ action: string; targetType: string | null; targetId: string | null; detail: Record<string, any> }>;
let events: Array<{ creatorId: string; userId: string | null; actor: string; event: string }>;
let restoreSink: (() => void) | undefined;
const savedBase = process.env.PUBLIC_BASE_URL;

const req = (over: Record<string, unknown> = {}): Request => ({ headers: {}, protocol: 'https', session: { userId: ADMIN, role: 'platform_admin' }, ...over }) as unknown as Request;

beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    settings = { 'app.public_base_url': 'https://app.test' };
    invites = [];
    audits = [];
    events = [];
    const previous = setLogSink(() => undefined);
    restoreSink = () => setLogSink(previous);
    db = installFakeDb();
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (settings[key] === undefined ? { rows: [] } : { rows: [{ value: settings[key], is_secret: false }] })],
        [/^SELECT id, name, is_active FROM creators WHERE id = \$1$/, ([id]) => ({ rows: id === TENANT ? [{ id, name: 'The Knowledge Hub', is_active: true }] : [] })],
        [/^INSERT INTO invites \(token_hash,/, ([hash, creatorId, email, role, purpose, userId, createdBy, expiresAt]) => {
            const row = { id: `invite-${invites.length + 1}`, token_hash: hash, creator_id: creatorId, email, membership_role: role, purpose, user_id: userId, created_by: createdBy, created_at: new Date(), expires_at: expiresAt, first_opened_at: null, open_count: 0, used_at: null, revoked_at: null };
            invites.push(row);
            return { rows: [row] };
        }],
        [/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'admin@example.com' }] })],
        [/^INSERT INTO audit_log /, ([, , action, targetType, targetId, detail]) => { audits.push({ action, targetType, targetId, detail: JSON.parse(detail) }); return { rows: [{ id: 'audit-1' }] }; }],
        [/^INSERT INTO onboarding_events /, ([creatorId, userId, actor, event]) => { events.push({ creatorId, userId, actor, event }); return { rows: [] }; }],
    );
});

afterEach(() => {
    db.restore();
    restoreSink?.();
    if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = savedBase;
});

describe('issueInvite', () => {
    it('makes the link, stores only its hash, audits the facts and not the link, and answers the shareable invite', async () => {
        const out = await issueInvite(req(), { creatorId: TENANT, lang: 'en' }, { via: 'tenant_create' });
        assert.equal(invites.length, 1);
        assert.equal(out.id, 'invite-1');
        assert.equal(out.lang, 'en');
        assert.equal(out.creator_id, TENANT);
        assert.ok(out.url.startsWith('https://app.test/dashboard#/invite?t='));
        assert.ok(out.whatsapp_text.includes(out.url));
        const token = new URLSearchParams(out.url.slice(out.url.indexOf('?') + 1)).get('t')!;
        assert.equal(JSON.stringify(invites).includes(token), false, 'only the hash is stored');
        assert.equal(JSON.stringify(audits).includes(token), false, 'and the audit never holds the link');

        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, AUDIT_ACTIONS.inviteCreate);
        assert.equal(audits[0]!.targetType, 'invite');
        assert.equal(audits[0]!.targetId, 'invite-1');
        assert.deepEqual([audits[0]!.detail['tenant_id'], audits[0]!.detail['purpose'], audits[0]!.detail['language'], audits[0]!.detail['via']], [TENANT, 'join', 'en', 'tenant_create']);
    });

    it('defaults to the admin as the funnel\'s actor, and `actor: tenant` makes the workspace the actor (the Team screen)', async () => {
        await issueInvite(req(), { creatorId: TENANT, lang: 'ar' });
        await issueInvite(req({ session: { userId: ADMIN, role: 'user' } }), { creatorId: TENANT, lang: 'ar' }, { via: 'team' }, { actor: 'tenant' });
        await issueInvite(req(), { creatorId: TENANT, lang: 'ar' }, {}, {});
        assert.deepEqual(events.map((e) => [e.actor, e.event, e.creatorId, e.userId]), [
            ['admin', 'invite_created', TENANT, ADMIN], ['tenant', 'invite_created', TENANT, ADMIN], ['admin', 'invite_created', TENANT, ADMIN],
        ]);
        assert.equal(audits[1]!.detail['via'], 'team');
    });

    it('writes no funnel event for a reset link: a password reset is not onboarding', async () => {
        db.routes.unshift([/^SELECT u\.id, u\.email, u\.role/, () => ({ rows: [{ id: 'u1', email: 'Sara@Example.com', role: 'user', is_active: true, is_member: true, membership_role: 'operator' }] })]);
        const out = await issueInvite(req(), { creatorId: TENANT, purpose: 'reset', userId: 'u1', lang: 'en' }, { via: 'team' }, { actor: 'tenant' });
        assert.equal(out.purpose, 'reset');
        assert.deepEqual(events, []);
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.detail['for_user_id'], 'u1');
    });

    it('passes the role and the email to the invite: only that address can use the link', async () => {
        const out = await issueInvite(req(), { creatorId: TENANT, role: 'viewer', email: 'Mona@Company.Example', lang: 'ar' });
        assert.equal(out.role, 'viewer');
        assert.equal(out.email, 'mona@company.example');
        assert.equal(invites[0]!['email'], 'mona@company.example');
        assert.equal(audits[0]!.detail['membership_role'], 'viewer');
    });

    it('resolves the public address BEFORE it writes: with none, it refuses 500 PUBLIC_URL_UNKNOWN and leaves no invite, audit or event behind', async () => {
        settings = {};
        await assert.rejects(
            () => issueInvite(req(), { creatorId: TENANT, lang: 'ar' }),
            (err: unknown) => err instanceof InviteError && err.status === 500 && err.code === 'PUBLIC_URL_UNKNOWN',
        );
        assert.deepEqual([invites, audits, events], [[], [], []]);
    });

    it('falls back to the address the request arrived on, as the route always did', async () => {
        settings = {};
        const out = await issueInvite(req({ headers: { host: 'preview.example', 'x-forwarded-proto': 'https' } }), { creatorId: TENANT, lang: 'ar' });
        assert.ok(out.url.startsWith('https://preview.example/dashboard#/invite?t='));
    });

    it('refuses what the invite service refuses (an unknown workspace, a bad email) before anything is audited', async () => {
        await assert.rejects(() => issueInvite(req(), { creatorId: '99999999-9999-4999-8999-999999999999', lang: 'ar' }), (err: unknown) => err instanceof InviteError && err.code === 'TENANT_NOT_FOUND');
        await assert.rejects(() => issueInvite(req(), { creatorId: TENANT, email: 'nope', lang: 'ar' }), (err: unknown) => err instanceof InviteError && err.code === 'BAD_EMAIL');
        assert.deepEqual([invites, audits, events], [[], [], []]);
    });
});

describe('the helpers that moved with it', () => {
    function reply(): { res: Response; sent: { status: number; body: any } } {
        const sent = { status: 0, body: null as any };
        const res = { status(code: number) { sent.status = code; return this; }, json(payload: unknown) { sent.body = payload; return this; } } as unknown as Response;
        return { res, sent };
    }

    it('answerInviteFailure answers an InviteError as its status, sentence, code and extras, and anything else as a 500 that says what failed', () => {
        const a = reply();
        answerInviteFailure(a.res, new InviteError(409, 'TENANT_INACTIVE', 'This tenant is switched off.', { hint: 'x' }), 'e', 'Failed.');
        assert.deepEqual([a.sent.status, a.sent.body.code, a.sent.body.error, a.sent.body.hint], [409, 'TENANT_INACTIVE', 'This tenant is switched off.', 'x']);
        const b = reply();
        answerInviteFailure(b.res, new Error('boom'), 'admin.invite_create_failed', 'Failed to create the invite.');
        assert.deepEqual([b.sent.status, b.sent.body], [500, { error: 'Failed to create the invite.' }]);
    });

    it('a schema that is behind the code is named, not hidden behind "Failed"', () => {
        const c = reply();
        answerInviteFailure(c.res, Object.assign(new Error('relation "invites" does not exist'), { code: '42P01' }), 'e', 'Failed.');
        assert.equal(c.sent.status, 500);
        assert.equal(c.sent.body.migrationPending, true);
        assert.match(c.sent.body.error, /migration/i);
    });

    it('requestOrigin is the proto and host the request arrived on, or null with no host', () => {
        assert.equal(requestOrigin(req({ headers: { host: 'a.example', 'x-forwarded-proto': 'https, http' } })), 'https://a.example');
        assert.equal(requestOrigin(req({ headers: { host: 'a.example' }, protocol: 'http' })), 'http://a.example');
        assert.equal(requestOrigin(req()), null);
    });

    it('inviteAuditDetail is ids and facts, with the extras after them', () => {
        const detail = inviteAuditDetail({ creator_id: TENANT, purpose: 'join', role: 'owner', email: null, user_id: null, expires_at: '2026-12-05T00:00:00.000Z' } as never, { via: 'team' });
        assert.deepEqual(detail, { tenant_id: TENANT, purpose: 'join', membership_role: 'owner', email: null, for_user_id: null, expires_at: '2026-12-05T00:00:00.000Z', via: 'team' });
    });

    it('shareable puts the link in the fragment and the language on it', () => {
        const out = shareable({ invite: { id: 'i', purpose: 'join' } as never, token: 'T'.repeat(43), tenantName: 'Nour' }, 'https://app.test', 'en', { whatsappText: '', defaultRole: 'owner' } as never);
        assert.ok(out.url.startsWith('https://app.test/dashboard#/invite?t='));
        assert.ok(out.url.endsWith('&lang=en'));
        assert.equal(out.lang, 'en');
    });
});
