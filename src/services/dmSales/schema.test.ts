/**
 * The schema the sales model answers in (`schema.ts`): inside Anthropic's structured-output limits (24 optional properties, 16
 * union-typed ones; a request over them is a 400 that says only "too complex"), with every field required and the enums carrying 'none'.
 * The schema a tenant with real offers gets is also pinned byte for byte, by the `dm.sales-schema` golden (`golden.test.ts`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_OPTIONAL_PROPERTIES, MAX_UNION_PROPERTIES } from '../llm/adapters/anthropic.js';
import type { GeminiSchema } from '../llm/geminiSchema.js';
import { dropNulls, jsonSchemaFor, matchesRoot, missingRequired, rootKind, schemaComplexity, strictify } from '../llm/schema.js';
import { salesReplySchema } from './schema.js';
import { HANDOFF_REASONS, INTENTS, NEXT_ACTIONS, NO_OFFER, STAGES } from './types.js';

const gemini = (ids: readonly string[]): GeminiSchema => salesReplySchema(ids) as GeminiSchema;

describe('salesReplySchema stays inside Anthropic\'s limits', () => {
    for (const ids of [[], ['main'], ['main', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']]) {
        it(`with ${ids.length} offers: no optional property and no union-typed one`, () => {
            const json = jsonSchemaFor(salesReplySchema(ids));
            const { optional, unions } = schemaComplexity(json);
            assert.equal(optional, 0, 'every field is required');
            assert.equal(unions, 0, 'enums carry "none"; nothing is nullable');
            assert.ok(optional <= MAX_OPTIONAL_PROPERTIES && unions <= MAX_UNION_PROPERTIES);
        });
    }

    it('lists every top-level property as required', () => {
        const s = gemini(['main']);
        assert.deepEqual([...s.required!].sort(), Object.keys(s.properties!).sort());
        assert.deepEqual([...s.required!].sort(), ['handoff_reason', 'intent', 'next_action', 'offer_id', 'quick_replies', 'stage', 'text']);
        assert.equal(s.type, 'OBJECT');
    });

    it('is a plain object schema every provider reads: closed, with a known root, and required keys the check can find', () => {
        const schema = salesReplySchema(['main']);
        const json = jsonSchemaFor(schema);
        assert.equal(json.additionalProperties, false);
        assert.equal(rootKind(schema), 'object');
        assert.ok(matchesRoot({}, rootKind(schema)));
        assert.deepEqual(missingRequired({ text: 'x' }, schema).sort(), ['handoff_reason', 'intent', 'next_action', 'offer_id', 'quick_replies', 'stage']);
    });

    it('survives OpenAI\'s strict reshaping untouched: nothing in it was optional, so nothing becomes nullable', () => {
        const json = jsonSchemaFor(salesReplySchema(['main', 'other']));
        const strict = strictify(json);
        assert.deepEqual(strict.required, json.required);
        const answer = { intent: 'info', stage: 'new', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'hi', quick_replies: [] };
        assert.deepEqual(dropNulls(answer, json), answer);
    });
});

describe('salesReplySchema is the model\'s vocabulary, and no more', () => {
    it('draws every enum from the closed lists the coercion reads', () => {
        const p = gemini(['main']).properties!;
        assert.deepEqual(p.intent!.enum, [...INTENTS]);
        assert.deepEqual(p.stage!.enum, [...STAGES]);
        assert.deepEqual(p.next_action!.enum, [...NEXT_ACTIONS]);
        assert.deepEqual(p.handoff_reason!.enum, [...HANDOFF_REASONS]);
    });

    it('names the offers of this tenant after "none", once each, in order: the model cannot name an offer the prompt does not list', () => {
        assert.deepEqual(gemini(['main', 'a', 'main', 'b']).properties!.offer_id!.enum, [NO_OFFER, 'main', 'a', 'b']);
        assert.deepEqual(gemini([]).properties!.offer_id!.enum, [NO_OFFER], 'a tenant with no offers can say only "none"');
        assert.deepEqual(gemini(['none', 'x']).properties!.offer_id!.enum, [NO_OFFER, 'x'], '"none" is never an offer');
    });

    it('has nowhere to write a link, a price, a coupon or an image: the reply is text and up to three buttons', () => {
        const p = gemini(['main']).properties!;
        assert.deepEqual(Object.keys(p).sort(), ['handoff_reason', 'intent', 'next_action', 'offer_id', 'quick_replies', 'stage', 'text']);
        const serialised = JSON.stringify(salesReplySchema(['main']));
        for (const field of ['url', 'link', 'price', 'coupon', 'image', 'carousel', 'buttons']) {
            assert.ok(!new RegExp(`"${field}[a-z_]*":`, 'i').test(serialised), `no "${field}" property`);
        }
        const buttons = p.quick_replies!;
        assert.equal(buttons.type, 'ARRAY');
        assert.equal(buttons.maxItems, 3);
        assert.deepEqual(buttons.items!.required, ['title', 'payload']);
    });

    it('asks for the decision before the words: the model writes intent, stage and action first, so the reply is written knowing them', () => {
        const keys = Object.keys(gemini(['main']).properties!);
        assert.ok(keys.indexOf('intent') < keys.indexOf('text'));
        assert.ok(keys.indexOf('next_action') < keys.indexOf('text'));
        assert.ok(keys.indexOf('handoff_reason') < keys.indexOf('text'));
    });

    it('tells the model in the text field that no URL, price or unknown number goes in it', () => {
        const description = gemini(['main']).properties!.text!.description!;
        assert.match(description, /No URLs/);
        assert.match(description, /no prices/);
    });
});
