/**
 * Is Claude on the owner's Mac signed in? (research USE-1, 2026-11-27.)
 *
 * Claude on the Mac was signed out from 2026-11-07 to 11-18. Every Claude job failed with "OAuth session expired": 176 `monteur_think` jobs in 30 days (the
 * Monteur retried each request four times), plus an infographic, an ad proposal and an explainer. Nothing told the owner, because the Mac's worker was online
 * and healthy: only the CLI behind it was signed out. This module is the one place that knows what a sign-in failure is and what to do about it.
 *
 *   rule      `isSignInFailure(message)`: what the CLI says when it is signed out. Conservative on purpose (a rate limit, a spent allowance or a draft that
 *             mentions OAuth is not one). Used by every Mac-brain failure path: the Monteur's think (`monteur/think.ts`), infographics and the proposal drafts
 *             (`studio/jobs.ts`, `ads/proposals/service.ts`) and the explainers (`explainers/writing.ts`).
 *   state     the app setting `mac.claude_signed_out_at`. `noteMacJobFailed` sets it on the first sign-in failure of a Claude job; `noteMacJobDone` clears it
 *             when the next Claude job of any kind succeeds, and then `requeueSignInBlocked` puts back the work the sign-in stopped.
 *   waiting   a sign-in failure is not a try: it costs none, and while the flag is set the Monteur WAITS. It never falls back to Gemini or another model
 *             (the owner's rule, "Claude, never Gemini, for videos").
 *   probe     with the flag set and no Claude job running, nothing would ever succeed to clear it. `probeClaudeSignIn` (every drain) queues one tiny think
 *             every `SIGNED_OUT_PROBE_MINUTES`; the answer of the first one that works clears the flag.
 *   alarm     `checkMacAlarms` (every drain): the probe, then one email a day per problem to the owner (signed out, and the worker offline with work waiting).
 *
 * Everything here is best effort around the job queue: a failed read or write is logged and never fails the job that was being reported.
 */
import { queryOne, queryRows } from '../../db/query.js';
import type { MonteurThinkPayload, StudioJobKind } from '../../db/rows.js';
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import { APP_SETTING_KEYS, getSetting, setSetting, type AppSettingKey } from '../appSettings.js';
import { isMacBrainJob } from '../macBrain.js';
import { effectiveTo, emailReady, readNotifyChannels, sendEmail } from '../notifyEmail.js';
import { sendTelegramMessage, telegramReady } from '../notify.js';
import { getPlatformOwnerId } from '../tenant.js';

// ─── The rule ─────────────────────────────────────────────────────────────────────────────────

/**
 * What the Claude CLI says when it is signed out, as the worker reports it: `claude answered with an error: Failed to authenticate: OAuth session expired and
 * could not be refreshed` (the worker's log, 2026-10-01, 10-22 and 11-07), and the older and shorter forms of the same refusal. Conservative on purpose: each
 * phrase is a whole sign-in message, and a bare "OAuth" or "401" is not one (a draft about OAuth, a failed page, a rate limit and a spent weekly allowance are
 * failures of their own, and the owner is told what they are instead of being told to sign in).
 */
const SIGN_IN_FAILURES: readonly RegExp[] = [
    /failed to authenticate/i,
    /oauth (?:session|token) (?:has )?expired/i,
    /\bnot logged in\b/i,
    /please run \/login/i,
    /invalid api key\s*[·\-–—]\s*please run/i,
    /\bauthentication_error\b/i,
];

export function isSignInFailure(message: string | null | undefined): boolean {
    return typeof message === 'string' && SIGN_IN_FAILURES.some((pattern) => pattern.test(message));
}

/** What an item that stopped for it says, plainly. Stored as the error of an infographic, a source or a proposal, and shown as it is. */
export const SIGNED_OUT_MESSAGE =
    'Claude on the Mac is signed out. On the Mac run `claude /login` (or restart the Studio worker): this goes on by itself once Claude answers again.';

/** While signed out, one tiny Claude question this often finds out whether it is over. */
export const SIGNED_OUT_PROBE_MINUTES = 30;

/** The most items one clearing puts back, and how old a blocked item may be: bounded, so a long outage cannot flood the Mac when it ends. */
export const REQUEUE_LIMIT = 10;
export const REQUEUE_MAX_AGE_DAYS = 3;

