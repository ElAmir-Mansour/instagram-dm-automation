/**
 * Webhook dispatch.
 *
 * The failure mode this exists to kill: the whole batch used to run inside one try/catch, so
 * the first un-wrapped database error aborted the loop over `body.entry` — and because the
 * handler answered 200 unconditionally in its `finally`, Meta was told every event in that
 * delivery succeeded. The remaining events were gone for good, with one console line as the
 * only evidence. Each entry, and each event inside it, now fails alone.
 */
import { handleMessagingEvent } from './messaging.js';
import { handleCommentChange } from './comments.js';

function describe(err: any): string {
    return err?.message ?? String(err);
}

async function processEntry(entry: any, objectType: string): Promise<void> {
    const entryId = entry?.id;
    console.log(`\n── Processing entry ID: ${entryId} (object: ${objectType})`);

    // ─── A. Process Instagram Direct Messages & Postbacks ─────────────────────
    if (Array.isArray(entry?.messaging)) {
        console.log(`📨 Found ${entry.messaging.length} messaging events to process.`);
        for (const event of entry.messaging) {
            try {
                await handleMessagingEvent(event, entryId);
            } catch (err: any) {
                console.error(
                    `❌ Messaging event failed (mid: ${event?.message?.mid ?? 'n/a'}) — continuing with the rest:`,
                    describe(err)
                );
            }
        }
    }

    // ─── B. Process Comment webhooks (Instagram & Facebook) ─────────────────
    if (Array.isArray(entry?.changes)) {
        for (const change of entry.changes) {
            try {
                await handleCommentChange(change, entryId);
            } catch (err: any) {
                console.error(
                    `❌ Comment event failed (field: ${change?.field}) — continuing with the rest:`,
                    describe(err)
                );
            }
        }
    }
}

/** Process one verified webhook body. Never throws: every event is isolated. */
export async function processWebhookBody(body: any): Promise<void> {
    const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];

    if (entries.length === 0) {
        console.log('⏭️  Webhook carried no entries to process.');
        return;
    }

    for (const entry of entries) {
        try {
            await processEntry(entry, body?.object);
        } catch (err: any) {
            console.error(`❌ Entry ${entry?.id} failed — remaining entries continue:`, describe(err));
        }
    }
}
