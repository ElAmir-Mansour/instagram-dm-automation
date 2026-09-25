/**
 * The audit trail for privileged actions.
 *
 * Before this, nothing recorded who changed what. Every admin mutation was a bare UPDATE from
 * a session that on this deployment is usually the shared `DASHBOARD_PASSWORD` — so "who
 * deactivated that tenant on Tuesday" had no answer anywhere, and the one irreversible action
 * in the product (data-subject erasure) was performed by hand in the SQL editor leaving no
 * trace at all.
 *
 * Two rules the writers here enforce:
 *
 *   1. **An audit write can never fail the action it is recording.** A failed INSERT is logged
 *      and swallowed. The alternative — 500ing a tenant update because the ledger table is
 *      missing — makes the whole admin surface depend on migration v15 having been applied,
 *      and an operator who cannot deactivate a tenant is worse off than one whose change went
 *      unrecorded. `written` in the return value says which happened.
 *
 *   2. **`detail` never holds a secret.** Callers pass the *names* of the fields they changed
 *      and the non-sensitive values. There is a redaction pass here as a backstop, keyed the
 *      same way `src/utils/log.ts` redacts, because a backstop is what catches the caller
 *      nobody reviewed.
 */
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { clampLimit } from './adminGuards.js';

/**
 * Who did it.
 *
 * `userId` is null for a legacy shared-password session, which is the only kind that exists on
 * this deployment today (the `users` table is empty). That is not a gap to paper over: the
 * honest record is "somebody holding the dashboard password", and `LEGACY_ACTOR_EMAIL` says so
 * in the column an operator reads rather than leaving it blank and ambiguous.
 */
export interface AuditActor {
    userId: string | null;
    email: string | null;
}

/** Recorded in `actor_email` when the session carries no user identity at all. */
export const LEGACY_ACTOR_EMAIL = 'legacy:dashboard-password';

/** Anything a session can be, narrowed to what identifies the actor. */
export interface ActorSession {
    userId?: string | null;
    role?: string;
}

/**
 * The actor for a request.
 *
 * `email` is looked up rather than carried in the token, because the session payload has no
 * room for it and a stale email in an audit row is worse than a fresh one — this runs once per
 * mutating admin action, not on a hot path.
 */
export async function actorFromSession(session: ActorSession | undefined): Promise<AuditActor> {
    const userId = session?.userId ?? null;
    if (!userId) return { userId: null, email: LEGACY_ACTOR_EMAIL };

    try {
        const rows = await queryRows<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
        return { userId, email: rows[0]?.email ?? null };
    } catch (err) {
        // Same reasoning as a failed audit write: never fail the action over bookkeeping.
        log('warn', 'audit.actor_lookup_failed', describeError(err));
        return { userId, email: null };
    }
}

export interface AuditEntry {
    /** Dotted, lowercase, machine-stable. See AUDIT_ACTIONS. */
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown> | null;
}

/**
 * Every action name this codebase writes.
 *
 * A const object rather than free strings so that a typo is a compile error and so that the
 * `action` filter on `GET /api/admin/audit` has something to validate against. Renaming one
 * of these silently breaks whatever filter an operator saved, which is the same failure mode
 * `src/utils/log.ts` names for log events.
 */
export const AUDIT_ACTIONS = {
    tenantCreate: 'tenant.create',
    tenantUpdate: 'tenant.update',
    tenantTokenWrite: 'tenant.token_write',
    tenantTokenRecheck: 'tenant.token_recheck',
    userCreate: 'user.create',
    userUpdate: 'user.update',
    userPasswordSet: 'user.password_set',
    userPasswordChange: 'user.password_change',
    userSessionsRevoke: 'user.sessions_revoke',
    membershipGrant: 'membership.grant',
    membershipRevoke: 'membership.revoke',
    jobRetry: 'job.retry',
    jobCancel: 'job.cancel',
    erasureExecute: 'erasure.execute',
    settingsTokenWrite: 'settings.token_write',
    settingsTokenExtend: 'settings.token_extend',
    settingsTokenRecheck: 'settings.token_recheck',
    settingsWebhookTokenWrite: 'settings.webhook_token_write',
    tiktokConnect: 'tiktok.connect',
    tiktokDisconnect: 'tiktok.disconnect',
    settingsTikTokAppWrite: 'settings.tiktok_app_write',
    /** A Studio worker credential was minted. Its token acts as the tenant for claims and uploads. */
    studioWorkerCreate: 'studio.worker_create',
    /** A Studio worker credential was revoked; its token stopped working at that moment. */
    studioWorkerRevoke: 'studio.worker_revoke',
    /** Brand, voice, product, CTA, schedule or library settings changed. */
    studioSettingsWrite: 'studio.settings_write',
    /** A Studio draft became scheduled posts (and possibly a campaign). */
    studioSchedule: 'studio.schedule',
    /** The queued TikTok carousels went out as a batch of rows due now. */
    studioTikTokBatch: 'studio.tiktok_batch',
    /** Growth keywords, hashtag sets, competitors or audience changed (GROWTH.md). */
    growthSettingsWrite: 'growth.settings_write',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

const KNOWN_ACTIONS: ReadonlySet<string> = new Set(Object.values(AUDIT_ACTIONS));

export function isAuditAction(value: unknown): value is AuditAction {
    return typeof value === 'string' && KNOWN_ACTIONS.has(value);
}

/**
 * Keys whose values must never reach the ledger, matched case-insensitively on the key name.
 *
 * Deliberately the same pattern as `REDACT_KEY` in src/utils/log.ts. `detail` is JSONB and is
 * read back by an admin endpoint, so a token that landed here would be both persisted and
 * served — strictly worse than one in a log line.
 */
const REDACT_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|signature|cookie)/i;
const REDACTED = '[redacted]';

