/**
 * The paced write queue (research R3, R5, R6; data-model `ads_ops`; tasks T049). Every write to Meta's Marketing API is one `ads_ops` row,
 * so one place enforces the limits Meta enforces per object and one place makes sure a create is never made twice.
 *
 *   enqueue            INSERT ... ON CONFLICT (idempotency_key) DO NOTHING: a retried request returns the op it already made.
 *   claimNext          ONE short transaction: the oldest due `pending` op becomes `running`. Per object the order is the order of creation and
 *                      only one op runs (or is being verified) at a time; the per-object limits (4 budget edits an hour per ad set, 30 s
 *                      between edits of one object, 10 spend-cap changes a day) push `not_before` instead of starting the op.
 *   execute            calls Meta OUTSIDE any transaction (the pooler would hold a connection and a row lock for up to 40 s of Graph retries),
 *                      then records the outcome in a second short transaction.
 *   verify             a create that timed out may have landed: it is searched for by the tag in its name before anything is sent again.
 *   reap               a `running` op that nobody finished (the instance was frozen or killed) is moved on after 5 minutes.
 *   drainAdsOps        what `GET /api/jobs/drain` runs: reap, then every account with something due, until the deadline.
 *
 * The state machine is plain functions (`limitWaitUntil`, `outcomeFor`, `nextVerifyStep`) so it is tested without a database. The Graph
 * calls go through one function, `sendExec`, and through the `deps` object every function takes, so a test stubs Meta without touching the
 * network.
 *
 * Every statement on an `ads_*` table names `creator_id` (a tenant's rows are only ever read or written under that tenant). The two that
 * cannot name one tenant, the reaper and the "who has something due" list, are maintenance over every tenant and return `creator_id`.
 */
import type { QueryResultRow } from 'pg';
import { queryOne, queryRows } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { waitUntil } from '../../utils/waitUntil.js';
import { LEGACY_ACTOR_EMAIL, writeAudit, type AuditActor, type AuditExecutor } from '../audit.js';
import { isQueueStopped, readAdsSettings, readHealth } from './settings.js';
import { fromMinorUnits } from './metaAds.js';
import { UUID_PATTERN, withTransaction, type Exec } from '../studio/common.js';
import { adsDelete, adsGet, adsPost, AdsGraphError, withAdsContext, type AdsCallOptions, type GraphParams } from './graph.js';
import { mayHaveLanded } from './money.js';
import { status as pacerStatus } from './pacer.js';

// ─── Types ──────────────────────────────────────────────────────────────────────────────────

/** The v53 CHECK list. */
export const ADS_OP_KINDS = ['create', 'update', 'status', 'budget', 'archive', 'delete', 'spend_cap', 'audience_create', 'audience_users', 'lead_form', 'study'] as const;
export type AdsOpKind = (typeof ADS_OP_KINDS)[number];
export type AdsOpState = 'pending' | 'running' | 'verify' | 'done' | 'failed' | 'cancelled';

export interface OpActor {
    userId: string | null;
    role?: string | null;
    via: 'owner' | 'rule' | 'proposal' | 'guard';
}

/**
 * The Graph call an op makes. `path` is `<metaId>` or `act_<id>/<edge>`; `{dep}` in it is replaced, when the op runs, by the `result.id`
 * of the op it depends on (an audience's users are added to the audience another op created). `edge` marks a create: its name gets the
 * `AR·<op id>` tag and it is verified by that tag if it times out.
 */
export interface OpExecSpec {
    method: 'POST' | 'DELETE';
    path: string;
    params?: GraphParams;
    edge?: 'campaigns' | 'adsets' | 'ads' | 'adcreatives' | 'customaudiences';
    level?: 'campaign' | 'adset' | 'ad' | 'creative';
}

export interface OpPayload {
    exec?: OpExecSpec;
    /** A1's money rule: what this op adds to the month's worst case until it is done. Kept as it is. */
    worst_case_delta?: number;
    /** Budget ops: the ad set the 4-per-hour rule counts against. */
    adsetMetaId?: string;
    /** The ad account's IANA zone: the day a spend-cap change is counted in. */
    tz?: string;
    /** `exec.params` holds data that must not outlive the call (hashed contacts): emptied in the statement that records the end of the op. */
    scrub?: boolean;
    [key: string]: unknown;
}

export interface EnqueueInput {
    creatorId: string;
    adAccountId: string;
    objectKey: string;
    kind: AdsOpKind;
    payload: OpPayload;
    idempotencyKey: string;
    dependsOn?: string | null;
    notBefore?: Date;
    actor: OpActor;
    proposalId?: string | null;
}

/** A row of `ads_ops`, in camelCase. */
export interface Op {
    id: string;
    creatorId: string;
    adAccountId: string;
    objectKey: string;
    kind: AdsOpKind;
    payload: OpPayload;
    idempotencyKey: string | null;
    dependsOn: string | null;
    state: AdsOpState;
    notBefore: Date;
    attempts: number;
    result: Record<string, unknown> | null;
    actor: OpActor;
    proposalId: string | null;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
}

export interface OpView {
    id: string;
    kind: AdsOpKind;
    state: AdsOpState;
    objectKey: string;
    notBefore: string;
    attempts: number;
    result: Record<string, unknown> | null;
    createdAt: string;
    finishedAt: string | null;
    actorVia: OpActor['via'];
}

/** What one Graph call (or one verification step) means for the op. */
export interface OpOutcome {
    state: 'done' | 'failed' | 'verify' | 'pending';
    /** The next time the op may be looked at; null leaves it as it is. */
    notBefore: Date | null;
    result: Record<string, unknown> | null;
    /** `token_dead`: the tenant's loop stops for this run. `throttle`: Meta blocked the account, nothing more is sent to it this run. */
    stop?: 'token_dead' | 'throttle';
}

// ─── The limits ─────────────────────────────────────────────────────────────────────────────

export const BUDGET_EDITS_PER_HOUR = 4;
export const OBJECT_GAP_MS = 30_000;
export const SPEND_CAP_EDITS_PER_DAY = 10;
export const RUNNING_STALE_MS = 5 * 60_000;
export const VERIFY_RECHECK_MS = 60_000;
export const VERIFY_GIVE_UP_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const DEFAULT_THROTTLE_MS = 300_000;
/** How much of the invocation is kept back for recording the last outcome and returning. */
const DEADLINE_MARGIN_MS = 3_000;
const MAX_STEPS_PER_ACCOUNT = 100;
const HISTORY_WINDOW_MS = 48 * HOUR_MS;

