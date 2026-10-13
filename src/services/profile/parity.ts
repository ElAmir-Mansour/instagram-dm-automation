/**
 * Prompt parity (docs/onboarding/05 §4): for one tenant's LIVE rows, the same prompts built twice, and their hashes.
 *
 *   (a) today's path:      every builder handed the settings as they are stored;
 *   (b) through the profile: every builder handed `studioView(stored, profile)` and `growthView(stored, profile)`,
 *                          the profile being the stored one, or the one the rows describe when there is none.
 *
 * The builders are `promptSurface.ts`'s, the ones the golden tests pin, so there is one list. A row is
 * `name  sha256(a)  sha256(b)  match`; a prompt that moved between the two paths shows as `DIFF`. Run on `main` and on a
 * release branch, the two outputs are what a reader PR must leave equal: the output holds no clock, no hash of a
 * secret and nothing that differs between machines, so `diff` is the check.
 *
 * Only hashes, names and positions are reported. A prompt holds the tenant's guide, links and offers; where two of them
 * first differ is printed as a line and column, never as text.
 */
import { createHash } from 'node:crypto';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { entryText, type SurfaceEntry, tenantSurface } from './promptSurface.js';
import type { CreatorProfile } from './types.js';
import { growthView, studioView } from './views.js';

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ParityRow {
    name: string;
    kind: 'text' | 'json';
    /** sha256 of the bytes path (a) built, or null when only the other path built this one. */
    a: string | null;
    b: string | null;
    match: boolean;
    /** Where the two first differ, when both exist and differ. */
    firstDifference?: { line: number; column: number; lengthA: number; lengthB: number };
}

export interface ParityReport {
    rows: ParityRow[];
    builders: number;
    mismatches: number;
    ok: boolean;
    /** sha256 of every `name hash(a)` line: one value to compare across branches. */
    digest: { a: string; b: string };
}

/** Where `a` and `b` first differ, as a 1-based line and column. */
function firstDifference(a: string, b: string): { line: number; column: number } {
    let i = 0;
    const n = Math.min(a.length, b.length);
    while (i < n && a[i] === b[i]) i++;
    const upTo = a.slice(0, i);
    const line = upTo.split('\n').length;
    return { line, column: i - (upTo.lastIndexOf('\n') + 1) + 1 };
}

const unique = (entries: readonly SurfaceEntry[], which: string): Map<string, SurfaceEntry> => {
    const byName = new Map<string, SurfaceEntry>();
    for (const e of entries) {
        if (byName.has(e.name)) throw new Error(`path (${which}) built ${e.name} twice`);
        byName.set(e.name, e);
    }
    return byName;
};

/**
 * The two paths' entries side by side, in path (a)'s order and then any only (b) built. A builder only one path
 * produced does not match: a surface that changed shape is a difference, not a gap in the table.
 */
export function compareSurfaces(a: readonly SurfaceEntry[], b: readonly SurfaceEntry[]): ParityReport {
    const left = unique(a, 'a');
    const right = unique(b, 'b');
    const names = [...left.keys(), ...[...right.keys()].filter((n) => !left.has(n))];
    const rows: ParityRow[] = names.map((name) => {
        const x = left.get(name);
        const y = right.get(name);
        const ta = x ? entryText(x) : null;
        const tb = y ? entryText(y) : null;
        const row: ParityRow = {
            name, kind: (x ?? y)!.kind,
            a: ta === null ? null : sha256(ta), b: tb === null ? null : sha256(tb),
            match: ta !== null && ta === tb,
        };
        if (ta !== null && tb !== null && ta !== tb) row.firstDifference = { ...firstDifference(ta, tb), lengthA: ta.length, lengthB: tb.length };
        return row;
    });
    const mismatches = rows.filter((r) => !r.match).length;
    const digestOf = (pick: (r: ParityRow) => string | null): string => sha256(rows.map((r) => `${r.name} ${pick(r) ?? '-'}`).join('\n'));
    return { rows, builders: rows.length, mismatches, ok: mismatches === 0 && rows.length > 0, digest: { a: digestOf((r) => r.a), b: digestOf((r) => r.b) } };
}

/** A tenant's rows and the profile it is read through. */
export interface ParityInput {
    studio: StudioSettings;
    growth: GrowthSettings;
    profile: CreatorProfile;
}

/**
 * Every builder, on both paths, for these rows. Pure given its input: it opens no connection (the Growth builders run
 * against a stand-in for the pool, see `promptSurface.ts`), so a test can hand it fixtures and the script can hand it rows
 * it read read-only.
 */
export async function runParity({ studio, growth, profile }: ParityInput): Promise<ParityReport> {
    const a = await tenantSurface({ studio, growth });
    const b = await tenantSurface({ studio: studioView(studio, profile), growth: growthView(growth, profile) });
    return compareSurfaces(a, b);
}

// ─── Output ─────────────────────────────────────────────────────────────────────────────────

/** Hex digits of a hash shown in the table. `--json` carries all 64. */
const SHOWN = 16;

export interface ParityHeader {
    tenant: string;
    /** `stored v3`, or `legacy` for a tenant read as the profile its rows describe. */
    profile: string;
    /** `host/database`, no credentials. */
    target: string;
}

/** The table, as lines. A mismatch is followed by where its two builds first differ. */
export function formatParity(report: ParityReport, header: ParityHeader): string {
    const width = Math.max(4, ...report.rows.map((r) => r.name.length));
    const cut = (h: string | null): string => (h === null ? '-'.repeat(SHOWN) : h.slice(0, SHOWN));
    const lines = [
        `prompt parity · tenant ${header.tenant} · profile ${header.profile} · ${header.target}`,
        '',
        `${'name'.padEnd(width)}  ${'sha256(a) today'.padEnd(SHOWN)}  ${'sha256(b) profile'.padEnd(SHOWN)}  match`,
    ];
    for (const r of report.rows) {
        lines.push(`${r.name.padEnd(width)}  ${cut(r.a)}  ${cut(r.b)}  ${r.match ? 'ok' : 'DIFF'}`);
        if (r.firstDifference) {
            const d = r.firstDifference;
            lines.push(`${' '.repeat(width)}  first difference at line ${d.line}, column ${d.column} (${d.lengthA} characters today, ${d.lengthB} through the profile)`);
        }
    }
    lines.push('', `${report.builders} builders · ${report.mismatches} differ · surface ${report.digest.a.slice(0, SHOWN)} (b ${report.digest.b.slice(0, SHOWN)}) · ${report.ok ? 'PARITY' : 'NO PARITY'}`);
    return lines.join('\n');
}

/** The same, for a machine: full hashes. */
export function parityJson(report: ParityReport, header: ParityHeader): string {
    return JSON.stringify({ ...header, ok: report.ok, builders: report.builders, mismatches: report.mismatches, digest: report.digest, rows: report.rows }, null, 2);
}
