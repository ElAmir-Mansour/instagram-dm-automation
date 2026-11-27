/**
 * UX U2 (research CP-S2): ONE Mac chip that knows "Claude signed in", and the tab strips that open on their current tab.
 *
 * The REAL components.js and pages in the shared vm harness:
 *   - `UI.workerChip` has three states (online + Claude signed in, Claude signed out, Mac asleep), in both languages, and a signed-out Mac
 *     that is also asleep says "asleep" (nothing can be fixed until it wakes);
 *   - the Studio's four pages and Ads proposals draw THAT chip, not a pill of their own, so none of them says "online" while Claude is signed out;
 *   - `UI.watchTabStrips` reveals the current tab of a `.segmented` strip the moment any render puts one in the page, once, and never a strip
 *     that fits or that a thumb already scrolled;
 *   - the Ads Results page marks its tab current in every state (loading and failed too).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const PAGES = [
    'dashboard/js/pages/studio.js', 'dashboard/js/pages/monteur.js', 'dashboard/js/pages/infographics.js', 'dashboard/js/pages/explainers.js',
    'dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_proposals.js', 'dashboard/js/pages/ads_results.js',
];
const plain = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

const ONLINE = { online: true, lastSeen: ago(5_000), name: 'Mac' };
const ASLEEP = { online: false, lastSeen: ago(3 * HOUR), name: 'Mac' };

describe('UI.workerChip: three states', () => {
    it('online with Claude signed in: "Mac online · Claude signed in · N waiting"', () => {
        const h = loadDashboard({ lang: 'en' });
        const chip = String(h.UI.workerChip({ worker: ONLINE, jobs: { pending: 2 }, claude: { applies: true, signedOutAt: null } }));
        assert.match(chip, /data-state="online"/);
        assert.equal(plain(chip).replace(/\s*\?\s*$/, ''), '● Mac online · Claude signed in · 2 waiting');
    });

    it('online with Claude signed out: says so and what to run, in red, however many jobs wait', () => {
        const h = loadDashboard({ lang: 'en' });
        const chip = String(h.UI.workerChip({ worker: ONLINE, jobs: { pending: 4 }, claude: { applies: true, signedOutAt: ago(HOUR) } }));
        assert.match(chip, /data-state="signed_out"/);
        assert.match(chip, /health-stale/);
        assert.match(plain(chip).replace(/[\u2066\u2069]/g, ''), /▲ Claude on the Mac is signed out: run claude \/login on the Mac/);
        assert.doesNotMatch(plain(chip), /signed in|online/i, 'no "online" while Claude is signed out');
        assert.match(chip, /href="#\/help\/worker#claude-signed-out"/, 'its help link goes to the fix');
    });

    it('asleep: since when, and how many jobs wait (one, many, none)', () => {
        const h = loadDashboard({ lang: 'en' });
        const say = (jobs: Json) => plain(h.UI.workerChip({ worker: ASLEEP, jobs, claude: { applies: true, signedOutAt: null } }));
        assert.match(say({ pending: 2 }), /○ Mac asleep since 3h · 2 jobs wait/);
        assert.match(say({ pending: 1 }), /Mac asleep since 3h · 1 job waits/);
        assert.match(say({ pending: 0 }), /○ Mac asleep since 3h(?! ·)/);
        assert.match(String(h.UI.workerChip({ worker: ASLEEP, jobs: {} })), /data-state="asleep"/);
        assert.match(plain(h.UI.workerChip({ worker: { online: false, lastSeen: null }, jobs: { pending: 3 } })), /Mac not connected yet · 3 waiting/);
    });

    it('a Mac that is asleep wins over a stale signed-out flag: nothing can be fixed until it wakes', () => {
        const h = loadDashboard({ lang: 'en' });
        const chip = String(h.UI.workerChip({ worker: ASLEEP, jobs: { pending: 1 }, claude: { applies: true, signedOutAt: ago(5 * HOUR) } }));
        assert.match(chip, /data-state="asleep"/);
    });

    it('claims nothing about Claude unless the server says the Mac does this workspace\'s Claude work', () => {
        const h = loadDashboard({ lang: 'en' });
        for (const claude of [undefined, null, { applies: false, signedOutAt: null }]) {
            const text = plain(h.UI.workerChip({ worker: ONLINE, jobs: { pending: 0 }, claude }));
            assert.match(text, /● Mac online · 0 waiting/);
            assert.doesNotMatch(text, /Claude/);
        }
    });

    it('is in Arabic (فصحى), with the command isolated left-to-right and «الماك» as the app writes it', () => {
        const h = loadDashboard({ lang: 'ar' });
        const out = plain(h.UI.workerChip({ worker: ONLINE, jobs: { pending: 0 }, claude: { applies: true, signedOutAt: ago(HOUR) } }));
        assert.match(out, /Claude على الماك غير مسجّل الدخول: شغّل ⁦claude \/login⁩ على الماك/);
        assert.match(plain(h.UI.workerChip({ worker: ONLINE, jobs: { pending: 0 }, claude: { applies: true, signedOutAt: null } })), /الماك متصل · Claude مسجّل الدخول/);
        assert.match(plain(h.UI.workerChip({ worker: ASLEEP, jobs: { pending: 2 } })), /الماك نائم منذ 3 ساعات · مهمتان تنتظران/);
    });
});

describe('every Studio page and Ads proposals draw the same chip', () => {
    const signedOut = { worker: ONLINE, jobs: { pending: 1, claimed: 0 }, claude: { applies: true, signedOutAt: ago(HOUR) } };
    const h = loadDashboard({ lang: 'en', files: PAGES });
    const P = h.run<Json>('({ StudioPage, MonteurPage, InfographicsPage, ExplainersPage, AdsProposalsPage })');

    it('Studio and Monteur: the status item is the chip, with Claude signed out shown as such', () => {
        const studio = String(P.StudioPage.workerMarkup(signedOut.worker, signedOut.jobs, signedOut.claude));
        assert.match(studio, /id="studio-worker-pill"[^>]*data-state="signed_out"/);
        P.MonteurPage.view = { worker: signedOut.worker, jobs: signedOut.jobs, claude: signedOut.claude };
        const monteur = String(P.MonteurPage.workerMarkup());
        assert.match(monteur, /id="mt-worker-pill"[^>]*data-state="signed_out"/);
        for (const markup of [studio, monteur]) assert.doesNotMatch(plain(markup), /Worker online/);
    });

    it('Infographics and Explainers: the chip, from the status read', () => {
        P.InfographicsPage.items = [];
        P.InfographicsPage.acceptMac({ status: 'fulfilled', value: signedOut });
        P.InfographicsPage.worker = signedOut.worker;
        assert.match(String(P.InfographicsPage.workerMarkup()), /id="ig-worker-chip"[^>]*data-state="signed_out"/);
        P.ExplainersPage.items = [];
        P.ExplainersPage.kind = 'list';
        P.ExplainersPage.acceptWorker({ status: 'fulfilled', value: signedOut });
        assert.match(String(P.ExplainersPage.workerMarkup()), /id="ex-worker-chip"[^>]*data-state="signed_out"/);
        // Nothing known about the Mac, nothing drawn.
        P.InfographicsPage.worker = null;
        assert.equal(String(P.InfographicsPage.workerMarkup()), '');
    });

    it('Ads proposals: only for a workspace whose drafts run on the Mac', () => {
        P.AdsProposalsPage.mac = signedOut;
        assert.match(String(P.AdsProposalsPage.macMarkup()), /id="adsprop-worker-chip"[^>]*data-state="signed_out"/);
        P.AdsProposalsPage.mac = { ...signedOut, claude: { applies: false, signedOutAt: null } };
        assert.equal(String(P.AdsProposalsPage.macMarkup()), '');
        P.AdsProposalsPage.mac = null;
        assert.equal(String(P.AdsProposalsPage.macMarkup()), '');
    });

    it('the old per-page "Worker online" pill is gone: only Settings → Workers (one row per worker) still names a worker\'s state', () => {
        for (const file of PAGES) {
            const source = readFileSync(file, 'utf8');
            const uses = source.split('\n').filter((line) => /t\('studio\.worker\.online'\)/.test(line));
            assert.equal(uses.length, file.endsWith('studio.js') ? 1 : 0, file);
            assert.doesNotMatch(source, /id="(?:studio|mt)-worker-pill">\s*<span class="health-dot"/, file);
        }
        const studio = readFileSync('dashboard/js/pages/studio.js', 'utf8');
        const body = studio.slice(studio.indexOf('    workerMarkup(worker, jobs, claude) {'), studio.indexOf('    workerHelpMarkup(worker) {'));
        assert.ok(body.length > 200 && body.includes('UI.workerChip('), 'the Studio status item is the chip');
    });
});

describe('the server says what the chip needs', () => {
    it('GET /studio/status and the Monteur view both carry `claude` and the queue', () => {
        assert.match(readFileSync('src/routes/studio.ts', 'utf8'), /claudeStatusFor\(creatorId\)[\s\S]*res\.json\(\{ worker, lessons, jobs, tiktok: \{ audited: flags\.audited, queued \}, claude \}\)/);
        const view = readFileSync('src/services/monteur/view.ts', 'utf8');
        assert.match(view, /claudeStatusFor\(creatorId\),\s*jobCounts\(creatorId\),/);
        assert.match(view, /worker,\s*claude,\s*jobs,/);
    });
});

// ─── Tab strips ───────────────────────────────────────────────────────────────────────────

interface Box { left: number; width: number }
function strip(opts: { scrollWidth: number; clientWidth: number; box: Box; tab: Box | null; scrollLeft?: number }): Json {
    const rect = (b: Box) => ({ left: b.left, width: b.width, right: b.left + b.width, top: 0, bottom: 0, height: 0 });
    const s: Json = {
        nodeType: 1, scrollWidth: opts.scrollWidth, clientWidth: opts.clientWidth, scrollLeft: opts.scrollLeft ?? 0,
        matches: (sel: string) => sel === 'nav.segmented',
        querySelectorAll: () => [],
        querySelector: (sel: string) => (sel === '[aria-current="page"]' && opts.tab ? { getBoundingClientRect: () => rect(opts.tab!) } : null),
        getBoundingClientRect: () => rect(opts.box),
    };
    return s;
}

/** A page container that a render writes into: the fake observer is how the test "renders". */
function watched() {
    let callback: ((records: Json[]) => void) | null = null;
    const observed: Json[] = [];
    class FakeObserver {
        constructor(cb: (records: Json[]) => void) { callback = cb; }
        observe(target: Json, options: Json): void { observed.push({ target, options }); }
    }
    const h = loadDashboard({ lang: 'en', globals: { MutationObserver: FakeObserver } });
    const host: Json = { nodeType: 1, matches: () => false, querySelectorAll: () => [] };
    h.UI.watchTabStrips(host);
    const render = (...added: Json[]) => callback!([{ addedNodes: added }]);
    return { h, render, observed, host };
}

