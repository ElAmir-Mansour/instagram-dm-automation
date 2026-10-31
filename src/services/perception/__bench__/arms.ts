/**
 * The two arms that need no extra module: the agent as it ships with Muse on (`meta`), and the agent as it was before (`today`).
 *
 * **Meta (Muse).** What `src/webhook/messaging.ts` does with a word-less Instagram message, piece for piece, with every part that would touch a database or send
 * a message handed in as a stand-in and every part that DECIDES left as it is:
 *
 *   the event            a Meta `message` built for the case, read by `primaryRef` / `mediaRefsOf` (`dm.ts`, `media.ts`): the same parser the webhook uses
 *   what to show         `resolveSource` (R18): the account's own reel is watched, someone else's is read by its caption, a photo or a story is shown whole
 *   Muse                 `perceiveDm` → `perceive()`: the pinned prompt, the schema `perception_v1`, the 0.6 confidence floor, a personal document never described
 *   what to do with it   `planOf`: answer it, or a fixed line (the request to send it again, the thanks that names the story)
 *   the answer           the sales turn's own prompt, schema, coercion and guard, drafted through the DM sales evaluation's runner (`__evals__/runner.ts`), which sends nothing
 *
 * Two differences from the live path, both on purpose: the Send API is never called (nothing is sent, nothing is typed, no owner is told), and the first draft is what is
 * judged: the product asks the model once more when its guard refuses a reply, which is a kindness the benchmark does not count. With typed words the words are the
 * question and what was shared rides along as a fact, as a reply to a story with words does in the product: Instagram delivers a shared reel and the words typed under
 * it as two messages, and the benchmark joins them.
 *
 * **Today.** What the agent sent before Muse. A message with no words got ONE fixed line from the language kit (`attachmentAck.ts`: "I can't open that here", or the
 * thanks for a story mention), once a day and never again until they wrote something. A message WITH words was answered from the words alone, and the attachment
 * was never opened. The first is deterministic and asks no model; the second is the same sales turn, on the same model, with nothing about the media in it.
 */
import { buildSalesPrompt, creatorName } from '../../dmSales/prompt.js';
import {
    checkNoInventedClaims, checkNoInventedNumbers, checkNoModelLinks, checkPatterns, excerpt,
} from '../../dmSales/__evals__/checks.js';
import { resolveFixture, type EvalFixture } from '../../dmSales/__evals__/fixtures.js';
import { isJudgeFailure, lowestScore } from '../../dmSales/__evals__/judge.js';
import { runCase } from '../../dmSales/__evals__/runner.js';
import type { CaseOutcome, EvalCaller, EvalCase, EvalPerceived, TurnOutcome } from '../../dmSales/__evals__/types.js';
import { SOFT_CRITERIA } from '../../dmSales/__evals__/types.js';
import { kitFor } from '../../profile/kits.js';
import { perceiveDm, primaryRef, type PerceiveDmDeps, type PerceiveDmInput } from '../dm.js';
import { readPhrase } from '../how.js';
import type { MediaRef } from '../media.js';
import { planOf } from '../plan.js';
import { resolveSource, type SourceDeps } from '../source.js';
import { perceivedFact } from '../text.js';
import { traceReason } from '../trace.js';
import type { Perception } from '../types.js';
import type { Ledger } from './caller.js';
import type { LoadedMedia } from './cases.js';
import type {
    ActionClass, ArmCaseResult, ArmId, Failure, InventedFacts, MuseCase, Understood,
} from './types.js';

// ─── What an arm needs ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ArmDeps {
    /** The sales turn's model: the real one, or a stand-in. */
    sales: EvalCaller;
    /** The judge, or null for none. */
    judge: EvalCaller | null;
    ledger: Ledger;
    /** Today's answer to a case with typed words is the sales turn on the words alone: a model call. False leaves those cases out of the Today arm. */
    todayText: boolean;
    /** Milliseconds, as `performance.now` gives them. A test or the dry run hands in a clock it moves itself. */
    clock?: () => number;
}

/** The creator and account the stand-ins speak for. The token is a placeholder that is never sent anywhere: the Graph API is a stand-in too. */
const BENCH_CREATOR = { id: 'benchmark-creator', page_access_token: 'benchmark-placeholder', instagram_page_id: 'benchmark-account' } as const;
const CDN_LINK = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=benchmark';
const REEL_ID = '17890000000000001';

