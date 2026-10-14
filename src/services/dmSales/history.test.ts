/**
 * The conversation as the sales model reads it (`history.ts`).
 *
 * Two things a stored row does not say: what a carousel or a row of buttons the bot sent actually held (stored as `[Structured Template]`,
 * the cards living only in `raw_payload`), and which button a customer tapped (the row's text is the button's title, its code is `payload`).
 * A model that cannot see them forgets it showed nine plans and misreads «باقي الخطط» as a fresh question.
 *
 * Sales path only: the old path's history (`generateAiResponse`, `dmTurns`) is not touched by any of this, and a test below says so.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dmTurns } from '../dmEngine.js';
import { historyText, salesTurns, STRUCTURED_SUMMARY_MAX, STRUCTURED_TEMPLATE_TEXT, structuredSummary } from './history.js';
import type { HistoryRow } from './store.js';
import { utf8Bytes } from './text.js';

const row = (over: Partial<HistoryRow> & Pick<HistoryRow, 'direction' | 'text'>): HistoryRow => ({ sender: null, ...over });

/** A carousel as the Send API takes it, as `toMetaMessage` builds it and the old path stores it in `raw_payload`. */
const carousel = (titles: string[], extra: Record<string, unknown> = {}) => ({
    attachment: { type: 'template', payload: { template_type: 'generic', elements: titles.map((title) => ({ title, subtitle: 'ignored', buttons: [{ type: 'web_url', title: 'Open', url: 'https://example.com/x' }] })) } },
    ...extra,
});

describe('structuredSummary: what a carousel or buttons held', () => {
    it('lists a carousel\'s card titles, in order', () => {
        assert.equal(structuredSummary(carousel(['Alpha Plan', 'خطة المبتدئين', 'خطة المتقدمين'])), '[sent cards: Alpha Plan · خطة المبتدئين · خطة المتقدمين]');
    });

    it('lists quick replies as buttons', () => {
        assert.equal(
            structuredSummary({ text: 'hi', quick_replies: [{ content_type: 'text', title: 'رابط الخطة', payload: 'LINK' }, { content_type: 'text', title: 'باقي الخطط', payload: 'OTHER_PLANS' }] }),
            '[buttons: رابط الخطة · باقي الخطط]'
        );
    });

    it('says both when a payload has both, cards first', () => {
        assert.equal(structuredSummary(carousel(['A', 'B'], { quick_replies: [{ title: 'More', payload: 'MORE' }] })), '[sent cards: A · B] [buttons: More]');
    });

    it('never shows a card\'s link, subtitle or button: only the titles', () => {
        const out = structuredSummary(carousel(['A']));
        assert.ok(!out.includes('http') && !out.includes('ignored') && !out.includes('Open'), out);
    });

    it('reads the payload from its JSON text as well as from the object (what a driver may hand back)', () => {
        assert.equal(structuredSummary(JSON.stringify(carousel(['A', 'B']))), '[sent cards: A · B]');
    });

    it('is empty for a plain text reply, for a payload that was cleared, and for anything that is not a payload', () => {
        for (const raw of [{ text: 'hello' }, null, undefined, '', 'not json', 42, [], { attachment: { type: 'image' } }, { attachment: { payload: { elements: [] } } }, { quick_replies: [] }]) {
            assert.equal(structuredSummary(raw), '', JSON.stringify(raw));
        }
    });

    it('skips entries without a title, and cleans the titles it keeps: one line, no control characters', () => {
        assert.equal(structuredSummary(carousel(['  A \n\t B  ', '', '\u0000'])), '[sent cards: A B]');
        assert.equal(structuredSummary({ attachment: { payload: { elements: [null, 5, { title: 7 }, { title: 'Real' }] } } }), '[sent cards: Real]');
    });

    it('stays within 300 characters however many cards there are, and says some were left out', () => {
        const nine = Array.from({ length: 9 }, (_, i) => `دورة رقم ${i + 1} في الذكاء الاصطناعي التطبيقي للمبتدئين`);
        const out = structuredSummary(carousel(nine, { quick_replies: [{ title: 'رابط الخطة' }, { title: 'باقي الخطط' }] }));
        assert.ok(out.length <= STRUCTURED_SUMMARY_MAX, `${out.length} characters`);
        assert.match(out, /^\[sent cards: .* …\] \[buttons: رابط الخطة · باقي الخطط\]$/, 'the buttons keep their share when the cards run long');
        assert.ok(out.startsWith('[sent cards: دورة رقم 1'));
    });

    it('cuts one very long title rather than losing the line, on whole characters', () => {
        const out = structuredSummary(carousel(['ا'.repeat(500)]));
        assert.ok(out.length <= STRUCTURED_SUMMARY_MAX);
        assert.match(out, /^\[sent cards: ا+…\]$/);
        assert.ok(!out.includes('�'));
        const emoji = structuredSummary(carousel(['🚀'.repeat(500)]));
        assert.ok(!/[\ud800-\udbff]…|[\ud800-\udbff]\]/.test(emoji), 'no half of a surrogate pair');
    });
});

