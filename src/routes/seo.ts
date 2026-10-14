/**
 * `GET /robots.txt` and `GET /sitemap.xml` (landing plan L5).
 *
 * Served by the function, not as files under `public/`: both name the site's own origin, which is the
 * `app.public_base_url` setting (src/services/appSettings.ts `getSiteOrigin`), and `public/**` has no static
 * handler here (vercel.json sends only /samples/*, /brand/* and /dashboard/* to files and everything else to
 * `src/index.ts`, so these two paths already reach this router with no routing change).
 *
 * The CDN keeps an answer for five minutes, like the pages: a saved origin appears within minutes, and a crawler
 * that fetches both once a day never sees the difference.
 */
import { Router, type Request, type Response } from 'express';
import { log, describeError } from '../utils/log.js';
import { robotsTxt, sitemapXml } from '../services/seo.js';

const CACHE_CONTROL = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600';

export interface SeoRouterDeps {
    /** The origin to name the site at: `getSiteOrigin` in production. It must not throw; a failure is a 500. */
    getOrigin: () => Promise<string>;
}

export function createSeoRouter({ getOrigin }: SeoRouterDeps): Router {
    const router = Router();
    const serve = (contentType: string, build: (origin: string) => string, name: string) =>
        async (_req: Request, res: Response): Promise<void> => {
            try {
                const body = build(await getOrigin());
                res.setHeader('Cache-Control', CACHE_CONTROL);
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.type(contentType).send(body);
            } catch (err) {
                log('error', 'seo.render_failed', { file: name, ...describeError(err) });
                res.status(500).type('text/plain').send('Unavailable');
            }
        };
    router.get('/robots.txt', serve('text/plain; charset=utf-8', robotsTxt, 'robots.txt'));
    router.get('/sitemap.xml', serve('application/xml; charset=utf-8', sitemapXml, 'sitemap.xml'));
    return router;
}