// ─── The stored state ─────────────────────────────────────────────────────────────────────────

/** When Claude was first seen signed out (ISO), or null when it is not known to be. */
export async function claudeSignedOutAt(): Promise<string | null> {
    return getSetting(APP_SETTING_KEYS.macClaudeSignedOutAt);
}

export async function isClaudeSignedOut(): Promise<boolean> {
    return (await claudeSignedOutAt()) !== null;
}

/** Set the flag unless it is already set (the first failure's time is kept). True when this call set it. */
export async function markClaudeSignedOut(now: Date = new Date()): Promise<boolean> {
    const { rowCount } = await pool.query(
        `INSERT INTO app_settings (key, value, is_secret, updated_at, updated_by)
         VALUES ($1, $2, FALSE, NOW(), NULL)
         ON CONFLICT (key) DO NOTHING`,
        [APP_SETTING_KEYS.macClaudeSignedOutAt, now.toISOString()]
    );
    return (rowCount ?? 0) > 0;
}

/** Delete the flag. True only for the call that deleted it, so two jobs finishing at once put the work back once. */
export async function clearClaudeSignedOut(): Promise<boolean> {
    const { rowCount } = await pool.query('DELETE FROM app_settings WHERE key = $1', [APP_SETTING_KEYS.macClaudeSignedOutAt]);
    return (rowCount ?? 0) > 0;
}

/** A Claude job failed (`studio/jobs.ts` `failJob`, after its commit). A sign-in failure sets the flag. Never throws. */
export async function noteMacJobFailed(kind: StudioJobKind, payload: unknown, error: string | null | undefined): Promise<void> {
    try {
        if (!isMacBrainJob(kind, payload) || !isSignInFailure(error)) return;
        const first = await markClaudeSignedOut();
        log(first ? 'warn' : 'info', 'mac.claude_signed_out', { kind, first });
    } catch (err) {
        log('error', 'mac.signed_out_mark_failed', { kind, ...describeError(err) });
    }
}

/**
 * A Claude job succeeded (`completeJob`, after its commit; an already-done delivery does not count). If Claude was signed out it is not any more: the flag
 * goes and the work it blocked is put back. Never throws.
 */
export async function noteMacJobDone(kind: StudioJobKind, payload: unknown, deps?: RequeueDeps): Promise<void> {
    try {
        if (!isMacBrainJob(kind, payload) && !isProbe(kind, payload)) return;
        if (!(await clearClaudeSignedOut())) return;
        const back = await requeueSignInBlocked(deps);
        log('info', 'mac.claude_signed_in', { kind, ...back });
    } catch (err) {
        log('error', 'mac.signed_in_clear_failed', { kind, ...describeError(err) });
    }
}

// ─── Waiting, not trying ──────────────────────────────────────────────────────────────────────

/** True for the probe's own think: it is Claude work, answered by the same handler. */
function isProbe(kind: StudioJobKind, payload: unknown): boolean {
    return kind === 'monteur_think' && typeof payload === 'object' && payload !== null && (payload as { step?: unknown }).step === 'probe';
}

// ─── Putting the work back ────────────────────────────────────────────────────────────────────

export interface Requeued {
    infographics: number;
    proposals: number;
    explainers: number;
}

/** What puts one item back. The real ones are loaded when needed (this file is imported by the queue itself, which they import); a test passes its own. */
export interface RequeueDeps {
    rewriteInfographic(creatorId: string, id: string): Promise<unknown>;
    advanceProposal(creatorId: string, proposalId: string): Promise<void> | void;
    retryExplainer(creatorId: string, id: string): Promise<unknown>;
}

const realDeps: RequeueDeps = {
    async rewriteInfographic(creatorId, id) {
        const { rerenderInfographic } = await import('./infographics.js');
        return rerenderInfographic(creatorId, id, { rewrite: true });
    },
    async advanceProposal(creatorId, proposalId) {
        const { queueAdvance } = await import('../ads/proposals/advance.js');
        queueAdvance(creatorId, proposalId, 'sweep');
    },
    async retryExplainer(creatorId, id) {
        const { retryExplainer } = await import('../explainers/explainers.js');
        return retryExplainer(creatorId, id);
    },
};

