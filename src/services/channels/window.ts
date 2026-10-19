/**
 * Can a free-form (non-template) WhatsApp message go out right now?
 *
 * One rule, in one place, so the manual-reply route, the follow-up job and the agent's own send all
 * ask the same question and cannot disagree about it (research R11):
 *
 *   a non-template send is allowed  iff  now < lastInboundAt + 24 h  OR  now < freeWindowExpiresAt
 *
 * - The customer-service window (CSW) opens or resets on every message the customer sends: 24 hours.
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
 * - The free-entry-point window (a Click to WhatsApp ad, up to 7 days from the business's first reply)
 *   is stored as `conversations.free_window_expires_at`; inside it service messages are free and allowed.
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
 *
 * Pure: no clock, no database. `now` is an argument, never read from the environment.
 *
 * **It fails closed.** A value that is not a usable instant (null, an unparseable string, `NaN`, an Invalid
 * Date) counts as "no window from that source", and an unusable `now` is a closed window. Sending outside
 * the window is the one mistake here with a cost (Meta answers 131047, and an unanswered template is not
 * free); declining to send is recoverable.
 *
 * The boundary is exclusive: at exactly `lastInboundAt + 24 h` the window is closed.
 */

/** The customer-service window: 24 hours from the customer's last message. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What a Postgres `TIMESTAMPTZ` column arrives as (a `Date`) or is serialised as (a string), plus epoch milliseconds. */
export type InstantLike = Date | string | number | null | undefined;

export interface WindowInput {
    /** `conversations.last_inbound_at`: the customer's last message. */
    lastInboundAt: InstantLike;
    /** `conversations.free_window_expires_at`: the end of the free-entry window, when there is one. */
    freeWindowExpiresAt: InstantLike;
    /** The instant to judge. Required: the caller owns the clock. */
    now: InstantLike;
}

/** The epoch milliseconds of an instant, or null when it is absent or not a real instant. */
function toMs(value: InstantLike): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * The instant the window closes: the later of the CSW's end and the free window's end. It may already be in
 * the past, which then says when the window did close. Null when neither source is a usable instant.
 *
 * `isWindowOpen` is exactly `now < windowClosesAt(...)`.
 */
export function windowClosesAt(input: Pick<WindowInput, 'lastInboundAt' | 'freeWindowExpiresAt'>): Date | null {
    const lastInbound = toMs(input.lastInboundAt);
    const free = toMs(input.freeWindowExpiresAt);
    const ends: number[] = [];
    if (lastInbound !== null) ends.push(lastInbound + CUSTOMER_SERVICE_WINDOW_MS);
    if (free !== null) ends.push(free);
    if (ends.length === 0) return null;
    const closes = new Date(Math.max(...ends));
    // A far-out-of-range epoch (`new Date(8.64e15 + 1)`) is not a Date; treat that as unusable too.
    return Number.isFinite(closes.getTime()) ? closes : null;
}

/** True when a free-form message may be sent at `now`. See the file comment for the rule and the boundary. */
export function isWindowOpen(input: WindowInput): boolean {
    const now = toMs(input.now);
    if (now === null) return false;
    const closes = windowClosesAt(input);
    return closes !== null && now < closes.getTime();
}
