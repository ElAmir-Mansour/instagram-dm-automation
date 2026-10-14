/**
 * What a scraped page and a model's answer become is only ever shown to a person (docs/onboarding/03 §3.5, point 5): "No agent reads
 * `profile_drafts`, and a test fails if any module outside `onboarding/` imports it". This is that test.
 *
 * Two facts, both about imports and text, so they hold whatever anybody writes next:
 *   1. The table is named in exactly one place, `draftStore.ts`. Not by an agent (comments, DMs, the Studio, the Monteur, Growth, infographics),
 *      not by the profile store, not by a route.
 *   2. The engine is imported by exactly the routes that serve the wizard and the operator, and the one route a worker calls. Everything that
 *      writes in a creator's name reads `creator_profiles`, which holds only what a person confirmed with Continue.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const SRC = path.resolve(new URL('../../', import.meta.url).pathname);
const ONBOARDING = path.join(SRC, 'services', 'onboarding') + path.sep;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
    }
    return out;
}

const OUTSIDE = walk(SRC).filter((f) => !f.startsWith(ONBOARDING));
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

/** Every module specifier a file imports or re-exports from. */
const importsOf = (file: string): string[] =>
    (fs.readFileSync(file, 'utf8').match(/^\s*(?:import|export)\b[^\n]*\bfrom\b\s*['"][^'"]+['"]/gm) ?? []).map((l) => l.match(/['"]([^'"]+)['"]/)![1]!);

/** The draft engine's own modules: anything here is the machinery that reads scraped text and a model's answer. */
const ENGINE = /onboarding\/(?:drafts|draftStore|draftSources|draftView|draftTypes|draftInputs|draftStep|testDb)\.js$/;

/** The only modules outside `onboarding/` allowed to import them, and what each is for. */
const ALLOWED: Record<string, string> = {
    'routes/onboardingDrafts.ts': 'the wizard\'s and the operator\'s routes, and the handlers both share',
    'routes/api.ts': 'mounts them, and holds the backstop sweep a worker calls with the cron secret',
};

describe('nothing outside the draft engine reads what was scraped', () => {
    it('the walk finds the application (a guard that scans nothing guards nothing)', () => {
        assert.ok(OUTSIDE.length > 80, `${OUTSIDE.length} files`);
        assert.ok(OUTSIDE.some((f) => rel(f) === 'webhook/comments.ts'));
        assert.ok(OUTSIDE.some((f) => rel(f) === 'services/monteur/think.ts'));
    });

    it('names the draft table in no module outside onboarding/', () => {
        const naming = OUTSIDE.filter((f) => /profile_drafts/.test(fs.readFileSync(f, 'utf8'))).map(rel);
        assert.deepEqual(naming, [], 'only the draft store names the table');
    });

    it('names it, inside onboarding/, only in the store\'s statements (and in the test stand-in that answers them)', () => {
        const code = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const naming = walk(ONBOARDING).filter((f) => /profile_drafts/.test(code(f))).map((f) => path.basename(f)).sort();
        assert.deepEqual(naming, ['draftStore.ts', 'testDb.ts']);
    });

    it('no production module imports the test stand-in', () => {
        const isSupport = (f: string): boolean => /[\\/]test(?:Support|Db|Fixtures)\.ts$/.test(f);
        for (const file of OUTSIDE.filter((f) => !isSupport(f))) assert.equal(importsOf(file).some((spec) => /onboarding\/testDb\.js$/.test(spec)), false, rel(file));
        for (const file of walk(ONBOARDING).filter((f) => !isSupport(f))) assert.equal(importsOf(file).some((spec) => /^\.\/testDb\.js$/.test(spec)), false, rel(file));
    });

    it('imports the engine from no module outside onboarding/ but the two routes that serve it', () => {
        const importers = OUTSIDE.filter((f) => importsOf(f).some((spec) => ENGINE.test(spec))).map(rel).sort();
        assert.deepEqual(importers, Object.keys(ALLOWED).sort());
    });

    it('and no agent is among them: comments, DMs, the Studio, the Monteur, Growth, infographics, the profile store, the job queue, the AI layer', () => {
        const agents = OUTSIDE.filter((f) => /^(?:webhook|jobs|services\/(?:monteur|studio|growth|profile|aiProviders|llm))\/|^services\/(?:ai|instagram|tiktok\w*|youtube\w*|matching)\.ts$/.test(rel(f)));
        assert.ok(agents.length > 30, `${agents.length} agent files scanned`);
        for (const file of agents) {
            const bad = importsOf(file).filter((spec) => /onboarding\/draft/.test(spec));
            assert.deepEqual(bad, [], `${rel(file)} reads the draft engine`);
        }
    });

    it('the engine does not import an agent either: a draft is made from sources and a model, not from what the agents know', () => {
        const engine = walk(ONBOARDING).filter((f) => /\/draft[A-Za-z]*\.ts$/.test(f) && !/testDb/.test(f));
        assert.ok(engine.length >= 8);
        for (const file of engine) {
            const bad = importsOf(file).filter((spec) => /(?:^|\/)(?:monteur|studio\/(?:jobs|drafts|settings)|growth|webhook|jobs)\//.test(spec));
            assert.deepEqual(bad, [], `${path.basename(file)} imports ${bad.join()}`);
        }
    });

    it('a ready draft is never applied by the engine: it writes no creator_profiles, settings or campaigns row', () => {
        for (const file of walk(ONBOARDING).filter((f) => /\/draft[A-Za-z]*\.ts$/.test(f) && !/testDb/.test(f))) {
            const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(code, /creator_profiles|studio_settings|growth_settings|INSERT INTO campaigns|saveProfile|createProfile|patchProfile/, path.basename(file));
        }
    });
});