/**
 * Claude is back: queue again what the sign-in stopped. The Monteur needs nothing (its think WAITED, and asks again by itself at once). Bounded to
 * `REQUEUE_LIMIT` per kind and `REQUEUE_MAX_AGE_DAYS` days, and idempotent: each item leaves the state that selects it as it is put back, so a second
 * call finds none, and an item the owner already retried or deleted is not touched.
 *
 *   infographics   `failed` with `SIGNED_OUT_MESSAGE` as the error: written again by Claude (`rerenderInfographic` with `rewrite`);
 *   proposals      `drafting` with a failed sign-in `ads_think` as the latest: advanced again, which queues a new job (`ads/proposals/service.ts`);
 *   explainers     `failed` at the write with a sign-in error: Retry (`retryExplainer`).
 *
 * One failing item is logged and does not stop the others.
 */
export async function requeueSignInBlocked(deps: RequeueDeps = realDeps): Promise<Requeued> {
    const out: Requeued = { infographics: 0, proposals: 0, explainers: 0 };

    const infographics = await queryRows<{ id: string; creator_id: string }>(
        `SELECT id, creator_id FROM infographics
          WHERE status = 'failed' AND error = $1 AND updated_at > NOW() - make_interval(days => $2)
          ORDER BY updated_at DESC LIMIT $3`,
        [SIGNED_OUT_MESSAGE, REQUEUE_MAX_AGE_DAYS, REQUEUE_LIMIT]
    );
    if (infographics.length > 0) {
        for (const row of infographics) {
            try {
                await deps.rewriteInfographic(row.creator_id, row.id);
                out.infographics += 1;
            } catch (err) {
                log('warn', 'mac.requeue_infographic_failed', { infographic_id: row.id, ...describeError(err) });
            }
        }
    }

    const proposals = await queryRows<{ creator_id: string; proposal_id: string; error: string | null }>(
        `SELECT DISTINCT ON (j.payload->>'proposalId') j.creator_id, j.payload->>'proposalId' AS proposal_id, j.error
           FROM studio_jobs j
           JOIN ads_proposals p ON p.id::text = j.payload->>'proposalId' AND p.creator_id = j.creator_id AND p.state = 'drafting'
          WHERE j.kind = 'ads_think' AND j.status = 'failed' AND j.created_at > NOW() - make_interval(days => $1)
          ORDER BY j.payload->>'proposalId', j.created_at DESC`,
        [REQUEUE_MAX_AGE_DAYS]
    );
    const blocked = proposals.filter((row) => isSignInFailure(row.error)).slice(0, REQUEUE_LIMIT);
    for (const row of blocked) {
        try {
            await deps.advanceProposal(row.creator_id, row.proposal_id);
            out.proposals += 1;
        } catch (err) {
            log('warn', 'mac.requeue_proposal_failed', { proposal_id: row.proposal_id, ...describeError(err) });
        }
    }

    const explainers = await queryRows<{ id: string; creator_id: string; error: string | null }>(
        `SELECT id, creator_id, error FROM explainers
          WHERE status = 'failed' AND failed_step = 'write' AND updated_at > NOW() - make_interval(days => $1)
          ORDER BY updated_at DESC LIMIT 50`,
        [REQUEUE_MAX_AGE_DAYS]
    );
    const stuck = explainers.filter((row) => isSignInFailure(row.error)).slice(0, REQUEUE_LIMIT);
    for (const row of stuck) {
        try {
            await deps.retryExplainer(row.creator_id, row.id);
            out.explainers += 1;
        } catch (err) {
            log('warn', 'mac.requeue_explainer_failed', { explainer_id: row.id, ...describeError(err) });
        }
    }
    return out;
}

// ─── The probe ────────────────────────────────────────────────────────────────────────────────

const PROBE_SYSTEM = 'You are a connectivity check. Answer with the JSON the schema asks for and nothing else.';
const PROBE_USER = 'Reply with {"ok": true}.';
const PROBE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

export type ProbeOutcome = 'queued' | 'not_signed_out' | 'recent' | 'no_owner';

