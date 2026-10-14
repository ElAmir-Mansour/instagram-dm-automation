/**
 * `GET /r/:code` (S7), through a real Express server on a loopback port and a stand-in for the database.
 *
 * The claims worth pinning, each against the wire and not against the handler's internals:
 *
 *   - the 302's `Location` is the stored address, byte for byte: a referral code in the address arrives, and nothing is appended;
 *   - HEAD, link-preview fetchers and speculative loads are counted as prefetches, a person in the in-app browser is a click;
 *   - an unknown or malformed code is a 404, and nothing in the request (a `url` query, a header) ever becomes a destination;
 *   - every answer is `no-store` and `noindex`, a failed count never costs a person their link, and a dead database is a 503, not a 404;
 *   - vercel.json sends /r/* to the function, ahead of anything that could shadow it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import { RECORD_CLICK_SQL, RESOLVE_LINK_SQL } from '../services/links.js';
import { setLogSink } from '../utils/log.js';
import { setWaitUntil } from '../utils/waitUntil.js';
import { createLinksRouter } from './links.js';

const REFERRAL = 'https://shop.example/p/handbook?ref=AB12CD34EF56GH78';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const CODE = 'aB3dE5gH7j';
const UNKNOWN = 'Zz9Yy8Xx7W';

const IPHONE_IG = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 345.0.1.14.99 (iPhone14,5; iOS 17_5_1; en_US; en; scale=3.00; 1170x2532; 633215957)';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const FB_CRAWLER = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const exact = (sql: string): RegExp => new RegExp(`^${flat(sql).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

let server: Server;
let base: string;
let db: FakeDb;
let stored: Map<string, string>;
let clicks: Array<{ code: string; uaClass: string; isPrefetch: boolean }>;
let handedToWaitUntil: Promise<unknown>[];
let logs: Array<{ level: string; event: string }>;
let notFoundPage: ((req: express.Request, res: express.Response) => void) | undefined;
let restoreSink: (() => void) | undefined;
let restoreWait: (() => void) | undefined;

before(async () => {
    const app = express();
    app.use('/r', createLinksRouter({ sendNotFoundPage: (req, res) => (notFoundPage ? notFoundPage(req, res) : res.type('text/plain').send('Not Found')) }));
    // The app's own catch-all: what a path nothing claims gets, so "falls through" is visible as a plain 404.
    app.use((_req, res) => { res.status(404).type('text/plain').send('fell through'); });
    server = await new Promise<Server>((resolveListen) => { const s = app.listen(0, '127.0.0.1', () => resolveListen(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }));

beforeEach(() => {
    stored = new Map([[CODE, REFERRAL]]);
    clicks = []; handedToWaitUntil = [];
    logs = [];
    notFoundPage = undefined;
    const previous = setLogSink((level, line) => { try { logs.push({ level, event: JSON.parse(line).event }); } catch { /* not structured */ } });
    restoreSink = () => setLogSink(previous);
    const previousWait = setWaitUntil((work) => { handedToWaitUntil.push(work); });
    restoreWait = () => setWaitUntil(previousWait);
    db = installFakeDb();
    db.routes.push([exact(RESOLVE_LINK_SQL), ([code], sql) => {
        const rows = [...stored].filter(([c]) => (sql.includes('WHERE code = $1') ? c === code : true))
            .map(([c, target]) => ({ code: c, creator_id: CREATOR, conversation_id: null, offer_id: 'handbook', target_url: target }));
        return { rows };
    }]);
    db.routes.push([exact(RECORD_CLICK_SQL), ([code, uaClass, isPrefetch]) => { clicks.push({ code, uaClass, isPrefetch }); return { rows: [], rowCount: 1 }; }]);
});
afterEach(() => { db.restore(); restoreSink?.(); restoreWait?.(); });

/** Request without following the redirect. Resolves after the click, if any, has been written. */
async function hit(path: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ res: Response; body: string }> {
    const res = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
    const body = await res.text();
    await Promise.all(handedToWaitUntil);
    return { res, body };
}

