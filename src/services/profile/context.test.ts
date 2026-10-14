/**
 * The profile context (docs/onboarding/01 §4, 05 §2; P5): what each purpose is told about the creator.
 *
 * Pinned here:
 *   - the owner's legacy profile gives every purpose today's facts: Gulf for reels, comments, DMs, carousels and the coach,
 *     فصحى for the infographic surface, `educator` / `tech educator` / `tech` / `course`, the male presenter and the no-women rule;
 *   - a second tenant (an English fitness coach, an Egyptian shop) gets none of those: no owner marker reaches its context;
 *   - a surface's own language and register win, and the register falls back the way the profile's does;
 *   - each purpose has exactly the slice 01 §4 lists, and the DM slice never carries the knowledge base;
 *   - a context is a copy, and `profileContext` reads the stored profile (else the virtual one) once per request;
 *   - a profile from a newer release is passed over for the legacy rows, as the settings readers do.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { withProfileCache } from './cache.js';
import {
    contextFor, isPurpose, legacyContext, offerKindOf, profileContext, profileContextOrLegacy, ProfileUnreadableError, PURPOSES, SURFACE_OF, type Purpose, type ProfileContext,
} from './context.js';
import { defaultProfile, upgradeProfile } from './defaults.js';
import { FITNESS_EN, SHOP_EG } from './fixtures.js';
import { LEGACY_ASSUMPTIONS, profileFromLegacy } from './legacy.js';
import { resetProfileTableWarning, resetProfileWarnings } from './store.js';
import { emptyState, growthRow, installProfileDb, OTHER, OWNER, PLATFORM_OWNER_SQL, type ProfileDb, setPlatformOwner, studioRow, type State } from './testDb.js';
import { deepFreeze, richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

/** A tenant's profile as the database holds it and the readers return it. */
const storedFrom = (profile: CreatorProfile): CreatorProfile => upgradeProfile(throughJsonb(profile)).profile;

const OWNER_PROFILE = storedFrom(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH));
const ENGLISH_LEGACY = storedFrom(profileFromLegacy(ENGLISH_SETTINGS));

/** Every string anywhere in `value`, keys included: what a prompt built from the context could end up saying. */
function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
    return [];
}

describe('purposes', () => {
    it('are the nine of 01 §4, each on one surface, and the reels purposes share one', () => {
        assert.deepEqual([...PURPOSES], ['dm', 'comment_reply', 'carousel', 'clip_pick', 'clip_copy', 'clip_edit', 'analyst', 'infographic', 'growth_coach']);
        assert.deepEqual({ ...SURFACE_OF }, {
            dm: 'dm', comment_reply: 'comments', carousel: 'carousel', clip_pick: 'reels', clip_copy: 'reels', clip_edit: 'reels',
            analyst: 'reels', infographic: 'infographic', growth_coach: 'coach',
        });
        assert.ok(isPurpose('dm') && !isPurpose('coach') && !isPurpose(undefined));
    });

    it('an unknown purpose is an error, from the pure function and before the database from the async one', async () => {
        assert.throws(() => contextFor(OWNER_PROFILE, 'nope' as never, 1), /unknown profile context purpose: nope/);
        await assert.rejects(profileContext(OWNER, 'nope' as never), /unknown profile context purpose: nope/);
    });
});

