/**
 * The script (`scripts/eval-muse.mts`) and the code under it, held to what the benchmark promises: that it is a thing you run by hand and not part of `npm test` or CI; that it takes its key
 * from a file you name, or the environment, or a read-only look at Settings, and from nowhere else; that it writes to no database (the only SQL in it is one read, the connection it opens
 * for that is read-only and closed, and the application's own pool is closed before anything runs); that it sends no message and reads no tenant (nothing it imports can); that it has
 * no way to put a key on a screen or in a file; and that, run for real in a process of its own with nothing in its environment, it refuses to start without a key and says nothing was sent.
 *
 * Most of this is read from the source, as `refusal.test.ts` reads the DM evaluation's, because a promise that is only kept by the way the code happens to be written today is a promise a
 * later edit can break without a test noticing. The processes it starts have no key, and the one that is given a made-up key is given no file to read, so nothing in it can reach a model.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { committed, META_KEY, REPO } from './testSupport.js';

const SCRIPT = path.join(REPO, 'scripts', 'eval-muse.mts');
const BENCH = path.join(REPO, 'src', 'services', 'perception', '__bench__');
const read = (file: string): string => readFileSync(file, 'utf8');

/** The source without its comment lines and trailing `//` notes: what the code does, not what it says about itself. */
function codeOf(text: string): string {
    return text
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
        .map((line) => line.replace(/\s\/\/ .*$/, ''))
        .join('\n');
}

const specifiers = (code: string): string[] => [...code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)'([^']+)'/g)].map((m) => m[1]!);

const script = read(SCRIPT);
const scriptCode = codeOf(script);

// ─── Where it runs ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('it is run by hand and by nothing else', () => {
    const pkg = JSON.parse(read(path.join(REPO, 'package.json'))) as { scripts: Record<string, string> };

    it('is the package script eval:muse, and neither the test script nor any workflow runs it', () => {
        assert.equal(pkg.scripts['eval:muse'], 'tsx scripts/eval-muse.mts');
        assert.doesNotMatch(pkg.scripts['test']!, /eval/);
        for (const [name, command] of Object.entries(pkg.scripts)) {
            if (name !== 'eval:muse') assert.doesNotMatch(command, /eval-muse|eval:muse/, `the "${name}" script`);
        }
        const workflows = path.join(REPO, '.github', 'workflows');
        for (const file of readdirSync(workflows)) assert.doesNotMatch(read(path.join(workflows, file)), /eval-muse|eval:muse/, file);
    });

    it('is imported by no file: the script is an entry point, and a test that imported it would run it', () => {
        const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter((f) => /\.(?:ts|mts|mjs|js)$/.test(f));
        assert.ok(tracked.length > 100);
        for (const file of tracked) {
            const text = (() => { try { return read(path.join(REPO, file)); } catch { return ''; } })();
            if (file === 'scripts/eval-muse.mts' || file === path.relative(REPO, path.join(BENCH, 'script.test.ts'))) continue;
            assert.equal(/\b(?:from|import)\s*\(?\s*'[^']*eval-muse(?:\.mts)?'/.test(text), false, `${file} imports the script`);
        }
    });

    it('can have its outputs committed: docs/hackathon is not ignored (the repository ignores the rest of docs), and a dry run\'s scratch folder is', () => {
        const ignored = (file: string): number | null => spawnSync('git', ['check-ignore', '-q', file], { cwd: REPO }).status;
        assert.equal(ignored('docs/hackathon/benchmark.md'), 1, 'benchmark.md is not ignored');
        assert.equal(ignored('docs/hackathon/benchmark.svg'), 1, 'benchmark.svg is not ignored');
        assert.equal(ignored('docs/SOME_LOCAL_NOTE.md'), 0, 'the rest of docs is still local only');
        assert.equal(ignored('scratch/bench/benchmark.md'), 0, 'a dry run into scratch is never committed by accident');
    });
});

