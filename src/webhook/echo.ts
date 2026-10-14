/**
 * Echo takeover (docs/DM_SALES_PLAN.md §8 and assumption A4, S8): when the owner answers a customer by hand, the bot stops answering that
 * customer.
 *
 * An echo (`message.is_echo`) is a message the ACCOUNT sent coming back to us as a webhook. Most are ours (the bot's reply, a dashboard
 * reply, a private reply to a comment), and a few are the owner typing in the Instagram app. Pausing on the first kind would silence the
 * bot after every reply it sends, so the whole feature rests on telling the two apart, and on doing NOTHING when that cannot be done.
 *
 * **What the classification relies on, and what it does not (A4).** Meta documents `is_echo` for Instagram ("the message is sent from
 * the Instagram account itself", webhooks reference for Instagram messaging), and nothing else that separates a person from an app. It
 * documents `app_id` only for Messenger's `message_echoes`: "the app that sent the message", which is the Facebook Page inbox app's own id
 * for a message sent from the Page inbox (Graph API v12.0 and later). It does NOT document `app_id` on an Instagram echo, nor what the
 * Instagram app itself sends. So the evidence used is `app_id`, and only when it is there:
 *
 *   own      `app_id` is this deployment's own app (`META_APP_ID`, `INSTAGRAM_APP_ID`): our send. Nothing to do.
 *   owner    `app_id` is one of the ids that mean "a person typed this": the Page inbox app's (documented), plus any the operator adds
 *            from Settings after reading the log. The bot is paused.
 *   unknown  anything else: no `app_id` at all (what an Instagram-app reply may well look like: UNPROVEN), or another app's (a tool such
 *            as ManyChat, which is not the owner). NOTHING happens and it is logged (`dm.echo_classified`, with the `app_id` seen), because a
 *            wrong pause silences the bot for a real customer and a missed one costs one extra bot reply. Not guessed from timing or from
 *            "we did not send that": a private reply to a comment is sent by us and is not in `messages`.
 *
 * **Off by default** (`dm.echo_takeover`), because A4 says to look at real echoes of each kind before pausing on them. Turning it on is how
 * that evidence is gathered: every echo is then classified and logged with its `app_id`. Off, an echo is dropped before it becomes a job
 * (`router.ts`), exactly as before this existed.
 *
 * **It only pauses, and records. It never sends.** The conversation's bot switch goes off (the one the inbox toggle and a manual reply
 * use), and the owner's message is stored as an `operator` row, keyed on Meta's message id so a redelivery changes nothing: the inbox
 * shows his words, a thread waiting for a person stops being "Needs you", and, when he hands the conversation back, the model reads what
 * he said.
 */
import { queryOne, queryCount } from '../db/query.js';
import { getSetting, getSettings, setSetting, APP_SETTING_KEYS } from '../services/appSettings.js';
import { getCreatorByPageId } from '../services/tenant.js';
import { log, withLogContext } from '../utils/log.js';

/**
 * The Facebook Page inbox app, whose id `app_id` carries for a message sent from the Page inbox (Messenger `message_echoes`, v12.0+). Two
 * spellings, because Meta's own references disagree: the echo reference prints the 14-digit one, and the handover-protocol documents (and every
 * vendor that copies them) the 15-digit one. A spelling that is nobody's id never matches, so listing both costs nothing.
 */
export const PAGE_INBOX_APP_IDS: readonly string[] = Object.freeze(['26390203743090', '263902037430900']);

export const MAX_OWNER_APP_IDS = 10;

/** A Meta app id: digits. Nothing else is ever stored or compared. */
export const APP_ID_PATTERN = /^\d{5,20}$/;

/** This deployment's own app ids: the Facebook app and, when it has one of its own, the Instagram app. */
export function ownAppIds(env: NodeJS.ProcessEnv = process.env): string[] {
    return [env['META_APP_ID'], env['INSTAGRAM_APP_ID']]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => APP_ID_PATTERN.test(v));
}

/**
 * The `app_id` of an echo as digits, or null when it carries none. Meta sends it as a string; a JSON number is read too (an id of this length
 * is exact in a double); `0` and '' say nothing.
 */