describe('the owner\'s legacy profile', () => {
    it('speaks Gulf Arabic on every surface but the infographic, which is فصحى', () => {
        const gulf = { code: 'ar', register: 'gulf', digits: 'arabic-indic', dir: 'rtl' };
        for (const purpose of PURPOSES) {
            const expected = purpose === 'infographic' ? { ...gulf, register: 'msa' } : gulf;
            assert.deepEqual(contextFor(OWNER_PROFILE, purpose, 1).language, expected, purpose);
        }
        // The reels purposes are the surface that says gulf for the Monteur.
        for (const purpose of ['clip_pick', 'clip_copy', 'clip_edit', 'analyst'] as const) assert.equal(contextFor(OWNER_PROFILE, purpose, 1).language.register, 'gulf');
    });

    it('is an educator, a tech educator, in the tech domain, selling a course', () => {
        for (const purpose of PURPOSES) {
            const ctx = contextFor(OWNER_PROFILE, purpose, 7);
            assert.deepEqual(ctx.who, { kind: 'educator', role: 'tech educator', niche: '', domain: 'tech', offerKind: 'course' }, purpose);
            assert.equal(ctx.purpose, purpose);
            assert.equal(ctx.version, 7);
        }
    });

    it('guards with the no-women rule and his live never-mention list', () => {
        const guard = contextFor(OWNER_PROFILE, 'clip_edit', 1).guard;
        assert.deepEqual(guard, { never_mention: ['MCP'], rules: ['no_women_imagery'], custom_rules: [] });
    });

    it('has a male presenter on camera, and the masculine address every Arabic pool is written in', () => {
        assert.deepEqual(contextFor(OWNER_PROFILE, 'clip_edit', 1).presenter, { name: '', pronouns: 'he', on_camera: 'face' });
        assert.deepEqual(contextFor(OWNER_PROFILE, 'clip_copy', 1).voice, { address: 'masc', emoji: 'light' });
    });

    it('the coach reads times in his timezone, and the DM slice carries his one offer and his link', () => {
        const coach = contextFor(OWNER_PROFILE, 'growth_coach', 1);
        assert.equal(coach.timezone, ELAMIR_SEED_SETTINGS.schedule.timezone, 'his schedule timezone');
        assert.equal(coach.timezone, 'Asia/Riyadh');
        assert.deepEqual(coach.goals, { followers: 10_000, views: 1_000_000 });
        const dm = contextFor(OWNER_PROFILE, 'dm', 1);
        assert.equal(dm.offers.length, 1);
        assert.equal(dm.offers[0]!.url, ELAMIR_SEED_SETTINGS.product.url);
        assert.deepEqual(dm.offers[0]!.bullets, ELAMIR_SEED_SETTINGS.product.dmBullets);
        assert.equal(dm.voice.guide, ELAMIR_SEED_SETTINGS.voice.guide);
    });

    it('says exactly what LEGACY_ASSUMPTIONS says, which legacy.test.ts ties to the text of the golden prompts', () => {
        const a = LEGACY_ASSUMPTIONS;
        const edit = contextFor(OWNER_PROFILE, 'clip_edit', 1);
        assert.deepEqual(edit.presenter, a.presenter);
        assert.deepEqual(edit.guard.rules, [...a.rules]);
        assert.equal(edit.language.register, a.register);
        assert.equal(contextFor(OWNER_PROFILE, 'infographic', 1).language.register, a.infographicRegister);
        assert.equal(contextFor(OWNER_PROFILE, 'clip_copy', 1).voice.address, a.address);
        assert.deepEqual(edit.who, { kind: a.kind, role: a.role, niche: '', domain: a.domain, offerKind: a.offerKind });
        const dm = contextFor(ENGLISH_LEGACY, 'dm', null).language;
        assert.deepEqual({ code: dm.code, register: dm.register }, { code: a.dm.language, register: a.dm.register }, 'the forced Arabic DM of an English tenant');
    });

    it('an English tenant\'s legacy profile keeps what the code forces today: Arabic Gulf DMs, a فصحى infographic register, English elsewhere', () => {
        assert.deepEqual(contextFor(ENGLISH_LEGACY, 'dm', null).language, { code: 'ar', register: 'gulf', digits: ENGLISH_LEGACY.language.digits, dir: 'rtl' });
        const infographic = contextFor(ENGLISH_LEGACY, 'infographic', null).language;
        assert.equal(infographic.code, 'en', 'its own language is English');
        assert.equal(infographic.register, 'msa', 'and an Arabic infographic job is written in فصحى');
        assert.equal(infographic.dir, 'ltr');
        for (const purpose of ['comment_reply', 'carousel', 'clip_pick', 'growth_coach'] as const) {
            const language = contextFor(ENGLISH_LEGACY, purpose, null).language;
            assert.equal(language.code, 'en', purpose);
            assert.equal(language.register, null, purpose);
            assert.equal(language.dir, 'ltr', purpose);
        }
    });
});

