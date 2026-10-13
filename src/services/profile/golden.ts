/**
 * Golden files for the prompts the owner's tenant is served (docs/onboarding/01 §5 and 05 §3).
 *
 * The tenant-onboarding work refactors every prompt builder so a new tenant gets its own voice, and
 * the owner's tenant must stay byte-identical while it does. This captures today's exact text as
 * committed files, so a later PR proves it changed nothing by leaving them untouched.
 *
 *   matchGolden('dm.system-instruction', text)        → __golden__/elamir/dm.system-instruction.txt
 *   matchGoldenJson('monteur.copy.ask-pool.ar', value) → __golden__/elamir/monteur.copy.ask-pool.ar.json
 *
 * Two sets, because they have different rules:
 *   - `elamir` (the default) is the owner's own output: his settings, his persona, his Growth settings,
 *     in the language he writes. `git diff -- src/services/profile/__golden__/elamir` must be empty in
 *     every refactor PR.
 *   - `control` (`control-english/`) is what he never receives: the neutral English fixture, the English
 *     halves of bilingual builders, and defaults a new tenant starts with. It is *meant* to change as
 *     defaults go neutral, so it lives apart and the rule above can stay literal.
 *
 * A golden is compared as exact bytes (UTF-8). A missing file is a failure, never created on the
 * fly: a new golden is written only with `UPDATE_GOLDEN=1`, which also rewrites a changed one:
 *
 *   UPDATE_GOLDEN=1 npx tsx --test src/services/profile/golden.test.ts
 *
 * Do that for the `elamir` set only when the change is meant for the owner; a refactor that moves
 * his text is a bug in the refactor, not in the golden. It is refused on CI (`updating()`).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type GoldenSet = 'elamir' | 'control';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '__golden__');
const DIRS: Record<GoldenSet, string> = { elamir: path.join(ROOT, 'elamir'), control: path.join(ROOT, 'control-english') };
const NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** How many differing lines the failure message shows. */
const SHOWN_LINES = 6;
/** How much of a long line is shown, around the first character that differs. */
const WINDOW = 70;

const touched = new Set<string>();

/**
 * Whether this run rewrites goldens (`UPDATE_GOLDEN=1`). Never on CI: a pipeline that rewrote the net
 * would pass whatever the builders did, so there the variable is an error, not a no-op.
 */
export function updating(): boolean {
    if (process.env.UPDATE_GOLDEN !== '1') return false;
    const ci = process.env.CI;
    if (ci && ci !== '0' && ci.toLowerCase() !== 'false') {
        throw new Error('UPDATE_GOLDEN=1 with CI set: goldens are never rewritten on CI. Regenerate them locally and commit the files.');
    }
    return true;
}

/** Where a golden lives. Names are lower-case words joined by `.` and `-`, so a path can't be built from one. */
export function goldenPath(name: string, ext: 'txt' | 'json', set: GoldenSet = 'elamir'): string {
    if (!NAME.test(name)) throw new Error(`golden: "${name}" is not a valid name (lower-case words joined by "." or "-")`);
    return path.join(DIRS[set], `${name}.${ext}`);
}

/** A line as one quoted, escaped string, so a trailing space or a stray \r shows. Cut around `col` when long. */
function show(line: string | undefined, col: number): string {
    if (line === undefined) return '(no line)';
    const from = Math.max(0, col - WINDOW);
    const to = Math.min(line.length, col + WINDOW);
    return `${from > 0 ? '…' : ''}${JSON.stringify(line.slice(from, to))}${to < line.length ? '…' : ''}`;
}

/** A short unified-style diff of the first differing lines. */
function describeDiff(file: string, expected: string, actual: string): string {
    const want = expected.split('\n');
    const got = actual.split('\n');
    const rows: string[] = [];
    let first = -1;
    let shown = 0;
    for (let i = 0; i < Math.max(want.length, got.length) && shown < SHOWN_LINES; i++) {
        if (want[i] === got[i]) continue;
        if (first < 0) first = i;
        shown++;
        let col = 0;
        const w = want[i] ?? '';
        const g = got[i] ?? '';
        while (col < w.length && col < g.length && w[col] === g[col]) col++;
        rows.push(`@@ line ${i + 1}, column ${col + 1} @@`, `- ${show(want[i], col)}`, `+ ${show(got[i], col)}`);
    }
    return [
        `golden mismatch: ${path.relative(process.cwd(), file)}`,
        `expected ${want.length} lines (${expected.length} chars), got ${got.length} lines (${actual.length} chars); first difference at line ${first + 1}`,
        ...rows,
        `(first ${SHOWN_LINES} differing lines. "-" is the golden, "+" is what the builder produced now.)`,
        'If this change is meant, regenerate with UPDATE_GOLDEN=1. The owner\'s tenant must stay byte-identical: a refactor PR that needs this is wrong.',
    ].join('\n');
}

/** The comparison itself, on any file: `matchGolden` is this with a golden's path. Exported for the helper's own test. */
export function checkGoldenFile(file: string, actual: unknown): void {
    if (typeof actual !== 'string') throw new Error(`golden ${path.basename(file)}: the builder returned ${typeof actual}, not text`);
    touched.add(file);
    const bytes = Buffer.from(actual, 'utf8');
    if (updating()) {
        if (existsSync(file) && readFileSync(file).equals(bytes)) return;
        const created = !existsSync(file);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, bytes);
        process.stderr.write(`golden: ${created ? 'wrote' : 'updated'} ${path.relative(process.cwd(), file)}\n`);
        return;
    }
    if (!existsSync(file)) {
        throw new Error(`golden missing: ${path.relative(process.cwd(), file)}\nIt is never created on the fly. If this golden is new, generate it with UPDATE_GOLDEN=1 and commit it.`);
    }
    const expected = readFileSync(file);
    if (expected.equals(bytes)) return;
    throw new Error(describeDiff(file, expected.toString('utf8'), actual));
}

/** Fails unless `actual` is, byte for byte, the text in `__golden__/<set>/<name>.txt`. */
export function matchGolden(name: string, actual: string, set: GoldenSet = 'elamir'): void {
    checkGoldenFile(goldenPath(name, 'txt', set), actual);
}

/** A value as a JSON golden holds it: `JSON.stringify(value, null, 2)` and a newline, keys in the object's own order (not sorted). */
export function goldenJsonText(value: unknown): string {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) throw new Error('golden: the value has no JSON form');
    return `${text}\n`;
}

/** Fails unless `value`, as `goldenJsonText` writes it, is the text in `__golden__/<set>/<name>.json`. */
export function matchGoldenJson(name: string, value: unknown, set: GoldenSet = 'elamir'): void {
    checkGoldenFile(goldenPath(name, 'json', set), goldenJsonText(value));
}

/** The golden files on disk that no `matchGolden` call in this process has checked: coverage that has gone quiet. */
export function uncheckedGoldens(): string[] {
    const out: string[] = [];
    for (const dir of Object.values(DIRS)) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir)) {
            const full = path.join(dir, f);
            if (!touched.has(full)) out.push(path.relative(process.cwd(), full));
        }
    }
    return out.sort();
}