/** A finished (`done`) op, all `limitWaitUntil` needs to know about the history. `adsetKey` is `payload.adsetMetaId`. */
export interface DoneRecord {
    kind: string;
    objectKey: string;
    adsetKey: string | null;
    finishedAt: Date;
}

/** A valid IANA zone, else UTC (an account with an unreadable zone still gets a day boundary rather than a crash). */
function safeTz(tz: unknown): string {
    if (typeof tz !== 'string' || !tz) return 'UTC';
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return tz;
    } catch {
        return 'UTC';
    }
}

function localParts(tz: string, at: Date): { day: string; secs: number } {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
    return { day: `${get('year')}-${get('month')}-${get('day')}`, secs: Number(get('hour')) * 3600 + Number(get('minute')) * 60 + Number(get('second')) };
}

/** The calendar day of `at` in `tz`, as `YYYY-MM-DD`. */
export function dayKeyIn(tz: string, at: Date): string {
    return localParts(safeTz(tz), at).day;
}

/** The start of the next calendar day in `tz`: when a daily limit is lifted. Corrected once for a clock change falling in between. */
export function nextMidnightIn(tz: string, now: Date): Date {
    const zone = safeTz(tz);
    const { secs } = localParts(zone, now);
    let guess = Math.floor(now.getTime() / 1000) * 1000 + (86_400 - secs) * 1000;
    const check = localParts(zone, new Date(guess)).secs;
    if (check !== 0) guess += check < 43_200 ? -check * 1000 : (86_400 - check) * 1000;
    return new Date(guess);
}

/**
 * When may `op` run, given what already finished? Null: now. Meta refuses a fifth budget change of one ad set in an hour (613/1487632), a
 * second edit of one object within 30 s (613/4841018) and an eleventh spend-cap change in a day (17/1885172); waiting is free and being
 * refused is not (it spends points and some of them extend a block), so the queue waits for the time itself.
 */
export function limitWaitUntil(op: Pick<Op, 'kind' | 'objectKey' | 'payload'>, history: readonly DoneRecord[], now: Date): Date | null {
    const nowMs = now.getTime();
    let wait = 0;

    const lastOnObject = history.filter((h) => h.objectKey === op.objectKey).reduce((max, h) => Math.max(max, h.finishedAt.getTime()), 0);
    if (lastOnObject > 0) wait = Math.max(wait, lastOnObject + OBJECT_GAP_MS);

    if (op.kind === 'budget') {
        const key = op.payload.adsetMetaId ?? op.objectKey;
        const recent = history
            .filter((h) => h.kind === 'budget' && (h.adsetKey ?? h.objectKey) === key && h.finishedAt.getTime() > nowMs - HOUR_MS)
            .sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime());
        // The window rolls: once enough of the oldest have aged out, fewer than four remain.
        if (recent.length >= BUDGET_EDITS_PER_HOUR) wait = Math.max(wait, recent[recent.length - BUDGET_EDITS_PER_HOUR]!.finishedAt.getTime() + HOUR_MS);
    }

    if (op.kind === 'spend_cap') {
        const tz = safeTz(op.payload.tz);
        const today = dayKeyIn(tz, now);
        const used = history.filter((h) => h.kind === 'spend_cap' && dayKeyIn(tz, h.finishedAt) === today).length;
        if (used >= SPEND_CAP_EDITS_PER_DAY) wait = Math.max(wait, nextMidnightIn(tz, now).getTime());
    }

    return wait > nowMs ? new Date(wait) : null;
}

// ─── Pure: outcomes ─────────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The edge a create posts to: `exec.edge`, or the audiences edge for an `audience_create`. Null for any other op. */
function edgeOf(op: Pick<Op, 'kind' | 'payload'>): string | null {
    const exec = op.payload.exec;
    if (!exec || exec.method !== 'POST') return null;
    return exec.edge ?? (op.kind === 'audience_create' ? 'customaudiences' : null);
}

/**
 * Whether `op` creates an object at Meta: it carries the tag, is sent under the `creates` rule of http.ts and, if it timed out, is looked
 * for before it is ever sent again. A create without an edge (a `copies` call) is an ordinary write here.
 */
export function isCreateOp(op: Pick<Op, 'kind' | 'payload'>): boolean {
    return edgeOf(op) !== null;
}

function tagOf(opId: string): string {
    return `AR·${opId}`;
}

function failure(err: unknown): Record<string, unknown> {
    const e = err as { metaCode?: unknown; metaSubcode?: unknown; fbtraceId?: unknown; message?: unknown };
    return {
        code: typeof e?.metaCode === 'number' ? e.metaCode : null,
        subcode: typeof e?.metaSubcode === 'number' ? e.metaSubcode : null,
        message: String(e?.message ?? 'The call failed.').slice(0, 500),
        fbtrace_id: typeof e?.fbtraceId === 'string' ? e.fbtraceId : null,
    };
}

/**
 * What one Graph call means for the op (contracts/meta-graph.md "Errors handled specially"). Never a retry: a throttle goes back to
 * `pending` at the time Meta named, because the pacer already blocked the account until then and calling again only lengthens the block.
 */
export function outcomeFor(
    op: Pick<Op, 'id' | 'kind' | 'payload' | 'result'>,
    attempt: { ok: true; data: unknown } | { ok: false; error: unknown },
    now: Date,
): OpOutcome {
    const prior = op.result ?? {};
    if (attempt.ok) {
        const data = isObject(attempt.data) ? attempt.data : {};
        return { state: 'done', notBefore: null, result: { ...(prior['resent'] ? { resent: true } : {}), ...data } };
    }
    const err = attempt.error;
    if (err instanceof AdsGraphError) {
        switch (err.klass) {
            case 'throttle': {
                const until = err.retryAt ?? new Date(now.getTime() + DEFAULT_THROTTLE_MS);
                return { state: 'pending', notBefore: until, result: { ...prior, deferred: { reason: 'throttle', until: until.toISOString() } }, stop: 'throttle' };
            }
            case 'budget_limit': {
                const until = new Date(now.getTime() + HOUR_MS);
                return { state: 'pending', notBefore: until, result: { ...prior, deferred: { reason: 'budget_limit', until: until.toISOString() } } };
            }
            case 'object_busy': {
                const until = new Date(now.getTime() + OBJECT_GAP_MS);
                return { state: 'pending', notBefore: until, result: { ...prior, deferred: { reason: 'object_busy', until: until.toISOString() } } };
            }
            case 'spend_cap_limit': {
                const retryAt = nextMidnightIn(safeTz(op.payload.tz), now);
                return { state: 'failed', notBefore: null, result: { ...failure(err), code: 'EDIT_LIMIT', retryAt: retryAt.toISOString() } };
            }
            case 'token_dead':
                return { state: 'failed', notBefore: null, result: { ...failure(err), code: 'TOKEN_INVALID' }, stop: 'token_dead' };
            default:
                break;
        }
        // No answer at all, or a 5xx: Meta may have done it. A create is searched for by its tag; any other write is read back.
        if (mayHaveLanded(err)) {
            return { state: 'verify', notBefore: now, result: { ...prior, ...(isCreateOp(op) ? { verifyChecks: [] } : {}), cause: { message: String(err.message).slice(0, 200) } } };
        }
    }
    return { state: 'failed', notBefore: null, result: failure(err) };
}

