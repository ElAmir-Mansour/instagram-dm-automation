/**
 * The public pages' three operator values, applied at serve time.
 *
 * `public/*.html` and `dashboard/eid.html` used to carry the founder's outlook.com address as a
 * literal in ~20 places and an empty `data-coupons-expire`, so changing a contact channel was
 * a deploy. Now the files carry `{{WHATSAPP_URL}}`, `{{CONTACT_EMAIL}}` and
 * `{{EID_COUPONS_EXPIRE}}`, and `src/index.ts` runs every page through `renderSiteTemplate`
 * with what Settings → Public site holds (src/services/appSettings.ts `getSiteSettings`).
 *
 * The same pass also picks the page's language for crawlers and link previews: `?lang=en`
 * (PB4) keeps only the `data-lang-only="en"` `<meta>`/`<link>` lines, flips `<html lang dir>`
 * and fills `{{LANG_QUERY}}` in the canonical, so the English alternate is a real URL with its
 * own description rather than the Arabic page with a query string on it. The visitor's own
 * choice is still made in the browser (each page's head script: `?lang=`, then the stored
 * `dashboard_lang`, then Arabic).
 *
 * Pure on purpose: `src/index.ts` cannot be imported by a test (it listens on a port), so the
 * part that has to be right — replacement, stripping, escaping — lives here.
 *
 * Two more jobs, both from the landing plan (L5, L6):
 *
 *   - `compactPublicPage` runs ONCE per page per warm instance, on the file as read from disk, before
 *     any per-request work: it drops every HTML comment and every CSS comment and the indentation the
 *     source is written with. The files are annotated heavily on purpose (each one is a claim ledger and
 *     a design record), and before this the landing shipped about 130 KB of that prose to every visitor.
 *     It is a small tokenizer, not a regex, because three things have to survive a comment sweep:
 *     the inside of a `<script>` or `<style>`, an attribute value that happens to hold `<!--`, and
 *     a comment that merely MENTIONS `<style>`.
 *   - `{{SITE_ORIGIN}}` is the public origin (`app.public_base_url`, else the production address), so a
 *     canonical, an hreflang or an og:image names the deployment it is served from and not a literal
 *     copied into six files.
 */
import type { SiteSettings } from './appSettings.js';

/**
 * Where crawlers and link previews are told the site lives when no `app.public_base_url` is saved and no
 * `PUBLIC_BASE_URL` is set. Never the request's own host: a preview deployment must not announce itself as canonical.
 */
export const PRODUCTION_ORIGIN = 'https://msg-response-auto.vercel.app';

/** What a WhatsApp conversation opens with when it starts from the site. */
export const WHATSAPP_OPENER = 'مرحباً، أريد الاستفسار عن أوتوريبلاي برو';

/** `https://wa.me/<number>?text=<opener>`, or '' when there is no number. */
export function whatsappUrl(number: string | null | undefined): string {
    if (!number) return '';
    return `https://wa.me/${number}?text=${encodeURIComponent(WHATSAPP_OPENER)}`;
}

/** Safe inside a double- or single-quoted attribute, and as text. */
export function escapeAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** The tokens a page may carry, and the `data-when` / `data-unless` flag each one drives. */
const TOKENS = {
    WHATSAPP_URL: 'whatsapp',
    CONTACT_EMAIL: 'email',
    EID_COUPONS_EXPIRE: 'eid-expiry',
} as const;

type TokenName = keyof typeof TOKENS;

export type PageLang = 'ar' | 'en';

/** `?lang=en` is the only way to ask for English; anything else is the Arabic default. */
export function pageLangFromQuery(value: unknown): PageLang {
    return value === 'en' ? 'en' : 'ar';
}

/**
 * The tags an element marked `data-when` may be. Kept deliberately short and the regex
 * deliberately simple: the marked element must not contain another element of the SAME tag
 * (an `<a data-when>` holding a `<bdi>` is fine; a `<div data-when>` holding a `<div>` is
 * not — the match would stop at the inner close). Every marked element in `public/` is one
 * of these, and `publicPages.test.ts` pins the behaviour.
 */
const STRIPPABLE_TAGS = 'a|li|p|span|div|section|nav|small|button|tr';

/** Remove every element carrying `attr="flag"`, with its own line when it has one. */
function stripMarked(html: string, attr: 'data-when' | 'data-unless', flag: string): string {
    const re = new RegExp(
        `[ \\t]*<(${STRIPPABLE_TAGS})\\b[^>]*\\b${attr}="${flag}"[^>]*>[\\s\\S]*?<\\/\\1>[ \\t]*\\r?\\n?`,
        'g'
    );
    return html.replace(re, '');
}

