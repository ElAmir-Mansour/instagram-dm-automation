/**
 * The conversation as the sales model reads it (docs/DM_SALES_PLAN.md §3). Pure.
 *
 * A row of `messages` is a poor record of what was said, in two ways the model has to be told about:
 *
 *   - **What the bot sent.** A carousel, or a message with quick replies, is stored with the placeholder text `[Structured Template]` (or the
 *     message's words alone): its cards and buttons live only in `raw_payload`. Read as stored, the history says the bot sent "[Structured
 *     Template]" and the model forgets it showed nine plans, so it offers them again or asks which one. `structuredSummary` says what the
 *     payload held, in one short line: `[sent cards: A · B · C]`, `[buttons: X · Y]`.
 *   - **What a tap meant.** When a customer taps a quick reply, the inbound row's text is the button's TITLE and its `payload` the button's code
 *     (`OTHER_PLANS`). The title alone may be a question the code answers ("other plans"). `historyText` adds `(tapped: OTHER_PLANS)`.
 *
 * Both are for the sales path only: the legacy Gemini path reads the history as it always did (`generateAiResponse`, `dmTurns`), untouched.
 */
import type { LlmTurn } from '../llm/types.js';
import type { HistoryRow } from './store.js';
import { graphemes } from './text.js';

/** What an outbound carousel or row of buttons is stored as in `messages.text`; the cards and buttons themselves are only in `raw_payload`. */
export const STRUCTURED_TEMPLATE_TEXT = '[Structured Template]';

/** How long the summary of what a structured message held may be, and how it is shared: the cards get the larger part, the buttons the rest. */
export const STRUCTURED_SUMMARY_MAX = 300;
const CARDS_SUMMARY_MAX = 195;
const BUTTONS_SUMMARY_MAX = 104;
/** One card's or button's title, at most: a title is a few words, and a long one must not take the whole budget. */
const SUMMARY_TITLE_MAX = 48;
/** The most of a tapped button's code that is shown. */
const TAPPED_MAX = 64;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Text a person or a card wrote, made safe to put in a line: control characters out, white space one space, cut to `max` whole characters. */
function clean(value: unknown, max: number): string {
    const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const parts = graphemes(text);
    return parts.length > max ? `${parts.slice(0, max - 1).join('').trimEnd()}…` : text;
}

/** `[label: a · b · c]` within `max` characters, dropping the titles that do not fit and saying so with an ellipsis. Empty for no titles. */
function section(label: string, titles: readonly string[], max: number): string {
    if (titles.length === 0) return '';
    const open = `[${label}: `;
    const room = max - open.length - 2; // the closing bracket, and " …" when something was left out
    let body = '';
    let shown = 0;
    for (const title of titles) {
        const next = body ? `${body} · ${title}` : title;
        if (next.length > room) break;
        body = next;
        shown += 1;
    }
    if (shown === 0) body = clean(titles[0], room);
    return `${open}${body}${shown < titles.length ? ' …' : ''}]`;
}

/**
 * What a structured message the bot sent actually held, as one short line for the model (`messages.raw_payload`, which for such a message is
 * the Send API's own body): `[sent cards: A · B · C]` for a carousel's titles, `[buttons: X · Y]` for its quick replies, both when it has both.
 * Never more than `STRUCTURED_SUMMARY_MAX` characters. Empty when the payload holds neither: a plain text reply, or a payload the retention
 * sweep has already cleared. `raw` may be the object or its JSON text.
 */
