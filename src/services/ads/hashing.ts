/**
 * Customer-list Custom Audiences: parse, normalise, hash, batch (spec 002, T149; research.md R15; research/02-policy-limits.md 5.2).
 *
 * The whole point of this file is that a person's email, phone or name exists as a raw value in ONE place only: the local variables of a single
 * request. The pasted text (or CSV text, at most 3 MB) is parsed, normalised and SHA-256-hashed in memory; people who opted out and people in
 * countries the legal sign-off does not cover are dropped; only the hashes go to Meta, in sessioned batches of at most 10,000 rows.
 *
 * Rules this file keeps, and the tests pin:
 *   - no function here logs, writes to a database, or builds an error message from a row: a `CustomerListError` says what kind of problem and
 *     which input (`text` or `columns`), never what the data said;
 *   - the only database access is `loadOptOutHashes`, which READS who must not be targeted and binds nothing but the tenant id;
 *   - Meta's normalisation (SHA-256 of lowercase hex; EMAIL trimmed and lowercased; PHONE digits with the country code and no leading zero;
 *     FN/LN lowercase without punctuation; COUNTRY lowercase ISO-2), because a hash of an un-normalised value matches nobody.
 */
import { createHash, randomInt } from 'node:crypto';
import { queryRows } from '../../db/query.js';

export type CustomerColumn = 'EMAIL' | 'PHONE' | 'FN' | 'LN' | 'COUNTRY';
export const CUSTOMER_COLUMNS: readonly CustomerColumn[] = ['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY'];

/** Meta accepts at most this many records per `POST /{audience_id}/users`. */
export const MAX_BATCH = 10_000;
/** The pasted or uploaded text, in bytes. */
export const MAX_TEXT_BYTES = 3 * 1024 * 1024;

/** ISO-2 -> international dial code (digits). */
export const DIAL_CODES: Readonly<Record<string, string>> = Object.freeze({
    EG: '20', SA: '966', AE: '971', KW: '965', QA: '974', BH: '973', OM: '968', JO: '962', LB: '961', MA: '212', DZ: '213', TN: '216',
    LY: '218', SD: '249', IQ: '964', SY: '963', PS: '970', YE: '967', US: '1', GB: '44', DE: '49', FR: '33', TR: '90',
});

/** Dial codes longest first, so '971' is tried before '97' would be. */
const DIAL_PREFIXES: ReadonlyArray<readonly [string, string]> = Object.entries(DIAL_CODES)
    .map(([iso, code]) => [code, iso] as const)
    .sort((a, b) => b[0].length - a[0].length);

// ─── errors ───────────────────────────────────────────────────────────────────────────────────

/** Bad input. The message is fixed text: it never contains a row, a cell or a header. */
export class CustomerListError extends Error {
    readonly code = 'INVALID' as const;
    readonly field: 'text' | 'columns';
    constructor(field: 'text' | 'columns', message: string) {
        super(message);
        this.name = 'CustomerListError';
        this.field = field;
    }
}

// ─── normalisers ──────────────────────────────────────────────────────────────────────────────

/** Arabic-Indic (U+0660..) and Persian (U+06F0..) digits to ASCII: a sheet typed on an Arabic keyboard is full of them. */
function asciiDigits(s: string): string {
    return s.replace(/[٠-٩۰-۹]/g, (ch) => {
        const c = ch.charCodeAt(0);
        return String(c >= 0x06F0 ? c - 0x06F0 : c - 0x0660);
    });
}

/** Trim and lowercase; it must look like x@y.z. */
export function normaliseEmail(s: string): string | null {
    const v = s.trim().toLowerCase();
    if (!v) return null;
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v) ? v : null;
}

/**
 * Digits only, with the country code, no leading zero, 8 to 15 digits.
 *
 *   - `+` or a leading `00` marks an international number: nothing is added.
 *   - A single leading `0` is a national trunk prefix: with a default country it is replaced by the dial code (EG `01012345678` ->
 *     `201012345678`); without one the number cannot be completed and is rejected.
 *   - A number with no zero is kept as it is when it is long enough to already carry its country code (E.164 digits, like the ones WhatsApp
 *     gives us). With a default country, a number of 10 digits or fewer is a national number written without its zero (EG `1012345678`) and
 *     gets the dial code. No real E.164 number is shorter than 11 digits in the markets in DIAL_CODES, so the two cases do not overlap.
 *   - A stray trunk zero after the dial code (`+20 0101...`) is dropped.
 */
