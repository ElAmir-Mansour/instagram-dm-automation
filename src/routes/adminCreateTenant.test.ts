/**
 * `POST /api/admin/tenants`: creating a tenant by name (P16, v34).
 *
 * What is pinned, because each is a way a second tenant could silently become the first one:
 *
 *   - the tenant is stored WITH a Creator Profile, version 1, the neutral `defaultProfile()` and never the one the owner's
 *     legacy settings describe (`profileFromLegacy` hard-sets his role, domain and pronouns), in the same transaction as its
 *     `creators` row, so there is never a tenant without one;
 *   - an Arabic tenant has the Studio's direction seeded `rtl`, an English one is left alone;
 *   - the `onboarding` row says `invited` (a tenant with no row reads as completed, D14);
 *   - its starter DM persona is in its own language;
 *   - the owner's rows are not touched, and nothing of the owner's is in any prompt the new tenant gets;
 *   - the legacy body (a page id and a token) still works and gets the same profile.
 *
 * Driven through the router with a plain request object, against the in-memory stand-in for the profile tables
 * (`profile/testDb.ts`) plus the three tables the route itself writes. Meta is a stubbed `axios.get`: there are live
 * credentials in `.env`, and nothing here may reach Meta.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { afterEach, before, after, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { starterPersona } from '../services/ai.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { getGrowthSettings } from '../services/growth/settings.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { entryText, NEUTRAL_TURN, tenantSurface } from '../services/profile/promptSurface.js';
import { NO_WOMEN_LINE } from '../services/monteur/editor.js';
import { loadStoredProfile } from '../services/profile/store.js';
import { installProfileDb, OWNER, type ProfileDb, seededState, type State, studioRow, USER, OWNER_STUDIO } from '../services/profile/testDb.js';
import { assertNoOwnerMarkers, throughJsonb } from '../services/profile/testSupport.js';
import { REQUIRED_SCOPES } from '../services/tokenHealth.js';
import { getStudioSettings } from '../services/studio/settings.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';

const NEW = '55555555-5555-4555-8555-555555555555';
const SESSION = { userId: USER, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };

interface Reply { status: number; body: any }

/** Call the router as Express would, with nothing mounted above it. */
function call(method: string, url: string, body: unknown, session: typeof SESSION | undefined = SESSION): Promise<Reply> {
    return new Promise((resolve) => {
        const req = { method: method.toUpperCase(), url, originalUrl: url, body, query: {}, params: {}, headers: {}, session } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        adminRouter(req, res, () => resolve({ status: 0, body: null }));
    });
}

const create = (body: unknown, session?: typeof SESSION) => call('POST', '/tenants', body, session);

// ─── The stand-in ────────────────────────────────────────────────────────────────────────────

let state: State;
let db: ProfileDb;
let settings: Record<string, string>;
let creators: Map<string, Record<string, unknown>>;
let onboarding: Map<string, { status: string }>;
let agents: Map<string, { is_active: boolean; system_prompt: string; knowledge_base: string }>;
let audits: { action: string; targetId: string | null; detail: Record<string, any> }[];
let logs: { event: string; fields: Record<string, unknown> }[];
let restoreSink: (() => void) | undefined;
let metaCalls: string[];
const originalAxiosGet = axios.get;
const savedKey = process.env.TOKEN_ENCRYPTION_KEY;

