/**
 * What the Editor's prompt says that depends on who the creator is (docs/onboarding/05 §2, "P10 · Monteur editor").
 *
 * The prompt used to be written for one man: "he", "him" and "his" throughout, «مثال: مطعم» and «هنا» as the example
 * labels whatever language the reel is in, Gemini, ChatGPT and n8n as the tools a speaker might name, and a closing
 * line that no picture shows a woman. Each is now a kit chosen from the tenant's profile context (`clip_edit`):
 *
 *   pronouns   `presenter.pronouns`: he / she, or the neutral "the speaker" (a `they` presenter, or none)
 *   language   `language.code` of the reels surface: the language the on-screen words are in, and the labels the example
 *              and callout lines show (one source for both: the sentence and its examples cannot disagree)
 *   domain     `content.domain`: the tools a speaker might name, the technical vocabulary the on-screen words keep in
 *              Latin script, and the emoji example that stood for a programming language
 *   noWomen    `content.rules` includes `no_women_imagery`: the closing line, printed verbatim only then
 *   rules      `content.custom_rules`: the creator's own rules, one line, only when there are any
 *
 * **The owner is unchanged, byte for byte.** His profile (`LEGACY_ASSUMPTIONS`: a man on camera, Arabic, the tech domain,
 * the no-women rule) selects exactly the kits that hold the words the prompt used to hard-code, and the golden prompts
 * pin the result. `LEGACY_EDITOR_KIT` is those same choices without a profile: the text the Mac brain keeps when the
 * profile cannot be read (see `editorKitFor` for why no other tenant gets it).
 *
 * The worker's picture filter is NOT conditional on the rule (`NO_WOMEN` in aicourse-captions' stock.mjs): the shared
 * photo library is curated to the strictest rule, so another tenant only ever sees a stricter filter. This file decides
 * what the *prompt* says, and the filter does not read it.
 */
import { describeError, log } from '../../utils/log.js';
import { legacyContext, profileContext, type ProfileContext } from '../profile/context.js';
import type { Domain, Lang, Presenter, Pronouns } from '../profile/types.js';
import { LANGUAGES, oneLine } from '../studio/prompts.js';
import type { ThinkOn } from './think.js';

// ─── Pronouns ────────────────────────────────────────────────────────────────────────────────

/** The four forms the prompt needs: "what he refers to", "an arrow at him", "his head", "never copy his". */
export interface PronounKit {
    subj: string;
    obj: string;
    det: string;
    pron: string;
}

export const PRONOUN_KITS: Readonly<Record<Pronouns, PronounKit>> = Object.freeze({
    he: Object.freeze({ subj: 'he', obj: 'him', det: 'his', pron: 'his' }),
    she: Object.freeze({ subj: 'she', obj: 'her', det: 'her', pron: 'hers' }),
    they: Object.freeze({ subj: 'the speaker', obj: 'the speaker', det: 'the speaker\'s', pron: 'the speaker\'s' }),
});

/** A presenter's pronouns, or the neutral kit for none (a shop, a studio with no one on camera) or a value this release does not know. */
export const pronounKit = (presenter: Pick<Presenter, 'pronouns'> | null | undefined): PronounKit =>
    (presenter ? PRONOUN_KITS[presenter.pronouns] : undefined) ?? PRONOUN_KITS.they;

// ─── Language ────────────────────────────────────────────────────────────────────────────────

/** The language the on-screen words are in, and the two labels the Editor's examples show, quoted as they are shown to the model. */
export interface EditorLanguageKit {
    /** The language's name in the prompt ("On-screen words are in Arabic"): the Studio's own (`LANGUAGES[code].name`). */
    name: string;
    /** An `example` edit's label: «مثال: مطعم». */
    example: string;
    /** The label a `callout` must never use, a pointer with no name: «هنا». */
    never: string;
}

export const EDITOR_LANGUAGE_KITS: Readonly<Record<Lang, EditorLanguageKit>> = Object.freeze({
    ar: Object.freeze({ name: LANGUAGES.ar.name, example: '«مثال: مطعم»', never: '«هنا»' }),
    en: Object.freeze({ name: LANGUAGES.en.name, example: '"Example: restaurant"', never: '"here"' }),
});

// ─── Domain ──────────────────────────────────────────────────────────────────────────────────

