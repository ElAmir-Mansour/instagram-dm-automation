/**
 * The render payload's human touches (MONTEUR.md §3, §6.2): what `buildRenderPayload` adds for a
 * clip's stored plan, and that a missing plan or `monteur.human` off adds nothing, so the worker
 * renders as before. The sweep's and a re-render's payloads are in sweep.test.ts and clips.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClipDirection } from '../../db/rows.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { buildRenderPayload, touchFields } from './render.js';

const PLAN: ClipDirection = {
    cuts: [{ t: 2.5, shot: 'close' }, { t: 8, shot: 'wide' }],
    doodles: [{ t: 3.1, shape: 'arrow', target: 'head' }],
    freezes: [{ t: 9.4, text: 'استنى' }],
    transitions: [{ t: 12, kind: 'glitch' }],
    behind: [{ t: 5, text: 'عشرة أضعاف' }],
    emphasis: [2.5, 6.25],
};

const payload = (direction: ClipDirection | null | undefined, human = true) => buildRenderPayload({
    clipId: 'clip', source: { id: 'src', path: '/v/a.mp4', words: [[10, 10.4, 'كلمة']] }, start: 9.85, end: 34.8,
    title: 'عنوان', keyword: 'دفتر', accent: '#FFD60A', edits: [],
    settings: { ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, human } },
    ...(direction === undefined ? {} : { direction }),
});
const BEFORE = ['brand', 'clipId', 'cover_at', 'cta', 'cta_tiktok', 'edits', 'end', 'path', 'sourceId', 'start', 'title', 'words'];

describe('buildRenderPayload — the human touches', () => {
    it('adds direction (cuts, doodles, freezes, transitions), emphasis (the times) and behind ([{ t, text }])', () => {
        const p = payload(PLAN);
        assert.deepEqual(Object.keys(p).sort(), [...BEFORE, 'behind', 'direction', 'emphasis'].sort());
        assert.deepEqual(p.direction, { cuts: PLAN.cuts, doodles: PLAN.doodles, freezes: PLAN.freezes, transitions: PLAN.transitions });
        assert.ok(!('emphasis' in p.direction!) && !('behind' in p.direction!));
        assert.deepEqual(p.emphasis, [2.5, 6.25]);
        assert.deepEqual(p.behind, [{ t: 5, text: 'عشرة أضعاف' }]);
        assert.equal(p.brand.direction, ELAMIR_SETTINGS.brand.direction, 'the brand’s reading direction is another field');
    });

    it('sends nothing new with no plan, or with monteur.human off: the payload as before', () => {
        for (const [plan, human] of [[null, true], [undefined, true], [PLAN, false], [null, false]] as const) {
            assert.deepEqual(Object.keys(payload(plan, human)).sort(), BEFORE, `${JSON.stringify(plan)?.slice(0, 20)} ${human}`);
        }
    });

    it('copies the lists, and sends a list missing from a stored plan as empty', () => {
        const fields = touchFields(PLAN);
        fields.emphasis.push(99);
        fields.direction.cuts.push({ t: 1, shot: 'wide' });
        assert.deepEqual(PLAN.emphasis, [2.5, 6.25]);
        assert.equal(PLAN.cuts.length, 2);
        assert.deepEqual(touchFields({ emphasis: [4] } as unknown as ClipDirection), {
            direction: { cuts: [], doodles: [], freezes: [], transitions: [] }, emphasis: [4], behind: [],
        });
    });
});
