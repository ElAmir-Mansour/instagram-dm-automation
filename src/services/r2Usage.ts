/**
 * Cloudflare R2's free tier, kept: this app must never go over it.
 *
 * Cloudflare's free tier, per month: 10 GB of storage, 1,000,000 Class A operations and 10,000,000 Class B operations; downloads (egress)
 * are free. Class A = writes and listings (PutObject, CreateBucket, PutBucketCors, ListObjects, CopyObject, multipart); Class B = reads
 * (GetObject, HeadObject, HeadBucket, GetBucketCors). DeleteObject(s) is free, so it is not counted and is never refused.
 *
 *   ceilings   the free tier itself, in code (`R2_CEILINGS`). Nothing can lift a limit above them.
 *   limits     what this app keeps to: `storage.r2_limits` `{storage_bytes, class_a, class_b}`, editable on the Settings card, and ONLY LOWER than
 *              a ceiling (a save above one is refused, and a stored value above one is read as the ceiling). Defaults leave a margin:
 *              9 GiB, 900,000, 9,000,000. The ceiling for storage is 10 GB counted in thousands (10,000,000,000 bytes), the stricter reading of "10 GB".
 *   counting   EVERY R2 request is counted BEFORE it is sent (`R2StorageClient`, the one place that sends one), per UTC calendar month, in the
 *              `app_settings` row `storage.r2_usage.<YYYY-MM>` = `{a, b}`: no migration, a new row each month, the old ones left as a record.
 *              The reserve is one atomic statement, `INSERT … ON CONFLICT DO UPDATE … WHERE counter + n <= limit RETURNING`: when nothing comes
 *              back the limit is reached and the request is NOT sent (`R2LimitError`). A presigned upload counts as 1 Class A when it is signed,
 *              because the browser or the worker makes the PUT and this app never sees it.
 *   fail closed  a counter that cannot be read or written refuses the request (`R2CounterError`): never "send it anyway".
 *   batches    Class B (reads, one per served file) are reserved 50 at a time per server instance and used locally, so the hot read path does not
 *              touch the database on every file. A batch is counted when reserved, used or not: over-reserving can only make the count HIGHER than
 *              the real one, so the app stays under the limit, never over it. An instance that dies with a batch unused costs at most 49 reads
 *              of the month's allowance. Class A is reserved one at a time (writes are rare and each is worth a counted round trip).
 *   storage    before any write, the bytes already in R2 (the sum of `size_bytes` of rows whose `storage_path` starts `r2:`, which includes a signed
 *              upload that has not arrived yet: its row is written with the declared size when it is signed) plus the new file must fit the limit.
 *              Two uploads checked at the same instant could both fit and together pass it by one file; the 1 GB margin below the ceiling is for that.
 *   resets     on the 1st at 00:00 UTC, by itself: the month is part of the key. Leftover local batches of the old month are dropped.
 *
 * What this cannot know: Cloudflare's own dashboard is the final word. Our count covers only requests THIS APP makes (a person using
 * another tool on the same bucket, or a stale batch, is not in it), and Cloudflare counts a request when it receives it, not when it succeeds.
 *
 * At 80% of any limit the drain's `checkR2Warnings` emails the owner once a day per limit, and Today and the Settings card show a banner at 80% and at 100%.
 */
import { queryOne } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { APP_SETTING_KEYS, getR2Config, getSetting, setSetting } from './appSettings.js';
import { effectiveTo, emailReady, readNotifyChannels, sendEmail } from './notifyEmail.js';
import { sendTelegramMessage, telegramReady } from './notify.js';

export interface R2Limits {
    storage_bytes: number;
    class_a: number;
    class_b: number;
}

/** Cloudflare's free tier. Storage in thousands (10 GB = 10,000,000,000 bytes), the stricter reading. */
export const R2_CEILINGS: Readonly<R2Limits> = Object.freeze({ storage_bytes: 10_000_000_000, class_a: 1_000_000, class_b: 10_000_000 });

/** What the app keeps to unless the owner lowers it further: a margin under each ceiling. */
export const R2_DEFAULT_LIMITS: Readonly<R2Limits> = Object.freeze({ storage_bytes: 9 * 1024 ** 3, class_a: 900_000, class_b: 9_000_000 });

