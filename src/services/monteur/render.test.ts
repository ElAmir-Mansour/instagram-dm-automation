/**
 * The render payload's human touches (MONTEUR.md §3, §6.2): what `buildRenderPayload` adds for a
 * clip's stored plan, and that a missing plan or `monteur.human` off adds nothing, so the worker
 * renders as before. The sweep's and a re-render's payloads are in sweep.test.ts and clips.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClipDirection } from '../../db/rows.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { brandColours, NO_BRAND, type RenderBrand } from '../brand/resolve.js';
import { accentsFor, buildRenderPayload, touchFields } from './render.js';

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
    brand: NO_BRAND,
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

describe('buildRenderPayload and accentsFor — the Brand Kit (docs: contract §3, §4)', () => {
    const LOGO = { url: 'https://msg-response-auto.vercel.app/api/uploads/6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23', width: 1200, height: 400, alpha: true, tone: 'dark' as const, colour: '#0E3B5C' };
    const build = (brand: RenderBrand) => buildRenderPayload({
        clipId: 'clip', source: { id: 'src', path: '/v/a.mp4', words: [[10, 10.4, 'كلمة']] }, start: 9.85, end: 34.8,
        title: 'عنوان', keyword: 'دفتر', accent: '#FFD60A', edits: [], settings: ELAMIR_SETTINGS, brand,
    });

    it('NO_BRAND is today\'s payload, byte for byte, and the same key order', () => {
        const out = build(NO_BRAND);
        assert.equal(JSON.stringify(out), JSON.stringify(build({ logo: null, colours: null })));
        assert.deepEqual(Object.keys(out.brand), ['accent', 'font', 'direction', 'style']);
        assert.equal(out.brand.accent, '#FFD60A');
        assert.equal(JSON.stringify(out).includes('logo'), false);
    });

    it('a logo with the switch off: only brand.logo is added, last', () => {
        const plain = build(NO_BRAND);
        const out = build({ logo: LOGO, colours: null });
        assert.deepEqual(Object.keys(out.brand), ['accent', 'font', 'direction', 'style', 'logo']);
        assert.equal(JSON.stringify(out.brand.logo), JSON.stringify(LOGO));
        const { logo: _logo, ...rest } = out.brand;
        assert.equal(JSON.stringify({ ...out, brand: rest }), JSON.stringify(plain));
    });

    it('a logo with the switch on: the payload\'s accent is still the one it was given (the switch acts in accentsFor)', () => {
        const out = build({ logo: LOGO, colours: brandColours('#0E3B5C', '#F2A33A') });
        assert.equal(out.brand.accent, '#FFD60A');
        assert.deepEqual(out.brand.logo, LOGO);
    });

    it('accentsFor with the switch on: the brand\'s reel accent for every new clip, and no read of the recent ones', async () => {
        const asked: string[] = [];
        const exec = { query: async (sql: string) => { asked.push(sql); return { rows: [] }; } } as never;
        const out = await accentsFor(exec, 'tenant', ELAMIR_SETTINGS, 3, { logo: null, colours: brandColours('#0E3B5C', '#1B2A41') });
        const accent = brandColours('#0E3B5C', '#1B2A41').reelAccent;
        assert.deepEqual(out, [accent, accent, accent]);
        assert.deepEqual(asked, []);
    });

    it('accentsFor with the switch off (a logo or not): the palette and the recent accents, as before', async () => {
        const exec = { query: async () => ({ rows: [{ accent: ELAMIR_SETTINGS.brand.palette[0] }] }) } as never;
        for (const brand of [NO_BRAND, { logo: LOGO, colours: null }]) {
            const out = await accentsFor(exec, 'tenant', ELAMIR_SETTINGS, 2, brand);
            assert.equal(out.length, 2);
            assert.ok(out.every((a) => ELAMIR_SETTINGS.brand.palette.includes(a)));
            assert.notEqual(out[0], ELAMIR_SETTINGS.brand.palette[0], 'it avoids the recent accent');
        }
    });
});