describe('a second tenant', () => {
    it('an English fitness coach: English, left to right, no register, a coach with a mixed offer list and no owner marker', () => {
        for (const purpose of PURPOSES) {
            const ctx = contextFor(FITNESS_EN, purpose, 3);
            assert.deepEqual(ctx.language, { code: 'en', register: null, digits: 'latin', dir: 'ltr' }, purpose);
            assert.deepEqual(ctx.who, { kind: 'coach', role: 'fitness coach', niche: 'Home workouts for busy parents', domain: 'general', offerKind: 'mixed' }, purpose);
            assert.deepEqual(ctx.guard, { never_mention: ['steroids'], rules: [], custom_rules: ['No before-and-after photos'] }, purpose);
            const text = strings(ctx).join('\n');
            for (const marker of ['educator', 'tech', 'course', 'gulf', 'he', 'MCP', 'Cairo', 'Udemy', 'udemy']) {
                assert.ok(!strings(ctx).includes(marker), `${purpose}: no field is "${marker}"`);
            }
            assert.ok(!/educator|udemy|gulf|tech educator|no_women/i.test(text), `${purpose}: no owner marker in ${text.slice(0, 80)}`);
        }
        assert.deepEqual(contextFor(FITNESS_EN, 'clip_edit', 1).presenter, { name: 'Sami', pronouns: 'they', on_camera: 'face' });
        assert.equal(contextFor(FITNESS_EN, 'growth_coach', 1).timezone, 'Europe/London');
    });

    it('an Egyptian shop: Egyptian Arabic, product offers, no presenter, a feminine address, no educator', () => {
        for (const purpose of PURPOSES) {
            const ctx = contextFor(SHOP_EG, purpose, 1);
            const expected = { code: 'ar', register: 'egyptian', digits: 'latin', dir: 'rtl' };
            assert.deepEqual(ctx.language, expected, purpose);
            assert.deepEqual(ctx.who, { kind: 'shop', role: 'online shop', niche: 'Handmade candles', domain: 'general', offerKind: 'product' }, purpose);
            assert.ok(!/educator|tech educator|gulf|udemy/i.test(strings(ctx).join('\n')), purpose);
        }
        assert.equal(contextFor(SHOP_EG, 'clip_edit', 1).presenter, null);
        assert.deepEqual(contextFor(SHOP_EG, 'clip_copy', 1).voice, { address: 'fem', emoji: 'light' });
        assert.deepEqual(contextFor(SHOP_EG, 'comment_reply', 1).offers.map((o) => o.name), ['شمعة لافندر', 'علبة هدية']);
    });

    it('a brand-new default profile is neutral and Arabic/MSA, or English with no register: nothing is carried over from the owner', () => {
        const ar = contextFor(defaultProfile(), 'dm', null);
        assert.deepEqual(ar.language, { code: 'ar', register: 'msa', digits: 'arabic-indic', dir: 'rtl' });
        assert.deepEqual(ar.who, { kind: null, role: '', niche: '', domain: 'general', offerKind: null });
        assert.deepEqual(ar.guard, { never_mention: [], rules: ['no_women_imagery'], custom_rules: [] });
        assert.equal(ar.version, null);
        const en = contextFor(defaultProfile({ lang: 'en' }), 'clip_edit', null);
        assert.deepEqual(en.language, { code: 'en', register: null, digits: 'latin', dir: 'ltr' });
        assert.equal(en.presenter, null);
    });
});

