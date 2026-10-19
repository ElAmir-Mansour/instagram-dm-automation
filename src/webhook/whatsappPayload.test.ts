/**
 * `toWhatsAppMessage` (contracts/outbound-send.md section 2): a reply as the Cloud API takes it. Exact bodies, because a body that is a field off
 * is a message Meta refuses, and a limit that is not enforced is one it cuts for us. Pure: nothing here touches a database or the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    BUTTON_BODY_MAX, BUTTON_ID_MAX, BUTTON_TITLE_MAX, CTA_BODY_MAX, CTA_LABEL_MAX, cutAtSentence, LIST_BODY_MAX, LIST_BUTTON_MAX, LIST_ROW_DESCRIPTION_MAX,
    LIST_ROW_ID_MAX, LIST_ROW_TITLE_MAX, MAX_LIST_ROWS, TEXT_BODY_MAX, toWhatsAppMessage, WhatsAppShapeError,
} from './whatsappPayload.js';

const BSUID = 'EG.13491208655302741918';
const ADDRESS = { messaging_product: 'whatsapp', recipient_type: 'individual', recipient: BSUID };
const len = (s: string): number => Array.from(s).length;

describe('addressing', () => {
    it('addresses a BSUID with `recipient` and never `to`', () => {
        const m = toWhatsAppMessage({ text: 'hello' }, BSUID);
        assert.equal(m.recipient, BSUID);
        assert.equal(m.recipient_type, 'individual');
        assert.equal(m.messaging_product, 'whatsapp');
        assert.ok(!('to' in m), 'both fields at once make Meta use the phone number');
    });

    it('addresses a phone number alone with `to` and no `recipient`, dropping a plus sign', () => {
        for (const phone of ['201001234567', '+201001234567']) {
            const m = toWhatsAppMessage({ text: 'hello' }, phone);
            assert.equal(m.to, '201001234567');
            assert.ok(!('recipient' in m));
        }
    });

    it('refuses a message with no recipient or no words, as a shape error and not a request Meta would reject', () => {
        assert.throws(() => toWhatsAppMessage({ text: 'hello' }, '  '), WhatsAppShapeError);
        assert.throws(() => toWhatsAppMessage({ text: '   ' }, BSUID), WhatsAppShapeError);
        assert.throws(() => toWhatsAppMessage({ text: '', quickReplies: [{ title: 'Yes', payload: 'YES' }] }, BSUID), WhatsAppShapeError);
    });
});

describe('text', () => {
    it('is the exact text message, with preview_url false when there is no link', () => {
        assert.deepEqual(toWhatsAppMessage({ text: '  Hello there  ' }, BSUID), { ...ADDRESS, type: 'text', text: { body: 'Hello there', preview_url: false } });
    });

    it('sets preview_url when the words hold a URL', () => {
        const m = toWhatsAppMessage({ text: 'See https://example.com/plan' }, BSUID);
        assert.deepEqual(m.text, { body: 'See https://example.com/plan', preview_url: true });
    });

    it('cuts a body over 4,096 characters at the end of a sentence', () => {
        const sentence = 'This sentence is exactly fifty characters long ok.';
        const text = Array.from({ length: 100 }, () => sentence).join(' ');
        assert.ok(text.length > TEXT_BODY_MAX);
        const body = (toWhatsAppMessage({ text }, BSUID).text as { body: string }).body;
        assert.ok(len(body) <= TEXT_BODY_MAX);
        assert.ok(body.endsWith('.'), 'a whole sentence');
        assert.ok(len(body) > TEXT_BODY_MAX - 100, 'and nearly all of what fits');
    });
});

describe('cutAtSentence', () => {
    it('leaves text that fits exactly as it is', () => {
        assert.equal(cutAtSentence('One. Two.', 20), 'One. Two.');
    });

    it('cuts after the last sentence that fits, in Arabic too', () => {
        assert.equal(cutAtSentence('First sentence here. Second sentence here. Third.', 45), 'First sentence here. Second sentence here.');
        const ar = 'هذه الجملة الأولى طويلة. وهذه الثانية أطول منها؟ وهذه الثالثة.';
        const cut = cutAtSentence(ar, 50);
        assert.ok(len(cut) <= 50);
        assert.ok(cut.endsWith('؟') || cut.endsWith('.'));
    });

    it('cuts at a word with an ellipsis when no sentence ends in the second half, and never past the limit', () => {
        const cut = cutAtSentence('word '.repeat(50).trim(), 30);
        assert.ok(len(cut) <= 30);
        assert.ok(cut.endsWith('…'));
        assert.ok(/\bword…$/.test(cut), 'a whole word, then the ellipsis');
        const noSpaces = cutAtSentence('x'.repeat(100), 30);
        assert.equal(len(noSpaces), 30);
        assert.ok(noSpaces.endsWith('…'));
    });

    it('does not split an emoji or any character outside the basic plane', () => {
        const cut = cutAtSentence('😀'.repeat(40), 10);
        assert.equal(len(cut), 10);
        assert.ok(!/[\uD800-\uDBFF]$/.test(cut), 'no lone surrogate');
    });

    it('keeps a link on the last line whole and cuts the words before it', () => {
        const link = 'https://example.com/r/abc123';
        const text = `${'A sentence of some length. '.repeat(10).trim()}\n${link}`;
        const cut = cutAtSentence(text, 120);
        assert.ok(len(cut) <= 120);
        assert.ok(cut.endsWith(`\n${link}`), 'the link is not the part that was cut');
        assert.ok(cut.split('\n')[0]!.endsWith('.'));
    });
});

describe('quick replies', () => {
    it('are an interactive button message for one to three, in the exact shape', () => {
        const m = toWhatsAppMessage({ text: 'Which one?', quickReplies: [{ title: 'Plan A', payload: 'PLAN_A' }, { title: 'Plan B', payload: 'PLAN_B' }] }, BSUID);
        assert.deepEqual(m, {
            ...ADDRESS,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: 'Which one?' },
                action: { buttons: [{ type: 'reply', reply: { id: 'PLAN_A', title: 'Plan A' } }, { type: 'reply', reply: { id: 'PLAN_B', title: 'Plan B' } }] },
            },
        });
    });

    it('cut a title to 20 characters, an id to 256 and the body to 1,024, and keep three buttons at most as buttons', () => {
        const three = [1, 2, 3].map((n) => ({ title: `${n}`.repeat(30), payload: `${n}`.repeat(300) }));
        const m = toWhatsAppMessage({ text: 'Pick one. '.repeat(200), quickReplies: three }, BSUID);
        const ui = m.interactive as any;
        assert.equal(ui.type, 'button');
        assert.ok(len(ui.body.text) <= BUTTON_BODY_MAX);
        assert.equal(ui.action.buttons.length, 3);
        for (const b of ui.action.buttons) {
            assert.equal(len(b.reply.title), BUTTON_TITLE_MAX);
            assert.equal(len(b.reply.id), BUTTON_ID_MAX);
        }
    });

    it('drop a button with no id or no title and a repeat of a title or an id, which Meta refuses', () => {
        const m = toWhatsAppMessage({
            text: 'Choose',
            quickReplies: [{ title: 'Yes', payload: 'YES' }, { title: 'Yes', payload: 'YES_2' }, { title: 'No', payload: 'YES' }, { title: '', payload: 'X' }, { title: 'Maybe', payload: '' }, { title: 'Later', payload: 'LATER' }],
        }, BSUID);
        assert.deepEqual((m.interactive as any).action.buttons.map((b: any) => b.reply.id), ['YES', 'LATER']);
    });

    it('with none left once the unusable are dropped, are just the text', () => {
        const m = toWhatsAppMessage({ text: 'Hi', quickReplies: [{ title: '', payload: '' }] }, BSUID);
        assert.equal(m.type, 'text');
    });

    it('carry a link in the words, so a message with buttons and a link is still ONE message with the link in it', () => {
        const m = toWhatsAppMessage({ text: 'Here you go', quickReplies: [{ title: 'Thanks', payload: 'THX' }], link: { url: 'https://example.com/r/x', label: 'Open' } }, BSUID);
        assert.equal((m.interactive as any).type, 'button');
        assert.equal((m.interactive as any).body.text, 'Here you go\nhttps://example.com/r/x');
    });

    it('four to ten become a list in one section, with the quick replies as the rows', () => {
        const replies = Array.from({ length: 12 }, (_, i) => ({ title: `Option number ${i + 1} with a long name`, payload: `OPT_${i + 1}` }));
        const m = toWhatsAppMessage({ text: 'Pick one of these', quickReplies: replies }, BSUID);
        const ui = m.interactive as any;
        assert.equal(ui.type, 'list');
        assert.equal(ui.action.button, 'Options');
        assert.equal(ui.action.sections.length, 1);
        assert.equal(ui.action.sections[0].rows.length, MAX_LIST_ROWS, 'ten rows at most');
        assert.deepEqual(ui.action.sections[0].rows[0], { id: 'OPT_1', title: Array.from('Option number 1 with a long name').slice(0, LIST_ROW_TITLE_MAX).join('') });
        for (const row of ui.action.sections[0].rows) assert.ok(len(row.title) <= LIST_ROW_TITLE_MAX);
        assert.ok(len(ui.action.sections[0].title) > 0 && len(ui.action.sections[0].title) <= 24, 'a section title is required');
    });

    it('name the list button in Arabic for an Arabic reply', () => {
        const replies = ['١', '٢', '٣', '٤'].map((t, i) => ({ title: `خيار ${t}`, payload: `O${i}` }));
        const m = toWhatsAppMessage({ text: 'اختر واحداً', quickReplies: replies }, BSUID);
        assert.equal((m.interactive as any).action.button, 'الخيارات');
    });
});

describe('a list', () => {
    const rows = [
        { id: 'a'.repeat(250), title: 'T'.repeat(40), description: 'D'.repeat(100) },
        { id: 'b', title: 'Second', description: 'plain' },
        { id: 'c', title: 'Third' },
    ];

    it('is the exact interactive list, within every limit', () => {
        const m = toWhatsAppMessage({ text: 'Which?', list: { button: 'Pick a plan please now', rows } }, BSUID);
        const ui = m.interactive as any;
        assert.equal(ui.type, 'list');
        assert.equal(ui.body.text, 'Which?');
        assert.equal(len(ui.action.button), LIST_BUTTON_MAX);
        const [first, second, third] = ui.action.sections[0].rows;
        assert.equal(len(first.id), LIST_ROW_ID_MAX);
        assert.equal(len(first.title), LIST_ROW_TITLE_MAX);
        assert.equal(len(first.description), LIST_ROW_DESCRIPTION_MAX);
        assert.deepEqual(second, { id: 'b', title: 'Second', description: 'plain' });
        assert.deepEqual(third, { id: 'c', title: 'Third' }, 'no empty description is sent');
        assert.ok(len(ui.body.text) <= LIST_BODY_MAX);
    });

    it('wins over quick replies, and an empty list is not a list', () => {
        const withBoth = toWhatsAppMessage({ text: 'Which?', quickReplies: [{ title: 'Yes', payload: 'Y' }], list: { button: 'Menu', rows } }, BSUID);
        assert.equal((withBoth.interactive as any).type, 'list');
        const empty = toWhatsAppMessage({ text: 'Which?', list: { button: 'Menu', rows: [] } }, BSUID);
        assert.equal(empty.type, 'text');
    });
});

describe('a link', () => {
    it('alone is the interactive CTA button, with the text as its body and the label cut to 20', () => {
        const m = toWhatsAppMessage({ text: 'The plan is here', link: { url: 'https://example.com/r/abc', label: 'Open the plan page now' } }, BSUID);
        assert.deepEqual(m, {
            ...ADDRESS,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: { text: 'The plan is here' },
                action: { name: 'cta_url', parameters: { display_text: 'Open the plan page n', url: 'https://example.com/r/abc' } },
            },
        });
        assert.equal(len((m.interactive as any).action.parameters.display_text), CTA_LABEL_MAX);
    });

    it('with more than 1,024 characters of words is a text message with the link after them, not a cut body', () => {
        const text = 'Word '.repeat(300).trim();
        assert.ok(text.length > CTA_BODY_MAX);
        const m = toWhatsAppMessage({ text, link: { url: 'https://example.com/r/abc', label: 'Open' } }, BSUID);
        assert.equal(m.type, 'text');
        const body = (m.text as any).body as string;
        assert.ok(body.startsWith('Word Word'));
        assert.ok(body.endsWith('\nhttps://example.com/r/abc'));
        assert.equal((m.text as any).preview_url, true);
    });

    it('that is not an http(s) URL, or has no label, is not a button: a javascript: link is never sent as one', () => {
        const bad = toWhatsAppMessage({ text: 'Hi', link: { url: 'javascript:alert(1)', label: 'Open' } }, BSUID);
        assert.equal(bad.type, 'text');
        assert.ok(!JSON.stringify(bad).includes('javascript:'));
        const unlabeled = toWhatsAppMessage({ text: 'Hi', link: { url: 'https://example.com/x', label: '' } }, BSUID);
        assert.equal(unlabeled.type, 'text');
        assert.equal((unlabeled.text as any).body, 'Hi\nhttps://example.com/x', 'the link is still there');
    });
});

describe('one message per reply (review M14)', () => {
    it('is ONE payload object for every combination: shaping never returns more than one message', () => {
        const link = { url: 'https://example.com/r/x', label: 'Open' };
        const buttons = [{ title: 'A', payload: 'A' }, { title: 'B', payload: 'B' }];
        const many = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, payload: `P${i}` }));
        const list = { button: 'Menu', rows: [{ id: '1', title: 'One' }] };
        for (const body of [
            { text: 'x' }, { text: 'x', link }, { text: 'x', quickReplies: buttons }, { text: 'x', quickReplies: buttons, link }, { text: 'x', quickReplies: many, link }, { text: 'x', list, link },
        ]) {
            const m = toWhatsAppMessage(body, BSUID);
            assert.ok(!Array.isArray(m), JSON.stringify(body));
            assert.equal(typeof m.type, 'string');
        }
    });
});
