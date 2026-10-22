/**
 * Boost's pure half: the money (units, the daily max, the monthly cap), the payload of each Meta object, and reading Meta's answers. Plus
 * the two properties of the Graph half that matter for spending: a create that may have landed is never retried, and activation switches
 * the campaign on LAST. No call here reaches Meta: `metaHttp` is stubbed.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { metaHttp } from './http.js';
import {
    activateBoostObjects, buildAdParams, buildAdSetActivationParams, buildAdSetParams, buildCampaignParams, buildCreativeParams,
    checkBoostBudget, createPausedBoost, currencyOffset, pickAdAccount, graphTime, normaliseAdAccountId, normaliseCountry, normaliseLink, objectiveProblem,
    readEligibility, readInsights, storyIdIfComplete, toMinorUnits, type BoostSpec,
} from './metaAds.js';

const NOW = new Date('2026-10-22T10:00:00.000Z');

function spec(over: Partial<BoostSpec> = {}): BoostSpec {
    return {
        boostId: '11111111-2222-3333-4444-555555555555',
        adAccountId: '509787248064459',
        platform: 'instagram',
        objective: 'ENGAGEMENT',
        country: 'SA',
        link: null,
        dailyBudget: 5,
        days: 3,
        currency: 'USD',
        pageId: '100200300',
        igUserId: '17841400000000000',
        mediaId: '18000000000000001',
        ...over,
    };
}

const LIMITS = { maxDailyBudget: 10, monthlyCap: 100 };

describe('money', () => {
    it('sends hundredths for most currencies and whole units for the zero-decimal ones', () => {
        assert.equal(currencyOffset('USD'), 100);
        assert.equal(currencyOffset('sar'), 100);
        assert.equal(currencyOffset('JPY'), 1);
        assert.equal(toMinorUnits(5, 'USD'), 500);
        assert.equal(toMinorUnits(53.75, 'EGP'), 5375);
        assert.equal(toMinorUnits(19.99, 'USD'), 1999, 'no float drift: 19.99 * 100 is 1998.9999…');
        assert.equal(toMinorUnits(500, 'JPY'), 500);
    });
});

describe('checkBoostBudget: the spend guard', () => {
    it('accepts a boost inside every limit and gives its planned total', () => {
        const check = checkBoostBudget({ dailyBudget: 5, days: 3, limits: LIMITS, committedThisMonth: 0 });
        assert.deepEqual(check, { ok: true, dailyBudget: 5, plannedTotal: 15 });
    });

    it('refuses a daily budget over the max, by a cent', () => {
        const check = checkBoostBudget({ dailyBudget: 10.01, days: 1, limits: LIMITS, committedThisMonth: 0 });
        assert.equal(check.ok, false);
        assert.equal(!check.ok && check.code, 'BUDGET_OVER_DAILY_MAX');
        assert.equal(checkBoostBudget({ dailyBudget: 10, days: 1, limits: LIMITS, committedThisMonth: 0 }).ok, true, 'exactly the max is allowed');
    });

    it('refuses a total that would pass the monthly cap, counting what is already committed', () => {
        const over = checkBoostBudget({ dailyBudget: 10, days: 3, limits: LIMITS, committedThisMonth: 70.01 });
        assert.equal(!over.ok && over.code, 'BUDGET_OVER_MONTHLY_CAP');
        assert.match(!over.ok ? over.message : '', /29\.99/, 'says how much of the cap is left');
        assert.equal(checkBoostBudget({ dailyBudget: 10, days: 3, limits: LIMITS, committedThisMonth: 70 }).ok, true, 'exactly the cap is allowed');
    });

    it('compares in cents, so 0.1 + 0.2 does not tip a boost over', () => {
        const check = checkBoostBudget({ dailyBudget: 0.1, days: 3, limits: { maxDailyBudget: 1, monthlyCap: 0.5 }, committedThisMonth: 0.2 });
        assert.equal(check.ok, true);
    });

    it("refuses a budget under Meta's minimum for the account when it is known", () => {
        const check = checkBoostBudget({ dailyBudget: 50, days: 1, limits: { maxDailyBudget: 100, monthlyCap: 1000 }, committedThisMonth: 0, minDailyBudget: 53.75 });
        assert.equal(!check.ok && check.code, 'BUDGET_UNDER_MINIMUM');
    });

    it('refuses rather than spends when a limit is missing', () => {
        for (const limits of [{ maxDailyBudget: 0, monthlyCap: 100 }, { maxDailyBudget: 10, monthlyCap: NaN }]) {
            assert.equal(checkBoostBudget({ dailyBudget: 1, days: 1, limits, committedThisMonth: 0 }).ok, false);
        }
    });

    it('refuses nonsense days and amounts', () => {
        for (const days of [0, 31, 2.5, '3', null]) {
            const check = checkBoostBudget({ dailyBudget: 5, days, limits: LIMITS, committedThisMonth: 0 });
            assert.equal(!check.ok && check.field, 'days', `days ${String(days)}`);
        }
        for (const dailyBudget of [0, -5, 0.001, Infinity, '5', null]) {
            const check = checkBoostBudget({ dailyBudget, days: 3, limits: LIMITS, committedThisMonth: 0 });
            assert.equal(!check.ok && check.field, 'dailyBudget', `budget ${String(dailyBudget)}`);
        }
    });
});

describe('inputs', () => {
    it('reads an ad account id with or without act_', () => {
        assert.equal(normaliseAdAccountId('act_509787248064459'), '509787248064459');
        assert.equal(normaliseAdAccountId(' 509787248064459 '), '509787248064459');
        for (const bad of ['act_', 'abc', '12', 42, null]) assert.equal(normaliseAdAccountId(bad), null);
    });

    it('reads a country and an https link', () => {
        assert.equal(normaliseCountry('sa'), 'SA');
        assert.equal(normaliseCountry('SAU'), null);
        assert.equal(normaliseLink('https://example.com/x'), 'https://example.com/x');
        for (const bad of ['http://example.com', 'javascript:alert(1)', 'https://localhost', 'nope']) assert.equal(normaliseLink(bad), null, bad);
    });

    it('keeps link clicks to Instagram, and requires the link', () => {
        assert.equal(objectiveProblem('instagram', 'ENGAGEMENT', null), null);
        assert.equal(objectiveProblem('facebook', 'AWARENESS', null), null);
        assert.match(objectiveProblem('facebook', 'TRAFFIC', 'https://x.co') ?? '', /Instagram/);
        assert.match(objectiveProblem('instagram', 'TRAFFIC', null) ?? '', /link/);
        assert.equal(objectiveProblem('instagram', 'TRAFFIC', 'https://x.co'), null);
    });

    it('knows a complete Facebook story id from a bare photo or video id', () => {
        assert.equal(storyIdIfComplete('100200300_400500600'), '100200300_400500600');
        assert.equal(storyIdIfComplete('400500600'), null);
    });
});

describe('pickAdAccount: what Connect fills in on its own', () => {
    const a = (id: string, status = 1) => ({ id, name: id, currency: 'USD', status });
    it('takes the only active account', () => {
        assert.equal(pickAdAccount([a('111111'), a('222222', 2)], null), '111111');
    });
    it('keeps the saved account while the token still reaches it', () => {
        assert.equal(pickAdAccount([a('111111'), a('222222')], '222222'), '222222');
    });
    it('leaves a real choice to the owner, and an unreachable saved one is not kept', () => {
        assert.equal(pickAdAccount([a('111111'), a('222222')], null), null);
        assert.equal(pickAdAccount([a('111111'), a('222222')], '999999'), null);
        assert.equal(pickAdAccount([], null), null);
    });
});

describe('payloads: everything is created PAUSED', () => {
    it('campaign: the objective, paused, no special category, no campaign budget', () => {
        const p = buildCampaignParams(spec());
        assert.equal(p['status'], 'PAUSED');
        assert.equal(p['objective'], 'OUTCOME_ENGAGEMENT');
        assert.deepEqual(p['special_ad_categories'], []);
        assert.equal(p['is_adset_budget_sharing_enabled'], false);
        assert.equal(p['daily_budget'], undefined);
        assert.match(String(p['name']), /11111111-2222-3333-4444-555555555555/, 'the boost id is in the name, so an orphan can be found');
        assert.equal(buildCampaignParams(spec({ objective: 'AWARENESS' }))['objective'], 'OUTCOME_AWARENESS');
        assert.equal(buildCampaignParams(spec({ objective: 'TRAFFIC' }))['objective'], 'OUTCOME_TRAFFIC');
    });

    it('ad set: a LIFETIME budget of daily × days in minor units, the window, the country, paused', () => {
        const p = buildAdSetParams(spec({ dailyBudget: 7.5, days: 4 }), 'c1', NOW);
        assert.equal(p['status'], 'PAUSED');
        assert.equal(p['campaign_id'], 'c1');
        assert.equal(p['lifetime_budget'], 3000);
        assert.equal(p['daily_budget'], undefined, 'never a daily budget: Meta may overspend one by 75% on a day');
        assert.equal(p['start_time'], '2026-10-22T10:00:00+0000');
        assert.equal(p['end_time'], '2026-10-26T10:00:00+0000');
        assert.equal(p['optimization_goal'], 'POST_ENGAGEMENT');
        assert.equal(p['destination_type'], 'ON_POST');
        assert.equal(p['billing_event'], 'IMPRESSIONS');
        const targeting = p['targeting'] as Record<string, any>;
        assert.deepEqual(targeting['geo_locations'], { countries: ['SA'] });
        assert.deepEqual(targeting['publisher_platforms'], ['instagram']);
        assert.equal(targeting['targeting_automation'].advantage_audience, 1);
    });

    it('ad set: reach promotes the Page, link clicks go to a website', () => {
        const reach = buildAdSetParams(spec({ objective: 'AWARENESS' }), 'c1', NOW);
        assert.equal(reach['optimization_goal'], 'REACH');
        assert.deepEqual(reach['promoted_object'], { page_id: '100200300' });
        const traffic = buildAdSetParams(spec({ objective: 'TRAFFIC', link: 'https://x.co/' }), 'c1', NOW);
        assert.equal(traffic['optimization_goal'], 'LINK_CLICKS');
        assert.equal(traffic['destination_type'], undefined, 'Meta documents no destination_type for Traffic: the link is the call to action');
    });

    it('ad set: a whole-unit currency is not multiplied by 100', () => {
        assert.equal(buildAdSetParams(spec({ currency: 'JPY', dailyBudget: 500, days: 2 }), 'c1', NOW)['lifetime_budget'], 1000);
    });

    it('creative, Instagram: the Page, the IG account and the media, with the v25+ field names', () => {
        const p = buildCreativeParams(spec());
        assert.equal(p['object_id'], '100200300');
        assert.equal(p['instagram_user_id'], '17841400000000000');
        assert.equal(p['source_instagram_media_id'], '18000000000000001');
        assert.equal(p['instagram_actor_id'], undefined);
        assert.equal(p['instagram_story_id'], undefined);
        assert.equal(p['call_to_action'], undefined);
        const traffic = buildCreativeParams(spec({ objective: 'TRAFFIC', link: 'https://x.co/' }));
        assert.deepEqual(traffic['call_to_action'], { type: 'LEARN_MORE', value: { link: 'https://x.co/' } });
    });

    it('creative, Facebook: the story id and nothing else', () => {
        const p = buildCreativeParams(spec({ platform: 'facebook', mediaId: '100200300_400500600', igUserId: null }));
        assert.equal(p['object_story_id'], '100200300_400500600');
        assert.equal(p['source_instagram_media_id'], undefined);
    });

    it('ad: the creative in the ad set, paused', () => {
        assert.deepEqual(buildAdParams(spec(), 'as1', 'cr1'), {
            name: 'AutoReply boost 11111111-2222-3333-4444-555555555555 · instagram · ad',
            adset_id: 'as1', creative: { creative_id: 'cr1' }, status: 'PAUSED',
        });
    });

    it('activation moves the window to start now', () => {
        assert.deepEqual(buildAdSetActivationParams(3, NOW), { status: 'ACTIVE', start_time: graphTime(NOW), end_time: '2026-10-25T10:00:00+0000' });
    });
});

describe("reading Meta's answers", () => {
    it('Instagram eligibility: yes, no with a reason, and "did not say"', () => {
        assert.deepEqual(readEligibility('instagram', { boost_eligibility_info: { eligible_to_boost: true } }), { eligible: true, reason: null });
        assert.deepEqual(
            readEligibility('instagram', { boost_eligibility_info: { eligible_to_boost: false, ineligible_reason: 'Copyrighted music' } }),
            { eligible: false, reason: 'Copyrighted music' }
        );
        assert.equal(readEligibility('instagram', { boost_eligibility_info: { eligible_to_boost: false } }).reason !== null, true);
        assert.deepEqual(readEligibility('instagram', { id: '1' }), { eligible: null, reason: null });
    });

    it('Facebook eligibility', () => {
        assert.equal(readEligibility('facebook', { is_eligible_for_promotion: true }).eligible, true);
        assert.equal(readEligibility('facebook', { is_eligible_for_promotion: false }).eligible, false);
        assert.equal(readEligibility('facebook', {}).eligible, null);
    });

    it("insights: spend in major units, and the objective's own result", () => {
        const data = { data: [{ spend: '12.345', reach: '900', impressions: '1500', clicks: '40', cpm: '8.2', actions: [{ action_type: 'post_engagement', value: '75' }, { action_type: 'link_click', value: '30' }] }] };
        assert.deepEqual(readInsights('ENGAGEMENT', data), { spend: 12.35, reach: 900, impressions: 1500, clicks: 40, cpm: 8.2, results: 75 });
        assert.equal(readInsights('TRAFFIC', data)?.results, 30);
        assert.equal(readInsights('AWARENESS', data)?.results, 900);
        assert.equal(readInsights('ENGAGEMENT', { data: [] }), null);
    });
});

describe('Graph calls (stubbed)', () => {
    const realPost = metaHttp.post;
    afterEach(() => {
        metaHttp.post = realPost;
    });

    it('never retries a create that timed out: it may have landed', async () => {
        let calls = 0;
        metaHttp.post = (async () => {
            calls++;
            throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        }) as typeof metaHttp.post;
        const progress: unknown[] = [];
        await assert.rejects(createPausedBoost(spec(), 'tok', NOW, async (ids) => { progress.push(ids); }), /campaign/);
        assert.equal(calls, 1, 'one attempt, no retry');
        assert.deepEqual(progress, [], 'nothing reported as created');
    });

    it('creates campaign → ad set → creative → ad in order, every one PAUSED, and reports each id as it exists', async () => {
        const sent: Array<{ url: string; body: URLSearchParams }> = [];
        metaHttp.post = (async (url: string, body: URLSearchParams) => {
            sent.push({ url, body });
            return { data: { id: `id${sent.length}` } };
        }) as typeof metaHttp.post;
        const progress: unknown[] = [];
        const ids = await createPausedBoost(spec(), 'tok', NOW, async (soFar) => { progress.push(soFar); });
        assert.deepEqual(ids, { campaignId: 'id1', adsetId: 'id2', creativeId: 'id3', adId: 'id4' });
        assert.deepEqual(sent.map((s) => s.url.replace(/^.*\/v\d+\.\d+\//, '')), [
            'act_509787248064459/campaigns', 'act_509787248064459/adsets', 'act_509787248064459/adcreatives', 'act_509787248064459/ads',
        ]);
        for (const s of [sent[0]!, sent[1]!, sent[3]!]) assert.equal(s.body.get('status'), 'PAUSED');
        assert.equal(sent[1]!.body.get('campaign_id'), 'id1');
        assert.deepEqual(JSON.parse(sent[1]!.body.get('targeting')!).geo_locations, { countries: ['SA'] }, 'nested params go as JSON');
        assert.equal(JSON.parse(sent[3]!.body.get('creative')!).creative_id, 'id3');
        assert.equal(progress.length, 4);
        assert.deepEqual(progress[1], { campaignId: 'id1', adsetId: 'id2' });
    });

    it('a failure half way reports what exists, so it can be deleted', async () => {
        let n = 0;
        metaHttp.post = (async () => {
            n++;
            if (n === 3) throw { response: { status: 400, data: { error: { code: 100, message: 'Invalid parameter' } } } };
            return { data: { id: `id${n}` } };
        }) as typeof metaHttp.post;
        let last: unknown = null;
        await assert.rejects(createPausedBoost(spec(), 'tok', NOW, async (ids) => { last = ids; }), /creative.*Invalid parameter/);
        assert.deepEqual(last, { campaignId: 'id1', adsetId: 'id2' });
    });

    it('activates the ad, then the ad set, then the campaign last', async () => {
        const order: string[] = [];
        metaHttp.post = (async (url: string, body: URLSearchParams) => {
            order.push(`${url.split('/').pop()}:${body.get('status')}`);
            return { data: { success: true } };
        }) as typeof metaHttp.post;
        await activateBoostObjects({ campaignId: 'C', adsetId: 'S', adId: 'A' }, 3, 'tok', NOW);
        assert.deepEqual(order, ['A:ACTIVE', 'S:ACTIVE', 'C:ACTIVE']);
    });
});
