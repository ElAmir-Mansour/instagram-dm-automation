#!/usr/bin/env node
/**
 * Builds and checks the brand display face: Alexandria at weight 600, self-hosted as one subset woff2 (L3).
 *
 *   public/brand/alexandria-600.<sha8>.woff2   the font; <sha8> is the SHA-256 of its own bytes, so /brand/* can be served
 *                                              `immutable` for a year and a changed font is a new URL
 *   public/brand/OFL.txt                       the licence, byte for byte as upstream ships it (the OFL asks for it to travel)
 *   scripts/font/manifest.json                 what the build recorded: the pinned source, the subset, the result
 *   scripts/font/subset.py                     the one step that needs fontTools (instance at wght 600, subset, woff2)
 *
 * Where it comes from. The official source: google/fonts, ofl/alexandria/Alexandria[wght].ttf, pinned to ONE commit and one
 * SHA-256 (SPEC.source). The file is downloaded as data and parsed by fontTools; nothing in it is executed. A download whose
 * hash is not the pinned one is refused, so the build cannot silently ship a different font under the same commit name.
 *
 * Why this subset. SPEC.unicodes is the one in DESIGN.md §3: the Arabic blocks, Basic Latin, Latin-1 and general
 * punctuation. It is far inside the 48 KB budget (about 21 KB), so nothing was trimmed to fit; `--check` scans the display text of
 * the six public pages and the dashboard's headings and fails when one of its code points is missing from the font, which is
 * how the subset stays chosen by what the pages use and not by a list nobody re-reads.
 *
 *   node scripts/build-font.mjs [--source <dir>]  fetch the pinned source (or take it from <dir>: it must hold
 *                                                 Alexandria[wght].ttf and OFL.txt, both checked against SPEC), build the woff2,
 *                                                 write the licence and the manifest, rewrite the @font-face block in the six
 *                                                 public pages and in dashboard/css/styles.css, and the landing's preload.
 *                                                 Needs python3 with fonttools and brotli (a venv is fine).
 *   node scripts/build-font.mjs --check           change nothing, needs only node. Exit 1 unless
 *                                                   - the manifest records exactly this script's SPEC,
 *                                                   - the committed woff2 is named for the hash of its bytes, matches the
 *                                                     manifest, is at most 48 KB, and its cmap is the recorded coverage,
 *                                                   - OFL.txt is the pinned upstream licence,
 *                                                   - all seven files carry the one @font-face block this script generates, and
 *                                                     it names the current font,
 *                                                   - /brand holds this release's font and at most one before it,
 *                                                   - only the landing preloads the font, with crossorigin,
 *                                                   - tokens.css's --font-display is the stack the block's fallback belongs to,
 *                                                   - the display text of the pages is covered by the font.
 *   node scripts/build-font.mjs --reproduce       --check, then fetch the pinned source, rebuild into a temp dir and compare
 *                                                 the bytes with the committed font (needs python3 + fonttools + brotli).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BRAND_DIR = 'public/brand';
export const MANIFEST = 'scripts/font/manifest.json';
const SUBSET_PY = join(ROOT, 'scripts/font/subset.py');

/** The ceiling in LANDING_PLAN.md L3 and DESIGN.md §3. */
export const MAX_BYTES = 48 * 1024;
/** Every font file a release names, and the file name pattern /brand serves it under. */
export const FONT_FILE = /^alexandria-600\.([0-9a-f]{8})\.woff2$/;
/** The licence sits beside the font, and nothing else of this script's lives in /brand. */
export const LICENCE_FILE = 'OFL.txt';
/** This release's font and the one before it: a browser holding the previous page (the CDN serves pages for minutes) still finds its own. */
export const MAX_RELEASES = 2;

