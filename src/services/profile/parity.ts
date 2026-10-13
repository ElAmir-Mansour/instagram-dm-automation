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
 * Three ways it can fail, and they are told apart (`parityExitCode`):
 *   1  a builder's prompt differs between the paths, or the stored profile is not one this release reads cleanly
 *      (`repaired` paths, or written by a newer release): the readers would not give the owner his bytes back;
 *   2  a builder threw, so the comparison is incomplete. It is reported by name, with the rest still compared.
 *
 * Only hashes, names and positions are reported. A prompt holds the tenant's guide, links and offers; where two of them
 * first differ is printed as a line and column, never as text.
 */
import { createHash } from 'node:crypto';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import type { Exec } from '../studio/common.js';
import { type AgentPersona, entryText, type SurfaceEntry, tenantSurface } from './promptSurface.js';
import type { CreatorProfile } from './types.js';
import { growthView, studioView } from './views.js';

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ParityRow {
    name: string;
    kind: 'text' | 'json';
    /** sha256 of the bytes path (a) built, or null when only the other path built this one, or its builder threw. */
    a: string | null;
    b: string | null;
    match: boolean;
    /** What a builder threw, by path. A row with an error never matches. */
    error?: { a?: string; b?: string };
    /** Where the two first differ, when both exist and differ. */
    firstDifference?: { line: number; column: number; lengthA: number; lengthB: number };
}

