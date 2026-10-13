/**
 * Prompt parity (`parity.ts`): the comparison and its output, on injected entries, and the whole of it on injected rows
 * (the owner's fixtures, no database). The script that feeds it live rows is `scripts/prompt-parity.mts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultGrowthSettings } from '../growth/settingsRow.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { profileFromLegacy } from './legacy.js';
import type { Exec } from '../studio/common.js';
import { ELAMIR_AGENT } from '../studio/testFixtures.js';
import {
    compareSurfaces, formatParity, parityExitCode, parityJson, profileProblemsOf, readAgent, runParity, sha256, type ParityHeader,
} from './parity.js';
import { entryText, type SurfaceEntry } from './promptSurface.js';
import { throughJsonb } from './testSupport.js';

const t = (name: string, value: string): SurfaceEntry => ({ name, kind: 'text', set: 'elamir', value });
const j = (name: string, value: unknown): SurfaceEntry => ({ name, kind: 'json', set: 'elamir', value });
/** A builder that threw: no value, and what it threw. */
const failed = (name: string, error: string): SurfaceEntry => ({ name, kind: 'text', set: 'elamir', value: undefined, error });
const HEADER: ParityHeader = { tenant: '00000000-0000-4000-8000-000000000001', profile: 'legacy (none stored: read from the rows)', target: 'db.example/postgres' };

describe('sha256', () => {
    it('is the hex digest of the UTF-8 bytes', () => {
        assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        assert.equal(sha256('ملف'), sha256(Buffer.from('ملف', 'utf8').toString('utf8')));
        assert.notEqual(sha256('ملف'), sha256('ملف '));
    });
});

describe('compareSurfaces', () => {
    it('matches when both paths built the same bytes, and hashes what a golden file would hold', () => {
        const a = [t('studio.system', 'one\ntwo'), j('studio.cta-lines', { ask: 'x' })];
        const b = [t('studio.system', 'one\ntwo'), j('studio.cta-lines', { ask: 'x' })];
        const report = compareSurfaces(a, b);
        assert.equal(report.ok, true);
        assert.equal(report.builders, 2);
        assert.equal(report.mismatches, 0);
        assert.deepEqual(report.rows.map((r) => [r.name, r.kind, r.match]), [['studio.system', 'text', true], ['studio.cta-lines', 'json', true]]);
        assert.equal(report.rows[0]!.a, sha256('one\ntwo'));
        assert.equal(report.rows[1]!.b, sha256('{\n  "ask": "x"\n}\n'), 'a json entry is hashed as the golden file writes it');
        assert.equal(report.digest.a, report.digest.b);
    });

    it('does not match when one byte differs, and says where, without the text', () => {
        const report = compareSurfaces(
            [t('same', 'a'), t('studio.system', 'line one\nline two SECRET-A tail')],
            [t('same', 'a'), t('studio.system', 'line one\nline two SECRET-B tail')],
        );
        assert.equal(report.ok, false);
        assert.equal(report.mismatches, 1);
        const row = report.rows[1]!;
        assert.equal(row.match, false);
        assert.deepEqual(row.firstDifference, { line: 2, column: 17, lengthA: 31, lengthB: 31 });
        assert.notEqual(report.digest.a, report.digest.b, 'the surface digests move with a hash');
        assert.doesNotMatch(JSON.stringify(report), /SECRET/, 'only hashes and positions are reported');
    });

    it('a difference in key order alone is a difference: the prompts print some of these objects as JSON', () => {
        const report = compareSurfaces([j('p', { a: 1, b: 2 })], [j('p', { b: 2, a: 1 })]);
        assert.equal(report.ok, false);
        assert.equal(report.rows[0]!.match, false);
    });

    it('a text entry and a json entry of the same bytes are the same bytes', () => {
        const report = compareSurfaces([t('p', '{\n  "a": 1\n}\n')], [j('p', { a: 1 })]);
        assert.equal(report.ok, true);
    });

    it('a builder only one path produced does not match: a surface that changed shape is a difference', () => {
        const report = compareSurfaces([t('a', '1'), t('only-today', '2')], [t('a', '1'), t('only-profile', '3')]);
        assert.deepEqual(report.rows.map((r) => [r.name, r.a === null ? 'none' : 'built', r.b === null ? 'none' : 'built', r.match]), [
            ['a', 'built', 'built', true], ['only-today', 'built', 'none', false], ['only-profile', 'none', 'built', false],
        ]);
        assert.equal(report.mismatches, 2);
        assert.equal(report.ok, false);
        assert.equal(report.rows[1]!.firstDifference, undefined, 'there is nothing to compare it with');
    });

    it('an empty surface proves nothing, so it is not parity', () => {
        const report = compareSurfaces([], []);
        assert.equal(report.builders, 0);
        assert.equal(report.ok, false);
    });

    it('refuses a path that built one name twice, rather than hashing the last', () => {
        assert.throws(() => compareSurfaces([t('x', '1'), t('x', '2')], [t('x', '1')]), /path \(a\) built x twice/);
        assert.throws(() => compareSurfaces([t('x', '1')], [t('x', '1'), t('x', '1')]), /path \(b\) built x twice/);
    });
});

