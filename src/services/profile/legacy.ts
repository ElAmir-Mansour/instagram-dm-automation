/**
 * The owner's tenant, described as a profile (docs/onboarding/01 §0.2).
 *
 * Today the code does not ask a tenant who they are: it writes the owner's answers into every
 * prompt. A male presenter and the no-women rule in the Editor, the Gulf asks in the Marketer, "tech
 * educator" and forced فصحى in the infographic writer, «الكورس» in the Studio's fallbacks, Arabic in
 * every DM. A tenant with no stored profile is therefore described by `profileFromLegacy`, which is
 * those assumptions plus whatever the tenant's own settings rows say. Phase 2 turns each hardcoded
 * line into a read of the profile field below, and the owner's bytes do not move.
 *
 * A new tenant never uses this. It gets the neutral `defaultProfile()`, so none of the following
 * can leak to a second creator (01 §6.3).
 */
import type { GrowthSettings } from '../../db/rows.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { defaultProfile } from './defaults.js';
import type { Address, ArabicRegister, ContentRulePreset, CreatorKind, CreatorProfile, Domain, Lang, OfferKind, Presenter } from './types.js';
import { intoProfile } from './views.js';

/**
 * What the code assumes for every tenant today. `legacy.test.ts` ties each one to the text it produces in
 * the golden prompts, so a value that stops matching the code fails there rather than here.
 */
export const LEGACY_ASSUMPTIONS: {
    /** He/him, on camera: `monteur/editor.ts` wrote "he", "him" and "his" 17 times; since P10 it reads `presenter` (`PRONOUN_KITS`, `monteur/editorKits.ts`). */
    readonly presenter: Readonly<Presenter>;
    /** `monteur/editor.ts` ended every Editor prompt with "Never a woman or a girl in any picture"; since P10 only a tenant with this rule gets the line. */
    readonly rules: readonly ContentRulePreset[];
    /** The Gulf asks and fallbacks: `monteur/copy.ts` ASK_POOL, `studio/prompts.ts` language kit, `webhook/errors.ts`. */
    readonly register: ArabicRegister;
    /** Arabic infographics are written in فصحى whatever the tenant speaks: `studio/infographicSpec.ts`. */
    readonly infographicRegister: ArabicRegister;
    /** The DM path is forced to Arabic, in the Gulf register, whatever the tenant speaks: `services/ai.ts` `dmSystemInstruction`. */
    readonly dm: Readonly<{ language: Lang; register: ArabicRegister }>;
    /** Every Arabic pool addresses one man: «تبي», «ودك», «ابعتها لصاحبك». */
    readonly address: Address;
    /** `studio/prompts.ts` adds `#LearnOnTikTok` to every TikTok caption, which only an educator's does (05 R8). */
    readonly kind: CreatorKind;
    /** `studio/infographicSpec.ts`: "…for a tech educator's Instagram…". */
    readonly role: string;
    /** The tech block of the infographic writer and the Editor's tool examples (05 R12, R16; the Editor's are `EDITOR_DOMAIN_KITS` since P10). */
    readonly domain: Domain;
    /** «الكورس», "the course": the Studio's framing of what is sold (05 R6). */
    readonly offerKind: OfferKind;
} = Object.freeze({
    presenter: Object.freeze({ name: '', pronouns: 'he', on_camera: 'face' } as const),
    rules: Object.freeze(['no_women_imagery'] as const),
    register: 'gulf',
    infographicRegister: 'msa',
    dm: Object.freeze({ language: 'ar', register: 'gulf' } as const),
    address: 'masc',
    kind: 'educator',
    role: 'tech educator',
    domain: 'tech',
    offerKind: 'course',
});

/**
 * The profile those assumptions make before any of the tenant's settings are read: Arabic is Gulf
 * with Arabic-Indic digits, and an English tenant has no register. Two surfaces speak Arabic whatever
 * the tenant does: the infographic (فصحى) and the DM bot (Gulf, forced to Arabic today), so an English
 * tenant carries both as overrides, and an Arabic one has nothing to override but the register. The
 * offer is an empty `course` shell for `intoProfile` to fill from `product`; it exists even for a
 * tenant with no product, because today's prompts say "course" regardless.
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
            surfaces: { infographic: { register: a.infographicRegister }, ...(lang === 'ar' ? {} : { dm: { ...a.dm } }) },
        },
        offers: [{ id: 'main', kind: a.offerKind, name: '', order_via: 'url', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }],
        voice: { ...base.voice, address: a.address },
        presenter: { ...a.presenter },
        content: { ...base.content, domain: a.domain },
    };
}

/**
 * The profile of a tenant that has none: the legacy assumptions, with the language, brand, voice,
 * product, timezone, audience and goals of the rows the tenant does have. `legacyBase(...)` is fed
 * `studio.voice.language` because that is the one fact the base depends on.
 *
 * It copies the brand name and the timezone outright. `intoProfile` leaves a profile's own value alone
 * when the view of it already equals the row (a brand name equal to the English display name, a
 * timezone of UTC), which keeps a *stored* profile from being rewritten; but a tenant being described
 * for the first time has said what its brand name and timezone are, and a derived blank that happens to
 * read the same today would silently change the day its display name did.
 */
export function profileFromLegacy(studio: StudioSettings, growth?: GrowthSettings): CreatorProfile {
    const p = intoProfile(legacyBase(studio.voice.language), studio, growth);
    p.identity.brand_name = studio.brand.name;
    p.identity.timezone = studio.schedule.timezone;
    return p;
}