describe('surfaces', () => {
    const rich = richProfile();

    it('a surface\'s own language and register win over the profile\'s', () => {
        // richProfile: Egyptian Arabic; carousel in English, infographic in Arabic/MSA, DM in Levantine.
        assert.equal(contextFor(rich, 'comment_reply', 1).language.register, 'egyptian');
        assert.equal(contextFor(rich, 'clip_pick', 1).language.register, 'egyptian');
        assert.equal(contextFor(rich, 'growth_coach', 1).language.register, 'egyptian');
        assert.deepEqual(contextFor(rich, 'dm', 1).language, { code: 'ar', register: 'levantine', digits: 'latin', dir: 'rtl' });
        assert.deepEqual(contextFor(rich, 'infographic', 1).language, { code: 'ar', register: 'msa', digits: 'latin', dir: 'rtl' });
        const carousel = contextFor(rich, 'carousel', 1).language;
        assert.equal(carousel.code, 'en');
        assert.equal(carousel.dir, 'ltr', 'the direction follows the language the surface speaks');
        assert.equal(carousel.register, 'egyptian', 'the register is kept for an English surface: it is the one an Arabic piece would be written in');
    });

    it('a surface that overrides only the register keeps the profile\'s language, and one that overrides only the language keeps its register', () => {
        const p = structuredClone(rich);
        p.language.surfaces = { reels: { register: 'msa' }, coach: { language: 'en' } };
        assert.deepEqual(contextFor(p, 'analyst', 1).language, { code: 'ar', register: 'msa', digits: 'latin', dir: 'rtl' });
        assert.deepEqual(contextFor(p, 'growth_coach', 1).language, { code: 'en', register: 'egyptian', digits: 'latin', dir: 'ltr' });
        assert.equal(contextFor(p, 'dm', 1).language.register, 'egyptian', 'a surface with no override reads the profile\'s');
    });

    it('an Arabic surface of an English profile with no register anywhere reads as MSA, the profile default (D8), and an English one as none', () => {
        const p = defaultProfile({ lang: 'en' });
        p.language.surfaces = { dm: { language: 'ar' } };
        assert.deepEqual(contextFor(p, 'dm', 1).language, { code: 'ar', register: 'msa', digits: 'latin', dir: 'rtl' });
        assert.equal(contextFor(p, 'comment_reply', 1).language.register, null);
    });
});

