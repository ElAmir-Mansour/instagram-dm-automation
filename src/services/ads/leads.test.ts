/**
 * Lead ads (A10, tasks T174): the form rules, the lock, reading a lead by id, the 6-hourly catch-up, encryption at rest, the retention
 * sweep and the erasure hook. The database is the pool stand-in (`monteur/testDb.ts`, answering by statement) and the Graph is a stub
 * (`setLeadsGraphForTests`), so nothing here needs a database or the network.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decryptBytes, personKey } from '../../config/crypto.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { AdsGraphError } from './graph.js';
import {
    buildFormParams, catchUpLeads, CONSENT_KEY, consentOf, createLeadForm, fetchAndStoreLead,
    leadPersonKeysForHandle, leadsCsv, personKeysOf, purgeExpiredLeads, restrictedCategory, setLeadsGraphForTests, validateForm,
    type LeadsGraph, type LeadView,
} from './leads.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const PAGE = '200000000000001';
const PAGE_TOKEN = 'EAApageTokenForLeads0123456789';
const PRIVACY = 'https://autoreply.example/privacy';

const validForm = {
    name: 'دورة البرمجة',
    questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }, { type: 'PHONE' }],
    thankYou: { title: 'شكراً لك', body: 'سنرسل لك التفاصيل قريباً.', buttonText: 'زيارة الموقع', url: 'https://example.com/workshop' },
};

const SIGNOFF_ROW = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', creator_id: T1, scope: 'lead_ads', countries: ['EG'], recorded_by: null,
    recorded_at: new Date('2026-10-01T00:00:00Z'), note: 'counsel opinion', revoked_at: null,
};

let db: FakeDb;
let calls: Array<{ method: 'get' | 'create'; path: string; params: any; token: string }>;
let savedKey: string | undefined;

function stubGraph(answer: (method: 'get' | 'create', path: string, params: any) => any): void {
    const g: LeadsGraph = {
        get: async (path, params, token) => { calls.push({ method: 'get', path, params, token }); return answer('get', path, params); },
        create: async (path, params, token) => { calls.push({ method: 'create', path, params, token }); return answer('create', path, params); },
    };
    setLeadsGraphForTests(g);
}

/** Routes every lead test needs: the sign-off (or none), the tenant's Page, the settings. */
function tenantRoutes(opts: { signed?: boolean; settings?: string | null } = {}): void {
    const signed = opts.signed ?? true;
    db.routes.push(
        [/FROM ads_legal_signoffs WHERE creator_id = \$1 AND scope = \$2 AND revoked_at IS NULL/, () => ({ rows: signed ? [SIGNOFF_ROW] : [] })],
        [/FROM creators WHERE id = \$1/, () => ({ rows: [{ id: T1, facebook_page_id: PAGE, page_access_token: PAGE_TOKEN }] })],
        [/FROM creators WHERE is_active = true/, () => ({ rows: [{ id: T1, instagram_page_id: null, facebook_page_id: PAGE, page_access_token: PAGE_TOKEN }] })],
        [/FROM app_settings WHERE key = \$1/, (p) => ({ rows: String(p[0]).startsWith('ads.settings.') && opts.settings ? [{ value: opts.settings, is_secret: false }] : [] })],
    );
}

const throttle = () => new AdsGraphError('limited', null, 'throttle', new Date(Date.now() + 60_000), null, 400);
const refusal = (msg = 'Invalid parameter') => new AdsGraphError(`Meta ads: ${msg}`, null, 'other', null, null, 400);

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'c'.repeat(64);
    process.env.PUBLIC_BASE_URL = 'https://autoreply.example';
    db = installFakeDb();
    calls = [];
});
afterEach(() => {
    db.restore();
    setLeadsGraphForTests(null);
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    delete process.env.PUBLIC_BASE_URL;
});