/** How many Class B operations one instance reserves at a time. */
export const R2_READ_BATCH = 50;

/** The share of a limit at which the owner is warned. */
export const R2_WARN_FRACTION = 0.8;

export type R2LimitKind = 'storage' | 'class_a' | 'class_b';
const LIMIT_FIELD: Readonly<Record<R2LimitKind, keyof R2Limits>> = { storage: 'storage_bytes', class_a: 'class_a', class_b: 'class_b' };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** The stored limits, each clamped to its ceiling. Anything missing or unreadable is the default. */
export function parseLimits(raw: string | null): R2Limits {
    let parsed: Record<string, unknown> = {};
    try {
        const value = raw ? JSON.parse(raw) : {};
        if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
        // an unreadable record is the defaults
    }
    const pick = (field: keyof R2Limits): number => {
        const value = parsed[field];
        return isCount(value) ? Math.min(value, R2_CEILINGS[field]) : Math.min(R2_DEFAULT_LIMITS[field], R2_CEILINGS[field]);
    };
    return { storage_bytes: pick('storage_bytes'), class_a: pick('class_a'), class_b: pick('class_b') };
}

/** What a save may carry: every limit a whole number from 1 up to its ceiling, never above. Every problem is reported. */
export function checkLimitsInput(input: unknown): { ok: true; value: R2Limits } | { ok: false; error: string; field: keyof R2Limits | null } {
    if (!input || typeof input !== 'object') return { ok: false, error: 'Send the limits as {storage_bytes, class_a, class_b}.', field: null };
    const body = input as Record<string, unknown>;
    const out: Partial<R2Limits> = {};
    for (const field of ['storage_bytes', 'class_a', 'class_b'] as const) {
        const value = body[field];
        if (!isCount(value)) return { ok: false, error: `${field} must be a whole number of at least 1.`, field };
        if (value > R2_CEILINGS[field]) {
            return { ok: false, error: `${field} cannot be above Cloudflare's free tier (${R2_CEILINGS[field].toLocaleString('en-US')}): limits can only be lower.`, field };
        }
        out[field] = value;
    }
    return { ok: true, value: out as R2Limits };
}

export async function readLimits(): Promise<R2Limits> {
    return parseLimits(await getSetting(APP_SETTING_KEYS.r2Limits));
}

// ─── The month ───────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM`, the UTC month. */
export function monthKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 7);
}

/** The first instant of the next UTC month: when the counters start again. */
export function nextReset(now: Date = new Date()): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export const usageKeyFor = (month: string): string => `storage.r2_usage.${month}`;

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1).replace(/\.0$/, '')} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.round(bytes / 1e3)} KB`;
}

const formatCount = (n: number): string => n.toLocaleString('en-US');

/** A limit is reached: the request was not sent, or the file was not written. Answered 409 `R2_LIMIT` to a writer, 503 to a reader. */
export class R2LimitError extends Error {
    readonly code = 'R2_LIMIT' as const;
    /** Plain data the dashboard's translated sentence fills in (`errors.R2_LIMIT`). */
    readonly params: { kind: R2LimitKind; used: string; limit: string; resets: string };
    constructor(readonly kind: R2LimitKind, readonly used: number, readonly limit: number, resetsAt: string = nextReset()) {
        const fmt = kind === 'storage' ? formatBytes : formatCount;
        const resets = resetsAt.slice(0, 10);
        super(kind === 'storage'
            ? `Cloudflare R2's free storage is full (${fmt(used)} of ${fmt(limit)}). Switch new uploads to Supabase or free up space.`
            : `Cloudflare R2's free ${kind === 'class_a' ? 'write' : 'read'} allowance for this month is used up (${fmt(used)} of ${fmt(limit)}). It resets on ${resets}. Switch new uploads to Supabase, or wait.`);
        this.name = 'R2LimitError';
        this.params = { kind, used: fmt(used), limit: fmt(limit), resets };
    }
}