export function normalisePhone(s: string, defaultCountry?: string | null): string | null {
    const t = asciiDigits(s).trim();
    if (!t) return null;
    // Letters ("ext", "n/a", spreadsheet "2.01E+11") and lists of several numbers are not a phone number.
    if (/\p{L}/u.test(t) || /[,;/]/.test(t)) return null;
    let digits = t.replace(/\D/g, '');
    if (!digits) return null;
    const dial = defaultCountry ? DIAL_CODES[defaultCountry.trim().toUpperCase()] : undefined;
    let international = t.startsWith('+');
    if (!international && digits.startsWith('00')) { international = true; digits = digits.slice(2); }
    if (!digits) return null;

    if (international) {
        // as given
    } else if (digits.startsWith('0')) {
        if (!dial) return null;
        digits = dial + digits.slice(1);
    } else if (dial && digits.length <= 10) {
        digits = dial + digits;
    }
    if (dial && digits.startsWith(`${dial}0`)) digits = dial + digits.slice(dial.length + 1);
    if (digits.startsWith('0')) return null;
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** Arabic harakat and the tatweel stretch: a vowelled spelling must hash like the plain one. */
const ARABIC_MARKS = /[ً-ٰٟـ]/g;

/**
 * Meta: lowercase, no punctuation. Letters of any script survive (Arabic included); digits and punctuation go; spaces collapse to one.
 * Arabic diacritics and tatweel are removed too, which is not Meta's rule but only ever helps a name written with them match one written without.
 */
export function normaliseName(s: string): string | null {
    const v = s.normalize('NFC').toLowerCase().replace(ARABIC_MARKS, '').replace(/[^\p{L}\p{M}\s]/gu, '').replace(/\s+/g, ' ').trim();
    return v ? v : null;
}

/** Folds a label for lookup: lowercase, Arabic letter variants merged, marks removed, separators to one space. */
function fold(s: string): string {
    return s.normalize('NFC').toLowerCase().replace(ARABIC_MARKS, '')
        .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
        .replace(/[\s_\-.]+/g, ' ').trim();
}

const COUNTRY_NAMES: Readonly<Record<string, string[]>> = {
    eg: ['egypt', 'arab republic of egypt', 'مصر', 'جمهورية مصر العربية'],
    sa: ['saudi arabia', 'saudi', 'ksa', 'kingdom of saudi arabia', 'السعودية', 'المملكة العربية السعودية', 'السعوديه'],
    ae: ['united arab emirates', 'uae', 'emirates', 'الإمارات', 'الامارات', 'الإمارات العربية المتحدة'],
    kw: ['kuwait', 'الكويت'],
    qa: ['qatar', 'قطر'],
    bh: ['bahrain', 'البحرين'],
    om: ['oman', 'سلطنة عمان', 'عمان'],
    jo: ['jordan', 'الأردن', 'الاردن'],
    lb: ['lebanon', 'لبنان'],
    ma: ['morocco', 'المغرب'],
    dz: ['algeria', 'الجزائر'],
    tn: ['tunisia', 'تونس'],
    ly: ['libya', 'ليبيا'],
    sd: ['sudan', 'السودان'],
    iq: ['iraq', 'العراق'],
    sy: ['syria', 'سوريا', 'سورية'],
    ps: ['palestine', 'فلسطين'],
    ye: ['yemen', 'اليمن'],
    us: ['united states', 'united states of america', 'usa', 'america', 'أمريكا', 'امريكا', 'الولايات المتحدة'],
    gb: ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'بريطانيا', 'المملكة المتحدة'],
    de: ['germany', 'ألمانيا', 'المانيا'],
    fr: ['france', 'فرنسا'],
    tr: ['turkey', 'turkiye', 'تركيا'],
};
const COUNTRY_BY_NAME: ReadonlyMap<string, string> = new Map(
    Object.entries(COUNTRY_NAMES).flatMap(([iso, names]) => names.map((n) => [fold(n), iso] as const)),
);

/** Lowercase ISO-2 (`EG`, ` eg ` -> `eg`), or one of the common names (`Egypt`, `مصر`, `KSA`). */
export function normaliseCountry(s: string): string | null {
    const v = s.trim().toLowerCase();
    if (!v) return null;
    if (v === 'uk') return 'gb'; // the common name; ISO-2 is GB
    if (/^[a-z]{2}$/.test(v)) return v;
    return COUNTRY_BY_NAME.get(fold(v)) ?? null;
}

/** ISO-2 (upper) from the dial code at the start of a normalised phone, longest prefix first. */
export function countryOfPhone(normalisedPhone: string): string | null {
    for (const [code, iso] of DIAL_PREFIXES) if (normalisedPhone.startsWith(code)) return iso;
    return null;
}