describe('slices', () => {
    const SLICE_KEYS: Record<Purpose, string[]> = {
        dm: ['faq', 'handoff', 'hours', 'links', 'names', 'offers', 'timezone', 'voice', 'voice_guide'],
        comment_reply: ['offers', 'voice'],
        carousel: ['audience', 'pillars'],
        clip_pick: ['audience', 'pillars'],
        clip_copy: ['voice'],
        clip_edit: ['presenter'],
        analyst: ['goals', 'pillars'],
        infographic: [],
        growth_coach: ['audience', 'goals', 'pillars', 'timezone'],
    };
    const BASE_KEYS = ['guard', 'language', 'purpose', 'version', 'who'];

    it('each purpose has the base and exactly its own slice', () => {
        for (const purpose of PURPOSES) {
            assert.deepEqual(Object.keys(contextFor(FITNESS_EN, purpose, 1)).sort(), [...BASE_KEYS, ...SLICE_KEYS[purpose]].sort(), purpose);
        }
    });

    it('the DM slice is the creator\'s facts, and never the knowledge base: that stays an agent setting', () => {
        const dm = contextFor(richProfile(), 'dm', 1);
        assert.ok(!strings(dm).some((s) => /knowledge/i.test(s)), 'no field is named for the knowledge base');
        assert.deepEqual(dm.names, { display_name: { ar: 'سامي للياقة', en: 'Sami Fitness' }, brand_name: 'Sami Fit Studio' });
        assert.deepEqual(dm.voice, { guide: 'Warm, direct, never preachy.', address: 'plural', emoji: 'rich' });
        assert.deepEqual(dm.faq, [{ q: 'How much is it?', a: '$99, once.' }]);
        assert.deepEqual(dm.handoff, { when: 'The person asks for a refund', message: 'A person will reply to you soon.' });
        assert.deepEqual(dm.hours, { days: [0, 1, 2, 3, 4], from: '09:00', to: '17:00' });
        assert.deepEqual(dm.links, { handle: '@sami.fit', site: 'samifit.example', links: { instagram: 'https://instagram.com/sami.fit' } });
        assert.deepEqual(dm.offers.map((o) => o.id), ['side', 'main'], 'every offer, in the profile\'s order');
        assert.equal(dm.offers[1]!.campaign?.dm_template, 'Hi {username}, the program is here: {url}');
        const none = contextFor(defaultProfile(), 'dm', null);
        assert.equal(none.handoff, null);
        assert.equal(none.hours, null);
        assert.deepEqual(none.offers, []);
    });

    it('a comment reply gets each offer\'s name, link, keyword and campaign, and a campaign key only where the offer has one', () => {
        const ctx = contextFor(richProfile(), 'comment_reply', 1);
        assert.deepEqual(ctx.offers.map((o) => Object.keys(o).sort()), [['keyword', 'name', 'primary', 'url'], ['campaign', 'keyword', 'name', 'primary', 'url']]);
        assert.deepEqual(ctx.offers[1]!.campaign, { name_match: 'twelve-week', match: 'word', keywords: ['plan', 'program'], dm_template: 'Hi {username}, the program is here: {url}', public_replies: ['Sent to your DMs!', 'Check your messages'] });
        assert.deepEqual(ctx.voice, { address: 'plural', emoji: 'rich' });
    });

    it('carousel, clip pick, analyst and coach slices carry the audience brief, pillars and goals the spec lists', () => {
        const audience = { description: 'Parents with under an hour a day', level: 'beginner', pains: ['No time', 'No gym'], goals: ['Lose weight', 'Sleep better'], countries: ['EG', 'SA'], languages: ['ar', 'en'] };
        const rich = richProfile();
        assert.deepEqual(contextFor(rich, 'carousel', 1).audience, audience);
        assert.deepEqual(contextFor(rich, 'carousel', 1).pillars, ['Workouts', 'Food']);
        assert.deepEqual(contextFor(rich, 'clip_pick', 1).audience, audience);
        assert.deepEqual(contextFor(rich, 'analyst', 1).goals, { followers: 5000, views: 250_000 });
        const coach = contextFor(rich, 'growth_coach', 1);
        assert.deepEqual(coach.audience, audience, 'the audience\'s heatmap timezone is a Growth setting, not part of the brief');
        assert.equal(coach.timezone, 'Africa/Cairo', 'the tenant\'s own timezone');
    });

    it('the coach\'s timezone is the profile\'s, and an empty one reads as UTC (what `schedule.timezone` reads)', () => {
        const p = structuredClone(FITNESS_EN);
        p.identity.timezone = '';
        assert.equal(contextFor(p, 'growth_coach', 1).timezone, 'UTC');
        p.identity.timezone = 'Asia/Riyadh';
        assert.equal(contextFor(p, 'growth_coach', 1).timezone, 'Asia/Riyadh');
        p.audience.timezone = 'Asia/Dubai';
        assert.equal(contextFor(p, 'growth_coach', 1).timezone, 'Asia/Riyadh', 'the heatmap override is not folded in');
    });
});

