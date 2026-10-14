/**
 * The schema the sales model answers in (docs/DM_SALES_PLAN.md §3). Pure.
 *
 * Written once, as the app's own `GeminiSchema` subset, so every provider gets it by the usual conversion (`jsonSchemaFor`). It is built
 * to sit well inside Anthropic's structured-output limits (at most 24 optional and 16 union-typed properties, `schemaComplexity`):
 *
 *   - **Every field is required**, so the schema has no optional property at all.
 *   - **Enums carry 'none'** (`offer_id`, `handoff_reason`) instead of a nullable union, so it has no union-typed property at all.
 *
 * `offer_id` is an enum of this tenant's own offer ids plus 'none': the model cannot name an offer that is not in the prompt, and the
 * schema is the same for a tenant whose offers have not changed. The model never writes a URL, a price or a coupon (the guard checks
 * that it did not); it names an offer and the server inserts the link.
 *
 * The decision fields come BEFORE the text, on purpose: the model writes the intent, the stage and the action first, and its reply is
 * then written knowing which of them it is. Key order is the order the model produces them in.
 */
import type { GeminiSchema } from '../llm/geminiSchema.js';
import type { LlmSchema } from '../llm/schema.js';
import { HANDOFF_REASONS, INTENTS, MAX_QUICK_REPLIES, NEXT_ACTIONS, NO_OFFER, QUICK_REPLY_TITLE_MAX, STAGES } from './types.js';

/** The schema for a tenant whose offers have these ids. Ids are listed once, in the order given, after 'none'. */
export function salesReplySchema(offerIds: readonly string[]): LlmSchema {
    const ids = [...new Set(offerIds.filter((id) => id !== NO_OFFER))];
    const schema: GeminiSchema = {
        type: 'OBJECT',
        properties: {
            intent: { type: 'STRING', enum: [...INTENTS], description: 'What the person is doing in their last message.' },
            stage: {
                type: 'STRING', enum: [...STAGES],
                description: 'The stage the conversation should be in after your reply: new, qualify, recommend, objection, link, follow_up, handoff or closed.',
            },
            next_action: {
                type: 'STRING', enum: [...NEXT_ACTIONS],
                description: 'What the system should do with this reply. send_link is the only way a link is sent: the system adds it. handoff passes the conversation to a person.',
            },
            offer_id: {
                type: 'STRING', enum: [NO_OFFER, ...ids],
                description: `The id of the one offer this reply is about, or ${NO_OFFER}. Required for recommend and send_link.`,
            },
            handoff_reason: {
                type: 'STRING', enum: [...HANDOFF_REASONS],
                description: 'Why a person must take over. none unless next_action is handoff.',
            },
            text: {
                type: 'STRING',
                description: 'The reply to send, in the language the person writes in. Plain text, at most three short sentences and one question. No URLs, no prices, no numbers that were not given to you.',
            },
            quick_replies: {
                type: 'ARRAY', maxItems: MAX_QUICK_REPLIES,
                items: {
                    type: 'OBJECT',
                    properties: {
                        title: { type: 'STRING', description: `The button's label. At most ${QUICK_REPLY_TITLE_MAX} characters.` },
                        payload: { type: 'STRING', description: 'A short code for the button, capital letters and underscores only, like ASK_LEVEL.' },
                    },
                    required: ['title', 'payload'],
                },
                description: `Up to ${MAX_QUICK_REPLIES} buttons, only when they help. An empty list otherwise.`,
            },
        },
        required: ['intent', 'stage', 'next_action', 'offer_id', 'handoff_reason', 'text', 'quick_replies'],
    };
    return schema;
}
