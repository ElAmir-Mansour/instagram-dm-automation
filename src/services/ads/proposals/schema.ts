/**
 * What a model must answer for an AI proposal (A7, contracts/ai-proposal.schema.md "Output"), and the validators that decide whether it did.
 *
 * Two things live here and they say the same thing twice, on purpose:
 *
 *   DRAFT_SCHEMA / REVIEW_SCHEMA   JSON Schema, handed to the provider (`{json}` form, `src/services/llm/schema.ts`) or to
 *                                  `claude --json-schema` on the owner's Mac, so a model is steered toward the shape.
 *   validateDraft / validateReview what the SERVER believes. Structured output is advice: a provider may drop a bound it does not
 *                                  support (array sizes, string lengths), a model on the Mac may answer in prose around a code
 *                                  fence, and a number may arrive as a string. Nothing is stored that these did not pass.
 *
 * The validators are hand-written (no new dependency) for one reason beyond size: their errors go BACK to the model on the one
 * regeneration the contract allows, so each is a readable sentence with the path of the field ("spec.ads[0].message.greeting: at most
 * 300 characters"), which a model fixes far more reliably than "invalid".
 *
 * The limits are exported so the prompt, the schemas and the tests quote one number.
 */
import type { LlmSchema } from '../../llm/schema.js';
import type {
    CampaignSpec, DraftOutput, ProposalTask, ReviewChange, ReviewItem, ReviewKind, ReviewOutput, Validation,
} from './types.js';

// ─── Limits ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_DRAFT_RATIONALE = 600;
export const MAX_REVIEW_RATIONALE = 400;
export const MAX_GREETING = 300;
export const MAX_ICE_BREAKERS = 4;
export const MAX_ICE_BREAKER_TITLE = 80;
export const MAX_REVIEW_ITEMS = 3;

/**
 * The goals Claude may propose. Never 'leads' (A10): a lead form collects personal data behind a legal lock, so a lead campaign is only ever
 * made by the owner in the builder. The response schema itself leaves it out, so the model cannot emit one; service.ts refuses it again.
 */
export const GOALS = ['messages', 'reach', 'engagement', 'traffic'] as const;
export const BUDGET_KINDS = ['daily', 'lifetime'] as const;
export const SPECIAL_CATEGORIES = ['none', 'employment', 'financial', 'housing', 'political'] as const;
export const DESTINATIONS = ['instagram', 'messenger', 'whatsapp'] as const;
export const EXPECTED_METRICS = ['conversations', 'link_clicks', 'reach', 'leads'] as const;
export const REVIEW_KINDS = ['pause', 'lower_budget', 'raise_budget', 'shift_budget', 'new_ad_from_post', 'audience'] as const;

/** Meta's audience age bounds: 13 is the youngest an ad can target, 65 stands for "65 and older". */
const AGE_MIN = 13;
const AGE_MAX = 65;
/** A percentage change a model may ask for: a raise of up to tenfold. A 100% cut is a pause. */
const PERCENT_MIN = -100;
const PERCENT_MAX = 1000;

// ─── JSON Schema ────────────────────────────────────────────────────────────────────────────────────────────────────────

type J = Record<string, unknown>;

const str = (extra: J = {}): J => ({ type: 'string', minLength: 1, ...extra });
const strs = (extra: J = {}): J => ({ type: 'array', items: { type: 'string' }, ...extra });
const num = (extra: J = {}): J => ({ type: 'number', ...extra });
const int = (extra: J = {}): J => ({ type: 'integer', ...extra });
const oneOf = (values: readonly string[]): J => ({ type: 'string', enum: [...values] });
const obj = (properties: Record<string, J>, required: string[]): J => ({ type: 'object', properties, required });