describe('offerKind', () => {
    it('is the kind every offer shares, mixed when they differ, and null with none', () => {
        assert.equal(offerKindOf([]), null);
        assert.equal(offerKindOf([{ kind: 'course' }]), 'course');
        assert.equal(offerKindOf([{ kind: 'product' }, { kind: 'product' }, { kind: 'product' }]), 'product');
        assert.equal(offerKindOf([{ kind: 'course' }, { kind: 'coaching' }]), 'mixed');
        assert.equal(offerKindOf([{ kind: 'other' }, { kind: 'other' }]), 'other', 'a shared "other" is still a kind');
        assert.equal(contextFor(OWNER_PROFILE, 'dm', 1).who.offerKind, 'course', 'the owner\'s blank-name legacy shell still says course');
    });
});

describe('a context is a copy', () => {
    it('is built from a frozen profile without touching it, and editing a context edits no profile', () => {
        const frozen = deepFreeze(structuredClone(richProfile()));
        for (const purpose of PURPOSES) contextFor(frozen, purpose, 1);

        const p = richProfile();
        const before = structuredClone(p);
        for (const purpose of PURPOSES) {
            const ctx = contextFor(p, purpose, 1) as ProfileContext & Record<string, any>;
            ctx.guard.never_mention.push('MUTATED');
            ctx.guard.rules.push('no_women_imagery');
            ctx.guard.custom_rules.length = 0;
            ctx.language.code = 'en';
            ctx.who.role = 'MUTATED';
            for (const key of ['offers', 'faq', 'pillars', 'links', 'names', 'audience', 'goals', 'presenter', 'voice', 'hours', 'handoff']) {
                const v = ctx[key];
                if (Array.isArray(v)) { v.length = 0; } else if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = 'MUTATED'; }
            }
        }
        assert.deepStrictEqual(p, before);
    });
});

// ─── profileContext: reading it for a tenant ─────────────────────────────────────────────────

