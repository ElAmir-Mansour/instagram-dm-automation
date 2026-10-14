/**
 * The profile context (docs/onboarding/01 §4, 05 §2): what an agent is told about the creator it works for,
 * cut to what its job needs.
 *
 *   contextFor(profile, purpose, version)    pure: the context a profile gives one purpose
 *   profileContext(creatorId, purpose)       the same, for a tenant: its stored profile, else the virtual one (`loadProfile`)
 *   profileContextOrLegacy(creatorId, p)     the same for the DM bot and the comment replies (P8), which speak to customers: a profile that
 *                                            cannot be read is, for the platform owner, `legacyContext(p)` (his wording, and a warning);
 *                                            for any other tenant a `ProfileUnreadableError`, which the job queue retries
 *
 * A context is a *base* every purpose shares plus a *slice* only that purpose reads, flattened into one object:
 *
 *   base   { purpose, version, language, who, guard }
 *   slice  dm, comment_reply, carousel, clip_pick, clip_copy, clip_edit, analyst, infographic, growth_coach
 *
 * **Phase 2's rule** (01 §4): a fact that already has a home in the `StudioSettings` view keeps being read from the
 * view. A context carries only the facts that have no home there today (the register, who the creator is, the
 * presenter, the content rules…), plus what the DM bot and the Growth coach need. So P8–P13 hand each builder the
 * settings *and* a context; nothing here duplicates a field the builders already read.
 *
 * **Language is resolved per surface.** `language.surfaces.<surface>` may speak another language or register than
 * the profile's, so the same tenant can be Gulf Arabic in its reels and فصحى in its infographics. Each purpose
 * belongs to one surface (`SURFACE_OF`): the reels purposes (`clip_pick`, `clip_copy`, `clip_edit`, `analyst`) share one,
 * a comment reply is `comments`, the coach is `coach`, and the rest are named for theirs.
 *
 * **The DM bot's knowledge base is not here.** It stays an agent setting (`ai_agents.knowledge_base`, unbounded),
 * so the DM slice carries the facts about the creator and never the knowledge (01 §7.1).
 *
 * A context holds copies: a caller that edits one cannot edit the profile (or the per-request cache behind it).
 *
 * A profile written by a *newer* release is not read by a context either: the settings readers decline to overlay it
 * (`overlayProfile`: a view over half a profile would present half a profile as the tenant's), and a context follows
 * them, so the coach's language and timezone are what the settings show after a rollback. `profileContext` cuts the
 * context from the legacy rows instead (`loadLegacyProfile`), with `version: null`, and `overlayProfile` logs it once.
 */
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import type { Exec } from '../studio/common.js';
import { getPlatformOwnerId } from '../tenant.js';
import { legacyBase } from './legacy.js';
import { loadLegacyProfile, loadProfile, overlayProfile } from './store.js';
import type {
    Address, ArabicRegister, AudienceLevel, ContentRulePreset, CreatorKind, CreatorProfile, Digits, Domain, EmojiLevel, FaqItem, Lang,
    Offer, OfferKind, Presenter, Surface,
} from './types.js';
import { scheduleTimezone } from './views.js';

// ─── Purposes ────────────────────────────────────────────────────────────────────────────────

/** Every job an agent does with the profile, in the order the spec lists them. */
export const PURPOSES = [
    'dm', 'comment_reply', 'carousel', 'clip_pick', 'clip_copy', 'clip_edit', 'analyst', 'infographic', 'growth_coach',
] as const;

export type Purpose = (typeof PURPOSES)[number];

export const isPurpose = (value: unknown): value is Purpose => typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);

/**
 * The surface each purpose speaks on: where its language override (`language.surfaces`) is read from. The four
 * reels purposes are one surface because the Monteur writes one reel in one voice, from the pick to the Analyst.
 */
export const SURFACE_OF: { readonly [P in Purpose]: Surface } = Object.freeze({
    dm: 'dm',
    comment_reply: 'comments',
    carousel: 'carousel',
    clip_pick: 'reels',
    clip_copy: 'reels',
    clip_edit: 'reels',
    analyst: 'reels',
    infographic: 'infographic',
    growth_coach: 'coach',
});

// ─── The shapes ──────────────────────────────────────────────────────────────────────────────

