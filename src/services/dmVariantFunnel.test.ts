/**
 * The A/B comparison of the DM funnel (`dmVariantFunnel.ts`, DM plan S14): the counting and the minimum-sample gate, from a fixture world worked out
 * BY HAND (below), and what `buildDmFunnel` does with it.
 *
 * The world, all of it inside the 30-day cohort (a person's click is `is_prefetch: false`; a preview is not a click):
 *
 *   arm A (Warm, share 50)   40 conversations   8 new, 12 only qualified, 10 recommended, 6 linked (a preview opened one of them), 4 linked and clicked
 *   arm B (Direct, share 50) 35 conversations   10 new, 11 qualified, 7 recommended, 6 linked, 1 linked and clicked
 *   arm C (Old, share 0)     12 conversations   4 new, 2 qualified, 2 recommended, 2 linked, 2 linked and clicked           (retired: under the floor)
 *   no arm                   5 conversations    all linked and clicked: they began before the experiment, and are in the funnel, not here
 *   ghost                    an assignment for a conversation that is not in the cohort: ignored
 *
 * Worked out:
 *
 *   A   recommended 10 + 6 + 4 = 20, link sent 6 + 4 = 10, clicked 4.      link 10/20 = 50%, click 4/10 = 40%      (40 >= 30: shown)
 *   B   recommended 7 + 6 + 1 = 14, link sent 6 + 1 = 7, clicked 1.        link 7/14 = 50%, click 1/7 = 14.3 -> 14%  (35 >= 30: shown)
 *   C   recommended 2 + 2 + 2 = 6, link sent 2 + 2 = 4, clicked 2.         the counts only: 12 < 30, no percentage
 *   comparable: A and B have enough, so yes. Not a claim that they differ: nothing here says which is better.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDmFunnel, reachedOf, type ClickFact, type ConversationFact } from './dmFunnel.js';
import { buildVariantBreakdown, MIN_VARIANT_SAMPLE, type VariantFact } from './dmVariantFunnel.js';
import type { SalesVariant, VariantConfig } from './dmSales/variants.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');

const fact = (id: string, over: Partial<ConversationFact> = {}): ConversationFact => ({
    id, stage: 'new', qualifier_turns: 0, links_sent: 0, last_link_at: null, followups_sent: 0, handoff_at: null, handoff_reason: null,
    opted_out_at: null, stages_seen: [], ...over,
});
const NEW = {};
const QUALIFY = { stage: 'qualify', qualifier_turns: 1 };
const RECOMMEND = { stage: 'recommend', stages_seen: ['recommend'] };
const LINKED = { stage: 'link', links_sent: 1, last_link_at: new Date(NOW - 3_600_000), stages_seen: ['link'] };

/** `count` conversations `prefix1..prefixN` that all look like `over`. */
const many = (prefix: string, count: number, over: Partial<ConversationFact>): ConversationFact[] => Array.from({ length: count }, (_, i) => fact(`${prefix}${i + 1}`, over));

const arm = (id: SalesVariant['id'], label: string, weight: number): SalesVariant => ({ id, label, weight, opening: '', cta: '' });
const CONFIG: VariantConfig = { enabled: true, variants: [arm('A', 'Warm', 50), arm('B', 'Direct', 50), arm('C', 'Old', 0)] };
const AB: VariantConfig = { enabled: true, variants: [arm('A', 'Warm', 50), arm('B', 'Direct', 50)] };

interface World {
    cohort: ConversationFact[];
    clicks: ClickFact[];
    assignments: VariantFact[];
}

