/**
 * The server checks after the model answers (contracts/ai-proposal.schema.md "Server checks", in that order):
 *
 *   1. Schema    `validateDraft` / `validateReview`. Wrong → asked again ONCE with the errors; wrong again → `failed`.
 *   2. Evidence  a review item may quote only numbers that are in the input, about objects the account has: otherwise it is dropped
 *                (listed in `checks.dropped`, never shown as a proposal). A model's invented "CTR 4.2%" never reaches the owner.
 *   3. Policy    A4's deterministic check on every text field. A `block` → asked again ONCE with the findings; still blocked → `failed`.
 *                Warnings are kept and shown on the card.
 *   4. Money     A1's money rule on the worst case. Over the daily max or past what is left of the month → the budget is REDUCED to fit,
 *                with a note in the tenant's language. Below Meta's minimum for the goal (or nothing left) → `failed` (a review item:
 *                dropped).
 *
 * Meta's own `validate_only` is NOT here: it costs points and runs on approval only (check 5).
 *
 * Pure apart from the ports it is handed: the policy port is pure, the money port may read Meta (never call this in a transaction).
 * A port that is null is not guessed: the check is skipped and named in `checks.unavailable`, and approve refuses while it is.
 */
import { hasNumber, inputNumbers, textFieldsOf } from './input.js';
import { validateDraft, validateReview } from './schema.js';
import type {
    CampaignSpec, MoneyCandidate, MoneyPort, PolicyFinding, ProposalChecks, ProposalEffect, ProposalInput, ProposalKind, ProposalPayload,
    ProposalPorts, ProposalTask, ReviewItem,
} from './types.js';

export type CheckOutcome =
    | { kind: 'regenerate'; reason: 'schema' | 'policy'; feedback: string[] }
    | { kind: 'failed'; reason: string; checks: ProposalChecks }
    | {
        kind: 'ok';
        items: Array<{
            kind: ProposalKind; payload: ProposalPayload; rationale: string; evidence: Record<string, unknown> | null;
            effect: ProposalEffect; checks: ProposalChecks;
        }>;
    };

export interface CheckArgs {
    task: ProposalTask;
    raw: unknown;
    input: ProposalInput;
    attempt: number;
    creatorId: string;
    ports: ProposalPorts;
}

/** A review proposal's horizon when it names no end: the rest of a month, as the money rule counts a daily budget. */
export const REVIEW_DAYS = 30;
/** A draft with a daily budget and no end date is weighed as running this many days. */
export const OPEN_ENDED_DAYS = 30;

const floor2 = (n: number): number => Math.floor(n * 100 + 1e-6) / 100;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const NO_EFFECT: ProposalEffect = { worstCaseDelta: null, newWorstCase: null, currency: null };

export function specDays(spec: CampaignSpec): number {
    if (!spec.budget.end) return OPEN_ENDED_DAYS;
    const ms = Date.parse(spec.budget.end) - Date.parse(spec.budget.start);
    return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 86_400_000)) : OPEN_ENDED_DAYS;
}

/** How many budget holders the amount is for: every ad set when the ad sets hold it, else the one campaign. */
const holders = (spec: CampaignSpec): number => (spec.budget.home === 'adset' ? Math.max(1, spec.adsets.length) : 1);

function baseChecks(ports: ProposalPorts): ProposalChecks {
    const unavailable: NonNullable<ProposalChecks['unavailable']> = [];
    if (!ports.policy) unavailable.push('policy');
    if (!ports.money) unavailable.push('money');
    return {
        policy: [],
        money: ports.money ? { ok: true, reason: null, note: null } : { ok: false, reason: 'NOT_WIRED', note: null },
        meta_validate: null,
        ...(unavailable.length ? { unavailable } : {}),
    };
}

function policyOf(ports: ProposalPorts, spec: CampaignSpec, lang: 'ar' | 'en'): PolicyFinding[] {
    return ports.policy ? ports.policy.check(textFieldsOf(spec), lang) : [];
}

const policyFeedback = (findings: PolicyFinding[]): string[] =>
    findings.filter((f) => f.severity === 'block').map((f) => `${f.field}: ${f.message} (policy rule ${f.ruleId}); rewrite this text`);

// ─── Money for a whole spec ──────────────────────────────────────────────────────────────────────────────────────────────

