/**
 * Seeding the owner's offers (`ownerOffers.ts`, `scripts/seed-owner-offers.mts`, docs/onboarding/05 P13): the plan, the checks that
 * decide whether it may be saved, and the write.
 *
 * What is pinned: the nine mappings merge into the owner's offers WITHOUT duplicating the Agentic AI course the backfill made, every
 * offer is a `course`, the primary offer stays his; the prompt surface (every builder the parity script hashes) is built before and
 * after and a single row that differs REFUSES the save, with nothing written and `saveProfile` never called; the save is against the
 * version that was read; and a second run finds the nine in place and writes nothing.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ELAMIR_AGENT, ELAMIR_GROWTH } from '../studio/testFixtures.js';
import { invalidateTenantCache } from '../tenant.js';
import { setLogSink } from '../../utils/log.js';
import { campaignSeeds, legacyCampaignSeeds, readCampaignSeeds } from './campaignSeeds.js';
import { offerKindOf } from './context.js';
import { LEGACY_COURSE_MAPPINGS } from './legacyCourseMappings.js';
import { profileFromLegacy } from './legacy.js';
import {
    applyOwnerOffers, assessOwnerOffers, campaignOf, courseTitleOf, formatOwnerOffers, offerIdFor, OwnerOffersRefused, type OwnerOffersInput, planOwnerOffers,
} from './ownerOffers.js';
import { ProfileError, resetProfileTableWarning, type SaveProfileOptions } from './store.js';
import { installProfileDb, OWNER, OWNER_STUDIO, type ProfileDb, seededState, setPlatformOwner, type State } from './testDb.js';
import { deepFreeze, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';
import { validateProfile } from './validate.js';

/** The owner's backfilled profile, as the database holds it: one `course` offer from his product, no campaign. */
const backfilled = (): CreatorProfile => profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH);

const inputFor = (profile: CreatorProfile, over: Partial<OwnerOffersInput> = {}): OwnerOffersInput => ({
    studio: OWNER_STUDIO, growth: ELAMIR_GROWTH, profile, version: 1, agent: ELAMIR_AGENT, stored: { repaired: [], newerSchema: false }, ...over,
});

const KEYS = Object.keys(LEGACY_COURSE_MAPPINGS);

