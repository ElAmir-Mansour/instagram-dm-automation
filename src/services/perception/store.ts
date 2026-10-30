/**
 * What perception reads and writes in Postgres (docs/specs/005-muse-sees data-model.md): the record on the inbound row, and the owner's saved notes on a reel.
 *
 *   readStoredPerception   `messages.perception` of one row, or null (never ran, or not a record this code wrote). A RETRY reads it and reuses it, so a job that
 *                          runs again never pays for the same media twice and never asks Meta about it twice.
 *   storePerception        `UPDATE messages SET perception = …, text = … WHERE id = $1 AND perception IS NULL`: written ONCE. The row's `text` is overwritten in the
 *                          same statement with the readable text when there is one (the description line), so history, later turns and the inbox all read it. It returns the
 *                          record as stored, or null when the row already had one (another attempt got there first): the caller reads that one.
 *   readReelAnalysis       the library's row for one of the creator's own reels (`reel_analyses`, status `ok`), which answers a shared reel without a model call.
 *
 * **`stored_at` is the DATABASE's clock** (`NOW()` in the same statement), because the sales turn's burst rule compares it with the `created_at` of the replies
 * (`supersession`, dmSales/store.ts), and both must be one clock: an application server a second ahead of the database would make a reply sent before the
 * perception look as if it came after it.
 *
 * Every statement names the tenant. Nothing here logs a description: the record is data, and a log line carries ids and a status.
 */
import { queryOne } from '../../db/query.js';
import { isPerceivableKind, PERCEPTION_STATUSES, ABOUT_OWNER, type AboutOwner, type Perception, type PerceptionReason, type PerceptionStatus } from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * A stored value as a `Perception`, or null when it is not one this code wrote: not an object, not version 1, a kind perception does not read, a status that is
 * not in the list, or no time. The fields a reader may leave out stay absent. Pure.
 */
export function parseStoredPerception(value: unknown): Perception | null {
    if (!isObj(value) || value['v'] !== 1) return null;
    const kind = value['kind'];
    const status = value['status'];
    const storedAt = str(value['stored_at']);
    if (!isPerceivableKind(kind) || typeof status !== 'string' || !(PERCEPTION_STATUSES as readonly string[]).includes(status) || !storedAt) return null;
    const owner = value['about_owner'];
    const recall = value['recall'];
    return {
        v: 1,
        kind,
        status: status as PerceptionStatus,
        ...(str(value['reason']) ? { reason: str(value['reason']) as PerceptionReason } : {}),
        ...(str(value['seen']) !== undefined ? { seen: str(value['seen'])! } : {}),
        ...(str(value['transcript']) !== undefined ? { transcript: str(value['transcript'])! } : {}),
        ...(typeof owner === 'string' && (ABOUT_OWNER as readonly string[]).includes(owner) ? { about_owner: owner as AboutOwner } : {}),
        ...(num(value['confidence']) !== undefined ? { confidence: num(value['confidence'])! } : {}),
        ...(str(value['mention_summary']) !== undefined ? { mention_summary: str(value['mention_summary'])! } : {}),
        ...(isObj(recall) && typeof recall['reel_id'] === 'string' && typeof recall['permalink'] === 'string' && num(recall['second']) !== undefined
            ? { recall: { reel_id: recall['reel_id'], permalink: recall['permalink'], second: num(recall['second'])! } }
            : {}),
        model: str(value['model']) ?? '',
        stored_at: storedAt,
        ms: num(value['ms']) ?? 0,
        usd: num(value['usd']) ?? 0,
    };
}

/** `messages.perception` of one inbound row, or null. */
export async function readStoredPerception(messageId: string, creatorId: string): Promise<Perception | null> {
    const row = await queryOne<{ perception: unknown }>('SELECT perception FROM messages WHERE id = $1 AND creator_id = $2', [messageId, creatorId]);
    return parseStoredPerception(row?.perception);
}

export interface StoreInput {
    messageId: string;
    creatorId: string;
    perception: Omit<Perception, 'stored_at'>;
    /** The row's new `text` (`perceivedText`); null leaves what is there: a perception that was not understood, or a story reply the person wrote words to. */
    text: string | null;
}

/** Write the perception once. The record as stored (with the database's `stored_at`), or null when the row already had one. */
export async function storePerception(input: StoreInput): Promise<Perception | null> {
    const row = await queryOne<{ perception: unknown }>(
        `UPDATE messages
            SET perception = $3::jsonb || jsonb_build_object('stored_at', to_jsonb(NOW())),
                text = COALESCE($4::text, text)
          WHERE id = $1 AND creator_id = $2 AND perception IS NULL
      RETURNING perception`,
        [input.messageId, input.creatorId, JSON.stringify(input.perception), input.text]
    );
    return parseStoredPerception(row?.perception);
}

/** What the library keeps of one reel the indexer has watched: its result as stored (the shape in `contracts/perception.md` §4), and the model that watched it. */
export interface ReelAnalysis {
    result: unknown;
    model: string | null;
}

/** The library's analysis of one of THIS tenant's reels, only when it ended `ok`; null for no row, a pending one or a failed one. */
export async function readReelAnalysis(creatorId: string, igMediaId: string): Promise<ReelAnalysis | null> {
    return queryOne<ReelAnalysis>(
        `SELECT result, model FROM reel_analyses WHERE creator_id = $1 AND ig_media_id = $2 AND status = 'ok' LIMIT 1`,
        [creatorId, igMediaId]
    );
}
