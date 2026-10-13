/**
 * What `scripts/probe-business-discovery.mts` prints, and the one rule for which account the platform reads Instagram with. Pure.
 *
 * The probe answers a question the plan marks unproven (TENANT_ONBOARDING_PLAN, "Business Discovery for an account with no
 * role on our app"): does the platform's own connected account get a public profile back for a handle that has no role on the
 * app? Its report is the evidence recorded in the PR, so it is built to be pasted: it carries the handle, the names of the
 * fields Meta returned, their counts and lengths and the error code, and NEVER a value (no biography, no caption, no count,
 * no id, no cursor) and never the token.
 */
import { classifyGraphFailure, type GraphFailureLike } from './igMap.js';
import { scrubSecrets } from './sourceError.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tenant whose Instagram account the platform reads with (03 §1): the setting `onboarding.discovery_creator_id`, which
 * defaults to the owner's tenant. A saved value that is not a tenant id is ignored, so a typo falls back to the owner rather
 * than to nothing. Null when there is neither.
 */
export function pickDiscoveryCreatorId(setting: string | null | undefined, ownerId: string | null | undefined): string | null {
    const saved = typeof setting === 'string' ? setting.trim() : '';
    if (UUID.test(saved)) return saved.toLowerCase();
    return typeof ownerId === 'string' && UUID.test(ownerId) ? ownerId.toLowerCase() : null;
}

/** What the main field expression asks for under `business_discovery` (igDiscovery.ts `discoveryMainFields`). */
export const EXPECTED_PROFILE_FIELDS: readonly string[] = ['username', 'biography', 'website', 'followers_count', 'media_count', 'media'];
export const EXPECTED_MEDIA_FIELDS: readonly string[] = ['id', 'caption', 'media_type', 'media_product_type', 'timestamp', 'permalink', 'like_count', 'comments_count', 'view_count'];

export type Loose = Record<string, unknown>;
export const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One value as its type and, where it has one, its size: `string(len=6)`, `number`, `array(n=30)`. Never the value. */
export function shapeOf(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `string(len=${Array.from(value).length})`;
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return `array(n=${value.length})`;
    if (isObj(value)) return `object(keys=${Object.keys(value).length})`;
    return typeof value;
}

export interface FieldPresence {
    name: string;
    /** In how many of the items the field was present with a value other than null. */
    present: number;
    total: number;
    /** The distinct types seen: `string`, `number`, `boolean`, `array`, `object`. */
    types: string[];
    /** For text fields, the shortest and longest length seen (in characters). */
    lengths: { min: number; max: number } | null;
}

/** Which fields each item of a list had, and how often: how the probe sees `like_count` missing on posts whose likes are hidden. */
export function presenceAcross(items: readonly unknown[], expected: readonly string[] = []): FieldPresence[] {
    const rows = items.filter(isObj);
    const names = [...expected];
    for (const row of rows) for (const key of Object.keys(row)) if (!names.includes(key)) names.push(key);
    return names.map((name): FieldPresence => {
        const values = rows.map((row) => row[name]).filter((v) => v !== undefined && v !== null);
        const types = [...new Set(values.map((v) => (Array.isArray(v) ? 'array' : typeof v)))];
        const lengths = values.filter((v): v is string => typeof v === 'string').map((v) => Array.from(v).length);
        return { name, present: values.length, total: rows.length, types, lengths: lengths.length ? { min: Math.min(...lengths), max: Math.max(...lengths) } : null };
    });
}

export interface ProbeSummary {
    ok: boolean;
    /** The profile-level fields that came back, with their shape. */
    profile: Array<{ name: string; shape: string }>;
    /** The media edge: how many items and which fields they had. */
    media: { items: number; fields: FieldPresence[] } | null;
    /** The top-level keys other than `business_discovery` (it is `id`, the asking account's own id). */
    otherKeys: string[];
    missingProfile: string[];
    missingMedia: string[];
}