before(() => { process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); });
after(() => {
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

beforeEach(() => {
    state = seededState();
    db = installProfileDb(state);
    settings = {};
    creators = new Map();
    onboarding = new Map();
    agents = new Map();
    audits = [];
    logs = [];
    metaCalls = [];
    const previous = setLogSink((_level, line) => {
        const parsed = JSON.parse(line) as { event: string } & Record<string, unknown>;
        logs.push({ event: parsed.event, fields: parsed });
    });
    restoreSink = () => setLogSink(previous);

    // What the route writes besides the profile tables: rolled back with the transaction, as the database would.
    let snapshot: { creators: typeof creators; onboarding: typeof onboarding } | null = null;
    db.onStatement = (flat) => {
        if (flat === 'BEGIN') snapshot = { creators: structuredClone(creators), onboarding: structuredClone(onboarding) };
        else if (flat === 'ROLLBACK' && snapshot) { creators = snapshot.creators; onboarding = snapshot.onboarding; snapshot = null; }
        else if (flat === 'COMMIT') snapshot = null;
    };
    db.routes.push(
        [/^INSERT INTO creators /, ([name, ig, fb, token, verify, status, error, checkedAt, expiresAt, dataAt, username, website]) => {
            const row = {
                id: NEW, name, instagram_page_id: ig, facebook_page_id: fb, instagram_username: username, website_url: website,
                is_active: true, token_status: status, created_at: new Date('2026-10-14T10:00:00Z'),
            };
            creators.set(NEW, { ...row, page_access_token: token, webhook_verify_token: verify, token_error: error, token_last_checked_at: checkedAt, token_expires_at: expiresAt, token_data_access_expires_at: dataAt });
            return { rows: [row] };
        }],
        [/^INSERT INTO onboarding \(creator_id, status\) VALUES \(\$1, 'invited'\) ON CONFLICT \(creator_id\) DO NOTHING$/, ([id]) => {
            if (!onboarding.has(id)) onboarding.set(id, { status: 'invited' });
            return { rows: [] };
        }],
        // `seedApiBrain` (P32): the Monteur's brain, only where the row says nothing about it, as the SQL's own WHERE says.
        [/^UPDATE studio_settings SET monteur = COALESCE\(monteur, '\{\}'::jsonb\) \|\| jsonb_build_object\('brain', 'api'\)/, ([id]) => {
            const row = state.studio.get(id);
            const monteur = (row?.monteur ?? null) as Record<string, unknown> | null;
            if (!row || (monteur && monteur.brain != null)) return { rows: [], rowCount: 0 };
            row.monteur = { ...(monteur ?? {}), brain: 'api' };
            return { rows: [], rowCount: 1 };
        }],
        [/^INSERT INTO ai_agents /, ([id, persona]) => {
            if (!agents.has(id)) agents.set(id, { is_active: false, system_prompt: persona, knowledge_base: '' });
            return { rows: [] };
        }],
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (settings[key] === undefined ? { rows: [] } : { rows: [{ value: settings[key], is_secret: false }] })],
        [/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'operator@example.com' }] })],
        [/^INSERT INTO audit_log /, ([, , action, , targetId, detail]) => {
            audits.push({ action, targetId, detail: JSON.parse(detail) });
            return { rows: [{ id: 'audit-1' }] };
        }],
    );
    // Meta, for the legacy body only: a valid PAGE token with every scope.
    (axios as any).get = async (url: string) => {
        metaCalls.push(url);
        return { data: { data: { is_valid: true, type: 'PAGE', scopes: [...REQUIRED_SCOPES], expires_at: 0, data_access_expires_at: Math.floor(Date.now() / 1000) + 86_400 * 80 } } };
    };
});

afterEach(() => {
    db.restore();
    restoreSink?.();
    (axios as any).get = originalAxiosGet;
});

const storedProfile = (id = NEW) => state.profiles.get(id)!.profile as ReturnType<typeof defaultProfile>;
const insertedCreator = () => db.ran(/^INSERT INTO creators /)[0]!;

// ─── By name ─────────────────────────────────────────────────────────────────────────────────

