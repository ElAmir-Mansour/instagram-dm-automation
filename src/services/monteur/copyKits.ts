/**
 * What the pick prompt and the copy prompt say that depends on who the creator is (docs/onboarding/05 §2, "P11 · Pick and
 * copy").
 *
 * Both prompts used to be written for one man: five Gulf asks as the fallback for every tenant, «ابعتها لصاحبك اللي …» and
 * Arabic examples of a bad opening shown to an English model, "Tech terms in Latin script", Gemini and ChatGPT and
 * الذكاء_الاصطناعي as the hashtags every reel is described by, and "a colleague" as the person a tool is worth sending to.
 * Each is now a kit chosen from the tenant's profile context (`clip_pick`, `clip_copy`):
 *
 *   register   `language.register` of the reels surface: the asks (`REEL_REGISTER_KITS`, `profile/kits.ts`: the register text lives
 *              with the other registers' text, so one file is the review), and, from P9's register kit (`KITS[key].studio`, which
 *              is not copied here), the "who to send it to" example and the question and pitch a DM falls back to
 *   language   `language.code` of the same surface: the examples of a bad opening, the reach tags, how an alt text opens
 *              (`REEL_LANGUAGE_KITS`); and the language the title and the copy are written in
 *   domain     `content.domain`: what a pick calls worth sending, whether tech terms keep their Latin script, the hashtags the
 *              clip is described by, and the examples of a good keyword. `tech` is today's text; `general` names no tool
 *   kind       `identity.kind`: whether the TikTok caption carries the learning-programme tags (`#LearnOnTikTok`), which only an
 *              educator's or a coach's reels do (05 R8: `LEARNING_KINDS`, the Studio's rule, handed to `normalizeTiktokCaption`);
 *              and `offers`: the DM's fallback pitch is a course's alone (`fallbackPitch`), so a shop never says «في الكورس»
 *
 * **The owner is unchanged, byte for byte.** His profile (`LEGACY_ASSUMPTIONS`: Gulf Arabic, the tech domain) selects exactly
 * the entries that hold the words the prompts used to hard-code, and the golden prompts pin the result: the pick system
 * prompt, the copy system prompt, the ask pool and the clip copy built with it. `promptSurface.ts` builds his surfaces through
 * `reelKitsOf`, the same path the sweep takes, so there is no second route to the same text.
 *
 */
import { profileContextOrLegacy, type ProfileContext } from '../profile/context.js';
import {
    fallbackPitch, kitFor, REEL_LANGUAGE_KITS, REEL_REGISTER_KITS, type KitKey, type ReelLanguageKit, type ReelRegisterKit,
} from '../profile/kits.js';
import type { Domain, Lang } from '../profile/types.js';
import { LANGUAGES, LEARNING_KINDS } from '../studio/prompts.js';

// ─── The pick ────────────────────────────────────────────────────────────────────────────────

/** What the pick prompt says that depends on the creator's field. */
export interface PickDomainKit {
    /** What a moment worth sending is, after "send:". Ends with its full stop; the prompt adds "Motivation alone is 0." */
    send: string;
    /** The end of the `title:` line: the Latin-script rule, for the domain whose vocabulary is Latin, and the hype rule. */
    titleEnd: string;
}

export const PICK_DOMAIN_KITS: Readonly<Record<Domain, PickDomainKit>> = Object.freeze({
    tech: Object.freeze({
        send: 'worth sending to a colleague: a tool, a prompt, a step, a number or a surprise.',
        titleEnd: 'Tech terms in Latin script, no hype words.',
    }),
    // No tool, no prompt and no Latin-script rule: a tenant that sells candles is not asked to keep "tech terms" anywhere.
    general: Object.freeze({
        send: 'worth sending to a friend: a tip, a step, a number or a surprise.',
        titleEnd: 'No hype words.',
    }),
});

export interface PickKit {
    /** The language the reel is spoken and written in: the title and the "why" are written in it. */
    lang: Lang;
    language: ReelLanguageKit;
    domain: PickDomainKit;
}

/** The kit the profile context of the `clip_pick` purpose selects. Pure. */
export function pickKit(ctx: ProfileContext<'clip_pick'>): PickKit {
    const lang = ctx.language.code;
    return {
        lang,
        language: REEL_LANGUAGE_KITS[lang] ?? REEL_LANGUAGE_KITS.en,
        domain: PICK_DOMAIN_KITS[ctx.who.domain] ?? PICK_DOMAIN_KITS.general,
    };
}

// ─── The copy ────────────────────────────────────────────────────────────────────────────────

/** What the copy prompt says that depends on the creator's field, in the language of the reel. */
export interface CopyDomainKit {
    /** What the hashtags name, after "naming this clip's topic:": the tool a tech reel shows, the subject any other shows. */
    hashtagTopic: string;
    /** The broad tags the prompt shows as the ones never to use, as it prints them (`#tech #learning`). */
    genericTags: string;
    /** The examples of a good comment keyword, after "like". */
    keywordExamples: string;
}

/**
 * `tech` is today's text: its Arabic half is `LANGUAGES.ar.keywordExamples` and its English half is `LANGUAGES.en`'s, read from the
 * Studio's own kit, so the two cannot disagree about what the owner's examples are. `general` mentions no tool, no AI and no
 * programming tag: the hashtags describe what the reel shows, and the examples of a keyword are the words anyone asks for.
 */