describe('validateForm', () => {
    it('defaults to Arabic and to the site\'s privacy page, which every form carries', () => {
        const r = validateForm(validForm, PRIVACY);
        assert.ok(r.ok);
        assert.equal(r.form.locale, 'AR_AR');
        assert.equal(r.form.privacyUrl, PRIVACY);
    });

    it('refuses a privacy link that is not https, and a locale it does not know', () => {
        const a = validateForm({ ...validForm, privacyUrl: 'http://x.example/privacy' }, PRIVACY);
        assert.ok(!a.ok && a.field === 'privacyUrl');
        const b = validateForm({ ...validForm, locale: 'FR_FR' }, PRIVACY);
        assert.ok(!b.ok && b.field === 'locale');
    });

    it('refuses Meta\'s restricted question types (an allow-list)', () => {
        for (const type of ['DOB', 'NATIONAL_ID', 'MARITIAL_STATUS', 'ID_CPF', 'GENDER', 'whatever']) {
            const r = validateForm({ ...validForm, questions: [{ type }] }, PRIVACY);
            assert.ok(!r.ok && r.code === 'RESTRICTED_QUESTION', type);
        }
    });

    it('refuses a question of your own that asks for a restricted category, in Arabic and in English', () => {
        for (const label of ['What is your bank account number?', 'Any health conditions?', 'ما هو رقم الهوية الوطنية؟', 'ما ديانتك؟', 'هل لديك مرض مزمن؟']) {
            const r = validateForm({ ...validForm, questions: [{ type: 'CUSTOM', label }] }, PRIVACY);
            assert.ok(!r.ok && r.code === 'RESTRICTED_QUESTION', label);
        }
        for (const fine of ['ما مستواك في البرمجة؟', 'في أي مدينة تسكن؟', 'هل جرّبت تطبيقاً للتعلم؟', 'ما الجنسية؟', 'مكان الإقامة', 'هل الإجابة صحيحة؟', 'هل شاركت في حملة سابقة؟', 'Where do you trace your interest?']) {
            assert.equal(restrictedCategory(fine), null, fine);
        }
        const ok = validateForm({ ...validForm, questions: [{ type: 'CUSTOM', label: 'ما مستواك في البرمجة؟' }] }, PRIVACY);
        assert.ok(ok.ok);
        assert.match(ok.form.questions[0]!.key!, /^[a-z0-9_]{1,40}$/);
    });

    it('needs a thank-you screen with https links, and at most 5 questions of your own', () => {
        const a = validateForm({ ...validForm, thankYou: { ...validForm.thankYou, url: 'javascript:alert(1)' } }, PRIVACY);
        assert.ok(!a.ok && a.field === 'thankYou.url');
        const six = Array.from({ length: 6 }, (_, i) => ({ type: 'CUSTOM', label: `سؤال ${i}`, key: `q${i}` }));
        assert.ok(!validateForm({ ...validForm, questions: six }, PRIVACY).ok);
    });
});

describe('buildFormParams', () => {
    it('sends the privacy policy, the locale, the thank-you page and the consent question last', () => {
        const r = validateForm({ ...validForm, consentQuestion: true }, PRIVACY);
        assert.ok(r.ok);
        const p = buildFormParams(r.form) as any;
        assert.equal(p.locale, 'AR_AR');
        assert.deepEqual(p.privacy_policy, { url: PRIVACY, link_text: 'سياسة الخصوصية' });
        assert.equal(p.thank_you_page.button_type, 'VIEW_WEBSITE');
        assert.equal(p.thank_you_page.website_url, 'https://example.com/workshop');
        assert.deepEqual(p.questions.slice(0, 3), [{ type: 'FULL_NAME' }, { type: 'EMAIL' }, { type: 'PHONE' }]);
        const consent = p.questions.at(-1);
        assert.equal(consent.key, CONSENT_KEY);
        assert.deepEqual(consent.options.map((o: any) => o.key), ['yes', 'no']);
    });
});