export interface ParityReport {
    rows: ParityRow[];
    builders: number;
    /** Rows that did not match, including those a builder threw in. */
    mismatches: number;
    /** Rows in which a builder threw on either path. */
    threw: number;
    /** What is wrong with the stored profile itself: paths it needed repaired at, or a newer schema. Empty for a profile this release reads cleanly. */
    profileProblems: string[];
    /** Every builder built on both paths, every pair matched, and the profile reads cleanly. */
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

/** What the stored profile itself says is wrong with it: a profile this release had to repair, or one a newer release wrote. */
export function profileProblemsOf(stored: { repaired: readonly string[]; newerSchema: boolean } | null | undefined): string[] {
    if (!stored) return [];
    return [
        ...stored.repaired.map((path) => `the stored profile needed repair at ${path}`),
        ...(stored.newerSchema ? ['the stored profile was written by a newer release'] : []),
    ];
}

/**
 * The two paths' entries side by side, in path (a)'s order and then any only (b) built. A builder only one path
 * produced does not match: a surface that changed shape is a difference, not a gap in the table. A builder that threw
 * does not match either, and the row says which path threw.
 */
export function compareSurfaces(a: readonly SurfaceEntry[], b: readonly SurfaceEntry[], profileProblems: readonly string[] = []): ParityReport {
    const left = unique(a, 'a');
    const right = unique(b, 'b');
    const names = [...left.keys(), ...[...right.keys()].filter((n) => !left.has(n))];
    const rows: ParityRow[] = names.map((name) => {
        const x = left.get(name);
        const y = right.get(name);
        const failed = { ...(x?.error !== undefined ? { a: x.error } : {}), ...(y?.error !== undefined ? { b: y.error } : {}) };
        const ta = x && x.error === undefined ? entryText(x) : null;
        const tb = y && y.error === undefined ? entryText(y) : null;
        const row: ParityRow = {
            name, kind: (x ?? y)!.kind,
            a: ta === null ? null : sha256(ta), b: tb === null ? null : sha256(tb),
            match: ta !== null && ta === tb,
        };
        if (Object.keys(failed).length > 0) row.error = failed;
        if (ta !== null && tb !== null && ta !== tb) row.firstDifference = { ...firstDifference(ta, tb), lengthA: ta.length, lengthB: tb.length };
        return row;
    });
    const mismatches = rows.filter((r) => !r.match).length;
    const threw = rows.filter((r) => r.error).length;
    const digestOf = (pick: (r: ParityRow) => string | null): string => sha256(rows.map((r) => `${r.name} ${pick(r) ?? '-'}`).join('\n'));
    return {
        rows, builders: rows.length, mismatches, threw, profileProblems: [...profileProblems],
        ok: mismatches === 0 && rows.length > 0 && profileProblems.length === 0,
        digest: { a: digestOf((r) => r.a), b: digestOf((r) => r.b) },
    };
}

/** The tenant's DM agent row, read the way the DM path reads it (`generateAiResponse`), or null when it has none. */
export async function readAgent(exec: Exec, creatorId: string): Promise<AgentPersona | null> {
    const { rows } = await exec.query<AgentPersona>('SELECT system_prompt, knowledge_base FROM ai_agents WHERE creator_id = $1', [creatorId]);
    return rows[0] ? { system_prompt: rows[0].system_prompt, knowledge_base: rows[0].knowledge_base } : null;
}

/** A tenant's rows and the profile it is read through. */
export interface ParityInput {
    studio: StudioSettings;
    growth: GrowthSettings;
    profile: CreatorProfile;
    /** The DM agent's persona and knowledge base, when the tenant has an agent row. The same on both paths. */
    agent?: AgentPersona | null;
    /** What reading the stored profile found; omit for a tenant with none stored. */
    stored?: { repaired: readonly string[]; newerSchema: boolean } | null;
    /**
     * Whether the tenant is the platform owner, who is shown the built-in carousels until P14 (`StudioWording.builtInExamples`).
     * The same on both paths. The script reads who the owner is from the database; left out it is false.
     */
    builtInExamples?: boolean;
}

/**
 * Every builder, on both paths, for these rows. Pure given its input: it opens no connection (the Growth builders run
 * against a stand-in for the pool, see `promptSurface.ts`), so a test can hand it fixtures and the script can hand it rows
 * it read read-only. A builder that throws is a row that says so, not an exception: the rest are still compared.
 */
export async function runParity({ studio, growth, profile, agent, stored, builtInExamples }: ParityInput): Promise<ParityReport> {
    const a = await tenantSurface({ studio, growth, agent, builtInExamples });
    // A stored profile is also what the Growth coach reads its language from (its `coach` surface), which the views cannot carry.
    // The profile itself is handed in too: the infographic writer reads its role, domain and register from the profile's context, not
    // from the settings; and so do the DM and comment wording (language, register, the kind of offer: P8). Path (a) describes the
    // rows' own profile, so a stored profile that speaks differently from its rows shows up as a difference in those entries.
    const b = await tenantSurface({ studio: studioView(studio, profile), growth: growthView(growth, profile), agent, profile, builtInExamples }, stored ? { storedProfile: profile } : {});
    return compareSurfaces(a, b, profileProblemsOf(stored));
}

/**
 * How the run ends: 0 parity; 1 a prompt differs, or the stored profile is not one this release reads cleanly; 2 a builder
 * threw (or nothing was built), so what was compared is not the whole surface. Distinct, because "the prompts moved"
 * and "the check could not finish" call for different things from whoever reads it.
 */
export function parityExitCode(report: ParityReport): 0 | 1 | 2 {
    if (report.threw > 0 || report.builders === 0) return 2;
    return report.ok ? 0 : 1;
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

/** The table, as lines. A mismatch is followed by where its two builds first differ; a builder that threw, by what it threw. */
export function formatParity(report: ParityReport, header: ParityHeader): string {
    const width = Math.max(4, ...report.rows.map((r) => r.name.length));
    const cut = (h: string | null): string => (h === null ? '-'.repeat(SHOWN) : h.slice(0, SHOWN));
    const lines = [
        `prompt parity · tenant ${header.tenant} · profile ${header.profile} · ${header.target}`,
        ...report.profileProblems.map((p) => `profile problem: ${p}`),
        '',
        `${'name'.padEnd(width)}  ${'sha256(a) today'.padEnd(SHOWN)}  ${'sha256(b) profile'.padEnd(SHOWN)}  match`,
    ];
    for (const r of report.rows) {
        lines.push(`${r.name.padEnd(width)}  ${cut(r.a)}  ${cut(r.b)}  ${r.error ? 'ERROR' : r.match ? 'ok' : 'DIFF'}`);
        if (r.error?.a !== undefined) lines.push(`${' '.repeat(width)}  threw on path (a), today: ${r.error.a}`);
        if (r.error?.b !== undefined) lines.push(`${' '.repeat(width)}  threw on path (b), through the profile: ${r.error.b}`);
        if (r.firstDifference) {
            const d = r.firstDifference;
            lines.push(`${' '.repeat(width)}  first difference at line ${d.line}, column ${d.column} (${d.lengthA} characters today, ${d.lengthB} through the profile)`);
        }
    }
    const verdict = parityExitCode(report) === 2 ? 'INCOMPLETE' : report.ok ? 'PARITY' : 'NO PARITY';
    lines.push('', `${report.builders} builders · ${report.mismatches} differ · ${report.threw} threw · surface ${report.digest.a.slice(0, SHOWN)} (b ${report.digest.b.slice(0, SHOWN)}) · ${verdict}`);
    return lines.join('\n');
}

/** The same, for a machine: full hashes. */
export function parityJson(report: ParityReport, header: ParityHeader): string {
    return JSON.stringify({
        ...header, ok: report.ok, exitCode: parityExitCode(report), builders: report.builders, mismatches: report.mismatches, threw: report.threw,
        profileProblems: report.profileProblems, digest: report.digest, rows: report.rows,
    }, null, 2);
}
