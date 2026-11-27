/**
 * The 30-day clean-up (UX plan U2, §3 defaults): a post that failed and a conversation that needed a person, left alone for a month, are put
 * away by themselves, and both can be brought back.
 *
 * Why: the owner's Today carried a red "4 posts failed" for five weeks, and a 191-day-old thread in his To do. Nothing was wrong that a month of
 * silence had not already answered, and a card that is red for a month stops being read. The way out already existed for each (Archive, Mark handled,
 * v45); this only presses them for him after a month, and says so in the audit log.
 *
 *   - **Failed posts**: `status = 'FAILED'`, not archived, scheduled more than `days` ago. Archived, never deleted: the row, its error and its
 *     media stay, and the Scheduler's Archived view restores it. A post dated in the future (a placeholder) is not old.
 *   - **Expired hand-offs**: a thread that still "needs a person" by the one rule the attention summary uses (`THREADS_NEEDING_PERSON_SQL`: handed
 *     over with no operator reply since, or the bot off with the customer's message last) whose wait began more than `days` ago. It gets `handled_at`;
 *     a new message from the customer clears it again by itself, so nobody who writes back is hidden.
 *
 * A setting, not a constant (`cleanup.auto_archive.<tenant>`): ON at 30 days when nothing is saved, and the owner can turn it off or change the days
 * from Settings → Messages & alerts. Run by the daily cron. Never throws for one tenant: the rest still run. Never calls Meta, TikTok or Google.
 */
import { pool } from '../config/db.js';
import { queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { THREADS_NEEDING_PERSON_SQL } from './attention.js';
import { TENANT_SETTING_PREFIXES, getSetting, setSetting, tenantSettingKey } from './appSettings.js';
import { AUDIT_ACTIONS, writeAudit, type AuditActor } from './audit.js';

export const AUTO_ARCHIVE_DEFAULT_DAYS = 30;
export const AUTO_ARCHIVE_MIN_DAYS = 7;
export const AUTO_ARCHIVE_MAX_DAYS = 365;

/** The actor of the sweep's audit rows: nobody signed in. */
export const AUTO_ARCHIVE_ACTOR_EMAIL = 'system:auto-archive';

export interface AutoArchiveSetting {
    enabled: boolean;
    days: number;
}

export const AUTO_ARCHIVE_DEFAULT: Readonly<AutoArchiveSetting> = Object.freeze({ enabled: true, days: AUTO_ARCHIVE_DEFAULT_DAYS });

/** A whole number of days within the limits, or null. */
export function validDays(value: unknown): number | null {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isInteger(n) && n >= AUTO_ARCHIVE_MIN_DAYS && n <= AUTO_ARCHIVE_MAX_DAYS ? n : null;
}

/**
 * The stored value read strictly: only a JSON object is a setting, `enabled` is off only when it is exactly `false`, and `days` must be valid or it is
 * the default. A value that cannot be read is the default, never "off": a damaged row must not quietly stop a clean-up the owner never asked to stop,
 * nor start one he switched off (that needs `enabled: false`, which is read exactly). Pure.
 */
export function parseAutoArchive(raw: string | null | undefined): AutoArchiveSetting {
    if (!raw) return { ...AUTO_ARCHIVE_DEFAULT };
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...AUTO_ARCHIVE_DEFAULT };
        const o = value as Record<string, unknown>;
        return { enabled: o['enabled'] !== false, days: validDays(o['days']) ?? AUTO_ARCHIVE_DEFAULT_DAYS };
    } catch {
        return { ...AUTO_ARCHIVE_DEFAULT };
    }
}

export async function getAutoArchive(creatorId: string): Promise<AutoArchiveSetting> {
    return parseAutoArchive(await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.autoArchive, creatorId)));
}