export interface ContextLanguage {
    /** The language this surface speaks: its own override, else the profile's `language.primary`. */
    code: Lang;
    /**
     * The Arabic register: the surface's own, else the profile's, and `msa` when the surface speaks Arabic and neither
     * says (the validator refuses that profile, so it is only a profile read before it was valid). It is kept when
     * `code` is 'en': an English surface can still be asked for one Arabic piece (an infographic job in Arabic), and
     * the register that piece is written in is the one the surface names. null when nothing names one.
     */
    register: ArabicRegister | null;
    /** For Arabic text only: an English line is not written in Arabic-Indic digits whatever this says. */
    digits: Digits;
    /**
     * The writing direction of `code`. It is not the carousel template's `brand.direction`, which stays a Studio
     * setting of its own (01 §7.2) and which a profile never overrides.
     */
    dir: 'rtl' | 'ltr';
}

export interface ContextWho {
    kind: CreatorKind | null;
    /** The English noun phrase the prompts use for them, 2-4 words: "tech educator". */
    role: string;
    niche: string;
    domain: Domain;
    /** The kind every offer shares ('course'), 'mixed' when they differ, null when there are none. */
    offerKind: OfferKind | 'mixed' | null;
}

export interface ContextGuard {
    /** Hard: in the prompt and in the validators that reject generated copy. */
    never_mention: string[];
    rules: ContentRulePreset[];
    custom_rules: string[];
}

export interface ContextBase<P extends Purpose = Purpose> {
    purpose: P;
    /** The stored version this was cut from, or null for the virtual profile of a tenant that has none yet. */
    version: number | null;
    language: ContextLanguage;
    who: ContextWho;
    guard: ContextGuard;
}

/** Who the content is for: the profile's `audience`, minus its heatmap timezone, which is a Growth setting. */
export interface AudienceBrief {
    description: string;
    level: AudienceLevel | null;
    pains: string[];
    goals: string[];
    countries: string[];
    languages: string[];
}

export interface ContextGoals {
    followers: number;
    views: number;
}

export interface ContextVoice {
    address: Address;
    emoji: EmojiLevel;
}

/** What a comment reply needs of an offer: what it is called, where it is, the word that asks for it, and its campaign. */
export type CommentOffer = Pick<Offer, 'name' | 'url' | 'keyword' | 'primary' | 'campaign'>;

export interface Slices {
    dm: {
        names: { display_name: { ar: string; en: string }; brand_name: string };
        offers: Offer[];
        faq: FaqItem[];
        handoff: { when: string; message: string } | null;
        hours: { days: number[]; from: string; to: string } | null;
        links: { handle: string; site: string; links: CreatorProfile['socials']['links'] };
        voice: { guide: string } & ContextVoice;
        /** `dm.voice_guide`: the voice of a chat reply. '' when the profile has none, and then the sales prompt uses `voice.guide`. */
        voice_guide: string;
        /** The tenant's timezone (`identity.timezone`), UTC when it has none: the hours are in it, and a price's "valid until" ends at the end of that day in it. */
        timezone: string;
    };
    comment_reply: { offers: CommentOffer[]; voice: ContextVoice };
    carousel: { audience: AudienceBrief; pillars: string[] };
    clip_pick: { pillars: string[]; audience: AudienceBrief };
    clip_copy: { voice: ContextVoice };
    clip_edit: { presenter: Presenter | null };
    analyst: { pillars: string[]; goals: ContextGoals };
    infographic: Record<never, never>;
    growth_coach: {
        /**
         * The tenant's timezone (`identity.timezone`), UTC when it has none: what `schedule.timezone` reads. The audience's
         * own heatmap override (`audience.timezone`) is not folded in; it stays a Growth setting, and the heatmap puts it first.
         */
        timezone: string;
        audience: AudienceBrief;
        goals: ContextGoals;
        pillars: string[];
    };
}

/** A context: the base every purpose shares and the slice that purpose reads, in one object. */
export type ProfileContext<P extends Purpose = Purpose> = ContextBase<P> & Slices[P];

// ─── Cutting a context ───────────────────────────────────────────────────────────────────────

/** The kind every offer shares, 'mixed' when they differ, null when there are no offers. A blank offer still has a kind. */
export function offerKindOf(offers: readonly Pick<Offer, 'kind'>[]): OfferKind | 'mixed' | null {
    if (offers.length === 0) return null;
    return offers.every((o) => o.kind === offers[0]!.kind) ? offers[0]!.kind : 'mixed';
}