/** Meta's `message` for a case, in the shape Instagram sends it, so that the webhook's own parser reads it. */
export function messageFor(c: MuseCase): unknown {
    switch (c.kind) {
        case 'image': return { attachments: [{ type: 'image', payload: { url: CDN_LINK } }] };
        case 'video': return { attachments: [{ type: 'video', payload: { url: CDN_LINK } }] };
        case 'story_mention': return { attachments: [{ type: 'story_mention', payload: { url: CDN_LINK } }] };
        case 'voice': return { attachments: [{ type: 'audio', payload: { url: CDN_LINK } }] };
        case 'reel': {
            const caption = c.source.kind === 'caption' ? c.source.caption : c.source.kind === 'file' ? c.source.caption : null;
            return { attachments: [{ type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/benchmark/', reel_video_id: REEL_ID, ...(caption ? { title: caption } : {}) } }] };
        }
    }
}

/** What `resolveSource` is asked its questions of: no library (it is P4's, and absent), a Graph answer that says whose the reel is, and the case's own bytes as the download. */
function sourceDeps(c: MuseCase, media: LoadedMedia | null): SourceDeps {
    return {
        library: async () => null,
        lookup: async () => (c.owner === 'other'
            ? { ok: false, notOurs: true }
            : { ok: true, media: { ownerId: BENCH_CREATOR.instagram_page_id, mediaType: 'VIDEO', mediaUrl: 'https://scontent.benchmark.fbcdn.net/reel.mp4', caption: null } }),
        download: async () => (media
            ? { ok: true, media: { mediaKind: media.mediaKind, mime: media.mime, bytes: media.bytes, host: 'benchmark.local', ms: 0 } }
            : { ok: false, status: 'skipped', reason: 'no_url' }),
    };
}

// ─── Reading it ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Reading {
    perception: Perception;
    ref: MediaRef;
    /** Milliseconds it took: the download is a file read here, so this is Muse's time and nothing else. */
    ms: number;
}

/**
 * `perceiveDm` for one case, with the gate open, nothing stored, no typing sent and nobody told: the stand-ins are listed and each is exercised by the tests. `perceive`
 * is the real one, so a stand-in for the providers layer (`setAiCaller`) is what stands between it and Meta.
 */
export interface ReadOptions {
    clock?: () => number;
    onTyping?: () => void;
    onTrouble?: (kind: string) => void;
    /** Replaces any of the stand-ins below. For a test of what each one is asked. */
    deps?: Partial<PerceiveDmDeps>;
}

export async function readCase(c: MuseCase, media: LoadedMedia | null, fx: EvalFixture, o: ReadOptions = {}): Promise<Reading> {
    const clock = o.clock ?? (() => performance.now());
    const ref = primaryRef(messageFor(c));
    if (!ref) throw new Error(`the case ${c.id} holds nothing Muse reads`);
    const kit = kitFor(fx.ctx.language);
    const input: PerceiveDmInput = {
        creator: { ...BENCH_CREATOR }, pageId: undefined, senderId: 'benchmark-sender', messageId: `benchmark-${c.id}`, ref, typed: c.typed !== null, resumed: false,
        language: kit.dm.schemaLanguage, handle: fx.ctx.links.handle,
    };
    const started = clock();
    const reading = await perceiveDm(input, {
        gate: async () => ({ ok: true }),
        readStored: async () => null,
        store: async ({ perception }) => ({ ...perception, stored_at: new Date().toISOString() }),
        typing: async () => { o.onTyping?.(); },
        resolve: (r, ctx) => resolveSource(r, ctx, sourceDeps(c, media)),
        onProviderTrouble: async (_id, kind) => { o.onTrouble?.(kind); },
        ...(o.deps ?? {}),
    });
    if (reading.kind !== 'read') throw new Error(`the gate was open and the read was declined (${reading.reason})`);
    return { perception: reading.perception, ref, ms: clock() - started };
}

// ─── Understood? ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const lower = (s: string): string => s.toLowerCase();

/** Did what Muse reported cover what the case says it must? A mechanical check on words, never a model's opinion. */
export function judgeUnderstood(spec: Understood, p: Pick<Perception, 'status' | 'reason' | 'seen' | 'transcript' | 'mention_summary' | 'about_owner'>): { ok: boolean; why: string | null } {
    if (spec.mode === 'unreadable') {
        return p.status === 'unreadable'
            ? { ok: true, why: null }
            : { ok: false, why: p.status === 'ok' ? `it described what could not be read: ${excerpt(p.seen ?? '', 70)}` : `it ended ${p.status}${p.reason ? ` (${p.reason})` : ''}, not as unreadable` };
    }
    if (spec.mode === 'personal') {
        return p.status === 'ok' && p.about_owner === 'personal'
            ? { ok: true, why: null }
            : { ok: false, why: p.status === 'ok' ? `it did not recognise a personal document: ${excerpt(p.seen ?? '', 70)}` : `it ended ${p.status}${p.reason ? ` (${p.reason})` : ''}` };
    }
    if (p.status !== 'ok') return { ok: false, why: `it ended ${p.status}${p.reason ? ` (${p.reason})` : ''}` };
    if (p.about_owner === 'personal') return { ok: false, why: 'it took it for a personal document' };
    const said = lower([p.seen, p.transcript, p.mention_summary].filter(Boolean).join(' '));
    const missed = spec.groups.filter((group) => !group.some((word) => said.includes(lower(word))));
    return missed.length === 0
        ? { ok: true, why: null }
        : { ok: false, why: `what it reported lacks ${missed.map((g) => `«${g[0]}»`).join(', ')}: ${excerpt(p.seen ?? '', 70)}` };
}

// ─── Scoring one drafted turn ────────────────────────────────────────────────────────────────────────────────────────────

/** The checks that are about what the agent DECIDED. A failure of one is the action not being the expected one. */
const DECISION_CHECKS: ReadonlySet<string> = new Set(['route', 'next_action', 'intent', 'stage', 'handoff_reason', 'offer_id', 'sent', 'model_answer']);
/** The checks that are about a fact the data does not hold: a number, a discount or a free offer, a link. */
const INVENTED_CHECKS: ReadonlySet<string> = new Set(['no_invented_numbers', 'no_invented_claims', 'no_model_links']);

export const oneLine = (text: string, max = 150): string => excerpt(text, max);

export const ACTION_WORDS: Readonly<Record<ActionClass, string>> = Object.freeze({
    answer: 'answered', recommend: 'recommended an offer', resend: 'asked for it to be sent again', handoff: 'handed the chat to a person', thank_named: 'thanked them by name',
    thank: 'sent a generic thanks', generic_line: 'sent the fixed "can\'t open that here" line', silent: 'sent nothing', error: 'made no answer (a model call failed)',
});

/** What the customer got, as a kind of action. The sales turn's `next_action` decides which kind of answer it was. */
export function actionOfTurn(t: Pick<TurnOutcome, 'sent' | 'model' | 'error'>): ActionClass {
    if (t.error) return 'error';
    switch (t.sent.kind) {
        case 'handoff':
        case 'unsure': return 'handoff';
        case 'none': return t.model ? 'silent' : 'error';
        case 'opt_out':
        case 'calm': return 'answer';
        case 'model': return t.model?.next_action === 'recommend' || t.model?.next_action === 'send_link' ? 'recommend' : 'answer';
    }
}

const failureLine = (c: { name: string; detail: string }): string => `${c.name}: ${oneLine(c.detail)}`;

/** Is `action` one the case accepts? (A case can only EXPECT five of the kinds an arm can do.) */
export const accepts = (c: MuseCase, action: ActionClass): boolean => (c.expect.action as readonly ActionClass[]).includes(action);

export interface TurnScore {
    action: ActionClass;
    actionOk: boolean;
    actionWhy: string | null;
    invented: InventedFacts;
    failures: Failure[];
    reply: string;
    judge: ArmCaseResult['judge'];
}

/** One drafted turn against what its case expects: the action, the invented facts before and after the guard, and every hard check that failed. */
export function scoreTurn(c: MuseCase, arm: ArmId, t: TurnOutcome, fx: EvalFixture): TurnScore {
    const action = actionOfTurn(t);
    const decisionFails = t.checks.filter((k) => !k.pass && DECISION_CHECKS.has(k.name));
    const classOk = accepts(c, action);
    const actionOk = classOk && decisionFails.length === 0;
    const failures: Failure[] = [];
    const fail = (what: string, reason: string): void => { failures.push({ caseId: c.id, arm, what, reason: oneLine(reason) }); };

    let actionWhy: string | null = null;
    if (!actionOk) {
        actionWhy = t.error
            ? `the model did not answer (${t.error.kind})`
            : !classOk
                ? `${ACTION_WORDS[action]}; expected ${c.expect.action.map((a) => ACTION_WORDS[a]).join(' or ')}`
                : decisionFails.map(failureLine).join('; ');
        fail('action', actionWhy);
    }

    const textIntended = t.model !== undefined && t.model.next_action !== 'handoff';
    const forbidCheck = (text: string) => {
        const r = checkPatterns(text, [], c.expect.forbid);
        return r && !r.pass ? { name: 'forbidden_fact', pass: false, detail: r.detail } : null;
    };

    // Before the guard: what the model wrote. This is the number the owner picks a model by.
    const draft = t.checks.filter((k) => !k.pass && INVENTED_CHECKS.has(k.name)).map(failureLine);
    const draftForbidden = textIntended && t.rawText !== undefined && c.expect.forbid.length > 0 ? forbidCheck(t.rawText) : null;
    if (draftForbidden) draft.push(failureLine(draftForbidden));

    // After the guard: what the customer is sent. The guard takes out a link and refuses a reply with a number the data does not hold, so this is nearly always empty,
    // and a case-specific forbidden fact (a number the picture showed, in a script the guard may read differently) is what it can still catch.
    const sent: string[] = [];
    if (t.sent.kind === 'model') {
        const claims = buildSalesPrompt({ persona: fx.persona, knowledge: fx.knowledge, ctx: fx.ctx, timezone: fx.timezone, now: fx.now }).claims;
        for (const r of [
            checkNoInventedNumbers(t.sent.text, claims), checkNoInventedClaims(t.sent.text, claims, c.expect.turn.allow_claim_words), checkNoModelLinks(t.sent.text), forbidCheck(t.sent.text),
        ]) if (r && !r.pass) sent.push(failureLine(r));
    }

    for (const k of t.checks) {
        if (k.pass || DECISION_CHECKS.has(k.name)) continue;
        fail(k.name, k.detail);
    }
    if (draftForbidden) fail('forbidden_fact', draftForbidden.detail);

    let judge: TurnScore['judge'] = null;
    if (t.judge && !isJudgeFailure(t.judge)) {
        const scores = SOFT_CRITERIA.map((k) => t.judge && !isJudgeFailure(t.judge) ? t.judge.scores[k] : undefined).filter((v): v is number => typeof v === 'number');
        const lowest = lowestScore(t.judge);
        if (scores.length > 0 && lowest !== null) {
            judge = { mean: scores.reduce((a, b) => a + b, 0) / scores.length, lowest, notes: t.judge.notes };
            if (lowest < 3) fail('judge', `scored ${lowest}: ${t.judge.notes || 'no notes'}`);
        }
    } else if (t.judge && isJudgeFailure(t.judge)) {
        fail('judge', `not scored: ${t.judge.error}`);
    }

    // What the customer is sent, for the report: the model's words, and a note that the system adds the offer's link after a send_link.
    const link = t.sent.kind === 'model' && t.model?.next_action === 'send_link' && t.model.offer_id !== 'none' ? '\n[the system adds the offer\'s tracked link]' : '';
    return { action, actionOk, actionWhy, invented: { draft, sent }, failures, reply: `${t.sent.text}${link}`.trim(), judge };
}

// ─── Drafting the sales turn ─────────────────────────────────────────────────────────────────────────────────────────────

/** The one-turn conversation the sales evaluation's runner is given for a case. */
function evalCaseFor(c: MuseCase, user: string, perceived?: EvalPerceived): EvalCase {
    return { id: c.id, title: c.title, fixture: c.fixture, writes: c.writes, turns: [{ user, expect: c.expect.turn, ...(perceived ? { perceived } : {}) }] };
}

export async function draftTurn(c: MuseCase, user: string, perceived: EvalPerceived | undefined, deps: ArmDeps): Promise<CaseOutcome> {
    return runCase(evalCaseFor(c, user, perceived), { caller: deps.sales, judge: deps.judge });
}

/** Cost, tokens and calls of the case from the ledger, and the model-call count. */
export function spent(deps: ArmDeps, caseId: string): { usd: number; tokensIn: number; tokensOut: number; calls: number } {
    return deps.ledger.totalsFor(caseId);
}

export const emptyInvented = (): InventedFacts => ({ draft: [], sent: [] });

/** The fixed line a hand-off sends: the account's own message when it typed one, else the kit's. What `lineFor` does in the sales turn. */
export function handoffLine(fx: EvalFixture): string {
    const kit = kitFor(fx.ctx.language).sales;
    return fx.ctx.handoff?.message.trim() || kit.lines.handoff(creatorName(fx.ctx, kit));
}

// ─── The Meta arm ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function runMetaCase(c: MuseCase, media: LoadedMedia | null, deps: ArmDeps, read: Omit<ReadOptions, 'clock'> = {}): Promise<ArmCaseResult> {
    const fx = resolveFixture(c.fixture);
    const kit = kitFor(fx.ctx.language);
    const base = { arm: 'meta' as const, caseId: c.id, status: 'ran' as const, note: null };
    deps.ledger.current = c.id;
    try {
        const reading = await readCase(c, media, fx, { ...read, ...(deps.clock ? { clock: deps.clock } : {}) });
        const p = reading.perception;
        const understood = judgeUnderstood(c.understood, p);
        const seen = p.status === 'ok' ? (p.mention_summary && p.kind === 'story_mention' ? `${p.seen ?? ''} [mention: ${p.mention_summary}]`.trim() : p.seen ?? null) : null;
        const common = { ...base, understood: understood.ok, understoodWhy: understood.why, seen, judge: null as ArmCaseResult['judge'] };
        const failures: Failure[] = understood.ok ? [] : [{ caseId: c.id, arm: 'meta', what: 'understood', reason: oneLine(understood.why ?? '') }];

        // A word-less message: what the pipeline does with what was read. With words: the words are the question, and what was read is a fact beside them.
        if (c.typed === null) {
            const plan = planOf(p, kit.attachments);
            if (plan.kind === 'ack') {
                const named = plan.perception?.line !== undefined && plan.perception.line !== kit.attachments.resend;
                const line = plan.perception?.line ?? (c.kind === 'story_mention' ? kit.attachments.mention : kit.attachments.media);
                const action: ActionClass = plan.perception?.line === kit.attachments.resend ? 'resend'
                    : c.kind === 'story_mention' ? (named ? 'thank_named' : 'thank') : 'generic_line';
                const actionOk = accepts(c, action);
                const actionWhy = actionOk ? null : `${ACTION_WORDS[action]}${plan.perception?.reason ? ` (${oneLine(plan.perception.reason, 110)})` : ''}; expected ${c.expect.action.map((a) => ACTION_WORDS[a]).join(' or ')}`;
                if (!actionOk) failures.push({ caseId: c.id, arm: 'meta', what: 'action', reason: oneLine(actionWhy ?? '') });
                const totals = spent(deps, c.id);
                return { ...common, action, actionOk, actionWhy, reply: line, trace: plan.perception?.reason ?? null, invented: emptyInvented(), failures, ms: reading.ms, ...totals };
            }
            if (plan.perceived.personal) {
                // No model is asked: a person looks, and nothing about what was in it is said to anyone.
                const actionOk = c.expect.action.includes('handoff');
                if (!actionOk) failures.push({ caseId: c.id, arm: 'meta', what: 'action', reason: `handed the chat to a person; expected ${c.expect.action.map((a) => ACTION_WORDS[a]).join(' or ')}` });
                const trace = traceReason({ kind: p.kind, effect: 'handoff', action: 'handoff', handoffReason: 'unsure', intent: null, personal: true });
                return {
                    ...common, action: 'handoff', actionOk, actionWhy: actionOk ? null : failures[failures.length - 1]!.reason, reply: handoffLine(fx), trace, invented: emptyInvented(), failures, ms: reading.ms,
                    ...spent(deps, c.id),
                };
            }
            const outcome = await draftTurn(c, plan.text, { sent: plan.perceived.sent, describedText: true }, deps);
            return finishDrafted(c, 'meta', common, failures, outcome, fx, reading.ms, deps, p);
        }

        // Words and media together.
        const readable = p.status === 'ok' && p.about_owner !== 'personal';
        const sent = readable ? perceivedFact(p) : null;
        const outcome = await draftTurn(c, c.typed, sent ? { sent, describedText: false } : undefined, deps);
        return finishDrafted(c, 'meta', common, failures, outcome, fx, reading.ms, deps, p);
    } finally {
        deps.ledger.current = null;
    }
}

/** The result of a drafted turn: the score, the product's own line of why, the time and the cost. `readMs` is how long reading the media (or hearing the voice note) took. */
export function finishDrafted(
    c: MuseCase, arm: ArmId, common: Pick<ArmCaseResult, 'arm' | 'caseId' | 'status' | 'note' | 'understood' | 'understoodWhy' | 'seen' | 'judge'>, failures: Failure[], outcome: CaseOutcome,
    fx: EvalFixture, readMs: number, deps: ArmDeps, p: Perception | null, extra: { trace?: string | null; usd?: number } = {},
): ArmCaseResult {
    const t = outcome.turns[0];
    if (!t) throw new Error(`the runner returned no turn for ${c.id}`);
    const score = scoreTurn(c, arm, t, fx);
    const decided = t.sent.kind === 'handoff' || t.sent.kind === 'unsure';
    const trace = p && p.status === 'ok'
        ? traceReason({
            kind: p.kind, read: readPhrase(p.kind, p.seen), effect: decided ? 'handoff' : 'reply', action: t.model?.next_action ?? 'handoff', handoffReason: t.model?.handoff_reason ?? 'none',
            intent: t.model?.intent ?? null, ...(t.error ? { modelFailed: true } : {}),
        })
        : null;
    const totals = spent(deps, c.id);
    return {
        ...common, action: score.action, actionOk: score.actionOk, actionWhy: score.actionWhy, reply: score.reply, trace: extra.trace ?? trace, invented: score.invented,
        failures: [...failures, ...score.failures], ms: readMs + (t.latencyMs ?? 0), judge: score.judge, ...totals, usd: Math.round((totals.usd + (extra.usd ?? 0)) * 1e9) / 1e9,
    };
}

// ─── The Today arm ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Today's answer to one case. Null: the case is not part of this arm (typed words, with `--no-today-text`). */
export async function runTodayCase(c: MuseCase, deps: ArmDeps, arm: 'today' | 'today_voice' = 'today'): Promise<ArmCaseResult | null> {
    const fx = resolveFixture(c.fixture);
    const kit = kitFor(fx.ctx.language);
    const base = { arm, caseId: c.id, status: 'ran' as const, note: null, understood: false, understoodWhy: 'it never opens an attachment', seen: null, trace: null, judge: null };

    // Words with it: the words alone, as ever. The media is never opened.
    if (c.typed !== null) {
        if (!deps.todayText) return null;
        deps.ledger.current = c.id;
        try {
            const outcome = await draftTurn(c, c.typed, undefined, deps);
            const t = outcome.turns[0]!;
            const score = scoreTurn(c, arm, t, fx);
            const failures: Failure[] = [{ caseId: c.id, arm, what: 'understood', reason: 'it never opens an attachment' }, ...score.failures];
            return { ...base, action: score.action, actionOk: score.actionOk, actionWhy: score.actionWhy, reply: score.reply, invented: score.invented, failures, ms: t.latencyMs ?? 0, judge: score.judge, ...spent(deps, c.id) };
        } finally {
            deps.ledger.current = null;
        }
    }

    // No words: one fixed line, once a day.
    const mention = c.kind === 'story_mention';
    const action: ActionClass = c.priorAck ? 'silent' : mention ? 'thank' : 'generic_line';
    const reply = c.priorAck ? '' : mention ? kit.attachments.mention : kit.attachments.media;
    const actionOk = accepts(c, action);
    const actionWhy = actionOk ? null : `${ACTION_WORDS[action]}; expected ${c.expect.action.map((a) => ACTION_WORDS[a]).join(' or ')}`;
    const failures: Failure[] = [{ caseId: c.id, arm, what: 'understood', reason: 'it never opens an attachment' }];
    if (!actionOk) failures.push({ caseId: c.id, arm, what: 'action', reason: oneLine(actionWhy ?? '') });
    return { ...base, action, actionOk, actionWhy, reply, invented: emptyInvented(), failures, ms: 0, usd: 0, tokensIn: 0, tokensOut: 0, calls: 0 };
}