/** What a speaker in this domain might name, and the vocabulary their on-screen words keep as it is. */
export interface EditorDomainKit {
    /** The `tool` edit's examples, as the prompt lists them in brackets. */
    tools: string;
    /** Ends the sentence "On-screen words are in <language>…": the words the reel keeps in Latin script, with its leading comma. */
    latinTerms: string;
    /** The one emoji example in the prompt that is a subject of the domain, as the prompt lists it ("🐍 Python"). */
    emoji: string;
}

export const EDITOR_DOMAIN_KITS: Readonly<Record<Domain, EditorDomainKit>> = Object.freeze({
    tech: Object.freeze({ tools: 'Gemini, ChatGPT, Claude, n8n, Python…', latinTerms: ', tech terms in Latin script', emoji: '🐍 Python' }),
    general: Object.freeze({ tools: 'an app, a brand, a product', latinTerms: ', brand and product names in Latin script', emoji: '🎁 a gift' }),
});

// ─── The kit ─────────────────────────────────────────────────────────────────────────────────

/** Everything the Editor's system prompt takes from the tenant, besides the Studio settings it already reads. */
export interface EditorKit {
    pronouns: PronounKit;
    language: EditorLanguageKit;
    domain: EditorDomainKit;
    /** `no_women_imagery`: the prompt's last line says no picture, emoji or sticker shows a woman or a girl. */
    noWomen: boolean;
    /** The tenant's own rules (`content.custom_rules`), one line each, none empty. */
    rules: readonly string[];
}

/** The kit the profile context of the `clip_edit` purpose selects. Pure. */
export function editorKit(ctx: ProfileContext<'clip_edit'>): EditorKit {
    return {
        pronouns: pronounKit(ctx.presenter),
        language: EDITOR_LANGUAGE_KITS[ctx.language.code] ?? EDITOR_LANGUAGE_KITS.en,
        domain: EDITOR_DOMAIN_KITS[ctx.who.domain] ?? EDITOR_DOMAIN_KITS.general,
        noWomen: ctx.guard.rules.includes('no_women_imagery'),
        // A tenant's own words go in one line each, so a rule cannot break the prompt's shape.
        rules: ctx.guard.custom_rules.map(oneLine).filter(Boolean),
    };
}

/**
 * The prompt as it was written before there were kits: a man, Arabic examples, the tech tools, the no-women rule and
 * no other. It is the kit of the owner-identical legacy context (`legacyContext`, which the DM bot and the comment replies
 * fall back to as well), so the owner's wording has one source, and it is what the Mac brain keeps when the profile
 * cannot be read (`editorKitFor`). The golden prompts prove it writes his bytes.
 */
export const LEGACY_EDITOR_KIT: EditorKit = (() => {
    const kit = editorKit(legacyContext('clip_edit'));
    return Object.freeze({ ...kit, rules: Object.freeze([...kit.rules]) });
})();

/**
 * The tenant's kit, read for one Editor call (`profileContext` is cached per request), or null when the profile cannot be
 * read. The failure is logged either way (`monteur.editor_profile_unreadable`, with what failed); what it does to the
 * reel depends on who is writing it:
 *
 *   - With `think` (the Mac brain, which G1 keeps to the owner and the tenants added to it) the text is
 *     `LEGACY_EDITOR_KIT`: today's, the owner's. A Mac call is waited for, never dropped (`editReady` throws what fails
 *     there), so a kit has to come back; and the only tenants that can reach it are the ones that text was written for.
 *   - Without `think` (Gemini: every other tenant) null. The owner's pronouns, Arabic labels and tech tools must not
 *     be handed to a tenant whose own profile could not be read, so the Editor is skipped for this reel, which is the
 *     best-effort contract it already has: no edits, `record.edit.error`, the reel goes out. It is not thrown: the
 *     attempt would fail after the Marketer's call, run again, and stop the source after three of them.
 *
 * `think` is a parameter with no default, so a caller says which it is. `read` is for tests.
 */
export async function editorKitFor(
    creatorId: string,
    think: ThinkOn | undefined,
    read: (creatorId: string, purpose: 'clip_edit') => Promise<ProfileContext<'clip_edit'>> = profileContext,
): Promise<EditorKit | null> {
    try {
        return editorKit(await read(creatorId, 'clip_edit'));
    } catch (err) {
        log('warn', 'monteur.editor_profile_unreadable', { creator_id: creatorId, mac_brain: Boolean(think), ...describeError(err) });
        return think ? LEGACY_EDITOR_KIT : null;
    }
}