function world(): World {
    const a = [
        ...many('a-new-', 8, NEW), ...many('a-q-', 12, QUALIFY), ...many('a-rec-', 10, RECOMMEND), ...many('a-link-', 6, LINKED), ...many('a-click-', 4, LINKED),
    ];
    const b = [
        ...many('b-new-', 10, NEW), ...many('b-q-', 11, QUALIFY), ...many('b-rec-', 7, RECOMMEND), ...many('b-link-', 6, LINKED), ...many('b-click-', 1, LINKED),
    ];
    const c = [
        ...many('c-new-', 4, NEW), ...many('c-q-', 2, QUALIFY), ...many('c-rec-', 2, RECOMMEND), ...many('c-link-', 2, LINKED), ...many('c-click-', 2, LINKED),
    ];
    const none = many('none-', 5, LINKED);
    const clicks: ClickFact[] = [
        ...[1, 2, 3, 4].map((i) => ({ conversation_id: `a-click-${i}`, is_prefetch: false, n: 1 })),
        { conversation_id: 'a-link-3', is_prefetch: true, n: 2 },           // a preview opened it: not a click
        { conversation_id: 'b-click-1', is_prefetch: false, n: 2 },        // two visits by the same person: ONE conversation clicked
        ...[1, 2].map((i) => ({ conversation_id: `c-click-${i}`, is_prefetch: false, n: 1 })),
        ...[1, 2, 3, 4, 5].map((i) => ({ conversation_id: `none-${i}`, is_prefetch: false, n: 1 })),
    ];
    const assign = (list: ConversationFact[], arm: string): VariantFact[] => list.map((f) => ({ id: f.id, sales_variant: arm }));
    return {
        cohort: [...a, ...b, ...c, ...none],
        clicks,
        assignments: [...assign(a, 'A'), ...assign(b, 'B'), ...assign(c, 'C'), { id: 'ghost', sales_variant: 'A' }],
    };
}

const breakdownOf = (w: World, config: VariantConfig | null = CONFIG) => {
    const funnel = buildDmFunnel(w.cohort, w.clicks, null, { days: 30, now: NOW, variants: { config, assignments: w.assignments } });
    return funnel.variants;
};

describe('the A/B breakdown of the funnel: the fixture world, counted by hand', () => {
    it('counts each arm\'s conversations, how many were recommended, linked and clicked, and the two rates with the numbers they are made of', () => {
        const v = breakdownOf(world());
        assert.ok(v);
        const [a, b] = v.arms;
        assert.deepEqual(
            [a!.id, a!.label, a!.weight, a!.conversations, a!.recommended, a!.link_sent, a!.clicked, a!.enough],
            ['A', 'Warm', 50, 40, 20, 10, 4, true]
        );
        assert.deepEqual(a!.link, { count: 10, of: 20, pct: 50 });
        assert.deepEqual(a!.click, { count: 4, of: 10, pct: 40 });
        assert.deepEqual(
            [b!.id, b!.label, b!.weight, b!.conversations, b!.recommended, b!.link_sent, b!.clicked, b!.enough],
            ['B', 'Direct', 50, 35, 14, 7, 1, true]
        );
        assert.deepEqual(b!.link, { count: 7, of: 14, pct: 50 });
        assert.deepEqual(b!.click, { count: 1, of: 7, pct: 14 }, '1 of 7 is 14.3%');
    });

    it('shows an arm under the floor as its COUNTS only: the same numbers, and no percentage', () => {
        const c = breakdownOf(world())!.arms[2]!;
        assert.deepEqual([c.id, c.label, c.weight, c.conversations, c.recommended, c.link_sent, c.clicked, c.enough], ['C', 'Old', 0, 12, 6, 4, 2, false]);
        assert.deepEqual(c.link, { count: 4, of: 6, pct: null }, '4 of 6 is a count, not a rate: 12 conversations');
        assert.deepEqual(c.click, { count: 2, of: 4, pct: null });
    });

    it('says the arms can be set side by side only when at least two of them have enough, and says the floor it applied', () => {
        const v = breakdownOf(world())!;
        assert.equal(v.min_sample, MIN_VARIANT_SAMPLE);
        assert.equal(v.min_sample, 30);
        assert.equal(v.comparable, true);
        assert.equal(v.running, true);
        // Drop arm B to 12 conversations: one arm with enough is nothing to compare with.
        const w = world();
        const drop = new Set(w.cohort.filter((f) => f.id.startsWith('b-')).slice(12).map((f) => f.id));
        const small: World = { ...w, cohort: w.cohort.filter((f) => !drop.has(f.id)), assignments: w.assignments.filter((x) => !drop.has(x.id)) };
        const v2 = breakdownOf(small)!;
        assert.equal(v2.arms[1]!.conversations, 12);
        assert.equal(v2.arms[1]!.enough, false);
        assert.equal(v2.comparable, false);
    });

    it('leaves out of every number the conversations that have no arm (they are in the funnel), and an assignment for a conversation that is not in the cohort', () => {
        const w = world();
        const v = breakdownOf(w)!;
        assert.equal(v.arms.reduce((n, x) => n + x.conversations, 0), 40 + 35 + 12, 'the five with no arm are in no arm, and "ghost" is nowhere');
        // The funnel's own numbers still count them: five more linked and clicked conversations.
        const funnel = buildDmFunnel(w.cohort, w.clicks, null, { days: 30, now: NOW, variants: { config: CONFIG, assignments: w.assignments } });
        assert.equal(funnel.conversations, 40 + 35 + 12 + 5);
        assert.equal(funnel.steps.find((s) => s.id === 'clicked')!.count, 4 + 1 + 2 + 5);
    });

    it('does not count a preview as a click, and counts a person who clicked twice once', () => {
        const [a, b] = breakdownOf(world())!.arms;
        assert.equal(a!.clicked, 4, 'a-link-3 was only previewed');
        assert.equal(b!.clicked, 1, 'b-click-1 visited twice');
    });

    it('counts by the funnel\'s own rule: every arm\'s numbers are what `reachedOf` says of its conversations', () => {
        const w = world();
        const v = breakdownOf(w)!;
        const humans = new Map<string, number>();
        for (const c of w.clicks) if (!c.is_prefetch) humans.set(c.conversation_id, (humans.get(c.conversation_id) ?? 0) + Number(c.n));
        const armOf = new Map(w.assignments.map((x) => [x.id, x.sales_variant]));
        for (const row of v.arms) {
            const own = w.cohort.filter((f) => armOf.get(f.id) === row.id).map((f) => reachedOf(f, humans.get(f.id) ?? 0));
            assert.equal(row.recommended, own.filter((r) => r.recommended).length, row.id);
            assert.equal(row.link_sent, own.filter((r) => r.linked).length, row.id);
            assert.equal(row.clicked, own.filter((r) => r.clicked).length, row.id);
        }
    });
});