describe('creating a tenant by name', () => {
    it('answers 201 with the tenant, no Meta connection, the language, the profile version and where onboarding stands', async () => {
        const reply = await create({ name: '  متجر نور  ', instagram_username: '@Nour.Shop', website: 'nour.example' });
        assert.equal(reply.status, 201);
        assert.deepEqual(reply.body, {
            id: NEW, name: 'متجر نور', instagram_page_id: null, facebook_page_id: null, instagram_username: 'nour.shop', website_url: 'https://nour.example/',
            is_active: true, token_status: 'unknown', created_at: new Date('2026-10-14T10:00:00Z'),
            language: 'ar', meta_connected: false, profile: { version: 1 }, onboarding: { status: 'invited' },
            // The invite link is made best-effort after the tenant is stored (src/routes/invites.test.ts covers it). This file's
            // stand-in has no `invites` table, so the tenant is made without one, and that is not an error.
            invite: null,
        });
    });

    it('stores the creator with NULL Meta columns and an unknown token status: it was never connected, so it is neither valid nor invalid', async () => {
        await create({ name: 'Nour', instagram_username: 'nour', website: 'https://nour.example' });
        const [name, ig, fb, token, verify, status, error, checkedAt, expiresAt, dataAt, username, website] = insertedCreator().params;
        assert.deepEqual([name, ig, fb, token, verify, status, error, checkedAt, expiresAt, dataAt], ['Nour', null, null, null, null, 'unknown', null, null, null, null]);
        assert.deepEqual([username, website], ['nour', 'https://nour.example/']);
        assert.deepEqual(metaCalls, [], 'Meta was not asked about anything');
    });

    it('stores a Creator Profile, version 1, in the same transaction: the neutral default, Arabic, with the default rule pre-ticked, from the admin', async () => {
        await create({ name: 'Nour' });
        assert.deepStrictEqual(storedProfile(), throughJsonb(defaultProfile({ lang: 'ar', rules: ['no_women_imagery'] })));
        const row = state.profiles.get(NEW)!;
        assert.equal(row.version, 1);
        assert.equal(row.activated_at, null, 'finishing the wizard activates a profile, not creating a tenant');
        assert.equal(row.updated_by, USER);
        assert.deepEqual(state.versions.map((v) => [v.creator_id, v.version, v.source, v.updated_by]), [[NEW, 1, 'admin', USER]]);
        assert.deepStrictEqual(state.versions[0]!.profile, storedProfile());
        // One transaction: the creator, the profile, its history, the mirror and the onboarding row between one BEGIN and one COMMIT.
        const sql = db.statements.map((s) => s.sql);
        const begin = sql.indexOf('BEGIN');
        const commit = sql.indexOf('COMMIT');
        const at = (pattern: RegExp) => sql.findIndex((s) => pattern.test(s));
        assert.ok(begin >= 0 && commit > begin);
        for (const step of [/^INSERT INTO creators /, /^INSERT INTO creator_profiles /, /^INSERT INTO creator_profile_versions /, /^INSERT INTO studio_settings /, /^INSERT INTO growth_settings /, /^INSERT INTO onboarding /]) {
            assert.ok(at(step) > begin && at(step) < commit, `${step} runs inside the transaction`);
        }
        assert.ok(at(/^INSERT INTO creators /) < at(/^INSERT INTO creator_profiles /), 'the profile follows the creator it belongs to');
        assert.equal(sql.filter((s) => s === 'BEGIN').length, 1);
    });

    it('is not what the owner\'s legacy settings describe: no role, no domain, no presenter, no he, none of his kind', async () => {
        await create({ name: 'Nour' });
        const profile = storedProfile();
        assert.equal(profile.identity.role, '');
        assert.equal(profile.identity.kind, null);
        assert.equal(profile.content.domain, 'general');
        assert.equal(profile.presenter, null);
        assert.deepEqual(profile.offers, []);
        assert.equal(profile.voice.guide, '');
        assert.deepEqual(profile.content.rules, ['no_women_imagery'], 'exactly onboarding.default_rules, pre-ticked and visible on W6 (D9)');
        assertNoOwnerMarkers(JSON.stringify(profile), 'the stored profile');
        assertNoOwnerMarkers(JSON.stringify(state.versions), 'its history');
    });

    it('seeds the Studio\'s direction rtl for an Arabic tenant, in the settings row, and the reader shows it', async () => {
        await create({ name: 'Nour' });
        assert.equal((state.studio.get(NEW)!.brand as { direction: string }).direction, 'rtl');
        assert.equal((await getStudioSettings(NEW)).brand.direction, 'rtl');
    });

    it('puts the new tenant\'s Monteur on the AI providers layer (monteur.brain api), inside the transaction, and leaves the owner\'s row exactly as it was', async () => {
        const ownerBefore = structuredClone(state.studio.get(OWNER));
        await create({ name: 'Nour' });
        assert.equal((state.studio.get(NEW)!.monteur as { brain: string }).brain, 'api');
        const settings = await getStudioSettings(NEW);
        assert.equal(settings.monteur.brain, 'api', 'and the reader shows it');
        assert.equal(settings.monteur.enabled, false, 'the Monteur itself stays off until the tenant turns it on');
        assert.deepEqual(state.studio.get(OWNER), ownerBefore, 'the owner\'s Studio row is untouched: his brain is his');
        const sql = db.statements.map((s) => s.sql);
        const seed = sql.findIndex((x) => /^UPDATE studio_settings SET monteur /.test(x));
        assert.ok(seed > sql.indexOf('BEGIN') && seed < sql.indexOf('COMMIT'), 'seeded in the creating transaction');
        assert.ok(seed > sql.findIndex((x) => /^INSERT INTO studio_settings /.test(x)), 'after its settings row exists');
        assert.deepEqual(db.statements[seed]!.params, [NEW], 'only for the new tenant');
    });

    it('leaves the Studio\'s direction alone for an English tenant, whose profile is English', async () => {
        const reply = await create({ name: 'Sami Fit', lang: 'en' });
        assert.equal(reply.status, 201);
        assert.equal(reply.body.language, 'en');
        assert.equal((state.studio.get(NEW)!.brand as { direction: string }).direction, 'ltr');
        const profile = storedProfile();
        assert.deepStrictEqual(profile, throughJsonb(defaultProfile({ lang: 'en', rules: ['no_women_imagery'] })));
        assert.deepEqual([profile.language.primary, profile.language.register, profile.language.digits, profile.brand.font_display], ['en', null, 'latin', 'Inter']);
    });

    it('mirrors the profile into the settings rows, so a reader finds no drift between them and the profile (the next write would only rewrite what is there)', async () => {
        await create({ name: 'Nour' });
        assert.ok(state.studio.has(NEW) && state.growth.has(NEW));
        await getStudioSettings(NEW);
        await getGrowthSettings(NEW);
        assert.deepEqual(logs.filter((l) => l.event === 'profile.row_drift'), []);
    });

    it('starts the tenant\'s DM agent switched OFF, with the starter persona in the tenant\'s language', async () => {
        await create({ name: 'Nour' });
        assert.deepEqual(agents.get(NEW), { is_active: false, system_prompt: starterPersona('ar'), knowledge_base: '' });
        agents.clear();
        await create({ name: 'Sami Fit', lang: 'en' });
        assert.equal(agents.get(NEW)!.system_prompt, starterPersona('en'));
        assert.match(agents.get(NEW)!.system_prompt, /in English/);
        assert.equal(agents.get(NEW)!.is_active, false);
    });

    it('inserts the onboarding row as invited: a tenant with no row reads as completed, which a new one is not', async () => {
        await create({ name: 'Nour' });
        assert.deepEqual(onboarding.get(NEW), { status: 'invited' });
    });

    it('reads onboarding.default_rules: an empty list is a deliberate "none", and a value it cannot read is the default', async () => {
        settings['onboarding.default_rules'] = '[]';
        await create({ name: 'Nour' });
        assert.deepEqual(storedProfile().content.rules, []);

        for (const bad of ['not json', '"no_women_imagery"', '["something_else"]', '{"a":1}']) {
            state.profiles.clear();
            state.versions.length = 0;
            creators.clear();
            settings['onboarding.default_rules'] = bad;
            await create({ name: 'Nour' });
            assert.deepEqual(storedProfile().content.rules, ['no_women_imagery'], bad);
        }
        assert.ok(logs.some((l) => l.event === 'onboarding.default_rules_unreadable'), 'a value it cannot read is logged');
    });

    it('audits what was made, as facts: how, in which language, which profile version, and that no credential was involved', async () => {
        await create({ name: 'Nour', instagram_username: 'nour' });
        const row = audits.find((a) => a.action === AUDIT_ACTIONS.tenantCreate)!;
        assert.equal(row.targetId, NEW);
        assert.deepEqual(row.detail, {
            name: 'Nour', instagram_page_id: null, facebook_page_id: null, credential_replaced: false, credential_type: null, missing_scopes: [],
            created_by_name: true, language: 'ar', profile_version: 1, instagram_username: 'nour', website_url: null,
        });
    });

    it('leaves the owner alone: his rows are what they were, he has no stored profile made for him, and no statement names him', async () => {
        const before = { studio: structuredClone(state.studio.get(OWNER)), growth: structuredClone(state.growth.get(OWNER)) };
        await create({ name: 'Nour' });
        assert.deepStrictEqual(state.studio.get(OWNER), before.studio);
        assert.deepStrictEqual(state.growth.get(OWNER), before.growth);
        assert.deepStrictEqual(state.studio.get(OWNER), studioRow(OWNER_STUDIO));
        assert.equal(state.profiles.has(OWNER), false);
        assert.equal(state.versions.some((v) => v.creator_id === OWNER), false);
        assert.deepEqual(db.statements.filter((s) => s.params.includes(OWNER)), [], 'nothing was written or locked for him');
    });

    it('does not change who the platform owner is: the first creator ever made stays first (tenant #2 is never the Mac\'s)', async () => {
        await create({ name: 'Nour' });
        // The route never asks which creator is the owner, and never writes the Mac-brain list.
        assert.deepEqual(db.ran(/studio\.mac_brain_tenants/), []);
        assert.deepEqual(db.statements.filter((s) => /app_settings/.test(s.sql) && /^(INSERT|UPDATE|DELETE)/.test(s.sql)), []);
    });
});