export function sha256Hex(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ─── parsing ──────────────────────────────────────────────────────────────────────────────────

const HEADER_LABELS: Readonly<Record<CustomerColumn, string[]>> = {
    EMAIL: ['email', 'e mail', 'email address', 'mail', 'البريد', 'البريد الإلكتروني', 'البريد الالكتروني', 'ايميل', 'إيميل', 'الايميل'],
    PHONE: ['phone', 'phone number', 'mobile', 'mobile number', 'cell', 'tel', 'telephone', 'whatsapp', 'whatsapp number', 'الهاتف', 'هاتف', 'الجوال',
        'جوال', 'رقم', 'رقم الهاتف', 'رقم الجوال', 'رقم الموبايل', 'موبايل', 'الموبايل', 'تليفون', 'واتساب', 'رقم الواتساب', 'رقم واتساب'],
    FN: ['first name', 'firstname', 'fn', 'first', 'given name', 'الاسم الأول', 'الاسم الاول', 'الاسم الأول'],
    LN: ['last name', 'lastname', 'ln', 'last', 'surname', 'family name', 'اسم العائلة', 'العائلة', 'اللقب', 'الاسم الأخير', 'الاسم الاخير'],
    COUNTRY: ['country', 'الدولة', 'البلد'],
};
const HEADER_BY_LABEL: ReadonlyMap<string, CustomerColumn> = new Map(
    (Object.entries(HEADER_LABELS) as Array<[CustomerColumn, string[]]>).flatMap(([col, labels]) => labels.map((l) => [fold(l), col] as const)),
);
const headerOf = (cell: string): CustomerColumn | null => HEADER_BY_LABEL.get(fold(cell)) ?? null;

/** The delimiter used most in the first few lines (tab, then semicolon, then comma on a tie), or null for one value per line. */
function detectDelimiter(text: string): string | null {
    const counts: Record<string, number> = { '\t': 0, ';': 0, ',': 0 };
    let lines = 0;
    let inQuotes = false;
    let lineHasContent = false;
    for (let i = 0; i < text.length && lines < 5; i++) {
        const ch = text[i]!;
        if (ch === '"') inQuotes = !inQuotes;
        else if (!inQuotes && (ch === '\n' || ch === '\r')) {
            if (lineHasContent) lines++;
            lineHasContent = false;
        } else {
            if (!/\s/.test(ch)) lineHasContent = true;
            if (!inQuotes && ch in counts) counts[ch]!++;
        }
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const d of ['\t', ';', ',']) if (counts[d]! > bestCount) { best = d; bestCount = counts[d]!; }
    return best;
}

/** RFC 4180-ish: quotes only at the start of a field, `""` is a quote, newlines may sit inside quotes. Blank rows are dropped. */
function splitRecords(text: string, delimiter: string | null): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let fieldStart = true;
    const endField = () => { row.push(field.trim()); field = ''; fieldStart = true; };
    const endRow = () => {
        endField();
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
    };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
            } else field += ch;
        } else if (ch === '"' && fieldStart) {
            inQuotes = true;
            fieldStart = false;
        } else if (delimiter !== null && ch === delimiter) endField();
        else if (ch === '\n') endRow();
        else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
        else { field += ch; if (!/\s/.test(ch)) fieldStart = false; }
    }
    endRow();
    return rows;
}

const looksLikePhone = (cell: string): boolean => {
    const t = asciiDigits(cell).replace(/[\s+\-().]/g, '');
    return t.length >= 7 && /^\d+$/.test(t);
};

/** Which column a header-less column is, judged from its first rows. */
function detectColumn(cells: string[]): CustomerColumn | null {
    const filled = cells.filter((c) => c !== '');
    if (filled.length === 0) return null;
    const share = (pred: (c: string) => boolean): number => filled.filter(pred).length / filled.length;
    if (share((c) => c.includes('@')) >= 0.5) return 'EMAIL';
    if (share(looksLikePhone) >= 0.5) return 'PHONE';
    if (share((c) => /^\p{L}{2}$/u.test(c)) >= 0.5) return 'COUNTRY';
    return null;
}

/**
 * CSV (comma, semicolon or tab) or one value per line. With `'auto'` a header row is read and consumed when its cells name columns; without
 * one, each column is detected from its first rows. At least one of EMAIL / PHONE must come out. Throws `CustomerListError` (fixed messages).
 */