describe('the output', () => {
    const report = compareSurfaces(
        [t('studio.system', 'abc'), t('monteur.render-payload', 'one\nSECRET-A')],
        [t('studio.system', 'abc'), t('monteur.render-payload', 'one\nSECRET-B')],
    );

    it('is a row of name, both hashes and the match, then a verdict', () => {
        const lines = formatParity(report, HEADER).split('\n');
        assert.equal(lines[0], `prompt parity · tenant ${HEADER.tenant} · profile ${HEADER.profile} · ${HEADER.target}`);
        const row = lines.find((l) => l.startsWith('studio.system'))!;
        assert.match(row, /^studio\.system {11}ba7816bf8f01cfea {2}ba7816bf8f01cfea {2}ok$/);
        const diff = lines.find((l) => l.startsWith('monteur.render-payload'))!;
        assert.match(diff, / {2}DIFF$/);
        assert.match(lines.at(-1)!, /^2 builders · 1 differ · 0 threw · surface [0-9a-f]{16} \(b [0-9a-f]{16}\) · NO PARITY$/);
    });

    it('says where a mismatch begins, and prints nothing of the prompts', () => {
        const text = formatParity(report, HEADER);
        assert.match(text, /first difference at line 2, column 8 \(12 characters today, 12 through the profile\)/);
        assert.doesNotMatch(text, /SECRET/);
        assert.doesNotMatch(parityJson(report, HEADER), /SECRET/);
    });

    it('says PARITY when every row matches', () => {
        const ok = compareSurfaces([t('x', '1')], [t('x', '1')]);
        assert.match(formatParity(ok, HEADER), /1 builders · 0 differ · 0 threw · surface [0-9a-f]{16} \(b [0-9a-f]{16}\) · PARITY$/);
    });

    it('depends on nothing but its input: the same report prints the same bytes', () => {
        assert.equal(formatParity(report, HEADER), formatParity(report, HEADER));
        assert.equal(parityJson(report, HEADER), parityJson(report, HEADER));
    });

    it('has full hashes in JSON, for a machine', () => {
        const parsed = JSON.parse(parityJson(report, HEADER));
        assert.equal(parsed.tenant, HEADER.tenant);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.builders, 2);
        assert.equal(parsed.mismatches, 1);
        assert.equal(parsed.rows[0].a.length, 64);
        assert.equal(parsed.rows[0].a, parsed.rows[0].b);
        assert.equal(parsed.digest.a.length, 64);
    });
});