/** What gets built, and from what. Changing anything here without a rebuild fails `--check` (the manifest records it). */
export const SPEC = {
    family: 'Alexandria',
    weight: 600,
    source: {
        repo: 'google/fonts',
        commit: 'fffdadf0f0c9cc1ec8b407063424a8bfbee05611',
        dir: 'ofl/alexandria',
        file: 'Alexandria[wght].ttf',
        sha256: 'db8ae03b62d55a65aa4e04307878df8c00d6e5388e4800635cbe0e22b6411b64',
        licenceSha256: '56372aed19c2701f50e6e784110af55bf8796ed51648805324ad1adb0a3860bb',
        // Where google/fonts took it from: https://github.com/Gue3bara/Alexandria at 4fd1422be3488837c41fbdb84a77350f0f56a734 (METADATA.pb).
        upstream: 'Gue3bara/Alexandria@4fd1422be3488837c41fbdb84a77350f0f56a734',
    },
    // DESIGN.md §3, verbatim. The font has about half of these (the Arabic letters, harakat, digits and the presentation forms it
    // draws); the subsetter keeps what exists, and the manifest records the coverage that resulted.
    unicodes: 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+0020-007E,U+00A0-00FF,U+2000-206F',
    // The features this face has that Arabic and Latin text shaping asks for. abvm/blwm carry the harakat's placement in HarfBuzz's common
    // feature set (the font ships them), tnum/pnum because `.figures` and `.stat-value` are tabular-nums. rvrn is the variable font's own
    // and resolves away when the axis is pinned. Features the font lacks (isol, calt, curs, lnum) are listed so a later font revision that
    // gains them keeps them; the subsetter ignores what is absent.
    features: ['ccmp', 'locl', 'rvrn', 'init', 'medi', 'fina', 'isol', 'rlig', 'liga', 'calt', 'curs', 'mark', 'mkmk', 'abvm', 'blwm', 'kern', 'tnum', 'pnum', 'lnum'],
};

/**
 * The size-adjusted local fallback, one face per script. Until Alexandria arrives (`font-display: swap` paints text at once)
 * the text is drawn in a platform face that `size-adjust` scales to Alexandria's width, and whose ascent/descent/line-gap are
 * overridden to Alexandria's, so the swap changes the letterforms and not the boxes.
 * `sizeAdjust` is Alexandria 600's width over the fallback's, measured on the display strings of the pages in Chromium on macOS (the
 * numbers and the method are in the report of the L3 PR). Windows and Android take the nearest face in each list and are NOT measured.
 */
export const FALLBACK = {
    latin: {
        range: 'U+0000-05FF, U+2000-206F',
        local: ['Arial Bold', 'Arial-BoldMT', 'Helvetica Bold', 'Helvetica-Bold'],
        sizeAdjust: 1.06,
    },
    arabic: {
        range: 'U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF',
        local: ['Geeza Pro Bold', 'GeezaPro-Bold', 'Tahoma Bold', 'Tahoma-Bold', 'Arial Bold', 'Arial-BoldMT'],
        sizeAdjust: 1.15,
    },
};
/** Alexandria's vertical metrics (hhea, unitsPerEm 1000); the build reads them from the font and refuses a mismatch. */
export const METRICS = { unitsPerEm: 1000, ascent: 968, descent: 251, lineGap: 0 };

// ─── The files that name the font ────────────────────────────────────────────────────────────────────────────────────
/** The six public pages, where each puts the block (the first anchor found), and whether it preloads. */
export const PAGES = [
    { file: 'public/landing.html', preload: true },
    { file: 'public/pricing.html', preload: false },
    { file: 'public/privacy.html', preload: false },
    { file: 'public/terms.html', preload: false },
    { file: 'public/data-deletion.html', preload: false },
    { file: 'public/404.html', preload: false },
];
const PAGE_ANCHOR = '/* ─── Cross-document view transitions';
export const STYLESHEET = { file: 'dashboard/css/styles.css', anchor: '/* ─── Reset & base' };
export const TOKENS = 'dashboard/css/tokens.css';
/** The stack the generated block belongs to. tokens.css declares it, because the pages and the dashboard both read it. */
export const FONT_DISPLAY = "--font-display: 'Alexandria', 'Alexandria Fallback', var(--font-ui);";

const BLOCK_BEGIN = '/* ─── Display face: Alexandria 600 (generated) ';
const BLOCK_END = '/* ─── end of display face ─── */';

const pct = (n) => `${(Math.round(n * 10000) / 100).toString()}%`;