export function parseCustomerText(text: string, columns: CustomerColumn[] | 'auto'): { columns: CustomerColumn[]; rows: string[][] } {
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new CustomerListError('text', 'The list is larger than 3 MB.');
    const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const records = splitRecords(body, detectDelimiter(body));
    if (records.length === 0) throw new CustomerListError('text', 'The list is empty.');

    let cols: CustomerColumn[];
    let indices: number[];
    let data: string[][];

    if (columns === 'auto') {
        const first = records[0]!;
        const mapped = first.map((c) => (c === '' ? null : headerOf(c)));
        const isHeader = mapped.some((m) => m !== null) && !first.some((c) => c.includes('@') || looksLikePhone(c));
        cols = [];
        indices = [];
        if (isHeader) {
            mapped.forEach((m, i) => { if (m && !cols.includes(m)) { cols.push(m); indices.push(i); } });
            data = records.slice(1);
        } else {
            const width = Math.max(...records.slice(0, 20).map((r) => r.length));
            for (let i = 0; i < width; i++) {
                const col = detectColumn(records.slice(0, 20).map((r) => r[i] ?? ''));
                if (col && !cols.includes(col)) { cols.push(col); indices.push(i); }
            }
            data = records;
        }
    } else {
        if (columns.length === 0 || new Set(columns).size !== columns.length || columns.some((c) => !CUSTOMER_COLUMNS.includes(c))) {
            throw new CustomerListError('columns', 'The columns are not valid: each of EMAIL, PHONE, FN, LN, COUNTRY at most once.');
        }
        cols = [...columns];
        indices = cols.map((_, i) => i);
        const first = records[0]!;
        const named = first.filter((c) => c !== '');
        data = named.length > 0 && named.every((c) => headerOf(c) !== null) ? records.slice(1) : records;
    }

    if (!cols.includes('EMAIL') && !cols.includes('PHONE')) {
        throw new CustomerListError('columns', 'The list needs an email column or a phone column.');
    }
    if (data.length === 0) throw new CustomerListError('text', 'The list has a header but no rows.');
    return { columns: cols, rows: data.map((r) => indices.map((i) => r[i] ?? '')) };
}

// ─── preparing ────────────────────────────────────────────────────────────────────────────────

export interface PreparedList {
    schema: CustomerColumn[];
    hashedRows: string[][];
    rowsAccepted: number;
    rowsInvalid: number;
    rowsExcludedOptOut: number;
    rowsExcludedCountry: number;
    rowsDuplicate: number;
}

function normaliseCell(col: CustomerColumn, raw: string, defaultCountry: string | null): string | null {
    switch (col) {
        case 'EMAIL': return normaliseEmail(raw);
        case 'PHONE': return normalisePhone(raw, defaultCountry);
        case 'FN':
        case 'LN': return normaliseName(raw);
        case 'COUNTRY': return normaliseCountry(raw);
    }
}

/**
 * Normalise, filter and hash. Per row, in this order: no valid email and no valid phone -> invalid; country unknown or outside
 * `allowedCountries` -> excluded by country; hashed email or phone in `optOutHashes` -> excluded as opted out; the same hashed row again ->
 * duplicate. The raw rows are only read.
 */
export function prepareCustomerList(
    parsed: { columns: CustomerColumn[]; rows: string[][] },
    opts: { optOutHashes: ReadonlySet<string>; allowedCountries: readonly string[]; defaultCountry?: string | null },
): PreparedList {
    const defaultCountry = opts.defaultCountry ? opts.defaultCountry.trim().toUpperCase() : null;
    const allowed = new Set(opts.allowedCountries.map((c) => c.trim().toUpperCase()));
    const columns = parsed.columns;
    const hasCountryColumn = columns.includes('COUNTRY');
    const schema: CustomerColumn[] = hasCountryColumn ? [...columns] : [...columns, 'COUNTRY'];
    const out: PreparedList = {
        schema, hashedRows: [], rowsAccepted: 0, rowsInvalid: 0, rowsExcludedOptOut: 0, rowsExcludedCountry: 0, rowsDuplicate: 0,
    };
    const seen = new Set<string>();

    for (const raw of parsed.rows) {
        const norm = new Map<CustomerColumn, string | null>();
        columns.forEach((col, i) => norm.set(col, normaliseCell(col, raw[i] ?? '', defaultCountry)));
        const email = norm.get('EMAIL') ?? null;
        const phone = norm.get('PHONE') ?? null;
        if (!email && !phone) { out.rowsInvalid++; continue; }

        const country = (norm.get('COUNTRY') ?? null) || (phone ? (countryOfPhone(phone)?.toLowerCase() ?? null) : null) || (defaultCountry ? defaultCountry.toLowerCase() : null);
        if (!country || !allowed.has(country.toUpperCase())) { out.rowsExcludedCountry++; continue; }

        const hashed = new Map<CustomerColumn, string>();
        for (const [col, v] of norm) hashed.set(col, v ? sha256Hex(v) : '');
        hashed.set('COUNTRY', sha256Hex(country));
        const emailHash = hashed.get('EMAIL');
        const phoneHash = hashed.get('PHONE');
        if ((emailHash && opts.optOutHashes.has(emailHash)) || (phoneHash && opts.optOutHashes.has(phoneHash))) { out.rowsExcludedOptOut++; continue; }

        const row = schema.map((col) => hashed.get(col) ?? '');
        const key = row.join('|');
        if (seen.has(key)) { out.rowsDuplicate++; continue; }
        seen.add(key);
        out.hashedRows.push(row);
        out.rowsAccepted++;
    }
    // Nothing accepted: the schema is just the columns that came in.
    if (out.rowsAccepted === 0 && !hasCountryColumn) out.schema = [...columns];
    return out;
}