export async function saveAutoArchive(creatorId: string, setting: AutoArchiveSetting, updatedBy: string | null): Promise<AutoArchiveSetting> {
    const clean: AutoArchiveSetting = { enabled: setting.enabled === true, days: validDays(setting.days) ?? AUTO_ARCHIVE_DEFAULT_DAYS };
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.autoArchive, creatorId), JSON.stringify(clean), updatedBy);
    return clean;
}

/** Failed posts older than `$2` days, put away. `$1` is the tenant. The same "failed" the attention count uses: FAILED and not archived. */
export const ARCHIVE_OLD_FAILED_POSTS_SQL = `
    UPDATE scheduled_posts
       SET archived_at = NOW()
     WHERE creator_id = $1
       AND status = 'FAILED'
       AND archived_at IS NULL
       AND scheduled_time < NOW() - make_interval(days => $2::int)
 RETURNING id
`;

/** Threads that need a person (the attention summary's own rule, shared) whose wait began more than `$2` days ago, marked handled. `$1` is the tenant. */
export const HANDLE_EXPIRED_THREADS_SQL = `
    UPDATE conversations
       SET handled_at = NOW()
     WHERE creator_id = $1
       AND handled_at IS NULL
       AND id IN (
           SELECT t.id FROM (${THREADS_NEEDING_PERSON_SQL}
           ) t
            WHERE t.kind IS NOT NULL AND t.since < NOW() - make_interval(days => $2::int)
       )
 RETURNING id
`;

export interface SweepResult {
    /** Tenants looked at (on by default or by choice). */
    tenants: number;
    posts: number;
    threads: number;
    failed: number;
}

const ACTOR: AuditActor = { userId: null, email: AUTO_ARCHIVE_ACTOR_EMAIL };

/** One tenant's clean-up. Returns what it put away. */
export async function sweepTenant(creatorId: string, days: number): Promise<{ posts: number; threads: number }> {
    const posts = await pool.query(ARCHIVE_OLD_FAILED_POSTS_SQL, [creatorId, days]);
    const threads = await pool.query(HANDLE_EXPIRED_THREADS_SQL, [creatorId, days]);
    const result = { posts: posts.rows.length, threads: threads.rows.length };
    if (result.posts > 0 || result.threads > 0) {
        log('info', 'cron.auto_archive_tenant', { creator_id: creatorId, posts: result.posts, threads: result.threads, days });
        await writeAudit(ACTOR, {
            action: AUDIT_ACTIONS.cleanupAutoArchive, targetType: 'tenant', targetId: creatorId,
            detail: { posts: result.posts, threads: result.threads, days },
        });
    }
    return result;
}

/**
 * The daily sweep, for every tenant that has not switched it off. One tenant's failure is logged and does not stop the others, and a database that
 * is behind v45 (no `archived_at`, no `handled_at`) fails per tenant the same way, which the log says.
 */
export async function runAutoArchiveSweep(): Promise<SweepResult> {
    const [creators, settings] = await Promise.all([
        queryRows<{ id: string }>('SELECT id FROM creators'),
        queryRows<{ key: string; value: string | null }>('SELECT key, value FROM app_settings WHERE key LIKE $1', [`${TENANT_SETTING_PREFIXES.autoArchive}%`]),
    ]);
    const stored = new Map(settings.map((row) => [row.key.slice(TENANT_SETTING_PREFIXES.autoArchive.length), parseAutoArchive(row.value)]));
    const out: SweepResult = { tenants: 0, posts: 0, threads: 0, failed: 0 };
    for (const { id } of creators) {
        const setting = stored.get(id) ?? AUTO_ARCHIVE_DEFAULT;
        if (!setting.enabled) continue;
        out.tenants += 1;
        try {
            const done = await sweepTenant(id, setting.days);
            out.posts += done.posts;
            out.threads += done.threads;
        } catch (err) {
            out.failed += 1;
            log('error', 'cron.auto_archive_tenant_failed', { creator_id: id, ...describeError(err) });
        }
    }
    return out;
}