function languageOf(p: CreatorProfile, surface: Surface): ContextLanguage {
    const own = p.language.surfaces[surface];
    const code = own?.language ?? p.language.primary;
    return {
        code,
        register: own?.register ?? p.language.register ?? (code === 'ar' ? 'msa' : null),
        digits: p.language.digits,
        dir: code === 'ar' ? 'rtl' : 'ltr',
    };
}

const audienceOf = (p: CreatorProfile): AudienceBrief => ({
    description: p.audience.description,
    level: p.audience.level,
    pains: [...p.audience.pains],
    goals: [...p.audience.goals],
    countries: [...p.audience.countries],
    languages: [...p.audience.languages],
});

const goalsOf = (p: CreatorProfile): ContextGoals => ({ followers: p.goals.followers, views: p.goals.views });
const voiceOf = (p: CreatorProfile): ContextVoice => ({ address: p.voice.address, emoji: p.voice.emoji });

/** A comment-reply offer: only what a reply needs, and `campaign` only when the offer has one (an absent key stays absent). */
function commentOffer(o: Offer): CommentOffer {
    const out: CommentOffer = { name: o.name, url: o.url, keyword: o.keyword, primary: o.primary };
    if (o.campaign) out.campaign = structuredClone(o.campaign);
    return out;
}

/** Each purpose's slice. A mapped type, so a purpose added to `PURPOSES` without one does not compile. */
const SLICE_OF: { readonly [P in Purpose]: (p: CreatorProfile) => Slices[P] } = {
    dm: (p) => ({
        names: { display_name: { ...p.identity.display_name }, brand_name: p.identity.brand_name },
        offers: structuredClone(p.offers),
        faq: structuredClone(p.dm.faq),
        handoff: structuredClone(p.dm.handoff),
        hours: structuredClone(p.dm.hours),
        links: { handle: p.socials.handle, site: p.socials.site, links: { ...p.socials.links } },
        voice: { guide: p.voice.guide, ...voiceOf(p) },
        voice_guide: p.dm.voice_guide ?? '',
        timezone: scheduleTimezone(p),
    }),
    comment_reply: (p) => ({ offers: p.offers.map(commentOffer), voice: voiceOf(p) }),
    carousel: (p) => ({ audience: audienceOf(p), pillars: [...p.content.pillars] }),
    clip_pick: (p) => ({ pillars: [...p.content.pillars], audience: audienceOf(p) }),
    clip_copy: (p) => ({ voice: voiceOf(p) }),
    clip_edit: (p) => ({ presenter: p.presenter ? { ...p.presenter } : null }),
    analyst: (p) => ({ pillars: [...p.content.pillars], goals: goalsOf(p) }),
    infographic: () => ({}),
    growth_coach: (p) => ({
        timezone: scheduleTimezone(p),
        audience: audienceOf(p),
        goals: goalsOf(p),
        pillars: [...p.content.pillars],
    }),
};

function assertPurpose(purpose: unknown): asserts purpose is Purpose {
    if (!isPurpose(purpose)) throw new Error(`unknown profile context purpose: ${String(purpose)}`);
}

/**
 * The context `p` gives `purpose` (pure). `version` is the stored version `p` was read at, null for a virtual profile:
 * generated rows record it (P7), so what a draft was written from can be found again.
 */
export function contextFor<P extends Purpose>(p: CreatorProfile, purpose: P, version: number | null): ProfileContext<P> {
    assertPurpose(purpose);
    const base: ContextBase<P> = {
        purpose,
        version,
        language: languageOf(p, SURFACE_OF[purpose]),
        who: {
            kind: p.identity.kind,
            role: p.identity.role,
            niche: p.identity.niche,
            domain: p.content.domain,
            offerKind: offerKindOf(p.offers),
        },
        guard: { never_mention: [...p.content.never_mention], rules: [...p.content.rules], custom_rules: [...p.content.custom_rules] },
    };
    return { ...base, ...SLICE_OF[purpose](p) } as ProfileContext<P>;
}