/**
 * Remove what was written for the other language: the `<meta>` / `<link>` lines (void elements, so they
 * are matched to their own `>` rather than to a closing tag), the `<title>`, and a JSON-LD
 * `<script type="application/ld+json">`. The last two have content and a close, so they are matched to it:
 * neither can hold another `<title>` or `<script>`, which is what keeps the lazy match from running long.
 * Only these two tags carry content a crawler reads; every other marked element is a `data-when` one.
 */
function stripOtherLanguage(html: string, lang: PageLang): string {
    const other = lang === 'ar' ? 'en' : 'ar';
    const voids = new RegExp(`[ \\t]*<(?:meta|link)\\b[^>]*\\bdata-lang-only="${other}"[^>]*>[ \\t]*\\r?\\n?`, 'g');
    const withContent = new RegExp(`[ \\t]*<(title|script)\\b[^>]*\\bdata-lang-only="${other}"[^>]*>[\\s\\S]*?<\\/\\1>[ \\t]*\\r?\\n?`, 'g');
    return html.replace(voids, '').replace(withContent, '');
}

/**
 * Apply the site settings to one page's HTML:
 *   1. every element marked `data-when="x"` is removed when the value behind `x` is empty,
 *      so a page never shows a WhatsApp button that goes nowhere;
 *   2. every element marked `data-unless="x"` is removed when that value IS set — the
 *      fallback a `data-when` element replaces (a pricing CTA that points at the contact
 *      block only while there is no WhatsApp number);
 *   3. the `<meta>`/`<link>` lines, the `<title>` and the JSON-LD `<script>` marked for the other language
 *      are removed, and for English `<html lang="ar" dir="rtl">` becomes `<html lang="en" dir="ltr">`;
 *   4. every `{{TOKEN}}` is replaced with its value, attribute-escaped ('' when unset).
 *      `{{LANG_QUERY}}` is `?lang=en` on the English alternate and '' otherwise; `{{SITE_ORIGIN}}`
 *      is `origin` (no trailing slash), so `{{SITE_ORIGIN}}/pricing` is an absolute URL.
 */
export function renderSiteTemplate(html: string, site: SiteSettings, lang: PageLang = 'ar', origin: string = PRODUCTION_ORIGIN): string {
    const values: Record<TokenName, string> = {
        WHATSAPP_URL: whatsappUrl(site.whatsappNumber),
        CONTACT_EMAIL: site.contactEmail ?? '',
        EID_COUPONS_EXPIRE: site.eidCouponsExpire ?? '',
    };
    let out = html;
    for (const [token, flag] of Object.entries(TOKENS) as Array<[TokenName, string]>) {
        out = stripMarked(out, values[token] ? 'data-unless' : 'data-when', flag);
    }
    out = stripOtherLanguage(out, lang);
    if (lang === 'en') out = out.replace(/<html lang="ar" dir="rtl">/, '<html lang="en" dir="ltr">');
    const langQuery = lang === 'en' ? '?lang=en' : '';
    const siteOrigin = origin.replace(/\/+$/, '');
    return out.replace(
        /\{\{(WHATSAPP_URL|CONTACT_EMAIL|EID_COUPONS_EXPIRE|LANG_QUERY|SITE_ORIGIN)\}\}/g,
        (_m, name: TokenName | 'LANG_QUERY' | 'SITE_ORIGIN') =>
            escapeAttr(name === 'LANG_QUERY' ? langQuery : name === 'SITE_ORIGIN' ? siteOrigin : values[name])
    );
}

// ─── Serve-time compaction (L6) ─────────────────────────────────────────────────────────────────────

/** Elements whose content is not HTML at all: scanned to their close tag, never parsed. */
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['script', 'style']);
/** Elements whose content is plain text in which `<` means nothing: a `<!--` inside is words on the page, not a comment. */
const ESCAPABLE_RAW_TEXT_TAGS: ReadonlySet<string> = new Set(['textarea', 'title']);