/** A Business Discovery answer as names, counts and lengths. */
export function summariseProbeBody(body: unknown): ProbeSummary {
    const root = isObj(body) ? body : {};
    const bd = isObj(root.business_discovery) ? root.business_discovery : null;
    const otherKeys = Object.keys(root).filter((k) => k !== 'business_discovery');
    if (!bd) return { ok: false, profile: [], media: null, otherKeys, missingProfile: [...EXPECTED_PROFILE_FIELDS], missingMedia: [] };
    const profile = Object.keys(bd).map((name) => ({ name, shape: shapeOf(bd[name]) }));
    const edge = isObj(bd.media) ? bd.media : null;
    const data = edge && Array.isArray(edge.data) ? edge.data : null;
    const media = data ? { items: data.length, fields: presenceAcross(data, EXPECTED_MEDIA_FIELDS) } : null;
    const returned = new Set(Object.keys(bd).filter((k) => bd[k] !== undefined && bd[k] !== null));
    return {
        ok: true,
        profile,
        media,
        otherKeys,
        missingProfile: EXPECTED_PROFILE_FIELDS.filter((f) => !returned.has(f)),
        missingMedia: media ? media.fields.filter((f) => EXPECTED_MEDIA_FIELDS.includes(f.name) && f.present === 0).map((f) => f.name) : [],
    };
}

export interface ProbeReportInput {
    handle: string;
    graphVersion: string;
    /** How many characters the discovering account's id has (its value is not printed). */
    askingAccountIdLength: number;
    result:
        | { ok: true; body: unknown; requests: number; ms: number }
        | { ok: false; failure: GraphFailureLike; requests: number; ms: number };
}

const pad = (s: string, n: number): string => s.padEnd(n);

/** The report, as lines. It holds no value from the answer and no credential. */
export function formatProbeReport(input: ProbeReportInput): string[] {
    const { result } = input;
    const lines: string[] = [
        'Business Discovery probe (read-only: one GET, nothing is written)',
        `  handle         ${input.handle}`,
        `  graph version  ${input.graphVersion}`,
        `  asking as      the platform's connected Instagram account (id of ${input.askingAccountIdLength} digits, not printed)`,
        `  HTTP requests  ${result.requests} · ${result.ms} ms`,
    ];
    if (!result.ok) {
        const f = result.failure;
        const kind = classifyGraphFailure('instagram_discovery', f).kind;
        lines.push(
            '  result         FAILED',
            `  HTTP status    ${f.status ?? 'none (no response)'}`,
            `  Graph code     ${f.code ?? 'none'}${f.subcode !== null ? ` · subcode ${f.subcode}` : ''}`,
            `  Meta said      ${scrubSecrets(f.message)}`,
            `  classified as  ${kind}`,
            `VERDICT: not working for this handle (${kind}).`,
        );
        return lines;
    }
    const summary = summariseProbeBody(result.body);
    if (!summary.ok) {
        lines.push(
            '  result         HTTP 200 but no business_discovery in the answer',
            `  other keys     ${summary.otherKeys.join(', ') || 'none'}`,
            'VERDICT: no profile returned (age-restricted or restricted account).',
        );
        return lines;
    }
    lines.push('  result         OK', '', 'Fields returned under business_discovery:');
    for (const f of summary.profile) lines.push(`  ${pad(f.name, 16)} ${f.shape}`);
    if (summary.media) {
        lines.push('', `media: ${summary.media.items} items; per field, items that carry it (types, text length):`);
        for (const f of summary.media.fields) {
            const len = f.lengths ? ` len ${f.lengths.min}..${f.lengths.max}` : '';
            lines.push(`  ${pad(f.name, 20)} ${String(f.present).padStart(3)}/${f.total}  ${f.types.join('|') || '-'}${len}`);
        }
    } else {
        lines.push('', 'media: no media list in the answer');
    }
    lines.push('', `asked for but not returned (profile): ${summary.missingProfile.join(', ') || 'none'}`);
    lines.push(`asked for but not returned on any post: ${summary.missingMedia.join(', ') || 'none'}`);
    lines.push(`top-level keys besides business_discovery: ${summary.otherKeys.join(', ') || 'none'}`);
    lines.push(
        summary.missingProfile.length === 0
            ? 'VERDICT: works. Meta returned the profile and its posts for this handle.'
            : `VERDICT: partly works. Meta answered, but ${summary.missingProfile.join(', ')} did not come back.`,
    );
    return lines;
}