describe('GET /r/:code: the redirect', () => {
    it('is a 302 whose Location is the stored address, with no body', async () => {
        const { res, body } = await hit(`/r/${CODE}`, { headers: { 'user-agent': SAFARI } });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), REFERRAL);
        assert.equal(body, '');
    });

    it('is byte for byte, for every shape of address: nothing appended, re-ordered, decoded, re-encoded or lower-cased', async () => {
        const targets = [
            REFERRAL,
            'https://shop.example/p/handbook?ref=AB12CD34EF56GH78&coupon=ABC',
            'HTTPS://Example.COM/Path?B=2&a=1&B=3#Frag',
            'https://example.com/a%20b/%E2%9C%93?q=%7Bx%7D&plus=a+b&amp=1&amp;x=2',
            'https://example.com/?',
            'https://example.com/#',
            'https://example.com',
            'https://example.com/%D9%85%D9%86%D8%AA%D8%AC',
            'http://example.com:8080/x;y=z?next=https://other.example/&u=1',
        ];
        for (const [i, target] of targets.entries()) {
            const code = `Tt${String(i).padStart(8, '0')}`;
            stored.set(code, target);
            const { res } = await hit(`/r/${code}`, { headers: { 'user-agent': SAFARI } });
            assert.equal(res.status, 302, target);
            assert.equal(res.headers.get('location'), target, target);
        }
    });

    it('carries no-store and noindex, and does not set a cookie', async () => {
        const { res } = await hit(`/r/${CODE}`);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('x-robots-tag'), 'noindex');
        assert.equal(res.headers.get('set-cookie'), null);
    });

    it('reads the destination from the table alone: a url, target or redirect in the query or the headers changes nothing', async () => {
        const evil = 'https://evil.example/phish';
        const query = `?url=${encodeURIComponent(evil)}&target=${evil}&redirect=${evil}&next=${evil}&to=${evil}&ref=hijack`;
        const { res } = await hit(`/r/${CODE}${query}`, { headers: { 'user-agent': SAFARI, referer: evil, 'x-forwarded-host': 'evil.example', host: new URL(base).host } });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), REFERRAL, 'the stored address, without the query');
        assert.equal(db.statements.some((s) => JSON.stringify(s.params).includes('evil')), false, 'nothing from the request reached a statement');
    });

    it('does not turn an unknown code with a target in the query into a redirect', async () => {
        const { res } = await hit(`/r/${UNKNOWN}?url=${encodeURIComponent('https://evil.example')}`);
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('location'), null);
    });
});

