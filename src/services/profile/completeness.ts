/**
 * How complete a tenant's profile is, and the three things to do next (docs/onboarding/02 §4; plan P30).
 *
 * Pure: a profile in, numbers and ids out. The words ("Add 3 posts you're proud of") are the dashboard's, in both languages; this
 * file names an action by id, says what it unlocks and where it is fixed, and never produces a sentence.
 *
 * ─── What is counted ──────────────────────────────────────────────────────────────────────────
 *
 * A list of weighted fields (`FIELDS`), each one something an agent reads and a person can fix from the dashboard today. A field
 * that no screen lets a tenant change is not on the list: the meter must not hold a tenant to something they cannot do. The weights
 * say what a field unlocks:
 *
 *   the seven activation fields   35   the wizard guarantees them, so for a finished tenant they are a given
 *   voice samples                 15   better captions: the writer is shown the creator's own words (partial credit up to 3)
 *   presenter                      8   the Monteur's Editor writes "he", "she" or "they" for the person on camera
 *   audience                       8   the Growth coach says who the content is for
 *   portrait                      10   the infographic footer
 *   DM hand-off                   10   when the bot hands a chat to a person; counted only while the DM bot is switched on
 *
 * The percentage is earned over what applies, so a tenant whose DM bot is off is not at 88% for want of a hand-off rule.
 * It reads 100 only when nothing is missing: 99.6 never rounds up to "complete".
 *
 * ─── The owner, and every tenant that predates profiles ───────────────────────────────────────
 *
 * The owner's setup is a Studio and a Growth settings row that grew before a profile existed. It never had a place for a niche, a
 * presenter's name, an audience description, a voice sample (his are `studio.examples`), a DM hand-off rule or a kind of creator, so
 * asking him for them is nagging him about things his setup was built without: his tenant was switched on, agent by agent, long
 * before any agent could ask. `legacy: true` (a tenant with no onboarding row, or one v34 inserted as completed with nobody having
 * filled it in, or the platform owner: `isGrandfathered`) therefore counts only the fields his setup DOES have a home for, i.e.
 * those marked `legacy: true` below: name, timezone, language, the main offer, its link and the portrait. His percentage is his
 * real state over those, and he is still told about anything that really is undone there, and about a platform he has not connected.
 *
 * ─── What to do next ──────────────────────────────────────────────────────────────────────────
 *
 * `nextBestActions` returns at most three, in a fixed order of what each unlocks most: finish setup, then connect Instagram and
 * Facebook (nothing posts or replies without it), then the profile's own gaps, then the other two platforms. A grandfathered tenant
 * never gets a profile action, only a platform he has not connected.
 */
import { activationMissing, primaryOffer } from './validate.js';
import type { CreatorProfile } from './types.js';

export interface CompletenessOptions {
    /** The tenant predates profiles (see above): count only the fields its setup can hold. */
    legacy?: boolean;
    /** The DM bot is switched on for this tenant: its hand-off rule counts. Off, it does not. */
    dm?: boolean;
}

/** Which platforms the tenant has connected. */
export interface Connections {
    meta: boolean;
    tiktok: boolean;
    youtube: boolean;
}

/** What a field or an action makes possible: the dashboard's "so that…" line is chosen by this word. */
export type Unlocks = 'setup' | 'comments' | 'captions' | 'reels' | 'infographics' | 'coach' | 'dm' | 'tiktok' | 'youtube';

interface Field {
    /** The field's id: `completeness().missing[].field`. */
    id: string;
    /** The profile paths it covers (what an "ask" sheet fills in). */
    paths: readonly string[];
    weight: number;
    /** Counted for a tenant that predates profiles: its setup has a home for this field. */
    legacy: boolean;
    /** Counted only while the DM bot is switched on. */
    needs?: 'dm';
    /** How much of the field is there, from 0 (nothing) to 1 (all of it). */
    filled: (p: CreatorProfile) => number;
}

const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
/** Up to `n` entries count, a third each when n is 3: the meter moves with every sample added. */
const upTo = (list: readonly unknown[], n: number): number => Math.min(list.filter(text).length, n) / n;

/** How many voice samples make "enough": the spec's "add 3 posts you're proud of". */
export const SAMPLES_ENOUGH = 3;

