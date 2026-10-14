/**
 * Ice breakers and the persistent menu (`iceBreakers.ts`, DM plan S13): the pure half. What is pinned, because each is a way the owner's
 * Instagram profile ends up wrong in front of every visitor:
 *
 *   - the limits: four ice breakers is Meta's number and a fifth is refused; the question and title lengths are OUR caps (Meta's Instagram pages
 *     state none, `iceBreakers.ts` says so) and are enforced at the character, not the byte or the UTF-16 unit, because the text is Arabic and emoji;
 *   - nothing the owner typed is trusted: an unknown payload, a link that is not https, a control character and a duplicate are each refused with
 *     the field they are on, and no key of the input that is not ours can reach Meta;
 *   - every payload code stands for an intent of the sales turn, and anything else stands for none;
 *   - the request is what Meta documents: one POST body holding both properties, `ice_breakers` with `call_to_actions` and the `default` locale
 *     Meta requires; a property the editor emptied is REMOVED, but only when this app published it;
 *   - what Meta answers is read in all three shapes its own pages show, and an answer that fits none is an empty profile, never a crash;
 *   - the suggestions are publishable as they stand and say nothing that belongs to the owner alone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KIT_KEYS } from '../profile/kits.js';
import { assertNoGulfInEgyptianOrMsa, ownerMarkersIn } from '../profile/testSupport.js';
import {
    charCount, EMPTY_CONFIG, fingerprint, ICE_BREAKER_MAX, ICE_BREAKER_QUESTION_MAX, intentForPayload, MENU_ITEMS_MAX, MENU_TITLE_MAX, menuUrlOk,
    parseConfig, planPublish, PROFILE_LOCALE, READ_FIELDS, readLiveProfile, REMOVE_FIELDS, suggestIceBreakers, SUGGESTION_KITS, TAP_CODES, TAP_INTENT,
    type IceBreakerConfig, type Problem,
} from './iceBreakers.js';
import { INTENTS } from './types.js';

const ice = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `Question number ${i + 1}?`, payload: 'TAP_INFO' }));
const menu = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'postback', title: `Item ${i + 1}`, payload: 'TAP_PRICE' }));

const problemsOf = (input: unknown): Problem[] => {
    const r = parseConfig(input);
    assert.equal(r.ok, false, 'the input is refused');
    return r.ok ? [] : r.problems;
};
const codes = (input: unknown): string[] => problemsOf(input).map((p) => `${p.field}:${p.code}`);
const configOf = (input: unknown): IceBreakerConfig => {
    const r = parseConfig(input);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.ok ? r.config : EMPTY_CONFIG;
};

describe('the limits Meta sets: at most four ice breakers', () => {
    it('four are accepted', () => {
        assert.equal(ICE_BREAKER_MAX, 4, 'Meta: "a maximum of 4 questions"');
        assert.equal(configOf({ iceBreakers: ice(4) }).iceBreakers.length, 4);
    });

    it('a fifth is refused, on the list and not on one of its rows', () => {
        assert.deepEqual(codes({ iceBreakers: ice(5) }), ['iceBreakers:TOO_MANY']);
        assert.match(problemsOf({ iceBreakers: ice(5) })[0]!.message, /At most 4/);
    });

    it('a list that is not a list is refused', () => {
        assert.deepEqual(codes({ iceBreakers: 'what is the price' }), ['iceBreakers:NOT_A_LIST']);
        assert.deepEqual(codes({ menu: { title: 'x' } }), ['menu:NOT_A_LIST']);
    });

    it('nothing at all is a valid, empty draft (what there is to publish is another question)', () => {
        assert.deepEqual(configOf({}), { iceBreakers: [], menu: [] });
        assert.deepEqual(configOf(undefined), { iceBreakers: [], menu: [] });
        assert.deepEqual(configOf(null), { iceBreakers: [], menu: [] });
        assert.deepEqual(configOf('nonsense'), { iceBreakers: [], menu: [] });
    });
});

describe('the length of a question: OUR cap, counted in characters', () => {
    const q = (text: string) => ({ iceBreakers: [{ question: text, payload: 'TAP_INFO' }] });

    it('is 80 characters: 80 pass and 81 do not', () => {
        assert.equal(ICE_BREAKER_QUESTION_MAX, 80);
        assert.equal(configOf(q('أ'.repeat(80))).iceBreakers[0]!.question.length, 80);
        assert.deepEqual(codes(q('أ'.repeat(81))), ['iceBreakers[0].question:QUESTION_TOO_LONG']);
    });

    it('counts an emoji as one character, not two UTF-16 units: 80 of them pass', () => {
        assert.equal(charCount('🙂'), 1);
        assert.equal('🙂'.length, 2);
        configOf(q('🙂'.repeat(80)));
        assert.deepEqual(codes(q('🙂'.repeat(81))), ['iceBreakers[0].question:QUESTION_TOO_LONG']);
    });

    it('is counted AFTER the whitespace is tidied: a line break and a run of spaces are one space, and the ends are trimmed', () => {
        const got = configOf(q('  وش   السعر؟\n\n  '));
        assert.equal(got.iceBreakers[0]!.question, 'وش السعر؟');
    });

    it('a blank question, a control character and a repeat are refused, each on its row', () => {
        assert.deepEqual(codes(q('   ')), ['iceBreakers[0].question:QUESTION_EMPTY']);
        assert.deepEqual(codes(q('price\u0007?')), ['iceBreakers[0].question:BAD_CHARACTERS']);
        assert.deepEqual(codes({ iceBreakers: [{ question: 'How much?', payload: 'TAP_PRICE' }, { question: ' how   MUCH? ', payload: 'TAP_PRICE' }] }), ['iceBreakers[1].question:QUESTION_DUPLICATE']);
    });

    it('every problem names its field, a stable code and a sentence', () => {
        for (const p of problemsOf({ iceBreakers: [{ question: '', payload: 'NOPE' }, 7] })) {
            assert.ok(p.field && p.code && p.message.length > 0, JSON.stringify(p));
        }
    });
});

describe('the payload is one of ours, or nothing is saved', () => {
    it('an unknown code, a missing one, a made-up one and one that is not a string are each refused', () => {
        for (const payload of ['DROP TABLE', 'tap_info', '', undefined, 42, null, 'TAP_INFO ']) {
            assert.deepEqual(codes({ iceBreakers: [{ question: 'Hello?', payload }] }), ['iceBreakers[0].payload:PAYLOAD_UNKNOWN'], String(payload));
        }
    });

    it('a row that is not an object is refused', () => {
        assert.deepEqual(codes({ iceBreakers: ['Hello?'] }), ['iceBreakers[0]:NOT_AN_OBJECT']);
    });

    it('keys of the input that are not ours do not survive: the result is built field by field', () => {
        const got = configOf({
            iceBreakers: [{ question: 'Hello?', payload: 'TAP_INFO', extra: '<script>', locale: 'en_GB' }],
            menu: [{ type: 'postback', title: 'Menu', payload: 'TAP_PRICE', url: 'https://x.test', composer_input_disabled: true }],
            platform: 'facebook', ice_breakers: [{ call_to_actions: [] }],
        });
        assert.deepEqual(got, {
            iceBreakers: [{ question: 'Hello?', payload: 'TAP_INFO' }],
            menu: [{ type: 'postback', title: 'Menu', payload: 'TAP_PRICE' }],
        });
    });
});

describe('the persistent menu', () => {
    it('is up to five items (Meta\'s best practice): five pass, six do not', () => {
        assert.equal(MENU_ITEMS_MAX, 5);
        assert.equal(configOf({ menu: menu(5) }).menu.length, 5);
        assert.deepEqual(codes({ menu: menu(6) }), ['menu:TOO_MANY']);
    });

    it('a title is at most 30 characters (our cap), and not blank', () => {
        assert.equal(MENU_TITLE_MAX, 30);
        configOf({ menu: [{ type: 'postback', title: 'ب'.repeat(30), payload: 'TAP_HUMAN' }] });
        assert.deepEqual(codes({ menu: [{ type: 'postback', title: 'ب'.repeat(31), payload: 'TAP_HUMAN' }] }), ['menu[0].title:TITLE_TOO_LONG']);
        assert.deepEqual(codes({ menu: [{ type: 'postback', title: ' ', payload: 'TAP_HUMAN' }] }), ['menu[0].title:TITLE_EMPTY']);
    });

    it('a postback needs one of our codes; a web_url needs an https link; anything else is no type', () => {
        assert.deepEqual(codes({ menu: [{ type: 'postback', title: 'Talk', payload: 'GO' }] }), ['menu[0].payload:PAYLOAD_UNKNOWN']);
        assert.deepEqual(codes({ menu: [{ type: 'web_url', title: 'Site', url: 'http://x.test' }] }), ['menu[0].url:URL_INVALID']);
        assert.deepEqual(codes({ menu: [{ type: 'phone', title: 'Call' }] }), ['menu[0].type:TYPE_UNKNOWN']);
        assert.deepEqual(configOf({ menu: [{ type: 'web_url', title: 'Site', url: ' https://x.test/a?b=1 ' }] }).menu, [{ type: 'web_url', title: 'Site', url: 'https://x.test/a?b=1' }]);
    });

    it('a link must be a full https address with a host, no credentials and a sane length', () => {
        for (const bad of ['', 'javascript:alert(1)', 'http://x.test', 'https://', 'https://user:pw@x.test', 'x.test', '//x.test', 'https://' + 'a'.repeat(2001), 'data:text/html,<b>']) {
            assert.equal(menuUrlOk(bad), false, bad.slice(0, 40));
        }
        assert.equal(menuUrlOk('https://x.test'), true);
        assert.equal(menuUrlOk('https://x.test/r/AbCdEf1234'), true);
    });
});

describe('payload → intent', () => {
    it('every code stands for an intent the sales turn has', () => {
        for (const code of TAP_CODES) assert.ok((INTENTS as readonly string[]).includes(TAP_INTENT[code]), `${code} → ${TAP_INTENT[code]}`);
        assert.deepEqual(Object.keys(TAP_INTENT).sort(), [...TAP_CODES].sort(), 'no code without an intent and no intent without a code');
    });

    it('is the table the editor shows', () => {
        assert.deepEqual(TAP_CODES.map((c) => [c, intentForPayload(c)]), [
            ['TAP_INFO', 'info'], ['TAP_LEVEL', 'level_fit'], ['TAP_PRICE', 'price'], ['TAP_LINK', 'ready_to_buy'],
            ['TAP_SUPPORT', 'support'], ['TAP_HUMAN', 'wants_human'], ['TAP_OTHER', 'other'],
        ]);
    });

    it('anything that is not one of our codes is no intent: the bot\'s own quick replies, a campaign\'s button, an old menu, no payload at all', () => {
        for (const other of ['OTHER_PLANS', 'GO_TO_OFFER_1', 'tap_price', 'TAP_PRICE ', 'TAP_', '', undefined, null, 7, {}, []]) {
            assert.equal(intentForPayload(other), null, String(other));
        }
    });
});

describe('the request a publish makes', () => {
    const config = configOf({
        iceBreakers: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
        menu: [{ type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN' }, { type: 'web_url', title: 'الموقع', url: 'https://x.test/a' }],
    });

    it('is ONE body holding both properties, as Meta documents each: call_to_actions with question and payload under the default locale, and the menu\'s postback and web_url buttons', () => {
        const plan = planPublish(config, null);
        assert.ok(plan);
        assert.deepEqual(plan!.remove, []);
        assert.deepEqual(plan!.set, {
            platform: 'instagram',
            ice_breakers: [{
                call_to_actions: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
                locale: 'default',
            }],
            persistent_menu: [{
                locale: 'default',
                call_to_actions: [
                    { type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN' },
                    { type: 'web_url', title: 'الموقع', url: 'https://x.test/a' },
                ],
            }],
        });
        assert.equal(PROFILE_LOCALE, 'default', 'Meta: "default locale is REQUIRED"');
    });

    it('a web_url button carries a url and no payload; a postback carries a payload and no url (Meta rejects unknown keys inside a template)', () => {
        const items = planPublish(config, null)!.set!.persistent_menu![0]!.call_to_actions;
        assert.deepEqual(Object.keys(items[0]!).sort(), ['payload', 'title', 'type']);
        assert.deepEqual(Object.keys(items[1]!).sort(), ['title', 'type', 'url']);
    });

    it('with no menu, the body has no persistent_menu at all (not an empty list)', () => {
        const plan = planPublish({ iceBreakers: config.iceBreakers, menu: [] }, null);
        assert.deepEqual(Object.keys(plan!.set!).sort(), ['ice_breakers', 'platform']);
        assert.equal('persistent_menu' in plan!.set!, false);
    });

    it('with only a menu, the body has no ice_breakers', () => {
        const plan = planPublish({ iceBreakers: [], menu: config.menu }, null);
        assert.deepEqual(Object.keys(plan!.set!).sort(), ['persistent_menu', 'platform']);
    });

    it('nothing to set and nothing this app published is nothing to do: null, so the route refuses', () => {
        assert.equal(planPublish(EMPTY_CONFIG, null), null);
        assert.equal(planPublish(EMPTY_CONFIG, { iceBreakers: 0, menu: 0 }), null);
    });

    it('a property the editor emptied is REMOVED, but only because this app published it', () => {
        const onlyIce = { iceBreakers: config.iceBreakers, menu: [] };
        assert.deepEqual(planPublish(onlyIce, { iceBreakers: 2, menu: 2 })!.remove, ['persistent_menu'], 'the menu this app put there goes');
        assert.deepEqual(planPublish(onlyIce, { iceBreakers: 2, menu: 0 })!.remove, [], 'a menu this app never published is not touched');
        assert.deepEqual(planPublish(onlyIce, null)!.remove, [], 'with no record of a publish nothing is deleted');

        const onlyMenu = { iceBreakers: [], menu: config.menu };
        assert.deepEqual(planPublish(onlyMenu, { iceBreakers: 3, menu: 0 })!.remove, ['ice_breakers']);
    });

    it('a draft that is only removals has no body to set: a DELETE and no POST', () => {
        const plan = planPublish(EMPTY_CONFIG, { iceBreakers: 2, menu: 1 });
        assert.equal(plan!.set, null);
        assert.deepEqual(plan!.remove, ['ice_breakers', 'persistent_menu']);
    });

    it('"Remove from Instagram" names both properties, and the read-back asks for both, comma-separated', () => {
        assert.deepEqual([...REMOVE_FIELDS], ['ice_breakers', 'persistent_menu']);
        assert.equal(READ_FIELDS, 'ice_breakers,persistent_menu');
    });
});

describe('the fingerprint of a draft', () => {
    const a = configOf({ iceBreakers: ice(2), menu: menu(1) });

    it('is stable, and the same for the same words however the object was built', () => {
        assert.equal(fingerprint(a), fingerprint(configOf({ menu: menu(1), iceBreakers: ice(2) })));
        assert.match(fingerprint(a), /^[0-9a-f]{16}$/);
    });

    it('changes with a word, a code, an order, a link and a type', () => {
        const base = fingerprint(a);
        const edit = (fn: (c: any) => void): string => { const c = JSON.parse(JSON.stringify(a)); fn(c); return fingerprint(c); };
        assert.notEqual(edit((c) => { c.iceBreakers[0].question += '!'; }), base);
        assert.notEqual(edit((c) => { c.iceBreakers[0].payload = 'TAP_LINK'; }), base);
        assert.notEqual(edit((c) => { c.iceBreakers.reverse(); }), base);
        assert.notEqual(edit((c) => { c.menu[0] = { type: 'web_url', title: 'Item 1', url: 'https://x.test' }; }), base);
        assert.notEqual(edit((c) => { c.menu = []; }), base);
    });
});

describe('what Meta says it holds', () => {
    it('reads the Instagram ice-breaker page\'s shape: the locale objects straight in `data`', () => {
        const live = readLiveProfile({ data: [{ call_to_actions: [{ question: 'Q1', payload: 'P1' }, { question: 'Q2', payload: 'P2' }], locale: 'default' }, { call_to_actions: [{ question: 'Q3', payload: 'P3' }], locale: 'en_GB' }] });
        assert.deepEqual(live, {
            iceBreakers: [
                { locale: 'default', items: [{ question: 'Q1', payload: 'P1' }, { question: 'Q2', payload: 'P2' }] },
                { locale: 'en_GB', items: [{ question: 'Q3', payload: 'P3' }] },
            ],
            menu: [],
        });
    });

    it('reads the persistent-menu page\'s shape: `{ persistent_menu: [...] }` inside data', () => {
        const live = readLiveProfile({ data: [{ persistent_menu: [{ locale: 'default', call_to_actions: [{ type: 'postback', title: 'Talk', payload: 'TAP_HUMAN' }, { type: 'web_url', title: 'Site', url: 'https://x.test' }] }] }] });
        assert.deepEqual(live.menu, [{ locale: 'default', items: [{ type: 'postback', title: 'Talk', payload: 'TAP_HUMAN' }, { type: 'web_url', title: 'Site', url: 'https://x.test' }] }]);
        assert.deepEqual(live.iceBreakers, []);
    });

    it('reads the multi-field shape: every property in ONE object', () => {
        const live = readLiveProfile({ data: [{
            ice_breakers: [{ call_to_actions: [{ question: 'Q', payload: 'P' }], locale: 'default' }],
            persistent_menu: [{ locale: 'default', call_to_actions: [{ type: 'postback', title: 'T', payload: 'X' }] }],
        }] });
        assert.equal(live.iceBreakers[0]!.items[0]!.question, 'Q');
        assert.equal(live.menu[0]!.items[0]!.title, 'T');
    });

    it('reads the old ice-breaker format: bare questions, put under the default locale', () => {
        const live = readLiveProfile({ data: [{ ice_breakers: [{ question: 'Old 1', payload: 'A' }, { question: 'Old 2', payload: 'B' }] }] });
        assert.deepEqual(live.iceBreakers, [{ locale: 'default', items: [{ question: 'Old 1', payload: 'A' }, { question: 'Old 2', payload: 'B' }] }]);
    });

    it('nothing Meta sent that fits none of these is an empty profile, never a throw', () => {
        for (const odd of [null, undefined, 'x', 42, [], {}, { data: 'no' }, { data: [null, 7, 'x', [], {}] }, { data: [{ ice_breakers: 'x', persistent_menu: {} }] }, { data: [{ call_to_actions: [] }] }]) {
            assert.deepEqual(readLiveProfile(odd), { iceBreakers: [], menu: [] }, JSON.stringify(odd));
        }
    });

    it('a string from Meta is cut to a length a screen can show, whatever it sent', () => {
        const live = readLiveProfile({ data: [{ call_to_actions: [{ question: 'q'.repeat(5000), payload: 'p'.repeat(5000) }], locale: 'l'.repeat(500) }] });
        assert.equal(live.iceBreakers[0]!.items[0]!.question.length, 300);
        assert.equal(live.iceBreakers[0]!.items[0]!.payload.length, 300);
        assert.equal(live.iceBreakers[0]!.locale.length, 20);
    });
});

describe('the suggestions', () => {
    it('are there for every kit the profile can speak: a register added later fails here', () => {
        assert.deepEqual([...SUGGESTION_KITS].sort(), [...KIT_KEYS].sort());
    });

    it('are four, each a question that fits, with a code of ours, and each code once', () => {
        for (const kit of KIT_KEYS) {
            for (const name of [null, 'Plan A', 'ن'.repeat(200)]) {
                const got = suggestIceBreakers(kit, name);
                assert.equal(got.length, 4, kit);
                assert.ok(got.length <= ICE_BREAKER_MAX);
                assert.deepEqual(got.map((s) => s.payload), ['TAP_INFO', 'TAP_LEVEL', 'TAP_PRICE', 'TAP_LINK']);
                for (const s of got) assert.ok(s.question.length > 0 && charCount(s.question) <= ICE_BREAKER_QUESTION_MAX, `${kit}: ${s.question}`);
            }
        }
    });

    it('are publishable exactly as they are: they pass the same validation the owner\'s own words do', () => {
        for (const kit of KIT_KEYS) {
            const r = parseConfig({ iceBreakers: suggestIceBreakers(kit, 'Plan A') });
            assert.equal(r.ok, true, `${kit}: ${JSON.stringify(r)}`);
        }
    });

    it('name the offer when there is one, and say it without a name when there is none, or when the name will not fit a button', () => {
        assert.equal(suggestIceBreakers('gulf', 'Plan A')[0]!.question, 'وش يتضمن Plan A؟');
        assert.equal(suggestIceBreakers('en', 'Plan A')[0]!.question, 'What does Plan A include?');
        assert.equal(suggestIceBreakers('gulf', null)[0]!.question, 'وش اللي تقدمونه؟');
        assert.equal(suggestIceBreakers('gulf', '   ')[0]!.question, 'وش اللي تقدمونه؟');
        assert.equal(suggestIceBreakers('en', 'x'.repeat(200))[0]!.question, 'What do you offer?');
    });

    it('the Gulf set is the owner\'s four questions, in his words', () => {
        assert.deepEqual(suggestIceBreakers('gulf', null).slice(1).map((s) => s.question), ['يناسب المبتدئين؟', 'وش السعر؟', 'أبي الرابط']);
    });

    it('speak the register they are for: the Egyptian and neutral Arabic sets have none of the Gulf\'s words', () => {
        for (const kit of ['egyptian', 'msa'] as const) {
            for (const s of suggestIceBreakers(kit, 'Plan A')) assertNoGulfInEgyptianOrMsa(s.question, `${kit}: ${s.question}`);
        }
        assert.notEqual(suggestIceBreakers('egyptian', null)[3]!.question, suggestIceBreakers('gulf', null)[3]!.question);
    });

    it('English is English, with no Arabic letter in it', () => {
        for (const s of suggestIceBreakers('en', 'Plan A')) assert.ok(!/[؀-ۿ]/.test(s.question), s.question);
    });

    it('name no product and no person of the owner\'s: the offer comes from the profile, the words come from here', () => {
        for (const kit of KIT_KEYS) {
            for (const s of suggestIceBreakers(kit, null)) assert.deepEqual(ownerMarkersIn(s.question), [], `${kit}: ${s.question}`);
        }
    });
});
