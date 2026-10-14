/**
 * The A/B comparison of the DM funnel (docs/DM_SALES_PLAN.md §9 and S14): for each wording arm of the owner's experiment, how many conversations
 * it was given, how many of them were recommended an offer, sent the link and clicked it, and the two rates the plan's §1 sets targets for.
 * It is a section of `GET /api/dm/funnel` (`dmFunnel.ts` builds it from the same facts and the same `reachedOf`, so a variant's numbers and the
 * funnel's own are counted by one rule).
 *
 * Counts and rates only: no conversation id, name or text leaves this module.
 *
 * **Who is counted.** A conversation counts for the arm written on it (`conversations.sales_variant`), in the window its FIRST customer message
 * falls in, exactly the funnel's cohort. A conversation that has no arm (it began before the experiment, or the tenant never ran one) is in
 * the funnel and not here. An arm keeps its row after the experiment is switched off or the arm is deleted from the editor: the counts are what
 * happened, and an arm with no name any more is shown by its slot letter.
 *
 * **No claim the data cannot carry.** Below `MIN_VARIANT_SAMPLE` conversations an arm shows its COUNTS and no percentage (`pct: null`, `enough:
 * false`): a rate of 3 in 4 is not a finding. Above it the rates are shown, with the numbers they are made of, and still nothing says which arm
 * "won": no significance test is run here, and the plan's own estimate is that a real difference between two arms needs hundreds of conversations
 * each, which at this volume is a long time. The gate is the server's, so any client that draws this inherits it.
 */
import type { DmFunnelRate, Reached } from './dmFunnel.js';
import { activeVariants, isVariantId, VARIANT_IDS, type VariantConfig, type VariantId } from './dmSales/variants.js';

/**
 * Fewer conversations than this in an arm, and its rates are not shown. A floor for "this is not just three people", chosen by the owner's brief
 * ("e.g. fewer than 30"), and deliberately NOT the number at which a difference between arms becomes real: see the top of the file.
 */
export const MIN_VARIANT_SAMPLE = 30;

/** One row of `SELECT c.id, c.sales_variant`: a conversation of the cohort and the arm it was given. */
export interface VariantFact {
    id: string;
    sales_variant: string | null;
}

export interface DmVariantArm {
    /** The slot: A, B or C. */
    id: VariantId;
    /** The owner's name for it; null when the arm is no longer in the editor. */
    label: string | null;
    /** Its share of new conversations as the editor has it; null when the arm is no longer there. 0: retired. */
    weight: number | null;
    /** Conversations of the cohort that were given this arm. */
    conversations: number;
    /** Of those, how many reached `recommend` or past it (the denominator of the link rate). */
    recommended: number;
    /** How many were sent a link (the numerator of the link rate, the denominator of the click rate). */
    link_sent: number;
    /** How many of those a person then clicked (previews are not clicks: `reachedOf`). */
    clicked: number;
    /** `link_sent / recommended`. `pct` is null below the sample floor, and when there is nothing to divide by. */
    link: DmFunnelRate;
    /** `clicked / link_sent`, under the same rule. */
    click: DmFunnelRate;
    /** `conversations >= min_sample`: only then are the percentages shown. */
    enough: boolean;
}

export interface DmVariantBreakdown {
    /** The floor, so a client states the same number the server applied. */
    min_sample: number;
    /** The experiment is switched on and could assign a conversation right now. */
    running: boolean;
    /** Every arm that is in the editor or has a conversation, in slot order. */
    arms: DmVariantArm[];
    /** At least two arms have enough conversations for their rates to be set side by side. Not a claim that they differ. */
    comparable: boolean;
}

const rate = (count: number, of: number, show: boolean): DmFunnelRate => ({ count, of, pct: show && of > 0 ? Math.round((100 * count) / of) : null });

/**
 * Pure: the cohort's facts, what each reached, the arms the conversations were given, and the owner's config in; the breakdown out. null when there is
 * nothing to compare: no arm in the config and no conversation given one (the funnel then carries no `variants` section at all).
 * `facts` and `reached` are the funnel's own, in the same order.
 */
export function buildVariantBreakdown(
    facts: readonly { id: string }[],
    reached: readonly Reached[],
    assignments: readonly VariantFact[],
    config: VariantConfig | null
): DmVariantBreakdown | null {
    const armOf = new Map<string, VariantId>();
    for (const a of assignments) if (isVariantId(a.sales_variant)) armOf.set(a.id, a.sales_variant);

    const tally = new Map<VariantId, { conversations: number; recommended: number; linked: number; clicked: number }>();
    facts.forEach((fact, i) => {
        const arm = armOf.get(fact.id);
        const r = reached[i];
        if (!arm || !r) return;
        const t = tally.get(arm) ?? { conversations: 0, recommended: 0, linked: 0, clicked: 0 };
        t.conversations += 1;
        if (r.recommended) t.recommended += 1;
        if (r.linked) t.linked += 1;
        if (r.clicked) t.clicked += 1;
        tally.set(arm, t);
    });

    const configured = new Map((config?.variants ?? []).map((v) => [v.id, v]));
    const ids = VARIANT_IDS.filter((id) => configured.has(id) || tally.has(id));
    if (ids.length === 0) return null;

    const arms: DmVariantArm[] = ids.map((id) => {
        const t = tally.get(id) ?? { conversations: 0, recommended: 0, linked: 0, clicked: 0 };
        const def = configured.get(id);
        const enough = t.conversations >= MIN_VARIANT_SAMPLE;
        return {
            id,
            label: def ? def.label : null,
            weight: def ? def.weight : null,
            conversations: t.conversations,
            recommended: t.recommended,
            link_sent: t.linked,
            clicked: t.clicked,
            link: rate(t.linked, t.recommended, enough),
            click: rate(t.clicked, t.linked, enough),
            enough,
        };
    });
    return {
        min_sample: MIN_VARIANT_SAMPLE,
        running: activeVariants(config) !== null,
        arms,
        comparable: arms.filter((a) => a.enough).length >= 2,
    };
}