describe('UI.watchTabStrips', () => {
    it('watches the page container for any render, subtree included', () => {
        const { observed, host } = watched();
        assert.equal(observed.length, 1);
        assert.equal(observed[0].target, host);
        assert.equal(JSON.stringify(observed[0].options), JSON.stringify({ childList: true, subtree: true }));
    });

    it('moves a strip whose current tab is out of view: its own scrollLeft, by the distance between the two boxes', () => {
        const { render } = watched();
        // The strip shows x 0..300 of a 900 px row; the current tab (width 100) sits at x 700..800: its centre is 600 px past the strip's.
        const s = strip({ scrollWidth: 900, clientWidth: 300, box: { left: 0, width: 300 }, tab: { left: 700, width: 100 } });
        render(s);
        assert.equal(s.scrollLeft, 600);
    });

    it('finds a strip inside a node the render added (a whole page, not only the strip)', () => {
        const { render } = watched();
        const s = strip({ scrollWidth: 900, clientWidth: 300, box: { left: 0, width: 300 }, tab: { left: 700, width: 100 } });
        render({ nodeType: 1, matches: () => false, querySelectorAll: () => [s] });
        assert.equal(s.scrollLeft, 600);
    });

    it('is right in RTL too: a negative distance moves it the other way', () => {
        const { render } = watched();
        const s = strip({ scrollWidth: 900, clientWidth: 300, box: { left: 600, width: 300 }, tab: { left: 100, width: 100 }, scrollLeft: -200 });
        render(s);
        assert.equal(s.scrollLeft, -200 + (150 - 750));
    });

    it('leaves alone a strip that fits, one with no current tab, and text nodes', () => {
        const { render } = watched();
        const fits = strip({ scrollWidth: 300, clientWidth: 300, box: { left: 0, width: 300 }, tab: { left: 200, width: 50 } });
        const none = strip({ scrollWidth: 900, clientWidth: 300, box: { left: 0, width: 300 }, tab: null });
        render(fits, none, { nodeType: 3 });
        assert.equal(fits.scrollLeft, 0);
        assert.equal(none.scrollLeft, 0);
    });

    it('moves a strip once: a later render elsewhere does not take it from a thumb that scrolled it', () => {
        const { render } = watched();
        const s = strip({ scrollWidth: 900, clientWidth: 300, box: { left: 0, width: 300 }, tab: { left: 700, width: 100 } });
        render(s);
        s.scrollLeft = 10; // the thumb
        render(s); // the same node reported again (a repaint inside it)
        assert.equal(s.scrollLeft, 10);
        // A strip drawn anew (a page repaint replaces the node) is revealed again.
        const fresh = strip({ scrollWidth: 900, clientWidth: 300, box: { left: 0, width: 300 }, tab: { left: 700, width: 100 } });
        render(fresh);
        assert.equal(fresh.scrollLeft, 600);
    });

    it('is switched on at boot, so every page gets it: App.init watches the page container', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /I18N\.applyStatic\(\);\s*UI\.watchTabStrips\(\);/);
    });
});

describe('Ads Results marks its tab current in every state', () => {
    const h = loadDashboard({ lang: 'en', files: PAGES });
    const R = h.run<Json>('AdsResultsPage');
    const current = (markup: unknown): string[] => [...String(markup).matchAll(/href="([^"]+)"\s+aria-current="page"/g)].map((m) => m[1]!);

    it('while it loads', () => {
        assert.deepEqual(current(R.skeleton()), ['#/ads_results']);
    });

    it('when it could not load', async () => {
        const page = h.el('page-container');
        h.ctx.API.getAdsResults = () => Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
        h.ctx.API.getAdsObjects = () => Promise.resolve({ items: [] });
        R.view = 'loading';
        await R.load();
        await settle();
        assert.equal(R.view, 'failed');
        assert.deepEqual(current(page.innerHTML), ['#/ads_results']);
    });

    it('and when it is ready, as before', () => {
        R.view = 'ready';
        R.data = { rows: [], totals: { byCurrency: {} }, currencies: [], objects: [] };
        assert.deepEqual(current(R.markup()), ['#/ads_results']);
    });
});