/**
 * The next step of an op in `verify`. `found` is the id the tag search returned (a create), or whether the object read back matches what
 * was meant (any other write); null / false when not.
 *
 *   create       found → done (the id adopted). Not found: the first look waits 60 s; a second look at least 60 s after it queues the op
 *                again with resent=true, so it is sent exactly once more with the same tag; once resent, the same two looks fail it.
 *   other write  matches → done; else sent once more (pending, resent), and failed if it is still wrong afterwards.
 *   no exec      written by A1's synchronous path: never executed here and never resolved: it stays until a day old, then fails `abandoned`.
 */
export function nextVerifyStep(op: Pick<Op, 'kind' | 'payload' | 'result' | 'startedAt' | 'createdAt'>, found: string | boolean | null, now: Date): OpOutcome {
    const prior = op.result ?? {};
    const resent = prior['resent'] === true;
    const age = now.getTime() - (op.startedAt ?? op.createdAt).getTime();

    if (!op.payload.exec) {
        if (age >= VERIFY_GIVE_UP_MS) return { state: 'failed', notBefore: null, result: { ...prior, reason: 'abandoned' } };
        return { state: 'verify', notBefore: new Date(now.getTime() + HOUR_MS), result: op.result };
    }

    const hit = found !== null && found !== false;
    if (!isCreateOp(op)) {
        if (hit) return { state: 'done', notBefore: null, result: { ...(resent ? { resent: true } : {}), verified: true } };
        if (!resent) return { state: 'pending', notBefore: now, result: { ...prior, resent: true } };
        return { state: 'failed', notBefore: null, result: { ...prior, code: 'NOT_APPLIED', message: 'Meta still does not show the change after it was sent twice.' } };
    }

    if (hit) return { state: 'done', notBefore: null, result: { ...(resent ? { resent: true } : {}), id: typeof found === 'string' ? found : null, adopted: true } };

    const checks = Array.isArray(prior['verifyChecks']) ? (prior['verifyChecks'] as string[]) : [];
    if (checks.length === 0) return { state: 'verify', notBefore: new Date(now.getTime() + VERIFY_RECHECK_MS), result: { ...prior, verifyChecks: [now.toISOString()] } };
    const firstAt = Date.parse(checks[0]!);
    if (now.getTime() - firstAt < VERIFY_RECHECK_MS) return { state: 'verify', notBefore: new Date(firstAt + VERIFY_RECHECK_MS), result: { ...prior, verifyChecks: checks } };
    // The second look, 60 s or more after the first, found nothing.
    if (!resent) return { state: 'pending', notBefore: now, result: { ...prior, verifyChecks: [], resent: true } };
    return { state: 'failed', notBefore: null, result: { ...prior, verifyChecks: [...checks, now.toISOString()], code: 'NOT_CREATED', message: 'Meta shows no such object after it was sent twice.' } };
}

// ─── Rows and views ─────────────────────────────────────────────────────────────────────────

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

function toOp(row: QueryResultRow): Op {
    const actor = isObject(row['actor']) ? row['actor'] : {};
    return {
        id: row['id'], creatorId: row['creator_id'], adAccountId: row['ad_account_id'], objectKey: row['object_key'], kind: row['kind'],
        payload: isObject(row['payload']) ? (row['payload'] as OpPayload) : {},
        idempotencyKey: row['idempotency_key'] ?? null, dependsOn: row['depends_on'] ?? null, state: row['state'], notBefore: asDate(row['not_before']),
        attempts: Number(row['attempts'] ?? 0), result: isObject(row['result']) ? row['result'] : null,
        actor: { userId: (actor['userId'] as string | null) ?? null, role: (actor['role'] as string | null) ?? null, via: (actor['via'] as OpActor['via']) ?? 'owner' },
        proposalId: row['proposal_id'] ?? null, createdAt: asDate(row['created_at']),
        startedAt: row['started_at'] ? asDate(row['started_at']) : null, finishedAt: row['finished_at'] ? asDate(row['finished_at']) : null,
    };
}

export function toView(op: Op): OpView {
    return {
        id: op.id, kind: op.kind, state: op.state, objectKey: op.objectKey, notBefore: op.notBefore.toISOString(), attempts: op.attempts, result: op.result,
        createdAt: op.createdAt.toISOString(), finishedAt: op.finishedAt ? op.finishedAt.toISOString() : null, actorVia: op.actor.via,
    };
}

/** An ops row is written under `ads.op_*` by the person or the machine that asked for it, never by "the system". */
function auditActor(actor: OpActor): AuditActor {
    if (actor.userId) return { userId: actor.userId, email: null };
    return { userId: null, email: actor.via === 'owner' ? LEGACY_ACTOR_EMAIL : `ads:${actor.via}` };
}

async function auditOp(action: 'ads.op_enqueued' | 'ads.op_applied' | 'ads.op_failed', op: Op, extra: Record<string, unknown>, exec?: Exec): Promise<void> {
    try {
        await writeAudit(auditActor(op.actor), {
            action, targetType: 'ads_op', targetId: op.id,
            detail: { kind: op.kind, object_key: op.objectKey, via: op.actor.via, creator_id: op.creatorId, ...(op.proposalId ? { proposal_id: op.proposalId } : {}), ...extra },
        }, exec as unknown as AuditExecutor | undefined);
    } catch (err) {
        log('error', 'ads.op_audit_failed', { op_id: op.id, ...describeError(err) });
    }
}

