/**
 * Audiences (spec 002, T148; research.md R15; research/01-capabilities.md section 5; contracts/meta-graph.md).
 *
 * What is pinned:
 *   - the exact engagement rule JSON Meta receives (Instagram, Page, messagers) and the legacy video rule array;
 *   - retention bounds (730 days for Instagram/Page/messagers, 365 for video), lookalike ratio steps and the seed minimum;
 *   - how a Meta read row becomes a status (flagged 471, too small, still being built, unknown sizes);
 *   - Meta's "Custom Audience Terms not accepted" error (200 / 1870090);
 *   - names that imply sensitive data (health, finances, religion, the DM bot's own segments) are refused, neutral ones are not;
 *   - what a campaign may target: only a ready audience, and only the tenant's own.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import {
    applyAudienceReads, AudienceError, buildCreateParams, classifyAudienceRead, createExec, defaultAudienceName, getAudience,
    isTermsError, LOOKALIKE_RATIOS, MIN_SEED_SIZE, MIN_TARGET_SIZE, parseAudienceInput, RETENTION_MAX_DAYS, scrubSpecForView,
    SENSITIVE_NAME_TERMS, targetingAudiences, termsUrl, resolveSpecAudiences, toAudienceView, tosFromAccount, usability, validateAudienceName,
    type AudienceRow,
} from './audiences.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const A2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const A3 = 'cccccccc-3333-4333-8333-333333333333';
const IG = '17841400000000001';
const PAGE = '100000000000002';

function row(over: Partial<AudienceRow> = {}): AudienceRow {
    return {
        id: A1, creator_id: CREATOR, meta_id: '6001', kind: 'ig_engagement', name: 'تفاعل', spec: { event: 'engaged', retentionDays: 30 },
        status: 'ready', size_lower: '5000', size_upper: '6000', seed_audience_id: null, synced_at: new Date('2026-10-22T10:00:00Z'),
        created_at: new Date('2026-10-21T10:00:00Z'), ...over,
    };
}

function refused(fn: () => unknown, match: { code?: string; field?: string; reason?: string }): void {
    assert.throws(fn, (err: unknown) => {
        assert.ok(err instanceof AudienceError, `expected an AudienceError, got ${String(err)}`);
        if (match.code) assert.equal(err.code, match.code);
        if (match.field) assert.equal(err.field, match.field);
        if (match.reason) assert.equal(err.reason, match.reason);
        return true;
    });
}

describe('constants', () => {
    it('retention maxima, ratios and thresholds', () => {
        assert.deepEqual(RETENTION_MAX_DAYS, { ig_engagement: 730, page_engagement: 730, messagers: 730, video_viewers: 365 });
        assert.equal(MIN_SEED_SIZE, 100);
        assert.equal(MIN_TARGET_SIZE, 1000);
        assert.equal(LOOKALIKE_RATIOS.length, 20);
        assert.equal(LOOKALIKE_RATIOS[0], 0.01);
        assert.equal(LOOKALIKE_RATIOS[19], 0.2);
    });
});

describe('engagement rules', () => {
    it('Instagram engaged, 30 days: exact rule JSON', () => {
        const params = buildCreateParams('ig_engagement', 'تفاعل', { event: 'engaged', retentionDays: 30 }, { igUserId: IG, pageId: PAGE });
        assert.deepEqual(JSON.parse(params['rule'] as string), {
            inclusions: {
                operator: 'or',
                rules: [{
                    event_sources: [{ id: IG, type: 'ig_business' }],
                    retention_seconds: 30 * 86400,
                    filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'ig_business_profile_engaged' }] },
                }],
            },
        });
        assert.equal(params['prefill'], 1);
        assert.equal(params['name'], 'تفاعل');
        assert.deepEqual(Object.keys(params).sort(), ['name', 'prefill', 'rule']);
    });

    it('Instagram: every event maps to its Meta name', () => {
        const want = { engaged: 'ig_business_profile_engaged', all: 'ig_business_profile_all', visited: 'ig_business_profile_visit', messaged: 'ig_user_messaged_business' } as const;
        for (const [event, value] of Object.entries(want)) {
            const params = buildCreateParams('ig_engagement', 'x', { event: event as 'engaged', retentionDays: 7 }, { igUserId: IG, pageId: null });
            assert.equal(JSON.parse(params['rule'] as string).inclusions.rules[0].filter.filters[0].value, value);
        }
    });

    it('Instagram messaged, 90 days', () => {
        const params = buildCreateParams('ig_engagement', 'x', { event: 'messaged', retentionDays: 90 }, { igUserId: IG, pageId: null });
        assert.deepEqual(JSON.parse(params['rule'] as string).inclusions.rules[0], {
            event_sources: [{ id: IG, type: 'ig_business' }],
            retention_seconds: 7_776_000,
            filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'ig_user_messaged_business' }] },
        });
    });

    it('Page engaged: exact rule JSON', () => {
        const params = buildCreateParams('page_engagement', 'x', { event: 'engaged', retentionDays: 365 }, { igUserId: null, pageId: PAGE });
        assert.deepEqual(JSON.parse(params['rule'] as string), {
            inclusions: {
                operator: 'or',
                rules: [{
                    event_sources: [{ id: PAGE, type: 'page' }],
                    retention_seconds: 365 * 86400,
                    filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'page_engaged' }] },
                }],
            },
        });
    });

    it('Page: every event maps to its Meta name, messaged included', () => {
        const want = { engaged: 'page_engaged', visited: 'page_visited', cta: 'page_cta_clicked', saved: 'page_or_post_save', messaged: 'page_messaged' } as const;
        for (const [event, value] of Object.entries(want)) {
            const params = buildCreateParams('page_engagement', 'x', { event: event as 'engaged', retentionDays: 30 }, { igUserId: null, pageId: PAGE });
            assert.equal(JSON.parse(params['rule'] as string).inclusions.rules[0].filter.filters[0].value, value);
        }
    });

    it('messagers: one OR-ed rule per chosen source', () => {
        const both = buildCreateParams('messagers', 'x', { sources: ['instagram', 'page'], retentionDays: 60 }, { igUserId: IG, pageId: PAGE });
        assert.deepEqual(JSON.parse(both['rule'] as string).inclusions, {
            operator: 'or',
            rules: [
                { event_sources: [{ id: IG, type: 'ig_business' }], retention_seconds: 60 * 86400, filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'ig_user_messaged_business' }] } },
                { event_sources: [{ id: PAGE, type: 'page' }], retention_seconds: 60 * 86400, filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: 'page_messaged' }] } },
            ],
        });
        const onlyPage = buildCreateParams('messagers', 'x', { sources: ['page'], retentionDays: 60 }, { igUserId: null, pageId: PAGE });
        assert.equal(JSON.parse(onlyPage['rule'] as string).inclusions.rules.length, 1);
    });

    it('refuses when the needed Instagram account or Page is not connected', () => {
        refused(() => buildCreateParams('ig_engagement', 'x', { event: 'engaged', retentionDays: 30 }, { igUserId: null, pageId: PAGE }), { code: 'INVALID', reason: 'no_instagram' });
        refused(() => buildCreateParams('page_engagement', 'x', { event: 'engaged', retentionDays: 30 }, { igUserId: IG, pageId: null }), { code: 'INVALID', reason: 'no_page' });
        refused(() => buildCreateParams('messagers', 'x', { sources: ['instagram', 'page'], retentionDays: 30 }, { igUserId: IG, pageId: null }), { code: 'INVALID', reason: 'no_page' });
        refused(() => buildCreateParams('messagers', 'x', { sources: ['instagram'], retentionDays: 30 }, { igUserId: null, pageId: PAGE }), { code: 'INVALID', reason: 'no_instagram' });
    });
});

describe('video viewers', () => {
    it('watched 3 seconds: ENGAGEMENT subtype with the legacy array rule', () => {
        const params = buildCreateParams('video_viewers', 'x', { videoIds: ['111', '222'], watched: '3s', retentionDays: 30 }, { igUserId: null, pageId: PAGE });
        assert.deepEqual(params, {
            name: 'x', subtype: 'ENGAGEMENT', prefill: 1, retention_days: 30,
            rule: JSON.stringify([{ event_name: 'video_watched', object_id: '111' }, { event_name: 'video_watched', object_id: '222' }]),
        });
    });

    it('watched 95%: video_completed', () => {
        const params = buildCreateParams('video_viewers', 'x', { videoIds: ['111'], watched: '95', retentionDays: 365 }, { igUserId: null, pageId: PAGE });
        assert.equal(params['rule'], JSON.stringify([{ event_name: 'video_completed', object_id: '111' }]));
        assert.equal(params['retention_days'], 365);
    });

    it('the unconfirmed names are still mapped', () => {
        const names: Record<string, string> = { '25': 'video_view_25_percent', '50': 'video_view_50_percent', '75': 'video_view_75_percent', thruplay: 'thruplay_watched' };
        for (const [watched, event] of Object.entries(names)) {
            const params = buildCreateParams('video_viewers', 'x', { videoIds: ['1'], watched: watched as '25', retentionDays: 10 }, { igUserId: null, pageId: null });
            assert.equal(params['rule'], JSON.stringify([{ event_name: event, object_id: '1' }]));
        }
    });
});

describe('parseAudienceInput', () => {
    it('accepts each kind and returns the canonical spec', () => {
        assert.deepEqual(parseAudienceInput({ kind: 'ig_engagement', name: '  تفاعل  ', spec: { event: 'engaged', retentionDays: 30, extra: 1 } }),
            { kind: 'ig_engagement', name: 'تفاعل', spec: { event: 'engaged', retentionDays: 30 } });
        assert.deepEqual(parseAudienceInput({ kind: 'page_engagement', name: 'p', spec: { event: 'cta', retentionDays: 730 } }).spec, { event: 'cta', retentionDays: 730 });
        assert.deepEqual(parseAudienceInput({ kind: 'messagers', name: 'm', spec: { sources: ['page', 'page', 'instagram'], retentionDays: 5 } }).spec, { sources: ['page', 'instagram'], retentionDays: 5 });
        assert.deepEqual(parseAudienceInput({ kind: 'video_viewers', name: 'v', spec: { videoIds: ['123'], watched: 'thruplay', retentionDays: 365 } }).spec, { videoIds: ['123'], watched: 'thruplay', retentionDays: 365 });
        assert.deepEqual(parseAudienceInput({ kind: 'lookalike', name: 'l', spec: { seedAudienceId: A1, country: 'eg', ratio: 0.03 } }).spec, { seedAudienceId: A1, country: 'EG', ratio: 0.03 });
    });

    it('retention bounds: 730 days for Instagram, 365 for video', () => {
        parseAudienceInput({ kind: 'ig_engagement', name: 'x', spec: { event: 'engaged', retentionDays: 730 } });
        refused(() => parseAudienceInput({ kind: 'ig_engagement', name: 'x', spec: { event: 'engaged', retentionDays: 731 } }), { code: 'INVALID', field: 'spec.retentionDays' });
        refused(() => parseAudienceInput({ kind: 'page_engagement', name: 'x', spec: { event: 'engaged', retentionDays: 731 } }), { code: 'INVALID', field: 'spec.retentionDays' });
        refused(() => parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: ['1'], watched: '3s', retentionDays: 366 } }), { code: 'INVALID', field: 'spec.retentionDays' });
        for (const bad of [0, -1, 1.5, '30', null, NaN]) {
            refused(() => parseAudienceInput({ kind: 'ig_engagement', name: 'x', spec: { event: 'engaged', retentionDays: bad } }), { code: 'INVALID', field: 'spec.retentionDays' });
        }
    });

    it('video ids: 1 to 50 digit strings, and a known "watched"', () => {
        refused(() => parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: [], watched: '3s', retentionDays: 30 } }), { field: 'spec.videoIds' });
        refused(() => parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: Array.from({ length: 51 }, (_, i) => String(i + 1)), watched: '3s', retentionDays: 30 } }), { field: 'spec.videoIds' });
        refused(() => parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: ['12a'], watched: '3s', retentionDays: 30 } }), { field: 'spec.videoIds' });
        refused(() => parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: [12], watched: '3s', retentionDays: 30 } }), { field: 'spec.videoIds' });
        refused(() => parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: ['1'], watched: '60', retentionDays: 30 } }), { field: 'spec.watched' });
        assert.equal(parseAudienceInput({ kind: 'video_viewers', name: 'x', spec: { videoIds: Array.from({ length: 50 }, (_, i) => String(i + 1)), watched: '50', retentionDays: 30 } }).kind, 'video_viewers');
    });

    it('lookalike: ratio in 1% steps from 1% to 20%, country ISO-2', () => {
        for (const ratio of [0.01, 0.05, 0.2]) parseAudienceInput({ kind: 'lookalike', name: 'x', spec: { seedAudienceId: A1, country: 'SA', ratio } });
        for (const ratio of [0, 0.005, 0.015, 0.21, 0.25, -0.01, '0.01', null]) {
            refused(() => parseAudienceInput({ kind: 'lookalike', name: 'x', spec: { seedAudienceId: A1, country: 'SA', ratio } }), { code: 'INVALID', field: 'spec.ratio' });
        }
        refused(() => parseAudienceInput({ kind: 'lookalike', name: 'x', spec: { seedAudienceId: A1, country: 'SAU', ratio: 0.01 } }), { field: 'spec.country' });
        refused(() => parseAudienceInput({ kind: 'lookalike', name: 'x', spec: { seedAudienceId: 'nope', country: 'SA', ratio: 0.01 } }), { field: 'spec.seedAudienceId' });
    });

    it('a customer list has its own route', () => {
        refused(() => parseAudienceInput({ kind: 'customer_list', name: 'x', spec: {} }), { code: 'INVALID', field: 'kind', reason: 'use_customer_list_route' });
        refused(() => parseAudienceInput({ kind: 'nonsense', name: 'x', spec: {} }), { code: 'INVALID', field: 'kind' });
        refused(() => parseAudienceInput(null), { code: 'INVALID' });
        refused(() => parseAudienceInput({ kind: 'ig_engagement', name: 'x' }), { code: 'INVALID', field: 'spec' });
    });

    it('a blank name gets the neutral automatic name', () => {
        const parsed = parseAudienceInput({ kind: 'ig_engagement', name: '   ', spec: { event: 'engaged', retentionDays: 30 } });
        assert.equal(parsed.name, 'تفاعل إنستغرام · 30 يومًا');
    });
});

describe('names', () => {
    const neutral = ['زوار الصفحة آخر 30 يوم', 'Instagram engagers 30d', 'مشتركو الدورة', 'دورة الذكاء الاصطناعي', 'عملاء القاهرة', 'Workshop buyers Q4', 'مدينة الرياض', 'مشاهدو الفيديو 50%', 'آخر 3 سنين'];
    const sensitive = [
        'people with diabetes', 'Pregnant moms', 'Mental health seekers', 'مرضى السكري', 'مهتمون بالصحة', 'نساء حوامل', 'ذوي الإعاقة', 'علاج نفسي',
        'poor people', 'In debt', 'Loan seekers', 'low income', 'unemployed', 'فقراء ديون', 'عاطلون عن العمل', 'قرض شخصي', 'دخل منخفض', 'محتاج فلوس', 'مش قادر يدفع',
        'Muslim audience', 'Christian', 'مسلمون', 'مسيحي', 'gay men', 'مثلي', 'political views', 'اهتمامات سياسية', 'ديون',
        'price objection', 'hot lead', 'Cold lead', 'DM segment A', 'اعتراض السعر', 'متردد', 'السعر غالي',
    ];

    it('neutral names pass', () => {
        for (const name of neutral) assert.equal(validateAudienceName(name), name.trim(), name);
    });

    it('names implying sensitive data are refused with reason sensitive_name', () => {
        for (const name of sensitive) refused(() => validateAudienceName(name), { code: 'INVALID', field: 'name', reason: 'sensitive_name' });
    });

    it('matching ignores case, Arabic diacritics and letter variants', () => {
        refused(() => validateAudienceName('DiAbEtEs'), { reason: 'sensitive_name' });
        refused(() => validateAudienceName('مَرَض'), { reason: 'sensitive_name' });
        refused(() => validateAudienceName('اعتـــراض'), { reason: 'sensitive_name' });
        refused(() => validateAudienceName('الصحه'), { reason: 'sensitive_name' });
    });

    it('length: 1 to 100 characters after trimming', () => {
        refused(() => validateAudienceName('   '), { code: 'INVALID', field: 'name' });
        refused(() => validateAudienceName('x'.repeat(101)), { code: 'INVALID', field: 'name', reason: 'name_length' });
        assert.equal(validateAudienceName('x'.repeat(100)).length, 100);
    });

    it('the block list is exported and non-empty', () => assert.ok(SENSITIVE_NAME_TERMS.length > 40));

    it('every automatic name passes the check', () => {
        const names = [
            defaultAudienceName('ig_engagement', { event: 'engaged', retentionDays: 30 }),
            defaultAudienceName('page_engagement', { event: 'cta', retentionDays: 1 }),
            defaultAudienceName('messagers', { sources: ['instagram', 'page'], retentionDays: 2 }),
            defaultAudienceName('video_viewers', { videoIds: ['1'], watched: '50', retentionDays: 30 }),
            defaultAudienceName('video_viewers', { videoIds: ['1'], watched: 'thruplay', retentionDays: 11 }),
            defaultAudienceName('lookalike', { seedAudienceId: A1, country: 'EG', ratio: 0.01 }),
            defaultAudienceName('lookalike', { seedAudienceId: A1, country: 'SA', ratio: 0.2 }),
            defaultAudienceName('lookalike', { seedAudienceId: A1, country: 'ZZ', ratio: 0.2 }),
            defaultAudienceName('customer_list', { columns: ['PHONE'], rows_sent: 3, matched_estimate: null }),
        ];
        for (const name of names) assert.equal(validateAudienceName(name), name);
    });

    it('automatic names read as the contract examples', () => {
        assert.equal(defaultAudienceName('ig_engagement', { event: 'engaged', retentionDays: 30 }), 'تفاعل إنستغرام · 30 يومًا');
        assert.equal(defaultAudienceName('video_viewers', { videoIds: ['1'], watched: '50', retentionDays: 30 }), 'مشاهدو الفيديو · 50% · 30 يومًا');
        assert.equal(defaultAudienceName('lookalike', { seedAudienceId: A1, country: 'EG', ratio: 0.01 }), 'مشابه · مصر · 1%');
    });
});

describe('create params', () => {
    it('lookalike', () => {
        const params = buildCreateParams('lookalike', 'مشابه', { seedAudienceId: A1, country: 'EG', ratio: 0.02 }, { igUserId: null, pageId: null, seedMetaId: '6001' });
        assert.deepEqual(params, { name: 'مشابه', subtype: 'LOOKALIKE', origin_audience_id: '6001', lookalike_spec: JSON.stringify({ ratio: 0.02, country: 'EG' }) });
        refused(() => buildCreateParams('lookalike', 'x', { seedAudienceId: A1, country: 'EG', ratio: 0.02 }, { igUserId: null, pageId: null }), { code: 'INVALID' });
    });

    it('customer list shell', () => {
        assert.deepEqual(buildCreateParams('customer_list', 'قائمة', { columns: ['PHONE'], rows_sent: 10, matched_estimate: null }, { igUserId: null, pageId: null }),
            { name: 'قائمة', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' });
    });

    it('createExec targets the account edge (the queue tags the name itself)', () => {
        assert.deepEqual(createExec('act_1234567', { name: 'x' }), { method: 'POST', path: 'act_1234567/customaudiences', params: { name: 'x' }, edge: 'customaudiences' });
        assert.equal(createExec('1234567', { name: 'x' }).path, 'act_1234567/customaudiences');
        assert.throws(() => createExec('nope', {}));
    });
});

describe('classifyAudienceRead', () => {
    const base = { id: '6001', name: 'x', subtype: 'ENGAGEMENT', approximate_count_lower_bound: 5000, approximate_count_upper_bound: 6000, operation_status: { code: 200, description: 'Normal' }, delivery_status: { code: 200, description: 'Ready' } };

    it('ready with sizes', () => assert.deepEqual(classifyAudienceRead(base), { status: 'ready', sizeLower: 5000, sizeUpper: 6000 }));

    it('operation_status 471 is flagged, whatever else it says', () => {
        assert.equal(classifyAudienceRead({ ...base, operation_status: { code: 471, description: 'Sensitive' } }).status, 'flagged');
        assert.equal(classifyAudienceRead({ ...base, operation_status: { code: 471 }, delivery_status: { code: 300 } }).status, 'flagged');
    });

    it('delivery_status 300 is too small', () => {
        assert.equal(classifyAudienceRead({ ...base, delivery_status: { code: 300, description: 'Too small' } }).status, 'too_small');
    });

    it('an upper bound under 1,000 is too small when both bounds are known', () => {
        assert.deepEqual(classifyAudienceRead({ ...base, approximate_count_lower_bound: 100, approximate_count_upper_bound: 999 }), { status: 'too_small', sizeLower: 100, sizeUpper: 999 });
        assert.equal(classifyAudienceRead({ ...base, approximate_count_lower_bound: 0, approximate_count_upper_bound: 1000 }).status, 'ready');
    });

    it('-1 means unknown: null sizes, and no verdict on size', () => {
        assert.deepEqual(classifyAudienceRead({ ...base, approximate_count_lower_bound: -1, approximate_count_upper_bound: -1 }), { status: 'ready', sizeLower: null, sizeUpper: null });
        assert.equal(classifyAudienceRead({ ...base, approximate_count_lower_bound: 0, approximate_count_upper_bound: -1 }).status, 'ready');
    });

    it('414 and 441 are still being built', () => {
        assert.equal(classifyAudienceRead({ ...base, operation_status: { code: 414 } }).status, 'creating');
        assert.equal(classifyAudienceRead({ ...base, operation_status: { code: 441 }, approximate_count_lower_bound: -1, approximate_count_upper_bound: -1 }).status, 'creating');
    });

    it('sizes may arrive as numeric strings; missing fields are unknown', () => {
        assert.deepEqual(classifyAudienceRead({ id: '1', approximate_count_lower_bound: '2000', approximate_count_upper_bound: '3000' }), { status: 'ready', sizeLower: 2000, sizeUpper: 3000 });
        assert.deepEqual(classifyAudienceRead({ id: '1' }), { status: 'ready', sizeLower: null, sizeUpper: null });
        assert.deepEqual(classifyAudienceRead(null), { status: 'ready', sizeLower: null, sizeUpper: null });
    });
});

describe('terms', () => {
    it('Meta 200 / 1870090 is the Custom Audience Terms refusal, in every error shape we carry', () => {
        assert.equal(isTermsError({ metaCode: 200, metaSubcode: 1870090 }), true);
        assert.equal(isTermsError({ response: { data: { error: { code: 200, error_subcode: 1870090 } } } }), true);
        assert.equal(isTermsError({ code: 200, error_subcode: 1870090 }), true);
        assert.equal(isTermsError({ code: 200, error_subcode: 1 }), false);
        assert.equal(isTermsError({ code: 100, error_subcode: 1870090 }), false);
        assert.equal(isTermsError(null), false);
        assert.equal(isTermsError(new Error('x')), false);
    });

    it('the acceptance link names the account', () => {
        assert.equal(termsUrl('act_123456'), 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=123456');
        assert.equal(termsUrl('123456'), 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=123456');
    });

    it('tosFromAccount reads the ad account map, null when Meta did not say', () => {
        assert.deepEqual(tosFromAccount(null), { custom: null, lookalike: null });
        assert.deepEqual(tosFromAccount({ custom_audience_tos: 1 }), { custom: true, lookalike: null });
        assert.deepEqual(tosFromAccount({ custom_audience_tos: 0 }), { custom: false, lookalike: null });
        assert.deepEqual(tosFromAccount({ custom_audience_tos: 1, lookalike_audience_tos: 1 }), { custom: true, lookalike: true });
        assert.deepEqual(tosFromAccount({}), { custom: null, lookalike: null });
    });
});

describe('usability and views', () => {
    it('only a ready audience is usable', () => {
        assert.deepEqual(usability(row({ status: 'ready' })), { usable: true, unusableReason: null });
        for (const status of ['creating', 'too_small', 'flagged', 'deleted'] as const) {
            assert.deepEqual(usability(row({ status })), { usable: false, unusableReason: status });
        }
    });

    it('the view is the contract shape: sizes as numbers, ISO dates, the latest op', () => {
        const view = toAudienceView(row(), { id: 'op1', kind: 'audience_create', state: 'running' });
        assert.deepEqual(view, {
            id: A1, metaId: '6001', kind: 'ig_engagement', name: 'تفاعل', status: 'ready', sizeLower: 5000, sizeUpper: 6000, seedAudienceId: null,
            spec: { event: 'engaged', retentionDays: 30 }, syncedAt: '2026-10-22T10:00:00.000Z', createdAt: '2026-10-21T10:00:00.000Z',
            usable: true, unusableReason: null, op: { id: 'op1', state: 'running', kind: 'audience_create' },
        });
        assert.equal(toAudienceView(row({ size_lower: null, size_upper: null, synced_at: null })).op, null);
    });

    it('a customer-list spec shows only columns, rows sent and the match estimate', () => {
        const dirty = { columns: ['PHONE'], rows_sent: 4, matched_estimate: null, hashed: ['abc'], text: '0100', rows: [1] };
        assert.deepEqual(scrubSpecForView(dirty), { columns: ['PHONE'], rows_sent: 4, matched_estimate: null });
        assert.deepEqual(toAudienceView(row({ kind: 'customer_list', spec: dirty })).spec, { columns: ['PHONE'], rows_sent: 4, matched_estimate: null });
        assert.deepEqual(scrubSpecForView({ event: 'engaged', retentionDays: 30 }), { event: 'engaged', retentionDays: 30 });
    });
});

describe('store', () => {
    let db: FakeDb;
    beforeEach(() => { db = installFakeDb(); });
    afterEach(() => db.restore());

    function serve(rows: AudienceRow[]): void {
        db.routes.push([/FROM ads_audiences/, ([creatorId]) => ({ rows: rows.filter((r) => r.creator_id === creatorId) })]);
    }

    it('targetingAudiences maps ready audiences to Meta ids', async () => {
        serve([row({ id: A1, meta_id: '6001' }), row({ id: A2, meta_id: '6002' })]);
        assert.deepEqual(await targetingAudiences(CREATOR, [A1], [A2]), { custom_audiences: [{ id: '6001' }], excluded_custom_audiences: [{ id: '6002' }] });
        assert.deepEqual(await targetingAudiences(CREATOR, [], []), { custom_audiences: [], excluded_custom_audiences: [] });
    });

    it('refuses an included audience that is not ready, with the reason', async () => {
        serve([row({ id: A1, status: 'too_small', size_upper: '500' }), row({ id: A2, status: 'flagged' }), row({ id: A3, status: 'creating', meta_id: null })]);
        for (const [id, reason] of [[A1, 'too_small'], [A2, 'flagged'], [A3, 'creating']] as const) {
            await assert.rejects(targetingAudiences(CREATOR, [id], []), (err: unknown) => err instanceof AudienceError && err.code === 'AUDIENCE_NOT_USABLE' && err.reason === reason);
        }
    });

    it('an excluded audience needs only a Meta id', async () => {
        serve([row({ id: A1, status: 'too_small', meta_id: '6001' }), row({ id: A2, status: 'creating', meta_id: null })]);
        assert.deepEqual(await targetingAudiences(CREATOR, [], [A1]), { custom_audiences: [], excluded_custom_audiences: [{ id: '6001' }] });
        await assert.rejects(targetingAudiences(CREATOR, [], [A2]), (err: unknown) => err instanceof AudienceError && err.code === 'AUDIENCE_NOT_USABLE');
    });

    it('an audience of another tenant, or an id that is not a uuid, is NOT_FOUND', async () => {
        serve([row({ id: A1, creator_id: OTHER })]);
        await assert.rejects(targetingAudiences(CREATOR, [A1], []), (err: unknown) => err instanceof AudienceError && err.code === 'NOT_FOUND');
        await assert.rejects(targetingAudiences(CREATOR, [], ['nope']), (err: unknown) => err instanceof AudienceError && err.code === 'NOT_FOUND');
        assert.equal(await getAudience(CREATOR, 'nope'), null);
    });

    it('resolveSpecAudiences maps our ids to Meta ids, passes Ads Manager ids on, and names the ad set field when one is not usable', async () => {
        serve([row({ id: A1, status: 'ready', meta_id: '6001' }), row({ id: A2, status: 'creating', meta_id: null })]);
        const out = await resolveSpecAudiences(CREATOR, [{ name: 'a', targeting: { includeAudiences: [A1, '23850000000001'], excludeAudiences: [] } }, { name: 'b', targeting: {} }]);
        assert.deepEqual(out[0]!.targeting, { includeAudiences: ['6001', '23850000000001'], excludeAudiences: [] });
        assert.deepEqual(out[1]!.targeting, {});
        await assert.rejects(resolveSpecAudiences(CREATOR, [{ targeting: {} }, { targeting: { includeAudiences: [A2] } }]),
            (err: unknown) => err instanceof AudienceError && err.code === 'AUDIENCE_NOT_USABLE' && err.field === 'adsets.1.targeting.includeAudiences');
    });

    it('the same audience cannot be both included and excluded', async () => {
        serve([row({ id: A1 })]);
        await assert.rejects(targetingAudiences(CREATOR, [A1], [A1]), (err: unknown) => err instanceof AudienceError && err.code === 'INVALID');
    });

    it('applyAudienceReads adopts ids from done create ops, then matches by Meta id and ignores strangers', async () => {
        const app = [
            row({ id: A1, meta_id: '6001', status: 'creating' }),
            row({ id: A2, meta_id: '6002', status: 'creating', kind: 'lookalike' }),
        ];
        db.routes.push([/^\s*UPDATE ads_audiences a\s+SET meta_id = o\.result/, () => ({ rows: [], rowCount: 0 })]);
        db.routes.push([/^SELECT .* FROM ads_audiences/, () => ({ rows: app })]);
        db.routes.push([/^UPDATE ads_audiences SET meta_id = \$3, status/, ([, id]) => ({ rows: [{ id }], rowCount: 1 })]);
        const updated = await applyAudienceReads(CREATOR, [
            { id: '6001', name: 'تفاعل AR·op', approximate_count_lower_bound: 5000, approximate_count_upper_bound: 6000, operation_status: { code: 200 }, delivery_status: { code: 200 } },
            { id: '6002', name: 'مشابه AR·op', approximate_count_lower_bound: 100, approximate_count_upper_bound: 500, delivery_status: { code: 300 } },
            { id: '9999', name: 'made in Ads Manager' },
        ]);
        assert.equal(updated, 2);
        assert.equal(db.ran(/UPDATE ads_audiences a\s+SET meta_id = o\.result/).length, 1);
        const updates = db.ran(/^UPDATE ads_audiences SET meta_id = \$3, status/);
        assert.equal(updates.length, 2);
        assert.deepEqual(updates[0]!.params.slice(0, 3), [CREATOR, A1, '6001']);
        assert.deepEqual(updates[1]!.params.slice(0, 3), [CREATOR, A2, '6002']);
        assert.ok(updates[1]!.params.includes('too_small'));
    });
});