export const FIELDS: readonly Field[] = Object.freeze([
    { id: 'name', paths: ['identity.display_name'], weight: 6, legacy: true, filled: (p) => (text(p.identity.display_name.ar) || text(p.identity.display_name.en) ? 1 : 0) },
    { id: 'kind', paths: ['identity.kind'], weight: 4, legacy: false, filled: (p) => (p.identity.kind === null ? 0 : 1) },
    { id: 'niche', paths: ['identity.niche'], weight: 6, legacy: false, filled: (p) => (text(p.identity.niche) ? 1 : 0) },
    { id: 'timezone', paths: ['identity.timezone'], weight: 3, legacy: true, filled: (p) => (text(p.identity.timezone) ? 1 : 0) },
    {
        id: 'language', paths: ['language.primary', 'language.register'], weight: 6, legacy: true,
        filled: (p) => (p.language.primary === 'ar' && p.language.register === null ? 0 : 1),
    },
    { id: 'offer', paths: ['offers.primary.name'], weight: 6, legacy: true, filled: (p) => (text(primaryOffer(p.offers)?.name) ? 1 : 0) },
    {
        id: 'offer_link', paths: ['offers.primary.url'], weight: 4, legacy: true,
        // "They DM me to order" needs no link; an offer ordered by link needs one. No offer at all has no link either.
        filled: (p) => {
            const offer = primaryOffer(p.offers);
            if (!offer || !text(offer.name)) return 0;
            return offer.order_via === 'dm' || text(offer.url) ? 1 : 0;
        },
    },
    { id: 'voice_samples', paths: ['voice.samples'], weight: 15, legacy: false, filled: (p) => upTo(p.voice.samples, SAMPLES_ENOUGH) },
    { id: 'presenter', paths: ['presenter'], weight: 8, legacy: false, filled: (p) => (p.presenter === null ? 0 : 1) },
    { id: 'audience', paths: ['audience.description'], weight: 8, legacy: false, filled: (p) => (text(p.audience.description) ? 1 : 0) },
    { id: 'portrait', paths: ['brand.portrait_url'], weight: 10, legacy: true, filled: (p) => (text(p.brand.portrait_url) ? 1 : 0) },
    { id: 'dm_handoff', paths: ['dm.handoff'], weight: 10, legacy: false, needs: 'dm', filled: (p) => (p.dm.handoff === null ? 0 : 1) },
]);

export interface MissingField {
    field: string;
    paths: readonly string[];
    /** Its share of the meter, as weighted. */
    weight: number;
    /** How much of it is there already: 0, or a fraction for samples. */
    filled: number;
}

export interface Completeness {
    /** 0 to 100. 100 only when `missing` is empty. */
    percent: number;
    earned: number;
    /** What applies to this tenant: the denominator. */
    total: number;
    /** Heaviest first, then in the list's order. */
    missing: MissingField[];
}

function applicable(field: Field, opts: CompletenessOptions): boolean {
    if (opts.legacy && !field.legacy) return false;
    if (field.needs === 'dm' && !opts.dm) return false;
    return true;
}

export function completeness(profile: CreatorProfile, opts: CompletenessOptions = {}): Completeness {
    let earned = 0;
    let total = 0;
    const missing: MissingField[] = [];
    for (const field of FIELDS) {
        if (!applicable(field, opts)) continue;
        const filled = Math.max(0, Math.min(1, field.filled(profile)));
        earned += field.weight * filled;
        total += field.weight;
        if (filled < 1) missing.push({ field: field.id, paths: field.paths, weight: field.weight, filled });
    }
    // Stable: the sort is by weight only, so equal weights keep the list's order.
    missing.sort((a, b) => b.weight - a.weight);
    let percent = total === 0 ? 100 : Math.round((100 * earned) / total);
    if (missing.length === 0) percent = 100;
    else if (percent >= 100) percent = 99;
    return { percent, earned, total, missing };
}

// ─── The next three things ─────────────────────────────────────────────────────────────────────

export type ActionId =
    | 'finish_setup' | 'connect_meta' | 'voice_samples' | 'dm_handoff' | 'presenter' | 'portrait' | 'audience' | 'connect_tiktok' | 'connect_youtube';

