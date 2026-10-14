/**
 * The onboarding funnel's events (`onboarding_events`, v34; docs/onboarding/02 §6; plan P31).
 *
 * One row says that something happened to a tenant's setup, and nothing about what they typed:
 *
 *   - **A closed list of events.** A name that is not in `ONBOARDING_EVENTS` cannot be written, so a typo does not become a
 *     column of the funnel nobody reads.
 *   - **A closed list of props per event, each a number or a short enum word.** `sanitizeProps` keeps the keys an event is
 *     allowed and drops the rest, and it drops a value that is not a finite number or a `[a-z0-9_]` word. A name, an email, a
 *     URL or a sentence cannot be stored as a prop even by a caller that tries: the table is PII-free by construction, not
 *     by every caller remembering.
 *   - **Best-effort.** A database without v34, or a failed insert, is logged and the request that caused the event goes on.
 *     The funnel is not worth a failed Continue, a failed invite or a failed login.
 *
 * Who writes what:
 *
 *   invite_created   the operator made (or regenerated) a join link        admin   routes/admin.ts `issueInvite`
 *   invite_opened    the link was opened the FIRST time                    tenant  services/invites.ts `peekInvite`
 *   invite_accepted  the link was used                                     tenant  services/invites.ts `acceptInvite`
 *   step_viewed / step_completed / step_skipped / wizard_completed          services/onboardingWizard.ts (P18)
 *   draft_started / draft_ready / draft_failed   `recordDraftEvent`: the draft state machine (P24) calls it
 *   proof_verdict / proof_regenerated   the proof samples (P25): a tenant's (or an admin's) verdict on a card, and a card written again
 *
 * A reset link is not onboarding and writes nothing here: the funnel counts people getting in, not people changing a password.
 */
import { pool } from '../config/db.js';
import { describeError, log } from '../utils/log.js';

export const ONBOARDING_EVENTS = [
    'invite_created', 'invite_opened', 'invite_accepted',
    'step_viewed', 'step_completed', 'step_skipped',
    'draft_started', 'draft_ready', 'draft_failed',
    'proof_verdict', 'proof_regenerated',
    'wizard_completed',
] as const;
export type OnboardingEvent = (typeof ONBOARDING_EVENTS)[number];

export type Actor = 'tenant' | 'admin';

export interface EventContext {
    creatorId: string;
    userId: string | null;
    actor: Actor;
}

/** The step an event is about: a wizard step id. Kept as plain text so this file does not import the wizard that imports it. */
export type EventStep = string | null;

/**
 * The props each event may carry. `n` is a number (milliseconds, or a count), `word` a short enum word. Everything else is dropped.
 * Adding a prop is a decision made here, where the next reader of "what do we keep" looks.
 */
type PropKind = 'n' | 'word';
export const EVENT_PROPS: Readonly<Record<OnboardingEvent, Readonly<Record<string, PropKind>>>> = Object.freeze({
    invite_created: {},
    invite_opened: { ms_since_created: 'n' },
    invite_accepted: { ms_since_created: 'n' },
    step_viewed: {},
    step_completed: { ms_on_step: 'n' },
    step_skipped: {},
    draft_started: { origin: 'word' },
    draft_ready: { ms: 'n', partial: 'n' },
    draft_failed: { ms: 'n', code: 'word' },
    // `kind` is the card (caption, comment), `verdict` approved/edited/rejected, `reason` the first chip the person chose (too_formal…).
    proof_verdict: { kind: 'word', verdict: 'word', reason: 'word' },
    proof_regenerated: { kind: 'word', attempt: 'n' },
    wizard_completed: { by: 'word', total_ms: 'n' },
});

const WORD = /^[a-z0-9_]{1,32}$/;
const MAX_NUMBER = 1e12;

/**
 * The props that may be stored: the event's own keys, each a finite non-negative number (rounded) or a `[a-z0-9_]` word of at most
 * 32 characters. A key the event does not list, or a value of the wrong kind, is dropped, never coerced.
 */
export function sanitizeProps(event: OnboardingEvent, props: Record<string, unknown> | undefined): Record<string, number | string> {
    const allowed = EVENT_PROPS[event];
    const out: Record<string, number | string> = {};
    if (!allowed || !props) return out;
    for (const [key, kind] of Object.entries(allowed)) {
        const value = props[key];
        if (kind === 'n' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER) out[key] = Math.round(value);
        else if (kind === 'word' && typeof value === 'string' && WORD.test(value)) out[key] = value;
    }
    return out;
}

export function isOnboardingEvent(value: unknown): value is OnboardingEvent {
    return typeof value === 'string' && (ONBOARDING_EVENTS as readonly string[]).includes(value);
}

/**
 * One funnel row. Never throws. The statement is one line, with the columns in this order, because the stand-in database the wizard's
 * tests use recognises it by shape (`wizard/testDb.ts`).
 */
export async function recordEvent(ctx: EventContext, event: OnboardingEvent, step: EventStep = null, props: Record<string, unknown> = {}): Promise<void> {
    if (!isOnboardingEvent(event)) {
        log('warn', 'onboarding.event_unknown', { wizard_event: String(event).slice(0, 40) });
        return;
    }
    try {
        await pool.query(
            'INSERT INTO onboarding_events (creator_id, user_id, actor, event, step, props) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
            [ctx.creatorId, ctx.userId, ctx.actor, event, step, JSON.stringify(sanitizeProps(event, props))]
        );
    } catch (err) {
        // Not `event:` — that key is the log line's own name.
        log('warn', 'onboarding.event_failed', { wizard_event: event, step, tenant_id: ctx.creatorId, ...describeError(err) });
    }
}

/** How long ago a link was made, kept to a sensible range (a link opened a week after it was made is "a week", not an overflow). */
export function msSince(created: Date | string | null | undefined, now: number = Date.now()): number | null {
    if (!created) return null;
    const then = created instanceof Date ? created.getTime() : Date.parse(created);
    if (Number.isNaN(then)) return null;
    return Math.max(0, now - then);
}

export type DraftOutcome = 'started' | 'ready' | 'failed';

/**
 * The draft state machine's three moments (P24): the draft began, it is ready for the tenant to confirm, or it failed for good.
 * `code` is the failure's enum kind (`error_kind`, `no_provider`, `timeout`…) and never the provider's words or any text that was
 * fetched; `origin` is who asked (`admin_create`, `wizard`, `redraft`). A value that is not an enum word is dropped by `sanitizeProps`.
 */
export function recordDraftEvent(
    ctx: EventContext, outcome: DraftOutcome, details: { ms?: number; code?: string; origin?: string; partial?: boolean } = {}
): Promise<void> {
    const props: Record<string, unknown> = { ms: details.ms, code: details.code, origin: details.origin, partial: details.partial === undefined ? undefined : details.partial ? 1 : 0 };
    return recordEvent(ctx, `draft_${outcome}` as OnboardingEvent, null, props);
}