describe('planOwnerOffers: the nine merged into his offers', () => {
    const before = backfilled();
    const plan = planOwnerOffers(before);

    it('starts from what the backfill made: one course offer, primary, no campaign', () => {
        assert.equal(before.offers.length, 1);
        assert.equal(before.offers[0]!.kind, 'course');
        assert.equal(before.offers[0]!.primary, true);
        assert.equal(before.offers[0]!.campaign, undefined);
    });

    it('gives nine offers and a campaign on every one, in the mappings\' order: the existing course is first and not duplicated', () => {
        assert.equal(plan.next.offers.length, 9);
        assert.deepStrictEqual(plan.next.offers.map((o) => o.campaign!.name_match), KEYS);
        assert.deepStrictEqual(plan.actions.map((a) => a.action), ['attach', ...Array(8).fill('create')]);
        assert.equal(plan.next.offers[0]!.id, before.offers[0]!.id, 'the offer that was there is the one that took the first campaign');
        assert.equal(plan.next.offers.filter((o) => /agentic ai/i.test(o.name)).length, 1, 'one Agentic AI course, not two');
        assert.equal(plan.changed, true);
        assert.deepStrictEqual(plan.problems, []);
    });

    it('every offer is a `course`, so his offers are "course" and the DM wording stays «كورسات» and GO_TO_COURSE_1', () => {
        assert.ok(plan.next.offers.every((o) => o.kind === 'course'));
        assert.equal(offerKindOf(plan.next.offers), 'course');
    });

    it('the primary offer is his, as it was: same id, name, link, facts and bullets; only the campaign is added', () => {
        const [was] = before.offers;
        const { campaign, ...rest } = plan.next.offers[0]!;
        assert.deepStrictEqual(rest, was);
        assert.equal(campaign!.name_match, 'agentic ai');
        assert.equal(plan.next.offers.filter((o) => o.primary).length, 1);
    });

    it('the eight new offers are named for their course (the title the mapping\'s DM quotes), ordered by message, with no link made up', () => {
        for (const o of plan.next.offers.slice(1)) {
            assert.equal(o.url, '', o.id);
            assert.equal(o.order_via, 'dm', o.id);
            assert.equal(o.primary, false, o.id);
            assert.deepStrictEqual([o.price, o.keyword, o.facts, o.bullets], ['', '', [], []], o.id);
            assert.ok(o.name.toLowerCase().includes(o.campaign!.name_match), `${o.id}: the import gives «${o.name}» to this key`);
            assert.ok(LEGACY_COURSE_MAPPINGS[o.campaign!.name_match]!.dmTemplate.includes(`"${o.name}"`), `${o.id}: the DM quotes its name`);
        }
        assert.deepStrictEqual(plan.next.offers.slice(1).map((o) => o.name), [
            'GoLang Course: Learn Go in Arabic', 'Swift Programming Language | in Arabic', 'CSS3 For Beginners [In Arabic]', 'HTML5 For Beginners [In Arabic]',
            'Problem Solving - with C# [in Arabic]', 'Java for Beginners [in Arabic]', 'Python For Beginners [in Arabic]', 'C# For Beginners [in Arabic]',
        ]);
        assert.deepStrictEqual(plan.next.offers.map((o) => o.id), ['main', ...['golang', 'swift', 'css3', 'html5', 'problem-solving', 'java', 'python', 'c-sharp'].map((s) => `course-${s}`)]);
    });

    it('is a valid profile, and its campaign seeds are exactly his nine, byte for byte', () => {
        const out = validateProfile(plan.next);
        assert.ok('profile' in out, 'problems' in out ? out.problems.join('; ') : '');
        assert.deepStrictEqual(campaignSeeds(plan.next), legacyCampaignSeeds());
    });

    it('changes nothing in the argument, and nothing but the offers in the result', () => {
        const frozen = deepFreeze(backfilled());
        const out = planOwnerOffers(frozen);
        assert.equal(frozen.offers.length, 1);
        const { offers: _a, ...rest } = out.next;
        const { offers: _b, ...was } = frozen;
        assert.deepStrictEqual(rest, was);
    });

    it('is idempotent: planning the result again finds all nine in place and changes nothing', () => {
        const again = planOwnerOffers(plan.next);
        assert.equal(again.changed, false);
        assert.deepStrictEqual(again.actions.map((a) => a.action), Array(9).fill('unchanged'));
        assert.deepStrictEqual(again.next, plan.next);
    });

    it('survives storage: written like jsonb and read back, the nine are still the nine', () => {
        const stored = throughJsonb(plan.next) as CreatorProfile;
        assert.deepStrictEqual(campaignSeeds(stored), legacyCampaignSeeds());
    });

    it('an offer already carrying a campaign for a key is the one that keeps it: the import does not make a second', () => {
        const half = planOwnerOffers(before).next;
        half.offers.splice(3); // main, golang, swift
        const rest = planOwnerOffers(half);
        assert.equal(rest.next.offers.length, 9);
        assert.deepStrictEqual(rest.actions.map((a) => a.action), ['unchanged', 'unchanged', 'unchanged', ...Array(6).fill('create')]);
    });

    it('a course that exists under another id is found by name, not duplicated', () => {
        const custom = backfilled();
        custom.offers.push({ id: 'my-golang', kind: 'course', name: 'GoLang Course: Learn Go in Arabic', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false });
        const out = planOwnerOffers(custom);
        assert.equal(out.next.offers.length, 9);
        assert.equal(out.next.offers.find((o) => o.id === 'my-golang')!.campaign!.name_match, 'golang');
        assert.equal(out.actions.find((a) => a.key === 'golang')!.action, 'attach');
    });

    it('a different campaign on the same key is a conflict, and is never overwritten', () => {
        const edited = planOwnerOffers(before).next;
        edited.offers[1]!.campaign = { ...edited.offers[1]!.campaign!, dm_template: 'his own wording {url} {username}' };
        const out = planOwnerOffers(edited);
        assert.equal(out.actions[1]!.action, 'conflict');
        assert.equal(out.next.offers[1]!.campaign!.dm_template, 'his own wording {url} {username}');
        assert.equal(out.problems.length, 1);
        assert.match(out.problems[0]!, /course-golang.*«golang».*not overwritten/);
    });

    it('a mapping whose DM names no course exactly once cannot become an offer, and says so', () => {
        const out = planOwnerOffers(before, { solo: { triggerKeywords: 'a, b', dmTemplate: 'no quotes here {url} {username}', publicReplies: 'x | y' } });
        assert.equal(out.next.offers.length, 1);
        assert.match(out.problems[0]!, /«solo» does not name its course exactly once/);
        assert.equal(courseTitleOf({ triggerKeywords: '', dmTemplate: '"a" and "b"', publicReplies: '' }), null);
        assert.equal(courseTitleOf({ triggerKeywords: '', dmTemplate: 'one "a b" here', publicReplies: '' }), 'a b');
    });

    it('campaignOf splits on the two separators and offerIdFor makes a slug', () => {
        const c = campaignOf('c#', { triggerKeywords: 'a, b', dmTemplate: 'd', publicReplies: 'x | y | z' });
        assert.deepStrictEqual(c, { name_match: 'c#', match: 'substring', keywords: ['a', 'b'], dm_template: 'd', public_replies: ['x', 'y', 'z'] });
        assert.equal(offerIdFor('c#'), 'course-c-sharp');
        assert.equal(offerIdFor('problem solving'), 'course-problem-solving');
        assert.equal(offerIdFor('css3'), 'course-css3');
    });
});