describe('GET /r/:code: what is counted', () => {
    it('a person tapping the link in Instagram\'s in-app browser is one click, not a prefetch', async () => {
        await hit(`/r/${CODE}`, { headers: { 'user-agent': IPHONE_IG } });
        assert.deepEqual(clicks, [{ code: CODE, uaClass: 'instagram', isPrefetch: false }]);
    });

    it('a person in Safari is one click', async () => {
        await hit(`/r/${CODE}`, { headers: { 'user-agent': SAFARI } });
        assert.deepEqual(clicks, [{ code: CODE, uaClass: 'ios', isPrefetch: false }]);
    });

    it('HEAD is answered like GET and counted as a prefetch, even from a browser\'s user-agent', async () => {
        const { res } = await hit(`/r/${CODE}`, { method: 'HEAD', headers: { 'user-agent': SAFARI } });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), REFERRAL);
        assert.deepEqual(clicks, [{ code: CODE, uaClass: 'ios', isPrefetch: true }]);
    });

    it('a link-preview fetcher is a prefetch: Meta\'s crawler on a GET, WhatsApp\'s', async () => {
        await hit(`/r/${CODE}`, { headers: { 'user-agent': FB_CRAWLER } });
        await hit(`/r/${CODE}`, { headers: { 'user-agent': 'WhatsApp/2.24.12.78 A' } });
        assert.deepEqual(clicks, [{ code: CODE, uaClass: 'preview', isPrefetch: true }, { code: CODE, uaClass: 'preview', isPrefetch: true }]);
    });

    it('a speculative load is a prefetch, and a request with no user-agent is not a click', async () => {
        await hit(`/r/${CODE}`, { headers: { 'user-agent': SAFARI, 'sec-purpose': 'prefetch;prerender' } });
        await hit(`/r/${CODE}`, { headers: { 'user-agent': '' } });
        assert.deepEqual(clicks.map((c) => c.isPrefetch), [true, true]);
    });

    it('still redirects the preview fetcher: it follows the link to build its card', async () => {
        const { res } = await hit(`/r/${CODE}`, { headers: { 'user-agent': FB_CRAWLER } });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), REFERRAL);
    });

    it('stores no address and no user-agent: the insert has three parameters, the code, a class and a flag', async () => {
        await hit(`/r/${CODE}`, { headers: { 'user-agent': IPHONE_IG, 'x-forwarded-for': '203.0.113.7' } });
        const insert = db.ran(/^INSERT INTO link_clicks/)[0]!;
        assert.deepEqual(insert.params, [CODE, 'instagram', false]);
        assert.equal(JSON.stringify(db.statements).includes('203.0.113.7'), false);
        assert.equal(JSON.stringify(db.statements).includes('Mozilla'), false);
    });

    it('hands the count to waitUntil, so the platform keeps the invocation alive until it is written', async () => {
        await hit(`/r/${CODE}`, { headers: { 'user-agent': SAFARI } });
        assert.equal(handedToWaitUntil.length, 1);
        await handedToWaitUntil[0];
        assert.equal(clicks.length, 1);
    });

    it('counts nothing for a code that is not a link', async () => {
        await hit(`/r/${UNKNOWN}`, { headers: { 'user-agent': SAFARI } });
        await hit('/r/short', { headers: { 'user-agent': SAFARI } });
        assert.deepEqual(clicks, []);
        assert.equal(db.ran(/^INSERT INTO link_clicks/).length, 0);
    });

    it('a count that fails is logged and costs the person nothing: the 302 has already gone out', async () => {
        db.routes.unshift([exact(RECORD_CLICK_SQL), () => { throw new Error('connection terminated'); }]);
        const { res } = await hit(`/r/${CODE}`, { headers: { 'user-agent': SAFARI } });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), REFERRAL);
        assert.deepEqual(logs.filter((l) => l.level === 'error').map((l) => l.event), ['links.click_not_recorded']);
    });
});

describe('GET /r/:code: what is not a link', () => {
    it('an unknown code is a 404 with no Location, no-store, noindex', async () => {
        const { res } = await hit(`/r/${UNKNOWN}`, { headers: { 'user-agent': SAFARI } });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('location'), null);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('x-robots-tag'), 'noindex');
    });

    it('a malformed code is a 404 without a database read: too short, too long, punctuation, encoded, a path', async () => {
        for (const bad of ['short', 'a'.repeat(40), 'abcdefghi-', 'abcdefghi%20', '%2e%2e%2fabcdefghij', 'abcdefghij.html']) {
            const { res } = await hit(`/r/${bad}`);
            assert.equal(res.status, 404, bad);
        }
        assert.equal(db.statements.length, 0);
    });

    it('answers a browser with the site\'s own 404 page, and anything else with plain text', async () => {
        let asked = 0;
        notFoundPage = (_req, res) => { asked++; res.type('html').send('<h1>الصفحة غير موجودة</h1>'); };
        const browser = await hit(`/r/${UNKNOWN}`, { headers: { accept: 'text/html,application/xhtml+xml' } });
        assert.equal(browser.res.status, 404);
        assert.equal(browser.body, '<h1>الصفحة غير موجودة</h1>');
        assert.equal(asked, 1);
        const script = await hit(`/r/${UNKNOWN}`, { headers: { accept: 'application/json' } });
        assert.equal(script.res.status, 404);
        assert.equal(script.body, 'Not Found');
        assert.equal(asked, 1, 'a client that does not take HTML is never handed the page');
    });

    it('a database that cannot be read is a 503 with no Location, not a 404 that says the link does not exist', async () => {
        db.routes.unshift([exact(RESOLVE_LINK_SQL), () => { throw new Error('the database is down'); }]);
        const { res } = await hit(`/r/${CODE}`, { headers: { 'user-agent': SAFARI } });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('location'), null);
        assert.equal(res.headers.get('retry-after'), '30');
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.deepEqual(clicks, []);
        assert.deepEqual(logs.filter((l) => l.level === 'error').map((l) => l.event), ['links.resolve_failed']);
    });

    it('is a GET (and HEAD) route only: a POST is not answered with a redirect', async () => {
        const { res } = await hit(`/r/${CODE}`, { method: 'POST' });
        assert.equal(res.status, 404);
        assert.equal(res.headers.get('location'), null);
        assert.deepEqual(clicks, []);
    });

    it('answers nothing at /r/ itself', async () => {
        const { res } = await hit('/r/');
        assert.equal(res.status, 404);
    });
});

