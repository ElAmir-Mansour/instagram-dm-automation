/**
 * `.env.example` names every environment variable the app reads.
 *
 * It is the one place an operator learns what can be set. On 2026-10-26 it lacked eleven that the code reads: the Supabase
 * and YouTube fallbacks, the public site's three printed values, `META_APP_HOURLY_LIMIT` and `MONTEUR_SWEEP_DEADLINE_MS`, each
 * a setting nobody could find without reading the source. This reads every `process.env.X` in `src/` outside the tests and
 * fails on one the file does not name. A variable that is not an operator's setting is listed below, with the reason.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const NOT_OPERATOR_SETTINGS: Readonly<Record<string, string>> = {
    VERCEL: 'set by the platform on every deployment',
    CI: 'set by the CI runner; only the golden-file tests read it (src/services/profile/golden.ts)',
    UPDATE_GOLDEN: 'a test switch that rewrites the golden files (src/services/profile/golden.ts)',
    ANTHROPIC_API_KEY: 'read by a test helper that fakes provider keys (src/services/proof/testDb.ts), not by the app',
};

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
}

function variablesRead(): Map<string, string> {
    const read = new Map<string, string>();
    for (const file of sourceFiles('src')) {
        for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
            const name = m[1] ?? m[2]!;
            if (!read.has(name)) read.set(name, file);
        }
    }
    return read;
}

const listed = new Set([...readFileSync('.env.example', 'utf8').matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!));

describe('.env.example', () => {
    it('names every variable the app reads', () => {
        const missing = [...variablesRead()].filter(([name]) => !listed.has(name) && !(name in NOT_OPERATOR_SETTINGS))
            .map(([name, file]) => `${name} (read in ${file})`);
        assert.deepEqual(missing, [], 'add these to .env.example, each with a one-line comment and an empty value');
    });

    it('lists no exception that the code no longer reads', () => {
        const read = variablesRead();
        assert.deepEqual(Object.keys(NOT_OPERATOR_SETTINGS).filter((name) => !read.has(name)), []);
    });

    it('holds no real value for a secret: each is empty or a your_…_here placeholder', () => {
        for (const line of readFileSync('.env.example', 'utf8').split('\n')) {
            const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
            if (!m || !/(SECRET|TOKEN|PASSWORD|_KEY|DATABASE_URL)$/.test(m[1]!)) continue;
            assert.match(m[2]!, /^$|^your_[a-z_]+_here$|\[YOUR-PASSWORD\]/, `${m[1]} must be empty or a placeholder in the example`);
        }
    });
});