/** The @font-face block, as it stands in every page and in styles.css. The one place its text is written. */
export function faceCss(fileName, indent = '') {
    const sa = (f) => f.sizeAdjust;
    const face = (f) => [
        '@font-face {',
        "    font-family: 'Alexandria Fallback';",
        '    font-style: normal;',
        '    font-weight: 600;',
        `    src: ${f.local.map((n) => `local('${n}')`).join(', ')};`,
        `    unicode-range: ${f.range};`,
        `    size-adjust: ${pct(sa(f))};`,
        `    ascent-override: ${pct(METRICS.ascent / METRICS.unitsPerEm / sa(f))};`,
        `    descent-override: ${pct(METRICS.descent / METRICS.unitsPerEm / sa(f))};`,
        `    line-gap-override: ${pct(METRICS.lineGap / METRICS.unitsPerEm / sa(f))};`,
        '}',
    ].join('\n');
    const text = [
        `${BLOCK_BEGIN}───────────────────────────────────────────────`,
        '   Written by scripts/build-font.mjs. Do not edit it here: the same text is in the six public pages and in',
        '   dashboard/css/styles.css, and `npm run check:font` fails when a copy differs. The file name carries the hash of',
        '   its own bytes, so /brand serves it `immutable`. `swap` paints text at once in the fallback; the fallback faces are',
        "   local fonts scaled to Alexandria's width and vertical metrics, so the swap changes letterforms, not boxes.",
        '   `--font-display` (tokens.css) names both. Weight 600 is the only one that exists; a heading asks for 600. */',
        '@font-face {',
        "    font-family: 'Alexandria';",
        '    font-style: normal;',
        '    font-weight: 600;',
        '    font-display: swap;',
        `    src: url('/brand/${fileName}') format('woff2');`,
        '}',
        face(FALLBACK.latin),
        face(FALLBACK.arabic),
        BLOCK_END,
    ].join('\n');
    return text.split('\n').map((l) => (l ? indent + l : l)).join('\n');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The whole block in a file (any indent), from its begin marker to its end marker. */
const BLOCK_RE = new RegExp(`^([ \\t]*)${escapeRe(BLOCK_BEGIN)}[^\\n]*\\n[\\s\\S]*?${escapeRe(BLOCK_END)}`, 'm');
/** The landing's preload: a short comment and the tag. Both are generated, and both are found again by these. */
const PRELOAD_TAG_RE = /<link rel="preload" href="\/brand\/alexandria-600\.[0-9a-f]{8}\.woff2"[^>]*>/g;
const PRELOAD_NOTE = '<!-- The display face, fetched with the stylesheet';
const PRELOAD_BLOCK_RE = new RegExp(`[ \\t]*${escapeRe(PRELOAD_NOTE)}[\\s\\S]*?-->\\r?\\n[ \\t]*<link rel="preload"[^>]*>\\r?\\n?`, 'g');
export const preloadTag = (fileName) => `<link rel="preload" href="/brand/${fileName}" as="font" type="font/woff2" crossorigin>`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const kb = (n) => (n / 1024).toFixed(1);
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

// ─── woff2 and cmap, read without fontTools (so --check needs only node) ───────────────────────────────────────────────
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** The tables of a woff2, decompressed: tag -> {bytes, transformed}. Only what the check reads is interpreted. */
export function readWoff2(buf) {
    if (buf.length < 48 || buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a woff2 (no wOF2 signature)');
    const numTables = buf.readUInt16BE(12);
    const totalCompressed = buf.readUInt32BE(20);
    let pos = 48;
    const u128 = () => {
        let v = 0;
        for (let i = 0; i < 5; i++) {
            const b = buf[pos++];
            v = v * 128 + (b & 0x7f);
            if (!(b & 0x80)) return v;
        }
        throw new Error('bad UIntBase128');
    };
    const dir = [];
    for (let i = 0; i < numTables; i++) {
        const flags = buf[pos++];
        const idx = flags & 0x3f;
        let tag;
        if (idx === 63) {
            tag = buf.toString('latin1', pos, pos + 4);
            pos += 4;
        } else tag = KNOWN_TAGS[idx];
        const version = flags >> 6;
        const origLength = u128();
        // glyf and loca are transformed at version 0; every other table is transformed at any version but 0.
        const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
        const length = transformed ? u128() : origLength;
        dir.push({ tag, transformed, length });
    }
    const data = brotliDecompressSync(buf.subarray(pos, pos + totalCompressed));
    const tables = new Map();
    let off = 0;
    for (const t of dir) {
        tables.set(t.tag, { bytes: data.subarray(off, off + t.length), transformed: t.transformed });
        off += t.length;
    }
    return tables;
}

/** The code points of a font's Unicode cmap (format 4 and 12 subtables), as a sorted array. */
export function cmapOf(cmapBytes) {
    const b = cmapBytes;
    const n = b.readUInt16BE(2);
    const out = new Set();
    for (let i = 0; i < n; i++) {
        const platform = b.readUInt16BE(4 + i * 8);
        const encoding = b.readUInt16BE(6 + i * 8);
        if (!((platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0)) continue;
        const st = b.readUInt32BE(8 + i * 8);
        const format = b.readUInt16BE(st);
        if (format === 4) {
            const segX2 = b.readUInt16BE(st + 6);
            const ends = st + 14;
            const starts = ends + segX2 + 2;
            const deltas = starts + segX2;
            const rangeOffs = deltas + segX2;
            for (let s = 0; s < segX2 / 2; s++) {
                const end = b.readUInt16BE(ends + s * 2);
                const start = b.readUInt16BE(starts + s * 2);
                if (start === 0xffff) continue;
                const delta = b.readInt16BE(deltas + s * 2);
                const ro = b.readUInt16BE(rangeOffs + s * 2);
                for (let c = start; c <= end; c++) {
                    let gid;
                    if (ro === 0) gid = (c + delta) & 0xffff;
                    else {
                        const at = rangeOffs + s * 2 + ro + (c - start) * 2;
                        const g = b.readUInt16BE(at);
                        gid = g === 0 ? 0 : (g + delta) & 0xffff;
                    }
                    if (gid !== 0) out.add(c);
                }
            }
        } else if (format === 12) {
            const groups = b.readUInt32BE(st + 12);
            for (let g = 0; g < groups; g++) {
                const o = st + 16 + g * 12;
                const start = b.readUInt32BE(o);
                const end = b.readUInt32BE(o + 4);
                const gid = b.readUInt32BE(o + 8);
                for (let c = start; c <= end; c++) if (gid + (c - start) !== 0) out.add(c);
            }
        }
    }
    return [...out].sort((a, c) => a - c);
}

/** `U+0020-007E,U+00A0` -> sorted code points. */
export function parseRanges(spec) {
    const out = new Set();
    for (const part of spec.split(',').map((s) => s.trim().replace(/^U\+/i, '')).filter(Boolean)) {
        const [lo, hi] = part.split('-');
        for (let c = parseInt(lo, 16); c <= parseInt(hi ?? lo, 16); c++) out.add(c);
    }
    return [...out].sort((a, b) => a - b);
}

/** Sorted code points -> `U+0020-007E,U+00A0`, the notation of subset.py's report and of DESIGN.md. */
export function formatRanges(cps) {
    const hex = (n) => n.toString(16).toUpperCase().padStart(4, '0');
    const out = [];
    for (let i = 0; i < cps.length; ) {
        let j = i;
        while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
        out.push(i === j ? `U+${hex(cps[i])}` : `U+${hex(cps[i])}-${hex(cps[j])}`);
        i = j + 1;
    }
    return out.join(',');
}

// ─── The text the display face is asked to draw ────────────────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', times: '×', copy: '©', rarr: '→', larr: '←' };

/** Text of an HTML fragment: tags dropped, entities decoded. An entity this does not know is kept visibly so the check cannot pass over it. */
export function htmlText(fragment) {
    return fragment
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_m, e) => {
            if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
            return ENTITIES[e] ?? `�${e}`;
        });
}

/** The display text of one public page: h1, h2, the wordmark and the dt of `.figures` / `.tally`. */
export function publicDisplayText(html) {
    const out = [];
    for (const m of html.matchAll(/<(h1|h2)\b[^>]*>([\s\S]*?)<\/\1>/g)) out.push(htmlText(m[2]));
    for (const m of html.matchAll(/<a\b[^>]*class="wordmark"[^>]*>([\s\S]*?)<\/a>/g)) out.push(htmlText(m[1]));
    for (const dl of html.matchAll(/<dl\b[^>]*class="(?:figures|tally)"[^>]*>([\s\S]*?)<\/dl>/g)) {
        for (const m of dl[1].matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>/g)) out.push(htmlText(m[1]));
    }
    return out.filter((s) => s.trim());
}