// ─── Its key ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('its key comes from three places and goes to one', () => {
    it('reads an env file only when one is named on the command line: loadEnv is called with that argument and nothing else', () => {
        const calls = [...scriptCode.matchAll(/\bloadEnv\(([^)]*)\)/g)].map((m) => m[1]!.trim());
        assert.deepEqual(calls, ['args.env'], 'a loadEnv() with no argument walks up the tree to a .env nobody named');
        assert.match(scriptCode, /if \(typeof args\.env === 'string'\) loadEnv\(args\.env\);/);
    });

    it('reads Settings only with --settings, through the read-only connection, for three keys and nothing else', () => {
        assert.match(scriptCode, /if \(args\.settings\) \{\s*const db = await connectReadOnly\('autoreply-muse-benchmark'\);/);
        const asked = [...scriptCode.matchAll(/\bsaved\('([^']+)'\)/g)].map((m) => m[1]);
        assert.deepEqual(asked, ['ai.providers.meta.api_key', 'ai.providers.anthropic.api_key', 'ai.providers.baseten.api_key']);
        assert.match(scriptCode, /if \(args\.judge\) keys\.anthropic/);
        assert.match(scriptCode, /if \(args\['open-weights'\]\) keys\.baseten/);
        assert.match(scriptCode, /await db\.end\(\)/, 'the connection is closed again in a finally');
    });

    it('has no way to print a key or write one to a file: nothing that writes names a key, and the keys go to the command and nowhere else', () => {
        for (const call of scriptCode.matchAll(/(?:process\.std(?:out|err)\.write|console\.\w+|writeFileSync|mkdirSync)\(([\s\S]*?)\);/g)) {
            assert.doesNotMatch(call[1]!, /\bkeys\b|\bk\.meta|apiKey|META_MODEL_API_KEY|api_key/, `a write that names a key: ${call[0].slice(0, 80)}`);
        }
        const used = [...scriptCode.matchAll(/\bkeys\b/g)].length;
        assert.ok(used > 0);
        assert.equal([...scriptCode.matchAll(/process\.env\.[A-Z_]+\s*=(?!=)/g)].length, 0, 'it never sets an environment variable');
        assert.equal([...scriptCode.matchAll(/process\.env\[[^\]]+\]\s*=(?!=)/g)].length, 0);
    });

    it('does not use a key it was not given for the arm it is: only the file, the environment or Settings are read, by these names', () => {
        const names = [...scriptCode.matchAll(/fromEnv\('([A-Z_]+)'\)/g)].map((m) => m[1]);
        assert.deepEqual([...new Set(names)].sort(), ['ANTHROPIC_API_KEY', 'BASETEN_API_KEY', 'META_MODEL_API_KEY']);
        assert.deepEqual([...scriptCode.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]), ['DATABASE_URL'], 'the one environment variable it names is the one it removes');
    });
});

// ─── It writes no database, sends no message, reads no tenant ─────────────────────────────────────────────────────────────