const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * A stylesheet without its comments, its indentation or the blanks around its punctuation. A `/*! … *\/` comment (a
 * licence) is kept.
 *
 * String-aware, because a comment marker or a brace inside `"…"`, `'…'` or an unquoted `url(…)` is data: the inline SVG
 * grain behind the landing hero is exactly that. The only whitespace that goes is whitespace CSS never reads: a line's
 * indentation, and any run touching `{`, `}`, `;` or `,` (before or after) or following a `:`. Whitespace between two
 * words stays whatever it holds, which is why a descendant combinator (`a :hover`) and the spaces inside `calc(1px + 2px)`
 * survive, and `--x: ;` keeps its one space (an empty custom property is a value, and older engines refuse `--x:;`).
 * A newline follows each `}` so the served sheet is still one rule per line in view-source.
 */
export function compactCss(css: string): string {
    const out: string[] = [];
    const n = css.length;
    /** The last thing written; the start of the sheet counts as a line start. */
    const last = (): string => (out.length ? out[out.length - 1]! : '\n');
    /** Drop the blanks written so far at the end, keeping one after a `:` (see above). */
    const dropBlanks = (): void => {
        let k = out.length;
        while (k > 0 && (out[k - 1] === ' ' || out[k - 1] === '\t' || out[k - 1] === '\n')) k--;
        const keep = k < out.length && k > 0 && out[k - 1] === ':';
        out.length = k;
        if (keep) out.push(' ');
    };
    /** After `{ } ; ,` and `:`, blanks are skipped (a comment in between does not end the skip). */
    let skipBlanks = false;
    let i = 0;
    while (i < n) {
        const ch = css[i]!;
        if (skipBlanks) {
            if (isSpace(ch)) {
                i++;
                continue;
            }
            if (!(ch === '/' && css[i + 1] === '*')) skipBlanks = false;
        }
        if (ch === '/' && css[i + 1] === '*') {
            const close = css.indexOf('*/', i + 2);
            const stop = close === -1 ? n : close + 2;
            if (css[i + 2] === '!') {
                out.push(css.slice(i, stop));
                skipBlanks = false;
            } else if (!isSpace(last().slice(-1))) {
                // A comment separates tokens (`a/**/b` is two), so when it sat between two non-blank neighbours a space stands in for it.
                if (stop < n && !isSpace(css[stop])) out.push(' ');
            } else {
                // After a blank, the blanks that follow the comment are the same blank.
                skipBlanks = true;
            }
            i = stop;
            continue;
        }
        if (ch === '"' || ch === "'") {
            let j = i + 1;
            while (j < n && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
            out.push(css.slice(i, Math.min(j + 1, n)));
            i = j + 1;
            continue;
        }
        if ((ch === 'u' || ch === 'U') && css.slice(i, i + 4).toLowerCase() === 'url(' && !/[\w-]/.test(css[i - 1] ?? ' ')) {
            let j = i + 4;
            while (j < n && isSpace(css[j])) j++;
            if (css[j] === '"' || css[j] === "'") {
                // A quoted url() is its string; the next turn of the loop copies it.
                out.push(css.slice(i, j));
                i = j;
                continue;
            }
            while (j < n && css[j] !== ')') j += css[j] === '\\' ? 2 : 1;
            out.push(css.slice(i, Math.min(j + 1, n)));
            i = j + 1;
            continue;
        }
        if (ch === '{' || ch === '}' || ch === ';' || ch === ',') {
            dropBlanks();
            out.push(ch);
            if (ch === '}' && i + 1 < n) out.push('\n');
            skipBlanks = true;
            i++;
            continue;
        }
        if (ch === ':') {
            out.push(ch);
            // `--x: ;` and `a: }` keep the one blank that makes the value empty rather than missing.
            let j = i + 1;
            while (j < n && isSpace(css[j])) j++;
            if (j > i + 1 && (css[j] === ';' || css[j] === '}')) out.push(' ');
            skipBlanks = true;
            i++;
            continue;
        }
        if (ch === '\r') {
            i++;
            continue;
        }
        if (ch === '\n') {
            while (out.length && (last() === ' ' || last() === '\t')) out.pop();
            if (last() !== '\n') out.push('\n');
            i++;
            continue;
        }
        if ((ch === ' ' || ch === '\t') && last() === '\n') {
            i++;
            continue;
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}

/** The end of the tag that starts at `from` (the index of its `>`), reading a quoted attribute value as one piece; -1 when it never closes. */
function tagEnd(html: string, from: number): number {
    let i = from + 1;
    while (i < html.length) {
        const ch = html[i]!;
        if (ch === '>') return i;
        if (ch === '=') {
            let j = i + 1;
            while (j < html.length && isSpace(html[j])) j++;
            const quote = html[j];
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, j + 1);
                if (close === -1) return -1;
                i = close + 1;
            } else {
                i = j;
            }
            continue;
        }
        i++;
    }
    return -1;
}

/** Text between tags: the line's indentation and trailing blanks go, and a run of blank lines is one line break. Whitespace stays whitespace. */
function compactText(text: string): string {
    return text.replace(/[ \t]*\r?\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n');
}

/**
 * A public page as served: no HTML comment, no CSS comment, no indentation. Run once per page, on the file as read,
 * and the result cached by the caller (`src/index.ts`).
 *
 *   - An HTML comment outside `<script>`, `<style>` and an attribute is removed, and the text on its two sides stays
 *     one run (a comment on its own line leaves no blank line). An IE conditional comment (`<!--[if …]>`) is kept: it is
 *     content for a browser that reads it, not prose for an author. A comment that is never closed is left as it is,
 *     since the browser would read the whole remainder as that comment and guessing otherwise would change the page.
 *   - A `<style>` goes through `compactCss`. A `<script>` is copied byte for byte: its comments are a few KB, and a
 *     JavaScript comment stripper cannot be a handful of lines (regex literals and template strings look like comment
 *     markers). `<textarea>`, `<title>` and `<pre>` keep every character.
 *   - Whitespace between tags loses its indentation but never its line break, so no two words run together and no
 *     inline gap closes: in HTML a run of whitespace renders as one space whatever it holds. No page here sets
 *     `white-space: pre*` on anything, and `publicPagesSeo.test.ts` compares the page before and after with every
 *     whitespace run squashed to prove the only difference is comments and blanks.
 */
export function compactPublicPage(html: string): string {
    const n = html.length;
    let out = '';
    /** Text since the last tag. A removed comment does not end it, so the two halves merge before they are compacted. */
    let pending = '';
    let preDepth = 0;
    const flush = (): void => {
        out += preDepth > 0 ? pending : compactText(pending);
        pending = '';
    };
    let i = 0;
    while (i < n) {
        const lt = html.indexOf('<', i);
        if (lt === -1) {
            pending += html.slice(i);
            break;
        }
        pending += html.slice(i, lt);
        i = lt;
        const next = html[i + 1] ?? '';

        if (html.startsWith('<!--', i)) {
            const close = html.indexOf('-->', i + 4);
            if (close === -1) {
                flush();
                out += html.slice(i);
                break;
            }
            const body = html.slice(i + 4, close);
            if (/^\s*\[if\b/i.test(body) || body.startsWith('<![endif]')) {
                flush();
                out += html.slice(i, close + 3);
            }
            i = close + 3;
            continue;
        }

        if (html.startsWith('<![CDATA[', i)) {
            const close = html.indexOf(']]>', i);
            const stop = close === -1 ? n : close + 3;
            flush();
            out += html.slice(i, stop);
            i = stop;
            continue;
        }

        if (next === '!' || next === '?') {
            const close = html.indexOf('>', i);
            const stop = close === -1 ? n : close + 1;
            flush();
            out += html.slice(i, stop);
            i = stop;
            continue;
        }

        if (next === '/') {
            const close = html.indexOf('>', i);
            if (close === -1) {
                flush();
                out += html.slice(i);
                break;
            }
            flush();
            if (/^<\/pre[\s/>]/i.test(html.slice(i, i + 7)) && preDepth > 0) preDepth--;
            out += html.slice(i, close + 1);
            i = close + 1;
            continue;
        }

        if (/[A-Za-z]/.test(next)) {
            const close = tagEnd(html, i);
            if (close === -1) {
                flush();
                out += html.slice(i);
                break;
            }
            const tag = html.slice(i, close + 1);
            const name = /^<([A-Za-z][^\s>/]*)/.exec(tag)![1]!.toLowerCase();
            flush();
            out += tag;
            i = close + 1;
            if (tag.endsWith('/>')) continue;
            if (RAW_TEXT_TAGS.has(name) || ESCAPABLE_RAW_TEXT_TAGS.has(name)) {
                const closing = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
                closing.lastIndex = i;
                const found = closing.exec(html);
                const stop = found ? found.index : n;
                const content = html.slice(i, stop);
                out += name === 'style' ? compactCss(content) : content;
                i = stop;
            } else if (name === 'pre') {
                preDepth++;
            }
            continue;
        }

        // A `<` that opens nothing ("a < b"): text.
        pending += '<';
        i++;
    }
    flush();
    return out;
}