/**
 * The context the tenant's profile gives `purpose`: the stored profile, else the virtual one its legacy settings
 * describe (`loadProfile`), so a reader never has to ask whether the tenant has a profile. The stored profile is read
 * once per request (`cache.ts`) when `exec` is the pool, so several agents asking in one request share one query; a
 * tenant that has none costs its legacy rows' reads on every call, and none in production does once backfilled.
 *
 * A stored profile written by a newer release is passed over for the legacy rows (see the top of the file).
 * Throws what `loadProfile` throws (a database that cannot be read). A caller that has a safe fallback catches it.
 */
export async function profileContext<P extends Purpose>(creatorId: string, purpose: P, exec: Exec = pool): Promise<ProfileContext<P>> {
    assertPurpose(purpose);
    const loaded = await loadProfile(creatorId, exec);
    // The one place that decides whether a stored profile is read: the settings readers' (`overlayProfile`), which also says so once.
    if (loaded.version !== null && overlayProfile(creatorId, loaded) === null) {
        return contextFor(await loadLegacyProfile(creatorId, exec), purpose, null);
    }
    return contextFor(loaded.profile, purpose, loaded.version);
}

// ─── A context for the paths that speak to customers ─────────────────────────────────────────

/**
 * The context the owner's legacy assumptions give `purpose` (`legacyBase('ar')`, no stored version): Gulf Arabic, courses.
 * It is what the owner gets when his profile cannot be read, so that a database hiccup costs him nothing he did not have
 * before P8 (the DM and comment text he always got) rather than a crash or an empty reply.
 */
export function legacyContext<P extends Purpose>(purpose: P): ProfileContext<P> {
    assertPurpose(purpose);
    return contextFor(legacyBase('ar'), purpose, null);
}

/**
 * A profile that could not be read for a tenant that is not the owner. It is transient by nature (a database that failed once
 * answers the next try), so it is thrown, not answered: the queued DM or comment job that asked is retried by the runner
 * (`src/jobs/runner.ts`: any thrown error is retried with a backoff, and is logged `job.failed` when the attempts run out).
 * The owner's Gulf wording is never a stand-in for another tenant's: it would speak Gulf Arabic about courses to followers
 * of an English shop. A caller that has no retry left decides for itself what to say (`comments.ts`).
 */
export class ProfileUnreadableError extends Error {
    constructor(readonly creatorId: string, readonly purpose: Purpose, readonly cause: unknown) {
        super(`the profile of tenant ${creatorId} could not be read for ${purpose}: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'ProfileUnreadableError';
    }
}

/**
 * Whether `creatorId` may be answered in the owner's legacy wording when its profile cannot be read: the platform owner, and
 * anyone while the owner cannot be found. A lookup that fails or finds no creator answers yes, so the owner is never blocked
 * on a database that is struggling, and a deployment with one tenant behaves exactly as it did before P8.
 */
async function mayUseLegacyWording(creatorId: string): Promise<boolean> {
    try {
        const owner = await getPlatformOwnerId();
        return owner === null || owner.toLowerCase() === creatorId.toLowerCase();
    } catch {
        return true;
    }
}

/**
 * `profileContext`, for the DM bot and the comment replies, which speak to real customers: the text they choose from the
 * profile is wording, not a gate, so a read that fails must not become a failed reply for the owner. A profile that cannot be
 * read (a database error, a read that threw) is logged as `profile.context_unreadable` and then:
 *
 *   - for the platform owner (`getPlatformOwnerId`, or anyone when that lookup fails or finds nobody), it is answered with
 *     the owner-identical legacy context: today's text, and the caller's own work goes on;
 *   - for any other tenant, it throws `ProfileUnreadableError`, so the queued job retries instead of answering a stranger's
 *     followers in the owner's language.
 *
 * An unknown purpose is a programming error and always throws.
 */
export async function profileContextOrLegacy<P extends Purpose>(creatorId: string, purpose: P, exec: Exec = pool): Promise<ProfileContext<P>> {
    assertPurpose(purpose);
    try {
        return await profileContext(creatorId, purpose, exec);
    } catch (err) {
        const legacy = await mayUseLegacyWording(creatorId);
        log('warn', 'profile.context_unreadable', {
            creator_id: creatorId, purpose, ...describeError(err),
            effect: legacy ? 'the owner-identical legacy wording is used for this request' : 'not the owner: the job is retried, nothing is answered in his wording',
        });
        if (legacy) return legacyContext(purpose);
        throw new ProfileUnreadableError(creatorId, purpose, err);
    }
}