/** The counter could not be read or written, so nothing was sent: the app does not guess about money-free-tier limits. */
export class R2CounterError extends Error {
    constructor(cause: unknown) {
        super(`Cloudflare R2 was not used because its usage counter could not be updated: ${(cause as Error)?.message ?? 'database error'}`);
        this.name = 'R2CounterError';
    }
}

// ─── The reserve ─────────────────────────────────────────────────────────────────────────────

/** What the R2 client asks before every request. */
export interface R2Guard {
    /** Count `n` operations of the class BEFORE sending. Resolves when they may be sent; throws `R2LimitError` or `R2CounterError` when not. */
    reserve(cls: 'A' | 'B', n?: number): Promise<void>;
}

/**
 * ONE statement, atomic in Postgres: add to the month's row only if every counter being raised stays within its limit, and say what the row is
 * now. A class whose add is 0 is not checked, so a Class B read is never refused because the owner lowered the Class A limit below what is used.
 * $1 key, $2 add A, $3 add B, $4 limit A, $5 limit B.
 */
export const RESERVE_SQL = `
    INSERT INTO app_settings (key, value, is_secret, updated_at)
    SELECT $1::varchar, json_build_object('a', $2::bigint, 'b', $3::bigint)::text, false, NOW()
     WHERE ($2::bigint = 0 OR $2::bigint <= $4::bigint)
       AND ($3::bigint = 0 OR $3::bigint <= $5::bigint)
    ON CONFLICT (key) DO UPDATE
       SET value = json_build_object(
                       'a', (app_settings.value::json->>'a')::bigint + $2::bigint,
                       'b', (app_settings.value::json->>'b')::bigint + $3::bigint)::text,
           updated_at = NOW()
     WHERE ($2::bigint = 0 OR (app_settings.value::json->>'a')::bigint + $2::bigint <= $4::bigint)
       AND ($3::bigint = 0 OR (app_settings.value::json->>'b')::bigint + $3::bigint <= $5::bigint)
    RETURNING value`;

export interface Counters { a: number; b: number }

function parseCounters(raw: string | null | undefined): Counters {
    try {
        const v = JSON.parse(raw ?? '{}') as { a?: unknown; b?: unknown };
        return { a: Number(v.a) || 0, b: Number(v.b) || 0 };
    } catch {
        return { a: 0, b: 0 };
    }
}

export async function readCounters(month: string = monthKey()): Promise<Counters> {
    const row = await queryOne<{ value: string | null }>('SELECT value FROM app_settings WHERE key = $1', [usageKeyFor(month)]);
    return parseCounters(row?.value);
}

export class R2UsageGuard implements R2Guard {
    private month = '';
    private local: Counters = { a: 0, b: 0 };

    constructor(private readonly options: { readBatch?: number; limits?: () => Promise<R2Limits> } = {}) {}

    private async tryReserve(month: string, add: Counters, limits: R2Limits): Promise<Counters | null> {
        const row = await queryOne<{ value: string }>(RESERVE_SQL, [usageKeyFor(month), add.a, add.b, limits.class_a, limits.class_b]);
        return row ? parseCounters(row.value) : null;
    }