/**
 * While Claude is signed out, ask it one tiny question every `SIGNED_OUT_PROBE_MINUTES` (a `monteur_think` that names step `probe`, so nothing reads
 * it as a Monteur request). Its success clears the flag; its failure changes nothing. Without this, a flag with no Claude work in the queue would stay
 * up after the owner signed in again, because nothing would succeed to clear it. At most one is ever open, and one per half hour however many drains run.
 */
export async function probeClaudeSignIn(now: Date = new Date()): Promise<ProbeOutcome> {
    if (!(await isClaudeSignedOut())) return 'not_signed_out';
    const owner = await getPlatformOwnerId();
    if (!owner) return 'no_owner';
    const recent = await queryOne<{ id: string }>(
        `SELECT id FROM studio_jobs
          WHERE creator_id = $1 AND kind = 'monteur_think' AND payload->>'step' = 'probe'
            AND (status IN ('pending', 'claimed') OR created_at > $2::timestamptz - make_interval(mins => $3))
          LIMIT 1`,
        [owner, now, SIGNED_OUT_PROBE_MINUTES]
    );
    if (recent) return 'recent';
    const bucket = Math.floor(now.getTime() / (SIGNED_OUT_PROBE_MINUTES * 60_000));
    const payload: MonteurThinkPayload = {
        request: `mac-probe/${bucket}`, try: 1, step: 'probe', purpose: 'mac.signin_probe', model: 'claude-opus-5-5',
        system: PROBE_SYSTEM, user: PROBE_USER, schema: PROBE_SCHEMA,
    };
    await pool.query(
        `INSERT INTO studio_jobs (creator_id, kind, payload) VALUES ($1, 'monteur_think', $2::jsonb) ON CONFLICT DO NOTHING`,
        [owner, JSON.stringify(payload)]
    );
    log('info', 'mac.signin_probe_queued', { creator_id: owner });
    return 'queued';
}

// ─── The email ────────────────────────────────────────────────────────────────────────────────

export type MacProblem = 'signed_out' | 'worker_offline';

const ALERT_KEY: Record<MacProblem, AppSettingKey> = {
    signed_out: APP_SETTING_KEYS.macAlertedSignedOut,
    worker_offline: APP_SETTING_KEYS.macAlertedOffline,
};

/** The words, in Arabic then English, in one email: the owner reads whichever he likes. Nothing in them comes from a job or a customer. */
export function macAlertText(problem: MacProblem, helpUrl: string): { subject: string; text: string } {
    if (problem === 'signed_out') {
        return {
            subject: 'AutoReply Pro: Claude غير مسجَّل الدخول على الماك / Claude is signed out on the Mac',
            text: [
                'Claude على جهاز الماك مسجَّل الخروج، فلا يستطيع الاستوديو كتابة أي شيء الآن. أعمال المونتور تنتظر ولن تُحوَّل إلى نموذج آخر.',
                'الحل: على الماك افتح الطرفية (Terminal) ونفّذ `claude /login`، ثم أعد تشغيل عامل الاستوديو إن لزم. بعد أول إجابة ناجحة يستأنف العمل وحده.',
                '',
                'Claude on the Mac is signed out, so the Studio cannot write anything right now. The Monteur is waiting; it will not switch to another model.',
                'Fix: on the Mac open Terminal and run `claude /login`, then restart the Studio worker if needed. After the first answer that works, everything goes on by itself.',
                '',
                helpUrl,
            ].join('\n'),
        };
    }
    return {
        subject: 'AutoReply Pro: عامل الاستوديو متوقف على الماك / The Studio worker is offline',
        text: [
            'عامل الاستوديو على الماك لم يتصل منذ مدة، وفي الاستوديو أعمال تنتظره. غالبًا الجهاز في وضع السكون أو أن العامل توقف.',
            'الحل: أيقظ الماك، أو أعد تشغيل العامل. تبقى الأعمال في الطابور ولا يضيع منها شيء.',
            '',
            'The Studio worker on the Mac has not called in for a while, and work is waiting for it. The Mac is probably asleep, or the worker stopped.',
            'Fix: wake the Mac, or restart the worker. The jobs stay queued and nothing is lost.',
            '',
            helpUrl,
        ].join('\n'),
    };
}

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Take today's turn for a problem: true for exactly one caller a day (one statement: the row is written only when it holds another day), so two drains
 * in the same instant send one email. Hand it back with `releaseTurn` when nothing could be sent, so the next drain tries again.
 */