const CAMPAIGN_SPEC_JSON: J = obj({
    name: str(),
    goal: oneOf(GOALS),
    destinations: { type: 'array', items: oneOf(DESTINATIONS) },
    specialCategory: oneOf(SPECIAL_CATEGORIES),
    budget: obj({
        home: oneOf(['campaign', 'adset']),
        kind: oneOf(BUDGET_KINDS),
        amount: num({ exclusiveMinimum: 0, description: 'major units of the ad account\'s currency; per day for daily, the whole amount for lifetime' }),
        start: str({ description: 'ISO 8601 time' }),
        end: str({ description: 'ISO 8601 time; required for a lifetime budget' }),
    }, ['home', 'kind', 'amount', 'start']),
    adsets: {
        type: 'array',
        minItems: 1,
        items: obj({
            name: str(),
            targeting: obj({
                countries: strs({ minItems: 1, description: 'ISO 3166-1 alpha-2, upper case' }),
                cities: { type: 'array', items: obj({ key: str(), radiusKm: num({ exclusiveMinimum: 0 }) }, ['key', 'radiusKm']) },
                ageMin: int({ minimum: AGE_MIN, maximum: AGE_MAX }),
                ageMax: int({ minimum: AGE_MIN, maximum: AGE_MAX }),
                genders: { type: 'array', items: int({ minimum: 1, maximum: 2 }) },
                locales: { type: 'array', items: int() },
                interests: { type: 'array', items: obj({ id: str(), name: str() }, ['id', 'name']) },
                includeAudiences: strs(),
                excludeAudiences: strs(),
                advantageAudience: { type: 'boolean' },
            }, ['countries', 'ageMin', 'advantageAudience']),
            placements: {
                anyOf: [
                    { type: 'string', enum: ['automatic'] },
                    obj({ facebook: strs(), instagram: strs() }, []),
                ],
            },
            optimization: { type: 'string' },
        }, ['name', 'targeting', 'placements']),
    },
    ads: {
        type: 'array',
        minItems: 1,
        items: obj({
            adsetIndex: int({ minimum: 0 }),
            name: str(),
            creative: {
                anyOf: [
                    obj({ source: { type: 'string', enum: ['post'] }, postId: str(), platform: str() }, ['source', 'postId', 'platform']),
                    obj({ source: { type: 'string', enum: ['media'] }, mediaId: str(), verticalMediaId: { type: 'string' }, coverMediaId: { type: 'string' } }, ['source', 'mediaId']),
                ],
            },
            copy: obj({ primaryText: str(), headline: { type: 'string' }, cta: str() }, ['primaryText']),
            link: { anyOf: [obj({ trackedOfferId: str() }, ['trackedOfferId']), obj({ url: str() }, ['url'])] },
            message: obj({
                greeting: str({ maxLength: MAX_GREETING }),
                iceBreakers: {
                    type: 'array',
                    maxItems: MAX_ICE_BREAKERS,
                    items: obj({ title: str({ maxLength: MAX_ICE_BREAKER_TITLE }), response: { type: 'string' } }, ['title']),
                },
            }, ['greeting', 'iceBreakers']),
            offerId: { type: 'string' },
        }, ['adsetIndex', 'name', 'creative', 'copy']),
    },
}, ['name', 'goal', 'specialCategory', 'budget', 'adsets', 'ads']);

/** `draft_campaign`: one campaign for the owner to approve. `range` is null unless the account's own history gives one. */
export const DRAFT_SCHEMA: LlmSchema = {
    json: obj({
        spec: CAMPAIGN_SPEC_JSON,
        rationale: str({ maxLength: MAX_DRAFT_RATIONALE, description: 'in the tenant\'s language' }),
        assumptions: strs(),
        expected: obj({
            metric: oneOf(EXPECTED_METRICS),
            range: {
                type: ['array', 'null'],
                items: num(),
                minItems: 2,
                maxItems: 2,
                description: '[low, high] from the account\'s own history, or null when there is none',
            },
        }, ['metric', 'range']),
    }, ['spec', 'rationale', 'assumptions', 'expected']),
};

/** `review`: at most three changes to what is running, each backed by numbers that exist in the input. */
export const REVIEW_SCHEMA: LlmSchema = {
    json: obj({
        items: {
            type: 'array',
            maxItems: MAX_REVIEW_ITEMS,
            items: obj({
                kind: oneOf(REVIEW_KINDS),
                targets: strs({ minItems: 1, description: 'ids of objects in the input' }),
                change: {
                    anyOf: [
                        obj({ percent: num({ minimum: PERCENT_MIN, maximum: PERCENT_MAX }) }, ['percent']),
                        obj({ from: str(), to: str(), amount: num({ exclusiveMinimum: 0 }) }, ['from', 'to', 'amount']),
                        obj({ spec: CAMPAIGN_SPEC_JSON }, ['spec']),
                    ],
                },
                evidence: obj({
                    window: { type: 'string', enum: ['7d'] },
                    numbers: { type: 'object', additionalProperties: { type: 'number' }, description: 'every number must appear in the input' },
                }, ['window', 'numbers']),
                rationale: str({ maxLength: MAX_REVIEW_RATIONALE }),
            }, ['kind', 'targets', 'change', 'evidence', 'rationale']),
        },
    }, ['items']),
};