// ─── The invite link comes back with the tenant (P17) ────────────────────────────────────────

describe('creating a tenant by name hands back its invite link', () => {
    let invites: Array<Record<string, any>>;

    beforeEach(() => {
        invites = [];
        // This file's request has no Host header, so the public address comes from the setting, as it does in production.
        delete process.env.PUBLIC_BASE_URL;
        settings['app.public_base_url'] = 'https://app.test';
        db.routes.push(
            [/^SELECT id, name, is_active FROM creators WHERE id = \$1$/, ([id]) => ({ rows: creators.has(id) ? [{ id, name: creators.get(id)!.name, is_active: true }] : [] })],
            [/^INSERT INTO invites \(token_hash,/, ([hash, creatorId, email, role, purpose, userId, createdBy, expiresAt]) => {
                const row = { id: `invite-${invites.length + 1}`, token_hash: hash, creator_id: creatorId, email, membership_role: role, purpose, user_id: userId, created_by: createdBy, created_at: new Date(), expires_at: expiresAt, first_opened_at: null, open_count: 0, used_at: null, revoked_at: null };
                invites.push(row);
                return { rows: [row] };
            }],
        );
    });

    /** The `?t=` out of a link's fragment. */
    const tokenOf = (url: string): string => new URLSearchParams(new URL(url).hash.slice(new URL(url).hash.indexOf('?') + 1)).get('t')!;

    it('answers the link in the same 201: Copy and WhatsApp need no second request', async () => {
        const reply = await call('POST', '/tenants', { name: 'متجر نور', lang: 'ar' }, SESSION);
        assert.equal(reply.status, 201);
        const invite = reply.body.invite;
        assert.equal(invites.length, 1);
        assert.equal(invite.id, 'invite-1');
        assert.equal(invite.purpose, 'join');
        assert.equal(invite.role, 'owner');
        assert.equal(invite.lang, 'ar');
        assert.equal(invite.creator_id, NEW);
        assert.equal(invite.status, 'pending');
        const url = new URL(invite.url);
        assert.equal(url.origin, 'https://app.test');
        assert.equal(url.pathname, '/dashboard');
        assert.equal(url.search, '', 'the token is in the fragment');
        assert.ok(url.hash.startsWith('#/invite?t='));
        assert.ok(invite.whatsapp_text.includes('متجر نور') && invite.whatsapp_text.includes(invite.url));
        assert.equal(Math.round((new Date(invite.expires_at).getTime() - Date.now()) / 86_400_000), 7);
    });

    it('stores only the hash of that token', async () => {
        const reply = await call('POST', '/tenants', { name: 'Nour' }, SESSION);
        const token = tokenOf(reply.body.invite.url);
        assert.equal(invites[0]!.token_hash, createHash('sha256').update(token).digest('hex'));
        assert.equal(JSON.stringify(invites).includes(token), false);
        assert.equal(JSON.stringify(audits).includes(token), false);
        assert.equal(logs.some((l) => JSON.stringify(l).includes(token)), false);
    });

    it('writes the link for the language the tenant was made in', async () => {
        const reply = await call('POST', '/tenants', { name: 'Sami Fit', lang: 'en' }, SESSION);
        assert.ok(reply.body.invite.url.endsWith('&lang=en'));
        assert.match(reply.body.invite.whatsapp_text, /workspace/);
    });

    it('audits it as invite.create after tenant.create, with facts and no link', async () => {
        await call('POST', '/tenants', { name: 'Nour' }, SESSION);
        assert.deepEqual(audits.map((a) => a.action), [AUDIT_ACTIONS.tenantCreate, AUDIT_ACTIONS.inviteCreate]);
        const row = audits[1]!;
        assert.equal(row.targetId, 'invite-1');
        assert.deepEqual([row.detail.tenant_id, row.detail.purpose, row.detail.membership_role, row.detail.via, row.detail.language], [NEW, 'join', 'owner', 'tenant_create', 'ar']);
        assert.equal(JSON.stringify(row.detail).includes('#/invite'), false);
    });

    it('is made AFTER the tenant is stored, so a failing invite never undoes the tenant: it answers invite null', async () => {
        db.routes.unshift([/^INSERT INTO invites /, () => { throw new Error('the invites table is missing'); }]);
        const reply = await call('POST', '/tenants', { name: 'Nour' }, SESSION);
        assert.equal(reply.status, 201);
        assert.equal(reply.body.invite, null);
        assert.ok(creators.has(NEW), 'the tenant exists');
        assert.ok(state.profiles.has(NEW), 'and its profile');
        assert.ok(logs.some((l) => l.event === 'admin.tenant_invite_failed'));
        assert.deepEqual(audits.map((a) => a.action), [AUDIT_ACTIONS.tenantCreate]);
    });

    it('is not made for a tenant created with credentials: that is the operator\'s own, with nobody to invite', async () => {
        const reply = await call('POST', '/tenants', { name: 'Own', instagram_page_id: '17841400000000001', page_access_token: 'EAAGx'.repeat(8) }, SESSION);
        assert.equal(reply.status, 201);
        assert.equal(reply.body.invite, null);
        assert.equal(invites.length, 0);
    });

    it('uses the saved lifetime and role, and the operator\'s own message', async () => {
        settings['onboarding.invite_ttl_days'] = '3';
        settings['onboarding.default_role'] = 'operator';
        settings['onboarding.whatsapp_text'] = 'Welcome to {name}: {link}';
        const reply = await call('POST', '/tenants', { name: 'Nour' }, SESSION);
        assert.equal(reply.body.invite.role, 'operator');
        assert.equal(Math.round((new Date(reply.body.invite.expires_at).getTime() - Date.now()) / 86_400_000), 3);
        assert.equal(reply.body.invite.whatsapp_text, `Welcome to Nour: ${reply.body.invite.url}`);
    });
});

// ─── Nothing of the owner's reaches the new tenant ───────────────────────────────────────────

describe('a tenant created by name gets no owner markers in any surface', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`${lang}: every prompt and payload built for it, read through the real readers`, async () => {
            await create({ name: lang === 'ar' ? 'متجر نور' : 'Sami Fit', lang });
            // What the app reads for this tenant: the stored profile, and the settings its readers show through it.
            const profile = (await loadStoredProfile(NEW))!.profile;
            const studio = await getStudioSettings(NEW);
            const growth = await getGrowthSettings(NEW);
            const agent = { system_prompt: agents.get(NEW)!.system_prompt, knowledge_base: agents.get(NEW)!.knowledge_base };

            // The turn the builders are fed is neutral (`NEUTRAL_TURN`): the owner's story, captions and hashtags are what the goldens
            // were captured with, and a prompt that quotes them holds his markers whatever the builder says. With it there is nothing to
            // let through but the line of the preset the tenant ticked (P15 emptied the two ratchets that used to stand here: the
            // default call to action that named what is sold, and the owner's fixture turn).
            const entries = await tenantSurface({ studio, growth, agent, profile, turn: NEUTRAL_TURN });
            assert.ok(entries.length >= 31, `${entries.length} entries were built`);
            assert.deepEqual(entries.filter((e) => e.error !== undefined).map((e) => `${e.name}: ${e.error}`), [], 'every builder ran');
            assert.deepEqual(growth.keywords, [], 'the tenant\'s own keywords are none');

            for (const entry of entries) {
                const text = entryText(entry);
                // The tenant ticked the no-women rule (pre-ticked, D9), so the Editor says its line: the tenant's own choice, and the
                // only owner marker it may say. Said once per prompt, and nothing else of his.
                const ticked = entry.name.startsWith('monteur.editor-system.');
                if (ticked) assert.equal(text.split(NO_WOMEN_LINE).length - 1, 1, `${entry.name} says the ticked rule's line once`);
                assertNoOwnerMarkers(text, `${entry.name} (${lang})`, { except: ticked ? [NO_WOMEN_LINE] : [] });
            }
        });
    }

    it('an English tenant\'s DM wording is English: the starter persona, the disclosure and the instruction follow the tenant\'s language', async () => {
        await create({ name: 'Sami Fit', lang: 'en' });
        const profile = (await loadStoredProfile(NEW))!.profile;
        const entries = await tenantSurface({ studio: await getStudioSettings(NEW), growth: await getGrowthSettings(NEW), agent: { system_prompt: agents.get(NEW)!.system_prompt, knowledge_base: '' }, profile });
        const byName = new Map(entries.map((e) => [e.name, entryText(e)]));
        assert.equal(byName.get('dm.starter-persona'), starterPersona('en'));
        assert.equal(byName.get('dm.disclosure-line'), '🤖 Automated reply from the AI assistant');
        assert.doesNotMatch(byName.get('dm.system-instruction')!, /[؀-ۿ]/, 'no Arabic script in an English tenant\'s DM instruction');
    });

    it('the check is real: the same surface built for the OWNER\'s rows does hold his markers', async () => {
        const studio = await getStudioSettings(OWNER);
        const growth = await getGrowthSettings(OWNER);
        const entries = await tenantSurface({ studio, growth });
        const held = entries.filter((e) => {
            try { assertNoOwnerMarkers(entryText(e)); return false; } catch { return true; }
        });
        assert.ok(held.length >= 12, `${held.length} of the owner's entries carry his markers`);
    });
});

