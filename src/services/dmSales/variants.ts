/**
 * A/B wording variants for the DM sales turn (docs/DM_SALES_PLAN.md §9 and S14): the owner writes two or three ways to open a conversation and
 * to offer the link, each conversation is given ONE of them for good, and the funnel (`dmVariantFunnel.ts`) compares what each led to.
 *
 * Pure: nothing here reads a database or a clock. The stored config and the conversation's column are `variantStore.ts` and `store.ts`.
 *
 * **What a variant is.** Guidance for the model, in the owner's own words, about two things only: the style of the FIRST reply (`opening`) and
 * the wording of the offer of the link (`cta`). It rides in the conversation's facts, after the cacheable system prompt, so it never changes the
 * prefix the layer's prompt cache holds and the goldens do not move. A variant with both texts empty is "as today": the control arm.
 * It is wording only. The model still never writes a link, a price or a number the data does not hold, so the text is refused at save time when
 * it holds a link or a number (a number the model repeated would be stopped by `guard.ts`, and an arm whose replies end in a hand-off is not
 * a wording test).
 *
 * **Assignment is a hash, not a coin.** `assignVariant` maps the conversation id through SHA-256 onto the weights, so the same id and the same
 * weights always give the same arm, on any server, and nothing needs a counter or a lock. It is stored on the conversation
 * (`conversations.sales_variant`) the first time a sales turn answers it, and THAT is what every later turn reads: changing the weights, the
 * texts or the arms later never moves a conversation that already has one. A retired arm (weight 0) keeps its conversations and gets no new ones.
 *
 * **Only a new conversation is assigned.** One that already had a bot reply (the old path's, or an earlier sales turn's) began before the
 * experiment and is left out of it: no arm, the prompt it always had, and no row in the funnel's comparison.
 */
import { createHash } from 'node:crypto';
import { stripLinks } from './guard.js';
import { extractNumbers } from './text.js';
import type { SalesFacts } from './types.js';

/** The arms, as slots. An id is a slot and never a name, so an arm renamed in the editor is still the same arm in the funnel. */
export const VARIANT_IDS = ['A', 'B', 'C'] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = VARIANT_IDS.length;
export const VARIANT_LABEL_MAX = 40;
export const VARIANT_TEXT_MAX = 300;
export const VARIANT_WEIGHT_MAX = 100;

export const isVariantId = (value: unknown): value is VariantId => typeof value === 'string' && (VARIANT_IDS as readonly string[]).includes(value);

export interface SalesVariant {
    id: VariantId;
    /** What the funnel calls it. */
    label: string;
    /** Its share of NEW conversations, relative to the others: 0 to 100. 0 retires it. */
    weight: number;
    /** How the first reply should open. Empty: no guidance. */
    opening: string;
    /** How the offer of the link should be worded. Empty: no guidance. */
    cta: string;
}

export interface VariantConfig {
    /** The experiment is running. Off, nothing below is used and every conversation gets the prompt it always had. */
    enabled: boolean;
    variants: SalesVariant[];
}

export const EMPTY_VARIANT_CONFIG: VariantConfig = { enabled: false, variants: [] };

export type VariantProblemCode =
    | 'shape' | 'enabled_type' | 'too_many' | 'too_few' | 'bad_id' | 'duplicate_id' | 'label_missing' | 'label_long' | 'label_duplicate'
    | 'weight_invalid' | 'weights_one_arm' | 'text_type' | 'text_long' | 'text_link' | 'text_number';

export interface VariantProblem {
    /** `enabled`, `variants`, or `variants[<i>].<field>`: where in the body. */
    field: string;
    code: VariantProblemCode;
    message: string;
}

/** Whitespace of any kind, including newlines, as one space: the text is one line of guidance and goes into a prompt line. */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The editor's body as a config, or every problem with it. Strict: it is what a person saved, so a typo is an answer and never a quiet default.
 * An experiment that is switched OFF may be half written (a draft); one that is ON must be able to run: two arms or more with a share, and
 * every text acceptable.
 */
