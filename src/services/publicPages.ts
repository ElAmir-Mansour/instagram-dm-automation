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
 */
import type { SiteSettings } from './appSettings.js';

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
 * Remove the `<meta>` / `<link>` lines written for the other language. Void elements, so they
 * are matched to their own `>` rather than to a closing tag.
 */
function stripOtherLanguage(html: string, lang: PageLang): string {
    const other = lang === 'ar' ? 'en' : 'ar';
    const re = new RegExp(`[ \\t]*<(?:meta|link)\\b[^>]*\\bdata-lang-only="${other}"[^>]*>[ \\t]*\\r?\\n?`, 'g');
    return html.replace(re, '');
}

/**
 * Apply the site settings to one page's HTML:
 *   1. every element marked `data-when="x"` is removed when the value behind `x` is empty,
 *      so a page never shows a WhatsApp button that goes nowhere;
 *   2. every element marked `data-unless="x"` is removed when that value IS set — the
 *      fallback a `data-when` element replaces (a pricing CTA that points at the contact
 *      block only while there is no WhatsApp number);
 *   3. the `<meta>`/`<link>` lines marked for the other language are removed, and for English
 *      `<html lang="ar" dir="rtl">` becomes `<html lang="en" dir="ltr">`;
 *   4. every `{{TOKEN}}` is replaced with its value, attribute-escaped ('' when unset).
 *      `{{LANG_QUERY}}` is `?lang=en` on the English alternate and '' otherwise.
 */
export function renderSiteTemplate(html: string, site: SiteSettings, lang: PageLang = 'ar'): string {
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
    return out.replace(/\{\{(WHATSAPP_URL|CONTACT_EMAIL|EID_COUPONS_EXPIRE|LANG_QUERY)\}\}/g, (_m, name: TokenName | 'LANG_QUERY') =>
        escapeAttr(name === 'LANG_QUERY' ? langQuery : values[name])
    );
}