export function structuredSummary(raw: unknown): string {
    let payload: unknown = raw;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            return '';
        }
    }
    if (!isObj(payload)) return '';
    const attachment = isObj(payload.attachment) ? payload.attachment : null;
    const inner = attachment && isObj(attachment.payload) ? attachment.payload : null;
    const cards: unknown[] = Array.isArray(inner?.elements) ? (inner.elements as unknown[]) : [];
    const quick: unknown[] = Array.isArray(payload.quick_replies) ? payload.quick_replies : [];
    const titles = (list: unknown[]): string[] => list.map((item) => (isObj(item) ? clean(item.title, SUMMARY_TITLE_MAX) : '')).filter(Boolean);
    return [section('sent cards', titles(cards), CARDS_SUMMARY_MAX), section('buttons', titles(quick), BUTTONS_SUMMARY_MAX)].filter(Boolean).join(' ');
}

/**
 * What the model reads for one message of the thread.
 *
 *   - OUTBOUND: the bot's words, and what a carousel or buttons held. A carousel shows `[sent cards: …]` where the placeholder was, and a
 *     message that had quick replies shows `[buttons: …]` after its words. A placeholder whose payload has been cleared is still said, as
 *     `[sent cards or buttons]`, so the model knows something was sent.
 *   - INBOUND: the person's words, and when they tapped a quick reply, which one: `text (tapped: CODE)`. When the stored text IS the code (a
 *     tap with no title), just `(tapped: CODE)`. `tapped` is the code when the row carries none of its own.
 */
export function historyText(row: HistoryRow, tapped = ''): string {
    const text = (row.text ?? '').trim();
    if (row.direction === 'inbound') {
        const code = clean(row.payload || tapped, TAPPED_MAX);
        if (!code) return text;
        return text && text !== code ? `${text} (tapped: ${code})` : `(tapped: ${code})`;
    }
    const summary = structuredSummary(row.raw_payload);
    if (text === '' || text === STRUCTURED_TEMPLATE_TEXT) return summary || (text === STRUCTURED_TEMPLATE_TEXT ? '[sent cards or buttons]' : '');
    return summary ? `${text}\n${summary}` : text;
}

/**
 * The conversation as the model's turns. `history` is oldest first and holds the message being answered; if it does not (a story mention
 * stored under other words), it is added, with the button code it carried (`tapped`) if it was a tap. What is kept and how:
 *
 *   - the person's messages are `user` turns, the bot's own replies `model` turns, each as `historyText` writes it;
 *   - a reply a PERSON sent from the inbox is a `model` turn marked `[owner]`, and a campaign's automatic DM is marked `[auto]`, so the model
 *     can see what the owner already said and does not repeat or contradict it;
 *   - Anthropic needs a conversation that starts with the user, so leading `model` turns go; consecutive turns of one role become one (a
 *     burst of three messages is one user turn of three lines), so roles alternate;
 *   - blank rows are not turns;
 *   - `facts` (the conversation's stage and counts) are put in front of the LAST user turn, which is always the customer's.
 */
export function salesTurns(history: readonly HistoryRow[], userMessage: string, owner: string, facts = '', tapped = ''): LlmTurn[] {
    const rows: HistoryRow[] = [...history];
    const last = rows[rows.length - 1];
    if (!last || last.direction !== 'inbound' || last.text !== userMessage) {
        rows.push({ direction: 'inbound', text: userMessage, sender: 'customer', payload: tapped || null });
    }

    const turns: LlmTurn[] = [];
    for (const row of rows) {
        const text = historyText(row);
        if (!text) continue;
        const turn: LlmTurn = row.direction === 'inbound'
            ? { role: 'user', text }
            : { role: 'model', text: row.sender === 'operator' ? `[${owner}] ${text}` : row.sender === 'automation' ? `[auto] ${text}` : text };
        const before = turns[turns.length - 1];
        if (before && before.role === turn.role) before.text = `${before.text}\n${turn.text}`;
        else turns.push(turn);
    }
    const firstUser = turns.findIndex((t) => t.role === 'user');
    const usable = firstUser < 0 ? [] : turns.slice(firstUser);
    const tail = usable[usable.length - 1];
    if (facts && tail && tail.role === 'user') tail.text = `${facts}\n\n${tail.text}`;
    return usable;
}