describe('createLeadForm', () => {
    it('is LOCKED_LEGAL without a lead_ads sign-off: nothing written, nothing sent', async () => {
        tenantRoutes({ signed: false });
        stubGraph(() => ({ id: '1' }));
        const r = await createLeadForm(T1, validForm);
        assert.ok(!r.ok && r.code === 'LOCKED_LEGAL');
        assert.equal(calls.length, 0);
        assert.equal(db.ran(/INSERT INTO ads_lead_forms/).length, 0);
    });

    it('creates with ONE POST on the Page with the Page token, and the form becomes active', async () => {
        tenantRoutes();
        db.routes.push(
            [/INSERT INTO ads_lead_forms/, () => ({ rows: [{ id: 'f1' }] })],
            [/FROM ads_lead_forms f WHERE f.id = \$1/, () => ({ rows: [{ id: 'f1', meta_id: '777', page_id: PAGE, name: validForm.name, locale: 'AR_AR', status: 'active', origin: 'app', consent_question: false, questions: [], last_lead_seen_at: null, created_at: new Date(), error: null }] })],
        );
        stubGraph(() => ({ id: '777' }));
        const r = await createLeadForm(T1, { ...validForm, idempotencyKey: 'dialog-0001' });
        assert.ok(r.ok);
        assert.equal(r.form.status, 'active');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.path, `${PAGE}/leadgen_forms`);
        assert.equal(calls[0]!.token, PAGE_TOKEN);
        assert.equal(db.ran(/UPDATE ads_lead_forms SET meta_id = \$2, status = 'active'/)[0]!.params[1], '777');
    });

    it('a reused idempotency key returns the first form and never POSTs again', async () => {
        tenantRoutes();
        db.routes.push([/f.idempotency_key = \$2/, () => ({ rows: [{ id: 'f1', meta_id: '777', page_id: PAGE, name: 'x', locale: 'AR_AR', status: 'active', origin: 'app', consent_question: false, questions: [], last_lead_seen_at: null, created_at: new Date(), error: null }] })]);
        stubGraph(() => ({ id: 'second' }));
        const r = await createLeadForm(T1, { ...validForm, idempotencyKey: 'dialog-0001' });
        assert.ok(r.ok && r.form.id === 'f1');
        assert.equal(calls.length, 0);
    });

    it('Meta\'s refusal fails the form with Meta\'s sentence', async () => {
        tenantRoutes();
        db.routes.push([/INSERT INTO ads_lead_forms/, () => ({ rows: [{ id: 'f1' }] })]);
        stubGraph(() => { throw refusal('Privacy policy required'); });
        const r = await createLeadForm(T1, validForm);
        assert.ok(!r.ok && r.code === 'META_ERROR');
        assert.equal(db.ran(/SET status = 'failed'/).length, 1);
    });
});

describe('fetchAndStoreLead (the ads.lead job)', () => {
    const job = { leadgenId: '9001', pageId: PAGE, formId: '777', adId: '555', createdTime: 1_760_000_000 };
    const lead = {
        id: '9001', created_time: '2026-10-22T10:00:00+0000', ad_id: '555', form_id: '777',
        field_data: [
            { name: 'full_name', values: ['علي أحمد'] }, { name: 'email', values: ['Ali@Example.com'] },
            { name: 'phone_number', values: ['+20 101 234 5678'] }, { name: CONSENT_KEY, values: ['نعم'] },
        ],
    };

    it('reads GET /{leadgen_id} with the Page token and stores the answers ENCRYPTED, with erasure keys and consent', async () => {
        tenantRoutes();
        db.routes.push([/INSERT INTO ads_leads/, () => ({ rows: [{ id: 'l1' }] })]);
        stubGraph(() => lead);
        assert.equal(await fetchAndStoreLead(job, 'webhook'), 'stored');
        assert.equal(calls[0]!.path, '9001');
        assert.equal(calls[0]!.token, PAGE_TOKEN);
        assert.match(calls[0]!.params.fields, /field_data/);

        const insert = db.ran(/INSERT INTO ads_leads/)[0]!;
        const enc = insert.params[5] as Buffer;
        assert.ok(Buffer.isBuffer(enc));
        assert.equal(enc.includes(Buffer.from('ali@example.com')), false);
        assert.equal(enc.includes(Buffer.from('Ali@Example.com')), false);
        assert.deepEqual(JSON.parse(decryptBytes(enc))[1], { name: 'email', values: ['Ali@Example.com'] });
        assert.deepEqual(new Set(insert.params[6]), new Set([personKey('ali@example.com'), personKey('201012345678')]));
        assert.equal(insert.params[7], true, 'consent');
        // retain_until = created_time + 90 days (no setting saved)
        assert.equal((insert.params[8] as Date).toISOString(), new Date(Date.parse('2026-10-22T10:00:00Z') + 90 * 86_400_000).toISOString());
        assert.equal(insert.params[9], 'webhook');
        // No answer reaches a SQL parameter in plain text.
        for (const s of db.statements) assert.equal(JSON.stringify(s.params).includes('Example.com'), false);
    });

    it('a second delivery of the same lead is a duplicate', async () => {
        tenantRoutes();
        db.routes.push([/INSERT INTO ads_leads/, () => ({ rows: [] })]);
        stubGraph(() => lead);
        assert.equal(await fetchAndStoreLead(job, 'webhook'), 'duplicate');
    });

    it('a locked tenant: no Meta call, nothing stored', async () => {
        tenantRoutes({ signed: false });
        stubGraph(() => lead);
        assert.equal(await fetchAndStoreLead(job, 'webhook'), 'locked');
        assert.equal(calls.length, 0);
        assert.equal(db.ran(/INSERT INTO ads_leads/).length, 0);
    });

    it('a throttle is not retried and does not throw (the catch-up gets the lead)', async () => {
        tenantRoutes();
        stubGraph(() => { throw throttle(); });
        assert.equal(await fetchAndStoreLead(job, 'webhook'), 'throttled');
        assert.equal(calls.length, 1);
    });

    it('a Page nobody owns is dropped', async () => {
        stubGraph(() => lead);
        assert.equal(await fetchAndStoreLead(job, 'webhook'), 'no_tenant');
        assert.equal(calls.length, 0);
    });

    it('no answer from Meta throws, so the job retries', async () => {
        tenantRoutes();
        stubGraph(() => { throw new Error('socket hang up'); });
        await assert.rejects(fetchAndStoreLead(job, 'webhook'), /socket hang up/);
    });
});

