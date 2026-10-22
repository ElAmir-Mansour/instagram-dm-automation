/**
 * The builder's routes (Meta Ads Manager A4, tasks T089): `POST /api/ads/policy`, `POST /api/ads/drafts/validate`, `POST /api/ads/drafts` and
 * Boost's "Send messages" preset, through the whole router as Express calls it.
 *
 * What is pinned:
 *   - /policy answers the policy check and calls nobody;
 *   - /drafts/validate answers the policy findings (on the post's caption as STORED), the money rule, Meta's `validate_only` on the campaign
 *     and the creative (and nothing created), the minimum budget, and the state of the assistant behind each destination;
 *   - /drafts refuses POLICY_BLOCKED with the findings, and unread warnings; otherwise it writes the stored copy and a chain of create ops,
 *     campaign → ad set → creative → ad, each depending on the one before, with the ids it needs as `{op:<id>}` placeholders, every object
 *     PAUSED, and runs the chain inline under `waitUntil` (Meta is not called in the request);
 *   - roles: validate is the operator's, create the owner's.
 *
 * The database, Meta and `waitUntil` are A2's kit (src/services/ads/testing/objects/testDb.ts), with the tables A4 reads added here.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { metaHttp } from '../services/http.js';
import { forgetMinimums } from '../services/ads/drafts.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { ACC, TENANT, installObjectsKit, type ObjectsKit } from '../services/ads/testing/objects/testDb.js';
import { adsRouter } from './ads.js';

type Role = 'viewer' | 'operator' | 'owner';

interface FakeRes { statusCode: number; body: any; status(code: number): FakeRes; json(payload: unknown): FakeRes; setHeader(): void; getHeader(): undefined }

async function call(method: string, url: string, opts: { role?: Role; body?: unknown } = {}): Promise<FakeRes> {
    return new Promise((resolve, reject) => {
        const res: FakeRes = {
            statusCode: 200, body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; resolve(this); return this; },
            setHeader() {}, getHeader() { return undefined; },
        };
        const req = {
            method, url, originalUrl: `/api/ads${url}`, baseUrl: '', path: url, headers: {}, params: {}, query: {}, body: opts.body ?? {},
            session: { userId: 'u1', role: 'user', tenantId: TENANT }, tenantRole: opts.role ?? 'owner',
        };
        (adsRouter as any)(req, res, (err?: unknown) => (err ? reject(err) : resolve({ ...res, statusCode: 404, body: { error: 'no route' } })));
    });
}

const POST_ID = '33333333-3333-4333-8333-333333333333';
const PAGE = '1001';
const IG_USER = '1784';

/** A quick-mode spec: one Instagram reel, a message ad to Instagram, 5 a day for 3 days in SA. */
function spec(over: Record<string, unknown> = {}, ad: Record<string, unknown> = {}): Record<string, unknown> {
    const start = new Date(Date.now() + 60_000);
    const end = new Date(start.getTime() + 3 * 86_400_000);
    return {
        name: 'Boost reel', goal: 'messages', destinations: ['instagram'], specialCategory: 'none',
        budget: { home: 'adset', kind: 'lifetime', amount: 15, start: start.toISOString(), end: end.toISOString() },
        adsets: [{ name: 'SA', targeting: { countries: ['SA'], ageMin: 18, advantageAudience: true }, placements: 'automatic' }],
        ads: [{
            adsetIndex: 0, name: 'Reel', creative: { source: 'post', postId: POST_ID, platform: 'instagram' }, copy: { primaryText: '' },
            message: { greeting: 'مرحبًا! كيف يمكننا مساعدتك؟', iceBreakers: [{ title: 'ما محتوى الدورة؟' }] }, ...ad,
        }],
        ...over,
    };
}

interface Posted { url: string; body: Record<string, string> }

