/**
 * "Copy existing files to R2": the Supabase objects a deployment already holds, copied to Cloudflare R2 a few at a time by the drain.
 *
 * The owner asks once on the Settings card (`storage.r2_copy` = `{requested_at, …}`); every drain after that (`GET /api/jobs/drain`, about once a
 * minute) copies a small batch within a time and size budget (`COPY_BUDGET_MS`, `COPY_BUDGET_BYTES`) until none remain. Resumable and harmless
 * to repeat: a file already in R2 is no longer a candidate, and a refusal just ends this call's batch for the next drain to try again.
 *
 * Per file: free-tier room check (`assertR2Room`) → download from Supabase → upload to R2 (Class A) → `headObject` (Class B) to verify the size →
 * `UPDATE media_uploads SET storage_path = 'r2:' || … WHERE id = $1 AND storage_path = <the old one>`, so a concurrent change to the row wins.
 * The Supabase copy is LEFT in place: a later clean-up can remove it once the owner is happy (nothing here deletes it, and the deletion queue
 * names only the new `r2:` path from then on).
 *
 * A Supabase refusal (the quota that motivated this, a bad key, an outage) or an R2 refusal (a free-tier limit, a bad token) stops the batch,
 * is logged once per distinct reason, and is kept on the card as `last_error`. A file Supabase says does not exist is skipped and counted
 * (`skipped`), never retried by this request. Never throws: the drain's other work goes on regardless.
 */