export async function takeTurn(problem: MacProblem, now: Date): Promise<{ taken: boolean; previous: string | null }> {
    const key = ALERT_KEY[problem];
    const previous = await getSetting(key);
    const day = utcDay(now);
    if (previous === day) return { taken: false, previous };
    const { rowCount } = await pool.query(
        `INSERT INTO app_settings (key, value, is_secret, updated_at, updated_by)
         VALUES ($1, $2, FALSE, NOW(), NULL)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
           WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value`,
        [key, day]
    );
    return { taken: (rowCount ?? 0) > 0, previous };
}

async function releaseTurn(problem: MacProblem, previous: string | null): Promise<void> {
    await setSetting(ALERT_KEY[problem], previous, null);
}

/** Email (and Telegram, if the deployment's bot is on) the owner. True when at least one channel took it. */
async function tell(problem: MacProblem, helpUrl: string): Promise<boolean> {
    const { subject, text } = macAlertText(problem, helpUrl);
    const channels = await readNotifyChannels();
    let sent = false;
    const tg = channels.telegram;
    if (telegramReady(tg)) {
        const r = await sendTelegramMessage({ token: tg.token, chatId: tg.chatId }, `${subject}\n\n${text}`);
        sent = sent || r.ok;
        if (!r.ok) log('warn', 'mac.alert_telegram_failed', { problem, reason: r.reason, status: r.status });
    }
    const to = effectiveTo(channels.email);
    if (emailReady(channels.email) && to) {
        const r = await sendEmail({ apiKey: channels.email.apiKey, to, from: channels.email.from }, { subject, text });
        sent = sent || r.ok;
        if (!r.ok) log('warn', 'mac.alert_email_failed', { problem, reason: r.reason, status: r.status });
    }
    return sent;
}

/** Tell the owner about one problem, once a day. A day on which nothing could be sent is not used up. Never throws. */
export async function alertOnce(problem: MacProblem, now: Date, helpUrl: string): Promise<boolean> {
    try {
        const turn = await takeTurn(problem, now);
        if (!turn.taken) return false;
        const sent = await tell(problem, helpUrl);
        log('warn', 'mac.alerted', { problem, sent });
        if (!sent) await releaseTurn(problem, turn.previous);
        return sent;
    } catch (err) {
        log('error', 'mac.alert_failed', { problem, ...describeError(err) });
        return false;
    }
}

export interface MacAlarmResult {
    probe: ProbeOutcome | 'error';
    alerted: MacProblem[];
}

/** Where the email sends the owner: the Studio page of the dashboard's help. The base is the app's public address, or just the path. */
export const MAC_HELP_PATH = '/dashboard#/help/worker';

/**
 * The drain's step (`GET /api/jobs/drain`): the probe, then the daily emails. `offline` answers whether the OWNER's worker is offline with work waiting (the
 * same rule as the attention item, passed in so this file does not read the attention queries). Cheap when all is well: one settings read.
 */
export async function checkMacAlarms(
    options: { now?: Date; baseUrl?: string | null; offline?: () => Promise<boolean> } = {}
): Promise<MacAlarmResult> {
    const now = options.now ?? new Date();
    const helpUrl = `${(options.baseUrl ?? '').replace(/\/+$/, '')}${MAC_HELP_PATH}`;
    const result: MacAlarmResult = { probe: 'not_signed_out', alerted: [] };
    try {
        const signedOut = await isClaudeSignedOut();
        if (signedOut) {
            try {
                result.probe = await probeClaudeSignIn(now);
            } catch (err) {
                result.probe = 'error';
                log('error', 'mac.signin_probe_failed', describeError(err));
            }
            if (await alertOnce('signed_out', now, helpUrl)) result.alerted.push('signed_out');
        }
        if (options.offline && (await options.offline())) {
            if (await alertOnce('worker_offline', now, helpUrl)) result.alerted.push('worker_offline');
        }
    } catch (err) {
        log('error', 'mac.alarms_failed', describeError(err));
    }
    return result;
}