/** Where an action is carried out: a sheet over the Overview that asks for the fields, a screen, or the setup wizard. */
export type ActionLink =
    | { kind: 'ask'; fields: readonly string[] }
    | { kind: 'page'; target: string; query?: string }
    | { kind: 'wizard' };

export interface NextAction {
    id: ActionId;
    unlocks: Unlocks;
    link: ActionLink;
    /** The profile paths it fills in (none for a platform to connect). */
    paths: readonly string[];
}

/** How many the Overview shows. */
export const MAX_ACTIONS = 3;

/** Exactly the weights' reading: an action is due while its field is not fully there. */
const fieldDue = (profile: CreatorProfile, id: string): boolean => {
    const field = FIELDS.find((f) => f.id === id);
    return !!field && field.filled(profile) < 1;
};

interface ActionRule {
    id: ActionId;
    unlocks: Unlocks;
    link: ActionLink;
    paths: readonly string[];
    /** Is it due for this tenant? Receives what `applicable` already decided, so a legacy tenant never reaches a profile rule. */
    due: (profile: CreatorProfile, connections: Connections, opts: CompletenessOptions) => boolean;
    /** A profile action: never offered to a tenant that predates profiles, and (for the DM) only while the bot is on. */
    profile: boolean;
}

/** In the order they are offered: what each unlocks, most first. */
const RULES: readonly ActionRule[] = Object.freeze([
    {
        id: 'finish_setup', unlocks: 'setup', link: { kind: 'wizard' }, paths: [], profile: true,
        due: (p) => activationMissing(p).length > 0,
    },
    { id: 'connect_meta', unlocks: 'comments', link: { kind: 'page', target: 'settings' }, paths: [], profile: false, due: (_p, c) => !c.meta },
    { id: 'voice_samples', unlocks: 'captions', link: { kind: 'ask', fields: ['voice.samples'] }, paths: ['voice.samples'], profile: true, due: (p) => fieldDue(p, 'voice_samples') },
    { id: 'dm_handoff', unlocks: 'dm', link: { kind: 'ask', fields: ['dm.handoff'] }, paths: ['dm.handoff'], profile: true, due: (p, _c, o) => !!o.dm && fieldDue(p, 'dm_handoff') },
    { id: 'presenter', unlocks: 'reels', link: { kind: 'ask', fields: ['presenter'] }, paths: ['presenter'], profile: true, due: (p) => fieldDue(p, 'presenter') },
    { id: 'portrait', unlocks: 'infographics', link: { kind: 'page', target: 'infographics' }, paths: ['brand.portrait_url'], profile: false, due: (p) => fieldDue(p, 'portrait') },
    { id: 'audience', unlocks: 'coach', link: { kind: 'ask', fields: ['audience.description'] }, paths: ['audience.description'], profile: true, due: (p) => fieldDue(p, 'audience') },
    { id: 'connect_tiktok', unlocks: 'tiktok', link: { kind: 'page', target: 'settings' }, paths: [], profile: false, due: (_p, c) => !c.tiktok },
    { id: 'connect_youtube', unlocks: 'youtube', link: { kind: 'page', target: 'settings' }, paths: [], profile: false, due: (_p, c) => !c.youtube },
]);

/**
 * At most `MAX_ACTIONS` things to do next, most valuable first, each with where to do it.
 *
 * `portrait` is not a profile action by this file's reading even though its field is one: a grandfathered tenant HAS a portrait
 * home (the infographic settings), so if he ever loses it he is told, like he is told about a platform he has not connected. Every
 * other profile action is for tenants that went through the wizard.
 */
export function nextBestActions(profile: CreatorProfile, connections: Connections, opts: CompletenessOptions = {}): NextAction[] {
    const out: NextAction[] = [];
    for (const rule of RULES) {
        if (out.length >= MAX_ACTIONS) break;
        if (opts.legacy && rule.profile) continue;
        if (!rule.due(profile, connections, opts)) continue;
        out.push({ id: rule.id, unlocks: rule.unlocks, link: rule.link, paths: rule.paths });
    }
    return out;
}

/** The ids of every action there is, for the dashboard's check that it has words for each. */
export const ACTION_IDS: readonly ActionId[] = RULES.map((r) => r.id);
