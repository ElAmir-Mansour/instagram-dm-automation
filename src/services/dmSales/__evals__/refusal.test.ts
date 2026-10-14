/**
 * What the evaluation refuses (`refusal.ts`) and the promise behind it, held to the source: the harness runs on committed fixtures,
 * reads no tenant, no conversation and no message, sends nothing, and charges what it spends to no tenant.
 *
 * The first half is the refusals as behaviour. The second reads the harness's own files: what they import, what they could query, and
 * how the script calls the providers layer. A promise only the comments make is the kind that stops being true unnoticed.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { assertFixture, assertFixturesOnly, assertNoLiveFlags, EvalRefusal, isFixtureName } from './refusal.js';
import { resolveFixture } from './fixtures.js';
import { FIXTURE_NAMES } from './types.js';
import { buildSalesPrompt } from '../prompt.js';
import { kitFor } from '../../profile/kits.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('a fixture is a name in the list, and nothing else', () => {
    it('accepts the three fixtures', () => {
        for (const name of FIXTURE_NAMES) {
            assert.equal(assertFixture(name, 'case x'), name);
            assert.equal(isFixtureName(name), true);
        }
        assert.deepEqual([...FIXTURE_NAMES], ['owner-ar', 'owner-ar-priced', 'coach-en']);
    });

    it('refuses a tenant id by saying it is one, in any case, and anything else by saying what a fixture is', () => {
        for (const id of [TENANT, TENANT.toUpperCase()]) {
            assert.throws(() => assertFixture(id, 'case 01-x'), (err: unknown) => err instanceof EvalRefusal && /case 01-x: ".*" is a tenant id\. The evaluation runs on the fixtures/.test(err.message));
        }
        assert.throws(() => assertFixture('production', 'fixture'), /"production" is not a fixture \(owner-ar, owner-ar-priced, coach-en\)/);
        for (const odd of [undefined, null, 5, {}, '', 'Owner-AR']) assert.throws(() => assertFixture(odd, 'fixture'), EvalRefusal, String(odd));
    });

    it('is an EvalRefusal, which is what the command line turns into exit 3', () => {
        try {
            assertFixture(TENANT, 'x');
            assert.fail('expected a refusal');
        } catch (err) {
            assert.ok(err instanceof EvalRefusal);
            assert.equal(err.name, 'EvalRefusal');
            assert.ok(err instanceof Error);
        }
    });

    it('refuses a run whose cases name anything but a fixture, whatever the type system was told', () => {
        assertFixturesOnly([{ id: '01-a', fixture: 'owner-ar' }, { id: '02-b', fixture: 'coach-en' }]);
        assert.throws(() => assertFixturesOnly([{ id: '01-a', fixture: 'owner-ar' }, { id: '02-b', fixture: TENANT as never }]), /case 02-b: ".*" is a tenant id/);
        assertFixturesOnly([]);
    });

    it('builds nothing for a name that is not a fixture: the refusal comes first', () => {
        assert.throws(() => resolveFixture(TENANT), EvalRefusal);
        assert.throws(() => resolveFixture('production'), EvalRefusal);
        assert.equal(resolveFixture('owner-ar'), resolveFixture('owner-ar'), 'built once');
    });
});

describe('no flag points the run at live data', () => {
    it('refuses each of them by name, and says what it would have meant', () => {
        const flags: Record<string, RegExp> = {
            tenant: /a tenant/, creator: /a creator/, 'creator-id': /a creator/, 'tenant-id': /a tenant/, conversation: /a conversation/, conversations: /conversations/,
            'conversation-id': /a conversation/, inbox: /the inbox/, messages: /messages/, live: /live data/, db: /the database/, 'from-db': /the database/,
            profile: /a stored profile/, 'profile-id': /a stored profile/, send: /sending a message/, 'send-dm': /sending a message/, token: /Page access token/, 'page-token': /Page access token/,
        };
        for (const [flag, what] of Object.entries(flags)) {
            assert.throws(() => assertNoLiveFlags(['model', flag]), (err: unknown) => err instanceof EvalRefusal && err.message.startsWith(`--${flag}:`) && what.test(err.message) && /sends nothing/.test(err.message), flag);
        }
    });

    it('lets the flags the evaluation does have through', () => {
        assertNoLiveFlags(['model', 'provider', 'effort', 'cases', 'judge-model', 'no-judge', 'report', 'timeout-ms', 'no-cache', 'stub', 'list', 'help']);
        assertNoLiveFlags([]);
    });
});

describe('the fixtures are the committed ones, and say what the cases rely on', () => {
    const prompt = (name: (typeof FIXTURE_NAMES)[number]) => {
        const f = resolveFixture(name);
        return buildSalesPrompt({ persona: f.persona, knowledge: f.knowledge, ctx: f.ctx, timezone: f.timezone, now: f.now });
    };

    it('owner-ar: nine offers, one with a link, a price typed and no date: nothing the bot may say', () => {
        const p = prompt('owner-ar');
        assert.deepEqual([p.offers.length, p.offers.filter((o) => o.hasLink).map((o) => o.id)], [9, ['main']]);
        assert.deepEqual(p.claims.prices, []);
        assert.equal(resolveFixture('owner-ar').ctx.language.register, 'gulf');
    });

    it('owner-ar-priced: the same, with 49 USD the one price it may say', () => {
        const p = prompt('owner-ar-priced');
        assert.deepEqual(p.claims.prices.map((x) => x.text), ['49 USD']);
        assert.deepEqual(prompt('owner-ar').offers.map((o) => o.id), p.offers.map((o) => o.id));
    });

    it('coach-en: English, a live price, a hand-off message of its own, and its own hours', () => {
        const f = resolveFixture('coach-en');
        assert.equal(f.ctx.language.code, 'en');
        assert.equal(kitFor(f.ctx.language).lang, 'en');
        assert.deepEqual(prompt('coach-en').claims.prices.map((x) => x.text), ['49 USD']);
        assert.equal(f.ctx.handoff!.message, 'Sami will reply personally soon.');
        assert.deepEqual(prompt('coach-en').offers.map((o) => [o.id, o.hasLink]), [['plan', true], ['call', false]]);
    });

    it('is fixed in time: a price\'s valid-until does not run out under a run', () => {
        for (const name of FIXTURE_NAMES) assert.equal(resolveFixture(name).now.toISOString(), '2026-10-14T09:00:00.000Z');
    });

    it('holds no tenant id anywhere in what it builds', () => {
        for (const name of FIXTURE_NAMES) {
            const text = JSON.stringify(resolveFixture(name).profile) + prompt(name).system;
            assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), name);
        }
    });
});

// ─── The harness's own source ───────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SCRIPT = path.join(REPO, 'scripts', 'eval-dm-sales.mts');

const harnessFiles = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(HERE, f));
const read = (file: string): string => readFileSync(file, 'utf8');

/** The file's code without its comments: block comments, and lines that are only a `//` comment. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The module specifiers a file imports, statically or with `import()`, and re-exports. */
function specifiers(text: string): string[] {
    const found = new Set<string>();
    for (const m of code(text).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) found.add(m[2]!);
    return [...found];
}