/**
 * Strip anything secret-shaped out of a detail object.
 *
 * Shallow on purpose: audit details are flat by convention, and a recursive walk would invite
 * callers to pass whole request bodies — which is exactly how a token ends up in here.
 * Exported so the redaction rule itself is testable.
 *
 * The pattern cannot tell a fact about a secret from the secret itself: `token_status:
 * "invalid"` and `token: "EAAG..."` both match, and it blanks both. That is the safe
 * direction to be wrong in, so the pattern stays broad and the callers adapt — the convention
 * is to name a non-secret fact without the trigger word:
 *
 *     token_status  ->  result_status
 *     token_type    ->  credential_type
 *     (a token was written)  ->  credential_replaced: true
 *
 * This is not cosmetic. A `tenant.token_recheck` row whose only interesting fields were
 * `[redacted]` recorded that somebody pressed the button and nothing about what came back,
 * which is the half an operator actually needs.
 */
export function redactDetail(
    detail: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
    if (!detail) return null;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail)) {
        if (value === undefined) continue;
        out[key] = REDACT_KEY.test(key) ? REDACTED : value;
    }
    return out;
}

/** Just enough of `pg`'s surface to accept either the pool or a client inside a transaction. */
export interface AuditExecutor {
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<{ id: string }> }>;
}

export interface AuditResult {
    /** False when the row could not be written — the action still happened. */
    written: boolean;
    id: string | null;
}

/**
 * Record one action. Never throws.
 *
 * `exec` takes a `PoolClient` when the action is itself transactional — erasure writes its
 * audit row inside the same transaction as the deletes, so there is no window in which rows
 * are gone and nothing says who removed them.
 */
export async function writeAudit(
    actor: AuditActor,
    entry: AuditEntry,
    exec: AuditExecutor | PoolClient = pool as unknown as AuditExecutor
): Promise<AuditResult> {
    try {
        const result = await exec.query(
            `INSERT INTO audit_log (actor_user_id, actor_email, action, target_type, target_id, detail)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING id`,
            [
                actor.userId,
                actor.email,
                entry.action,
                entry.targetType ?? null,
                entry.targetId ?? null,
                JSON.stringify(redactDetail(entry.detail) ?? {}),
            ]
        );

        // Mirrors the action name into the log stream as well, so an alert can fire on a
        // privileged action without polling the table.
        log('info', 'audit.recorded', {
            audit_action: entry.action,
            target_type: entry.targetType ?? null,
            target_id: entry.targetId ?? null,
            actor_user_id: actor.userId,
        });

        return { written: true, id: result.rows[0]?.id ?? null };
    } catch (err) {
        // Never rethrow. The caller has already performed the action; failing here would
        // report a completed change as an error and invite the operator to repeat it.
        log('error', 'audit.write_failed', { audit_action: entry.action, ...describeError(err) });
        return { written: false, id: null };
    }
}

/** Newest first, bounded. */
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

/** Clamp a caller-supplied limit. See `clampLimit` for why "absent" is decided first. */
export function clampAuditLimit(raw: unknown): number {
    return clampLimit(raw, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
}

export interface AuditRow {
    id: string;
    actor_user_id: string | null;
    actor_email: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    detail: Record<string, unknown> | null;
    created_at: Date;
}

/** Postgres `undefined_table` — migration v15 has not been applied. */
export const PG_UNDEFINED_TABLE = '42P01';

export interface AuditListing {
    entries: AuditRow[];
    /**
     * True when the `audit_log` table does not exist. The dashboard needs to distinguish
     * "nothing has happened yet" from "the ledger is not there", because the second is a
     * deploy step and the first is not — and an empty array says the same thing for both.
     */
    migrationPending: boolean;
}

export async function listAudit(limit: number, action: string | null): Promise<AuditListing> {
    try {
        const entries = await queryRows<AuditRow>(
            `SELECT id, actor_user_id, actor_email, action, target_type, target_id, detail, created_at
               FROM audit_log
              WHERE ($2::text IS NULL OR action = $2)
              ORDER BY created_at DESC, id DESC
              LIMIT $1`,
            [limit, action]
        );
        return { entries, migrationPending: false };
    } catch (err: any) {
        if (err?.code === PG_UNDEFINED_TABLE) {
            return { entries: [], migrationPending: true };
        }
        throw err;
    }
}