describe('runParity, on the rows of a tenant', () => {
    it('the owner\'s seed settings, read into the profile their rows describe: every builder matches', async () => {
        const report = await runParity({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH, profile: profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH) });
        assert.equal(report.builders, 28, 'no agent row: no DM instruction');
        assert.deepEqual(report.rows.filter((r) => !r.match), []);
        assert.equal(report.ok, true);
        assert.equal(parityExitCode(report), 0);
    });

    it('with the DM agent\'s persona the surface also holds the DM instruction, the same on both paths', async () => {
        const profile = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        const report = await runParity({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH, profile, agent: ELAMIR_AGENT });
        assert.equal(report.builders, 29);
        const dm = report.rows.find((r) => r.name === 'dm.system-instruction')!;
        assert.equal(dm.match, true);
        assert.ok(dm.a && dm.a === dm.b);
        assert.equal(report.ok, true);
    });

    it('the same, through a stored profile as Postgres hands it back (keys reordered)', async () => {
        const profile = throughJsonb(profileFromLegacy(ELAMIR_SETTINGS, ELAMIR_GROWTH));
        const report = await runParity({ studio: ELAMIR_SETTINGS, growth: ELAMIR_GROWTH, profile });
        assert.equal(report.ok, true, JSON.stringify(report.rows.filter((r) => !r.match).map((r) => r.name)));
    });

    it('an English tenant with default Growth settings', async () => {
        const growth = defaultGrowthSettings();
        const report = await runParity({ studio: ENGLISH_SETTINGS, growth, profile: profileFromLegacy(ENGLISH_SETTINGS, growth) });
        assert.equal(report.ok, true);
        assert.ok(report.rows.some((r) => r.name === 'growth.coach-system.en'));
    });

    it('a stored profile that says something else is not parity, and the builders that read it are the ones that differ', async () => {
        const profile = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        profile.voice.guide = `${profile.voice.guide} (edited in the profile, not in the row)`;
        const report = await runParity({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH, profile });
        assert.equal(report.ok, false);
        const differing = report.rows.filter((r) => !r.match).map((r) => r.name);
        assert.deepEqual(differing, ['studio.system', 'studio.plan-system', 'monteur.copy-system'], 'the three that print the voice guide');
        for (const row of report.rows.filter((r) => !r.match)) assert.ok(row.firstDifference, `${row.name} says where`);
    });

    it('another audience in the profile moves the Growth builders and nothing the Studio writes', async () => {
        const profile = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        profile.audience.countries = ['EG'];
        const report = await runParity({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH, profile });
        const differing = report.rows.filter((r) => !r.match).map((r) => r.name);
        assert.ok(differing.includes('growth.coach-user'), differing.join(', '));
        assert.ok(differing.every((n) => n.startsWith('growth.')), differing.join(', '));
    });

    it('hands the builders the profile\'s view, not the row: a row the profile does not describe shows as a difference', async () => {
        // The row says one product and the profile another; the (b) path must read the profile.
        const studio = { ...ELAMIR_SEED_SETTINGS, product: { ...ELAMIR_SEED_SETTINGS.product, name: 'A different product' } };
        const profile = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        const report = await runParity({ studio, growth: ELAMIR_GROWTH, profile });
        assert.equal(report.ok, false);
        assert.ok(report.rows.some((r) => r.name === 'studio.system' && !r.match), 'the writer\'s prompt names the product');
    });
});

describe('a stored profile\'s coach language: the one fact the rows cannot say', () => {
    const clean = { repaired: [] as string[], newerSchema: false };
    const withCoachEnglish = (): ReturnType<typeof profileFromLegacy> => {
        const p = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        p.language.surfaces = { ...p.language.surfaces, coach: { language: 'en' } };
        return p;
    };
    const rows = { studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH };

    it('a coach override in a STORED profile is drift: the coach and the keyword finder would write in English, and today\'s rows say Arabic', async () => {
        const report = await runParity({ ...rows, profile: withCoachEnglish(), stored: clean });
        assert.equal(report.ok, false);
        assert.equal(parityExitCode(report), 1);
        const differing = report.rows.filter((r) => !r.match).map((r) => r.name);
        // Named for the language each was written in: the Arabic ones only path (a) built, the English ones only (b).
        for (const name of ['growth.coach-system.ar', 'growth.coach-system.en', 'growth.keywords-system.ar', 'growth.keywords-system.en']) {
            assert.ok(differing.includes(name), `${name} in ${differing.join(', ')}`);
        }
        assert.ok(differing.every((n) => n.startsWith('growth.')), 'and nothing the Studio writes');
    });

    it('the same profile described from the rows alone (none stored) is not drift: a profile nobody stored cannot hold an override', async () => {
        const report = await runParity({ ...rows, profile: withCoachEnglish() });
        assert.equal(report.ok, true);
    });

    it('the owner\'s own stored profile: parity, with the hashes it has without it (nothing moved)', async () => {
        const profile = throughJsonb(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH));
        const stored = await runParity({ ...rows, profile, stored: clean });
        const legacy = await runParity({ ...rows, profile });
        assert.equal(stored.ok, true, JSON.stringify(stored.rows.filter((r) => !r.match).map((r) => r.name)));
        assert.deepEqual(stored.digest, legacy.digest);
        assert.equal(stored.builders, legacy.builders);
    });
});

