/**
 * The prompt surface (`promptSurface.ts`): the one list of builder calls the goldens and the live parity script share.
 * `golden.test.ts` holds what each entry says; this holds that the list itself is whole, that its names are the goldens'
 * names, and that what the parity script hashes is the bytes a golden file holds.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { defaultGrowthSettings } from '../growth/settingsRow.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { goldenPath } from './golden.js';
import { sha256 } from './parity.js';
import {
    dmFallbackSurface, entryText, growthSurface, infographicSurface, studioSurface, tenantSurface, type SurfaceEntry, withRows,
} from './promptSurface.js';

/** Every builder the parity script hashes for a live tenant, in order. A builder added to the goldens is added here and to this list. */
const TENANT_SURFACE = [
    'studio.system', 'studio.plan-system', 'studio.cta-lines', 'studio.dm', 'studio.dm-fallback', 'studio.catalog', 'studio.draft-user',
    'captions.instagram', 'captions.tiktok', 'studio.carousel-render-payload',
    'monteur.pick-system', 'monteur.pick-user', 'monteur.copy-system', 'monteur.copy-user', 'monteur.copy-clip-fallbacks',
    'monteur.editor-system.human-on', 'monteur.editor-system.human-off', 'monteur.analyst-system', 'monteur.render-payload',
    'infographic.render-payload.ar', 'infographic.render-payload.en', 'infographic.brand',
    'comments.dm-fallback-replies.ar', 'comments.dm-fallback-replies.en',
    'growth.keywords-system.ar', 'growth.keywords-user', 'growth.coach-system.ar', 'growth.coach-user',
];

const fileOf = (e: SurfaceEntry): string => goldenPath(e.name, e.kind === 'text' ? 'txt' : 'json', e.set);

describe('tenantSurface', () => {
    it('is exactly these builders, once each, for the owner\'s settings', async () => {
        const entries = await tenantSurface({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH });
        assert.deepEqual(entries.map((e) => e.name), TENANT_SURFACE);
    });

    it('is the same list for an English tenant, with the language in the Growth names alone', async () => {
        const entries = await tenantSurface({ studio: ENGLISH_SETTINGS, growth: defaultGrowthSettings() });
        assert.deepEqual(
            entries.map((e) => e.name),
            TENANT_SURFACE.map((n) => n.replace(/^(growth\.(?:keywords|coach)-system)\.ar$/, '$1.en')),
            'the Growth system prompts are named for the language the tenant speaks',
        );
    });

    it('builds the same bytes twice: nothing in it depends on the clock or on chance', async () => {
        const rows = { studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH };
        const first = (await tenantSurface(rows)).map(entryText);
        const second = (await tenantSurface(rows)).map(entryText);
        assert.deepEqual(first, second);
    });

    it('does not mutate what it is handed', async () => {
        const studio = structuredClone(ELAMIR_SEED_SETTINGS);
        const growth = structuredClone(ELAMIR_GROWTH);
        await tenantSurface({ studio, growth });
        assert.deepStrictEqual(studio, ELAMIR_SEED_SETTINGS);
        assert.deepStrictEqual(growth, ELAMIR_GROWTH);
    });

    it('puts the pool back, and never opens a connection while it runs', async () => {
        const before = { query: pool.query, connect: pool.connect };
        await tenantSurface({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH });
        assert.equal(pool.query, before.query);
        assert.equal(pool.connect, before.connect);

        // ... also when what runs inside throws: the stand-in is not left installed.
        await assert.rejects(withRows({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH }, async () => {
            assert.notEqual(pool.query, before.query, 'while it runs, the pool answers from the rows');
            await assert.rejects(pool.connect(), /never opens a database connection/);
            throw new Error('boom');
        }), /boom/);
        assert.equal(pool.query, before.query);
        assert.equal(pool.connect, before.connect);
    });
});

describe('the entries are what the golden files hold', () => {
    it('every entry of every fixture is a golden file, and the parity script\'s hash of it is that file\'s sha256', async () => {
        const entries: SurfaceEntry[] = [];
        for (const [settings, slug, lang, set] of [
            [ELAMIR_SETTINGS, 'elamir', 'ar', 'elamir'], [ELAMIR_SEED_SETTINGS, 'seed', 'ar', 'elamir'], [ENGLISH_SETTINGS, 'english', 'en', 'control'],
        ] as const) entries.push(...await studioSurface(settings, { lang, slug, set }));
        entries.push(...infographicSurface(ELAMIR_SEED_SETTINGS, { slug: 'seed' }), ...dmFallbackSurface(ELAMIR_SETTINGS));
        entries.push(...await growthSurface({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH }, { slug: 'elamir' }));

        assert.ok(entries.length > 60, 'three fixtures of Studio and Monteur builders, and the rest');
        for (const e of entries) {
            const golden = readFileSync(fileOf(e));
            assert.equal(sha256(entryText(e)), sha256(golden.toString('utf8')), `${e.name} is not the golden's bytes`);
            assert.ok(Buffer.from(entryText(e), 'utf8').equals(golden), `${e.name} differs from its golden byte for byte`);
        }
    });

    it('a name with no fixture suffix is the golden\'s name without it', async () => {
        const [named, bare] = [
            await studioSurface(ELAMIR_SEED_SETTINGS, { lang: 'ar', slug: 'seed' }),
            await studioSurface(ELAMIR_SEED_SETTINGS, { lang: 'ar' }),
        ];
        assert.deepEqual(bare.map((e) => `${e.name}.seed`), named.map((e) => e.name));
        assert.deepEqual(bare.map(entryText), named.map(entryText), 'the suffix is a name, not an input');
    });
});

describe('entryText', () => {
    it('a text entry is the string, a json entry is what a golden file holds', () => {
        assert.equal(entryText({ kind: 'text', value: 'abc\n' }), 'abc\n');
        assert.equal(entryText({ kind: 'json', value: { b: 1, a: [2] } }), '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}\n');
    });

    it('refuses a text entry that is not text', () => {
        assert.throws(() => entryText({ kind: 'text', value: { a: 1 } }), /must hold a string/);
    });
});