describe('profileContext', () => {
    let state: State;
    let db: ProfileDb;
    let restoreSink: (() => void) | undefined;
    let events: string[];

    beforeEach(() => {
        events = [];
        const previous = setLogSink((_level, line) => { try { events.push(JSON.parse(line).event); } catch { /* not structured */ } });
        restoreSink = () => setLogSink(previous);
        resetProfileTableWarning();
        resetProfileWarnings();
        state = emptyState();
        db = installProfileDb(state);
    });
    afterEach(() => {
        db.restore();
        restoreSink?.();
    });

    const store = (id: string, profile: unknown, version = 1): void => {
        state.profiles.set(id, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
    };

    it('cuts the context from the stored profile, and carries its version', async () => {
        store(OWNER, richProfile(), 4);
        const ctx = await profileContext(OWNER, 'dm');
        assert.equal(ctx.version, 4);
        assert.equal(ctx.who.role, 'fitness coach');
        assert.equal(ctx.language.register, 'levantine');
        assert.deepEqual(ctx, contextFor(richProfile(), 'dm', 4));
    });

    it('for a tenant with no stored profile, describes it from its legacy settings: the version is null', async () => {
        state.studio.set(OWNER, studioRow(ELAMIR_SEED_SETTINGS));
        state.growth.set(OWNER, growthRow(ELAMIR_GROWTH));
        const ctx = await profileContext(OWNER, 'clip_edit');
        assert.equal(ctx.version, null);
        assert.deepEqual(ctx, contextFor(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH), 'clip_edit', null));
        assert.deepEqual(ctx.who, { kind: 'educator', role: 'tech educator', niche: '', domain: 'tech', offerKind: 'course' });
        assert.equal(ctx.presenter?.pronouns, 'he');
        assert.ok(ctx.guard.rules.includes('no_women_imagery'));
        assert.equal(db.ran(/INSERT|UPDATE/).length, 0, 'reading a context writes nothing');
    });

    it('a profile written by a newer release is passed over, as the settings readers pass it over: the context is cut from the legacy rows, with no version, and it is said once', async () => {
        state.studio.set(OWNER, studioRow(ELAMIR_SEED_SETTINGS));
        state.growth.set(OWNER, growthRow(ELAMIR_GROWTH));
        store(OWNER, { ...richProfile(), schema: 2, future: { kept: true } }, 8);
        const ctx = await profileContext(OWNER, 'dm');
        assert.equal(ctx.version, null, 'it was not cut from version 8');
        assert.deepEqual(ctx, contextFor(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH), 'dm', null));
        assert.equal(ctx.who.role, 'tech educator', 'the rows\' tenant, not the newer profile\'s fitness coach');
        assert.equal(ctx.language.register, 'gulf');
        await profileContext(OWNER, 'clip_edit');
        assert.equal(events.filter((e) => e === 'profile.newer_schema').length, 1, 'said once per tenant');
        assert.equal(db.ran(/INSERT|UPDATE/).length, 0);
    });

    it('a stored profile this release reads is not passed over, and is not said to be', async () => {
        store(OWNER, richProfile(), 2);
        assert.equal((await profileContext(OWNER, 'dm')).version, 2);
        assert.equal(events.filter((e) => e === 'profile.newer_schema').length, 0);
    });

    it('reads the stored profile once per request however many contexts ask, and a transaction client always asks', async () => {
        store(OWNER, richProfile());
        const reads = (): number => db.ran(/FROM creator_profiles/).length;
        await withProfileCache(async () => {
            for (const purpose of PURPOSES) await profileContext(OWNER, purpose);
        });
        assert.equal(reads(), 1, 'nine contexts, one profile query');
        const client = await pool.connect();
        try {
            await withProfileCache(async () => {
                await profileContext(OWNER, 'dm', client as never);
                await profileContext(OWNER, 'dm', client as never);
            });
        } finally {
            client.release();
        }
        assert.equal(reads(), 3);
    });

    it('is the latest stored profile for the tenant that asks, not another\'s', async () => {
        store(OWNER, richProfile());
        store(OTHER, FITNESS_EN, 2);
        assert.equal((await profileContext(OTHER, 'dm')).who.role, 'fitness coach');
        assert.equal((await profileContext(OTHER, 'clip_copy')).version, 2);
        assert.equal((await profileContext(OWNER, 'clip_copy')).voice.address, 'plural');
    });

    it('a database error is the caller\'s to handle', async () => {
        db.failOn = /FROM creator_profiles/;
        db.failWith = new Error('connection refused');
        await assert.rejects(profileContext(OWNER, 'dm'), /connection refused/);
    });

    it('profileContextOrLegacy is the same context when the profile can be read, and writes nothing and warns nothing', async () => {
        store(OTHER, FITNESS_EN, 2);
        assert.deepEqual(await profileContextOrLegacy(OTHER, 'dm'), contextFor(FITNESS_EN, 'dm', 2));
        assert.deepEqual(await profileContextOrLegacy(OTHER, 'comment_reply'), contextFor(FITNESS_EN, 'comment_reply', 2));
        assert.equal(events.filter((e) => e === 'profile.context_unreadable').length, 0);
        assert.equal(db.ran(/INSERT|UPDATE/).length, 0);
    });

    describe('profileContextOrLegacy, when the profile cannot be read', () => {
        const unreadable = (): void => {
            store(OTHER, FITNESS_EN, 2);
            store(OWNER, richProfile(), 3);
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('connection refused');
        };
        const unreadableLines = (): number => events.filter((e) => e === 'profile.context_unreadable').length;

        it('the OWNER gets the owner-identical legacy context, and a warning: a failed read is never a failed reply for him', async () => {
            unreadable();
            setPlatformOwner(db, OWNER);
            for (const purpose of ['dm', 'comment_reply'] as const) {
                const ctx = await profileContextOrLegacy(OWNER, purpose);
                assert.deepEqual(ctx, legacyContext(purpose), purpose);
                assert.equal(ctx.version, null);
                assert.deepEqual(ctx.language, { code: 'ar', register: 'gulf', digits: 'arabic-indic', dir: 'rtl' });
                assert.equal(ctx.who.offerKind, 'course');
            }
            assert.equal(unreadableLines(), 2, 'said once per read');
        });

        it('the owner is found without case: an id the database writes in upper case is still him', async () => {
            unreadable();
            setPlatformOwner(db, OWNER.toUpperCase());
            assert.deepEqual(await profileContextOrLegacy(OWNER, 'dm'), legacyContext('dm'));
        });

        it('any other tenant gets a ProfileUnreadableError, so the job that asked is retried: never the owner\'s wording', async () => {
            unreadable();
            setPlatformOwner(db, OWNER);
            for (const purpose of ['dm', 'comment_reply'] as const) {
                await assert.rejects(profileContextOrLegacy(OTHER, purpose), (err: unknown) => {
                    assert.ok(err instanceof ProfileUnreadableError, 'its own error class: the callers tell it from anything else');
                    assert.equal(err.name, 'ProfileUnreadableError');
                    assert.equal(err.creatorId, OTHER);
                    assert.equal(err.purpose, purpose);
                    assert.match(err.message, /connection refused/);
                    assert.equal((err.cause as Error).message, 'connection refused', 'the database error is kept as the cause');
                    return true;
                }, purpose);
            }
            assert.equal(unreadableLines(), 2);
        });

        it('says so in the log line: which of the two it was', async () => {
            unreadable();
            const lines: Record<string, unknown>[] = [];
            const previous = setLogSink((_level, line) => { try { lines.push(JSON.parse(line)); } catch { /* not structured */ } });
            try {
                setPlatformOwner(db, OWNER);
                await profileContextOrLegacy(OWNER, 'dm');
                await assert.rejects(profileContextOrLegacy(OTHER, 'dm'), ProfileUnreadableError);
            } finally {
                setLogSink(previous);
            }
            const [forOwner, forOther] = lines.filter((l) => l.event === 'profile.context_unreadable');
            assert.match(String(forOwner!.effect), /legacy wording is used/);
            assert.match(String(forOther!.effect), /not the owner: the job is retried/);
        });

        it('when the owner cannot be found, anyone is answered in the legacy wording: the owner is never blocked while there is one tenant', async () => {
            unreadable();
            for (const owner of [new Error('lookup down'), null]) {
                setPlatformOwner(db, owner);
                for (const id of [OWNER, OTHER]) {
                    assert.deepEqual(await profileContextOrLegacy(id, 'dm'), legacyContext('dm'), `${id}, owner lookup ${owner === null ? 'finds nobody' : 'fails'}`);
                }
            }
        });

        it('a read that works never asks who the owner is, for any tenant', async () => {
            store(OTHER, FITNESS_EN, 2);
            setPlatformOwner(db, OWNER);
            await profileContextOrLegacy(OTHER, 'dm');
            assert.equal(db.ran(PLATFORM_OWNER_SQL).length, 0);
        });
    });

    it('profileContextOrLegacy still refuses a purpose that does not exist: a programming error is not a database error', async () => {
        await assert.rejects(profileContextOrLegacy(OWNER, 'nope' as never), /unknown profile context purpose: nope/);
        assert.throws(() => legacyContext('nope' as never), /unknown profile context purpose: nope/);
        assert.equal(events.filter((e) => e === 'profile.context_unreadable').length, 0);
    });
});

describe('legacyContext', () => {
    it('says for every purpose what the owner\'s legacy profile says: the language and register, and who he is and what he sells', () => {
        for (const purpose of PURPOSES) {
            const legacy = legacyContext(purpose);
            const owner = contextFor(OWNER_PROFILE, purpose, null);
            assert.deepEqual(legacy.language, owner.language, purpose);
            assert.deepEqual(legacy.who, owner.who, purpose);
            assert.equal(legacy.version, null);
            assert.equal(legacy.purpose, purpose);
        }
    });
});