describe('the harness reads no tenant and sends nothing: its imports are the pure sales modules, the profile fixtures and the model call', () => {
    /** Where a file in `__evals__/` may import from, relative to this folder. */
    const ALLOWED = [
        /^node:/, /^\.\/[a-zA-Z]+\.js$/, // its own modules
        /^\.\.\/(types|coerce|guard|prefilter|prompt|schema|text|price|testFixtures)\.js$/, // the sales modules and the sales test fixtures
        /^\.\.\/\.\.\/llm\/(schema|types|registry|geminiSchema)\.js$/,
        /^\.\.\/\.\.\/profile\/(context|defaults|fixtures|jsonb|kits|legacy|ownerOffers|types)\.js$/,
        /^\.\.\/\.\.\/studio\/testFixtures\.js$/,
    ];

    it('lists the harness\'s files, so this test cannot pass on an empty folder', () => {
        const names = harnessFiles.map((f) => path.basename(f)).sort();
        for (const expected of ['checks.ts', 'cases.ts', 'cli.ts', 'dialect.ts', 'fixtures.ts', 'judge.ts', 'refusal.ts', 'report.ts', 'runner.ts', 'stub.ts', 'types.ts']) {
            assert.ok(names.includes(expected), expected);
        }
    });

    for (const file of harnessFiles) {
        it(`${path.basename(file)} imports only what it is allowed to`, () => {
            const bad = specifiers(read(file)).filter((s) => !ALLOWED.some((re) => re.test(s)));
            assert.deepEqual(bad, []);
        });
    }

    it('the script imports the layer, the pool it must close, the log sink and the harness, and nothing that reads a conversation or sends a message', () => {
        const allowed = [
            /^node:/, /^\.\/lib\/live\.mjs$/, /^\.\.\/src\/services\/dmSales\/__evals__\/[a-z]+\.js$/, /^\.\.\/src\/utils\/log\.js$/,
            /^\.\.\/src\/services\/aiProviders\/(generate|purposes)\.js$/, /^\.\.\/src\/config\/db\.js$/, /^\.\.\/src\/services\/llm\/(registry|types)\.js$/,
        ];
        assert.deepEqual(specifiers(read(SCRIPT)).filter((s) => !allowed.some((re) => re.test(s))), []);
    });
});