describe('the entries are text', () => {
    it('entryText is what is hashed', () => {
        const report = compareSurfaces([j('p', { a: [1] })], [j('p', { a: [1] })]);
        assert.equal(report.rows[0]!.a, sha256(entryText(j('p', { a: [1] }))));
    });
});

describe('a stored profile this release does not read cleanly is not parity, even when every prompt matches', () => {
    const profile = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
    const rows = { studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH, profile };

    it('profileProblemsOf: a path it needed repaired at, a newer release, nothing', () => {
        assert.deepEqual(profileProblemsOf(null), []);
        assert.deepEqual(profileProblemsOf(undefined), []);
        assert.deepEqual(profileProblemsOf({ repaired: [], newerSchema: false }), []);
        assert.deepEqual(profileProblemsOf({ repaired: ['voice.emoji', 'brand.primary'], newerSchema: true }), [
            'the stored profile needed repair at voice.emoji', 'the stored profile needed repair at brand.primary', 'the stored profile was written by a newer release',
        ]);
    });

    it('repaired paths: every prompt matches, and the run still exits 1 and says why', async () => {
        const report = await runParity({ ...rows, stored: { repaired: ['voice.emoji'], newerSchema: false } });
        assert.equal(report.mismatches, 0);
        assert.equal(report.ok, false);
        assert.equal(parityExitCode(report), 1);
        assert.deepEqual(report.profileProblems, ['the stored profile needed repair at voice.emoji']);
        const text = formatParity(report, HEADER);
        assert.match(text, /^profile problem: the stored profile needed repair at voice\.emoji$/m);
        assert.match(text, /0 differ · 0 threw · .* · NO PARITY$/, 'not PARITY');
        assert.deepEqual(JSON.parse(parityJson(report, HEADER)).profileProblems, ['the stored profile needed repair at voice.emoji']);
    });

    it('a newer schema: the same', async () => {
        const report = await runParity({ ...rows, stored: { repaired: [], newerSchema: true } });
        assert.equal(report.ok, false);
        assert.equal(parityExitCode(report), 1);
        assert.deepEqual(report.profileProblems, ['the stored profile was written by a newer release']);
    });

    it('a stored profile that reads cleanly changes nothing', async () => {
        const report = await runParity({ ...rows, stored: { repaired: [], newerSchema: false } });
        assert.equal(report.ok, true);
        assert.deepEqual(report.profileProblems, []);
    });
});