export function parseVariantConfig(input: unknown): { ok: true; config: VariantConfig } | { ok: false; problems: VariantProblem[] } {
    const problems: VariantProblem[] = [];
    const bad = (field: string, code: VariantProblemCode, message: string): void => { problems.push({ field, code, message }); };
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, problems: [{ field: 'body', code: 'shape', message: 'Send { enabled, variants }.' }] };
    }
    const body = input as Record<string, unknown>;

    let enabled = false;
    if (body['enabled'] !== undefined && body['enabled'] !== null) {
        if (typeof body['enabled'] === 'boolean') enabled = body['enabled'];
        else bad('enabled', 'enabled_type', 'enabled must be true or false.');
    }

    const raw = body['variants'] === undefined || body['variants'] === null ? [] : body['variants'];
    if (!Array.isArray(raw)) {
        bad('variants', 'shape', 'variants must be a list.');
        return { ok: false, problems };
    }
    if (raw.length > MAX_VARIANTS) bad('variants', 'too_many', `At most ${MAX_VARIANTS} variants.`);

    const variants: SalesVariant[] = [];
    const seenIds = new Set<string>();
    const seenLabels = new Set<string>();
    raw.slice(0, MAX_VARIANTS).forEach((item, i) => {
        const at = (field: string): string => `variants[${i}].${field}`;
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            bad(`variants[${i}]`, 'shape', 'Each variant is an object.');
            return;
        }
        const v = item as Record<string, unknown>;

        const id = v['id'];
        if (!isVariantId(id)) bad(at('id'), 'bad_id', `A variant's id is one of ${VARIANT_IDS.join(', ')}.`);
        else if (seenIds.has(id)) bad(at('id'), 'duplicate_id', `Variant ${id} appears twice.`);
        else seenIds.add(id);

        const label = typeof v['label'] === 'string' ? squash(v['label']) : '';
        if (label === '') bad(at('label'), 'label_missing', 'Give each variant a short name: it is what the funnel calls it.');
        else if (label.length > VARIANT_LABEL_MAX) bad(at('label'), 'label_long', `A name is at most ${VARIANT_LABEL_MAX} characters.`);
        else if (seenLabels.has(label.toLowerCase())) bad(at('label'), 'label_duplicate', 'Two variants have the same name.');
        else seenLabels.add(label.toLowerCase());

        const rawWeight = v['weight'];
        const weight = typeof rawWeight === 'number' ? rawWeight : typeof rawWeight === 'string' && /^\d{1,3}$/.test(rawWeight.trim()) ? Number(rawWeight) : NaN;
        if (!Number.isInteger(weight) || weight < 0 || weight > VARIANT_WEIGHT_MAX) {
            bad(at('weight'), 'weight_invalid', `A share is a whole number from 0 to ${VARIANT_WEIGHT_MAX}.`);
        }

        const texts: Record<'opening' | 'cta', string> = { opening: '', cta: '' };
        for (const key of ['opening', 'cta'] as const) {
            const value = v[key];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'string') { bad(at(key), 'text_type', `${key} must be text.`); continue; }
            const text = squash(value);
            if (text.length > VARIANT_TEXT_MAX) bad(at(key), 'text_long', `At most ${VARIANT_TEXT_MAX} characters.`);
            else if (stripLinks(text).removed.length > 0) bad(at(key), 'text_link', 'Write the wording, not a link: the system adds the link itself.');
            else if (extractNumbers(text).size > 0) bad(at(key), 'text_number', 'Write the wording without numbers: the assistant may only state the numbers in your offers.');
            else texts[key] = text;
        }

        if (isVariantId(id)) variants.push({ id, label, weight: Number.isInteger(weight) ? weight : 0, opening: texts.opening, cta: texts.cta });
    });

    if (enabled) {
        if (variants.length < MIN_VARIANTS && !problems.some((p) => p.code === 'too_many')) {
            bad('variants', 'too_few', `An experiment needs at least ${MIN_VARIANTS} variants. Switch it off to keep a draft.`);
        } else if (variants.filter((v) => v.weight > 0).length < MIN_VARIANTS && !problems.some((p) => p.code === 'weight_invalid')) {
            bad('variants', 'weights_one_arm', `At least ${MIN_VARIANTS} variants need a share above 0, or there is nothing to compare.`);
        }
    }
    if (problems.length > 0) return { ok: false, problems };

    variants.sort((a, b) => VARIANT_IDS.indexOf(a.id) - VARIANT_IDS.indexOf(b.id));
    return { ok: true, config: { enabled, variants } };
}