// ─── Reading and writing the queue ──────────────────────────────────────────────────────────

/** A path that stays inside one object: `<id>`, `<id>/<edge>`, `act_<id>/<edge>`, or `{dep}/<edge>`. Never a query string or a way out. */
function validPath(path: unknown): path is string {
    return typeof path === 'string' && path.length > 0 && path.length <= 200 && !/[?#\s]|\.\./.test(path) && !path.startsWith('/') && !path.endsWith('/');
}

function checkInput(input: EnqueueInput): void {
    if (!ADS_OP_KINDS.includes(input.kind)) throw new Error(`Unknown ads op kind: ${String(input.kind)}`);
    const exec = input.payload?.exec;
    if (exec !== undefined) {
        if (exec.method !== 'POST' && exec.method !== 'DELETE') throw new Error('An ads op exec is a POST or a DELETE.');
        if (!validPath(exec.path)) throw new Error('An ads op exec path must stay inside one object (no query, no "..", no leading slash).');
    }
}

/**
 * Queue a write. `idempotencyKey` is `<actor action id>:<step>`: a second request with the same key gets the op the first made, with no
 * second row and no second audit row. With `exec` (a caller's locked transaction, A1's money lock) the op and its audit row are written
 * in that transaction, so they are committed or rolled back with the check that allowed them; without it the audit row follows the insert.
 */
export async function enqueue(input: EnqueueInput, exec?: Exec): Promise<OpView> {
    checkInput(input);
    const sql = `INSERT INTO ads_ops (creator_id, ad_account_id, object_key, kind, payload, idempotency_key, depends_on, not_before, actor, proposal_id)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8, NOW()), $9::jsonb, $10)
                 ON CONFLICT (idempotency_key) DO NOTHING
                 RETURNING *`;
    const params = [
        input.creatorId, input.adAccountId, input.objectKey, input.kind, JSON.stringify(input.payload), input.idempotencyKey, input.dependsOn ?? null,
        input.notBefore ?? null, JSON.stringify({ userId: input.actor.userId, role: input.actor.role ?? null, via: input.actor.via }), input.proposalId ?? null,
    ];
    const inserted = exec ? (await exec.query(sql, params)).rows[0] : (await queryRows(sql, params))[0];
    if (inserted) {
        const op = toOp(inserted);
        await auditOp('ads.op_enqueued', op, {}, exec);
        return toView(op);
    }
    const lookup = 'SELECT * FROM ads_ops WHERE idempotency_key = $1 AND creator_id = $2';
    const existing = exec ? (await exec.query(lookup, [input.idempotencyKey, input.creatorId])).rows[0] : (await queryRows(lookup, [input.idempotencyKey, input.creatorId]))[0];
    if (!existing) throw new Error('This idempotency key belongs to another tenant.');
    return toView(toOp(existing));
}

export async function getOp(creatorId: string, id: string): Promise<OpView | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await queryOne('SELECT * FROM ads_ops WHERE id = $1 AND creator_id = $2', [id, creatorId]);
    return row ? toView(toOp(row)) : null;
}

export async function listOps(creatorId: string, states: AdsOpState[], limit = 100): Promise<OpView[]> {
    const rows = await queryRows('SELECT * FROM ads_ops WHERE creator_id = $1 AND state = ANY($2::text[]) ORDER BY created_at DESC, id LIMIT $3', [creatorId, states, Math.max(1, Math.min(limit, 500))]);
    return rows.map((r) => toView(toOp(r)));
}

/** 4 minus the budget ops done in the last hour, per ad set (Meta's `613/1487632` limit), for the budget editor's "n edits left". */
export async function editsLeftThisHour(creatorId: string, adsetMetaIds: string[], now: Date = new Date()): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (adsetMetaIds.length === 0) return out;
    const rows = await queryRows<{ k: string; n: string }>(
        `SELECT COALESCE(payload->>'adsetMetaId', object_key) AS k, COUNT(*)::text AS n
           FROM ads_ops
          WHERE creator_id = $1 AND kind = 'budget' AND state = 'done' AND finished_at > $2
            AND COALESCE(payload->>'adsetMetaId', object_key) = ANY($3::text[])
          GROUP BY 1`,
        [creatorId, new Date(now.getTime() - HOUR_MS), adsetMetaIds],
    );
    const used = new Map(rows.map((r) => [r.k, Number(r.n)]));
    for (const id of adsetMetaIds) out.set(id, Math.max(0, BUDGET_EDITS_PER_HOUR - (used.get(id) ?? 0)));
    return out;
}

// ─── Claiming ───────────────────────────────────────────────────────────────────────────────

const SCRUB_SQL = `jsonb_set(payload, '{exec,params}', '{}'::jsonb)`;

/**
 * The due ops of one ad account, oldest first. An op is excluded while any op on its object is running or being verified (one at a time per
 * object) and while an older op on its object is still pending (the order of creation is the order of execution). A dependency's state
 * rides along so the claim can tell "not yet" from "never".
 */
const CANDIDATES_SQL = `
    SELECT p.*, d.state AS dep_state
      FROM ads_ops p
      LEFT JOIN ads_ops d ON d.id = p.depends_on AND d.creator_id = p.creator_id
     WHERE p.ad_account_id = $1
       AND p.state = 'pending'
       AND p.not_before <= $2
       AND p.payload ? 'exec'
       AND ($3::uuid IS NULL OR p.id = $3::uuid)
       AND ($4::uuid IS NULL OR p.creator_id = $4::uuid)
       AND NOT EXISTS (SELECT 1 FROM ads_ops r WHERE r.creator_id = p.creator_id AND r.ad_account_id = p.ad_account_id AND r.object_key = p.object_key AND r.state IN ('running', 'verify'))
       AND NOT EXISTS (SELECT 1 FROM ads_ops e WHERE e.creator_id = p.creator_id AND e.ad_account_id = p.ad_account_id AND e.object_key = p.object_key AND e.state = 'pending' AND (e.created_at, e.id) < (p.created_at, p.id))
     ORDER BY p.created_at, p.id
     LIMIT 25
       FOR UPDATE OF p SKIP LOCKED`;