export function appIdOf(event: unknown): string | null {
    const raw = (event as { message?: { app_id?: unknown } } | null | undefined)?.message?.app_id;
    const text = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    return APP_ID_PATTERN.test(text) && !/^0+$/.test(text) ? text : null;
}

export type EchoVerdict =
    | { kind: 'own'; why: 'our_app' }
    | { kind: 'owner'; why: 'owner_app_id' }
    | { kind: 'unknown'; why: 'no_app_id' | 'other_app' };

/**
 * Whose message is this echo? Pure. `own` is decided first, so an id listed in both places is ours (a mistake in the list can only make
 * the bot answer, never silence it). The only path to `owner` is an `app_id` that is on the owner list: see the top of the file.
 */
export function classifyEcho(appId: string | null, known: { ownAppIds: readonly string[]; ownerAppIds: readonly string[] }): EchoVerdict {
    if (appId === null) return { kind: 'unknown', why: 'no_app_id' };
    if (known.ownAppIds.includes(appId)) return { kind: 'own', why: 'our_app' };
    if (known.ownerAppIds.includes(appId)) return { kind: 'owner', why: 'owner_app_id' };
    return { kind: 'unknown', why: 'other_app' };
}

/** Is this echo certainly this deployment's own send, from the event alone (no database)? Used to keep it out of the queue. */
export function echoFromOwnApp(event: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
    const appId = appIdOf(event);
    return appId !== null && ownAppIds(env).includes(appId);
}

// ─── Settings ───────────────────────────────────────────────────────────────────────────────

export interface EchoSettings {
    takeover: boolean;
    /** What the operator added, in the order saved. */
    extraOwnerAppIds: string[];
    /** The documented ids and the added ones, without ours: what a match is made against. */
    ownerAppIds: string[];
}

/** The ids that mean "a person": the documented ones and the operator's, never one of our own. */
export function effectiveOwnerAppIds(extra: readonly string[], own: readonly string[] = ownAppIds()): string[] {
    return [...new Set([...PAGE_INBOX_APP_IDS, ...extra])].filter((id) => !own.includes(id));
}

/**
 * The operator's list as a person typed it or an API sent it: ids separated by commas, spaces or lines, or a list. Trimmed and de-duplicated;
 * anything that is not an app id is an error that names it, never dropped (a typo must not leave the id the owner meant off the list).
 */
export function parseOwnerAppIds(input: unknown): { ids: string[] } | { error: string } {
    let parts: unknown[];
    if (input === undefined || input === null || input === '') parts = [];
    else if (typeof input === 'string') parts = input.split(/[\s,;،]+/);
    else if (Array.isArray(input)) parts = input;
    else return { error: 'The app ids must be a list of numbers.' };
    const ids: string[] = [];
    for (const part of parts) {
        if (typeof part !== 'string' && typeof part !== 'number') return { error: 'The app ids must be a list of numbers.' };
        const id = String(part).trim();
        if (!id) continue;
        if (!APP_ID_PATTERN.test(id)) return { error: `"${id.slice(0, 40)}" is not an app id: they are numbers only (5 to 20 digits).` };
        if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length > MAX_OWNER_APP_IDS) return { error: `At most ${MAX_OWNER_APP_IDS} app ids.` };
    return { ids };
}

export async function readEchoSettings(): Promise<EchoSettings> {
    const values = await getSettings([APP_SETTING_KEYS.dmEchoTakeover, APP_SETTING_KEYS.dmEchoOwnerAppIds]);
    const parsed = parseOwnerAppIds(values.get(APP_SETTING_KEYS.dmEchoOwnerAppIds) ?? '');
    // A saved list that cannot be read is no extra ids, which is the safe direction (fewer things mean "a person").
    const extra = 'ids' in parsed ? parsed.ids : [];
    return { takeover: values.get(APP_SETTING_KEYS.dmEchoTakeover) === 'true', extraOwnerAppIds: extra, ownerAppIds: effectiveOwnerAppIds(extra) };
}

/** Is takeover switched on? One row. The router asks it only when a delivery holds an echo. */
export async function echoTakeoverEnabled(): Promise<boolean> {
    return (await getSetting(APP_SETTING_KEYS.dmEchoTakeover)) === 'true';
}