/** The arms of an experiment that is RUNNING, or null: switched off, fewer than two arms, or fewer than two with a share. Every arm, retired ones too. */
export function activeVariants(config: VariantConfig | null | undefined): SalesVariant[] | null {
    if (!config || !config.enabled) return null;
    if (config.variants.length < MIN_VARIANTS) return null;
    if (config.variants.filter((v) => v.weight > 0).length < MIN_VARIANTS) return null;
    return config.variants;
}

/** Changing this re-rolls every conversation that has not been assigned yet: it names the hash, not the experiment. */
const HASH_SALT = 'dm-variant:v1';

/** Where a conversation falls in [0, 1): the first 32 bits of SHA-256 over a salt and its id. The same id is always the same point. */
export function variantPoint(conversationId: string): number {
    return createHash('sha256').update(`${HASH_SALT}:${conversationId}`).digest().readUInt32BE(0) / 2 ** 32;
}

/**
 * The arm a conversation falls into: its point laid over the weights, in slot order. An arm with weight 0 owns no part of the line. null when
 * no arm has a weight (the caller has already checked `activeVariants`). Deterministic, and independent of every other conversation.
 */
export function assignVariant(conversationId: string, variants: readonly Pick<SalesVariant, 'id' | 'weight'>[]): VariantId | null {
    const arms = variants.filter((v) => v.weight > 0);
    const total = arms.reduce((sum, v) => sum + v.weight, 0);
    if (arms.length === 0 || total <= 0) return null;
    const point = variantPoint(conversationId) * total;
    let upTo = 0;
    for (const arm of arms) {
        upTo += arm.weight;
        if (point < upTo) return arm.id;
    }
    return arms[arms.length - 1]!.id;
}

/** What one turn does about the experiment. */
export interface VariantChoice {
    /** The arm whose guidance this turn carries; null: the prompt as it always was. */
    variant: SalesVariant | null;
    /** The arm to WRITE to the conversation with this turn's record: only a conversation that had none and is new. null: nothing to write. */
    assign: VariantId | null;
}

/**
 * Who gets what, this turn. `stored` is the conversation's own column (null: never assigned), `isNew` whether no bot reply has gone out in it yet.
 *
 *   no experiment running            nothing: no arm, nothing to write (whatever the column holds is for the funnel to read, not the prompt)
 *   an arm is stored                 that arm, always. Never re-rolled, whatever the weights are now. An arm that has since been deleted is the
 *                                    prompt as it always was, and stays as recorded
 *   none stored, a new conversation  the arm its id hashes to, and it is written with this turn
 *   none stored, an older one        none: it began before the experiment
 */
export function chooseVariant(input: { config: VariantConfig | null | undefined; stored: string | null; conversationId: string; isNew: boolean }): VariantChoice {
    const arms = activeVariants(input.config);
    if (!arms) return { variant: null, assign: null };
    if (input.stored !== null) return { variant: arms.find((v) => v.id === input.stored) ?? null, assign: null };
    if (!input.isNew) return { variant: null, assign: null };
    const id = assignVariant(input.conversationId, arms);
    return { variant: id ? arms.find((v) => v.id === id) ?? null : null, assign: id };
}

/**
 * The guidance a turn's facts carry for an arm, or undefined when it has none. The opening is for the first reply only: once the bot has
 * spoken, how to open is no longer a question.
 */
export function variantGuidance(variant: SalesVariant | null, firstReply: boolean): SalesFacts['variant'] {
    if (!variant) return undefined;
    const opening = firstReply && variant.opening !== '' ? variant.opening : null;
    const cta = variant.cta !== '' ? variant.cta : null;
    return opening || cta ? { opening, cta } : undefined;
}