// ─── Validation: nothing is written for a body that is refused ───────────────────────────────

describe('a body that is refused writes nothing', () => {
    const nothingWritten = () => {
        assert.deepEqual(db.statements.filter((s) => /^(INSERT|UPDATE|DELETE|BEGIN)/.test(s.sql)), []);
        assert.equal(creators.size, 0);
    };

    for (const [why, body, error] of [
        ['no name', { lang: 'en' }, /name is required/],
        ['a blank name', { name: '   ' }, /name is required/],
        ['a language that is not ar or en', { name: 'x', lang: 'fr' }, /lang must be "ar" or "en"/],
        ['a handle that is not one', { name: 'x', instagram_username: 'not a handle!' }, /instagram_username/],
        ['a website that is not an address anyone could open', { name: 'x', website: 'http://127.0.0.1/admin' }, /website/],
        ['a language that is not ar or en, with a Meta connection', { name: 'x', lang: 'fr', instagram_page_id: '17841400000000000', page_access_token: 't' }, /lang must be "ar" or "en"/],
    ] as const) {
        it(`${why}: 400, and the database is not touched`, async () => {
            const reply = await create(body);
            assert.equal(reply.status, 400);
            assert.match(reply.body.error, error);
            nothingWritten();
        });
    }

    it('a page id without its token (the legacy rule) is still a 400, and Meta is not asked', async () => {
        const reply = await create({ name: 'x', instagram_page_id: '17841400000000000' });
        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /page_access_token is required/);
        assert.deepEqual(metaCalls, []);
        nothingWritten();
    });

    it('a non-admin session is a 404 whatever the body, and nothing is written', async () => {
        const reply = await create({ name: 'Nour' }, { ...SESSION, role: 'user' });
        assert.equal(reply.status, 404);
        nothingWritten();
    });
});