const HISTORY_SQL = `
    SELECT kind, object_key, payload->>'adsetMetaId' AS adset_key, finished_at
      FROM ads_ops
     WHERE creator_id = $1 AND ad_account_id = $2 AND state = 'done' AND finished_at > $3
     ORDER BY finished_at
     LIMIT 2000`;

export interface ClaimTrace {
    /** Ops whose `not_before` was pushed out by a per-object limit. */
    deferred: number;
    /** Ops cancelled because the op they depend on failed or was cancelled. */
    cancelled: number;
}

export interface ClaimOptions {
    /** Only this tenant's ops (the drain and the inline run always name it). */
    creatorId?: string | null;
    /** Only this op (the inline run). */
    onlyId?: string | null;
    trace?: ClaimTrace;
}

/**
 * ONE short transaction (no Meta call in it): the oldest `pending` op that is due, whose dependency is done, and that no per-object limit
 * holds back becomes `running`. An op held back has its `not_before` pushed to when the limit lifts and the next one is tried; the ops
 * behind it on the same object wait too, so the order per object never changes. An op whose dependency failed or was cancelled is cancelled.
 */
export async function claimNext(adAccountId: string, now: Date, opts: ClaimOptions = {}): Promise<Op | null> {
    return withTransaction(async (tx) => {
        const histories = new Map<string, DoneRecord[]>();
        const historyOf = async (creatorId: string): Promise<DoneRecord[]> => {
            let h = histories.get(creatorId);
            if (!h) {
                const { rows } = await tx.query(HISTORY_SQL, [creatorId, adAccountId, new Date(now.getTime() - HISTORY_WINDOW_MS)]);
                h = rows.map((r) => ({ kind: r['kind'], objectKey: r['object_key'], adsetKey: r['adset_key'] ?? null, finishedAt: asDate(r['finished_at']) }));
                histories.set(creatorId, h);
            }
            return h;
        };
        for (let round = 0; round < 4; round++) {
            const { rows } = await tx.query(CANDIDATES_SQL, [adAccountId, now, opts.onlyId ?? null, opts.creatorId ?? null]);
            if (rows.length === 0) return null;
            let cancelled = 0;
            const held = new Set<string>();
            for (const row of rows) {
                const op = toOp(row);
                if (held.has(op.objectKey)) continue;
                const depState = row['dep_state'] as string | null | undefined;
                if (op.dependsOn && (depState === 'failed' || depState === 'cancelled')) {
                    await tx.query(
                        `UPDATE ads_ops SET state = 'cancelled', result = $2::jsonb, finished_at = $3,
                                payload = CASE WHEN payload->>'scrub' = 'true' THEN ${SCRUB_SQL} ELSE payload END
                          WHERE id = $1 AND creator_id = $4 AND state = 'pending'`,
                        [op.id, JSON.stringify({ code: 'DEPENDENCY_FAILED', dependsOn: op.dependsOn, dependencyState: depState }), now, op.creatorId],
                    );
                    cancelled++;
                    if (opts.trace) opts.trace.cancelled++;
                    continue;
                }
                if (op.dependsOn && depState !== 'done') { held.add(op.objectKey); continue; }
                const wait = limitWaitUntil(op, await historyOf(op.creatorId), now);
                if (wait) {
                    await tx.query('UPDATE ads_ops SET not_before = $2 WHERE id = $1 AND creator_id = $3 AND state = \'pending\'', [op.id, wait, op.creatorId]);
                    held.add(op.objectKey);
                    if (opts.trace) opts.trace.deferred++;
                    continue;
                }
                const claimed = await tx.query(
                    `UPDATE ads_ops SET state = 'running', started_at = $2, attempts = attempts + 1
                      WHERE id = $1 AND creator_id = $3 AND state = 'pending' RETURNING *`,
                    [op.id, now, op.creatorId],
                );
                if (claimed.rows[0]) return toOp(claimed.rows[0]);
            }
            // Cancelling a dependent frees the ops behind it on its object: look again.
            if (cancelled === 0) return null;
        }
        return null;
    });
}

/** The oldest `verify` op that is due, leased for a minute in the same short transaction so a concurrent run does not look at it too. */
async function claimVerify(adAccountId: string, creatorId: string, now: Date): Promise<Op | null> {
    return withTransaction(async (tx) => {
        const { rows } = await tx.query(
            `SELECT * FROM ads_ops v
              WHERE v.state = 'verify' AND v.ad_account_id = $1 AND v.not_before <= $2 AND v.creator_id = $3 AND v.payload ? 'exec'
              ORDER BY v.not_before, v.created_at
              LIMIT 1
                FOR UPDATE SKIP LOCKED`,
            [adAccountId, now, creatorId],
        );
        if (!rows[0]) return null;
        const op = toOp(rows[0]);
        await tx.query('UPDATE ads_ops SET not_before = $2 WHERE id = $1 AND creator_id = $3 AND state = \'verify\'', [op.id, new Date(now.getTime() + VERIFY_RECHECK_MS), op.creatorId]);
        return op;
    });
}

// ─── Talking to Meta ────────────────────────────────────────────────────────────────────────

export interface GraphResponse { data?: any }

/** The three Graph calls; tests pass stubs, everything else the real client of graph.ts. */
export interface GraphDeps {
    get(path: string, params: Record<string, string>, token: string, opts: AdsCallOptions): Promise<GraphResponse>;
    post(path: string, params: GraphParams, token: string, opts: AdsCallOptions): Promise<GraphResponse>;
    del(path: string, token: string, opts: AdsCallOptions): Promise<GraphResponse>;
}

const realGraph: GraphDeps = { get: adsGet, post: adsPost, del: adsDelete };

export interface RunOpts {
    graph?: GraphDeps;
    now?: () => Date;
    /** The tenant's ads token; null when none is stored. */
    loadToken?: (creatorId: string) => Promise<string | null>;
    /** Until when Meta has the ad account blocked (the pacer's row), if it does. */
    blockedUntil?: (adAccountId: string) => Promise<Date | null>;
    /** `runOpInline`: only this tenant's op. */
    creatorId?: string;
}

interface Env {
    graph: GraphDeps;
    now: () => Date;
    loadToken: (creatorId: string) => Promise<string | null>;
    blockedUntil: (adAccountId: string) => Promise<Date | null>;
}

