/**
 * `GET /r/:code`: the tracked link a sales DM carries (docs/DM_SALES_PLAN.md §9, S7). Public, and mounted in src/index.ts before any auth.
 *
 *   known code     302 to the stored address, `Location` exactly as stored: a referral parameter in it survives and nothing is added to it.
 *   unknown code   404, the site's bilingual page for a browser. A malformed code is the same 404 without a database read.
 *   database down  503. The link cannot be read, so there is nothing to redirect to, and a 404 would say the link does not exist.
 *
 * The target comes from the table and from nowhere else. Nothing in the URL, the query string or a header is ever read as an address, so this
 * is not an open redirect: the only way to make it send a person somewhere is to put a row in `tracked_links`.
 *
 * Every answer carries `Cache-Control: no-store` (a cached 302 would count nothing and a cached 404 would outlive the row it was a miss for)
 * and `X-Robots-Tag: noindex`.
 *
 * The click is counted AFTER the redirect has gone out, under `waitUntil` (src/utils/waitUntil.ts, the webhook's own mechanism): the person
 * waits for one read, not two writes, and a failed count is logged and costs them nothing. HEAD is answered like GET, because Express routes it
 * to this handler, and is counted as a prefetch with every other request that is not a person (src/services/links.ts `classifyClick`).
 *
 * It is a router of its own, and not a handler inline in `src/index.ts`, because that file binds a port when it is imported: this is the part a
 * test can run.
 */
import { Router, type Request, type Response } from 'express';
import { classifyClick, isLinkCode, recordClick, resolve, type TrackedLink } from '../services/links.js';
import { describeError, log } from '../utils/log.js';
import { waitUntil } from '../utils/waitUntil.js';

export interface LinksRouterDeps {
    /**
     * Sends the site's own 404 page. Given only for a client that accepts HTML, the way the app's catch-all does; everything else gets a plain
     * 404. Absent in tests.
     */
    sendNotFoundPage?: (req: Request, res: Response) => void;
}

/** The headers a browser adds when it fetches a link speculatively. Joined and matched as one string by `classifyClick`. */
const PURPOSE_HEADERS = ['sec-purpose', 'purpose', 'x-moz', 'x-purpose'] as const;

function header(req: Request, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value.join(' ') : value;
}

export function createLinksRouter(deps: LinksRouterDeps = {}): Router {
    const router = Router();

    const notFound = (req: Request, res: Response): void => {
        res.status(404);
        if (deps.sendNotFoundPage && req.accepts('html')) {
            deps.sendNotFoundPage(req, res);
            return;
        }
        res.type('text/plain').send('Not Found');
    };

    router.get('/:code', async (req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Robots-Tag', 'noindex');

        const code = req.params['code'];
        if (!isLinkCode(code)) {
            notFound(req, res);
            return;
        }

        let link: TrackedLink | null;
        try {
            link = await resolve(code);
        } catch (err) {
            log('error', 'links.resolve_failed', describeError(err));
            res.status(503).setHeader('Retry-After', '30');
            res.type('text/plain').send('Temporarily unavailable');
            return;
        }
        if (!link) {
            notFound(req, res);
            return;
        }

        // The stored address, as the Location header and nothing else: no `res.redirect` (it re-encodes), no query appended, no body.
        const location: string = link.targetUrl;
        res.status(302).setHeader('Location', location);
        res.end();

        const click = classifyClick({
            method: req.method,
            userAgent: header(req, 'user-agent'),
            purpose: PURPOSE_HEADERS.map((name) => header(req, name)).filter(Boolean).join(' '),
        });
        const settled = recordClick(code, click).catch((err: unknown) => {
            log('error', 'links.click_not_recorded', describeError(err));
        });
        waitUntil(settled);
        await settled;
    });

    return router;
}