describe('historyText: one message as the model reads it', () => {
    it('replaces the placeholder of a carousel with the cards it held', () => {
        assert.equal(historyText(row({ direction: 'outbound', sender: 'ai', text: STRUCTURED_TEMPLATE_TEXT, raw_payload: carousel(['Alpha Plan', 'Python']) })), '[sent cards: Alpha Plan · Python]');
    });

    it('adds the buttons after the words of a message that had quick replies', () => {
        const text = historyText(row({
            direction: 'outbound', sender: 'ai', text: 'أي خطة تهمك؟',
            raw_payload: { text: 'x', quick_replies: [{ title: 'رابط الخطة', payload: 'A' }, { title: 'باقي الخطط', payload: 'B' }] },
        }));
        assert.equal(text, 'أي خطة تهمك؟\n[buttons: رابط الخطة · باقي الخطط]');
    });

    it('leaves a plain reply exactly as it was', () => {
        assert.equal(historyText(row({ direction: 'outbound', sender: 'ai', text: 'أهلاً بك', raw_payload: { text: 'أهلاً بك' } })), 'أهلاً بك');
        assert.equal(historyText(row({ direction: 'outbound', sender: 'ai', text: 'أهلاً بك' })), 'أهلاً بك', 'a row whose payload was not read at all');
    });

    it('still says something was sent when the placeholder\'s payload has been cleared by retention', () => {
        assert.equal(historyText(row({ direction: 'outbound', sender: 'ai', text: STRUCTURED_TEMPLATE_TEXT, raw_payload: null })), '[sent cards or buttons]');
        assert.equal(historyText(row({ direction: 'outbound', sender: 'ai', text: STRUCTURED_TEMPLATE_TEXT })), '[sent cards or buttons]');
    });

    it('is empty for a blank outbound row, and the placeholder is never shown to the model', () => {
        assert.equal(historyText(row({ direction: 'outbound', text: '  ' })), '');
        for (const r of [row({ direction: 'outbound', text: STRUCTURED_TEMPLATE_TEXT }), row({ direction: 'outbound', text: STRUCTURED_TEMPLATE_TEXT, raw_payload: carousel(['A']) })]) {
            assert.ok(!historyText(r).includes('Structured Template'));
        }
    });

    it('marks a button tap with its code, after the title', () => {
        assert.equal(historyText(row({ direction: 'inbound', text: 'باقي الخطط', payload: 'OTHER_PLANS' })), 'باقي الخطط (tapped: OTHER_PLANS)');
    });

    it('does not say a thing twice: a tap stored with no title (the text IS the code) is just the tap', () => {
        assert.equal(historyText(row({ direction: 'inbound', text: 'OTHER_PLANS', payload: 'OTHER_PLANS' })), '(tapped: OTHER_PLANS)');
        assert.equal(historyText(row({ direction: 'inbound', text: '', payload: 'GET_STARTED' })), '(tapped: GET_STARTED)');
    });

    it('leaves a message with no payload exactly as it was, and a blank payload is none', () => {
        assert.equal(historyText(row({ direction: 'inbound', text: 'كم السعر؟' })), 'كم السعر؟');
        assert.equal(historyText(row({ direction: 'inbound', text: 'كم السعر؟', payload: null })), 'كم السعر؟');
        assert.equal(historyText(row({ direction: 'inbound', text: 'كم السعر؟', payload: '  ' })), 'كم السعر؟');
    });

    it('keeps a code to one safe line: control characters and a very long code do not reach the model as written', () => {
        const out = historyText(row({ direction: 'inbound', text: 'x', payload: `A\nB\u0000${'C'.repeat(200)}` }));
        assert.ok(!/[\n\u0000]/.test(out));
        assert.ok(out.length < 100, `${out.length}`);
    });

    it('never puts an outbound row\'s payload on an inbound one, or the reverse: a customer\'s message holds no cards', () => {
        assert.equal(historyText(row({ direction: 'inbound', text: 'hi', raw_payload: carousel(['A']) })), 'hi');
        assert.equal(historyText(row({ direction: 'outbound', sender: 'ai', text: 'hello', payload: 'TAP' })), 'hello');
    });
});