describe('assessOwnerOffers', () => {
    it('his live shape is ready: valid, all courses, his nine, and every prompt builder builds the same bytes before and after', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled()));
        assert.deepStrictEqual(a.reasons, []);
        assert.equal(a.status, 'ready');
        assert.equal(a.offerKind, 'course');
        assert.equal(a.version, 1);
        assert.ok(a.surface, 'the surfaces were compared');
        assert.equal(a.surface!.mismatches, 0);
        assert.equal(a.surface!.threw, 0);
        assert.equal(a.surface!.ok, true);
        assert.equal(a.surface!.digest.a, a.surface!.digest.b, 'one digest for both');
        const names = a.surface!.rows.map((r) => r.name);
        // What the owner's tenant is served: the DM bot, the comment replies, the infographic writer and the Studio.
        for (const group of ['dm.', 'comments.', 'infographic.', 'studio.']) assert.ok(names.some((n) => n.startsWith(group)), `${group} rows are compared`);
        assert.ok(a.surface!.builders >= 30, `${a.surface!.builders} builders`);
    });

    it('a profile that already has the nine is unchanged: nothing to write', async () => {
        const seeded = planOwnerOffers(backfilled()).next;
        const a = await assessOwnerOffers(inputFor(seeded, { version: 2 }));
        assert.equal(a.status, 'unchanged');
        assert.deepStrictEqual(a.reasons, []);
        await assert.rejects(() => applyOwnerOffers(OWNER, a, async () => { throw new Error('must not be called'); }), OwnerOffersRefused);
    });

    // ─── The refusals ───

    it('REFUSES when a surface would change: his only offer is not a course, so the nine make his offers "mixed" and the DM rule 2 and button move', async () => {
        const notACourse = backfilled();
        notACourse.offers[0]!.kind = 'program';
        const a = await assessOwnerOffers(inputFor(notACourse));
        assert.equal(a.status, 'refused');
        assert.equal(a.offerKind, 'mixed');
        assert.ok(a.surface && a.surface.mismatches > 0, 'the comparison found rows that differ');
        const rows = a.surface!.rows.filter((r) => !r.match).map((r) => r.name);
        assert.ok(rows.some((n) => n.startsWith('dm.')), `a DM row differs: ${rows.join(', ')}`);
        for (const row of rows) assert.ok(a.reasons.some((r) => r.includes(`prompt surface row ${row} would change`)), `${row} is named in the reasons`);
        assert.ok(a.reasons.some((r) => /is not a course.*mixed.*GO_TO_OFFER_1/.test(r)), a.reasons.join(' | '));
    });

    it('REFUSES an offer of another kind even where the surface would not move: every offer must be a course', async () => {
        const mixed = backfilled();
        mixed.offers.push({ id: 'call', kind: 'coaching', name: 'A call', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false });
        const a = await assessOwnerOffers(inputFor(mixed));
        assert.equal(a.status, 'refused');
        assert.ok(a.reasons.some((r) => /call \(coaching\) is not a course/.test(r)));
    });

    it('REFUSES a conflict, an invalid result, and a stored profile that needed repair or is from a newer release', async () => {
        const edited = planOwnerOffers(backfilled()).next;
        edited.offers[1]!.campaign!.dm_template = 'his own wording {url}';
        const conflict = await assessOwnerOffers(inputFor(edited, { version: 2 }));
        assert.equal(conflict.status, 'refused');
        assert.ok(conflict.reasons.some((r) => /not overwritten/.test(r)));

        const full = backfilled();
        for (let i = 0; i < 3; i++) full.offers.push({ id: `x${i}`, kind: 'course', name: `Extra ${i}`, order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false });
        const tooMany = await assessOwnerOffers(inputFor(full));
        assert.equal(tooMany.status, 'refused', 'four offers and the other eight: more than the ten a profile may hold');
        assert.ok(tooMany.reasons.some((r) => /not valid/.test(r)), tooMany.reasons.join(' | '));

        const repaired = await assessOwnerOffers(inputFor(backfilled(), { stored: { repaired: ['voice.guide'], newerSchema: false } }));
        assert.equal(repaired.status, 'refused');
        assert.ok(repaired.reasons.some((r) => /needed repair at voice\.guide/.test(r)));
        const newer = await assessOwnerOffers(inputFor(backfilled(), { stored: { repaired: [], newerSchema: true } }));
        assert.equal(newer.status, 'refused');
        assert.ok(newer.reasons.some((r) => /newer release/.test(r)));
    });

    it('the primary offer is the one marked primary, not the first: a course listed before it changes nothing', async () => {
        const odd = backfilled();
        odd.offers.unshift({ id: 'side', kind: 'course', name: 'Side course', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false });
        const a = await assessOwnerOffers(inputFor(odd));
        assert.equal(a.status, 'ready', a.reasons.join(' | '));
        assert.equal(a.plan.next.offers.find((o) => o.primary)!.id, 'main');
        assert.equal(a.reasons.some((r) => /primary offer would change/.test(r)), false);
    });

    it('the surface is built from the profile the assessment is given, not from a fixture: another register changes the same rows', async () => {
        const gulf = await assessOwnerOffers(inputFor(backfilled()));
        const egyptian = backfilled();
        egyptian.language.register = 'egyptian';
        const other = await assessOwnerOffers(inputFor(egyptian));
        assert.equal(other.status, 'ready');
        assert.notEqual(other.surface!.digest.a, gulf.surface!.digest.a, 'a different tenant\'s surface hashes differently');
        assert.equal(other.surface!.digest.a, other.surface!.digest.b);
    });
});