describe('the minimum-sample gate', () => {
    /** `n` conversations in arm A (all linked and clicked, which would be 100%) and as many in B, so the gate alone decides what is shown. */
    const exactly = (n: number) => {
        const cohort = [...many('a', n, LINKED), ...many('b', n, LINKED)];
        const clicks: ClickFact[] = cohort.map((f) => ({ conversation_id: f.id, is_prefetch: false, n: 1 }));
        const assignments: VariantFact[] = cohort.map((f) => ({ id: f.id, sales_variant: f.id.startsWith('a') ? 'A' : 'B' }));
        return breakdownOf({ cohort, clicks, assignments }, AB)!;
    };

    it('shows no percentage at 29 conversations in an arm, and shows it at 30: the gate is on conversations', () => {
        const below = exactly(MIN_VARIANT_SAMPLE - 1);
        for (const row of below.arms) {
            assert.equal(row.enough, false);
            assert.equal(row.link.pct, null);
            assert.equal(row.click.pct, null);
            assert.equal(row.link.count, 29, 'the counts are still there');
            assert.equal(row.click.of, 29);
        }
        assert.equal(below.comparable, false);

        const at = exactly(MIN_VARIANT_SAMPLE);
        for (const row of at.arms) {
            assert.equal(row.enough, true);
            assert.equal(row.link.pct, 100);
            assert.equal(row.click.pct, 100);
        }
        assert.equal(at.comparable, true);
    });

    it('applies per arm: one arm with enough shows its rates beside one that has not', () => {
        const cohort = [...many('a', 31, LINKED), ...many('b', 5, LINKED)];
        const assignments: VariantFact[] = cohort.map((f) => ({ id: f.id, sales_variant: f.id.startsWith('a') ? 'A' : 'B' }));
        const v = breakdownOf({ cohort, clicks: [], assignments }, AB)!;
        assert.deepEqual(v.arms.map((r) => [r.id, r.enough, r.link.pct]), [['A', true, 100], ['B', false, null]]);
        assert.equal(v.comparable, false, 'one arm with enough is not a comparison');
    });

    it('shows no percentage when there is nothing to divide by, even above the floor', () => {
        const cohort = many('a', 40, NEW);
        const v = breakdownOf({ cohort, clicks: [], assignments: cohort.map((f) => ({ id: f.id, sales_variant: 'A' })) }, AB)!;
        assert.equal(v.arms[0]!.enough, true);
        assert.deepEqual(v.arms[0]!.link, { count: 0, of: 0, pct: null });
        assert.deepEqual(v.arms[0]!.click, { count: 0, of: 0, pct: null });
    });

    it('claims nothing it does not compute: the answer has no winner, no significance and no confidence, only counts, rates and the floor', () => {
        const v = breakdownOf(world())!;
        assert.deepEqual(Object.keys(v).sort(), ['arms', 'comparable', 'min_sample', 'running']);
        assert.deepEqual(Object.keys(v.arms[0]!).sort(), ['click', 'clicked', 'conversations', 'enough', 'id', 'label', 'link', 'link_sent', 'recommended', 'weight']);
        assert.equal(/winner|signific|confiden|p_value|lift|better/i.test(JSON.stringify(v)), false);
    });
});