type SpecMoney =
    | { ok: true; spec: CampaignSpec; note: string | null; effect: ProposalEffect }
    | { ok: false; reason: 'BELOW_META_MINIMUM' | 'OVER_MONTHLY_CAP' | 'OVER_DAILY_MAX' | 'NOT_CONFIGURED' | 'UNREADABLE'; note: string | null };

function reducedNote(lang: 'ar' | 'en', from: number, to: number, currency: string, why: 'daily' | 'month'): string {
    if (lang === 'ar') {
        return why === 'daily'
            ? `خُفِّضت الميزانية من ${from} إلى ${to} ${currency} لتبقى ضمن الحد اليومي الذي حددته.`
            : `خُفِّضت الميزانية من ${from} إلى ${to} ${currency} لتبقى ضمن ما تبقّى من سقف هذا الشهر.`;
    }
    return why === 'daily'
        ? `The budget was reduced from ${from} to ${to} ${currency} to stay within your max daily budget.`
        : `The budget was reduced from ${from} to ${to} ${currency} to fit what is left of this month's cap.`;
}

async function moneyForSpec(money: MoneyPort, args: CheckArgs, original: CampaignSpec): Promise<SpecMoney> {
    const { input, creatorId } = args;
    const lang = input.tenant.lang;
    const currency = input.tenant.currency;
    const spec: CampaignSpec = { ...original, budget: { ...original.budget } };
    const n = holders(spec);
    const days = specDays(spec);
    const daily = spec.budget.kind === 'daily';
    const notes: string[] = [];
    const candidateOf = (): MoneyCandidate => ({ kind: spec.budget.kind, amount: round2(spec.budget.amount * n), days });

    // The daily max first: it is the owner's own limit, known without asking anyone.
    const maxDaily = input.limits.maxDailyBudget;
    const perDayTotal = (): number => (daily ? spec.budget.amount * n : (spec.budget.amount * n) / days);
    if (maxDaily !== null && perDayTotal() > maxDaily + 1e-9) {
        const to = daily ? floor2(maxDaily / n) : floor2((maxDaily * days) / n);
        notes.push(reducedNote(lang, spec.budget.amount, to, currency, 'daily'));
        spec.budget.amount = to;
    }

    let answer = await money.check(creatorId, candidateOf());
    if (!answer.fits) {
        if (answer.reason === 'NOT_CONFIGURED' || answer.reason === 'UNREADABLE') return { ok: false, reason: answer.reason, note: null };
        if (answer.reason === 'OVER_DAILY_MAX' && answer.maxDailyBudget !== null) {
            const to = daily ? floor2(answer.maxDailyBudget / n) : floor2((answer.maxDailyBudget * days) / n);
            notes.push(reducedNote(lang, spec.budget.amount, to, currency, 'daily'));
            spec.budget.amount = to;
            answer = await money.check(creatorId, candidateOf());
        }
        if (!answer.fits) {
            const remaining = answer.remaining;
            if (remaining === null || remaining <= 0) return { ok: false, reason: 'OVER_MONTHLY_CAP', note: null };
            const to = daily ? floor2(remaining / days / n) : floor2(remaining / n);
            if (to <= 0) return { ok: false, reason: 'OVER_MONTHLY_CAP', note: null };
            notes.push(reducedNote(lang, spec.budget.amount, to, currency, 'month'));
            spec.budget.amount = to;
            answer = await money.check(creatorId, candidateOf());
            if (!answer.fits) return { ok: false, reason: 'OVER_MONTHLY_CAP', note: null };
        }
    }

    const minimum = input.limits.metaMinimumDaily[spec.goal];
    const perHolderDay = daily ? spec.budget.amount : spec.budget.amount / days;
    if (typeof minimum === 'number' && perHolderDay < minimum - 1e-9) return { ok: false, reason: 'BELOW_META_MINIMUM', note: notes.join(' ') || null };

    const delta = round2(daily ? spec.budget.amount * n * days : spec.budget.amount * n);
    const cap = answer.monthlyCap;
    const remaining = answer.remaining;
    return {
        ok: true,
        spec,
        note: notes.length ? notes.join(' ') : null,
        effect: { worstCaseDelta: delta, newWorstCase: cap !== null && remaining !== null ? round2(cap - remaining + delta) : null, currency: answer.currency ?? (currency || null) },
    };
}

// ─── Money for one review item ───────────────────────────────────────────────────────────────────────────────────────────

type ItemMoney = { ok: true; item: ReviewItem; note: string | null; effect: ProposalEffect } | { ok: false; reason: string };