// ─── The write, against the profile tables' stand-in ───────────────────────────────────────

describe('applyOwnerOffers', () => {
    let state: State;
    let db: ProfileDb;
    let restoreSink: (() => void) | undefined;

    beforeEach(() => {
        resetProfileTableWarning();
        invalidateTenantCache();
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
        state = seededState();
        db = installProfileDb(state);
        setPlatformOwner(db, OWNER);
        state.profiles.set(OWNER, { profile: throughJsonb(backfilled()), version: 1, activated_at: null, updated_by: null });
    });
    afterEach(() => {
        db.restore();
        restoreSink?.();
    });

    const writes = (): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql));
    /** The Studio and Growth rows as the mirror leaves them: their `updated_at` is the one column a save is meant to move. */
    const settingsRows = () => JSON.stringify([state.studio.get(OWNER), state.growth.get(OWNER)], (key, value) => (key === 'updated_at' ? undefined : value));

    it('a ready assessment is saved as the next version, source backfill, no user, against the version it read', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled()));
        assert.equal(a.status, 'ready');
        const settingsBefore = JSON.parse(settingsRows());
        const saved = await applyOwnerOffers(OWNER, a);
        assert.equal(saved.version, 2);
        assert.deepStrictEqual(campaignSeeds(saved.profile), legacyCampaignSeeds());
        const row = state.profiles.get(OWNER)!;
        assert.equal(row.version, 2);
        assert.equal(row.updated_by, null);
        assert.deepStrictEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[2, 'backfill', null]]);
        assert.deepStrictEqual(campaignSeeds(row.profile as CreatorProfile), legacyCampaignSeeds(), 'what is stored is the nine');
        assert.deepStrictEqual(JSON.parse(settingsRows()), settingsBefore, 'the mirror wrote the Studio and Growth rows back exactly as they were');
    });

    it('then the API answers the nine from his profile (`source: profile`), and a second run finds nothing to do', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled()));
        await applyOwnerOffers(OWNER, a);
        const answer = await readCampaignSeeds(OWNER);
        assert.equal(answer.source, 'profile');
        assert.deepStrictEqual(answer.seeds, legacyCampaignSeeds());
        const stored = state.profiles.get(OWNER)!;
        const again = await assessOwnerOffers(inputFor(throughJsonb(stored.profile) as CreatorProfile, { version: stored.version }));
        assert.equal(again.status, 'unchanged');
    });

    it('a refused assessment is NEVER saved: `saveProfile` is not called and nothing is written', async () => {
        const notACourse = backfilled();
        notACourse.offers[0]!.kind = 'program';
        state.profiles.set(OWNER, { profile: throughJsonb(notACourse), version: 1, activated_at: null, updated_by: null });
        const a = await assessOwnerOffers(inputFor(notACourse));
        assert.equal(a.status, 'refused');
        const calls: unknown[] = [];
        await assert.rejects(
            () => applyOwnerOffers(OWNER, a, async (...args) => { calls.push(args); throw new Error('must not be called'); }),
            (err: unknown) => err instanceof OwnerOffersRefused && /prompt surface row dm\./.test(err.message) && err.assessment === a,
        );
        assert.deepStrictEqual(calls, [], 'the gate is before the save');
        // And with the real save in its place: the stored profile and the history are as they were.
        await assert.rejects(() => applyOwnerOffers(OWNER, a), OwnerOffersRefused);
        assert.deepStrictEqual(writes(), [], 'no statement of any kind was sent');
        assert.equal(state.profiles.get(OWNER)!.version, 1);
        assert.deepStrictEqual(state.versions, []);
    });

    it('a profile that changed since it was read is a conflict, not an overwrite', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled()));
        // Someone saved version 2 in between.
        state.profiles.set(OWNER, { profile: throughJsonb({ ...backfilled(), goals: { followers: 1, views: 1 } }), version: 2, activated_at: null, updated_by: null });
        await assert.rejects(() => applyOwnerOffers(OWNER, a), (err: unknown) => err instanceof ProfileError && err.code === 'PROFILE_VERSION_CONFLICT');
        assert.equal(state.profiles.get(OWNER)!.version, 2);
        assert.deepStrictEqual(state.versions, [], 'nothing was written: the update matched no row');
        assert.deepStrictEqual((state.profiles.get(OWNER)!.profile as CreatorProfile).offers.length, 1);
    });

    it('hands saveProfile exactly: the profile it assessed, expectVersion, source backfill and no user', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled(), { version: 7 }));
        let seen: { id: string; next: unknown; options: Pick<SaveProfileOptions, 'expectVersion' | 'source' | 'userId'> } | null = null;
        await applyOwnerOffers(OWNER, a, async (id, next, options) => {
            seen = { id, next, options };
            return { profile: next as CreatorProfile, version: 8 };
        });
        assert.deepStrictEqual(seen, { id: OWNER, next: a.plan.next, options: { expectVersion: 7, source: 'backfill', userId: null } });
    });

    it('a tenant with no stored profile (the virtual one) is saved with expectVersion null: the store creates version 1 first', async () => {
        state.profiles.delete(OWNER);
        const a = await assessOwnerOffers(inputFor(backfilled(), { version: null, stored: null }));
        assert.equal(a.status, 'ready');
        const saved = await applyOwnerOffers(OWNER, a);
        assert.equal(saved.version, 2);
        assert.deepStrictEqual(state.versions.map((v) => [v.version, v.source]), [[1, 'backfill'], [2, 'backfill']]);
    });
});

