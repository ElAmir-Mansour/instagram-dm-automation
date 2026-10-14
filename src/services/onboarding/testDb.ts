/**
 * Tests only: an in-memory stand-in for the tables the draft engine touches (`profile_drafts`, `app_rate_limit_counters`, and for the
 * routes `creators`, `onboarding`, `users`, `audit_log`), answering by SQL like `invites/testDb.ts`. Not a test file, so `npm test`
 * does not run it.
 *
 * What makes it worth more than canned answers: **the claim, the guards and the reuse rule read their predicates out of the SQL they are
 * given.** `CLAIM_SQL` is answered by checking only the conditions that sentence contains: delete `lease_until < NOW()` from the
 * production statement and a second caller walks in on a draft that is being worked on, and the test for it fails. The same goes for
 * `next_attempt_at <= NOW()`, for the status guard, and for `lease_owner = $2` on every write (a caller that lost its lease must not
 * be able to overwrite the one that holds it). A stand-in that matched whole statements would answer "no rows" to a mutated one and fail
 * every test for the wrong reason; one that ignored the predicates would pass whatever the code did.
 *
 * Time is the world's: `world.clock` (epoch ms) is what `NOW()` means, so a test moves a lease, a back-off and a 24-hour window by
 * setting it. Pass `() => world.clock` as the engine's `now`.
 *
 * A transaction is a snapshot at BEGIN, restored at ROLLBACK, so the day's counter and a supersede roll back with a refused start, as in Postgres.
 * The partial unique index (one active draft per tenant) is enforced on INSERT, which is what makes "supersede before inserting" a tested fact.
 */
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { ACTIVE_STATUSES } from './draftStep.js';
import type { DraftRow } from './draftStore.js';

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface CreatorRec {
    id: string;
    name: string | null;
    instagram_username: string | null;
    website_url: string | null;
    instagram_page_id: string | null;
    page_access_token: string | null;
}

export interface DraftWorld {
    db: FakeDb;
    /** `NOW()`, in epoch milliseconds. */
    clock: number;
    now: () => number;
    drafts: DraftRow[];
    counters: Map<string, number>;
    creators: Map<string, CreatorRec>;
    onboarding: Map<string, string>;
    audits: Array<{ actor_user_id: string | null; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown> }>;
    /** Runs once, just BEFORE the next statement matching `pattern` is answered: another caller getting in between two of this one's statements. */
    before: Array<{ pattern: RegExp; run: () => void | Promise<void> }>;
    /** Throws on the next `times` statements that match. */
    failOn(pattern: RegExp, error?: Error, times?: number): void;
    addCreator(n: number, over?: Partial<CreatorRec>): CreatorRec;
    /** The draft rows of one tenant, oldest first. */
    draftsOf(creatorId: string): DraftRow[];
    restore(): void;
}

const ACTIVE = new Set<string>(ACTIVE_STATUSES);
const flatList = `status IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')})`;
const DAY_MS = 86_400_000;
const unique = (message: string): Error => Object.assign(new Error(message), { code: '23505' });

/** A pg-like copy: JSON columns come back as fresh objects, dates as Dates, so a caller cannot reach into the "table". */
const copy = (row: DraftRow): DraftRow => structuredClone(row);