    async reserve(cls: 'A' | 'B', n = 1): Promise<void> {
        const month = monthKey();
        if (this.month !== month) {
            // A new month: what an old batch had left was counted in the old month, and does not carry over.
            this.month = month;
            this.local = { a: 0, b: 0 };
        }
        const field = cls === 'A' ? 'a' : 'b';
        if (this.local[field] >= n) {
            this.local[field] -= n;
            return;
        }
        let limits: R2Limits;
        try {
            limits = await (this.options.limits ?? readLimits)();
        } catch (err) {
            log('error', 'media.r2_counter_unreadable', describeError(err));
            throw new R2CounterError(err);
        }
        const batch = cls === 'B' ? Math.max(n, this.options.readBatch ?? R2_READ_BATCH) : n;
        const ask = (count: number): Counters => (cls === 'A' ? { a: count, b: 0 } : { a: 0, b: count });
        let now: Counters | null;
        let granted = batch;
        try {
            now = await this.tryReserve(month, ask(batch), limits);
            if (!now && batch > n) {
                // Not room for a whole batch: take exactly what this request needs, if that fits.
                granted = n;
                now = await this.tryReserve(month, ask(n), limits);
            }
        } catch (err) {
            log('error', 'media.r2_counter_failed', describeError(err));
            throw new R2CounterError(err);
        }
        if (!now) {
            let used = 0;
            try {
                const counters = await readCounters(month);
                used = cls === 'A' ? counters.a : counters.b;
            } catch {
                used = cls === 'A' ? limits.class_a : limits.class_b;
            }
            log('warn', 'media.r2_limit_reached', { class: cls, used_ops: used, limit_ops: cls === 'A' ? limits.class_a : limits.class_b, month });
            throw new R2LimitError(cls === 'A' ? 'class_a' : 'class_b', used, cls === 'A' ? limits.class_a : limits.class_b, nextReset());
        }
        // Reserved `granted`, uses `n` now; the rest is this instance's own, if the month has not turned in the meantime.
        if (this.month === month) this.local[field] += granted - n;
    }

    /** Forget any local batch — tests only. */
    reset(): void {
        this.month = '';
        this.local = { a: 0, b: 0 };
    }
}

let sharedGuard: R2Guard | null = null;
let guardOverride: R2Guard | null = null;

/** The guard every R2 client of this instance shares, so one batch serves them all. */
export function r2Guard(): R2Guard {
    if (guardOverride) return guardOverride;
    sharedGuard ??= new R2UsageGuard();
    return sharedGuard;
}

/** Substitute the guard — tests only. Returns the previous override. */
export function setR2Guard(next: R2Guard | null): R2Guard | null {
    const previous = guardOverride;
    guardOverride = next;
    return previous;
}

// ─── Storage ─────────────────────────────────────────────────────────────────────────────────

/** Bytes in R2 as the rows record them: every `r2:` row, including one signed but not yet confirmed. */
export async function r2StoredBytes(): Promise<number> {
    const row = await queryOne<{ bytes: string | number | null }>("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM media_uploads WHERE storage_path LIKE 'r2:%'");
    return Number(row?.bytes ?? 0) || 0;
}

/**
 * Whether `addBytes` more fit in R2's storage limit. Throws `R2LimitError('storage')` when not, and `R2CounterError` when the sum cannot be
 * read: a write that cannot be measured is not made.
 */
export async function assertR2Room(addBytes: number, options: { limit?: number } = {}): Promise<void> {
    let used: number;
    let limit: number;
    try {
        used = await r2StoredBytes();
        limit = options.limit ?? (await readLimits()).storage_bytes;
    } catch (err) {
        log('error', 'media.r2_counter_unreadable', describeError(err));
        throw new R2CounterError(err);
    }
    if (used + Math.max(0, addBytes) > limit) {
        log('warn', 'media.r2_limit_reached', { class: 'storage', used_ops: used, limit_ops: limit, add_bytes: addBytes });
        throw new R2LimitError('storage', used, limit);
    }
}

/**
 * A look, without spending anything, at whether this month still has room for a write: for the copy job, which should not download a file from
 * Supabase (its own egress) for an upload that R2's counter would then refuse. Not a reservation: the upload itself reserves, and may still be refused.
 */
export async function assertR2WriteRoom(): Promise<void> {
    let used: number;
    let limit: number;
    try {
        [used, limit] = await Promise.all([readCounters().then((c) => c.a), readLimits().then((l) => l.class_a)]);
    } catch (err) {
        log('error', 'media.r2_counter_unreadable', describeError(err));
        throw new R2CounterError(err);
    }
    if (used >= limit) {
        log('warn', 'media.r2_limit_reached', { class: 'A', used_ops: used, limit_ops: limit });
        throw new R2LimitError('class_a', used, limit);
    }
}

// ─── What the card and the banners show ──────────────────────────────────────────────────────

export interface R2UsageItem {
    kind: R2LimitKind;
    used: number;
    limit: number;
    ceiling: number;
    /** Whole percent of the limit, not capped. */
    pct: number;
}