export interface EchoInput {
    takeover?: boolean;
    /** The operator's extra ids; an empty list clears them. */
    ownerAppIds?: string[];
}

export async function saveEchoInput(input: EchoInput, updatedBy: string | null): Promise<void> {
    if (input.takeover !== undefined) await setSetting(APP_SETTING_KEYS.dmEchoTakeover, input.takeover ? 'true' : 'false', updatedBy);
    if (input.ownerAppIds !== undefined) await setSetting(APP_SETTING_KEYS.dmEchoOwnerAppIds, input.ownerAppIds.length ? input.ownerAppIds.join(',') : null, updatedBy);
}

// ─── The handler ────────────────────────────────────────────────────────────────────────────

export type EchoOutcome = 'off' | 'own' | 'unclassified' | 'unresolved' | 'no_conversation' | 'paused';

/**
 * One echo. Off (the default): logged at debug and dropped, as it always was. On: classified, and logged WITH what it was classified from;
 * an `owner` echo pauses that customer's conversation and records the owner's message, and everything else is left alone.
 *
 * A failure of the pause throws, so the job runner retries it: a pause that is lost is a bot that talks over the owner. Every statement is
 * idempotent (a second pause, and a message keyed on its Meta id), so a retry changes nothing that was already done.
 */
export async function handleEcho(event: any, entryId: string): Promise<EchoOutcome> {
    const settings = await readEchoSettings();
    if (!settings.takeover) {
        log('debug', 'dm.skipped_echo');
        return 'off';
    }

    const message = event?.message ?? {};
    const mid: string | null = typeof message.mid === 'string' && message.mid ? message.mid : null;
    return withLogContext({ mid }, async () => {
        const appId = appIdOf(event);
        const verdict = classifyEcho(appId, { ownAppIds: ownAppIds(), ownerAppIds: settings.ownerAppIds });
        // The evidence behind every verdict, which is what A4 asks to be read before the owner relies on this. An unknown echo is the one
        // to look at, so it is the one that is not quiet.
        log(verdict.kind === 'own' ? 'debug' : 'info', 'dm.echo_classified', {
            verdict: verdict.kind, why: verdict.why, app_id: appId, has_text: Boolean(message.text), has_metadata: message.metadata !== undefined,
            attachments: Array.isArray(message.attachments) ? message.attachments.length : 0,
        });
        if (verdict.kind === 'own') return 'own';
        if (verdict.kind === 'unknown') return 'unclassified';

        const customerId: unknown = event?.recipient?.id;
        const creator = typeof customerId === 'string' && customerId ? await getCreatorByPageId(event?.sender?.id, entryId) : null;
        if (!creator || typeof customerId !== 'string') {
            log('warn', 'dm.echo_unresolved', { sender_id: event?.sender?.id ?? null, entry_id: entryId, has_recipient: Boolean(customerId) });
            return 'unresolved';
        }

        // The pause, exactly as the inbox's manual reply does it (`last_message_at` moves the thread to the top of the list).
        const paused = await queryOne<{ id: string }>(
            `UPDATE conversations SET is_bot_active = false, last_message_at = NOW()
              WHERE creator_id = $1 AND instagram_user_id = $2
          RETURNING id`,
            [creator.id, customerId]
        );
        if (!paused) {
            // The owner wrote first: there is no conversation for the bot to be paused in. It is not created here.
            log('info', 'dm.echo_no_conversation', { creator_id: creator.id });
            return 'no_conversation';
        }

        // His words, as an operator row. Without a mid there is nothing to make a retry idempotent, so no row.
        if (mid) {
            const text = typeof message.text === 'string' && message.text.trim() ? message.text.slice(0, 4000) : '[Attachment]';
            await queryCount(
                `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender, meta_message_id)
                 VALUES ($1, $2, 'outbound', 'text', $3, $4, 'operator', $5)
                 ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING`,
                [paused.id, creator.id, text, JSON.stringify({ text, via: 'instagram_app_echo' }), mid]
            );
        }
        log('info', 'dm.echo_takeover', { creator_id: creator.id, conversation_id: paused.id, why: verdict.why });
        return 'paused';
    });
}