async function moneyForItem(money: MoneyPort, args: CheckArgs, item: ReviewItem): Promise<ItemMoney> {
    const { input } = args;
    const byId = new Map(input.account.objects.map((o) => [o.id, o]));
    const currency = input.tenant.currency || null;
    const lang = input.tenant.lang;
    const targets = item.targets.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    const base = targets.reduce((sum, o) => sum + (o.budget && o.budget.kind !== 'none' && o.budget.amount !== null ? o.budget.amount : 0), 0);
    const daily = targets.every((o) => o.budget?.kind !== 'lifetime');
    const span = daily ? REVIEW_DAYS : 1;

    if ('spec' in item.change) {
        const r = await moneyForSpec(money, args, item.change.spec);
        if (!r.ok) return { ok: false, reason: r.reason };
        return { ok: true, item: { ...item, change: { spec: r.spec } }, note: r.note, effect: r.effect };
    }

    if ('from' in item.change) {
        // Moving budget between two ad sets leaves the total where it was; only the receiving one's daily max can stop it.
        const to = byId.get(item.change.to);
        let amount = item.change.amount;
        let note: string | null = null;
        const maxDaily = input.limits.maxDailyBudget;
        if (maxDaily !== null && to?.budget?.amount != null && to.budget.kind === 'daily' && to.budget.amount + amount > maxDaily + 1e-9) {
            const fitted = floor2(maxDaily - to.budget.amount);
            if (fitted <= 0) return { ok: false, reason: 'OVER_DAILY_MAX' };
            note = reducedNote(lang, amount, fitted, input.tenant.currency, 'daily');
            amount = fitted;
        }
        return { ok: true, item: { ...item, change: { ...item.change, amount } }, note, effect: { worstCaseDelta: 0, newWorstCase: null, currency } };
    }

    const percent = item.kind === 'pause' ? -100 : item.change.percent;
    if (percent <= 0) {
        return { ok: true, item, note: null, effect: { worstCaseDelta: round2((base * percent) / 100 * span), newWorstCase: null, currency } };
    }

    // A raise: the extra per day is what the money rule weighs.
    if (base <= 0) return { ok: false, reason: 'the current budget is not known' };
    let p = percent;
    let note: string | null = null;
    const maxDaily = input.limits.maxDailyBudget;
    if (daily && maxDaily !== null && base * (1 + p / 100) > maxDaily + 1e-9) {
        const fitted = Math.floor(((maxDaily - base) / base) * 100);
        if (fitted <= 0) return { ok: false, reason: 'OVER_DAILY_MAX' };
        note = lang === 'ar' ? `خُفِّضت الزيادة من ${p}% إلى ${fitted}% لتبقى ضمن الحد اليومي.` : `The raise was reduced from ${p}% to ${fitted}% to stay within your max daily budget.`;
        p = fitted;
    }
    const candidate = (pct: number): MoneyCandidate => ({ kind: daily ? 'daily' : 'lifetime', amount: round2((base * pct) / 100), days: span });
    let answer = await money.check(args.creatorId, candidate(p));
    if (!answer.fits) {
        if (answer.reason === 'NOT_CONFIGURED' || answer.reason === 'UNREADABLE') return { ok: false, reason: answer.reason };
        const remaining = answer.remaining;
        if (remaining === null || remaining <= 0) return { ok: false, reason: 'OVER_MONTHLY_CAP' };
        const fitted = Math.floor((remaining / span / base) * 100);
        if (fitted <= 0) return { ok: false, reason: 'OVER_MONTHLY_CAP' };
        note = lang === 'ar' ? `خُفِّضت الزيادة من ${p}% إلى ${fitted}% لتبقى ضمن ما تبقّى من سقف الشهر.` : `The raise was reduced from ${p}% to ${fitted}% to fit what is left of this month's cap.`;
        p = fitted;
        answer = await money.check(args.creatorId, candidate(p));
        if (!answer.fits) return { ok: false, reason: 'OVER_MONTHLY_CAP' };
    }
    const delta = round2((base * p) / 100 * span);
    const cap = answer.monthlyCap;
    const remaining = answer.remaining;
    return {
        ok: true, item: { ...item, change: { percent: p } }, note,
        effect: { worstCaseDelta: delta, newWorstCase: cap !== null && remaining !== null ? round2(cap - remaining + delta) : null, currency: answer.currency ?? currency },
    };
}