export interface R2UsageSummary {
    month: string;
    resetsAt: string;
    limits: R2Limits;
    ceilings: R2Limits;
    items: R2UsageItem[];
    /** `full`: some limit is reached; `warn`: some is at 80% or more; else `ok`. */
    level: 'ok' | 'warn' | 'full';
}

export function summarize(used: { storage_bytes: number; class_a: number; class_b: number }, limits: R2Limits, now: Date = new Date()): R2UsageSummary {
    const items = (['storage', 'class_a', 'class_b'] as const).map((kind): R2UsageItem => {
        const field = LIMIT_FIELD[kind];
        return { kind, used: used[field], limit: limits[field], ceiling: R2_CEILINGS[field], pct: Math.floor((used[field] / limits[field]) * 100) };
    });
    const level = items.some((i) => i.used >= i.limit) ? 'full' : items.some((i) => i.used >= i.limit * R2_WARN_FRACTION) ? 'warn' : 'ok';
    return { month: monthKey(now), resetsAt: nextReset(now), limits, ceilings: { ...R2_CEILINGS }, items, level };
}

/** This month's usage against the limits. Throws on a database error: the callers that show it decide what an unread counter looks like. */
export async function readR2Summary(now: Date = new Date()): Promise<R2UsageSummary> {
    const [counters, bytes, limits] = await Promise.all([readCounters(monthKey(now)), r2StoredBytes(), readLimits()]);
    return summarize({ storage_bytes: bytes, class_a: counters.a, class_b: counters.b }, limits, now);
}

export interface R2Banner {
    level: 'warn' | 'full';
    resetsAt: string;
    items: Array<{ kind: R2LimitKind; pct: number }>;
}

let bannerCache: { at: number; value: R2Banner | null } | null = null;
const BANNER_TTL_MS = 60_000;

/**
 * What Today shows (`GET /api/health/tenant`, platform admin): null while R2 is not configured or every limit is under 80%. Kept for a minute per
 * instance, because that endpoint is polled. Never throws: an unread counter shows no banner (the drain's email check still runs).
 */
export async function readR2Banner(now: Date = new Date()): Promise<R2Banner | null> {
    if (bannerCache && Date.now() - bannerCache.at < BANNER_TTL_MS) return bannerCache.value;
    let value: R2Banner | null = null;
    try {
        if (await getR2Config()) {
            const summary = await readR2Summary(now);
            if (summary.level !== 'ok') {
                value = {
                    level: summary.level, resetsAt: summary.resetsAt,
                    items: summary.items.filter((i) => i.used >= i.limit * R2_WARN_FRACTION).map((i) => ({ kind: i.kind, pct: i.pct })),
                };
            }
        }
    } catch (err) {
        log('warn', 'media.r2_banner_unread', describeError(err));
    }
    bannerCache = { at: Date.now(), value };
    return value;
}

/** Forget the cached banner — tests, and after a save. */
export function clearR2BannerCache(): void {
    bannerCache = null;
}

// ─── The owner's email ───────────────────────────────────────────────────────────────────────

interface AlertRecord { day: string; kinds: string[] }

function parseAlerted(raw: string | null): AlertRecord | null {
    try {
        const v = JSON.parse(raw ?? 'null') as { day?: unknown; kinds?: unknown } | null;
        if (v && typeof v.day === 'string' && Array.isArray(v.kinds)) return { day: v.day, kinds: v.kinds.filter((k): k is string => typeof k === 'string') };
    } catch {
        // an unreadable record is no record: the owner is told again rather than never
    }
    return null;
}

const LABELS: Readonly<Record<R2LimitKind, { en: string; ar: string }>> = {
    storage: { en: 'storage', ar: 'مساحة التخزين' },
    class_a: { en: 'write operations (Class A)', ar: 'عمليات الكتابة (Class A)' },
    class_b: { en: 'read operations (Class B)', ar: 'عمليات القراءة (Class B)' },
};