export const COPY_DOMAIN_KITS: Readonly<Record<Domain, Readonly<Record<Lang, CopyDomainKit>>>> = Object.freeze({
    tech: Object.freeze({
        ar: Object.freeze({
            hashtagTopic: 'the tool it shows (Gemini, ChatGPT) and the subject (الذكاء_الاصطناعي)',
            genericTags: '#تقنية #تعلم #برمجة',
            keywordExamples: LANGUAGES.ar.keywordExamples,
        }),
        en: Object.freeze({
            hashtagTopic: 'the tool it shows (Gemini, ChatGPT) and the subject',
            genericTags: '#tech #learning',
            keywordExamples: LANGUAGES.en.keywordExamples,
        }),
    }),
    general: Object.freeze({
        ar: Object.freeze({
            hashtagTopic: 'the specific subject it shows (a product, a place, a step or a result)',
            genericTags: '#نصائح #تعلم',
            keywordExamples: 'دليل، قائمة، خطوات',
        }),
        en: Object.freeze({
            hashtagTopic: 'the specific subject it shows (a product, a place, a step or a result)',
            genericTags: '#tips #learning',
            keywordExamples: 'guide, plan, steps',
        }),
    }),
});

export interface CopyKit {
    /** The kit the register chose: `en` for English, else the Arabic register (`gulf` for the owner). */
    key: KitKey;
    /** The language the copy is written in. */
    lang: Lang;
    /** The register's asks. */
    register: ReelRegisterKit;
    /** The example of who to forward a reel to, quotes included: P9's `studio.forwardExample` of the register's kit. */
    forward: string;
    /** The question a DM opens with for a model that left it empty: P9's `studio.fallbackQuestion` of the register's kit. */
    fallbackQuestion: string;
    /**
     * The pitch a DM falls back to for a model that left it empty: a course's alone, in the register's words, and the empty string for
     * every other offer (`fallbackPitch`, P9), which `buildDm` drops. A shop's DM never says «في الكورس».
     */
    fallbackPitch: string;
    language: ReelLanguageKit;
    domain: CopyDomainKit;
    /**
     * The learning-programme tags the TikTok caption carries: the language's for an educator or a coach, none for any other kind
     * (nor for a profile that has not said). Handed to `normalizeTiktokCaption`, which adds every tag it is given.
     */
    learnTags: readonly string[];
}

/** The kit the profile context of the `clip_copy` purpose selects. Pure. */
export function copyKit(ctx: ProfileContext<'clip_copy'>): CopyKit {
    const lang = ctx.language.code;
    const chosen = kitFor(ctx.language);
    const domains = COPY_DOMAIN_KITS[ctx.who.domain] ?? COPY_DOMAIN_KITS.general;
    return {
        key: chosen.key,
        lang,
        register: REEL_REGISTER_KITS[chosen.key],
        forward: chosen.studio.forwardExample,
        fallbackQuestion: chosen.studio.fallbackQuestion,
        fallbackPitch: fallbackPitch(chosen, ctx.who.offerKind),
        language: REEL_LANGUAGE_KITS[lang] ?? REEL_LANGUAGE_KITS.en,
        domain: domains[lang] ?? domains.en,
        learnTags: ctx.who.kind !== null && LEARNING_KINDS.includes(ctx.who.kind) ? [...LANGUAGES[lang].learnTags] : [],
    };
}

// ─── Both, for a tenant ──────────────────────────────────────────────────────────────────────

export interface ReelKits {
    pick: PickKit;
    copy: CopyKit;
}

/** The two kits a profile gives, each from the context of its own purpose. For the prompt surface and the tests: pure. */
export function reelKitsFromContexts(pick: ProfileContext<'clip_pick'>, copy: ProfileContext<'clip_copy'>): ReelKits {
    return { pick: pickKit(pick), copy: copyKit(copy) };
}

/**
 * The tenant's two kits, read for one source, before any model is asked (`profileContextOrLegacy` is cached per request).
 * A profile that cannot be read is answered by who is asking, as the DM and the comment replies answer it (P8):
 *
 *   - the platform OWNER gets his own text (`legacyContext`), logged as `profile.context_unreadable`: a database hiccup must
 *     cost him nothing he did not have before P11, and his prompts are the one thing the goldens pin;
 *   - any other tenant gets a `ProfileUnreadableError`, which the sweep answers by handing the source back untouched
 *     (`releaseUnreadable`, `sweep.ts`): the source returns to `transcribed` with the claim's attempt given back, so waiting for
 *     the database never spends one of the three attempts that end in a failed source. Never the owner's wording for a stranger's
 *     reel (Gulf asks, tech hashtags), and never a reel written in a neutral voice the creator did not choose.
 *
 * Which of the two is decided by identity, not by the brain: the Mac brain is for the owner, but an operator can add a tenant
 * to it (G1), and that tenant is a stranger to the owner's wording all the same. `read` is for tests.
 */
export async function reelKitsFor(
    creatorId: string,
    read: <P extends 'clip_pick' | 'clip_copy'>(creatorId: string, purpose: P) => Promise<ProfileContext<P>> = profileContextOrLegacy,
): Promise<ReelKits> {
    // One after the other: a tenant that cannot be read is told so once, by the first.
    const pick = await read(creatorId, 'clip_pick');
    const copy = await read(creatorId, 'clip_copy');
    return reelKitsFromContexts(pick, copy);
}
