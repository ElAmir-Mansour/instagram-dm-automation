/**
 * The first comment campaign (P25): what `POST /api/onboarding/complete` creates, once, switched OFF. The plan (`planFirstCampaign`) is
 * pure, so every case is a table; the finishing itself (one campaign, in the same transaction as the status change, and never two) is
 * driven through the real route below.
 *
 * What is pinned, because each reaches followers or leaves a tenant half set up:
 *
 *   - it is created OFF (`is_active = false`), on every post, and the statement says so;
 *   - it is made from what the TENANT confirmed (an approval or their own edit), else from the register's own wording and the offer;
 *     an admin's approval, a rejection and an unconfirmed sample are not their words;
 *   - it needs a real keyword and a message that can be sent, and says why when it has neither;
 *   - Finish is idempotent: a second call, a double tap and two tabs make ONE campaign, and a campaign that cannot be written leaves the
 *     setup open to be finished again, with nothing half-done.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { onboardingRouter } from '../../routes/onboarding.js';
import { setLogSink } from '../../utils/log.js';
import { contextFor } from '../profile/context.js';
import { FITNESS_EN, offer, SHOP_EG } from '../profile/fixtures.js';
import { kitFor } from '../profile/kits.js';
import { resetProfileTableWarning } from '../profile/store.js';
import { throughJsonb } from '../profile/testSupport.js';
import { invalidateTenantCache } from '../tenant.js';
import {
    cleanKeyword, confirmedComment, FIRST_CAMPAIGN_SQL, planFirstCampaign, primaryOffer, type ConfirmedComment,
} from './proofCampaign.js';
import type { ProofRow } from './proofStore.js';
import {
    addProofTenant, ADMIN_USER, installAiStub, installProofWorld, NEW_OWNER_USER, NEWCOMER, proofProfile, providerKeys, type AiStub, type ProofWorld,
} from '../proof/testDb.js';

const SAMPLE: ConfirmedComment = { keyword: 'شمعة', dm: 'أهلًا {username}\n🔗 https://nour.example/candle', publicReplies: ['وصلك الرابط يا {username}', 'شوف رسايلك'] };

// ─── The plan ────────────────────────────────────────────────────────────────────────────────────

describe('planFirstCampaign', () => {
    it('is the tenant\'s confirmed wording when there is some: the keyword, the message, the replies joined the way the webhook splits them', () => {
        const plan = planFirstCampaign(SHOP_EG, SAMPLE);
        assert.ok(plan.ok);
        assert.deepEqual(plan.seed, {
            trigger_keyword: 'شمعة', dm_template: SAMPLE.dm, public_reply_template: 'وصلك الرابط يا {username} | شوف رسايلك', match_mode: 'substring', source: 'proof',
        });
    });

    it('is the register\'s own campaign wording, with the offer\'s name and link in it, when there is no sample', () => {
        const plan = planFirstCampaign(SHOP_EG, null);
        assert.ok(plan.ok);
        const lines = kitFor(contextFor(SHOP_EG, 'comment_reply', null).language).importFallback;
        assert.equal(plan.seed.source, 'kit');
        assert.equal(plan.seed.trigger_keyword, 'شمعة');
        assert.equal(plan.seed.dm_template, lines.dm.replace('{name}', 'شمعة لافندر').replace('{url}', 'https://nour.example/candle'));
        assert.equal(plan.seed.public_reply_template, lines.replies);
        assert.match(plan.seed.dm_template, /\{username\}/, '{username} waits for the send');
    });

    it('speaks the language of the tenant: English for an English one, and no name that can become a placeholder', () => {
        const plan = planFirstCampaign({ ...FITNESS_EN, offers: [offer({ id: 'p', kind: 'program', name: 'Plan {username} {url}', order_via: 'url', url: 'https://samifit.example/plan', keyword: 'plan, programme', primary: true })] }, null);
        assert.ok(plan.ok);
        assert.match(plan.seed.dm_template, /^Hi \{username\}! 👋\nHere is the link for "Plan username url":\n🔗 https:\/\/samifit\.example\/plan$/);
        assert.equal(plan.seed.trigger_keyword, 'plan', 'the first of a comma list');
    });

    it('has a main offer: the primary one, else the first', () => {
        assert.equal(primaryOffer(FITNESS_EN)!.id, 'plan');
        assert.equal(primaryOffer({ offers: [offer({ id: 'a' }), offer({ id: 'b' })] })!.id, 'a');
        assert.equal(primaryOffer({ offers: [] }), null);
    });

    it('says why there is none: no offer, no keyword, or nothing that can be sent', () => {
        assert.deepEqual(planFirstCampaign({ ...SHOP_EG, offers: [] }, null), { ok: false, reason: 'no_offer' });
        assert.deepEqual(planFirstCampaign({ ...SHOP_EG, offers: [offer({ id: 'c', name: 'x', order_via: 'url', url: 'https://x.example', primary: true })] }, null), { ok: false, reason: 'no_keyword' });
        assert.deepEqual(planFirstCampaign({ ...SHOP_EG, offers: [offer({ id: 'c', name: 'x', order_via: 'dm', keyword: 'x', primary: true })] }, null), { ok: false, reason: 'no_message' }, 'an offer ordered by DM has no link to send; only the tenant can say how to order');
        assert.deepEqual(planFirstCampaign({ ...SHOP_EG, offers: [offer({ id: 'c', name: 'x', order_via: 'url', url: '  ', keyword: 'x', primary: true })] }, null), { ok: false, reason: 'no_message' });
        assert.equal(planFirstCampaign({ ...SHOP_EG, offers: [offer({ id: 'c', name: 'x', order_via: 'dm', keyword: 'x', primary: true })] }, SAMPLE).ok, true, 'a confirmed sample can say it');
    });

    it('matches whole words when the keyword sits inside a longer word in their own captions', () => {
        const inside = { ...SHOP_EG, voice: { ...SHOP_EG.voice, samples: ['شمعةين جداد'] } };
        const plan = planFirstCampaign(inside, SAMPLE);
        assert.ok(plan.ok);
        assert.equal(plan.seed.match_mode, 'word');
        const kit = planFirstCampaign(inside, null);
        assert.ok(kit.ok);
        assert.equal(kit.seed.match_mode, 'word');
    });
});

describe('cleanKeyword', () => {
    it('is the first word of a list, and nothing for what is not one short word', () => {
        assert.equal(cleanKeyword('شمعة'), 'شمعة');
        assert.equal(cleanKeyword(' plan ,  other '), 'plan');
        assert.equal(cleanKeyword('شمعة، علبة'), 'شمعة');
        for (const bad of ['', '   ', 'two words', 'a|b', '{k}', '<k>', 'x'.repeat(25), 5, null, undefined]) assert.equal(cleanKeyword(bad), '', JSON.stringify(bad));
    });
});

describe('confirmedComment', () => {
    const row = (over: Partial<ProofRow> = {}): ProofRow => ({
        id: 'r', profile_version: 1, kind: 'comment_dm', input: { keyword: 'شمعة', public_replies: ['a', 'b'] }, model_output: 'WROTE', final_text: null,
        verdict: 'approved', verdict_by: 'tenant', tenant_confirmed_at: new Date(1), model: 'm', created_at: new Date(1), ...over,
    });

    it('reads an approval as written and an edit as the tenant\'s own wording', () => {
        assert.deepEqual(confirmedComment(row()), { keyword: 'شمعة', dm: 'WROTE', publicReplies: ['a', 'b'] });
        assert.equal(confirmedComment(row({ verdict: 'edited', final_text: 'MINE' }))!.dm, 'MINE');
    });

    it('is nothing for what the tenant did not stand behind: an admin\'s approval, a rejection, no verdict, the wrong card', () => {
        for (const over of [{ tenant_confirmed_at: null }, { verdict: 'rejected' as const }, { verdict: null }, { kind: 'caption' as const }]) {
            assert.equal(confirmedComment(row(over)), null, JSON.stringify(over));
        }
        assert.equal(confirmedComment(null), null);
    });

    it('is nothing for a row whose parts are not what the proof stores: it is JSONB, so every part is checked', () => {
        for (const input of [{}, { keyword: 'شمعة' }, { keyword: 'two words', public_replies: ['a'] }, { keyword: 'k', public_replies: [] }, { keyword: 'k', public_replies: ['a|b'] }, { keyword: 'k', public_replies: [5] }, 'x', null, []]) {
            assert.equal(confirmedComment(row({ input: input as never })), null, JSON.stringify(input));
        }
        assert.equal(confirmedComment(row({ verdict: 'edited', final_text: '   ' })), null);
        assert.equal(confirmedComment(row({ model_output: 'أ'.repeat(501) })), null, 'over Meta\'s 1,000 bytes');
    });
});

describe('the statement', () => {
    it('creates the campaign OFF, on every post, in the mode it was given, unless the tenant has one on that keyword already', () => {
        assert.match(FIRST_CAMPAIGN_SQL, /SELECT \$1::uuid, \$2::text, \$3::text, \$4::text, NULL, false, \$5::text/);
        assert.match(FIRST_CAMPAIGN_SQL, /WHERE NOT EXISTS \(SELECT 1 FROM campaigns WHERE creator_id = \$1::uuid AND lower\(trigger_keyword\) = lower\(\$2::text\)\)/);
        assert.doesNotMatch(FIRST_CAMPAIGN_SQL, /\btrue\b/);
    });
});

// ─── Finishing ───────────────────────────────────────────────────────────────────────────────────

interface Reply { status: number; body: any }
async function route(method: 'get' | 'put' | 'post', path: string, options: { session?: Record<string, unknown>; body?: unknown; params?: Record<string, string> } = {}): Promise<Reply> {
    const layer = (onboardingRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] } }[] }).stack
        .find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method} ${path}`);
    const reply: Reply = { status: 200, body: null };
    const res = { status(code: number) { reply.status = code; return this; }, json(payload: unknown) { reply.body = payload; return this; } } as unknown as Response;
    const req = {
        method: method.toUpperCase(), originalUrl: path, params: options.params ?? {}, query: {}, headers: {}, body: options.body ?? {},
        session: { userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER, ...(options.session ?? {}) }, tenantRole: 'owner',
    } as unknown as Request;
    for (const inner of layer!.route!.stack) {
        let advanced = false;
        await inner.handle(req, res, (() => { advanced = true; }) as NextFunction);
        if (!advanced) break;
    }
    return reply;
}
const finish = (session?: Record<string, unknown>) => route('post', '/complete', { session });
const proof = () => route('post', '/proof');
const verdict = (id: string, body: unknown, session?: Record<string, unknown>) => route('post', '/proof/:id/verdict', { body, params: { id }, session });

let world: ProofWorld;
let ai: AiStub;
let restoreKeys: () => void;
let restoreSink: () => void;
const row = () => world.onboarding.get(NEWCOMER)!;

function setup(profile = proofProfile()): void {
    world.state.profiles.clear();
    addProofTenant(world, throughJsonb(profile));
}

beforeEach(() => {
    resetProfileTableWarning();
    invalidateTenantCache();
    const previous = setLogSink(() => undefined);
    restoreSink = () => setLogSink(previous);
    restoreKeys = providerKeys(true);
    world = installProofWorld();
    setup();
    ai = installAiStub();
});
afterEach(() => { ai.restore(); world.restore(); restoreKeys(); restoreSink(); invalidateTenantCache(); });

describe('POST /api/onboarding/complete: the first campaign', () => {
    it('creates one campaign, OFF, from the comment sample the tenant approved', async () => {
        const cards = (await proof()).body.cards;
        const comment = cards.find((c: any) => c.card === 'comment');
        await verdict(comment.id, { verdict: 'approved' });
        const reply = await finish();
        assert.equal(reply.status, 200);
        assert.deepEqual({ status: reply.body.status, already: reply.body.alreadyCompleted, created: reply.body.campaign.created, source: reply.body.campaign.source }, { status: 'completed', already: false, created: true, source: 'proof' });
        assert.equal(world.campaigns.length, 1);
        assert.deepEqual({ ...world.campaigns[0], id: undefined }, {
            id: undefined, creator_id: NEWCOMER, trigger_keyword: 'شمعة', dm_template: 'أهلًا {username} 👋\nدا رابط «شمعة لافندر»:\n🔗 https://nour.example/candle',
            public_reply_template: 'وصلك الرابط على الخاص يا {username} 📩 | شوف رسايلك يا {username} 🚀', post_id: null, is_active: false, match_mode: 'substring',
        });
        assert.equal(reply.body.campaign.id, world.campaigns[0]!.id);
    });

    it('uses the tenant\'s own wording when they edited the message', async () => {
        const comment = (await proof()).body.cards.find((c: any) => c.card === 'comment');
        await verdict(comment.id, { verdict: 'edited', edited_text: 'هلا {username}، الرابط: https://nour.example/candle' });
        await finish();
        assert.equal(world.campaigns[0]!.dm_template, 'هلا {username}، الرابط: https://nour.example/candle');
        assert.equal(world.campaigns[0]!.is_active, false);
    });

    it('does not take the words of a sample the tenant did not confirm: an admin\'s approval, or a rejection, fall back to the register\'s own', async () => {
        const comment = (await proof()).body.cards.find((c: any) => c.card === 'comment');
        await verdict(comment.id, { verdict: 'approved' }, { userId: ADMIN_USER, role: 'platform_admin' });
        const byAdmin = await finish();
        assert.equal(byAdmin.body.campaign.source, 'kit');
        assert.notEqual(world.campaigns[0]!.dm_template, world.examples.find((e) => e.kind === 'comment_dm')!.model_output);
    });

    it('does not take a rejected sample either', async () => {
        const comment = (await proof()).body.cards.find((c: any) => c.card === 'comment');
        await verdict(comment.id, { verdict: 'rejected' });
        assert.equal((await finish()).body.campaign.source, 'kit');
    });

    it('is idempotent: a second Finish makes nothing, and says nothing about a campaign', async () => {
        const first = await finish();
        assert.equal(first.body.campaign.created, true);
        const again = await finish();
        assert.deepEqual(again.body, { status: 'completed', alreadyCompleted: true, step: 'done' });
        assert.equal(world.campaigns.length, 1);
        for (let i = 0; i < 3; i++) await finish();
        assert.equal(world.campaigns.length, 1, 'however many times it is pressed');
    });

    it('makes one campaign for two Finishes at the same moment: only the call that wins the status change creates it', async () => {
        const [a, b] = await Promise.all([finish(), finish()]);
        assert.equal(world.campaigns.length, 1);
        assert.deepEqual([a.body.alreadyCompleted, b.body.alreadyCompleted].sort(), [false, true]);
        assert.equal([a, b].filter((r) => r.body.campaign?.created === true).length, 1);
    });

    it('creates nothing when another request finished it first', async () => {
        world.before.push({ pattern: /^UPDATE onboarding SET status = 'completed'/, run: () => { row().status = 'completed'; row().completed_at = new Date(2000); row().current_step = 'done'; } });
        const reply = await finish();
        assert.equal(reply.body.alreadyCompleted, true);
        assert.deepEqual(world.campaigns, []);
    });

    it('leaves the setup open when the campaign cannot be written: nothing is half done, and Finish can be pressed again', async () => {
        world.db.failOn = /^INSERT INTO campaigns/;
        const failed = await finish();
        assert.equal(failed.status, 500);
        assert.equal(row().status, 'in_progress', 'the status change was rolled back with the insert');
        assert.equal(row().completed_at, null);
        assert.deepEqual(world.campaigns, []);
        assert.deepEqual(world.events.filter((e) => e.event === 'wizard_completed'), [], 'and the funnel does not say it finished');

        world.db.failOn = null;
        const retry = await finish();
        assert.equal(retry.status, 200);
        assert.equal(retry.body.campaign.created, true);
        assert.equal(row().status, 'completed');
        assert.equal(world.campaigns.length, 1);
        assert.equal(world.events.filter((e) => e.event === 'wizard_completed').length, 1);
    });

    it('takes the tenant\'s publishing lock before it writes, as the Studio and the Monteur do before they plan a campaign on a keyword', async () => {
        await finish();
        const locks = world.db.ran(/pg_advisory_xact_lock/).filter((s) => s.params[0] === `publishing:${NEWCOMER}`);
        assert.equal(locks.length, 1);
        const order = world.db.statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => /pg_advisory_xact_lock/.test(s)) < order.findIndex((s) => /^INSERT INTO campaigns/.test(s)));
    });

    it('creates none, and says why, for a tenant whose offer has no keyword; it still finishes', async () => {
        setup(proofProfile({ offers: [{ ...SHOP_EG.offers[0]!, keyword: '' }] }));
        const reply = await finish();
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body.campaign, { created: false, reason: 'no_keyword' });
        assert.equal(row().status, 'completed');
        assert.deepEqual(world.campaigns, []);
    });

    it('creates none for an offer ordered by DM when nobody wrote how to order, and says so', async () => {
        setup(proofProfile({ offers: [{ ...SHOP_EG.offers[0]!, order_via: 'dm', url: '' }] }));
        assert.deepEqual((await finish()).body.campaign, { created: false, reason: 'no_message' });
    });

    it('does not make a second campaign on a keyword the tenant already has, in any case, and still finishes', async () => {
        world.campaigns.push({ id: 'existing', creator_id: NEWCOMER, trigger_keyword: 'شمعة', dm_template: 'x', public_reply_template: null, post_id: null, is_active: true, match_mode: 'substring' });
        const reply = await finish();
        assert.deepEqual(reply.body.campaign, { created: false, reason: 'exists' });
        assert.equal(world.campaigns.length, 1);
        assert.equal(row().status, 'completed');
    });

    it('still finishes when the sample cannot be read: the campaign is then the register\'s own wording', async () => {
        world.db.failOn = /FROM voice_examples/;
        const reply = await finish();
        assert.equal(reply.status, 200);
        assert.equal(reply.body.campaign.source, 'kit');
    });

    it('is nothing the owner is ever given: his tenant is completed, so Finish answers it and creates nothing', async () => {
        const reply = await finish({ userId: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111' });
        assert.equal(reply.body.alreadyCompleted, true);
        assert.deepEqual(world.campaigns, []);
    });
});