describe('the arms a funnel shows', () => {
    it('lists an arm that is in the editor with no conversation yet, with zeros: the owner sees the experiment started', () => {
        const v = breakdownOf({ cohort: [], clicks: [], assignments: [] })!;
        assert.deepEqual(v.arms.map((r) => [r.id, r.conversations, r.enough, r.link.pct]), [['A', 0, false, null], ['B', 0, false, null], ['C', 0, false, null]]);
        assert.equal(v.running, true);
        assert.equal(v.comparable, false);
    });

    it('keeps an arm that is no longer in the editor, by its slot and with no name, for as long as it holds conversations', () => {
        const cohort = [...many('a', 3, LINKED), ...many('z', 2, NEW)];
        const assignments: VariantFact[] = [...cohort.slice(0, 3).map((f) => ({ id: f.id, sales_variant: 'A' })), ...cohort.slice(3).map((f) => ({ id: f.id, sales_variant: 'C' }))];
        const config: VariantConfig = { enabled: true, variants: [arm('A', 'Warm', 50), arm('B', 'Direct', 50)] };
        const v = breakdownOf({ cohort, clicks: [], assignments }, config)!;
        assert.deepEqual(v.arms.map((r) => [r.id, r.label, r.weight, r.conversations]), [['A', 'Warm', 50, 3], ['B', 'Direct', 50, 0], ['C', null, null, 2]]);
    });

    it('is not running once the owner switches it off, and still shows what happened', () => {
        const w = world();
        const off = breakdownOf(w, { ...CONFIG, enabled: false })!;
        assert.equal(off.running, false);
        assert.equal(off.arms[0]!.conversations, 40);
        const noConfig = breakdownOf(w, null)!;
        assert.equal(noConfig.running, false, 'the arms were written on the conversations, so they are shown');
        assert.deepEqual(noConfig.arms.map((r) => [r.id, r.label]), [['A', null], ['B', null], ['C', null]]);
    });

    it('ignores a value no slot has', () => {
        const cohort = many('a', 2, LINKED);
        const v = breakdownOf({ cohort, clicks: [], assignments: [{ id: 'a1', sales_variant: 'Z' }, { id: 'a2', sales_variant: null }] }, null);
        assert.equal(v, undefined, 'nothing configured and nothing assigned: no section at all');
    });

    it('is no section for a tenant with no experiment and no arm: the funnel is exactly what it was', () => {
        assert.equal(buildVariantBreakdown([], [], [], null), null);
        assert.equal(buildVariantBreakdown([], [], [], { enabled: false, variants: [] }), null);
        // And the funnel's own numbers are byte for byte the same with the section absent.
        const world30 = buildDmFunnel([fact('x')], [], null, { days: 30, now: NOW });
        const withEmpty = buildDmFunnel([fact('x')], [], null, { days: 30, now: NOW, variants: { config: null, assignments: [] } });
        assert.deepEqual(withEmpty, world30);
        assert.equal('variants' in withEmpty, false);
    });
});
