/**
 * What the model is given for an AI proposal (A7, contracts/ai-proposal.schema.md "Input"): AGGREGATES ONLY (FR-049).
 *
 * In it: the tenant's language, currency, time zone and countries; the limits and what is left of the month (the money rule); each
 * offer's title, price and a short summary of its own bullets and facts; the owner's words; the post a "Suggest a campaign" was pressed
 * on (its caption and organic counts); the policy rules' descriptions; and the stored copy's numbers (names, budgets, statuses, the
 * targeting summary and 7-day totals per object, audience names and sizes).
 *
 * Never in it: a contact, a customer's name or words, a lead-form answer, a conversation, a testimonial, the bot's knowledge or hand-off
 * text. Those all live in tables and profile sections this file does not read: it takes `offers[].name/price/url/order_via/bullets/facts`
 * and nothing else of the profile, and strips any address or phone number an owner typed into a bullet. input.test.ts holds a profile
 * full of such data and asserts none of it reaches the input or the prompt.
 *
 * A port that cannot be read (Meta down for the money rule, the database for the stored copy) leaves its part empty rather than failing
 * the draft: the checks after the answer re-run the money rule anyway, and approve runs it a third time.
 */
import { loadProfile as loadStoredProfile } from '../../profile/store.js';
import type { CreatorProfile } from '../../profile/types.js';
import { describeError, log } from '../../../utils/log.js';
import { MAX_REQUEST_CHARS, type CampaignSpec, type ProposalInput, type ProposalPorts, type ProposalTask } from './types.js';

/** An offer's summary, at most. */
export const MAX_OFFER_SUMMARY = 300;
/** A post's caption, at most: the hook is what matters to an ad. */
export const MAX_POST_CAPTION = 1000;

export interface InputDeps {
    loadProfile: (creatorId: string) => Promise<{ profile: CreatorProfile }>;
}

const DEFAULT_DEPS: InputDeps = { loadProfile: (creatorId) => loadStoredProfile(creatorId) };

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
/** A run of 7+ digits, with the spaces, dashes, dots and brackets people write between them, and an optional leading +. */
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;

/** A bullet or fact with any address or phone number taken out. Prices ("99 SAR") are short and stay. */
function clean(text: string): string {
    return text.replace(EMAIL, '').replace(PHONE, '').replace(/\s{2,}/g, ' ').trim();
}

function clip(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

async function safely<T>(what: string, creatorId: string, fallback: T, read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch (err) {
        log('warn', 'ads.proposal_input_unreadable', { what, creator_id: creatorId, ...describeError(err) });
        return fallback;
    }
}

export async function buildInput(
    creatorId: string,
    opts: { task: ProposalTask; request?: string | null; post?: ProposalInput['post'] },
    ports: ProposalPorts,
    deps: InputDeps = DEFAULT_DEPS,
): Promise<ProposalInput> {
    const { profile } = await deps.loadProfile(creatorId);
    const lang: 'ar' | 'en' = profile.language?.primary === 'en' ? 'en' : 'ar';

    const mirror = ports.mirror;
    const snapshot = mirror
        ? await safely('mirror', creatorId, null, () => mirror.snapshot(creatorId))
        : null;
    const money = ports.money;
    const [answer, minimums] = money
        ? await Promise.all([
            safely('money', creatorId, null, () => money.check(creatorId, null)),
            safely('minimums', creatorId, {} as Record<string, number>, () => money.minimumDaily(creatorId)),
        ])
        : [null, {} as Record<string, number>];

    const request = typeof opts.request === 'string' && opts.request.trim() ? opts.request.trim().slice(0, MAX_REQUEST_CHARS) : null;
    const post = opts.post
        ? {
            id: String(opts.post.id), platform: String(opts.post.platform), caption: clip(String(opts.post.caption ?? ''), MAX_POST_CAPTION), kind: String(opts.post.kind),
            organic: {
                views: opts.post.organic?.views ?? null, reach: opts.post.organic?.reach ?? null,
                saves: opts.post.organic?.saves ?? null, skipRate: opts.post.organic?.skipRate ?? null,
            },
        }
        : null;

    return {
        tenant: {
            lang,
            currency: snapshot?.currency ?? answer?.currency ?? '',
            timezone: snapshot?.timezone ?? profile.identity?.timezone ?? 'UTC',
            countries: [...(profile.audience?.countries ?? [])],
        },
        limits: {
            maxDailyBudget: answer?.maxDailyBudget ?? null,
            monthlyCap: answer?.monthlyCap ?? null,
            remainingThisMonth: answer?.remaining ?? null,
            metaMinimumDaily: { ...minimums },
        },
        offers: (profile.offers ?? []).map((o) => {
            const price = typeof o.price === 'string' && o.price.trim() ? o.price.trim() : null;
            const summary = clip([...(o.bullets ?? []), ...(o.facts ?? [])].map(clean).filter(Boolean).join(' · '), MAX_OFFER_SUMMARY);
            return { id: o.id, title: o.name, price, url_is_tracked: o.order_via === 'url' && !!o.url, summary };
        }),
        request,
        post,
        policy: { rules: ports.policy ? ports.policy.rules(lang) : [] },
        account: { objects: snapshot?.objects ?? [], audiences: snapshot?.audiences ?? [] },
        daysOfData: snapshot?.daysOfData ?? 0,
        task: opts.task,
    };
}

// ─── For the checks ───────────────────────────────────────────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Every number the input holds, rounded to cents: the objects' budgets and 7-day totals, the limits and the post's organic counts. A
 * review item's evidence may quote only these (contract check 2). A number inside free text (a caption, a name) is not evidence.
 */
export function inputNumbers(input: ProposalInput): Set<number> {
    const out = new Set<number>();
    const add = (v: unknown): void => { if (typeof v === 'number' && Number.isFinite(v)) out.add(round2(v)); };
    for (const o of input.account.objects) {
        add(o.budget?.amount);
        for (const v of Object.values(o.last7d ?? {})) add(v);
    }
    for (const a of input.account.audiences) add(a.size);
    add(input.limits.maxDailyBudget);
    add(input.limits.monthlyCap);
    add(input.limits.remainingThisMonth);
    for (const v of Object.values(input.limits.metaMinimumDaily)) add(v);
    if (input.post) for (const v of Object.values(input.post.organic)) add(v);
    return out;
}

/** Whether `n` is one of the input's numbers, after rounding both to cents. */
export function hasNumber(numbers: Set<number>, n: number): boolean {
    return Number.isFinite(n) && numbers.has(round2(n));
}

/** Every piece of copy a spec carries, with its path: what the policy check reads (contract check 3). */
export function textFieldsOf(spec: CampaignSpec): { field: string; text: string }[] {
    const out: { field: string; text: string }[] = [];
    const push = (field: string, text: unknown): void => { if (typeof text === 'string' && text.trim()) out.push({ field, text }); };
    push('name', spec.name);
    (spec.ads ?? []).forEach((ad, i) => {
        push(`ads[${i}].copy.primaryText`, ad.copy?.primaryText);
        push(`ads[${i}].copy.headline`, ad.copy?.headline);
        if (ad.message) {
            push(`ads[${i}].message.greeting`, ad.message.greeting);
            (ad.message.iceBreakers ?? []).forEach((b, j) => {
                push(`ads[${i}].message.iceBreakers[${j}].title`, b.title);
                push(`ads[${i}].message.iceBreakers[${j}].response`, b.response);
            });
        }
    });
    return out;
}