describe('salesTurns: the thread with what was sent and what was tapped', () => {
    it('shows the model the cards it sent and the button the customer pressed, as two turns', () => {
        const turns = salesTurns([
            row({ direction: 'inbound', text: 'السلام عليكم' }),
            row({ direction: 'outbound', sender: 'ai', text: STRUCTURED_TEMPLATE_TEXT, raw_payload: carousel(['Alpha Plan', 'خطة المبتدئين']) }),
            row({ direction: 'inbound', text: 'باقي الخطط', payload: 'OTHER_PLANS' }),
        ], 'باقي الخطط', 'Sami');
        assert.deepEqual(turns.map((t) => [t.role, t.text]), [
            ['user', 'السلام عليكم'],
            ['model', '[sent cards: Alpha Plan · خطة المبتدئين]'],
            ['user', 'باقي الخطط (tapped: OTHER_PLANS)'],
        ]);
    });

    it('a reply a person sent from the inbox keeps its marker with the summary after it', () => {
        const turns = salesTurns([
            row({ direction: 'inbound', text: 'hi' }),
            row({ direction: 'outbound', sender: 'operator', text: STRUCTURED_TEMPLATE_TEXT, raw_payload: carousel(['A']) }),
            row({ direction: 'inbound', text: 'ok' }),
        ], 'ok', 'Sami');
        assert.equal(turns[1]!.text, '[Sami] [sent cards: A]');
    });

    it('carries the tap of the message being answered when the history does not hold it (the fallback row)', () => {
        const turns = salesTurns([row({ direction: 'inbound', text: 'hi' }), row({ direction: 'outbound', sender: 'ai', text: 'hello' })], 'باقي الخطط', 'Sami', '', 'OTHER_PLANS');
        assert.equal(turns[turns.length - 1]!.text, 'باقي الخطط (tapped: OTHER_PLANS)');
    });

    it('puts the facts in front of the tap, as it does in front of any last message', () => {
        const turns = salesTurns([row({ direction: 'inbound', text: 'باقي الخطط', payload: 'OTHER_PLANS' })], 'باقي الخطط', 'Sami', 'FACTS');
        assert.equal(turns[0]!.text, 'FACTS\n\nباقي الخطط (tapped: OTHER_PLANS)');
    });

    it('a row of buttons whose payload is gone is still a turn, so roles keep alternating', () => {
        const turns = salesTurns([
            row({ direction: 'inbound', text: 'a' }),
            row({ direction: 'outbound', sender: 'ai', text: STRUCTURED_TEMPLATE_TEXT, raw_payload: null }),
            row({ direction: 'inbound', text: 'b' }),
        ], 'b', 'Sami');
        assert.deepEqual(turns.map((t) => t.role), ['user', 'model', 'user']);
    });
});

describe('the old path\'s history is not the sales path\'s', () => {
    it('`dmTurns`, which the legacy and providers engines read, still sees a carousel as the placeholder and a tap as its title: byte for byte what it was', () => {
        const turns = dmTurns([
            { direction: 'inbound', text: 'hi' },
            { direction: 'outbound', text: STRUCTURED_TEMPLATE_TEXT },
            { direction: 'inbound', text: 'باقي الخطط' },
        ], 'باقي الخطط');
        assert.deepEqual(turns, [
            { role: 'user', text: 'hi' }, { role: 'model', text: '[Structured Template]' }, { role: 'user', text: 'باقي الخطط' },
        ]);
    });

    it('the byte size of a summary is small: a few hundred characters of text for a carousel, however large its payload', () => {
        const big = carousel(Array.from({ length: 10 }, (_, i) => `Plan ${i} ${'x'.repeat(200)}`));
        assert.ok(utf8Bytes(structuredSummary(big)) <= STRUCTURED_SUMMARY_MAX * 4);
    });
});
