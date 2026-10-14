/**
 * When the bot may state a price. Pure.
 *
 * The owner's rule (2026-10-14): the bot never states a number for an offer unless the owner typed a price AND a "valid until" date that
 * has not passed. Otherwise it says the current price is on the page. A price the owner typed years ago, on a marketplace whose prices
 * move with every sale, is the one number a customer will hold the owner to; the date is how the owner says "this is still true".
 *
 * Both the prompt (which shows a live price and hides every other) and the guard (which accepts a live price and no other) read it
 * from here, so what the model was shown and what the guard lets through cannot disagree.
 *
 * "Valid until" is the whole of that day in the tenant's own timezone: a price valid until 2026-11-01 is still live at 23:59 there.
 */
import type { Offer } from '../profile/types.js';
import { isCalendarDate } from '../profile/validate.js';
import { extractNumbers } from './text.js';

/** A price the bot may state now. */
export interface LivePrice {
    offerId: string;
    /** As it is shown to the model and may be said: the owner's text, with the currency code after it when the text names none. */
    text: string;
    /** The numbers in `text`, canonical (`canonNumber`). Empty for a price with no digits in it. */
    amounts: string[];
    /** `sales.currency`, or null when the owner left it to the price text. */
    currency: string | null;
    /** 'YYYY-MM-DD'. */
    validUntil: string;
}

/** Today's date, 'YYYY-MM-DD', in `timezone` (UTC when it is empty or not a zone). */
export function todayIn(now: Date, timezone: string): string {
    for (const zone of [timezone, 'UTC']) {
        try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        } catch {
            // an unknown zone: try UTC
        }
    }
    return now.toISOString().slice(0, 10);
}

/** Does the price text already say what it is in? A letter (SAR, ريال) or a currency symbol does. */
const NAMES_A_CURRENCY = /[\p{L}$€£¥₪﷼]/u;

/**
 * The offer's price if the bot may state it at `now`, else null. Null when there is no price, no sales block, no date, a date that is
 * not on the calendar, or one that has passed.
 */
export function livePrice(offer: Offer, now: Date, timezone: string): LivePrice | null {
    const price = offer.price.trim();
    const sales = offer.sales;
    if (!price || !sales) return null;
    const until = sales.price_valid_until;
    if (!isCalendarDate(until) || todayIn(now, timezone) > until) return null;
    const currency = sales.currency || null;
    const text = currency && !NAMES_A_CURRENCY.test(price) ? `${price} ${currency}` : price;
    return { offerId: offer.id, text, amounts: [...extractNumbers(price)], currency, validUntil: until };
}