const unescapeJs = (s) => s.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|\\(.)/gi, (_m, u, x, c) => (u ? String.fromCharCode(parseInt(u, 16)) : x ? String.fromCharCode(parseInt(x, 16)) : c === 'n' ? '\n' : c));

/** The dashboard's display text: the page titles (`nav.<page>`), the login and setup titles, the sidebar's name, and the static h1s in the shell. */
export function dashboardDisplayText(indexHtml, dictSources) {
    const out = [];
    for (const m of indexHtml.matchAll(/<h1\b[^>]*class="[^"]*(?:login-title|page-title)[^"]*"[^>]*>([\s\S]*?)<\/h1>/g)) out.push(htmlText(m[1]));
    for (const m of indexHtml.matchAll(/<span\b[^>]*class="sidebar-brand"[^>]*>([\s\S]*?)<\/span>/g)) out.push(htmlText(m[1]));
    for (const src of dictSources) {
        for (const m of src.matchAll(/'((?:nav\.(?!group\.|inboxWaiting)[a-z_]+)|login\.title|setup\.title|app\.name)':\s*'((?:[^'\\\n]|\\.)*)'/g)) out.push(unescapeJs(m[2]));
    }
    return out.filter((s) => s.trim());
}

/** Code points that draw nothing and never ask the font for a glyph (zero-width and bidi controls, soft hyphen, BOM). */
const INVISIBLE = (cp) => cp === 0xad || cp === 0x61c || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0xfeff;

