/**
 * The owner's tenant, described as a profile (docs/onboarding/01 §0.2).
 *
 * Today the code does not ask a tenant who they are: it writes the owner's answers into every
 * prompt. A male presenter and the no-women rule in the Editor, the Gulf asks in the Marketer, "tech
 * educator" and forced فصحى in the infographic writer, «الكورس» in the Studio's fallbacks. A tenant
 * with no stored profile is therefore described by `profileFromLegacy`, which is those assumptions
 * plus whatever the tenant's own settings rows say. Phase 2 turns each hardcoded line into a read of
 * the profile field below, and the owner's bytes do not move.
 *
 * A new tenant never uses this. It gets the neutral `defaultProfile()`, so none of the following
 * can leak to a second creator (01 §6.3).
 */
import type { GrowthSettings } from '../../db/rows.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { defaultProfile } from './defaults.js';
import type { ArabicRegister, ContentRulePreset, CreatorKind, CreatorProfile, Domain, Lang, OfferKind, Presenter } from './types.js';
import { intoProfile } from './views.js';

/** What the code assumes for every tenant today, each with the place it is written. */
export const LEGACY_ASSUMPTIONS: {
    /** He/him, on camera: `monteur/editor.ts` writes "he", "him" and "his" 17 times. */
    readonly presenter: Readonly<Presenter>;
    /** `monteur/editor.ts` ends every Editor prompt with "Never a woman or a girl in any picture". */
    readonly rules: readonly ContentRulePreset[];
    /** The Gulf asks and fallbacks: `monteur/copy.ts` ASK_POOL, `studio/prompts.ts` language kit, `webhook/errors.ts`. */
    readonly register: ArabicRegister;
    /** Arabic infographics are written in فصحى whatever the tenant speaks: `studio/infographicSpec.ts`. */
    readonly infographicRegister: ArabicRegister;
    /** `studio/prompts.ts` adds `#LearnOnTikTok` to every TikTok caption, which only an educator's does (05 R8). */
    readonly kind: CreatorKind;
    /** `studio/infographicSpec.ts`: "…for a tech educator's Instagram…". */
    readonly role: string;
    /** The tech block of the infographic writer and the Editor's tool examples (05 R12, R16). */
    readonly domain: Domain;
    /** «الكورس», "the course": the Studio's framing of what is sold (05 R6). */
    readonly offerKind: OfferKind;
} = Object.freeze({
    presenter: Object.freeze({ name: '', pronouns: 'he', on_camera: 'face' } as const),
    rules: Object.freeze(['no_women_imagery'] as const),
    register: 'gulf',
    infographicRegister: 'msa',
    kind: 'educator',
    role: 'tech educator',
    domain: 'tech',
    offerKind: 'course',
});

/**
 * The profile those assumptions make before any of the tenant's settings are read: Arabic is Gulf
 * with Arabic-Indic digits, and an English tenant has no register. Both carry the infographic's
 * فصحى, since a tenant who writes in English can still have Arabic infographics. The offer is an
 * empty `course` shell for `intoProfile` to fill from `product`; it exists even for a tenant with no
 * product, because today's prompts say "course" regardless.
 */
export function legacyBase(lang: Lang): CreatorProfile {
    const a = LEGACY_ASSUMPTIONS;
    const base = defaultProfile({ lang, rules: a.rules });
    return {
        ...base,
        identity: { ...base.identity, kind: a.kind, role: a.role },
        language: {
            ...base.language,
            register: lang === 'ar' ? a.register : null,
            surfaces: { infographic: { register: a.infographicRegister } },
        },
        offers: [{ id: 'main', kind: a.offerKind, name: '', order_via: 'url', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }],
        presenter: { ...a.presenter },
        content: { ...base.content, domain: a.domain },
    };
}

/**
 * The profile of a tenant that has none: the legacy assumptions, with the language, brand, voice,
 * product, timezone, audience, goals and knowledge base of the rows the tenant does have.
 * `legacyBase(...)` is fed `studio.voice.language` because that is the one fact the base depends on.
 */
export function profileFromLegacy(studio: StudioSettings, growth?: GrowthSettings, kb?: string | null): CreatorProfile {
    return intoProfile(legacyBase(studio.voice.language), studio, growth, kb);
}