// ─── All or nothing ──────────────────────────────────────────────────────────────────────────

describe('a tenant is never left without its profile', () => {
    const rolledBack = () => {
        assert.equal(creators.size, 0, 'the creators row was rolled back');
        assert.equal(onboarding.size, 0);
        assert.equal(state.profiles.has(NEW), false);
        assert.deepEqual(state.versions, []);
        assert.equal(state.studio.has(NEW), false);
        assert.equal(state.growth.has(NEW), false);
        assert.equal(db.statements.at(-1)!.sql.startsWith('INSERT INTO audit_log') || db.statements.at(-1)!.sql === 'ROLLBACK', true);
        assert.deepEqual(audits, [], 'nothing was audited as created');
        assert.equal(agents.size, 0, 'no agent was seeded for a tenant that does not exist');
    };

    it('when the profile cannot be stored, the creator is rolled back with it, and the operator is told', async () => {
        db.failOn = /^INSERT INTO creator_profiles /;
        const reply = await create({ name: 'Nour' });
        assert.equal(reply.status, 500);
        rolledBack();
    });

    it('when its history cannot be written, the profile goes too', async () => {
        db.failOn = /^INSERT INTO creator_profile_versions /;
        assert.equal((await create({ name: 'Nour' })).status, 500);
        rolledBack();
    });

    it('when the mirror into the settings cannot be written, nothing stays', async () => {
        db.failOn = /^INSERT INTO studio_settings /;
        assert.equal((await create({ name: 'Nour' })).status, 500);
        rolledBack();
    });

    it('when the onboarding row cannot be written, nothing stays', async () => {
        db.failOn = /^INSERT INTO onboarding /;
        assert.equal((await create({ name: 'Nour' })).status, 500);
        rolledBack();
    });

    it('on a database without v33, the answer is the profile store\'s own 503, naming the migration, and no tenant exists', async () => {
        db.v33 = false;
        const reply = await create({ name: 'Nour' });
        assert.equal(reply.status, 503);
        assert.equal(reply.body.code, 'PROFILE_STORAGE_MISSING');
        assert.match(reply.body.error, /migration v33/);
        rolledBack();
    });

    it('on a database without v34, a tenant with no Meta ids hits the old NOT NULL: the answer names migration v34', async () => {
        db.routes.unshift([/^INSERT INTO creators /, () => {
            throw Object.assign(new Error('null value in column "instagram_page_id" of relation "creators" violates not-null constraint'), { code: '23502' });
        }]);
        const reply = await create({ name: 'Nour' });
        assert.equal(reply.status, 500);
        assert.equal(reply.body.migrationPending, true);
        assert.match(reply.body.error, /migration v34/);
        rolledBack();
    });

    it('a page id that another tenant holds is still a 409', async () => {
        db.routes.unshift([/^INSERT INTO creators /, () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); }]);
        const reply = await create({ name: 'x', instagram_page_id: '17841400000000000', page_access_token: 'tok' });
        assert.equal(reply.status, 409);
        assert.match(reply.body.error, /page id already exists/);
        rolledBack();
    });

    it('an agent that cannot be seeded does not undo the tenant: it is best-effort, as it always was', async () => {
        db.routes.unshift([/^INSERT INTO ai_agents /, () => { throw new Error('agent insert failed'); }]);
        const reply = await create({ name: 'Nour' });
        assert.equal(reply.status, 201);
        assert.ok(state.profiles.has(NEW));
        assert.ok(logs.some((l) => l.event === 'admin.tenant_agent_seed_failed'));
    });
});