// ─── The pipeline ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function runChecks(args: CheckArgs): Promise<CheckOutcome> {
    const { task, raw, input, attempt, ports } = args;
    const lang = input.tenant.lang;

    if (task === 'draft_campaign') {
        // 1. Schema.
        const v = validateDraft(raw);
        if (!v.ok) {
            if (attempt <= 1) return { kind: 'regenerate', reason: 'schema', feedback: v.errors };
            return { kind: 'failed', reason: `The answer did not match the schema: ${v.errors.join('; ')}`, checks: baseChecks(ports) };
        }
        const draft = v.value;
        const checks = baseChecks(ports);

        // 3. Policy (2. evidence is for review items).
        const findings = policyOf(ports, draft.spec, lang);
        checks.policy = findings;
        if (findings.some((f) => f.severity === 'block')) {
            if (attempt <= 1) return { kind: 'regenerate', reason: 'policy', feedback: policyFeedback(findings) };
            return { kind: 'failed', reason: 'POLICY_BLOCKED', checks };
        }

        // 4. Money.
        let spec = draft.spec;
        let effect = NO_EFFECT;
        if (ports.money) {
            const m = await moneyForSpec(ports.money, args, draft.spec);
            if (!m.ok) return { kind: 'failed', reason: m.reason, checks: { ...checks, money: { ok: false, reason: m.reason, note: m.note } } };
            spec = m.spec;
            effect = m.effect;
            checks.money = { ok: true, reason: null, note: m.note };
        }
        return {
            kind: 'ok',
            items: [{
                kind: 'new_campaign',
                payload: { task: 'draft_campaign', spec, assumptions: draft.assumptions, expected: draft.expected },
                rationale: draft.rationale,
                evidence: draft.expected.range ? { expected: draft.expected } : null,
                effect,
                checks,
            }],
        };
    }

    // Review: 1. schema.
    const v = validateReview(raw);
    if (!v.ok) {
        if (attempt <= 1) return { kind: 'regenerate', reason: 'schema', feedback: v.errors };
        return { kind: 'failed', reason: `The answer did not match the schema: ${v.errors.join('; ')}`, checks: baseChecks(ports) };
    }

    // 2. Evidence.
    const numbers = inputNumbers(input);
    const ids = new Set(input.account.objects.map((o) => o.id));
    const dropped: { index: number; reason: string }[] = [];
    const kept: { index: number; item: ReviewItem }[] = [];
    v.value.items.forEach((item, index) => {
        const unknownTarget = [...item.targets, ...('from' in item.change ? [item.change.from, item.change.to] : [])].find((id) => !ids.has(id));
        if (unknownTarget !== undefined) { dropped.push({ index, reason: `targets ${unknownTarget}, which is not in the account` }); return; }
        const invented = Object.entries(item.evidence.numbers).find(([, n]) => !hasNumber(numbers, n));
        if (invented) { dropped.push({ index, reason: `evidence ${invented[0]} = ${invented[1]} is not in the account's numbers` }); return; }
        kept.push({ index, item });
    });

    // 3. Policy, on the copy of an item that carries a spec.
    const policyByIndex = new Map<number, PolicyFinding[]>();
    for (const { index, item } of kept) {
        if (!('spec' in item.change)) continue;
        const findings = policyOf(ports, item.change.spec, lang);
        policyByIndex.set(index, findings);
        if (findings.some((f) => f.severity === 'block')) {
            if (attempt <= 1) return { kind: 'regenerate', reason: 'policy', feedback: policyFeedback(findings).map((f) => `items[${index}].change.spec.${f}`) };
            dropped.push({ index, reason: 'POLICY_BLOCKED' });
        }
    }

    // 4. Money.
    const items: Extract<CheckOutcome, { kind: 'ok' }>['items'] = [];
    for (const { index, item } of kept) {
        if (dropped.some((d) => d.index === index)) continue;
        const checks = baseChecks(ports);
        checks.policy = policyByIndex.get(index) ?? [];
        let final = item;
        let effect = NO_EFFECT;
        if (ports.money) {
            const m = await moneyForItem(ports.money, args, item);
            if (!m.ok) { dropped.push({ index, reason: m.reason }); continue; }
            final = m.item;
            effect = m.effect;
            checks.money = { ok: true, reason: null, note: m.note };
        }
        items.push({ kind: 'change', payload: { task: 'review', item: final }, rationale: final.rationale, evidence: final.evidence, effect, checks });
    }
    if (dropped.length) for (const it of items) it.checks.dropped = [...dropped].sort((a, b) => a.index - b.index);
    return { kind: 'ok', items };
}