// ─── batching ─────────────────────────────────────────────────────────────────────────────────

export interface UsersBatch { sessionId: number; batchSeq: number; lastBatch: boolean; schema: CustomerColumn[]; data: string[][] }

/** At most `size` (never above MAX_BATCH) rows per batch; `batchSeq` from 1; only the last carries `lastBatch`. */
export function toBatches(list: PreparedList, sessionId: number, size: number = MAX_BATCH): UsersBatch[] {
    const n = Number.isFinite(size) ? Math.max(1, Math.min(MAX_BATCH, Math.floor(size))) : MAX_BATCH;
    const batches: UsersBatch[] = [];
    for (let i = 0; i < list.hashedRows.length; i += n) {
        batches.push({
            sessionId, batchSeq: batches.length + 1, lastBatch: i + n >= list.hashedRows.length,
            schema: [...list.schema], data: list.hashedRows.slice(i, i + n),
        });
    }
    return batches;
}

/** A random positive safe integer (48 bits). */
export function newSessionId(): number {
    return randomInt(1, 2 ** 48);
}

/** The body of Meta's `POST /{audience_id}/users`. */
export function buildUsersParams(b: UsersBatch, estimatedTotal: number): Record<string, string> {
    return {
        payload: JSON.stringify({ schema: b.schema, data: b.data }),
        session: JSON.stringify({ session_id: b.sessionId, batch_seq: b.batchSeq, last_batch_flag: b.lastBatch, estimated_num_total: estimatedTotal }),
    };
}

// ─── opt-outs ─────────────────────────────────────────────────────────────────────────────────

/** Hashes of E.164 digit strings (no default country: they are already complete). Invalid ones are skipped. */
export function optOutHashesFromPhones(phones: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const p of phones) {
        const n = normalisePhone(p, null);
        if (n) out.add(sha256Hex(n));
    }
    return out;
}

/**
 * Every opted-out person of the tenant, as SHA-256 hashes: the phone of a conversation that opted out of the DM bot (`opted_out_at`), the phone
 * of a conversation whose newest marketing consent row is a withdrawal, and the stored hashes of people who asked by email to never be targeted
 * (`platform = 'customer_list_optout'`, `contact_ref` is already a hash). Reads only; selects only the two columns it needs.
 */
export const OPT_OUT_SQL = `
SELECT 'phone'::text AS kind, wa_phone AS value
  FROM conversations
 WHERE creator_id = $1 AND opted_out_at IS NOT NULL AND wa_phone IS NOT NULL
UNION
SELECT 'phone'::text AS kind, c.wa_phone AS value
  FROM conversations c
 WHERE c.creator_id = $1 AND c.wa_phone IS NOT NULL
   AND (SELECT cc.action FROM contact_consents cc
         WHERE cc.creator_id = $1 AND cc.conversation_id = c.id AND cc.category = 'marketing'
         ORDER BY cc.created_at DESC LIMIT 1) = 'withdrawn'
UNION
SELECT 'hash'::text AS kind, contact_ref AS value
  FROM contact_consents
 WHERE creator_id = $1 AND platform = 'customer_list_optout' AND action = 'withdrawn'`;

export async function loadOptOutHashes(creatorId: string): Promise<Set<string>> {
    const rows = await queryRows<{ kind: string; value: string | null }>(OPT_OUT_SQL, [creatorId]);
    const out = new Set<string>();
    const phones: string[] = [];
    for (const r of rows) {
        if (!r.value) continue;
        if (r.kind === 'phone') phones.push(r.value);
        else {
            const h = r.value.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(h)) out.add(h);
        }
    }
    for (const h of optOutHashesFromPhones(phones)) out.add(h);
    return out;
}