export const schemaFor = (task: ProposalTask): LlmSchema => (task === 'review' ? REVIEW_SCHEMA : DRAFT_SCHEMA);

// ─── Reading the answer ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The answer as a value. Providers hand back an object when structured output worked; the Mac and a lenient provider hand back text,
 * which may be bare JSON, JSON in a ```json fence, or JSON with a sentence around it. Anything else is returned untouched (a string),
 * and the validators then say it is not JSON.
 */
export function parseModelJson(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    const text = raw.replace(/^﻿/, '').trim();
    const attempts = [text];
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fence) attempts.push((fence[1] ?? '').trim());
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
    for (const attempt of attempts) {
        try {
            const parsed: unknown = JSON.parse(attempt);
            if (typeof parsed === 'object' && parsed !== null) return parsed;
        } catch { /* try the next reading */ }
    }
    return raw;
}

// ─── Validators ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const at = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const idx = (path: string, i: number): string => `${path}[${i}]`;

/** Collects errors with the path of the field they belong to. Every check returns whether the value is usable by the checks after it. */
class Check {
    readonly errors: string[] = [];

    fail(path: string, message: string): false {
        this.errors.push(`${path}: ${message}`);
        return false;
    }

    object(path: string, v: unknown): v is Record<string, unknown> {
        if (v === undefined) return this.fail(path, 'is required');
        return isObject(v) || this.fail(path, 'must be an object');
    }

    string(path: string, v: unknown, opts: { max?: number; optional?: boolean; empty?: boolean } = {}): v is string {
        if (v === undefined || v === null) return opts.optional ? false : this.fail(path, 'is required');
        if (typeof v !== 'string') return this.fail(path, 'must be a string');
        if (!opts.empty && v.trim() === '') return this.fail(path, 'must not be empty');
        if (opts.max !== undefined && v.length > opts.max) return this.fail(path, `at most ${opts.max} characters`);
        return true;
    }

    number(path: string, v: unknown, opts: { gt?: number; min?: number; max?: number; int?: boolean; optional?: boolean } = {}): v is number {
        if (v === undefined || v === null) return opts.optional ? false : this.fail(path, 'is required');
        if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(path, 'must be a finite number');
        if (opts.int && !Number.isInteger(v)) return this.fail(path, 'must be a whole number');
        if (opts.gt !== undefined && v <= opts.gt) return this.fail(path, `must be greater than ${opts.gt}`);
        if (opts.min !== undefined && v < opts.min) return this.fail(path, `must be at least ${opts.min}`);
        if (opts.max !== undefined && v > opts.max) return this.fail(path, `must be at most ${opts.max}`);
        return true;
    }

    oneOf<T extends string>(path: string, v: unknown, values: readonly T[]): v is T {
        if (v === undefined || v === null) return this.fail(path, 'is required');
        return (typeof v === 'string' && (values as readonly string[]).includes(v)) || this.fail(path, `must be one of ${values.join(', ')}`);
    }

    array(path: string, v: unknown, opts: { min?: number; max?: number; optional?: boolean } = {}): v is unknown[] {
        if (v === undefined || v === null) return opts.optional ? false : this.fail(path, 'is required');
        if (!Array.isArray(v)) return this.fail(path, 'must be an array');
        if (opts.min !== undefined && v.length < opts.min) return this.fail(path, `at least ${opts.min} ${opts.min === 1 ? 'item' : 'items'} needed`);
        if (opts.max !== undefined && v.length > opts.max) return this.fail(path, `at most ${opts.max} items`);
        return true;
    }

    strings(path: string, v: unknown, opts: { min?: number; optional?: boolean } = {}): void {
        if (!this.array(path, v, opts)) return;
        v.forEach((item, i) => this.string(idx(path, i), item));
    }
}

const isoTime = (v: string): number => Date.parse(v);

function checkTargeting(c: Check, path: string, v: unknown): void {
    if (!c.object(path, v)) return;
    if (c.array(at(path, 'countries'), v.countries, { min: 1 })) {
        v.countries.forEach((country, i) => {
            if (c.string(idx(at(path, 'countries'), i), country) && !/^[A-Z]{2}$/.test(country)) c.fail(idx(at(path, 'countries'), i), 'must be a two-letter upper-case country code');
        });
    }
    const ageMinOk = c.number(at(path, 'ageMin'), v.ageMin, { int: true, min: AGE_MIN, max: AGE_MAX });
    if (c.number(at(path, 'ageMax'), v.ageMax, { int: true, min: AGE_MIN, max: AGE_MAX, optional: true }) && ageMinOk && (v.ageMax as number) < (v.ageMin as number)) {
        c.fail(at(path, 'ageMax'), 'must not be below ageMin');
    }
    if (c.array(at(path, 'genders'), v.genders, { optional: true })) v.genders.forEach((g, i) => c.number(idx(at(path, 'genders'), i), g, { int: true, min: 1, max: 2 }));
    if (c.array(at(path, 'locales'), v.locales, { optional: true })) v.locales.forEach((l, i) => c.number(idx(at(path, 'locales'), i), l, { int: true }));
    if (c.array(at(path, 'cities'), v.cities, { optional: true })) {
        v.cities.forEach((city, i) => {
            const p = idx(at(path, 'cities'), i);
            if (!c.object(p, city)) return;
            c.string(at(p, 'key'), city.key);
            c.number(at(p, 'radiusKm'), city.radiusKm, { gt: 0 });
        });
    }
    if (c.array(at(path, 'interests'), v.interests, { optional: true })) {
        v.interests.forEach((interest, i) => {
            const p = idx(at(path, 'interests'), i);
            if (!c.object(p, interest)) return;
            c.string(at(p, 'id'), interest.id);
            c.string(at(p, 'name'), interest.name);
        });
    }
    c.strings(at(path, 'includeAudiences'), v.includeAudiences, { optional: true });
    c.strings(at(path, 'excludeAudiences'), v.excludeAudiences, { optional: true });
    if (typeof v.advantageAudience !== 'boolean') c.fail(at(path, 'advantageAudience'), v.advantageAudience === undefined ? 'is required' : 'must be true or false');
}

function checkAd(c: Check, path: string, v: unknown, adsetCount: number): void {
    if (!c.object(path, v)) return;
    if (c.number(at(path, 'adsetIndex'), v.adsetIndex, { int: true, min: 0 }) && adsetCount > 0 && (v.adsetIndex as number) >= adsetCount) {
        c.fail(at(path, 'adsetIndex'), `there is no ad set ${v.adsetIndex as number} (the spec has ${adsetCount})`);
    }
    c.string(at(path, 'name'), v.name);

    const creative = at(path, 'creative');
    if (c.object(creative, v.creative)) {
        if (v.creative.source === 'post') {
            c.string(at(creative, 'postId'), v.creative.postId);
            c.string(at(creative, 'platform'), v.creative.platform);
        } else if (v.creative.source === 'media') {
            c.string(at(creative, 'mediaId'), v.creative.mediaId);
            c.string(at(creative, 'verticalMediaId'), v.creative.verticalMediaId, { optional: true });
            c.string(at(creative, 'coverMediaId'), v.creative.coverMediaId, { optional: true });
        } else c.fail(at(creative, 'source'), 'must be one of post, media');
    }

    const copy = at(path, 'copy');
    if (c.object(copy, v.copy)) {
        c.string(at(copy, 'primaryText'), v.copy.primaryText);
        c.string(at(copy, 'headline'), v.copy.headline, { optional: true, empty: true });
        c.string(at(copy, 'cta'), v.copy.cta, { optional: true }); // spec.ts: only a traffic ad uses it
    }

    if (v.link !== undefined && v.link !== null) {
        const link = at(path, 'link');
        if (c.object(link, v.link)) {
            if ('trackedOfferId' in v.link) c.string(at(link, 'trackedOfferId'), v.link.trackedOfferId);
            else if ('url' in v.link) c.string(at(link, 'url'), v.link.url);
            else c.fail(link, 'must be { trackedOfferId } or { url }');
        }
    }

    if (v.message !== undefined && v.message !== null) {
        const message = at(path, 'message');
        if (c.object(message, v.message)) {
            c.string(at(message, 'greeting'), v.message.greeting, { max: MAX_GREETING });
            const breakers = at(message, 'iceBreakers');
            // Too many is one error; each title is still checked, so the one regeneration fixes both.
            c.array(breakers, v.message.iceBreakers, { max: MAX_ICE_BREAKERS });
            if (Array.isArray(v.message.iceBreakers)) {
                (v.message.iceBreakers as unknown[]).forEach((b, i) => {
                    const p = idx(breakers, i);
                    if (!c.object(p, b)) return;
                    c.string(at(p, 'title'), b.title, { max: MAX_ICE_BREAKER_TITLE });
                    c.string(at(p, 'response'), b.response, { optional: true });
                });
            }
        }
    }
    c.string(at(path, 'offerId'), v.offerId, { optional: true });
}

function checkSpec(c: Check, path: string, v: unknown): void {
    if (!c.object(path, v)) return;
    c.string(at(path, 'name'), v.name);
    c.oneOf(at(path, 'goal'), v.goal, GOALS);
    if (c.array(at(path, 'destinations'), v.destinations, { optional: true })) v.destinations.forEach((d, i) => c.oneOf(idx(at(path, 'destinations'), i), d, DESTINATIONS));
    c.oneOf(at(path, 'specialCategory'), v.specialCategory, SPECIAL_CATEGORIES);

    const budget = at(path, 'budget');
    if (c.object(budget, v.budget)) {
        c.oneOf(at(budget, 'home'), v.budget.home, ['campaign', 'adset'] as const);
        const kindOk = c.oneOf(at(budget, 'kind'), v.budget.kind, BUDGET_KINDS);
        c.number(at(budget, 'amount'), v.budget.amount, { gt: 0 });
        const startOk = c.string(at(budget, 'start'), v.budget.start) && (Number.isFinite(isoTime(v.budget.start)) || c.fail(at(budget, 'start'), 'must be an ISO 8601 time'));
        if (c.string(at(budget, 'end'), v.budget.end, { optional: true })) {
            if (!Number.isFinite(isoTime(v.budget.end))) c.fail(at(budget, 'end'), 'must be an ISO 8601 time');
            else if (startOk && isoTime(v.budget.end) <= isoTime(v.budget.start as string)) c.fail(at(budget, 'end'), 'must be after start');
        } else if (kindOk && v.budget.kind === 'lifetime' && v.budget.end === undefined) {
            c.fail(at(budget, 'end'), 'is required for a lifetime budget');
        }
    }

    const adsets = at(path, 'adsets');
    let adsetCount = 0;
    if (c.array(adsets, v.adsets, { min: 1 })) {
        adsetCount = v.adsets.length;
        v.adsets.forEach((adset, i) => {
            const p = idx(adsets, i);
            if (!c.object(p, adset)) return;
            c.string(at(p, 'name'), adset.name);
            checkTargeting(c, at(p, 'targeting'), adset.targeting);
            const placements = at(p, 'placements');
            if (adset.placements === undefined) c.fail(placements, 'is required');
            else if (adset.placements !== 'automatic') {
                if (c.object(placements, adset.placements)) {
                    c.strings(at(placements, 'facebook'), adset.placements.facebook, { optional: true });
                    c.strings(at(placements, 'instagram'), adset.placements.instagram, { optional: true });
                } else if (typeof adset.placements === 'string') c.fail(placements, 'must be "automatic" or an object of platforms');
            }
            c.string(at(p, 'optimization'), adset.optimization, { optional: true });
        });
    }

    const ads = at(path, 'ads');
    if (c.array(ads, v.ads, { min: 1 })) v.ads.forEach((ad, i) => checkAd(c, idx(ads, i), ad, adsetCount));
}

const done = <T>(c: Check, value: unknown): Validation<T> => (c.errors.length ? { ok: false, errors: c.errors } : { ok: true, value: value as T });

/** A parsed answer as an object, or the one error that says why not. */
function asObject(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
    if (typeof value === 'string') return { ok: false, errors: ['answer: is not valid JSON'] };
    if (!isObject(value)) return { ok: false, errors: ['answer: must be a JSON object'] };
    return { ok: true, value };
}

/** `draft_campaign`'s answer. On success `value` is the model's own object, unchanged: the checks adjust it afterwards, never the validator. */
export function validateDraft(raw: unknown): Validation<DraftOutput> {
    const parsed = asObject(parseModelJson(raw));
    if (!parsed.ok) return parsed;
    const v = parsed.value;
    const c = new Check();
    checkSpec(c, 'spec', v.spec);
    c.string('rationale', v.rationale, { max: MAX_DRAFT_RATIONALE });
    c.strings('assumptions', v.assumptions);

    if (c.object('expected', v.expected)) {
        c.oneOf('expected.metric', v.expected.metric, EXPECTED_METRICS);
        const range = v.expected.range;
        if (range === undefined) c.fail('expected.range', 'is required (null when the account has no history)');
        else if (range !== null) {
            if (!Array.isArray(range) || range.length !== 2) c.fail('expected.range', 'must be null or [low, high]');
            else {
                const lowOk = c.number('expected.range[0]', range[0], { min: 0 });
                const highOk = c.number('expected.range[1]', range[1], { min: 0 });
                if (lowOk && highOk && (range[0] as number) > (range[1] as number)) c.fail('expected.range', 'low must not exceed high');
            }
        }
    }
    return done<DraftOutput>(c, v);
}

/** The shape each kind of review item needs of `change` (the contract lists three shapes; a kind uses one). */
function checkChange(c: Check, path: string, kind: unknown, change: unknown): void {
    if (change === undefined) { c.fail(path, 'is required'); return; }
    if (!isObject(change)) { c.fail(path, 'must be { percent }, { from, to, amount } or { spec }'); return; }
    if ('spec' in change) {
        checkSpec(c, at(path, 'spec'), change.spec);
        if (kind !== 'new_ad_from_post' && kind !== 'audience') c.fail(path, `${String(kind)} cannot carry a spec`);
    } else if ('from' in change || 'to' in change) {
        c.string(at(path, 'from'), change.from);
        c.string(at(path, 'to'), change.to);
        c.number(at(path, 'amount'), change.amount, { gt: 0 });
        if (kind !== 'shift_budget') c.fail(path, `${String(kind)} cannot move budget between ad sets`);
    } else if ('percent' in change) {
        if (c.number(at(path, 'percent'), change.percent, { min: PERCENT_MIN, max: PERCENT_MAX })) {
            if (change.percent === 0) c.fail(at(path, 'percent'), 'must not be 0');
            else if (kind === 'lower_budget' && change.percent > 0) c.fail(at(path, 'percent'), 'must be negative for lower_budget');
            else if (kind === 'raise_budget' && change.percent < 0) c.fail(at(path, 'percent'), 'must be positive for raise_budget');
        }
        if (kind === 'shift_budget' || kind === 'new_ad_from_post') c.fail(path, `${String(kind)} needs ${kind === 'shift_budget' ? '{ from, to, amount }' : '{ spec }'}`);
    } else c.fail(path, 'must be { percent }, { from, to, amount } or { spec }');
}

/** `review`'s answer: at most three items. */
export function validateReview(raw: unknown): Validation<ReviewOutput> {
    const parsed = asObject(parseModelJson(raw));
    if (!parsed.ok) return parsed;
    const v = parsed.value;
    const c = new Check();
    if (c.array('items', v.items, { max: MAX_REVIEW_ITEMS })) {
        v.items.forEach((item, i) => {
            const p = idx('items', i);
            if (!c.object(p, item)) return;
            c.oneOf(at(p, 'kind'), item.kind, REVIEW_KINDS);
            c.strings(at(p, 'targets'), item.targets, { min: 1 });
            checkChange(c, at(p, 'change'), item.kind, item.change);

            const evidence = at(p, 'evidence');
            if (c.object(evidence, item.evidence)) {
                if (item.evidence.window !== '7d') c.fail(at(evidence, 'window'), 'must be 7d');
                const numbers = at(evidence, 'numbers');
                if (c.object(numbers, item.evidence.numbers)) {
                    for (const [key, n] of Object.entries(item.evidence.numbers)) c.number(at(numbers, key), n);
                }
            }
            c.string(at(p, 'rationale'), item.rationale, { max: MAX_REVIEW_RATIONALE });
        });
    }
    return done<ReviewOutput>(c, v);
}

// Re-exported for the callers that name a change or a kind without reaching into types.ts.
export type { CampaignSpec, ReviewChange, ReviewItem, ReviewKind };
