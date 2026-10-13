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
import { ELAMIR_AGENT } from '../studio/testFixtures.js';
import {
    dmFallbackSurface, dmInstructionSurface, entryText, growthSurface, infographicSurface, studioSurface, tenantSurface, type SurfaceEntry, withRows,
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
        entries.push(...infographicSurface(ELAMIR_SEED_SETTINGS, { slug: 'seed' }), ...dmFallbackSurface(ELAMIR_SETTINGS), ...dmInstructionSurface(ELAMIR_AGENT));
        entries.push(...await growthSurface({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH }, { slug: 'elamir' }));

        assert.ok(entries.length > 60, 'three fixtures of Studio and Monteur builders, and the rest');
        assert.ok(entries.some((e) => e.name === 'dm.system-instruction'));
        assert.deepEqual(entries.filter((e) => e.error), [], 'every builder built');
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

describe('the DM instruction', () => {
    it('is in the tenant surface, after the infographic builders, only when the tenant has an agent row', async () => {
        const rows = { studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH };
        const names = (await tenantSurface({ ...rows, agent: ELAMIR_AGENT })).map((e) => e.name);
        assert.deepEqual(names, [...TENANT_SURFACE.slice(0, 22), 'dm.system-instruction', ...TENANT_SURFACE.slice(22)]);
        assert.deepEqual((await tenantSurface({ ...rows, agent: null })).map((e) => e.name), TENANT_SURFACE);
    });

    it('is built from the agent row alone: the persona and knowledge base inside the fixed rules', () => {
        const [entry] = dmInstructionSurface({ system_prompt: 'PERSONA', knowledge_base: 'KB TEXT' });
        assert.equal(entry!.name, 'dm.system-instruction');
        assert.equal(entry!.kind, 'text');
        assert.match(entry!.value as string, /^PERSONA\n\n=== .*\nKB TEXT\n\n=== /s);
    });
});

describe('a builder that throws is an entry that says so', () => {
    const broken = { ...ELAMIR_SEED_SETTINGS, cta: null } as unknown as typeof ELAMIR_SEED_SETTINGS;

    it('studioSurface: the builders that read what is missing carry the error, every other builder is built, and the order is kept', async () => {
        const whole = await studioSurface(ELAMIR_SEED_SETTINGS, { lang: 'ar' });
        const entries = await studioSurface(broken, { lang: 'ar' });
        assert.deepEqual(entries.map((e) => e.name), whole.map((e) => e.name), 'the same entries in the same order');
        const failed = entries.filter((e) => e.error !== undefined);
        assert.ok(failed.some((e) => e.name === 'studio.dm'));
        assert.match(failed[0]!.error!, /^TypeError: /);
        assert.equal(failed[0]!.value, undefined);
        assert.ok(entries.some((e) => e.error === undefined), 'the rest were built');
        const analyst = (list: SurfaceEntry[]) => list.find((e) => e.name === 'monteur.analyst-system')!;
        assert.equal(analyst(entries).error, undefined);
        assert.equal(analyst(entries).value, analyst(whole).value, 'a builder that does not read the missing section is what it is without the failure');
    });

    it('entryText refuses an entry whose builder threw, by name, rather than hashing nothing', () => {
        assert.throws(() => entryText({ name: 'studio.dm', kind: 'text', value: undefined, error: 'TypeError: x' }), /studio\.dm was not built: TypeError: x/);
    });

    it('the Arabic fallback replies read his DM template and the English ones do not: only the former fail', () => {
        const [ar, en] = dmFallbackSurface(broken);
        assert.match(ar!.error!, /^TypeError: /);
        assert.equal(en!.error, undefined);
        assert.ok(Array.isArray(en!.value));
    });

    it('a Growth builder that throws is `growth.keywords` or `growth.coach` (the language it would have been named for is unknown), and the pool is put back', async () => {
        const before = { query: pool.query, connect: pool.connect };
        const unreadable = new Proxy({}, { ownKeys() { throw new Error('row unreadable'); } }) as never;
        const entries = await growthSurface({ studio: ELAMIR_SEED_SETTINGS, growth: unreadable }, { slug: 'x' });
        assert.deepEqual(entries.map((e) => [e.name, e.error]), [['growth.keywords.x', 'Error: row unreadable'], ['growth.coach.x', 'Error: row unreadable']]);
        assert.equal(pool.query, before.query);
        assert.equal(pool.connect, before.connect);
    });
});

describe('the pool stand-in answers what the Growth builders ask and nothing else', () => {
    const rows = { studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH };
    const ask = (sql: string) => pool.query(sql, ['creator']);

    it('answers the stored-profile lookup with none, explicitly: the rows handed in are already the answer', async () => {
        await withRows(rows, async () => {
            assert.deepEqual((await ask('SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = $1')).rows, []);
            assert.deepEqual((await ask('SELECT profile, version FROM creator_profiles WHERE creator_id = $1 FOR UPDATE')).rows, []);
        });
        // ... and says so in the code, so it stays a decision (a scan: the answer and the refusal are both behaviour).
        const src = readFileSync(new URL('./promptSurface.ts', import.meta.url), 'utf8');
        assert.match(src, /if \(\/FROM creator_profiles\/\.test\(q\)\) return \{ rows: storedProfile === undefined \? \[\] : \[\{ profile: storedProfile, version: 1, activated_at: null \}\] \};/);
    });

    it('answers it with a stored profile only when one is passed in', async () => {
        const stored = { schema: 1, marker: 'a stored profile' };
        await withRows(rows, async () => {
            assert.deepEqual((await ask('SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = $1')).rows, [{ profile: stored, version: 1, activated_at: null }]);
        }, { storedProfile: stored });
    });

    it('besides the golden test, only runParity supplies a stored profile, and only on path (b), for a tenant that has one', () => {
        for (const file of ['../../../scripts/prompt-parity.mts', './backfill.ts']) {
            assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /storedProfile/, file);
        }
        const parity = readFileSync(new URL('./parity.ts', import.meta.url), 'utf8');
        assert.equal(parity.match(/storedProfile/g)?.length, 1, 'one use');
        assert.match(parity, /const a = await tenantSurface\(\{ studio, growth, agent \}\);/, 'path (a), today\'s rows, is handed none');
        assert.match(parity, /const b = await tenantSurface\(\{[^\n]*\}, stored \? \{ storedProfile: profile \} : \{\}\);/, 'path (b) is handed the stored profile, when there is one');
    });

    it('answers the settings rows with the rows it was given, a copy each', async () => {
        await withRows(rows, async () => {
            const g = (await ask('SELECT keywords FROM growth_settings WHERE creator_id = $1')).rows[0];
            assert.deepStrictEqual(g, ELAMIR_GROWTH);
            assert.notEqual(g, ELAMIR_GROWTH);
            assert.deepStrictEqual((await ask('SELECT brand FROM studio_settings WHERE creator_id = $1')).rows[0], ELAMIR_SEED_SETTINGS);
        });
    });

    it('refuses a query it has no answer for, by name, instead of handing back an empty result', async () => {
        await withRows(rows, async () => {
            await assert.rejects(ask('SELECT * FROM jobs WHERE creator_id = $1'), /the prompt surface has no answer for: SELECT \* FROM jobs/);
            await assert.rejects(ask('UPDATE growth_settings_extra SET x = 1'), /no answer for/);
        });
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