describe('catchUpLeads (every 6 hours)', () => {
    function catchUpRoutes(lastSeen: Date | null, lastRun: string | null = null) {
        tenantRoutes();
        db.routes.unshift([/FROM app_settings WHERE key = \$1/, (p) => ({ rows: String(p[0]).startsWith('ads.leads_caught_up.') && lastRun ? [{ value: lastRun, is_secret: false }] : [] })]);
        db.routes.push(
            [/SELECT DISTINCT s.creator_id FROM ads_legal_signoffs/, () => ({ rows: [{ creator_id: T1 }] })],
            [/SELECT id, meta_id, last_lead_seen_at FROM ads_lead_forms/, () => ({ rows: [{ id: 'f1', meta_id: '777', last_lead_seen_at: lastSeen }] })],
            [/INSERT INTO ads_leads/, () => ({ rows: [{ id: 'l' }] })],
            [/subscribed_apps/, () => ({ rows: [] })],
        );
    }

    it('asks for leads created after the newest one seen, follows the paging, and stores them as catchup', async () => {
        const seen = new Date('2026-10-21T00:00:00Z');
        catchUpRoutes(seen);
        let page = 0;
        stubGraph((_m, path, params) => {
            if (path.endsWith('/leadgen_forms')) return { data: [{ id: '777', name: 'x', status: 'ACTIVE' }] };
            if (path === '777/leads') {
                page++;
                const filter = JSON.parse(params.filtering)[0];
                assert.deepEqual([filter.field, filter.operator], ['time_created', 'GREATER_THAN']);
                assert.equal(filter.value, Math.floor(seen.getTime() / 1000) - 600);
                if (page === 1) assert.equal(params.after, undefined); else assert.equal(params.after, 'CUR1');
                return page === 1
                    ? { data: [{ id: 'a', created_time: '2026-10-21T05:00:00+0000', field_data: [] }], paging: { cursors: { after: 'CUR1' }, next: 'https://graph/next' } }
                    : { data: [{ id: 'b', created_time: '2026-10-21T06:00:00+0000', field_data: [] }], paging: { cursors: { after: 'CUR2' } } };
            }
            return {};
        });
        const r = await catchUpLeads(new Date('2026-10-22T12:00:00Z'));
        assert.equal(page, 2);
        assert.equal(r.stored, 2);
        assert.ok(db.ran(/INSERT INTO ads_leads/).every(s => s.params[9] === 'catchup'));
    });

    it('runs at most every 6 hours per tenant', async () => {
        catchUpRoutes(null, '2026-10-22T10:00:00.000Z');
        stubGraph(() => ({ data: [] }));
        const r = await catchUpLeads(new Date('2026-10-22T12:00:00Z'));
        assert.equal(r.tenants, 0);
        assert.equal(calls.length, 0);
    });

    it('a throttle ends the tenant\'s run without throwing', async () => {
        catchUpRoutes(null);
        stubGraph(() => { throw throttle(); });
        const r = await catchUpLeads(new Date('2026-10-22T12:00:00Z'));
        assert.equal(r.throttled, 1);
        assert.equal(r.failed, 0);
    });
});