describe('the harness holds no query for a tenant\'s data and no call to Meta', () => {
    const files = [...harnessFiles, SCRIPT];
    const FORBIDDEN: [string, RegExp][] = [
        ['a query on a tenant table', /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+(?:conversations|messages|creators|creator_profiles|ai_agents|interactions|campaigns|scheduled_posts|platform_connections|memberships|users|jobs)\b/i],
        ['a database call of its own', /\b(?:pool|client|db)\.(?:query|connect)\b|\bqueryRows\b|\bqueryOne\b/],
        ['a Graph API address', /graph\.(?:facebook|instagram)\.com/i],
        ['a send', /\b(?:sendDirectMessage|sendPrivateReply|sendMessage|publishFacebookPost|likeComment)\b/],
        ['a tenant lookup', /\b(?:loadProfile|profileContext|profileContextOrLegacy|readAgent|resolveTenant)\b/],
    ];
    for (const file of files) {
        it(`${path.basename(file)} has none`, () => {
            const text = code(read(file));
            for (const [what, re] of FORBIDDEN) assert.ok(!re.test(text), `${path.basename(file)} has ${what}: ${re.exec(text)?.[0]}`);
        });
    }

    it('and the checks above would catch each one (the patterns are not empty promises)', () => {
        const sample: Record<string, string> = {
            'a query on a tenant table': 'SELECT * FROM conversations WHERE id = 1',
            'a database call of its own': 'await pool.query("x")',
            'a Graph API address': 'https://graph.facebook.com/v26.0/me/messages',
            'a send': 'await sendDirectMessage(x)',
            'a tenant lookup': 'await loadProfile(id)',
        };
        for (const [what, re] of FORBIDDEN) assert.ok(re.test(sample[what]!), what);
    });
});

describe('what the script spends is labelled and charged to no one', () => {
    const text = code(read(SCRIPT));

    it('asks the layer for purpose dm, labelled eval, for no tenant, with the route named on the command line', () => {
        assert.match(text, /purpose: 'dm'/);
        assert.match(text, /usageAs: EVAL/);
        assert.match(text, /creatorId: null/);
        assert.match(text, /\broute,/);
    });

    it('never names a tenant to the layer: creatorId appears once, and it is null', () => {
        assert.deepEqual([...text.matchAll(/creatorId\s*:\s*([^,\n]+)/g)].map((m) => m[1]!.trim()), ['null']);
    });

    it('reads no .env for a run that asks no model (--stub, --list, --help), and reads one before it imports anything that opens the pool', () => {
        const raw = read(SCRIPT);
        assert.match(raw, /OFFLINE = \['--stub', '--dry-run', '--list', '--help', '-h'\]/);
        assert.ok(raw.indexOf('loadEnv(null)') < raw.indexOf("await import('../src/services/dmSales/__evals__/cli.js')"));
    });
});