describe('/api/ads policy, drafts/validate and drafts (A4)', () => {
    let kit: ObjectsKit;
    let posted: Posted[];
    let caption: string;
    let assistant: Record<string, unknown> | null;
    let inserted: Array<{ level: string; parent: string | null; status: string; appMeta: Record<string, unknown> }>;
    let metaRefuses: ((url: string) => unknown) | null;
    const original = { post: metaHttp.post };

    beforeEach(() => {
        kit = installObjectsKit();
        kit.configure({ maxDailyBudget: 20, monthlyCap: 100 });
        invalidateTenantCache();
        forgetMinimums();
        posted = [];
        caption = 'تعلّم بناء وكلاء الذكاء الاصطناعي خطوة بخطوة';
        assistant = { is_active: true, sales_mode: 'on', sales_test_senders: [] };
        inserted = [];
        metaRefuses = null;
        let n = 0;
        kit.db.on(/FROM creators WHERE id = \$1/, () => ({ rows: [{ id: TENANT, instagram_page_id: IG_USER, facebook_page_id: PAGE }] }));
        kit.db.on(/FROM scheduled_posts WHERE id = \$1 AND creator_id = \$2/, (p) => ({
            rows: p[0] === POST_ID && p[1] === TENANT ? [{ status: 'PUBLISHED', published_post_id: `FB:99 | IG:17890`, caption }] : [],
        }));
        kit.db.on(/FROM ai_agents WHERE creator_id = \$1/, (_p, sql) => ({ rows: sql.includes('whatsapp_mode') ? [] : assistant ? [assistant] : [] }));
        kit.db.on(/FROM platform_connections WHERE creator_id = \$1 AND platform = 'whatsapp'/, () => ({ rows: [] }));
        kit.db.on(/^INSERT INTO ads_objects/, (p) => {
            const id = `b0000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
            inserted.push({ level: p[2], parent: p[3], status: 'PAUSED', appMeta: JSON.parse(p[14]) });
            return { rows: [{ id }] };
        });
        (metaHttp as any).post = async (url: string, form: URLSearchParams) => {
            const body = Object.fromEntries(new URLSearchParams(String(form ?? '')));
            posted.push({ url, body });
            kit.meta.push({ method: 'POST', url });
            if (metaRefuses) {
                const err = metaRefuses(url);
                if (err) throw err;
            }
            return { data: { success: true }, headers: {} };
        };
    });
    afterEach(() => { (metaHttp as any).post = original.post; kit.restore(); });

    describe('POST /policy', () => {
        it('answers the check for the fields it is given and calls nobody', async () => {
            const res = await call('POST', '/policy', { role: 'operator', body: { fields: { greeting: 'اكسب 500$ يومياً', caption: 'Learn Go step by step' } } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.equal(res.body.blocked, true);
            assert.deepEqual(res.body.findings.map((f: any) => [f.field, f.ruleId, f.match]), [['greeting', 'income_figure', 'اكسب 500$ يومياً']]);
            assert.equal(kit.meta.length, 0);
        });

        it('refuses a body that is not an object of short texts, and a viewer', async () => {
            assert.equal((await call('POST', '/policy', { body: { fields: 'x' } })).statusCode, 400);
            assert.equal((await call('POST', '/policy', { body: { fields: { a: 'x'.repeat(5001) } } })).statusCode, 400);
            assert.equal((await call('POST', '/policy', { role: 'viewer', body: { fields: { a: 'x' } } })).statusCode, 403);
        });
    });

    describe('POST /drafts/validate', () => {
        it('answers policy, money, Meta\'s validate_only (campaign and creative), the minimum budget and the bots; it creates nothing', async () => {
            const res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec: spec() } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            const a = res.body;
            assert.deepEqual(a.policy.findings, []);
            assert.equal(a.problems.length, 0, JSON.stringify(a.problems));
            assert.equal(a.money.candidate, 'lifetime:15:3');
            assert.equal(typeof a.money.fits, 'boolean');
            assert.equal(a.meta.ok, true, JSON.stringify(a.meta));
            assert.ok('minimumBudget' in a.meta);
            assert.deepEqual(a.bots, [{ destination: 'instagram', state: 'on' }]);
            // Meta was asked to validate, with validate_only, and only the campaign and the creative.
            assert.deepEqual(posted.map((p) => p.url.replace(/^.*\/v\d+\.\d+\//, '')), [`act_${ACC}/campaigns`, `act_${ACC}/adcreatives`]);
            for (const p of posted) assert.equal(p.body['execution_options'], '["validate_only"]');
            assert.equal(posted[0]!.body['status'], 'PAUSED');
            const creative = posted[1]!.body;
            assert.equal(creative['source_instagram_media_id'], '17890');
            assert.match(creative['call_to_action'] ?? '', /INSTAGRAM_MESSAGE/);
            assert.equal(kit.ops.length, 0);
            assert.equal(inserted.length, 0);
        });

        it('reads the caption from the database: a blocked caption is reported, and Meta is not asked', async () => {
            caption = 'اكسب 500$ يومياً من البيت';
            const res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec: spec() } });
            assert.equal(res.body.policy.blocked, true);
            assert.deepEqual(res.body.policy.findings.map((f: any) => [f.field, f.ruleId]), [['caption', 'income_figure']]);
            assert.equal(res.body.meta.ok, false);
            assert.equal(posted.length, 0);
        });

        it('a refusal from Meta is its message, shown in Review', async () => {
            metaRefuses = (url) => (url.endsWith('/adcreatives')
                ? Object.assign(new Error('Invalid parameter'), { isAxiosError: true, response: { status: 400, data: { error: {
                    message: 'Invalid parameter', code: 100, error_subcode: 2446885,
                    error_user_title: 'Instagram account not available', error_user_msg: 'Assign the Instagram account to this business.',
                } }, headers: {} } })
                : null);
            const res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec: spec() } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.equal(res.body.meta.ok, false);
            assert.equal(res.body.meta.object, 'ads.0.creative');
            assert.match(res.body.meta.error, /Invalid parameter/);
            assert.match(res.body.meta.error, /Instagram account not available: Assign the Instagram account to this business\./, 'Meta\'s own explanation is shown');
            assert.equal(res.body.meta.metaCode, 100);
            assert.equal(res.body.meta.metaSubcode, 2446885);
        });

        it('says when the destination\'s assistant is off, or sells only to testers', async () => {
            assistant = { is_active: false, sales_mode: 'on', sales_test_senders: [] };
            let res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec: spec({ destinations: ['instagram', 'whatsapp'] }) } });
            assert.deepEqual(res.body.bots, [{ destination: 'instagram', state: 'off' }, { destination: 'whatsapp', state: 'not_connected' }]);
            assistant = { is_active: true, sales_mode: 'test', sales_test_senders: ['1'] };
            res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec: spec() } });
            assert.deepEqual(res.body.bots, [{ destination: 'instagram', state: 'sales_test' }]);
        });

        it('a spec that does not hold together is its problems, with no call to Meta', async () => {
            const res = await call('POST', '/drafts/validate', { role: 'operator', body: { spec: spec({ destinations: [] }) } });
            assert.equal(res.statusCode, 200);
            assert.ok(res.body.problems.length > 0);
            assert.equal(kit.meta.length, 0);
        });

        it('a viewer may not ask Meta', async () => {
            assert.equal((await call('POST', '/drafts/validate', { role: 'viewer', body: { spec: spec() } })).statusCode, 403);
        });
    });

    describe('POST /drafts', () => {
        it('refuses POLICY_BLOCKED with the findings, and writes nothing', async () => {
            caption = 'هل أنت عاطل عن العمل؟';
            const res = await call('POST', '/drafts', { body: { spec: spec() } });
            assert.equal(res.statusCode, 422);
            assert.equal(res.body.code, 'POLICY_BLOCKED');
            assert.equal(res.body.findings[0].ruleId, 'personal_attribute');
            assert.equal(kit.ops.length, 0);
            assert.equal(inserted.length, 0);
        });

        it('refuses unread warnings, and creates once they are confirmed', async () => {
            const warned = spec({}, { message: { greeting: 'احصل على شهادة معتمدة', iceBreakers: [] } });
            const first = await call('POST', '/drafts', { body: { spec: warned } });
            assert.equal(first.statusCode, 409);
            assert.equal(first.body.code, 'POLICY_WARNINGS');
            assert.equal(kit.ops.length, 0);
            const second = await call('POST', '/drafts', { body: { spec: warned, confirmPolicyWarnings: true } });
            assert.equal(second.statusCode, 201, JSON.stringify(second.body));
        });

        it('writes the stored copy PAUSED and a chain of create ops with dependencies; Meta is not called in the request', async () => {
            const res = await call('POST', '/drafts', { body: { spec: spec() } });
            assert.equal(res.statusCode, 201, JSON.stringify(res.body));
            assert.deepEqual(inserted.map((r) => r.level), ['campaign', 'adset', 'ad', 'creative']);
            assert.ok(inserted.every((r) => r.status === 'PAUSED'));
            assert.equal(inserted[2]!.appMeta['greeting'], 'مرحبًا! كيف يمكننا مساعدتك؟');

            const ops = kit.ops;
            assert.deepEqual(ops.map((o) => o.payload.exec.edge), ['campaigns', 'adsets', 'adcreatives', 'ads']);
            assert.ok(ops.every((o) => o.kind === 'create' && o.creator_id === TENANT));
            assert.equal(ops[0]!.depends_on, null);
            for (let i = 1; i < ops.length; i++) assert.equal(ops[i]!.depends_on, ops[i - 1]!.id, `op ${i} waits for the one before it`);
            // Every object PAUSED, and the ids each needs named by placeholder.
            for (const o of ops) assert.equal(o.payload.exec.params.status ?? 'PAUSED', 'PAUSED');
            assert.equal(ops[1]!.payload.exec.params.campaign_id, `{op:${ops[0]!.id}}`);
            assert.equal(ops[3]!.payload.exec.params.adset_id, `{op:${ops[1]!.id}}`);
            assert.deepEqual(ops[3]!.payload.exec.params.creative, { creative_id: `{op:${ops[2]!.id}}` });
            assert.equal(ops[1]!.payload.exec.params.destination_type, 'INSTAGRAM_DIRECT');
            assert.match(ops[2]!.payload.exec.params.url_tags, /^ref=ar_[0-9a-f]{12}$/);

            assert.equal(res.body.campaignId, 'b0000000-0000-4000-8000-000000000001');
            assert.equal(res.body.ops.length, 4);
            assert.equal(posted.length, 0, 'no create was sent inside the request');
            assert.equal(kit.waits.length, 1, 'the chain runs inline under waitUntil');
            await Promise.all(kit.waits);
        });

        it('is the owner\'s', async () => {
            assert.equal((await call('POST', '/drafts', { role: 'operator', body: { spec: spec() } })).statusCode, 403);
        });

        it('refuses a WhatsApp destination when no WhatsApp number is linked', async () => {
            const res = await call('POST', '/drafts', { body: { spec: spec({ destinations: ['whatsapp'] }) } });
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 'UNSUPPORTED');
            assert.equal(kit.ops.length, 0);
        });

        it('refuses a Facebook post for a message ad until the live check says it works (T094)', async () => {
            const res = await call('POST', '/drafts', { body: { spec: spec({}, { creative: { source: 'post', postId: POST_ID, platform: 'facebook' } }) } });
            assert.equal(res.statusCode, 400, JSON.stringify(res.body));
            assert.equal(res.body.code, 'UNSUPPORTED');
        });
    });

    describe('POST /boosts with Send messages: the preset', () => {
        it('creates the same draft from the v1 inputs, origin boost', async () => {
            const res = await call('POST', '/boosts', { body: {
                postId: POST_ID, platform: 'instagram', dailyBudget: 5, days: 3, country: 'sa', objective: 'MESSAGES',
                destinations: ['instagram'], greeting: 'أهلًا بك', iceBreakers: [{ title: 'كم سعر الدورة؟' }],
            } });
            assert.equal(res.statusCode, 201, JSON.stringify(res.body));
            assert.equal(kit.ops.length, 4);
            assert.equal(kit.ops[1]!.payload.exec.params.lifetime_budget, 1500);
            assert.deepEqual(kit.ops[1]!.payload.exec.params.targeting.geo_locations, { countries: ['SA'] });
        });
    });
});