describe('it writes no database', () => {
    it('has one statement of SQL in it, a SELECT of one setting, and no verb that changes anything', () => {
        assert.deepEqual([...scriptCode.matchAll(/\.query\(\s*'([^']*)'/g)].map((m) => m[1]), ['SELECT value FROM app_settings WHERE key = $1']);
        assert.doesNotMatch(scriptCode, /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|MERGE|LOCK)\b/);
        assert.doesNotMatch(scriptCode, /\bfrom\s+'pg'|new (?:Pool|Client)\(/, 'it opens no connection of its own: only connectReadOnly, which runs each statement in BEGIN READ ONLY');
        assert.equal([...scriptCode.matchAll(/\bconnectReadOnly\(/g)].length, 1);
    });

    it('removes DATABASE_URL before the product modules load, and closes the application\'s own pool before anything runs', () => {
        const removed = scriptCode.indexOf('delete process.env.DATABASE_URL;');
        const firstImport = scriptCode.indexOf('await import(');
        const closed = scriptCode.indexOf('await pool.end();');
        const ran = scriptCode.indexOf('await runCli(');
        assert.ok(removed > 0 && firstImport > removed, 'the variable is gone before the first product module is loaded');
        assert.ok(closed > firstImport && closed < ran, 'the pool is closed after it was created by those modules and before the first case');
        assert.match(scriptCode, /const \{ pool \} = await import\('\.\.\/src\/config\/db\.js'\);/);
    });

    it('closes the read-only connection before it does either: the keys are read, then the connection is gone', () => {
        assert.ok(scriptCode.indexOf('await db.end()') > 0 && scriptCode.indexOf('await db.end()') < scriptCode.indexOf('delete process.env.DATABASE_URL;'));
    });
});

describe('it sends no message and reads no tenant', () => {
    it('imports only Node, the script library, the benchmark and the pool it closes', () => {
        const allowed = (s: string): boolean => s.startsWith('node:') || s === './lib/live.mjs' || s.startsWith('../src/services/perception/__bench__/') || s === '../src/config/db.js';
        const found = specifiers(scriptCode);
        assert.ok(found.length >= 8);
        for (const s of found) assert.ok(allowed(s), `the script imports ${s}`);
    });

    it('has the benchmark sources import nothing that sends, reads a conversation or reads a tenant: only the harness, the providers layer, the perception parsers and Node', () => {
        const allowed = [
            /^node:/, /^\.\//, /^\.\.\/\.\.\/dmSales\/(?:__evals__\/|prompt\.js$|prefilter\.js$|text\.js$|turn\.js$|types\.js$)/, /^\.\.\/\.\.\/llm\//, /^\.\.\/\.\.\/aiProviders\/(?:generate|purposes)\.js$/,
            /^\.\.\/\.\.\/profile\/kits\.js$/, /^\.\.\/\.\.\/\.\.\/utils\/log\.js$/,
            /^\.\.\/(?:dm|how|media|plan|source|text|trace|types|reelIndex)\.js$/, /^\.\.\/(?:reelLibrary|voice)\.js$/,
        ];
        for (const file of readdirSync(BENCH).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testSupport.ts')) {
            for (const s of specifiers(codeOf(read(path.join(BENCH, file))))) {
                assert.ok(allowed.some((re) => re.test(s)), `${file} imports ${s}`);
            }
        }
    });

    it('imports the reel library and the voice module for their types alone: both reach the database, and the arms are handed what they need', () => {
        let seen = 0;
        for (const file of readdirSync(BENCH).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testSupport.ts')) {
            for (const m of read(path.join(BENCH, file)).matchAll(/^import (type )?[^;]*from '\.\.\/(?:reelLibrary|voice)\.js';/gm)) {
                seen++;
                assert.equal(m[1], 'type ', `${file}: ${m[0]}`);
            }
        }
        assert.ok(seen >= 2, 'the memory arm names the library\'s row type and the voice arm the module\'s steps');
    });

    it('never touches the environment, the database, a log line or a file system call that writes, below the command line', () => {
        const environment: string[] = [];
        for (const file of readdirSync(BENCH).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testSupport.ts')) {
            const code = codeOf(read(path.join(BENCH, file)));
            for (const m of code.matchAll(/process\.env\b(?:\.(\w+)|\[)?/g)) environment.push(`${file}:${m[1] ?? '[]'}`);
            assert.doesNotMatch(code, /\bpool\b|\bpg\b|config\/db/, `${file} touches the database`);
            // A file system call that changes anything is the script's own io, to the folder it was told: below it, `node:fs` is imported for reading (and for looking) alone.
            for (const m of code.matchAll(/import \{([^}]*)\} from 'node:fs(?:\/promises)?';/g)) {
                const names = m[1]!.split(',').map((n) => n.trim()).filter(Boolean);
                assert.deepEqual(names.filter((n) => !['readFileSync', 'existsSync'].includes(n)), [], `${file} imports more than reading from node:fs`);
            }
            assert.doesNotMatch(code, /import \* as \w+ from 'node:fs|import fs from 'node:fs|require\('node:fs'\)/, `${file} takes the whole of node:fs`);
            if (file !== 'cli.ts') assert.doesNotMatch(code, /\blog\(/, `${file} writes a log line`);
        }
        // Nothing below the command line reads the environment: the home folder, to print a path in a public file without a user name in it, comes from node:os. The application reads
        // its environment in the places `.env.example` names, and the benchmark has none of its own to name.
        assert.deepEqual(environment, []);
    });

    it('names no field a log line would blank (a field whose name holds secret, token, password or signature)', () => {
        for (const file of readdirSync(BENCH).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
            assert.doesNotMatch(codeOf(read(path.join(BENCH, file))), /\blog\([^)]*\b(?:secret|token|password|signature)\w*\s*:/i, file);
        }
    });
});

// ─── Run for real, in a process of its own ────────────────────────────────────────────────────────────────────────────────

describe('run as a process, with nothing in its environment', () => {
    /** A child with no key and no database in its environment, in a folder with no .env of its own, so that whatever it does is what the script does by itself. */
    function run(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
        const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
            cwd: REPO, encoding: 'utf8', timeout: 120_000,
            env: { PATH: process.env.PATH ?? '', HOME: path.join(REPO, 'scratch', 'no-home'), ...env },
        });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }

    it('refuses to start without a key, says that nothing was sent, and prints nothing else', () => {
        const r = run(['--env', path.join(REPO, 'scratch', 'there-is-no-env-file-here'), '--cases', 'image-price']);
        assert.equal(r.status, 3, r.stderr);
        assert.match(r.stderr, /refused: there is no Meta key to try\. Pass --env <file> with META_MODEL_API_KEY in it, or --settings to read the one saved in Settings -> AI providers\. Nothing was sent anywhere\./);
        assert.equal(r.stdout, '');
    });

    it('does not go and look for a .env nobody named: with no --env, the environment is all it has', () => {
        const r = run(['--cases', 'image-price']);
        assert.equal(r.status, 3, r.stderr);
        assert.match(r.stderr, /there is no Meta key to try/);
    });

    it('takes the key from the environment, never prints it, and with no media file to read it makes no call at all', () => {
        const r = run(['--cases', 'image-price', '--media-dir', path.join(REPO, 'scratch', 'no-media-here')], { META_MODEL_API_KEY: META_KEY });
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, /skipped image-price: price-screenshot\.png is not in the media folder \(/);
        assert.match(r.stderr, /nothing ran: 1 case had no file in /);
        assert.equal(`${r.stdout}${r.stderr}`.includes(META_KEY), false);
        assert.equal(`${r.stdout}${r.stderr}`.includes(META_KEY.slice(0, 20)), false);
    });

    it('refuses a flag that names a tenant before it looks for a key, in the process too', () => {
        const r = run(['--tenant', 'abc'], { META_MODEL_API_KEY: META_KEY });
        assert.equal(r.status, 3);
        assert.match(r.stderr, /^refused: --tenant: this would point the evaluation at a tenant\./);
    });

    it('lists the cases and prints the help with no key and no network', () => {
        const list = run(['--list']);
        assert.equal(list.status, 0, list.stderr);
        assert.equal(list.stdout.trim().split('\n').length, committed().cases.length);
        const help = run(['--help']);
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, /^Muse benchmark: what the sales agent does with what followers send/);
    });

    it('does a dry run with canned answers: no key, no file, no database, and with --no-write nothing on disk', () => {
        const r = run(['--stub', '--out', path.join(REPO, 'scratch', 'script-test-never-written'), '--no-write']);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^DRY RUN: canned answers, nothing sent to Meta, not a measurement\./);
        assert.match(r.stdout, /meta\s+15\s+100%\s+100%/);
        assert.doesNotMatch(r.stderr, /written:/);
        assert.deepEqual(spawnSync('git', ['status', '--porcelain', '--ignored', 'scratch/script-test-never-written'], { cwd: REPO, encoding: 'utf8' }).stdout, '');
    });
});