function envOf(opts: RunOpts): Env {
    return {
        graph: opts.graph ?? realGraph,
        now: opts.now ?? (() => new Date()),
        loadToken: opts.loadToken ?? (async (creatorId) => {
            // A token Meta refused (190/102) stops the tenant's queue until a new one is saved (A1 `isQueueStopped`): nothing is claimed.
            try { return isQueueStopped(await readHealth(creatorId)) ? null : (await readAdsSettings(creatorId)).token; } catch (err) { log('error', 'ads.drain_token_unreadable', { creator_id: creatorId, ...describeError(err) }); return null; }
        }),
        blockedUntil: opts.blockedUntil ?? (async (account) => {
            try { return (await pacerStatus(account))?.blockedUntil ?? null; } catch { return null; }
        }),
    };
}

export interface ExecCall {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    params?: Record<string, any>;
    label: string;
    creates?: boolean;
}

/**
 * EVERY send of an op to Meta (the write, the tag search, the read-back, a resend) goes through this one function, inside the tenant's and
 * the ad account's context so the pacer spends from the right budget. It is the single place to assert that the op may use this token.
 */
export function sendExec(op: Op, call: ExecCall, deps: GraphDeps & { token: string }): Promise<GraphResponse> {
    return withAdsContext({ creatorId: op.creatorId, adAccountId: op.adAccountId }, () => {
        const opts: AdsCallOptions = { label: call.label, creates: call.creates, creatorId: op.creatorId, adAccountId: op.adAccountId };
        if (call.method === 'GET') return deps.get(call.path, (call.params ?? {}) as Record<string, string>, deps.token, opts);
        if (call.method === 'DELETE') return deps.del(call.path, deps.token, opts);
        return deps.post(call.path, (call.params ?? {}) as GraphParams, deps.token, opts);
    });
}

/** The params of a create with `AR·<op id>` in its name (added if absent), so the object can be found again if the answer never came. */
function taggedParams(op: Op, params: GraphParams): GraphParams {
    const tag = tagOf(op.id);
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    return { ...params, name: name.includes(tag) ? name : `${name} ${tag}`.trim() };
}

/** The op's path with `{dep}` replaced by the id its dependency produced. Null when it cannot be: no dependency, or one that made no id. */
async function resolvePath(op: Op, path: string): Promise<string | null> {
    if (!path.includes('{dep}')) return path;
    if (!op.dependsOn) return null;
    const dep = await queryOne<{ result: Record<string, unknown> | null }>('SELECT result FROM ads_ops WHERE id = $1 AND creator_id = $2', [op.dependsOn, op.creatorId]);
    const id = dep?.result?.['id'];
    return typeof id === 'string' && id ? path.split('{dep}').join(id) : null;
}

const NO_DEP_ID: OpOutcome = { state: 'failed', notBefore: null, result: { reason: 'dependency_without_id', message: 'The op this one depends on left no id to use.' } };

// ─── Recording ──────────────────────────────────────────────────────────────────────────────

/** The stored copy follows a write at once (the sync corrects it later): a new object's id, a status, a budget. */
async function applyToMirror(tx: Exec, op: Op, result: Record<string, unknown> | null): Promise<void> {
    if (!UUID_PATTERN.test(op.objectKey)) return;
    const exec = op.payload.exec;
    if (!exec) return;
    if (isCreateOp(op)) {
        const id = result?.['id'];
        if (typeof id === 'string' && id) {
            // A row the sync inserted for this id in the meantime owns it: adopting it twice would break the unique index.
            await tx.query(
                `UPDATE ads_objects SET meta_id = $3, updated_at = NOW()
                  WHERE id = $1 AND creator_id = $2 AND meta_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM ads_objects o WHERE o.creator_id = $2 AND o.level = ads_objects.level AND o.meta_id = $3)`,
                [op.objectKey, op.creatorId, id],
            );
        }
        return;
    }
    const params = exec.params ?? {};
    const status = exec.method === 'DELETE' ? 'DELETED' : typeof params['status'] === 'string' ? (params['status'] as string) : null;
    if (status) {
        const final = status === 'ARCHIVED' || status === 'DELETED';
        await tx.query(
            `UPDATE ads_objects SET status = $3, ${final ? 'effective_status = $3, ' : ''}updated_at = NOW() WHERE id = $1 AND creator_id = $2`,
            [op.objectKey, op.creatorId, status],
        );
    }
    const budgetKey = params['daily_budget'] !== undefined ? 'daily_budget' : params['lifetime_budget'] !== undefined ? 'lifetime_budget' : null;
    if (budgetKey) {
        const minor = Number(params[budgetKey]);
        const row = (await tx.query<{ currency: string }>('SELECT currency FROM ads_objects WHERE id = $1 AND creator_id = $2', [op.objectKey, op.creatorId])).rows[0];
        if (row && Number.isFinite(minor)) {
            await tx.query(
                'UPDATE ads_objects SET budget_kind = $3, budget_amount = $4, updated_at = NOW() WHERE id = $1 AND creator_id = $2',
                [op.objectKey, op.creatorId, budgetKey === 'daily_budget' ? 'daily' : 'lifetime', fromMinorUnits(minor, row.currency)],
            );
        }
    }
}

/**
 * The second short transaction: the op's new state, in the statement that also empties `exec.params` when the payload asks for it (hashed
 * contact rows must not outlive the upload) and only once the op is over. `expected` is the state the op was in when this run took it: if
 * the reaper moved it meanwhile the update matches nothing and nothing else is written either.
 */
async function recordOutcome(op: Op, expected: 'running' | 'verify', out: OpOutcome, now: Date): Promise<boolean> {
    const terminal = out.state === 'done' || out.state === 'failed';
    const applied = await withTransaction(async (tx) => {
        const res = await tx.query(
            `UPDATE ads_ops SET state = $2, not_before = COALESCE($3, not_before), result = $4::jsonb, finished_at = $5,
                    payload = CASE WHEN $5::timestamptz IS NOT NULL AND payload->>'scrub' = 'true' THEN ${SCRUB_SQL} ELSE payload END
              WHERE id = $1 AND creator_id = $7 AND state = $6 RETURNING id`,
            [op.id, out.state, out.notBefore, out.result === null ? null : JSON.stringify(out.result), terminal ? now : null, expected, op.creatorId],
        );
        if (res.rows.length === 0) return false;
        if (out.state === 'done') await applyToMirror(tx, op, out.result);
        return true;
    });
    if (applied && out.state === 'done') await auditOp('ads.op_applied', op, { result_id: typeof out.result?.['id'] === 'string' ? out.result['id'] : null });
    if (applied && out.state === 'failed') await auditOp('ads.op_failed', op, { code: out.result?.['code'] ?? out.result?.['reason'] ?? null, subcode: out.result?.['subcode'] ?? null });
    return applied;
}