import { queryCount, queryOne, queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { APP_SETTING_KEYS, getMediaConfigs, getSetting, setSetting } from './appSettings.js';
import { R2StorageClient } from './r2Storage.js';
import { assertR2Room, assertR2WriteRoom, R2CounterError, R2LimitError } from './r2Usage.js';
import { bucketForPath, R2_PATH_PREFIX, StorageApiError, SupabaseStorageClient } from './supabaseStorage.js';

/** One drain call copies for at most this long and this many bytes (a file already started is finished). */
export const COPY_BUDGET_MS = 25_000;
export const COPY_BUDGET_BYTES = 150 * 1024 * 1024;
const COPY_PAGE = 25;
const MAX_SKIPPED = 500;

export interface R2CopyState {
    requested_at: string;
    done_at: string | null;
    last_error: string | null;
    /** Files Supabase reports as missing: never retried by this request. */
    skipped: string[];
}

export interface R2CopyStatus {
    /** The owner asked for it and it has not finished. */
    active: boolean;
    requestedAt: string | null;
    doneAt: string | null;
    lastError: string | null;
    /** Object rows in R2, and every object row (R2 + still in Supabase): "N of M". */
    inR2: number;
    total: number;
    skipped: number;
}

function parseState(raw: string | null): R2CopyState | null {
    try {
        const v = JSON.parse(raw ?? 'null') as Partial<R2CopyState> | null;
        if (v && typeof v.requested_at === 'string') {
            return {
                requested_at: v.requested_at,
                done_at: typeof v.done_at === 'string' ? v.done_at : null,
                last_error: typeof v.last_error === 'string' ? v.last_error : null,
                skipped: Array.isArray(v.skipped) ? v.skipped.filter((x): x is string => typeof x === 'string').slice(0, MAX_SKIPPED) : [],
            };
        }
    } catch {
        // an unreadable record is no request
    }
    return null;
}

const save = (state: R2CopyState): Promise<void> => setSetting(APP_SETTING_KEYS.r2Copy, JSON.stringify(state), null);

/** The owner pressed the button: start (or restart) the copy. */
export async function requestCopy(updatedBy: string | null, now: Date = new Date()): Promise<void> {
    await setSetting(APP_SETTING_KEYS.r2Copy, JSON.stringify({ requested_at: now.toISOString(), done_at: null, last_error: null, skipped: [] } satisfies R2CopyState), updatedBy);
}

export async function readCopyStatus(): Promise<R2CopyStatus> {
    const [state, counts] = await Promise.all([
        getSetting(APP_SETTING_KEYS.r2Copy).then(parseState),
        queryOne<{ in_r2: string; elsewhere: string }>(
            `SELECT count(*) FILTER (WHERE storage_path LIKE 'r2:%')                                AS in_r2,
                    count(*) FILTER (WHERE storage_path IS NOT NULL AND storage_path NOT LIKE 'r2:%') AS elsewhere
               FROM media_uploads`
        ),
    ]);
    const inR2 = Number(counts?.in_r2 ?? 0) || 0;
    const elsewhere = Number(counts?.elsewhere ?? 0) || 0;
    return {
        active: Boolean(state && !state.done_at),
        requestedAt: state?.requested_at ?? null,
        doneAt: state?.done_at ?? null,
        lastError: state?.last_error ?? null,
        inR2, total: inR2 + elsewhere,
        skipped: state?.skipped.length ?? 0,
    };
}

export interface CopyBatchResult {
    /** A request was waiting and this call looked at it. */
    ran: boolean;
    copied: number;
    skipped: number;
    /** Why the batch stopped early, when it did. */
    stoppedBecause: string | null;
    /** Nothing is left to copy: the request is finished. */
    done: boolean;
}

const idle: CopyBatchResult = { ran: false, copied: 0, skipped: 0, stoppedBecause: null, done: false };

function reasonOf(err: unknown): string {
    if (err instanceof R2LimitError || err instanceof R2CounterError) return err.message;
    if (err instanceof StorageApiError) return err.message;
    return (err as Error)?.message ?? 'unknown error';
}

/**
 * One batch. `deadline` is an absolute time (ms): no new file starts after it. Never throws.
 */
export async function runCopyBatch(options: { deadline?: number; maxBytes?: number } = {}): Promise<CopyBatchResult> {
    const deadline = options.deadline ?? Date.now() + COPY_BUDGET_MS;
    const maxBytes = options.maxBytes ?? COPY_BUDGET_BYTES;
    try {
        const state = parseState(await getSetting(APP_SETTING_KEYS.r2Copy));
        if (!state || state.done_at) return idle;

        const stop = async (reason: string): Promise<CopyBatchResult> => {
            if (state.last_error !== reason) {
                log('warn', 'media.r2_copy_stopped', { reason });
                state.last_error = reason;
                await save(state);
            }
            return { ran: true, copied, skipped, stoppedBecause: reason, done: false };
        };
        let copied = 0;
        let skipped = 0;

        const { supabase, r2: r2Config } = await getMediaConfigs();
        if (!supabase || !r2Config) return await stop('Both Supabase Storage and Cloudflare R2 must be set up to copy files from one to the other.');
        const r2 = new R2StorageClient(r2Config);
        const sources = new Map<string, SupabaseStorageClient>();
        const sourceFor = (path: string): SupabaseStorageClient => {
            const bucket = bucketForPath(path);
            if (!sources.has(bucket)) sources.set(bucket, new SupabaseStorageClient({ url: supabase.url, key: supabase.key, bucket }));
            return sources.get(bucket)!;
        };

        const rows = await queryRows<{ id: string; storage_path: string; mime_type: string; size_bytes: string | number | null }>(
            `SELECT id, storage_path, mime_type, size_bytes
               FROM media_uploads
              WHERE storage_path IS NOT NULL AND storage_path NOT LIKE 'r2:%' AND id <> ALL($1::uuid[])
              ORDER BY id
              LIMIT ${COPY_PAGE}`,
            [state.skipped]
        );
        if (rows.length === 0) {
            state.done_at = new Date().toISOString();
            state.last_error = null;
            await save(state);
            log('info', 'media.r2_copy_done', { skipped: state.skipped.length });
            return { ran: true, copied: 0, skipped: 0, stoppedBecause: null, done: true };
        }

        let bytes = 0;
        for (const row of rows) {
            const size = Number(row.size_bytes ?? 0) || 0;
            if (Date.now() >= deadline) break;
            if (copied > 0 && bytes + size > maxBytes) break;

            // The free tier first: never copy what R2 may not hold.
            try {
                await assertR2Room(size);
                await assertR2WriteRoom();
            } catch (err) {
                return await stop(reasonOf(err));
            }

            const oldPath = row.storage_path;
            let data: Buffer | null;
            try {
                data = await sourceFor(oldPath).download(oldPath);
            } catch (err) {
                // Supabase refused (its quota, a bad key, an outage): stop here, the next drain tries again.
                return await stop(reasonOf(err));
            }
            if (!data) {
                log('warn', 'media.copy_object_missing', { media_id: row.id, storage_path: oldPath });
                state.skipped.push(row.id);
                skipped++;
                await save(state);
                continue;
            }

            try {
                await r2.upload(oldPath, data, row.mime_type);
                const head = await r2.headObject(oldPath);
                if (!head || (head.size !== null && head.size !== data.length)) {
                    throw new StorageApiError(502, null, `Cloudflare R2 holds ${head?.size ?? 'no'} bytes of ${row.id}, not the ${data.length} copied: left as it was.`);
                }
            } catch (err) {
                return await stop(reasonOf(err));
            }

            const newPath = `${R2_PATH_PREFIX}${oldPath}`;
            const changed = await queryCount('UPDATE media_uploads SET storage_path = $3 WHERE id = $1 AND storage_path = $2', [row.id, oldPath, newPath]);
            if (changed === 0) {
                // The row changed (or another drain copied it first) while this one worked: that change wins. Take our R2 object back out only when
                // the row does NOT now name it, so a concurrent copy's good object is never deleted.
                const now = await queryOne<{ storage_path: string | null }>('SELECT storage_path FROM media_uploads WHERE id = $1', [row.id]);
                if (now?.storage_path !== newPath) await r2.remove([oldPath]).catch(() => undefined);
                log('info', 'media.r2_copy_superseded', { media_id: row.id });
                continue;
            }
            copied++;
            bytes += data.length;
        }

        if (state.last_error) {
            state.last_error = null;
            await save(state);
        }
        if (copied > 0) log('info', 'media.r2_copied', { count: copied, bytes_copied: bytes });
        return { ran: true, copied, skipped, stoppedBecause: null, done: false };
    } catch (err) {
        log('error', 'media.r2_copy_failed', describeError(err));
        return idle;
    }
}