describe('purgeExpiredLeads (retention)', () => {
    it('nulls the answers and the erasure keys and sets purged_at, honouring a LOWERED retention', async () => {
        tenantRoutes({ settings: JSON.stringify({ leadRetentionDays: 30 }) });
        db.routes.push(
            [/SELECT DISTINCT creator_id FROM ads_leads WHERE purged_at IS NULL/, () => ({ rows: [{ creator_id: T1 }] })],
            [/UPDATE ads_leads SET answers_enc = NULL/, () => ({ rows: [], rowCount: 3 })],
        );
        const now = new Date('2026-10-22T00:00:00Z');
        assert.equal(await purgeExpiredLeads(now), 3);
        const s = db.ran(/UPDATE ads_leads SET answers_enc = NULL, person_keys = '\{\}', purged_at = \$2/)[0]!;
        assert.match(s.sql, /retain_until <= \$2 OR created_time <= \$3/);
        assert.equal((s.params[2] as Date).toISOString(), new Date(now.getTime() - 30 * 86_400_000).toISOString());
        assert.equal(db.ran(/DELETE FROM ads_leads/).length, 0, 'retention keeps a count-only row');
    });
});

describe('erasure', () => {
    it('finds a person by email or phone, never by an Instagram handle', () => {
        assert.deepEqual(leadPersonKeysForHandle('ALI@example.com '), [personKey('ali@example.com')]);
        assert.ok(leadPersonKeysForHandle('01012345678').includes(personKey('201012345678')));
        assert.ok(leadPersonKeysForHandle('+201012345678').includes(personKey('201012345678')));
        assert.deepEqual(leadPersonKeysForHandle('ali_ahmed'), []);
    });

    it('personKeysOf and consentOf read the answers', () => {
        const answers = [{ name: 'email', values: ['x@y.co'] }, { name: CONSENT_KEY, values: ['yes'] }];
        assert.deepEqual(personKeysOf(answers), [personKey('x@y.co')]);
        assert.equal(consentOf(answers), true);
        assert.equal(consentOf([{ name: CONSENT_KEY, values: ['لا'] }]), false);
    });
});

describe('leadsCsv', () => {
    const base: LeadView = { id: '1', createdTime: '2026-10-22T10:00:00.000Z', formId: 'f', formName: 'نموذج', adId: '555', answers: null, consentContact: false, handedTo: 'none', purged: false, retainUntil: '2027-01-20T10:00:00.000Z' };

    it('starts with a BOM, quotes every cell, and defuses formulas', () => {
        const csv = leadsCsv([
            { ...base, answers: [{ name: 'full_name', values: ['=HYPERLINK("x")'] }, { name: 'email', values: ['a"b@x.co'] }], consentContact: true },
            { ...base, id: '2', purged: true },
        ]);
        assert.ok(csv.startsWith('﻿'));
        const [header, first, second] = csv.slice(1).trim().split('\r\n');
        assert.equal(header, '"created_time","form","ad_id","consent_contact","full_name","email"');
        assert.match(first!, /"'=HYPERLINK\(""x""\)"/);
        assert.match(first!, /"a""b@x.co"/);
        assert.match(first!, /"yes"/);
        assert.match(second!, /,"",""$/, 'a purged lead has empty answer cells');
    });
});

describe('the AI never proposes lead ads', () => {
    it('the proposals schema offers no leads goal', async () => {
        const { GOALS } = await import('./proposals/schema.js');
        assert.equal((GOALS as readonly string[]).includes('leads'), false);
    });

    it('leads.ts imports no AI module', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('./leads.ts', import.meta.url), 'utf8');
        assert.doesNotMatch(src, /from '[^']*(ai|aiProviders|llm|macBrain|gemini|proposals)[^']*'/i);
    });
});
