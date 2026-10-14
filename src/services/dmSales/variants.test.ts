/**
 * The A/B wording variants (`variants.ts`, DM plan S14): what an owner may save, how a conversation is given an arm, and that it keeps it.
 *
 * What is pinned, because each is a way an experiment lies to the person reading it: an arm that changes under a conversation's feet (the arm
 * must be a function of the conversation id and, once written, of nothing at all); weights that are not the weights (a distribution that
 * drifts from them); a conversation that began before the experiment counted in it; and wording that carries a link or a number into a prompt
 * that promises the model never writes either.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
    activeVariants, assignVariant, chooseVariant, parseVariantConfig, variantGuidance, variantPoint, VARIANT_IDS, VARIANT_LABEL_MAX, VARIANT_TEXT_MAX,
    type SalesVariant, type VariantConfig, type VariantId,
} from './variants.js';

const arm = (id: VariantId, weight: number, over: Partial<SalesVariant> = {}): SalesVariant => ({ id, label: `Arm ${id}`, weight, opening: '', cta: '', ...over });
const running = (...variants: SalesVariant[]): VariantConfig => ({ enabled: true, variants });
const TWO = running(arm('A', 50), arm('B', 50));

const problemsOf = (input: unknown) => {
    const parsed = parseVariantConfig(input);
    assert.equal(parsed.ok, false, 'refused');
    return parsed.ok ? [] : parsed.problems;
};
const codes = (input: unknown): string[] => problemsOf(input).map((p) => p.code);

// ─── What an owner may save ──────────────────────────────────────────────────────────────────

describe('parseVariantConfig', () => {
    it('accepts a running experiment of two arms, in slot order, with the texts cleaned to one line', () => {
        const parsed = parseVariantConfig({
            enabled: true,
            variants: [
                { id: 'B', label: '  Direct   offer ', weight: '30', opening: 'Open with\n one short question.', cta: 'Offer the link in one line.' },
                { id: 'A', label: 'Warm', weight: 70, opening: '', cta: '' },
            ],
        });
        assert.ok(parsed.ok);
        assert.deepEqual(parsed.config.variants.map((v) => v.id), ['A', 'B'], 'slot order, whatever order they were sent in');
        assert.deepEqual(parsed.config.variants[1], { id: 'B', label: 'Direct offer', weight: 30, opening: 'Open with one short question.', cta: 'Offer the link in one line.' });
        assert.equal(parsed.config.enabled, true);
    });

    it('accepts Arabic wording, and an arm with no wording at all (the control: the prompt as it is today)', () => {
        const parsed = parseVariantConfig({
            enabled: true,
            variants: [
                { id: 'A', label: 'كما هو', weight: 50 },
                { id: 'B', label: 'سؤال أولاً', weight: 50, opening: 'ابدأ بسؤال قصير عن هدفه.', cta: 'اعرض الرابط بجملة واحدة دافئة.' },
            ],
        });
        assert.ok(parsed.ok);
        assert.equal(parsed.config.variants[0]!.opening, '');
        assert.equal(parsed.config.variants[1]!.cta, 'اعرض الرابط بجملة واحدة دافئة.');
    });

    it('lets an experiment that is switched OFF be a draft: no arms, one arm, or no shares', () => {
        assert.ok(parseVariantConfig({ enabled: false, variants: [] }).ok);
        assert.ok(parseVariantConfig({ variants: [{ id: 'A', label: 'Only', weight: 0 }] }).ok, 'enabled defaults to off');
        assert.ok(parseVariantConfig({}).ok);
        assert.ok(parseVariantConfig({ enabled: null, variants: null }).ok);
    });

    it('refuses a running experiment that cannot compare anything: fewer than two arms, or fewer than two with a share', () => {
        assert.deepEqual(codes({ enabled: true, variants: [] }), ['too_few']);
        assert.deepEqual(codes({ enabled: true, variants: [{ id: 'A', label: 'Only', weight: 50 }] }), ['too_few']);
        assert.deepEqual(codes({ enabled: true, variants: [{ id: 'A', label: 'One', weight: 50 }, { id: 'B', label: 'Two', weight: 0 }] }), ['weights_one_arm']);
        assert.deepEqual(codes({ enabled: true, variants: [{ id: 'A', label: 'One', weight: 0 }, { id: 'B', label: 'Two', weight: 0 }] }), ['weights_one_arm']);
    });

    it('allows a retired arm (share 0) beside two that run: it keeps its conversations and gets no new ones', () => {
        const parsed = parseVariantConfig({ enabled: true, variants: [{ id: 'A', label: 'One', weight: 40 }, { id: 'B', label: 'Two', weight: 60 }, { id: 'C', label: 'Old', weight: 0 }] });
        assert.ok(parsed.ok);
    });

    it('refuses more than three arms, an id that is not a slot, and the same slot twice', () => {
        assert.ok(codes({ variants: [1, 2, 3, 4].map((n) => ({ id: 'A', label: `L${n}`, weight: 1 })) }).includes('too_many'));
        assert.ok(codes({ variants: [{ id: 'D', label: 'Four', weight: 1 }] }).includes('bad_id'));
        assert.ok(codes({ variants: [{ label: 'No id', weight: 1 }] }).includes('bad_id'));
        assert.ok(codes({ variants: [{ id: 'A', label: 'One', weight: 1 }, { id: 'A', label: 'Two', weight: 1 }] }).includes('duplicate_id'));
        assert.deepEqual([...VARIANT_IDS], ['A', 'B', 'C']);
    });

    it('refuses a missing, long or repeated name', () => {
        assert.deepEqual(codes({ variants: [{ id: 'A', label: '   ', weight: 1 }] }), ['label_missing']);
        assert.deepEqual(codes({ variants: [{ id: 'A', weight: 1 }] }), ['label_missing']);
        assert.deepEqual(codes({ variants: [{ id: 'A', label: 'x'.repeat(VARIANT_LABEL_MAX + 1), weight: 1 }] }), ['label_long']);
        assert.ok(parseVariantConfig({ variants: [{ id: 'A', label: 'x'.repeat(VARIANT_LABEL_MAX), weight: 1 }] }).ok);
        assert.deepEqual(codes({ variants: [{ id: 'A', label: 'Same', weight: 1 }, { id: 'B', label: ' same ', weight: 1 }] }), ['label_duplicate']);
    });

    it('refuses a share that is not a whole number from 0 to 100', () => {
        for (const weight of [-1, 101, 1.5, 'abc', '', null, undefined, NaN, '1e2', [50]]) {
            assert.deepEqual(codes({ variants: [{ id: 'A', label: 'One', weight }] }), ['weight_invalid'], JSON.stringify(weight));
        }
        for (const weight of [0, 1, 100, '100']) assert.ok(parseVariantConfig({ variants: [{ id: 'A', label: 'One', weight }] }).ok, JSON.stringify(weight));
    });

    it('refuses wording that carries a link: the model never writes one, the system adds it', () => {
        for (const text of ['Send https://shop.example/offer', 'see www.example.com', 'write to a@b.com', 'go to shop.example/offer', 'visit example.com', 'اضغط https://x.test/a']) {
            assert.deepEqual(codes({ variants: [{ id: 'A', label: 'One', weight: 1, cta: text }] }), ['text_link'], text);
        }
    });

    it('refuses wording that carries a number, in any script: a number the data does not hold is what the guard stops, and an arm that ends in hand-offs is not a wording test', () => {
        for (const text of ['Offer it in 2 lines', 'Say 50% off', 'اعرض الرابط في ٣ أسطر', 'عرض بسعر ۴۹', 'Mention the 1,000 learners']) {
            assert.deepEqual(codes({ variants: [{ id: 'A', label: 'One', weight: 1, opening: text }] }), ['text_number'], text);
        }
        assert.ok(parseVariantConfig({ variants: [{ id: 'A', label: 'One', weight: 1, opening: 'Offer it in two short lines.' }] }).ok, 'number words are wording');
    });

    it('refuses wording that is too long or not text, and a body that is not a config', () => {
        assert.deepEqual(codes({ variants: [{ id: 'A', label: 'One', weight: 1, cta: 'x'.repeat(VARIANT_TEXT_MAX + 1) }] }), ['text_long']);
        assert.ok(parseVariantConfig({ variants: [{ id: 'A', label: 'One', weight: 1, cta: 'x'.repeat(VARIANT_TEXT_MAX) }] }).ok);
        assert.deepEqual(codes({ variants: [{ id: 'A', label: 'One', weight: 1, cta: 7 }] }), ['text_type']);
        assert.deepEqual(codes({ enabled: 'yes' }), ['enabled_type']);
        assert.deepEqual(codes({ variants: 'A' }), ['shape']);
        assert.deepEqual(codes({ variants: ['A'] }), ['shape']);
        assert.deepEqual(codes(null), ['shape']);
        assert.deepEqual(codes([]), ['shape']);
        assert.deepEqual(codes('x'), ['shape']);
    });

    it('names where each problem is, so the editor can put it under the right field', () => {
        const problems = problemsOf({ enabled: true, variants: [{ id: 'A', label: 'One', weight: 50 }, { id: 'B', label: '', weight: 500, cta: 'see https://x.test' }] });
        assert.deepEqual(problems.map((p) => p.field).sort(), ['variants[1].cta', 'variants[1].label', 'variants[1].weight']);
        for (const p of problems) assert.ok(p.message.length > 0);
    });
});

describe('activeVariants', () => {
    it('is the arms of an experiment that is running, and null for anything that is not', () => {
        assert.equal(activeVariants(TWO)?.length, 2);
        assert.equal(activeVariants({ ...TWO, enabled: false }), null);
        assert.equal(activeVariants(null), null);
        assert.equal(activeVariants(undefined), null);
        assert.equal(activeVariants(running(arm('A', 50))), null, 'one arm is not an experiment');
        assert.equal(activeVariants(running(arm('A', 50), arm('B', 0))), null, 'one arm with a share is not either');
        assert.equal(activeVariants(running(arm('A', 50), arm('B', 50), arm('C', 0)))?.length, 3, 'a retired arm is still an arm');
    });
});

// ─── Assignment ──────────────────────────────────────────────────────────────────────────────

describe('assignVariant: a hash of the conversation id laid over the weights', () => {
    const arms = [{ id: 'A' as const, weight: 50 }, { id: 'B' as const, weight: 30 }, { id: 'C' as const, weight: 20 }];

    it('is deterministic: the same id and weights are the same arm every time, and the point is a pure function of the id (SHA-256, pinned)', () => {
        for (let i = 0; i < 50; i++) assert.equal(assignVariant('conv-1', arms), assignVariant('conv-1', arms));
        const expected = createHash('sha256').update('dm-variant:v1:conv-1').digest().readUInt32BE(0) / 2 ** 32;
        assert.equal(variantPoint('conv-1'), expected);
        // Pinned, so a change of hash, salt or ordering (which would re-roll every conversation) fails here by name.
        assert.deepEqual(
            ['conv-1', '00000000-0000-4000-8000-000000000001', 'c2b6f1f0-3d1e-4c3b-9d58-0c9a3a6e7d11', 'conv-2', 'conv-3', 'conv-4'].map((id) => assignVariant(id, arms)),
            ['B', 'A', 'C', 'A', 'B', 'C']
        );
        assert.equal(variantPoint('conv-1').toFixed(6), '0.624131');
    });

    it('is a function of the arms it is given and nothing else: a copy of the same list answers the same', () => {
        const again = arms.map((a) => ({ ...a }));
        for (let i = 0; i < 200; i++) assert.equal(assignVariant(`c-${i}`, again), assignVariant(`c-${i}`, arms));
    });

    it('spreads conversations over the weights: 50/30/20 over 20,000 ids lands within two points of each share', () => {
        const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
        const n = 20_000;
        for (let i = 0; i < n; i++) counts[assignVariant(`conversation-${i}`, arms)!]!++;
        assert.ok(Math.abs(counts.A! / n - 0.5) < 0.02, `A ${counts.A! / n}`);
        assert.ok(Math.abs(counts.B! / n - 0.3) < 0.02, `B ${counts.B! / n}`);
        assert.ok(Math.abs(counts.C! / n - 0.2) < 0.02, `C ${counts.C! / n}`);
        assert.equal(counts.A! + counts.B! + counts.C!, n, 'every conversation gets exactly one arm');
    });

    it('spreads real ids (random UUIDs) the same way, and even shares evenly', () => {
        const counts: Record<string, number> = { A: 0, B: 0 };
        const n = 10_000;
        for (let i = 0; i < n; i++) counts[assignVariant(randomUUID(), [{ id: 'A', weight: 1 }, { id: 'B', weight: 1 }])!]!++;
        assert.ok(Math.abs(counts.A! / n - 0.5) < 0.03, `A ${counts.A! / n}`);
        // Weights are shares of each other, not percentages of 100: 1 and 3 is a quarter and three quarters.
        let a = 0;
        for (let i = 0; i < n; i++) if (assignVariant(randomUUID(), [{ id: 'A', weight: 1 }, { id: 'B', weight: 3 }]) === 'A') a++;
        assert.ok(Math.abs(a / n - 0.25) < 0.03, `A ${a / n}`);
    });

    it('gives an arm with no share no conversation, and the whole line to the one that has it', () => {
        for (let i = 0; i < 2_000; i++) {
            const id = assignVariant(`c-${i}`, [{ id: 'A', weight: 0 }, { id: 'B', weight: 10 }, { id: 'C', weight: 10 }]);
            assert.ok(id === 'B' || id === 'C', String(id));
        }
        assert.equal(assignVariant('c-1', [{ id: 'A', weight: 0 }, { id: 'B', weight: 7 }]), 'B');
        assert.equal(assignVariant('c-1', [{ id: 'A', weight: 0 }, { id: 'B', weight: 0 }]), null);
        assert.equal(assignVariant('c-1', []), null);
    });

    it('is independent of the other conversations: one id is the same arm whether it is asked first or last', () => {
        const alone = assignVariant('conv-1', arms);
        for (let i = 0; i < 100; i++) assignVariant(`other-${i}`, arms);
        assert.equal(assignVariant('conv-1', arms), alone);
    });
});

// ─── Stickiness and who is in ─────────────────────────────────────────────────────────────────

describe('chooseVariant: an arm is given once and kept', () => {
    // 'conv-1' hashes to B under 50/50 (the pinned vector above says B under 50/30/20 and under 1/99; under 50/50 it is point 0.62: B).
    const opposite = (id: string, config: VariantConfig): VariantId => (assignVariant(id, config.variants) === 'A' ? 'B' : 'A');

    it('gives a NEW conversation the arm its id hashes to, and says to write it', () => {
        const choice = chooseVariant({ config: TWO, stored: null, conversationId: 'conv-1', isNew: true });
        const expected = assignVariant('conv-1', TWO.variants);
        assert.ok(expected);
        assert.equal(choice.assign, expected);
        assert.equal(choice.variant?.id, expected);
    });

    it('keeps the stored arm on every later turn, writes nothing, and never asks the hash again, whatever the weights have become', () => {
        const first = chooseVariant({ config: TWO, stored: null, conversationId: 'conv-1', isNew: true }).assign!;
        // Later turns: the arm is stored, the bot has spoken (not new), and the owner has since moved the weights the other way.
        const flipped = running(arm('A', first === 'A' ? 1 : 99), arm('B', first === 'A' ? 99 : 1));
        for (let turn = 0; turn < 5; turn++) {
            const later = chooseVariant({ config: flipped, stored: first, conversationId: 'conv-1', isNew: false });
            assert.equal(later.variant?.id, first, 'the same arm');
            assert.equal(later.assign, null, 'nothing to write');
        }
    });

    it('does not re-roll per message: with the arm stored, even a conversation that still reads as new keeps it, for any id', () => {
        for (let i = 0; i < 500; i++) {
            const id = `conversation-${i}`;
            const stored = opposite(id, TWO);   // deliberately NOT the arm the hash would pick
            const choice = chooseVariant({ config: TWO, stored, conversationId: id, isNew: true });
            assert.equal(choice.variant?.id, stored, id);
            assert.equal(choice.assign, null, id);
        }
    });

    it('gives a conversation that is not new, and has no arm, none: it began before the experiment', () => {
        assert.deepEqual(chooseVariant({ config: TWO, stored: null, conversationId: 'conv-1', isNew: false }), { variant: null, assign: null });
    });

    it('does nothing at all when no experiment is running, even for a conversation that holds an arm (that is the funnel\'s history, not the prompt\'s)', () => {
        for (const config of [null, undefined, { ...TWO, enabled: false }, running(arm('A', 50))]) {
            assert.deepEqual(chooseVariant({ config, stored: null, conversationId: 'conv-1', isNew: true }), { variant: null, assign: null });
            assert.deepEqual(chooseVariant({ config, stored: 'A', conversationId: 'conv-1', isNew: false }), { variant: null, assign: null });
        }
    });

    it('treats an arm that has since been deleted as the prompt it always had, and writes nothing over it', () => {
        const withoutC = running(arm('A', 50), arm('B', 50));
        assert.deepEqual(chooseVariant({ config: withoutC, stored: 'C', conversationId: 'conv-1', isNew: false }), { variant: null, assign: null });
        assert.deepEqual(chooseVariant({ config: withoutC, stored: 'Z', conversationId: 'conv-1', isNew: true }), { variant: null, assign: null }, 'nor does a value no slot has');
    });

    it('keeps a retired arm\'s conversations on it', () => {
        const retired = running(arm('A', 50), arm('B', 50), arm('C', 0, { cta: 'Offer it plainly.' }));
        const choice = chooseVariant({ config: retired, stored: 'C', conversationId: 'conv-1', isNew: false });
        assert.equal(choice.variant?.id, 'C');
        assert.equal(choice.assign, null);
    });
});

describe('variantGuidance', () => {
    const v = arm('A', 50, { opening: 'Open with a question.', cta: 'Offer the link in one line.' });

    it('carries the opening only for the FIRST reply and the link wording for every reply', () => {
        assert.deepEqual(variantGuidance(v, true), { opening: 'Open with a question.', cta: 'Offer the link in one line.' });
        assert.deepEqual(variantGuidance(v, false), { opening: null, cta: 'Offer the link in one line.' });
    });

    it('says nothing for no arm, for the control, and for an arm whose only text is the opening once the bot has spoken', () => {
        assert.equal(variantGuidance(null, true), undefined);
        assert.equal(variantGuidance(arm('A', 50), true), undefined, 'the control');
        assert.equal(variantGuidance(arm('B', 50, { opening: 'Open with a question.' }), false), undefined);
        assert.deepEqual(variantGuidance(arm('B', 50, { opening: 'Open with a question.' }), true), { opening: 'Open with a question.', cta: null });
    });
});
