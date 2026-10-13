/**
 * A small, forgiving HTML tokenizer: enough to read a creator's own website, no more. There is no HTML
 * parser in `package.json` and none is added: the extractor needs tags, attributes and text, in order,
 * from pages that are often broken (unclosed tags, unquoted attributes, scripts full of `<`). It never
 * builds a tree and never throws; it scans by index, with no backtracking pattern that a hostile page
 * could make quadratic, and it stops at fixed caps (input size, token count, attributes per tag,
 * attribute length). Nothing here fetches, executes or renders anything.
 */

export type Token =
    | { t: 'open'; tag: string; attrs: Record<string, string>; selfClosing: boolean }
    | { t: 'close'; tag: string }
    | { t: 'text'; text: string };

export const MAX_HTML_CHARS = 2_000_000;
const MAX_TOKENS = 300_000;
const MAX_ATTRS = 64;
const MAX_ATTR_CHARS = 20_000;

/** Elements whose content is not markup: it runs to the matching close tag. `title` and `textarea` hold text (entities decode), the rest hold code. */
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const ESCAPABLE_RAW_TEXT = new Set(['title', 'textarea']);

export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'command', 'keygen',
]);

/** ASCII-only lower-casing: unlike `toLowerCase`, it never changes the length of the string, so indexes into the copy stay valid. */
const lowerAscii = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', copy: '©', reg: '®', trade: '™', ndash: '–', mdash: '—', hellip: '…',
    laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', times: '×', rlm: '\u200F', lrm: '\u200E',
    zwnj: '\u200C', zwj: '\u200D', shy: '\u00AD', pound: '£', yen: '¥', cent: '¢', deg: '°', hearts: '♥', star: '☆', check: '✓',
};

/** Character references: the numeric ones and a short list of named ones. Decoded once, so `&amp;lt;` is `&lt;`, not `<`. */
export function decodeEntities(text: string): string {
    if (!text.includes('&')) return text;
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (whole, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
            return String.fromCodePoint(code);
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/** Reads one open tag starting just after `<`. Returns the token and where scanning resumes. */
function readOpenTag(html: string, start: number): { token: Extract<Token, { t: 'open' }>; end: number } {
    let i = start;
    const n = html.length;
    while (i < n && !isSpace(html[i]!) && html[i] !== '/' && html[i] !== '>') i++;
    const tag = lowerAscii(html.slice(start, i));
    const attrs: Record<string, string> = {};
    let count = 0;
    let selfClosing = false;
    while (i < n) {
        while (i < n && (isSpace(html[i]!) || html[i] === '/')) {
            if (html[i] === '/' && html[i + 1] === '>') selfClosing = true;
            i++;
        }
        if (i >= n) break;
        if (html[i] === '>') {
            i++;
            break;
        }
        const nameStart = i;
        while (i < n && !isSpace(html[i]!) && html[i] !== '=' && html[i] !== '>' && html[i] !== '/') i++;
        const name = lowerAscii(html.slice(nameStart, i));
        while (i < n && isSpace(html[i]!)) i++;
        let value = '';
        if (html[i] === '=') {
            i++;
            while (i < n && isSpace(html[i]!)) i++;
            const quote = html[i];
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, i + 1);
                const stop = close < 0 ? n : close;
                value = html.slice(i + 1, stop);
                i = close < 0 ? n : close + 1;
            } else {
                const valueStart = i;
                while (i < n && !isSpace(html[i]!) && html[i] !== '>') i++;
                value = html.slice(valueStart, i);
            }
        }
        // The first value of an attribute wins, as in a browser, and a flood of attributes is cut off.
        if (name && !(name in attrs) && count < MAX_ATTRS) {
            attrs[name] = decodeEntities(value.length > MAX_ATTR_CHARS ? value.slice(0, MAX_ATTR_CHARS) : value);
            count++;
        }
    }
    return { token: { t: 'open', tag, attrs, selfClosing }, end: i };
}

/** Tokenizes HTML. Comments, doctypes, processing instructions and CDATA are dropped; raw-text elements come back as one text token. */
export function tokenize(input: string): Token[] {
    const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
    const lower = lowerAscii(html);
    const tokens: Token[] = [];
    const n = html.length;
    let i = 0;
    const text = (from: number, to: number, decode = true) => {
        if (to <= from) return;
        const raw = html.slice(from, to);
        tokens.push({ t: 'text', text: decode ? decodeEntities(raw) : raw });
    };
    while (i < n && tokens.length < MAX_TOKENS) {
        const lt = html.indexOf('<', i);
        if (lt < 0) {
            text(i, n);
            break;
        }
        text(i, lt);
        const next = html[lt + 1];
        if (html.startsWith('<!--', lt)) {
            const close = html.indexOf('-->', lt + 4);
            i = close < 0 ? n : close + 3;
        } else if (next === '!' || next === '?') {
            const close = html.indexOf('>', lt + 2);
            i = close < 0 ? n : close + 1;
        } else if (next === '/' && isLetter(html[lt + 2])) {
            const close = html.indexOf('>', lt + 2);
            const stop = close < 0 ? n : close;
            const name = lowerAscii(html.slice(lt + 2, stop)).split(/[\s/]/)[0]!;
            tokens.push({ t: 'close', tag: name });
            i = close < 0 ? n : close + 1;
        } else if (isLetter(next)) {
            const { token, end } = readOpenTag(html, lt + 1);
            tokens.push(token);
            i = end;
            const raw = RAW_TEXT.has(token.tag);
            if (!token.selfClosing && (raw || ESCAPABLE_RAW_TEXT.has(token.tag))) {
                const close = lower.indexOf(`</${token.tag}`, i);
                const stop = close < 0 ? n : close;
                text(i, stop, !raw);
                i = stop;
            }
        } else {
            // A `<` that starts nothing ("a < b"): it is text.
            text(lt, lt + 1);
            i = lt + 1;
        }
    }
    return tokens;
}

/** Whitespace folded to single spaces, ends trimmed. */
export const collapse = (s: string): string => s.replace(/[\s\u00A0]+/g, ' ').trim();