// ─── The report ──────────────────────────────────────────────────────────────────────────────

describe('formatOwnerOffers', () => {
    const header = { tenant: OWNER, profile: 'stored v1', target: 'db.example/postgres', mode: 'dry-run' as const };

    it('lists every offer by title and what happens to it, and the verdict, and prints no link, template, keyword or setting', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled()));
        const out = formatOwnerOffers(a, header);
        assert.match(out, /DRY RUN \(reads only; nothing is written\)/);
        assert.match(out, /offers: 1 now, 9 after/);
        assert.match(out, /campaign added to the existing offer/);
        assert.equal(out.match(/new offer/g)!.length, 8);
        assert.match(out, /identical to the nine mappings the dashboard carried/);
        assert.match(out, /\d+ builders · 0 differ · 0 threw/);
        assert.match(out, /verdict: READY \(run again with --apply to write version 2\)/);
        for (const secret of ['https://', '{username}', '{url}', 'referralCode', 'ذكاء اصطناعي, ايجنتك']) assert.ok(!out.includes(secret), `the report does not print ${secret}`);
    });

    it('says what was refused and why', async () => {
        const notACourse = backfilled();
        notACourse.offers[0]!.kind = 'program';
        const out = formatOwnerOffers(await assessOwnerOffers(inputFor(notACourse)), header);
        assert.match(out, /verdict: REFUSED/);
        assert.match(out, / - the prompt surface row dm\./);
        assert.match(out, /NOT course: the DM wording would change/);
    });

    it('an apply run says it is writing, and an unchanged one says there is nothing to do', async () => {
        const a = await assessOwnerOffers(inputFor(backfilled()));
        assert.match(formatOwnerOffers(a, { ...header, mode: 'apply' }), /mode: APPLY/);
        assert.match(formatOwnerOffers(a, { ...header, mode: 'apply' }), /verdict: READY \(writing version 2\)/);
        const done = await assessOwnerOffers(inputFor(planOwnerOffers(backfilled()).next, { version: 2 }));
        assert.match(formatOwnerOffers(done, header), /verdict: NOTHING TO DO/);
    });
});