export function installDraftWorld(): DraftWorld {
    const db = installFakeDb();
    const failures: Array<{ pattern: RegExp; error: Error; times: number }> = [];
    let nextId = 1;
    let snapshot: { drafts: DraftRow[]; counters: Map<string, number> } | null = null;

    const world: DraftWorld = {
        db,
        clock: Date.UTC(2026, 9, 14, 9, 0, 0),
        now: () => world.clock,
        drafts: [],
        counters: new Map(),
        creators: new Map(),
        onboarding: new Map(),
        audits: [],
        before: [],
        failOn: (pattern, error = new Error('connection terminated unexpectedly'), times = 1) => { failures.push({ pattern, error, times }); },
        addCreator(n, over = {}) {
            const rec: CreatorRec = { id: uuid(n), name: `Tenant ${n}`, instagram_username: null, website_url: null, instagram_page_id: null, page_access_token: null, ...over };
            world.creators.set(rec.id, rec);
            return rec;
        },
        draftsOf: (creatorId) => world.drafts.filter((d) => d.creator_id === creatorId).sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id)),
        restore: () => db.restore(),
    };
    const at = (ms: number): Date => new Date(ms);
    const nowDate = (): Date => at(world.clock);
    const byId = (id: string): DraftRow | undefined => world.drafts.find((d) => d.id === id);

    const route = (pattern: RegExp, answer: (params: any[], sql: string) => { rows: any[]; rowCount?: number }): void => {
        db.routes.push([pattern, (params, sql) => {
            const hookAt = world.before.findIndex((h) => h.pattern.test(sql));
            if (hookAt >= 0) {
                const hook = world.before.splice(hookAt, 1)[0]!;
                const ran = hook.run();
                if (ran && typeof (ran as Promise<void>).then === 'function') throw new Error('a `before` hook must be synchronous');
                // What the other caller did was COMMITTED: this transaction's rollback must not undo it.
                if (snapshot) snapshot = { drafts: structuredClone(world.drafts), counters: new Map(world.counters) };
            }
            const failure = failures.find((f) => f.times > 0 && f.pattern.test(sql));
            if (failure) {
                failure.times -= 1;
                throw failure.error;
            }
            return answer(params, sql);
        }]);
    };

    // ── Transactions ──
    route(/^BEGIN$/, () => { snapshot = { drafts: structuredClone(world.drafts), counters: new Map(world.counters) }; return { rows: [] }; });
    route(/^COMMIT$/, () => { snapshot = null; return { rows: [] }; });
    route(/^ROLLBACK$/, () => {
        if (snapshot) { world.drafts = snapshot.drafts; world.counters = snapshot.counters; snapshot = null; }
        return { rows: [] };
    });
    route(/^SELECT pg_advisory_xact_lock\(/, () => ({ rows: [{ pg_advisory_xact_lock: '' }] }));

    // ── Reading ──
    route(/^SELECT .* FROM profile_drafts WHERE id = \$1$/, ([id]) => {
        const row = byId(id);
        return { rows: row ? [copy(row)] : [] };
    });
    route(/^SELECT .* FROM profile_drafts WHERE creator_id = \$1 AND status <> 'superseded' ORDER BY created_at DESC, id DESC LIMIT 1$/, ([creatorId]) => {
        const rows = world.draftsOf(creatorId).filter((d) => d.status !== 'superseded').reverse();
        return { rows: rows[0] ? [copy(rows[0])] : [] };
    });
    route(/^SELECT .* FROM profile_drafts WHERE creator_id = \$1 AND inputs_hash = \$2 AND \(/, ([creatorId, hash], sql) => {
        const rows = world.draftsOf(creatorId).filter((d) => {
            if (d.inputs_hash !== hash) return false;
            const active = sql.includes(flatList) && ACTIVE.has(d.status);
            const fresh = sql.includes("status = 'ready' AND finished_at > NOW() - INTERVAL '24 hours'") && d.status === 'ready' && d.finished_at !== null && d.finished_at.getTime() > world.clock - DAY_MS;
            return active || fresh;
        }).reverse();
        return { rows: rows[0] ? [copy(rows[0])] : [] };
    });
    route(/^SELECT id FROM profile_drafts WHERE status IN /, ([limit], sql) => {
        const due = world.drafts.filter((d) => {
            if (sql.includes(flatList) && !ACTIVE.has(d.status)) return false;
            if (sql.includes('lease_until < NOW()') && d.lease_until !== null && d.lease_until.getTime() >= world.clock) return false;
            if (sql.includes('next_attempt_at <= NOW()') && d.next_attempt_at !== null && d.next_attempt_at.getTime() > world.clock) return false;
            return true;
        }).sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
        return { rows: due.slice(0, limit).map((d) => ({ id: d.id })) };
    });

    // ── Starting and superseding ──
    route(/^UPDATE profile_drafts SET status = 'superseded'/, ([creatorId], sql) => {
        let n = 0;
        for (const d of world.drafts) {
            if (d.creator_id !== creatorId) continue;
            const eligible = sql.includes(`${flatList.slice(0, -1)}, 'ready')`) ? ACTIVE.has(d.status) || d.status === 'ready' : false;
            if (!eligible) continue;
            d.status = 'superseded'; d.finished_at = nowDate(); d.lease_until = null; d.lease_owner = null; d.next_attempt_at = null; d.updated_at = nowDate();
            n += 1;
        }
        return { rows: [], rowCount: n };
    });
    route(/^INSERT INTO profile_drafts /, ([creatorId, origin, requestedBy, inputs, hash, promptVersion]) => {
        // The partial unique index: one active draft per tenant.
        if (world.drafts.some((d) => d.creator_id === creatorId && ACTIVE.has(d.status))) {
            throw unique('duplicate key value violates unique constraint "idx_profile_drafts_one_active"');
        }
        const row: DraftRow = {
            id: uuid(9000 + nextId++), creator_id: creatorId, origin, requested_by: requestedBy, inputs: JSON.parse(inputs), inputs_hash: hash, prompt_version: promptVersion,
            status: 'queued', attempts: 0, next_attempt_at: null, lease_until: null, lease_owner: null, sources: null, sources_status: null, draft: null, partial: false,
            usage: null, error: null, error_kind: null, created_at: nowDate(), updated_at: nowDate(), finished_at: null,
        };
        world.drafts.push(row);
        return { rows: [copy(row)] };
    });
    route(/^INSERT INTO app_rate_limit_counters /, ([bucket]) => {
        const key = `${bucket}|${Math.floor(world.clock / DAY_MS)}`;
        const count = (world.counters.get(key) ?? 0) + 1;
        world.counters.set(key, count);
        return { rows: [{ count }] };
    });

    // ── The lease ──
    route(/^UPDATE profile_drafts SET lease_until = NOW\(\) \+ make_interval/, ([id, owner, seconds], sql) => {
        const d = byId(id);
        if (!d) return { rows: [] };
        // Only the conditions the statement carries are applied: take one out of the SQL and it stops being enforced here.
        if (sql.includes(flatList) && !ACTIVE.has(d.status)) return { rows: [] };
        if (sql.includes('lease_until < NOW()') && d.lease_until !== null && d.lease_until.getTime() >= world.clock) return { rows: [] };
        if (sql.includes('next_attempt_at <= NOW()') && d.next_attempt_at !== null && d.next_attempt_at.getTime() > world.clock) return { rows: [] };
        if (sql.includes('CASE WHEN lease_owner IS NOT NULL THEN 1 ELSE 0 END') && d.lease_owner !== null) d.attempts += 1;
        d.lease_until = at(world.clock + seconds * 1000);
        d.lease_owner = owner;
        d.updated_at = nowDate();
        return { rows: [copy(d)] };
    });
    route(/^UPDATE profile_drafts SET lease_until = NULL, lease_owner = NULL, updated_at = NOW\(\) WHERE id = \$1 AND lease_owner = \$2$/, ([id, owner], sql) => {
        const d = byId(id);
        if (d && (!sql.includes('lease_owner = $2') || d.lease_owner === owner)) { d.lease_until = null; d.lease_owner = null; d.updated_at = nowDate(); }
        return { rows: [] };
    });

    /** The two guards every save carries, read from the statement. */
    const writable = (d: DraftRow | undefined, owner: string, sql: string): d is DraftRow => {
        if (!d) return false;
        if (sql.includes('lease_owner = $2') && d.lease_owner !== owner) return false;
        if (sql.includes(flatList) && !ACTIVE.has(d.status)) return false;
        return true;
    };
    const json = (v: string | null): unknown => (v === null || v === undefined ? null : JSON.parse(v));
    const release = (d: DraftRow): void => { d.lease_until = null; d.lease_owner = null; };

    route(/^UPDATE profile_drafts SET status = \$3, updated_at = NOW\(\)/, ([id, owner, status], sql) => {
        const d = byId(id);
        if (!writable(d, owner, sql)) return { rows: [] };
        d.status = status; d.updated_at = nowDate();
        return { rows: [copy(d)] };
    });
    route(/^UPDATE profile_drafts SET status = 'drafting', sources = /, ([id, owner, sources, sourcesStatus, usage], sql) => {
        const d = byId(id);
        if (!writable(d, owner, sql)) return { rows: [] };
        d.status = 'drafting'; d.sources = json(sources); d.sources_status = json(sourcesStatus); d.usage = json(usage); d.error = null; d.error_kind = null; d.next_attempt_at = null; d.updated_at = nowDate();
        return { rows: [copy(d)] };
    });
    route(/^UPDATE profile_drafts SET attempts = \$3, next_attempt_at = \$4/, ([id, owner, attempts, next, error, errorKind, sourcesStatus, draft, usage], sql) => {
        const d = byId(id);
        if (!writable(d, owner, sql)) return { rows: [] };
        d.attempts = attempts; d.next_attempt_at = next; d.error = error; d.error_kind = errorKind;
        if (sourcesStatus !== null) d.sources_status = json(sourcesStatus);
        if (draft !== null) d.draft = json(draft);
        d.usage = json(usage); release(d); d.updated_at = nowDate();
        return { rows: [copy(d)] };
    });
    route(/^UPDATE profile_drafts SET status = 'ready'/, ([id, owner, draft, partial, usage], sql) => {
        const d = byId(id);
        if (!writable(d, owner, sql)) return { rows: [] };
        d.status = 'ready'; d.draft = json(draft); d.partial = partial; d.usage = json(usage); d.error = null; d.error_kind = null; d.next_attempt_at = null;
        release(d); d.finished_at = nowDate(); d.updated_at = nowDate();
        return { rows: [copy(d)] };
    });
    route(/^UPDATE profile_drafts SET status = 'failed'/, ([id, owner, error, errorKind, draft, sourcesStatus, usage], sql) => {
        const d = byId(id);
        if (!writable(d, owner, sql)) return { rows: [] };
        d.status = 'failed'; d.error = error; d.error_kind = errorKind; d.draft = json(draft);
        if (sourcesStatus !== null) d.sources_status = json(sourcesStatus);
        d.usage = json(usage); d.next_attempt_at = null; release(d); d.finished_at = nowDate(); d.updated_at = nowDate();
        return { rows: [copy(d)] };
    });

    // ── What the routes read around the draft ──
    route(/^SELECT c\.instagram_username, c\.website_url, \(c\.instagram_page_id IS NOT NULL AND c\.page_access_token IS NOT NULL\) AS connected, o\.status AS onboarding_status FROM creators c LEFT JOIN onboarding o ON o\.creator_id = c\.id WHERE c\.id = \$1$/, ([id]) => {
        const c = world.creators.get(id);
        return { rows: c ? [{ instagram_username: c.instagram_username, website_url: c.website_url, connected: c.instagram_page_id !== null && c.page_access_token !== null, onboarding_status: world.onboarding.get(id) ?? null }] : [] };
    });
    route(/^SELECT id FROM creators WHERE id = \$1$/, ([id]) => ({ rows: world.creators.has(id) ? [{ id }] : [] }));
    route(/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [] }));
    route(/^INSERT INTO audit_log /, ([actorUserId, , action, targetType, targetId, detail]) => {
        world.audits.push({ actor_user_id: actorUserId, action, target_type: targetType, target_id: targetId, detail: JSON.parse(detail) });
        return { rows: [{ id: `audit-${world.audits.length}` }] };
    });
    // The campaigns' trigger words (the draft's collision check): none unless a test adds a route.
    route(/^SELECT trigger_keyword FROM campaigns WHERE creator_id = \$1/, () => ({ rows: [] }));

    return world;
}