/** A failure to record is logged and left to the reaper (a create is then looked for by its tag): it never reaches the caller. */
async function recordQuietly(op: Op, expected: 'running' | 'verify', out: OpOutcome, now: Date): Promise<void> {
    try {
        await recordOutcome(op, expected, out, now);
    } catch (err) {
        log('error', 'ads.op_record_failed', { op_id: op.id, state: out.state, ...describeError(err) });
    }
}

// ─── Executing ──────────────────────────────────────────────────────────────────────────────

/** Send one claimed (`running`) op to Meta and record what came back. Never throws; the result says what became of the op. */
export async function execute(op: Op, token: string, opts: RunOpts = {}): Promise<OpOutcome> {
    const env = envOf(opts);
    const exec = op.payload.exec;
    let out: OpOutcome;
    try {
        const path = exec ? await resolvePath(op, exec.path) : null;
        if (!exec) out = { state: 'failed', notBefore: null, result: { code: 'NO_EXEC', message: 'This op has no call to make.' } };
        else if (path === null) out = NO_DEP_ID;
        else {
            const create = isCreateOp(op);
            const deps = { ...env.graph, token };
            try {
                const res = await sendExec(op, {
                    method: exec.method, path, label: `ads.op.${op.kind}`, creates: create || undefined,
                    params: exec.method === 'DELETE' ? undefined : create ? taggedParams(op, exec.params ?? {}) : exec.params ?? {},
                }, deps);
                out = outcomeFor(op, { ok: true, data: res.data }, env.now());
            } catch (err) {
                out = outcomeFor(op, { ok: false, error: err }, env.now());
            }
        }
    } catch (err) {
        log('error', 'ads.op_execute_failed', { op_id: op.id, ...describeError(err) });
        out = { state: 'failed', notBefore: null, result: failure(err) };
    }
    await recordQuietly(op, 'running', out, env.now());
    return out;
}

// ─── Verifying ──────────────────────────────────────────────────────────────────────────────

const VERIFY_FIELDS = 'status,daily_budget,lifetime_budget,end_time';

/** Does what Meta shows for the object match the write that may have landed? Only the fields a write here sets are compared. */
function matchesIntent(params: Record<string, unknown>, data: Record<string, unknown>): boolean {
    const keys = ['status', 'daily_budget', 'lifetime_budget', 'end_time', 'spend_cap'].filter((k) => params[k] !== undefined);
    if (keys.length === 0) return false;
    return keys.every((k) => {
        const want = params[k];
        const have = data[k];
        if (have === undefined || have === null) return false;
        if (k === 'end_time') {
            const a = typeof want === 'number' ? want * 1000 : Date.parse(String(want));
            const b = Date.parse(String(have));
            return Number.isFinite(a) && Number.isFinite(b) ? a === b : String(want) === String(have);
        }
        return String(want) === String(have);
    });
}

/**
 * `found` for `nextVerifyStep`: a create is searched for by its tag in the name (`filtering=[{"field":"name","operator":"CONTAIN",...}]`,
 * ids only); any other write is read back and compared with what was meant. A delete is "done" when Meta no longer knows the object.
 */
async function readBack(op: Op, exec: OpExecSpec, path: string, deps: GraphDeps & { token: string }): Promise<string | boolean | null> {
    if (isCreateOp(op)) {
        const res = await sendExec(op, {
            method: 'GET', path, label: 'ads.op_verify',
            params: { filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: tagOf(op.id) }]), fields: 'id' },
        }, deps);
        const list = res.data?.data;
        const hit = Array.isArray(list) ? list.find((o: any) => o && typeof o.id === 'string') : null;
        return hit?.id ?? null;
    }
    const params = exec.params ?? {};
    const fields = params['spend_cap'] !== undefined ? `${VERIFY_FIELDS},spend_cap` : VERIFY_FIELDS;
    try {
        const res = await sendExec(op, { method: 'GET', path, label: 'ads.op_verify', params: { fields } }, deps);
        if (exec.method === 'DELETE') return false;
        return matchesIntent(params, isObject(res.data) ? res.data : {});
    } catch (err) {
        if (exec.method === 'DELETE' && err instanceof AdsGraphError && err.metaCode === 100) return true;
        throw err;
    }
}

/** A read that failed says nothing about the object: the op stays in `verify` and no check is counted. */
function verifyReadFailed(op: Op, err: unknown, now: Date): OpOutcome {
    if (err instanceof AdsGraphError && err.klass === 'token_dead') return { state: 'failed', notBefore: null, result: { ...failure(err), code: 'TOKEN_INVALID' }, stop: 'token_dead' };
    if (err instanceof AdsGraphError && err.klass === 'throttle') return { state: 'verify', notBefore: err.retryAt ?? new Date(now.getTime() + DEFAULT_THROTTLE_MS), result: op.result, stop: 'throttle' };
    return { state: 'verify', notBefore: new Date(now.getTime() + VERIFY_RECHECK_MS), result: op.result };
}

/**
 * Settle an op in `verify` (R6): look for what may have landed and let `nextVerifyStep` decide. Nothing is sent from here: a resend is
 * the op going back to `pending` once, to be executed like any other. Never throws.
 */
export async function verify(op: Op, token: string, opts: RunOpts = {}): Promise<OpOutcome> {
    const env = envOf(opts);
    const exec = op.payload.exec;
    let out: OpOutcome;
    try {
        if (!exec) {
            out = nextVerifyStep(op, null, env.now());
        } else {
            const path = await resolvePath(op, exec.path);
            if (path === null) out = NO_DEP_ID;
            else {
                try {
                    const found = await readBack(op, exec, path, { ...env.graph, token });
                    out = nextVerifyStep(op, found, env.now());
                } catch (err) {
                    out = verifyReadFailed(op, err, env.now());
                }
            }
        }
    } catch (err) {
        log('error', 'ads.op_verify_failed', { op_id: op.id, ...describeError(err) });
        out = { state: 'verify', notBefore: new Date(env.now().getTime() + VERIFY_RECHECK_MS), result: op.result };
    }
    await recordQuietly(op, 'verify', out, env.now());
    return out;
}

// ─── Reaping ────────────────────────────────────────────────────────────────────────────────