/** Code points in `entries` ({text, where}) that the font cannot draw: {cp, sample, where}. Whitespace and invisible controls are not counted. */
export function uncovered(entries, cmapSet) {
    const missing = new Map();
    for (const { text, where } of entries) {
        for (const ch of text) {
            const cp = ch.codePointAt(0);
            if (/\s/.test(ch) || INVISIBLE(cp) || cmapSet.has(cp)) continue;
            if (!missing.has(cp)) missing.set(cp, { sample: text.trim().slice(0, 40), where });
        }
    }
    return [...missing].map(([cp, v]) => ({ cp, ...v })).sort((a, b) => a.cp - b.cp);
}

// ─── --check ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Where the check reads from: the repo at `root`, with `overrides` ({relativePath: text | Buffer | null}) laid over it in memory, null
 * meaning the file is absent. The tests mutate one file at a time this way, without touching the disk.
 */
export function makeIo(root, overrides = {}) {
    const has = (rel) => Object.prototype.hasOwnProperty.call(overrides, rel);
    const missing = (rel) => Object.assign(new Error(`ENOENT: ${rel}`), { code: 'ENOENT' });
    const bytes = (rel) => {
        if (has(rel)) {
            if (overrides[rel] === null) throw missing(rel);
            return Buffer.from(overrides[rel]);
        }
        return readFileSync(join(root, rel));
    };
    return {
        bytes,
        text: (rel) => bytes(rel).toString('utf8'),
        names: (dir) => {
            const disk = existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : [];
            const added = Object.keys(overrides).filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/') && overrides[k] !== null).map((k) => k.slice(dir.length + 1));
            return [...new Set([...disk, ...added])].filter((n) => !has(`${dir}/${n}`) || overrides[`${dir}/${n}`] !== null);
        },
    };
}

