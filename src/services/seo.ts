/**
 * What a crawler is told about the site: `robots.txt` and `sitemap.xml` (landing plan L5).
 *
 * Both are built from an origin and nothing else, so `src/routes/seo.ts` can serve them from the saved
 * `app.public_base_url` and a test can run them on any address. The list of indexed pages is the one
 * place that says which URLs are meant to be found; `publicPagesSeo.test.ts` checks it against the pages
 * themselves (each declares a canonical and an ar/en/x-default hreflang set, and none is `noindex`).
 */

/**
 * The pages worth indexing, each in two languages. Not the 404 (`noindex`), not `/dashboard` (a login), and not
 * `/eid`: a coupon campaign in Arabic only, with no English alternate and an expiry date, and not this product.
 */
export const INDEXED_PATHS = ['/', '/pricing', '/privacy', '/terms', '/data-deletion'] as const;

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const origin_ = (origin: string): string => origin.replace(/\/+$/, '');

/**
 * `/dashboard` and `/api` stay out of search results, with two exceptions that are deliberate:
 *
 *   - `/dashboard/css/` — every public page links `/dashboard/css/tokens.css`. A crawler that may not fetch the stylesheet renders
 *     the page unstyled and judges it by that, so the one folder the public pages need is allowed (the longer rule wins);
 *   - `/api/uploads/` — the media Meta and TikTok are told to fetch (`/api/uploads/<id>`, public by design). TikTok's photo
 *     posts pull from that exact path, and whether its fetcher honours robots.txt is not documented: blocking it would risk
 *     a publish for nothing, since nothing links to those URLs.
 *
 * The Allow lines come first because some parsers take the first rule that matches rather than the longest.
 */
export function robotsTxt(origin: string): string {
    return [
        'User-agent: *',
        'Allow: /dashboard/css/',
        'Allow: /api/uploads/',
        'Disallow: /dashboard',
        'Disallow: /api',
        '',
        `Sitemap: ${origin_(origin)}/sitemap.xml`,
        '',
    ].join('\n');
}

/**
 * One `<url>` per page per language, each carrying the whole alternate set (itself included), which is what Google's
 * guidelines ask for: every language version lists every other. No `lastmod`: nothing here knows when a page's copy last
 * changed, and an invented date teaches a crawler to ignore the real ones.
 */
export function sitemapXml(origin: string): string {
    const base = origin_(origin);
    const entries: string[] = [];
    for (const path of INDEXED_PATHS) {
        const ar = `${base}${path}`;
        const en = `${base}${path}?lang=en`;
        for (const loc of [ar, en]) {
            entries.push(
                [
                    '  <url>',
                    `    <loc>${xml(loc)}</loc>`,
                    `    <xhtml:link rel="alternate" hreflang="ar" href="${xml(ar)}"/>`,
                    `    <xhtml:link rel="alternate" hreflang="en" href="${xml(en)}"/>`,
                    `    <xhtml:link rel="alternate" hreflang="x-default" href="${xml(ar)}"/>`,
                    '  </url>',
                ].join('\n')
            );
        }
    }
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
        ...entries,
        '</urlset>',
        '',
    ].join('\n');
}
