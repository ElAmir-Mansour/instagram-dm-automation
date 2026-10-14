/**
 * When the bot may state a price (`price.ts`): only when the owner typed one AND a valid-until date that has not passed, the date being
 * the whole of that day in the tenant's own timezone. Everything else is "the current price is on the page".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blankSales } from '../profile/defaults.js';
import type { Offer } from '../profile/types.js';
import { livePrice, todayIn } from './price.js';
import { NOW } from './testFixtures.js';

const offer = (over: Partial<Offer> = {}, sales: Partial<ReturnType<typeof blankSales>> | null = {}): Offer => ({
    id: 'o', kind: 'other', name: 'Offer', order_via: 'url', url: 'https://example.com/o', price: '49', facts: [], bullets: [], keyword: '', primary: true,
    ...(sales === null ? {} : { sales: { ...blankSales(), price_valid_until: '2026-12-31', ...sales } }),
    ...over,
});

describe('livePrice', () => {
    it('is the price when the owner typed one and its date has not passed', () => {
        assert.deepEqual(livePrice(offer(), NOW, 'UTC'), { offerId: 'o', text: '49', amounts: ['49'], currency: null, validUntil: '2026-12-31' });
    });

    it('is nothing without a price, without a sales block, without a date, or with a date that is not one', () => {
        assert.equal(livePrice(offer({ price: '' }), NOW, 'UTC'), null);
        assert.equal(livePrice(offer({ price: '   ' }), NOW, 'UTC'), null);
        assert.equal(livePrice(offer({}, null), NOW, 'UTC'), null, 'a price with no sales block has no date');
        assert.equal(livePrice(offer({}, { price_valid_until: '' }), NOW, 'UTC'), null, 'a price with no date is a price from an unknown time');
        assert.equal(livePrice(offer({}, { price_valid_until: '2026-02-30' }), NOW, 'UTC'), null);
        assert.equal(livePrice(offer({}, { price_valid_until: 'soon' }), NOW, 'UTC'), null);
    });

    it('is nothing once the date has passed, and still live on the date itself', () => {
        assert.equal(livePrice(offer({}, { price_valid_until: '2026-10-13' }), NOW, 'UTC'), null, 'yesterday');
        assert.notEqual(livePrice(offer({}, { price_valid_until: '2026-10-14' }), NOW, 'UTC'), null, 'today');
        assert.notEqual(livePrice(offer({}, { price_valid_until: '2026-10-15' }), NOW, 'UTC'), null, 'tomorrow');
    });

    it('ends the day in the tenant\'s own timezone, not the server\'s', () => {
        // 22:30 UTC on New Year's Eve is already 2027-01-01 in Istanbul (UTC+3), and still 2026-12-31 in London and New York.
        const late = new Date('2026-12-31T22:30:00Z');
        const until = { price_valid_until: '2026-12-31' };
        assert.equal(livePrice(offer({}, until), late, 'Europe/Istanbul'), null);
        assert.notEqual(livePrice(offer({}, until), late, 'Europe/London'), null);
        assert.notEqual(livePrice(offer({}, until), late, 'America/New_York'), null);
        assert.notEqual(livePrice(offer({}, until), late, 'UTC'), null);
        // And the other way round: 01:00 UTC on the 1st is still the 31st in New York.
        const early = new Date('2027-01-01T01:00:00Z');
        assert.equal(livePrice(offer({}, until), early, 'UTC'), null);
        assert.notEqual(livePrice(offer({}, until), early, 'America/New_York'), null);
    });

    it('reads an empty or unknown timezone as UTC, and never throws on one', () => {
        for (const zone of ['', 'Not/AZone', '   ']) {
            assert.equal(todayIn(NOW, zone), '2026-10-14', JSON.stringify(zone));
            assert.notEqual(livePrice(offer(), NOW, zone), null);
        }
    });

    it('puts the currency after a price that names none, and leaves one that does', () => {
        assert.equal(livePrice(offer({}, { currency: 'USD' }), NOW, 'UTC')!.text, '49 USD');
        assert.equal(livePrice(offer({ price: '349 SAR' }, { currency: 'USD' }), NOW, 'UTC')!.text, '349 SAR', 'the text names a currency already');
        assert.equal(livePrice(offer({ price: '٤٩ ريال' }, { currency: 'SAR' }), NOW, 'UTC')!.text, '٤٩ ريال');
        assert.equal(livePrice(offer({ price: '$49' }, { currency: 'USD' }), NOW, 'UTC')!.text, '$49');
        assert.equal(livePrice(offer({}, { currency: 'USD' }), NOW, 'UTC')!.currency, 'USD');
    });

    it('reads its amounts in either script, and a range as two', () => {
        assert.deepEqual(livePrice(offer({ price: '٣٤٩٫٥٠ ريال' }), NOW, 'UTC')!.amounts, ['349.5']);
        assert.deepEqual(livePrice(offer({ price: '199 - 249' }), NOW, 'UTC')!.amounts, ['199', '249']);
        assert.deepEqual(livePrice(offer({ price: 'مجاني' }), NOW, 'UTC')!.amounts, [], 'a price with no digits has no amount to match');
    });

    it('is a pure function of its arguments: the same inputs, the same answer', () => {
        assert.deepEqual(livePrice(offer(), NOW, 'UTC'), livePrice(offer(), NOW, 'UTC'));
    });
});
