/**
 * The CampaignSpec → Meta payload mapping (spec.ts): pure, so every test is a function call. The properties that matter most are the
 * ones that decide whether money can move: EVERY object is PAUSED, every name carries the op tag, and the parameters Meta defaults
 * differently across versions (`special_ad_categories`, `advantage_audience`, `bid_strategy`, the creative opt-outs) are always explicit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    adParams, adsetParams, boostToSpec, CREATIVE_OPT_OUTS, FB_POST_MESSENGER_OK, mapSpec, messageDestinationType, POST_GREETING_PLACEMENT,
    SpecError, validateSpec,
    type AdGoal, type CampaignSpec, type MessageDestination, type SpecContext,
} from './spec.js';
import { buildAdSetParams, buildCampaignParams, buildCreativeParams, type BoostSpec } from '../metaAds.js';

const NOW = new Date('2026-10-22T10:00:00.000Z');
const OP_TAG = 'AR·op42';

function ctx(over: Partial<SpecContext> = {}): SpecContext {
    return {
        adAccountId: '509787248064459', currency: 'USD', pageId: '100200300', igUserId: '17841400000000000', whatsappPhone: '966500000000',
        opTag: OP_TAG, refShort: 'k7Qx2', now: NOW,
        posts: {
            ig1: { platform: 'instagram', mediaId: '18000000000000001' },
            fb1: { platform: 'facebook', mediaId: '100200300_999' },
        },
        media: { img1: { kind: 'image', imageHash: 'hash123' }, vid1: { kind: 'video', videoId: '555', coverUrl: 'https://cdn.example.com/c.jpg' } },
        links: { offer1: 'https://autoreply.example.com/r/abc123' },
        ...over,
    };
}

type Spec = CampaignSpec;

function messageSpec(over: Partial<Spec> = {}): Spec {
    return {
        name: 'Go course', goal: 'messages', destinations: ['instagram'], specialCategory: 'none',
        budget: { home: 'adset', kind: 'lifetime', amount: 15, start: '2026-10-22T10:00:00.000Z', end: '2026-10-25T10:00:00.000Z' },
        adsets: [{ name: 'SA', targeting: { countries: ['SA'], ageMin: 18, advantageAudience: true }, placements: 'automatic' }],
        ads: [{
            adsetIndex: 0, name: 'Reel', creative: { source: 'post', postId: 'ig1', platform: 'instagram' }, copy: { primaryText: 'Learn Go' },
            message: { greeting: 'Hi! How can we help?', iceBreakers: [{ title: 'Price?', response: '49 USD' }, { title: 'Syllabus?' }] },
        }],
        ...over,
    };
}

function problemsOf(spec: unknown): Array<{ field: string; code: string }> {
    const r = validateSpec(spec);
    assert.equal(r.ok, false, 'expected a problem');
    return r.ok ? [] : r.problems.map(p => ({ field: p.field, code: p.code }));
}

const PERMUTE = <T,>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) => PERMUTE([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest]));

const CTA = {
    instagram: { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT', link: 'https://www.instagram.com' } },
    messenger: { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER', link: 'https://fb.com/messenger_doc/' } },
    whatsapp: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP', link: 'https://api.whatsapp.com/send' } },
};

describe('messages: destinations', () => {
    it('maps each single destination to its destination_type, with CONVERSATIONS and the page', () => {
        const expected: Record<MessageDestination, string> = { instagram: 'INSTAGRAM_DIRECT', messenger: 'MESSENGER', whatsapp: 'WHATSAPP' };
        for (const d of Object.keys(expected) as MessageDestination[]) {
            const p = mapSpec(messageSpec({ destinations: [d] }), ctx());
            assert.equal(p.adsets[0]!['destination_type'], expected[d]);
            assert.equal(p.adsets[0]!['optimization_goal'], 'CONVERSATIONS');
            assert.equal((p.adsets[0]!['promoted_object'] as Record<string, unknown>)['page_id'], '100200300');
            assert.equal(p.campaign['objective'], 'OUTCOME_ENGAGEMENT');
        }
    });

    it('maps every 2- and 3-destination mix to the right MESSAGING_* value, whatever the order', () => {
        const table: Array<[MessageDestination[], string]> = [
            [['instagram', 'messenger', 'whatsapp'], 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP'],
            [['instagram', 'messenger'], 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER'],
            [['messenger', 'whatsapp'], 'MESSAGING_MESSENGER_WHATSAPP'],
            [['instagram', 'whatsapp'], 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP'],
        ];
        for (const [dests, value] of table) {
            for (const order of PERMUTE(dests)) {
                assert.equal(messageDestinationType(order), value);
                const p = mapSpec(messageSpec({ destinations: order }), ctx());
                assert.equal(p.adsets[0]!['destination_type'], value);
                assert.equal(p.adsets[0]!['optimization_goal'], 'CONVERSATIONS');
            }
        }
    });

    it('puts the right CTA on a single-destination creative', () => {
        for (const d of ['instagram', 'messenger', 'whatsapp'] as const) {
            const cta = mapSpec(messageSpec({ destinations: [d] }), ctx()).creatives[0]!['call_to_action'] as { type: string; value: Record<string, unknown> };
            assert.equal(cta.type, CTA[d].type);
            assert.equal(cta.value['app_destination'], CTA[d].value.app_destination);
            assert.equal(cta.value['link'], CTA[d].value.link);
        }
    });

    it('several destinations use asset_feed_spec DOF_MESSAGING_DESTINATION with one CTA per destination', () => {
        const creative = mapSpec(messageSpec({ destinations: ['whatsapp', 'instagram', 'messenger'] }), ctx()).creatives[0]!;
        const feed = creative['asset_feed_spec'] as { optimization_type: string; call_to_actions: Array<{ type: string; value: Record<string, unknown> }> };
        assert.equal(feed.optimization_type, 'DOF_MESSAGING_DESTINATION');
        assert.deepEqual(feed.call_to_actions.map(c => c.type).sort(), ['INSTAGRAM_MESSAGE', 'MESSAGE_PAGE', 'WHATSAPP_MESSAGE']);
        for (const c of feed.call_to_actions) {
            const dest = Object.values(CTA).find(x => x.type === c.type)!;
            assert.equal(c.value['app_destination'], dest.value.app_destination);
            assert.equal(c.value['link'], dest.value.link);
        }
        assert.equal(creative['call_to_action'], undefined, 'the single CTA is replaced by the feed');
        const single = mapSpec(messageSpec({ destinations: ['instagram'] }), ctx()).creatives[0]!;
        assert.equal(single['asset_feed_spec'], undefined);
    });

    it('whatsapp: promoted_object carries the number; without one it is UNSUPPORTED', () => {
        const p = mapSpec(messageSpec({ destinations: ['whatsapp'] }), ctx());
        assert.deepEqual(p.adsets[0]!['promoted_object'], { page_id: '100200300', whatsapp_phone_number: '966500000000' });
        const noWa = mapSpec(messageSpec({ destinations: ['instagram'] }), ctx());
        assert.deepEqual(noWa.adsets[0]!['promoted_object'], { page_id: '100200300' });
        for (const destinations of [['whatsapp'], ['instagram', 'whatsapp']] as MessageDestination[][]) {
            assert.throws(() => mapSpec(messageSpec({ destinations }), ctx({ whatsappPhone: null })), (e: unknown) =>
                e instanceof SpecError && e.code === 'UNSUPPORTED' && e.field === 'destinations');
        }
    });

    it('an Instagram destination needs the Instagram account', () => {
        assert.throws(() => mapSpec(messageSpec({ destinations: ['instagram'] }), ctx({ igUserId: null })), (e: unknown) => e instanceof SpecError && e.code === 'UNSUPPORTED');
    });
});

describe('messages: the greeting and ice breakers', () => {
    const WELCOME = {
        type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text',
        text_format: {
            customer_action_type: 'ice_breakers',
            message: { text: 'Hi! How can we help?', ice_breakers: [{ title: 'Price?', response: '49 USD' }, { title: 'Syllabus?' }] },
        },
    };

    it('a post creative carries NO greeting (Meta refuses it there: live check 2026-10-22) and says so', () => {
        assert.equal(POST_GREETING_PLACEMENT, 'omit');
        const p = mapSpec(messageSpec({ destinations: ['instagram'] }), ctx());
        const creative = p.creatives[0]!;
        assert.equal(JSON.stringify(creative).includes('page_welcome_message'), false);
        assert.deepEqual((creative['call_to_action'] as { value: Record<string, unknown> }).value, { app_destination: 'INSTAGRAM_DIRECT', link: 'https://www.instagram.com' });
        assert.deepEqual(p.warnings.map((w) => [w.code, w.field]), [['NO_GREETING_ON_POST', 'ads.0.message']]);
    });

    it('a post creative without a greeting has no warning', () => {
        const s = messageSpec({ destinations: ['instagram'] });
        delete (s.ads[0] as { message?: unknown }).message;
        assert.deepEqual(mapSpec(s, ctx()).warnings, []);
    });

    it('a media creative carries it under link_data (image) or video_data (video)', () => {
        const base = messageSpec();
        const image = mapSpec({ ...base, ads: [{ ...base.ads[0]!, creative: { source: 'media', mediaId: 'img1' }, copy: { primaryText: 'Learn Go', headline: 'Go' } }] }, ctx()).creatives[0]!;
        const iss = image['object_story_spec'] as { page_id: string; instagram_user_id: string; link_data: Record<string, unknown> };
        assert.equal(iss.page_id, '100200300');
        assert.equal(iss.instagram_user_id, '17841400000000000');
        assert.equal(iss.link_data['image_hash'], 'hash123');
        assert.equal(iss.link_data['message'], 'Learn Go');
        assert.equal(iss.link_data['name'], 'Go');
        assert.deepEqual(iss.link_data['page_welcome_message'], WELCOME);
        assert.deepEqual(iss.link_data['call_to_action'], CTA.instagram);

        const video = mapSpec({ ...base, ads: [{ ...base.ads[0]!, creative: { source: 'media', mediaId: 'vid1' } }] }, ctx()).creatives[0]!;
        const vss = video['object_story_spec'] as { video_data: Record<string, unknown> };
        assert.equal(vss.video_data['video_id'], '555');
        assert.equal(vss.video_data['image_url'], 'https://cdn.example.com/c.jpg');
        assert.deepEqual(vss.video_data['page_welcome_message'], WELCOME);
    });

    it('validateSpec enforces the limits: greeting 300, title 80, response 300, 4 ice breakers', () => {
        const withMessage = (message: unknown): Spec => { const s = messageSpec(); (s.ads[0] as { message: unknown }).message = message; return s; };
        const ok = (message: unknown) => validateSpec(withMessage(message)).ok;
        assert.equal(ok({ greeting: 'x'.repeat(300), iceBreakers: [] }), true);
        assert.deepEqual(problemsOf(withMessage({ greeting: 'x'.repeat(301), iceBreakers: [] })), [{ field: 'ads.0.message.greeting', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(withMessage({ greeting: '', iceBreakers: [] })), [{ field: 'ads.0.message.greeting', code: 'INVALID' }]);
        assert.equal(ok({ greeting: 'hi', iceBreakers: [{ title: 't'.repeat(80) }] }), true);
        assert.deepEqual(problemsOf(withMessage({ greeting: 'hi', iceBreakers: [{ title: 'ok' }, { title: 't'.repeat(81) }] })), [{ field: 'ads.0.message.iceBreakers.1.title', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(withMessage({ greeting: 'hi', iceBreakers: [{ title: 'ok', response: 'r'.repeat(301) }] })), [{ field: 'ads.0.message.iceBreakers.0.response', code: 'INVALID' }]);
        assert.equal(ok({ greeting: 'hi', iceBreakers: [1, 2, 3, 4].map(n => ({ title: `q${n}` })) }), true);
        assert.deepEqual(problemsOf(withMessage({ greeting: 'hi', iceBreakers: [1, 2, 3, 4, 5].map(n => ({ title: `q${n}` })) })), [{ field: 'ads.0.message.iceBreakers', code: 'INVALID' }]);
    });

    it('validateSpec needs at least one destination for messages, and no duplicates', () => {
        assert.deepEqual(problemsOf(messageSpec({ destinations: [] })), [{ field: 'destinations', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(messageSpec({ destinations: undefined })), [{ field: 'destinations', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(messageSpec({ destinations: ['instagram', 'instagram'] })), [{ field: 'destinations', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(messageSpec({ destinations: ['telegram' as MessageDestination] })), [{ field: 'destinations', code: 'INVALID' }]);
    });
});

describe('what is always explicit', () => {
    it('special_ad_categories is always present, with the four mappings', () => {
        const table: Array<[Spec['specialCategory'], string[]]> = [
            ['none', []], ['employment', ['EMPLOYMENT']], ['financial', ['FINANCIAL_PRODUCTS_SERVICES']], ['housing', ['HOUSING']], ['political', ['ISSUES_ELECTIONS_POLITICS']],
        ];
        for (const [cat, value] of table) {
            // A special category narrows targeting (18–65+, no gender, no exclusions) — the default spec already complies.
            const p = mapSpec(messageSpec({ specialCategory: cat }), ctx());
            assert.deepEqual(p.campaign['special_ad_categories'], value, cat);
            assert.ok(Array.isArray(p.campaign['special_ad_categories']));
        }
    });

    it('targeting_automation.advantage_audience is always present: 0 and 1; with 1 age_min <= 25 and no age_max', () => {
        const spec = (advantageAudience: boolean, ageMin: number, ageMax?: number): Spec => messageSpec({
            adsets: [{ name: 'SA', targeting: { countries: ['SA'], ageMin, ...(ageMax !== undefined ? { ageMax } : {}), advantageAudience }, placements: 'automatic' }],
        });
        const off = mapSpec(spec(false, 30, 45), ctx()).adsets[0]!['targeting'] as Record<string, unknown>;
        assert.deepEqual(off['targeting_automation'], { advantage_audience: 0 });
        assert.equal(off['age_min'], 30);
        assert.equal(off['age_max'], 45);
        const on = mapSpec(spec(true, 22), ctx()).adsets[0]!['targeting'] as Record<string, unknown>;
        assert.deepEqual(on['targeting_automation'], { advantage_audience: 1 });
        assert.equal(on['age_min'], 22);
        assert.equal('age_max' in on, false);
        assert.deepEqual(problemsOf(spec(true, 30)), [{ field: 'adsets.0.targeting.ageMin', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(spec(true, 20, 40)), [{ field: 'adsets.0.targeting.ageMax', code: 'INVALID' }]);
    });

    it('bid_strategy is explicit wherever the budget lives', () => {
        const adsetHome = mapSpec(messageSpec(), ctx());
        assert.equal(adsetHome.adsets[0]!['bid_strategy'], 'LOWEST_COST_WITHOUT_CAP');
        assert.equal(adsetHome.campaign['is_adset_budget_sharing_enabled'], false);
        assert.equal('lifetime_budget' in adsetHome.campaign, false);
        const campaignHome = mapSpec(messageSpec({ budget: { home: 'campaign', kind: 'daily', amount: 5, start: '2026-10-22T10:00:00.000Z' } }), ctx());
        assert.equal(campaignHome.campaign['bid_strategy'], 'LOWEST_COST_WITHOUT_CAP');
        assert.equal('is_adset_budget_sharing_enabled' in campaignHome.campaign, false);
        assert.equal('daily_budget' in campaignHome.adsets[0]!, false, 'the budget is on the campaign only');
        assert.equal(campaignHome.campaign['buying_type'], 'AUCTION');
    });

    it('every creative opts out of the rewriting features and in to adapt_to_placement', () => {
        assert.ok(CREATIVE_OPT_OUTS.length > 15);
        assert.ok(!(CREATIVE_OPT_OUTS as readonly string[]).includes('standard_enhancements'), 'dead since v22');
        assert.ok(!(CREATIVE_OPT_OUTS as readonly string[]).includes('adapt_to_placement'));
        const traffic = (): Spec => ({
            ...messageSpec(), goal: 'traffic', destinations: undefined,
            ads: [{ adsetIndex: 0, name: 'A', creative: { source: 'post', postId: 'ig1', platform: 'instagram' }, copy: { primaryText: '' }, link: { trackedOfferId: 'offer1' } }],
        });
        const everyCreative = [
            ...mapSpec(messageSpec(), ctx()).creatives,
            ...mapSpec(traffic(), ctx()).creatives,
            ...mapSpec({ ...traffic(), goal: 'engagement', ads: [{ ...traffic().ads[0]!, creative: { source: 'post', postId: 'fb1', platform: 'facebook' } }] }, ctx()).creatives,
            ...mapSpec(messageSpec({ destinations: ['messenger', 'whatsapp'] }), ctx()).creatives,
        ];
        for (const creative of everyCreative) {
            const features = (creative['degrees_of_freedom_spec'] as { creative_features_spec: Record<string, { enroll_status: string }> }).creative_features_spec;
            for (const key of CREATIVE_OPT_OUTS) assert.deepEqual(features[key], { enroll_status: 'OPT_OUT' }, key);
            assert.deepEqual(features['adapt_to_placement'], { enroll_status: 'OPT_IN' });
        }
    });

    it('every name carries the op tag; messages and traffic creatives carry url_tags ref=ar_<refShort>', () => {
        const p = mapSpec(messageSpec(), ctx());
        assert.equal(p.campaign['name'], `Go course · ${OP_TAG}`);
        assert.equal(p.adsets[0]!['name'], `SA · ${OP_TAG}`);
        assert.ok(String(p.creatives[0]!['name']).includes(OP_TAG));
        assert.ok(String(p.ads[0]!.params['name']).includes(OP_TAG));
        assert.ok(String(p.creatives[0]!['url_tags']).includes('ref=ar_k7Qx2'));
        const traffic = mapSpec({ ...messageSpec(), goal: 'traffic', destinations: undefined, ads: [{ adsetIndex: 0, name: 'A', creative: { source: 'post', postId: 'ig1', platform: 'instagram' }, copy: { primaryText: '' }, link: { trackedOfferId: 'offer1' } }] }, ctx());
        assert.ok(String(traffic.creatives[0]!['url_tags']).includes('ref=ar_k7Qx2'));
    });

    it('EVERY object is PAUSED, walking every payload of every goal', () => {
        const specs: Spec[] = [
            messageSpec(),
            messageSpec({ destinations: ['instagram', 'messenger', 'whatsapp'] }),
            messageSpec({ budget: { home: 'campaign', kind: 'daily', amount: 5, start: '2026-10-22T10:00:00.000Z' }, adsets: [
                { name: 'A', targeting: { countries: ['SA'], ageMin: 18, advantageAudience: true }, placements: 'automatic' },
                { name: 'B', targeting: { countries: ['EG'], ageMin: 18, advantageAudience: true }, placements: 'automatic' },
            ], ads: [
                { adsetIndex: 0, name: 'a', creative: { source: 'post', postId: 'ig1', platform: 'instagram' }, copy: { primaryText: '' } },
                { adsetIndex: 1, name: 'b', creative: { source: 'media', mediaId: 'vid1' }, copy: { primaryText: 'x' } },
            ] }),
            { ...messageSpec(), goal: 'engagement', destinations: undefined },
            { ...messageSpec(), goal: 'reach', destinations: undefined },
            { ...messageSpec(), goal: 'traffic', destinations: undefined, ads: [{ adsetIndex: 0, name: 'A', creative: { source: 'post', postId: 'ig1', platform: 'instagram' }, copy: { primaryText: '' }, link: { url: 'https://example.com/x' } }] },
        ];
        for (const spec of specs) {
            const p = mapSpec(spec, ctx());
            const everything: Array<Record<string, unknown>> = [p.campaign];
            p.adsets.forEach((_, i) => everything.push(adsetParams(p, i, 'C1')));
            p.ads.forEach((_, i) => everything.push(adParams(p, i, 'S1', 'CR1')));
            assert.equal(everything.length, 1 + spec.adsets.length + spec.ads.length);
            for (const obj of everything) assert.equal(obj['status'], 'PAUSED', `${spec.goal}: ${String(obj['name'])}`);
            // The creatives are not ads: they have no status. What they must not do is smuggle one in.
            for (const creative of p.creatives) assert.ok(!('status' in creative) || creative['status'] === 'PAUSED');
        }
    });

    it('the ad builder plugs the ids in', () => {
        const p = mapSpec(messageSpec(), ctx());
        assert.deepEqual(adParams(p, 0, 'S9', 'CR9'), { name: `Reel · ${OP_TAG}`, adset_id: 'S9', creative: { creative_id: 'CR9' }, status: 'PAUSED' });
        assert.equal(adsetParams(p, 0, 'C9')['campaign_id'], 'C9');
        assert.equal(mapSpec(messageSpec(), ctx(), 'C5').adsets[0]!['campaign_id'], 'C5', 'or give the campaign id up front');
    });
});

describe('budget', () => {
    it('sends minor units: USD x100, JPY x1; lifetime carries end_time; times are Meta format', () => {
        const usd = mapSpec(messageSpec(), ctx()).adsets[0]!;
        assert.equal(usd['lifetime_budget'], 1500);
        assert.equal(usd['start_time'], '2026-10-22T10:00:00+0000');
        assert.equal(usd['end_time'], '2026-10-25T10:00:00+0000');
        assert.equal(usd['billing_event'], 'IMPRESSIONS');
        const jpy = mapSpec(messageSpec({ budget: { home: 'adset', kind: 'daily', amount: 700, start: '2026-10-22T10:00:00.000Z' } }), ctx({ currency: 'JPY' })).adsets[0]!;
        assert.equal(jpy['daily_budget'], 700);
        assert.equal('end_time' in jpy, false, 'a daily budget may run on');
        assert.equal(mapSpec(messageSpec({ budget: { home: 'adset', kind: 'daily', amount: 19.99, start: '2026-10-22T10:00:00.000Z' } }), ctx()).adsets[0]!['daily_budget'], 1999);
    });

    it('a campaign budget sits on the campaign, in minor units, and a lifetime one gets a stop_time', () => {
        const p = mapSpec(messageSpec({ budget: { home: 'campaign', kind: 'lifetime', amount: 30, start: '2026-10-22T10:00:00.000Z', end: '2026-10-26T10:00:00.000Z' } }), ctx());
        assert.equal(p.campaign['lifetime_budget'], 3000);
        assert.equal(p.campaign['stop_time'], '2026-10-26T10:00:00+0000');
        assert.equal('lifetime_budget' in p.adsets[0]!, false);
        assert.equal(p.adsets[0]!['end_time'], '2026-10-26T10:00:00+0000');
    });

    it('validateSpec rejects bad budgets with field paths', () => {
        const b = (budget: unknown) => problemsOf({ ...messageSpec(), budget });
        const start = '2026-10-22T10:00:00.000Z';
        assert.deepEqual(b({ home: 'adset', kind: 'daily', amount: 0, start }), [{ field: 'budget.amount', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'daily', amount: -3, start }), [{ field: 'budget.amount', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'daily', amount: NaN, start }), [{ field: 'budget.amount', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'daily', amount: '5', start }), [{ field: 'budget.amount', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'lifetime', amount: 5, start }), [{ field: 'budget.end', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'lifetime', amount: 5, start, end: start }), [{ field: 'budget.end', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'daily', amount: 5, start, end: '2026-10-22T20:00:00.000Z' }), [{ field: 'budget.end', code: 'INVALID' }], 'a daily budget needs a window over 24 h');
        assert.deepEqual(b({ home: 'adset', kind: 'lifetime', amount: 5, start, end: '2027-02-22T10:00:00.000Z' }), [{ field: 'budget.end', code: 'INVALID' }], 'over 90 days');
        assert.deepEqual(b({ home: 'adset', kind: 'lifetime', amount: 5, start: 'soon', end: start }), [{ field: 'budget.start', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'both', kind: 'daily', amount: 5, start }), [{ field: 'budget.home', code: 'INVALID' }]);
        assert.deepEqual(b({ home: 'adset', kind: 'weekly', amount: 5, start }), [{ field: 'budget.kind', code: 'INVALID' }]);
    });
});

describe('refusals', () => {
    it('a Facebook post cannot be a Messenger message ad (FB_POST_MESSENGER_OK is false until T094)', () => {
        assert.equal(FB_POST_MESSENGER_OK, false);
        const spec = (): Spec => { const s = messageSpec(); s.ads[0]!.creative = { source: 'post', postId: 'fb1', platform: 'facebook' }; return s; };
        const r = validateSpec(spec());
        assert.equal(r.ok, false);
        assert.deepEqual(!r.ok && r.problems.map(p => [p.field, p.code]), [['ads.0.creative', 'UNSUPPORTED']]);
        assert.match(!r.ok ? r.problems[0]!.message : '', /Instagram copy of the reel/);
        assert.throws(() => mapSpec(spec(), ctx()), (e: unknown) => e instanceof SpecError && e.code === 'UNSUPPORTED' && e.field === 'ads.0.creative');
    });

    it('several destinations with a special ad category is a problem', () => {
        const spec = messageSpec({ destinations: ['instagram', 'messenger'], specialCategory: 'employment' });
        assert.deepEqual(problemsOf(spec), [{ field: 'destinations', code: 'UNSUPPORTED' }]);
        assert.equal(validateSpec(messageSpec({ destinations: ['instagram'], specialCategory: 'employment' })).ok, true);
    });

    it('a special category forces the narrow targeting: 18-65+, no genders, no exclusions, cities of 25 km or more', () => {
        const withTargeting = (targeting: Record<string, unknown>) => messageSpec({
            specialCategory: 'housing',
            adsets: [{ name: 'SA', targeting: { countries: ['SA'], ageMin: 18, advantageAudience: false, ...targeting } as Spec['adsets'][0]['targeting'], placements: 'automatic' }],
        });
        assert.equal(validateSpec(withTargeting({ ageMax: 65 })).ok, true);
        assert.deepEqual(problemsOf(withTargeting({ ageMin: 25 })), [{ field: 'adsets.0.targeting.ageMin', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(withTargeting({ ageMax: 50 })), [{ field: 'adsets.0.targeting.ageMax', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(withTargeting({ genders: [1] })), [{ field: 'adsets.0.targeting.genders', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(withTargeting({ excludeAudiences: ['123'] })), [{ field: 'adsets.0.targeting.excludeAudiences', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(withTargeting({ cities: [{ key: '2418956', radiusKm: 20 }] })), [{ field: 'adsets.0.targeting.cities.0.radiusKm', code: 'INVALID' }]);
        assert.equal(validateSpec(withTargeting({ cities: [{ key: '2418956', radiusKm: 25 }] })).ok, true);
    });

    it('lead ads are UNSUPPORTED until A10', () => {
        const r = validateSpec({ ...messageSpec(), goal: 'leads' });
        assert.equal(r.ok, false);
        assert.deepEqual(!r.ok && r.problems.map(p => [p.field, p.code]), [['goal', 'UNSUPPORTED']]);
        assert.match(!r.ok ? r.problems[0]!.message : '', /A10/);
    });

    it('an EU country is refused: the DSA payor and beneficiary are not collected', () => {
        const spec = messageSpec({ adsets: [{ name: 'EU', targeting: { countries: ['SA', 'de'], ageMin: 18, advantageAudience: true }, placements: 'automatic' }] });
        assert.deepEqual(problemsOf(spec), [{ field: 'adsets.0.targeting.countries', code: 'UNSUPPORTED' }]);
    });

    it('a Facebook post cannot carry a link-clicks button (as v1), and media ads are messages or traffic only', () => {
        const traffic = (creative: Spec['ads'][0]['creative']): Spec => ({
            ...messageSpec(), goal: 'traffic', destinations: undefined, ads: [{ adsetIndex: 0, name: 'A', creative, copy: { primaryText: 'x' }, link: { url: 'https://example.com' } }],
        });
        assert.deepEqual(problemsOf(traffic({ source: 'post', postId: 'fb1', platform: 'facebook' })), [{ field: 'ads.0.creative', code: 'UNSUPPORTED' }]);
        assert.equal(validateSpec(traffic({ source: 'media', mediaId: 'img1' })).ok, true);
        const engagement = { ...traffic({ source: 'media', mediaId: 'img1' }), goal: 'engagement' as AdGoal };
        assert.deepEqual(problemsOf(engagement), [{ field: 'ads.0.creative', code: 'UNSUPPORTED' }]);
    });

    it('mapSpec throws INVALID for a post or media the server did not resolve', () => {
        const spec = messageSpec();
        assert.throws(() => mapSpec(spec, ctx({ posts: {} })), (e: unknown) => e instanceof SpecError && e.field === 'ads.0.creative.postId');
        const media = { ...spec, ads: [{ ...spec.ads[0]!, creative: { source: 'media' as const, mediaId: 'nope' } }] };
        assert.throws(() => mapSpec(media, ctx()), (e: unknown) => e instanceof SpecError && e.field === 'ads.0.creative.mediaId');
    });
});

describe('the v1 goals', () => {
    const goalSpec = (goal: AdGoal, over: Partial<Spec['ads'][0]> = {}): Spec => ({
        ...messageSpec(), goal, destinations: undefined,
        ads: [{ adsetIndex: 0, name: 'A', creative: { source: 'post', postId: 'ig1', platform: 'instagram' }, copy: { primaryText: '' }, ...over }],
    });

    it('engagement: POST_ENGAGEMENT on the post; reach: REACH with the page', () => {
        const eng = mapSpec(goalSpec('engagement'), ctx());
        assert.equal(eng.campaign['objective'], 'OUTCOME_ENGAGEMENT');
        assert.equal(eng.adsets[0]!['optimization_goal'], 'POST_ENGAGEMENT');
        assert.equal(eng.adsets[0]!['destination_type'], 'ON_POST');
        const reach = mapSpec(goalSpec('reach'), ctx());
        assert.equal(reach.campaign['objective'], 'OUTCOME_AWARENESS');
        assert.equal(reach.adsets[0]!['optimization_goal'], 'REACH');
        assert.deepEqual(reach.adsets[0]!['promoted_object'], { page_id: '100200300' });
        assert.equal('destination_type' in reach.adsets[0]!, false);
    });

    it('traffic: LINK_CLICKS, no destination_type, the link from the minted offer link', () => {
        const p = mapSpec(goalSpec('traffic', { link: { trackedOfferId: 'offer1' } }), ctx());
        assert.equal(p.campaign['objective'], 'OUTCOME_TRAFFIC');
        assert.equal(p.adsets[0]!['optimization_goal'], 'LINK_CLICKS');
        assert.equal('destination_type' in p.adsets[0]!, false);
        assert.deepEqual((p.creatives[0]!['call_to_action'] as { value: unknown }).value, { link: 'https://autoreply.example.com/r/abc123' });
        assert.deepEqual(p.warnings, []);
        assert.throws(() => mapSpec(goalSpec('traffic', { link: { trackedOfferId: 'ghost' } }), ctx()), (e: unknown) => e instanceof SpecError && e.field === 'ads.0.link.trackedOfferId');
    });

    it('traffic: a free URL works but warns UNTRACKED_LINK; a non-https URL is refused', () => {
        const p = mapSpec(goalSpec('traffic', { link: { url: 'https://example.com/learn' } }), ctx());
        assert.equal((p.creatives[0]!['call_to_action'] as { value: { link: string } }).value.link, 'https://example.com/learn');
        assert.deepEqual(p.warnings.map(w => [w.code, w.field]), [['UNTRACKED_LINK', 'ads.0.link']]);
        assert.match(p.warnings[0]!.message, /will not be counted/);
        assert.deepEqual(problemsOf(goalSpec('traffic', { link: { url: 'http://example.com' } })), [{ field: 'ads.0.link.url', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(goalSpec('traffic', { link: { url: 'javascript:alert(1)' } })), [{ field: 'ads.0.link.url', code: 'INVALID' }]);
        assert.deepEqual(problemsOf(goalSpec('traffic')), [{ field: 'ads.0.link', code: 'INVALID' }]);
    });

    it('post creatives: IG carries the media ids; FB carries object_story_id', () => {
        const ig = mapSpec(goalSpec('engagement'), ctx()).creatives[0]!;
        assert.equal(ig['object_id'], '100200300');
        assert.equal(ig['instagram_user_id'], '17841400000000000');
        assert.equal(ig['source_instagram_media_id'], '18000000000000001');
        const fb = mapSpec(goalSpec('engagement', { creative: { source: 'post', postId: 'fb1', platform: 'facebook' } }), ctx());
        assert.equal(fb.creatives[0]!['object_story_id'], '100200300_999');
        assert.equal('object_id' in fb.creatives[0]!, false);
        assert.equal((fb.adsets[0]!['targeting'] as Record<string, unknown>)['publisher_platforms'] !== undefined, true);
    });

    it("the ad set's publisher_platforms follow the post's platform when placements are automatic, and the explicit ones otherwise", () => {
        const auto = mapSpec(goalSpec('engagement'), ctx()).adsets[0]!['targeting'] as Record<string, unknown>;
        assert.deepEqual(auto['publisher_platforms'], ['instagram']);
        const explicit = goalSpec('engagement');
        explicit.adsets[0]!.placements = { instagram: ['stream', 'story'], facebook: ['feed'] };
        const t = mapSpec(explicit, ctx()).adsets[0]!['targeting'] as Record<string, unknown>;
        assert.deepEqual(t['publisher_platforms'], ['facebook', 'instagram']);
        assert.deepEqual(t['instagram_positions'], ['stream', 'story']);
        assert.deepEqual(t['facebook_positions'], ['feed']);
        const media = goalSpec('engagement');
        media.ads[0]!.creative = { source: 'media', mediaId: 'img1' };
        const m = (() => { try { return mapSpec({ ...media, goal: 'traffic', ads: [{ ...media.ads[0]!, link: { url: 'https://example.com' } }] }, ctx()).adsets[0]!['targeting'] as Record<string, unknown>; } catch { return {}; } })();
        assert.equal('publisher_platforms' in m, false, 'a media ad is not tied to one platform');
    });

    it('targeting carries cities, genders, locales, interests and audiences in Graph shape', () => {
        const spec = goalSpec('engagement');
        spec.adsets[0]!.targeting = {
            countries: ['SA'], ageMin: 25, ageMax: 40, advantageAudience: false, genders: [1], locales: [28],
            cities: [{ key: '2418956', radiusKm: 30 }], interests: [{ id: '6003', name: 'Go' }], includeAudiences: ['111'], excludeAudiences: ['222'],
        };
        const t = mapSpec(spec, ctx()).adsets[0]!['targeting'] as Record<string, unknown>;
        assert.deepEqual(t['geo_locations'], { cities: [{ key: '2418956', radius: 30, distance_unit: 'kilometer' }] });
        assert.deepEqual(t['genders'], [1]);
        assert.deepEqual(t['locales'], [28]);
        assert.deepEqual(t['flexible_spec'], [{ interests: [{ id: '6003', name: 'Go' }] }]);
        assert.deepEqual(t['custom_audiences'], [{ id: '111' }]);
        assert.deepEqual(t['excluded_custom_audiences'], [{ id: '222' }]);
    });
});

describe('boostToSpec: the v1 Boost as a preset', () => {
    function v1(objective: 'ENGAGEMENT' | 'AWARENESS' | 'TRAFFIC', platform: 'instagram' | 'facebook', link: string | null): BoostSpec {
        return {
            boostId: 'b1', adAccountId: '509787248064459', platform, objective, country: 'SA', link, dailyBudget: 5, days: 3, currency: 'USD', pageId: '100200300',
            igUserId: '17841400000000000', mediaId: platform === 'instagram' ? '18000000000000001' : '100200300_999',
        };
    }
    const objectiveCases: Array<['ENGAGEMENT' | 'AWARENESS' | 'TRAFFIC', 'instagram' | 'facebook', string | null]> = [
        ['ENGAGEMENT', 'instagram', null], ['ENGAGEMENT', 'facebook', null], ['AWARENESS', 'instagram', null], ['AWARENESS', 'facebook', null],
        ['TRAFFIC', 'instagram', 'https://example.com/learn'],
    ];

    it('produces the payload v1 would have sent, on the meaningful fields', () => {
        for (const [objective, platform, link] of objectiveCases) {
            const old = v1(objective, platform, link);
            const spec = boostToSpec({
                postId: platform === 'instagram' ? 'ig1' : 'fb1', platform, dailyBudget: 5, days: 3, objective, country: 'SA', ...(link ? { link } : {}),
            }, NOW);
            const r = validateSpec(spec);
            assert.equal(r.ok, true, `${objective}/${platform}: ${JSON.stringify(!r.ok && r.problems)}`);
            const p = mapSpec(spec, ctx());
            const label = `${objective}/${platform}`;
            assert.equal(p.campaign['objective'], buildCampaignParams(old)['objective'], label);
            assert.equal(p.campaign['status'], 'PAUSED');
            const o = buildAdSetParams(old, 'C', NOW);
            const n = p.adsets[0]!;
            for (const key of ['optimization_goal', 'destination_type', 'lifetime_budget', 'start_time', 'end_time', 'billing_event', 'bid_strategy', 'promoted_object']) {
                assert.deepEqual(n[key], o[key], `${label} ${key}`);
            }
            const ot = o['targeting'] as Record<string, unknown>; const nt = n['targeting'] as Record<string, unknown>;
            for (const key of ['geo_locations', 'age_min', 'publisher_platforms', 'targeting_automation']) assert.deepEqual(nt[key], ot[key], `${label} targeting.${key}`);
            const oc = buildCreativeParams(old); const nc = p.creatives[0]!;
            for (const key of ['object_id', 'instagram_user_id', 'source_instagram_media_id', 'object_story_id', 'call_to_action']) assert.deepEqual(nc[key], oc[key], `${label} creative.${key}`);
        }
    });

    it('MESSAGES with destinations, greeting and ice breakers makes a message ad', () => {
        const spec = boostToSpec({
            postId: 'ig1', platform: 'instagram', dailyBudget: 5, days: 3, objective: 'MESSAGES', country: 'SA',
            destinations: ['instagram', 'messenger'], greeting: 'Hi!', iceBreakers: [{ title: 'Price?' }],
        }, NOW);
        assert.equal(spec.goal, 'messages');
        assert.deepEqual(spec.destinations, ['instagram', 'messenger']);
        assert.equal(spec.budget.kind, 'lifetime');
        assert.equal(spec.budget.amount, 15);
        assert.equal(spec.budget.end, '2026-10-25T10:00:00.000Z');
        assert.equal(validateSpec(spec).ok, true);
        const p = mapSpec(spec, ctx());
        assert.equal(p.adsets[0]!['destination_type'], 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER');
        assert.equal(p.adsets[0]!['optimization_goal'], 'CONVERSATIONS');
        const feed = p.creatives[0]!['asset_feed_spec'] as { call_to_actions: unknown[] };
        assert.equal(feed.call_to_actions.length, 2);
        assert.equal(JSON.stringify(p.creatives[0]).includes('"Price?"'), false, 'a post creative carries no greeting (Meta refuses it)');
        assert.equal(p.warnings[0]?.code, 'NO_GREETING_ON_POST');
        assert.deepEqual(p.campaign['special_ad_categories'], []);
    });

    it('MESSAGES without a destination does not validate, and a Facebook post cannot be used', () => {
        const none = boostToSpec({ postId: 'ig1', platform: 'instagram', dailyBudget: 5, days: 3, objective: 'MESSAGES', country: 'SA' }, NOW);
        assert.deepEqual(problemsOf(none), [{ field: 'destinations', code: 'INVALID' }]);
        const fb = boostToSpec({ postId: 'fb1', platform: 'facebook', dailyBudget: 5, days: 3, objective: 'MESSAGES', country: 'SA', destinations: ['messenger'] }, NOW);
        assert.deepEqual(problemsOf(fb), [{ field: 'ads.0.creative', code: 'UNSUPPORTED' }]);
    });
});

describe('validateSpec: garbage', () => {
    it('rejects non-objects with a problem rather than throwing', () => {
        for (const junk of [null, undefined, 5, 'x', [], true]) {
            const r = validateSpec(junk);
            assert.equal(r.ok, false);
            assert.equal(!r.ok && r.problems[0]!.field, 'spec');
        }
    });

    it('names the field of each defect', () => {
        const fields = (mutate: (s: Record<string, any>) => void): string[] => { // eslint-disable-line @typescript-eslint/no-explicit-any
            const s = JSON.parse(JSON.stringify(messageSpec())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
            mutate(s);
            return problemsOf(s).map(p => p.field);
        };
        assert.deepEqual(fields(s => { delete s['ads']; }), ['ads']);
        assert.deepEqual(fields(s => { s['ads'] = []; }), ['ads']);
        assert.deepEqual(fields(s => { delete s['adsets']; }), ['adsets']);
        assert.deepEqual(fields(s => { s['ads'][0].adsetIndex = 3; }), ['ads.0.adsetIndex']);
        assert.deepEqual(fields(s => { s['ads'][0].adsetIndex = -1; }), ['ads.0.adsetIndex']);
        assert.deepEqual(fields(s => { s['adsets'][0].targeting.countries = ['XYZ']; }), ['adsets.0.targeting.countries']);
        assert.deepEqual(fields(s => { s['adsets'][0].targeting.countries = []; }), ['adsets.0.targeting.countries']);
        assert.deepEqual(fields(s => { s['adsets'][0].targeting.ageMin = 12; }), ['adsets.0.targeting.ageMin']);
        assert.deepEqual(fields(s => { s['adsets'][0].targeting.ageMin = NaN; }), ['adsets.0.targeting.ageMin']);
        assert.deepEqual(fields(s => { s['adsets'][0].targeting.advantageAudience = 'yes'; }), ['adsets.0.targeting.advantageAudience']);
        assert.deepEqual(fields(s => { s['budget'].amount = null; }), ['budget.amount']);
        assert.deepEqual(fields(s => { delete s['budget']; }), ['budget']);
        assert.deepEqual(fields(s => { s['name'] = '  '; }), ['name']);
        assert.deepEqual(fields(s => { s['goal'] = 'sales'; }), ['goal']);
        assert.deepEqual(fields(s => { s['specialCategory'] = 'crypto'; }), ['specialCategory']);
        assert.deepEqual(fields(s => { s['ads'][0].creative = { source: 'post', postId: '', platform: 'instagram' }; }), ['ads.0.creative.postId']);
        assert.deepEqual(fields(s => { s['ads'][0].creative = { source: 'nope' }; }), ['ads.0.creative.source']);
        assert.deepEqual(fields(s => { s['ads'][0].message.greeting = 7; }), ['ads.0.message.greeting']);
        assert.deepEqual(fields(s => { s['adsets'][0].placements = {}; }), ['adsets.0.placements']);
    });

    it('collects several problems at once and returns a clean copy on success', () => {
        const s = JSON.parse(JSON.stringify(messageSpec())) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        s['budget'].amount = 0; s['adsets'][0].targeting.countries = ['??']; s['ads'][0].message.greeting = 'x'.repeat(301);
        assert.deepEqual(problemsOf(s).map(p => p.field).sort(), ['ads.0.message.greeting', 'adsets.0.targeting.countries', 'budget.amount']);
        const ok = validateSpec(messageSpec({ adsets: [{ name: 'SA', targeting: { countries: [' sa '], ageMin: 18, advantageAudience: true }, placements: 'automatic' }] }));
        assert.equal(ok.ok, true);
        assert.deepEqual(ok.ok && ok.spec.adsets[0]!.targeting.countries, ['SA'], 'countries come back normalised');
    });
});