describe('a builder that throws is reported, not fatal, and exits 2 (a difference exits 1)', () => {
    it('is a row that says which path threw, never a match, with every other builder still compared', () => {
        const report = compareSurfaces(
            [t('fine', 'x'), failed('studio.dm', 'TypeError: Cannot read properties of null'), t('differs', 'a')],
            [t('fine', 'x'), t('studio.dm', 'text'), t('differs', 'b')],
        );
        assert.equal(report.builders, 3);
        assert.equal(report.threw, 1);
        assert.equal(report.mismatches, 2);
        const row = report.rows[1]!;
        assert.deepEqual(row.error, { a: 'TypeError: Cannot read properties of null' });
        assert.equal(row.a, null);
        assert.equal(row.b, sha256('text'));
        assert.equal(row.match, false);
        assert.equal(row.firstDifference, undefined);
        assert.ok(report.rows[2]!.firstDifference, 'the other differing builder is still compared');
        assert.equal(parityExitCode(report), 2, 'a builder threw: 2, even though another prompt also differs');
    });

    it('both paths throwing is one row, with both reasons', () => {
        const report = compareSurfaces([failed('p', 'Error: a')], [failed('p', 'Error: b')]);
        assert.deepEqual(report.rows[0]!.error, { a: 'Error: a', b: 'Error: b' });
        assert.equal(report.threw, 1);
    });

    it('the output names the builder, the path and what it threw, and the verdict is INCOMPLETE', () => {
        const report = compareSurfaces([t('fine', 'x'), t('p', 'x')], [t('fine', 'x'), failed('p', 'RangeError: bad')]);
        const lines = formatParity(report, HEADER).split('\n');
        assert.match(lines.find((l) => l.startsWith('p '))!, / {2}ERROR$/);
        assert.ok(lines.some((l) => l.trim() === 'threw on path (b), through the profile: RangeError: bad'));
        assert.match(lines.at(-1)!, /^2 builders · 1 differ · 1 threw · .* · INCOMPLETE$/);
        assert.equal(JSON.parse(parityJson(report, HEADER)).exitCode, 2);
        assert.equal(JSON.parse(parityJson(report, HEADER)).threw, 1);
    });

    it('parityExitCode: 0 parity, 1 a difference or a profile problem, 2 a throw or nothing compared', () => {
        assert.equal(parityExitCode(compareSurfaces([t('x', '1')], [t('x', '1')])), 0);
        assert.equal(parityExitCode(compareSurfaces([t('x', '1')], [t('x', '2')])), 1);
        assert.equal(parityExitCode(compareSurfaces([t('x', '1')], [t('x', '1')], ['the stored profile was written by a newer release'])), 1);
        assert.equal(parityExitCode(compareSurfaces([failed('x', 'Error: e')], [t('x', '1')])), 2);
        assert.equal(parityExitCode(compareSurfaces([], [])), 2);
    });

    it('runParity on settings a builder cannot read: those builders are rows that threw, and the rest are compared', async () => {
        const studio = { ...ELAMIR_SEED_SETTINGS, cta: null } as unknown as typeof ELAMIR_SEED_SETTINGS;
        const profile = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        const report = await runParity({ studio, growth: ELAMIR_GROWTH, profile });
        const threw = report.rows.filter((r) => r.error).map((r) => r.name);
        assert.ok(threw.includes('studio.dm'), threw.join(', '));
        assert.ok(report.threw > 0 && report.threw < report.builders, 'some threw; the rest were built');
        assert.ok(report.rows.some((r) => r.match && !r.error), 'and the rest matched');
        assert.equal(parityExitCode(report), 2);
        const text = formatParity(report, HEADER);
        assert.match(text, /threw on path \(a\), today: TypeError/);
        assert.doesNotMatch(text, /elamirmansour|referralCode/, 'what a builder threw holds no tenant text');
    });
});

describe('readAgent', () => {
    const exec = (rows: unknown[]): Exec & { sent: { sql: string; params: unknown[] }[] } => {
        const sent: { sql: string; params: unknown[] }[] = [];
        return { sent, query: async (sql: string, params: unknown[] = []) => { sent.push({ sql, params }); return { rows }; } } as never;
    };

    it('reads the persona and knowledge base the way the DM path does, with one SELECT', async () => {
        const e = exec([{ system_prompt: 'persona', knowledge_base: 'kb', is_active: true, model: 'm' }]);
        assert.deepEqual(await readAgent(e, 'tenant-1'), { system_prompt: 'persona', knowledge_base: 'kb' }, 'only what the instruction is built from');
        assert.deepEqual(e.sent, [{ sql: 'SELECT system_prompt, knowledge_base FROM ai_agents WHERE creator_id = $1', params: ['tenant-1'] }]);
    });

    it('is null for a tenant with no agent row', async () => {
        assert.equal(await readAgent(exec([]), 'tenant-1'), null);
    });

    it('a null knowledge base is kept as the row has it, as the DM path interpolates it', async () => {
        assert.deepEqual(await readAgent(exec([{ system_prompt: 'p', knowledge_base: null }]), 't'), { system_prompt: 'p', knowledge_base: null });
    });
});