/**
 * A `running` op older than 5 minutes was taken by an instance that never finished it: a create (and any op written by the synchronous
 * path, which has no call to repeat) goes to `verify`, since it may have landed; any other op goes back to `pending`. A `verify` op a day
 * old that could not be settled fails as `abandoned`. This is maintenance across every tenant, so it names none.
 */
export async function reap(now: Date = new Date()): Promise<number> {
    const stale = await queryRows(
        `UPDATE ads_ops SET state = CASE WHEN payload #>> '{exec,edge}' IS NOT NULL OR kind = 'audience_create' OR NOT (payload ? 'exec') THEN 'verify' ELSE 'pending' END,
                not_before = $1
          WHERE state = 'running' AND started_at < $2
          RETURNING id, creator_id`,
        [now, new Date(now.getTime() - RUNNING_STALE_MS)],
    );
    const abandoned = await queryRows(
        `UPDATE ads_ops SET state = 'failed', result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('reason', 'abandoned'), finished_at = $1,
                payload = CASE WHEN payload->>'scrub' = 'true' THEN ${SCRUB_SQL} ELSE payload END
          WHERE state = 'verify' AND COALESCE(started_at, created_at) < $2
          RETURNING id, creator_id`,
        [now, new Date(now.getTime() - VERIFY_GIVE_UP_MS)],
    );
    return stale.length + abandoned.length;
}

// ─── Draining ───────────────────────────────────────────────────────────────────────────────

export interface DrainStats {
    ran: number;
    done: number;
    failed: number;
    /** Ops put back on the clock (a throttle, a budget or object limit) plus accounts skipped while Meta has them blocked. */
    deferred: number;
    reaped: number;
}

/**
 * What `GET /api/jobs/drain` runs. Reaps, then for each ad account with something due: settles a `verify` op first (it may unblock its
 * object), otherwise claims and executes the next `pending` one, until nothing is due or the invocation is nearly out of time. An account
 * Meta has blocked is skipped, a throttle ends that account's run, a dead token ends that tenant's. Never throws.
 */
export async function drainAdsOps(deadline: number, opts: RunOpts = {}): Promise<DrainStats> {
    const stats: DrainStats = { ran: 0, done: 0, failed: 0, deferred: 0, reaped: 0 };
    const env = envOf(opts);
    const hasTime = () => Date.now() <= deadline - DEADLINE_MARGIN_MS;
    try {
        try {
            stats.reaped = await reap(env.now());
        } catch (err) {
            log('error', 'ads.drain_reap_failed', describeError(err));
        }
        const accounts = await queryRows<{ creator_id: string; ad_account_id: string }>(
            `SELECT DISTINCT creator_id, ad_account_id FROM ads_ops
              WHERE state IN ('pending', 'verify') AND not_before <= $1 AND payload ? 'exec'
              LIMIT 100`,
            [env.now()],
        );
        const deadTokens = new Set<string>();
        for (const { creator_id: creatorId, ad_account_id: account } of accounts) {
            if (!hasTime()) break;
            if (deadTokens.has(creatorId)) continue;
            try {
                const until = await env.blockedUntil(account);
                if (until && until.getTime() > env.now().getTime()) { stats.deferred++; continue; }
                const token = await env.loadToken(creatorId);
                if (!token) { log('warn', 'ads.drain_no_token', { creator_id: creatorId, ad_account_id: account }); stats.deferred++; continue; }
                for (let step = 0; step < MAX_STEPS_PER_ACCOUNT && hasTime(); step++) {
                    const now = env.now();
                    const trace: ClaimTrace = { deferred: 0, cancelled: 0 };
                    const waiting = await claimVerify(account, creatorId, now);
                    const op = waiting ?? (await claimNext(account, now, { creatorId, trace }));
                    stats.deferred += trace.deferred;
                    if (!op) break;
                    const out = waiting ? await verify(op, token, { ...opts, graph: env.graph, now: env.now }) : await execute(op, token, { ...opts, graph: env.graph, now: env.now });
                    stats.ran++;
                    if (out.state === 'done') stats.done++;
                    else if (out.state === 'failed') stats.failed++;
                    else if (out.state === 'pending') stats.deferred++;
                    if (out.stop === 'token_dead') { deadTokens.add(creatorId); break; }
                    if (out.stop === 'throttle') break;
                }
            } catch (err) {
                log('error', 'ads.drain_account_failed', { creator_id: creatorId, ad_account_id: account, ...describeError(err) });
            }
        }
    } catch (err) {
        log('error', 'ads.drain_failed', describeError(err));
    }
    return stats;
}

/**
 * Run one op now, as a button press does after `enqueue`: claim it if it is claimable (due, its dependency done, nothing else running on
 * its object, no limit applies), send it and record it. Anything else leaves it to the drain, and the screen shows "queued". Never throws.
 */
export async function runOpInline(opId: string, opts: RunOpts = {}): Promise<void> {
    try {
        const env = envOf(opts);
        const row = await queryOne<{ creator_id: string; ad_account_id: string }>(
            `SELECT creator_id, ad_account_id FROM ads_ops WHERE id = $1 AND state = 'pending' AND ($2::uuid IS NULL OR creator_id = $2::uuid)`,
            [opId, opts.creatorId ?? null],
        );
        if (!row) return;
        const until = await env.blockedUntil(row.ad_account_id);
        if (until && until.getTime() > env.now().getTime()) return;
        // The token first: an op claimed without one would sit `running` until the reaper moved it.
        const token = await env.loadToken(row.creator_id);
        if (!token) return;
        const op = await claimNext(row.ad_account_id, env.now(), { creatorId: row.creator_id, onlyId: opId });
        if (op) await execute(op, token, { ...opts, graph: env.graph, now: env.now });
    } catch (err) {
        log('error', 'ads.op_inline_failed', { op_id: opId, ...describeError(err) });
    }
}

/**
 * Enqueue, then try to run it under `waitUntil` so the request is answered at once. With the caller's own transaction (`exec`) the op is not
 * visible yet, so nothing is attempted here: the caller runs `runOpInline(op.id)` after it commits, or the drain picks the op up.
 */
export async function enqueueAndTryInline(input: EnqueueInput, exec?: Exec): Promise<OpView> {
    const view = await enqueue(input, exec);
    if (!exec) waitUntil(runOpInline(view.id, { creatorId: input.creatorId }));
    return view;
}