// ─── The legacy body ─────────────────────────────────────────────────────────────────────────

describe('the legacy body (a page id and a token) still works, and gets the same profile', () => {
    const body = { name: 'Elharef', instagram_page_id: '17841400000000000', facebook_page_id: '100000000000001', page_access_token: 'EAAB-plain-token', webhook_verify_token: 'verify-token-123' };

    it('verifies the token with Meta, stores it encrypted, and connects the tenant', async () => {
        const reply = await create(body);
        assert.equal(reply.status, 201);
        assert.equal(reply.body.meta_connected, true);
        assert.equal(reply.body.instagram_page_id, '17841400000000000');
        assert.equal(reply.body.token_status, 'valid');
        assert.equal(metaCalls.length, 1, 'one debug_token call');
        const [name, ig, fb, token, verify, status] = insertedCreator().params;
        assert.deepEqual([name, ig, fb, verify, status], ['Elharef', '17841400000000000', '100000000000001', 'verify-token-123', 'valid']);
        assert.match(token, /^enc:v1:/, 'encrypted before it is stored');
        assert.doesNotMatch(JSON.stringify(db.statements), /EAAB-plain-token/, 'the plaintext token is in no statement');
        assert.doesNotMatch(JSON.stringify(audits), /EAAB-plain-token/);
        assert.equal(audits[0]!.detail.credential_replaced, true);
        assert.equal(audits[0]!.detail.created_by_name, false);
    });

    it('and still stores the neutral profile, the rtl seed and the invited onboarding row: a tenant is a tenant however it was made', async () => {
        await create(body);
        assert.deepStrictEqual(storedProfile(), throughJsonb(defaultProfile({ lang: 'ar', rules: ['no_women_imagery'] })));
        assert.equal((state.studio.get(NEW)!.brand as { direction: string }).direction, 'rtl');
        assert.deepEqual(onboarding.get(NEW), { status: 'invited' });
        assert.equal(agents.get(NEW)!.system_prompt, starterPersona('ar'));
    });

    it('takes the language from the body, like a tenant created by name', async () => {
        await create({ ...body, lang: 'en' });
        assert.equal(storedProfile().language.primary, 'en');
        assert.equal(agents.get(NEW)!.system_prompt, starterPersona('en'));
        assert.equal((state.studio.get(NEW)!.brand as { direction: string }).direction, 'ltr');
    });

    it('keeps the handle and the site too, when the form that sent the credentials carried them', async () => {
        const reply = await create({ ...body, instagram_username: '@Elharef.Store', website: 'elharef.example' });
        assert.equal(reply.status, 201);
        const params = insertedCreator().params;
        assert.deepEqual([params[10], params[11]], ['elharef.store', 'https://elharef.example/']);
        assert.deepEqual([reply.body.instagram_username, reply.body.website_url], ['elharef.store', 'https://elharef.example/']);
    });

    it('refuses a handle or a site it cannot read before Meta is asked, with the credentials as with a name', async () => {
        for (const extra of [{ instagram_username: 'not a handle!' }, { website: 'http://10.0.0.1/' }]) {
            const reply = await create({ ...body, ...extra });
            assert.equal(reply.status, 400, JSON.stringify(extra));
            assert.match(reply.body.error, /^(instagram_username|website)/);
        }
        assert.deepEqual(metaCalls, [], 'Meta was not asked');
        assert.deepEqual(db.statements.filter((s) => /^(INSERT|BEGIN)/.test(s.sql)), []);
    });

    it('a token Meta rejects creates nothing at all', async () => {
        (axios as any).get = async () => ({ data: { data: { is_valid: false, error: { message: 'expired' } } } });
        const reply = await create(body);
        assert.equal(reply.status, 400);
        assert.deepEqual(db.statements.filter((s) => /^(INSERT|BEGIN)/.test(s.sql)), []);
        assert.equal(state.profiles.size, 0);
    });
});

// ─── PATCH: a page id needs its token ────────────────────────────────────────────────────────

describe('PATCH /tenants/:id on a tenant with no Meta connection', () => {
    it('says what to send when the database refuses a page id without a token (creators_meta_ids_need_token)', async () => {
        db.routes.unshift([/^SELECT id, name FROM creators WHERE instagram_page_id/, () => ({ rows: [] })]);
        db.routes.unshift([/^UPDATE creators /, () => {
            throw Object.assign(new Error('new row for relation "creators" violates check constraint "creators_meta_ids_need_token"'), { code: '23514', constraint: 'creators_meta_ids_need_token' });
        }]);
        const reply = await call('PATCH', `/tenants/${NEW}`, { instagram_page_id: '17841400000000000' });
        assert.equal(reply.status, 400);
        assert.equal(reply.body.code, 'TOKEN_REQUIRED');
        assert.match(reply.body.error, /page_access_token together with the page id/);
    });
});