export function buildR2Alert(items: readonly R2UsageItem[], resetsAt: string, settingsUrl: string): { subject: string; text: string } {
    const fmt = (i: R2UsageItem, n: number) => (i.kind === 'storage' ? formatBytes(n) : formatCount(n));
    const full = items.some((i) => i.used >= i.limit);
    const lines = items.map((i) => `- ${LABELS[i.kind].en}: ${fmt(i, i.used)} of ${fmt(i, i.limit)} (${i.pct}%)`);
    const linesAr = items.map((i) => `- ${LABELS[i.kind].ar}: ${fmt(i, i.used)} من ${fmt(i, i.limit)} (${i.pct}%)`);
    const reset = resetsAt.slice(0, 10);
    const text = [
        full
            ? 'Cloudflare R2\'s free tier is used up. New uploads to R2 are refused (and R2 files cannot be served) until it resets or you act.'
            : 'Cloudflare R2 is above 80% of its free tier.',
        ...lines,
        `Operations reset on ${reset} (UTC). Storage frees up only when files are deleted. Our count covers requests this app makes: Cloudflare's own dashboard is the final word.`,
        `Settings: ${settingsUrl}`,
        '',
        full
            ? 'وصل استخدام Cloudflare R2 إلى حد الباقة المجانية: تُرفض الرفعات الجديدة إلى R2 ولا تُعرض ملفاته حتى يتجدد الشهر أو تتدخل.'
            : 'استخدام Cloudflare R2 تجاوز 80% من الباقة المجانية.',
        ...linesAr,
        `تتجدد العمليات في ${reset} (UTC). مساحة التخزين لا تتحرر إلا بحذف الملفات.`,
    ].join('\n');
    return { subject: full ? 'Cloudflare R2 free tier reached' : 'Cloudflare R2 is above 80% of its free tier', text };
}

/**
 * Email the owner (and Telegram, if the deployment's bot is on) once a day per limit that is at 80% or more. A day on which nothing could be sent is not
 * marked told, so the next drain tries again. Read-then-write, not a claim: two drains in the same instant can both send, which costs one extra message.
 * Never throws: it runs inside the drain. Cheap while R2 is not configured: one settings read.
 */
export async function checkR2Warnings(options: { now?: Date; settingsUrl?: string } = {}): Promise<{ alerted: R2LimitKind[] }> {
    const now = options.now ?? new Date();
    try {
        if (!(await getR2Config())) return { alerted: [] };
        const summary = await readR2Summary(now);
        const hot = summary.items.filter((i) => i.used >= i.limit * R2_WARN_FRACTION);
        if (hot.length === 0) return { alerted: [] };
        const day = now.toISOString().slice(0, 10);
        const stored = parseAlerted(await getSetting(APP_SETTING_KEYS.r2Alerted));
        const known = stored && stored.day === day ? stored.kinds : [];
        const fresh = hot.filter((i) => !known.includes(i.kind));
        if (fresh.length === 0) return { alerted: [] };

        const { subject, text } = buildR2Alert(fresh, summary.resetsAt, options.settingsUrl ?? '/dashboard#/settings?s=storage');
        const channels = await readNotifyChannels();
        let sent = false;
        const tg = channels.telegram;
        if (telegramReady(tg)) {
            const r = await sendTelegramMessage({ token: tg.token, chatId: tg.chatId }, text);
            sent = sent || r.ok;
            if (!r.ok) log('warn', 'media.r2_alert_telegram_failed', { reason: r.reason, status: r.status });
        }
        const to = effectiveTo(channels.email);
        if (emailReady(channels.email) && to) {
            const r = await sendEmail({ apiKey: channels.email.apiKey, to, from: channels.email.from }, { subject, text });
            sent = sent || r.ok;
            if (!r.ok) log('warn', 'media.r2_alert_email_failed', { reason: r.reason, status: r.status });
        }
        log('warn', 'media.r2_warning', { kinds: fresh.map((i) => i.kind), sent });
        if (!sent) return { alerted: [] };
        await setSetting(APP_SETTING_KEYS.r2Alerted, JSON.stringify({ day, kinds: [...new Set([...known, ...fresh.map((i) => i.kind)])] }), null);
        return { alerted: fresh.map((i) => i.kind) };
    } catch (err) {
        log('error', 'media.r2_warning_failed', describeError(err));
        return { alerted: [] };
    }
}