describe('the wiring', () => {
    it('src/index.ts mounts the router at /r, after /api and before the page routes', () => {
        const index = readFileSync('src/index.ts', 'utf8').replace(/\/\/[^\n]*/g, '');
        assert.match(index, /import \{ createLinksRouter \} from '\.\/routes\/links\.js';/);
        const api = index.indexOf("app.use('/api', apiRouter)");
        const links = index.indexOf("app.use('/r', createLinksRouter(");
        const privacy = index.indexOf("app.get('/privacy'");
        assert.ok(api > 0 && links > api && privacy > links, `${api} < ${links} < ${privacy}`);
    });

    it('the unknown-code page is sent no-store: the CDN must not keep a miss for five minutes', () => {
        const index = readFileSync('src/index.ts', 'utf8');
        assert.match(index, /sendPublicPage\(req, res, 'notFound', 404, 'no-store'\)/);
        assert.match(index, /cacheControl = PUBLIC_PAGE_CACHE_CONTROL,/);
        assert.match(index, /res\.setHeader\('Cache-Control', cacheControl\);/);
    });
});

describe('vercel.json', () => {
    interface Route { src: string; dest?: string; status?: number; headers?: Record<string, string> }
    const routes = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { routes: Route[] }).routes;

    /** Vercel's legacy routing, as far as this file uses it: the first route whose anchored `src` matches the path decides. */
    function route(path: string): Route | undefined {
        return routes.find((r) => new RegExp(`^${r.src}$`).test(path));
    }

    it('sends /r/<code> to the function, by an entry of its own', () => {
        const hit = route(`/r/${CODE}`);
        assert.ok(hit, 'a route matches');
        assert.equal(hit!.src, '/r/(.*)', 'the /r entry, and not the catch-all, is the one that decides');
        assert.equal(hit!.dest, 'src/index.ts', 'the same function that serves everything else');
        assert.equal(hit!.status, undefined, 'a rewrite, not a redirect');
    });

    it('comes before every route that could shadow it, and the catch-all is still last', () => {
        const srcs = routes.map((r) => r.src);
        assert.ok(srcs.indexOf('/r/(.*)') >= 0);
        assert.ok(srcs.indexOf('/r/(.*)') < srcs.indexOf('/(.*)'));
        assert.equal(srcs[srcs.length - 1], '/(.*)');
        for (const path of [`/r/${CODE}`, '/r/a', '/r/abcdefghij/extra']) {
            const first = routes.findIndex((r) => new RegExp(`^${r.src}$`).test(path));
            assert.equal(routes[first]!.src, '/r/(.*)', path);
        }
    });

    it('does not capture the paths that are served from static files, or any path outside /r/', () => {
        for (const path of ['/dashboard', '/dashboard/js/app.js', '/samples/a.mp4', '/brand/hero3d.js']) {
            assert.notEqual(route(path)?.src, '/r/(.*)', path);
        }
        for (const path of ['/rr/abc', '/r', '/prefix/r/abc', '/api/r/abc', '/robots.txt', '/random']) {
            assert.notEqual(route(path)?.src, '/r/(.*)', path);
        }
    });

    it('the function it names is a build, so the route has somewhere to land', () => {
        const builds = (JSON.parse(readFileSync('vercel.json', 'utf8')) as { builds: Array<{ src: string; use: string }> }).builds;
        assert.ok(builds.some((b) => b.src === 'src/index.ts' && b.use === '@vercel/node'));
    });
});