/** Everything wrong with the committed font and the files that name it, as readable lines. */
export function collectProblems(root = ROOT, overrides = {}) {
    const problems = [];
    const io = makeIo(root, overrides);
    let manifest;
    try {
        manifest = JSON.parse(io.text(MANIFEST));
    } catch {
        return [`${MANIFEST} is missing or is not JSON: run npm run build:font`];
    }

    // 1. The manifest records this script's SPEC and FALLBACK.
    if (!sameJson(manifest.spec, SPEC)) problems.push(`${MANIFEST} records a different spec from SPEC in scripts/build-font.mjs (the source, the subset or the features changed without a rebuild): run npm run build:font`);
    if (!sameJson(manifest.fallback, FALLBACK)) problems.push(`${MANIFEST} records a different FALLBACK from scripts/build-font.mjs: run npm run build:font`);

    // 2. The font file: named for its hash, as recorded, within budget, and its cmap is the recorded coverage.
    const out = manifest.output ?? {};
    const current = out.file;
    const onDisk = io.names(BRAND_DIR).filter((f) => FONT_FILE.test(f));
    if (!current || !FONT_FILE.test(current)) problems.push(`${MANIFEST}: output.file is not an alexandria-600.<sha8>.woff2 name`);
    let cmapSet = new Set();
    if (current && FONT_FILE.test(current)) {
        let bytes = null;
        try {
            bytes = io.bytes(`${BRAND_DIR}/${current}`);
        } catch {
            problems.push(`${BRAND_DIR}/${current} does not exist: the manifest names it`);
        }
        if (bytes) {
            const hash = sha256(bytes);
            if (!hash.startsWith(FONT_FILE.exec(current)[1])) problems.push(`${current} holds bytes that hash to ${hash.slice(0, 8)}: a file must be named for its own hash`);
            if (hash !== out.sha256) problems.push(`${current}: its SHA-256 differs from the manifest's (${out.sha256}); the font changed without a rebuild`);
            if (bytes.length !== out.bytes) problems.push(`${current} is ${bytes.length} bytes, the manifest says ${out.bytes}`);
            if (bytes.length > MAX_BYTES) problems.push(`${current} is ${kb(bytes.length)} KB, over the ${kb(MAX_BYTES)} KB budget`);
            try {
                const tables = readWoff2(bytes);
                for (const t of ['cmap', 'GSUB', 'GPOS', 'GDEF', 'hmtx']) if (!tables.has(t)) problems.push(`${current} has no ${t} table: Arabic shaping and mark placement need it`);
                for (const t of ['fvar', 'gvar']) if (tables.has(t)) problems.push(`${current} still has ${t}: it must be the weight-600 instance, not the variable font`);
                const cps = cmapOf(tables.get('cmap').bytes);
                cmapSet = new Set(cps);
                if (formatRanges(cps) !== out.coverage) problems.push(`${current}: its cmap is not the coverage the manifest records`);
                const want = new Set(parseRanges(SPEC.unicodes));
                const stray = cps.filter((c) => !want.has(c));
                if (stray.length) problems.push(`${current} carries code points outside SPEC.unicodes: ${formatRanges(stray)}`);
            } catch (e) {
                problems.push(`${current} is not a readable woff2: ${e.message}`);
            }
        }
    }
    // 3. /brand holds this release and the one before, and the licence.
    if (onDisk.length === 0) problems.push(`${BRAND_DIR} holds no alexandria-600.<sha8>.woff2`);
    if (onDisk.length > MAX_RELEASES) problems.push(`${onDisk.length} fonts in ${BRAND_DIR} (${onDisk.join(', ')}); at most ${MAX_RELEASES}: this release and the one before`);
    if (current && !onDisk.includes(current)) problems.push(`${BRAND_DIR} does not hold ${current}`);
    try {
        if (sha256(io.bytes(`${BRAND_DIR}/${LICENCE_FILE}`)) !== SPEC.source.licenceSha256) problems.push(`${BRAND_DIR}/${LICENCE_FILE} is not the upstream OFL.txt at ${SPEC.source.commit.slice(0, 7)}`);
    } catch {
        problems.push(`${BRAND_DIR}/${LICENCE_FILE} is missing: the OFL asks for the licence to accompany the font`);
    }

    // 4. The seven files that carry the block, and the one that preloads.
    if (current && FONT_FILE.test(current)) {
        const want = faceCss(current);
        const carriers = [...PAGES, { file: STYLESHEET.file, preload: false }];
        for (const c of carriers) {
            let text;
            try {
                text = io.text(c.file);
            } catch {
                problems.push(`${c.file} is missing`);
                continue;
            }
            const blocks = [...text.matchAll(new RegExp(escapeRe(BLOCK_BEGIN), 'g'))];
            if (blocks.length !== 1) problems.push(`${c.file} carries ${blocks.length} display-face blocks, want 1: run npm run build:font`);
            else {
                const m = BLOCK_RE.exec(text);
                if (!m) problems.push(`${c.file}: the display-face block has no end marker`);
                else if (m[0].split('\n').map((l) => l.slice(m[1].length)).join('\n') !== want) problems.push(`${c.file}: the display-face block differs from what scripts/build-font.mjs generates for ${current}: run npm run build:font`);
            }
            const preloads = [...text.matchAll(PRELOAD_TAG_RE)].map((x) => x[0].trim());
            if (c.preload) {
                if (preloads.length !== 1 || preloads[0] !== preloadTag(current)) problems.push(`${c.file}: expected exactly ${preloadTag(current)}, found ${preloads.length ? preloads.join(' | ') : 'no preload'}`);
            } else if (preloads.length) problems.push(`${c.file} preloads the font, and only the landing may: a page that preloads what its first screen may not need pays for it on every visit`);
            for (const stale of onDisk.filter((f) => f !== current)) if (text.includes(stale)) problems.push(`${c.file} names ${stale}, which is not the current font`);
        }
        // Nothing else may name a font file (the dashboard shell, the Eid page, the share cards ...).
        for (const rel of ['dashboard/index.html', 'dashboard/eid.html', TOKENS]) {
            try {
                if (/alexandria-600\./.test(io.text(rel))) problems.push(`${rel} names the font file: only the generated block and the landing's preload may`);
            } catch { /* absent in a partial copy */ }
        }
    }

    // 5. --font-display.
    try {
        const tokens = io.text(TOKENS).replace(/\/\*[\s\S]*?\*\//g, '');
        const decl = [...tokens.matchAll(/--font-display:[^;]+;/g)].map((m) => m[0]);
        if (decl.length !== 1 || decl[0] !== FONT_DISPLAY) problems.push(`${TOKENS}: expected exactly "${FONT_DISPLAY}", found ${decl.length ? decl.join(' | ') : 'no --font-display'}`);
    } catch {
        problems.push(`${TOKENS} is missing`);
    }

    // 6. Everything the display face is asked to draw is in it.
    if (cmapSet.size) {
        const entries = [];
        for (const p of PAGES) {
            try {
                for (const text of publicDisplayText(io.text(p.file))) entries.push({ text, where: p.file });
            } catch { /* reported above */ }
        }
        try {
            const dict = ['ar', 'en'].map((l) => io.text(`dashboard/js/i18n.${l}.js`));
            for (const text of dashboardDisplayText(io.text('dashboard/index.html'), dict)) entries.push({ text, where: 'the dashboard' });
        } catch { /* a partial copy */ }
        for (const { cp, sample, where } of uncovered(entries, cmapSet)) {
            const hex = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
            problems.push(`display text in ${where} uses ${hex} (${JSON.stringify(String.fromCodePoint(cp))}) in "${sample}", which the font does not have; add it to SPEC.unicodes if Alexandria draws it, or take it out of the heading`);
        }
    }
    return problems;
}

// ─── build ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sourceUrl = (name) => `https://raw.githubusercontent.com/${SPEC.source.repo}/${SPEC.source.commit}/${SPEC.source.dir}/${encodeURIComponent(name)}`;

async function fetchVerified(name, want) {
    const res = await fetch(sourceUrl(name), { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${sourceUrl(name)}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== want) throw new Error(`${name} from ${SPEC.source.repo}@${SPEC.source.commit.slice(0, 7)} hashes to ${sha256(bytes)}, not the pinned ${want}: refusing it`);
    return bytes;
}

/** The pinned source and licence, from `dir` when given (still verified) and from the network otherwise. */
async function sourceFiles(dir) {
    const get = async (name, want) => {
        if (!dir) return fetchVerified(name, want);
        const bytes = readFileSync(join(dir, name));
        if (sha256(bytes) !== want) throw new Error(`${join(dir, name)} hashes to ${sha256(bytes)}, not the pinned ${want}: refusing it`);
        return bytes;
    };
    return { ttf: await get(SPEC.source.file, SPEC.source.sha256), licence: await get(LICENCE_FILE, SPEC.source.licenceSha256) };
}

/** Run subset.py on the TTF bytes; returns {bytes: Buffer, report}. The temp files live in a directory this function creates and empties. */
function subsetFont(ttf) {
    const tmp = mkdtempSync(join(tmpdir(), 'build-font-'));
    const src = join(tmp, 'source.ttf');
    const dst = join(tmp, 'out.woff2');
    try {
        writeFileSync(src, ttf);
        const stdout = execFileSync(process.env.PYTHON || 'python3', ['-I', SUBSET_PY, src, dst, '--wght', String(SPEC.weight), '--unicodes', SPEC.unicodes, '--features', SPEC.features.join(',')], { encoding: 'utf8' });
        const report = JSON.parse(stdout.trim().split('\n').pop());
        return { bytes: readFileSync(dst), report };
    } finally {
        for (const f of [src, dst]) if (existsSync(f)) unlinkSync(f);
        rmdirSync(tmp);
    }
}

/** Put the generated block (and the preload) into one file's text; returns the new text. */
function inject(text, file, fileName, { anchor, preload }) {
    let next;
    if (BLOCK_RE.test(text)) next = text.replace(BLOCK_RE, (_m, indent) => faceCss(fileName, indent));
    else {
        const at = text.indexOf(anchor);
        if (at < 0) throw new Error(`${file}: no "${anchor}" to put the display-face block before`);
        const lineStart = text.lastIndexOf('\n', at) + 1;
        const indent = /^[ \t]*/.exec(text.slice(lineStart, at + 1))[0];
        next = `${text.slice(0, lineStart)}${faceCss(fileName, indent)}\n\n${text.slice(lineStart)}`;
    }
    next = next.replace(PRELOAD_BLOCK_RE, '').replace(PRELOAD_TAG_RE, '');
    if (preload) {
        const at = next.indexOf('<link rel="stylesheet" href="/dashboard/css/tokens.css');
        if (at < 0) throw new Error(`${file}: no tokens.css <link> to put the preload before`);
        // Ahead of the comment that introduces the stylesheet link, when there is one directly above it.
        const intro = /<!--(?:(?!-->)[\s\S])*-->\s*$/.exec(next.slice(0, at));
        const insertAt = intro ? intro.index : at;
        const lineStart = next.lastIndexOf('\n', insertAt) + 1;
        const indent = /^[ \t]*/.exec(next.slice(lineStart, insertAt + 1))[0];
        const note = `${indent}${PRELOAD_NOTE} instead of after it: the headline and\n${indent}     the wordmark are on the first screen, so without this the browser finds the font only once the CSS is parsed. crossorigin is\n${indent}     required for a font even from the same origin. Only this page preloads it. Written by scripts/build-font.mjs. -->\n`;
        next = `${next.slice(0, lineStart)}${note}${indent}${preloadTag(fileName)}\n${next.slice(lineStart)}`;
    }
    return next;
}

async function build(sourceDir) {
    const { ttf, licence } = await sourceFiles(sourceDir);
    const { bytes, report } = subsetFont(ttf);
    const hash = sha256(bytes);
    const fileName = `alexandria-600.${hash.slice(0, 8)}.woff2`;
    if (report.metrics.unitsPerEm !== METRICS.unitsPerEm || report.metrics.ascent !== METRICS.ascent || -report.metrics.descent !== METRICS.descent || report.metrics.lineGap !== METRICS.lineGap) {
        throw new Error(`the font's vertical metrics are ${JSON.stringify(report.metrics)}, not METRICS ${JSON.stringify(METRICS)}: the fallback's ascent/descent overrides are derived from them, so update METRICS and re-measure`);
    }
    if (bytes.length > MAX_BYTES) throw new Error(`${fileName} is ${kb(bytes.length)} KB, over the ${kb(MAX_BYTES)} KB budget: report it, do not trim the subset silently`);

    const brand = join(ROOT, BRAND_DIR);
    mkdirSync(brand, { recursive: true });
    // The release before this one: the manifest's file, or (when nothing changed) the one it already kept.
    const last = existsSync(join(ROOT, MANIFEST)) ? JSON.parse(read(ROOT, MANIFEST)).output : undefined;
    const previous = last && last.file !== fileName ? last.file : last?.previous;
    writeFileSync(join(brand, fileName), bytes);
    writeFileSync(join(brand, LICENCE_FILE), licence);
    // This release and the one before it; anything older goes.
    for (const f of readdirSync(brand).filter((x) => FONT_FILE.test(x))) if (f !== fileName && f !== previous) unlinkSync(join(brand, f));

    const manifest = {
        spec: SPEC,
        fallback: FALLBACK,
        output: {
            file: fileName,
            ...(previous ? { previous } : {}),
            bytes: bytes.length,
            sha256: hash,
            glyphs: report.glyphs,
            codepoints: report.codepoints,
            coverage: report.coverage,
            features: report.features,
            metrics: report.metrics,
            builtWith: report.tools,
        },
    };
    writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

    const files = [...PAGES.map((p) => ({ file: p.file, anchor: PAGE_ANCHOR, preload: p.preload })), { file: STYLESHEET.file, anchor: STYLESHEET.anchor, preload: false }];
    for (const f of files) writeFileSync(join(ROOT, f.file), inject(read(ROOT, f.file), f.file, fileName, f));
    console.log(`built ${fileName}: ${kb(bytes.length)} KB (limit ${kb(MAX_BYTES)}), ${report.glyphs} glyphs, ${report.codepoints} code points, from ${SPEC.source.repo}@${SPEC.source.commit.slice(0, 7)}`);
    console.log(`wrote ${files.length} files; bump ASSET_VERSION and every ?v= together (dashboard/ changed), then run npm run check:font and npm run check:assets`);
}

async function reproduce() {
    const { ttf } = await sourceFiles(undefined);
    const { bytes } = subsetFont(ttf);
    const manifest = JSON.parse(read(ROOT, MANIFEST));
    if (sha256(bytes) !== manifest.output.sha256) {
        console.error(`not reproducible: a fresh build hashes to ${sha256(bytes)}, the committed font to ${manifest.output.sha256} (fontTools/brotli differ from ${JSON.stringify(manifest.output.builtWith)}?)`);
        process.exit(1);
    }
    console.log(`reproduced: a fresh build from ${SPEC.source.repo}@${SPEC.source.commit.slice(0, 7)} is byte-identical to ${manifest.output.file}`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--check') || args.includes('--reproduce')) {
        const problems = collectProblems();
        if (problems.length) {
            console.error('\nfont check failed:\n');
            for (const p of problems) console.error(`   - ${p}\n`);
            process.exit(1);
        }
        const m = JSON.parse(read(ROOT, MANIFEST));
        console.log(`font ok: ${m.output.file} ${kb(m.output.bytes)} KB (limit ${kb(MAX_BYTES)}), ${m.output.codepoints} code points, ${m.output.glyphs} glyphs, ${PAGES.length + 1} files carry the face, preload on ${PAGES.filter((p) => p.preload).map((p) => p.file).join(', ')}, source ${SPEC.source.repo}@${SPEC.source.commit.slice(0, 7)}`);
        if (args.includes('--reproduce')) await reproduce();
        return;
    }
    const at = args.indexOf('--source');
    await build(at >= 0 ? resolve(args[at + 1]) : undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
