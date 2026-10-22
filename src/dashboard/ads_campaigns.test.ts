/**
 * Ads, phase A2: the Campaigns tab (`#/ads_campaigns`), the dashboard half (spec 002, T048).
 *
 * The REAL `ads_campaigns.js` (and `ads.js`, for the shared tab bar) in the shared `node:vm` harness, with the API stubbed to the A2 contract
 * (`GET /ads/objects`, `GET /ads/objects/:id`, the write routes that answer `{ op }`, `GET /ads/ops/:id`, `POST /ads/sync`):
 *
 *   - the tree renders campaign -> ad set -> ad, each with the status in words (the server's `effectiveLabel` key, translated), Meta's review
 *     reasons, the budget with the changes left this hour, and a badge for every queued change with when it is expected;
 *   - RESUME starts spending: it asks first, and only the answer "yes" sends `confirm: true`; a RAISE on a running object asks too, lowering does not;
 *   - DELETE is not offered (nor accepted) for an object that is ACTIVE; a viewer gets no change buttons, and only the owner gets "Refresh results";
 *   - the tab bar renders on both tabs; a 404 ADS_DISABLED is a calm panel without it;
 *   - a queued change is followed to its end and the row is read again; EDIT_LIMIT and RATE_LIMITED say when to try again.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
/** The Unicode isolates the page wraps names, times and money in are invisible: assertions read the words. */
const plain = (markup: unknown): string => text(markup).replace(/[⁦⁧⁨⁩]/g, '');

const SOON = new Date(Date.now() + 10 * 60_000).toISOString();

function view(over: Json): Json {
    return {
        id: 'x', level: 'campaign', metaId: '1', name: 'Object', origin: 'meta', status: 'ACTIVE', effectiveStatus: 'ACTIVE', effectiveLabel: 'ads.status.active',
        review: { reasons: [], learning: null }, objective: null, destinationType: null, optimizationGoal: null,
        budget: { kind: 'none', amount: null, currency: 'USD', editable: false, editsLeftThisHour: null },
        schedule: { start: null, end: null }, targetingSummary: null, creative: null, appMeta: {}, results: null, queued: [], parentId: null, syncedAt: '2026-10-22T09:30:00.000Z',
        ...over,
    };
}

const RUNNING = view({
    id: 'c1', name: 'Spring offer', metaId: '101',
    budget: { kind: 'daily', amount: 20, currency: 'USD', editable: true, editsLeftThisHour: 3 },
    results: { spend: 12.5, impressions: 900, reach: 700, linkClicks: 30, conversations: 4, costPerConversation: 3.125, results: 4, costPerResult: 3.125 },
    queued: [{ id: 'op-1', kind: 'budget', state: 'pending', objectKey: 'c1', notBefore: SOON, attempts: 0, result: null, createdAt: SOON, finishedAt: null, actorVia: 'owner' }],
});
const PAUSED = view({
    id: 'c2', name: 'Old promo', metaId: '102', status: 'PAUSED', effectiveStatus: 'PAUSED', effectiveLabel: 'ads.status.paused',
    budget: { kind: 'lifetime', amount: 300, currency: 'USD', editable: true, editsLeftThisHour: 4 },
});
const ADSET = view({
    id: 's1', level: 'adset', parentId: 'c1', name: 'Riyadh women 25-40', metaId: '201', status: 'ACTIVE', effectiveStatus: 'WITH_ISSUES', effectiveLabel: 'ads.status.with_issues',
    review: { reasons: ['The ad set targets too small an audience.'], learning: 'LEARNING_LIMITED' },
    budget: { kind: 'daily', amount: 10, currency: 'USD', editable: true, editsLeftThisHour: 0 },
});
const AD = view({
    id: 'a1', level: 'ad', parentId: 's1', name: 'Reel ad', metaId: '301', status: 'ACTIVE', effectiveStatus: 'DISAPPROVED', effectiveLabel: 'ads.status.disapproved',
    review: { reasons: ['The ad does not follow the advertising standards.'], learning: null },
});

interface Setup {
    items?: Json[];
    children?: Record<string, Json[]>;
    api?: Json;
    canOperate?: boolean;
    canAdminister?: boolean;
    lang?: 'ar' | 'en';
}

async function open(setup: Setup = {}) {
    const asked: Json[] = [];
    const toasts: Array<[string, string]> = [];
    const calls: Array<[string, unknown[]]> = [];
    // The page edits the objects it is given (a queued change is put on the row): each test gets its own copies, as each answer is its own JSON.
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const children: Record<string, Json[]> = clone(setup.children ?? { c1: [ADSET], s1: [AD] });
    const items: Json[] = clone(setup.items ?? [RUNNING, PAUSED]);
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const api: Json = {
        token: 't',
        getAdsObjects: record('getAdsObjects', async () => ({ items, syncedAt: '2026-10-22T09:30:00.000Z' })),
        getAdsObject: record('getAdsObject', async (id: string) => ({ object: [...items, ...Object.values(children).flat()].find((o) => o.id === id), children: children[id] ?? [], results: { daily: [], totals: {} } })),
        setAdsObjectStatus: record('setAdsObjectStatus', async () => ({ op: { id: 'op-9', kind: 'status', state: 'pending', notBefore: SOON } })),
        setAdsObjectBudget: record('setAdsObjectBudget', async () => ({ op: { id: 'op-8', kind: 'budget', state: 'pending', notBefore: SOON } })),
        archiveAdsObject: record('archiveAdsObject', async () => ({ op: { id: 'op-7', kind: 'archive', state: 'pending', notBefore: SOON } })),
        deleteAdsObject: record('deleteAdsObject', async () => ({ op: { id: 'op-6', kind: 'delete', state: 'pending', notBefore: SOON } })),
        getAdsOp: record('getAdsOp', async (id: string) => ({ op: { id, kind: 'status', state: 'pending', notBefore: SOON } })),
        requestAdsSync: record('requestAdsSync', async () => ({ queued: true, notBefore: SOON })),
        ...(setup.api ?? {}),
    };
    const h = loadDashboard({
        lang: setup.lang ?? 'en',
        files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads.js'],
        globals: {
            API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
            App: { canOperate: () => setup.canOperate !== false, canAdminister: () => setup.canAdminister !== false },
        },
    });
    h.UI.confirm = (options: Json) => { asked.push(options); };
    h.UI.toast = (message: string, type?: unknown) => { toasts.push([String(message), typeof type === 'string' ? type : 'success']); };
    h.UI.showModal = () => {};
    h.UI.closeModal = () => {};
    const container = h.el('page-container');
    const tree = h.el('ads-tree');
    h.el('ads-camp-help');
    const page: Json = h.run('AdsCampaignsPage');
    // Polling is real here (a stub answers it): fast, and always stopped at the end of the test.
    page.POLL_MS = 5;
    await page.render();
    await settle();
    const screen = (): string => `${container.innerHTML}${tree.innerHTML}`;
    return { h, page, container, tree, asked, toasts, calls, screen, called: (name: string) => calls.filter(([n]) => n === name) };
}

describe('Campaigns tab: the tree (T048)', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`renders campaign -> ad set -> ad with the translated status, the review reasons, the edits left and the queued change (${lang})`, async () => {
            const { h, page, tree, screen } = await open({ lang });
            try {
                assert.equal(h.el('ads-tree').id, 'ads-tree');
                const top = text(screen());
                assert.ok(top.includes('Spring offer') && top.includes('Old promo'), 'the campaigns');
                assert.ok(top.includes(h.t('ads.status.active')) && top.includes(h.t('ads.status.paused')), 'statuses in words');
                assert.ok(plain(screen()).includes(h.t('ads.camp.editsLeft', { count: 3 })), 'budget changes left this hour');
                assert.ok(plain(screen()).includes(h.t('ads.camp.editsLeft', { count: 4 })));

                // Opening a campaign reads its ad sets; opening an ad set reads its ads.
                page.toggle('c1');
                await settle();
                page.toggle('s1');
                await settle();
                const all = plain(`${screen()}${tree.innerHTML}`);
                assert.ok(all.includes('Riyadh women 25-40'), 'the ad set');
                assert.ok(all.includes('Reel ad'), 'the ad');
                assert.match(tree.innerHTML, /data-level="campaign"[\s\S]*data-level="adset"[\s\S]*data-level="ad"/, 'nested in that order');
                assert.ok(all.includes(h.t('ads.status.with_issues')), 'an ad set\'s own label');
                assert.ok(all.includes(h.t('ads.status.disapproved')), 'an ad\'s own label');
                assert.ok(all.includes('The ad set targets too small an audience.'), 'Meta\'s reasons for the ad set');
                assert.ok(all.includes('The ad does not follow the advertising standards.'), 'Meta\'s reasons for the ad');
                assert.ok(all.includes(h.t('ads.camp.learning.limited')), 'learning limited');
                assert.ok(all.includes(h.t('ads.camp.editsLeft', { count: 0 })), 'no changes left says so');
                assert.match(tree.innerHTML, /data-edits-left="0"/);
                assert.equal(/\bads\.[a-zA-Z.]+/.test(all), false, 'no raw key');
            } finally { page.destroy(); }
        });
    }

    it('a queued change is a badge with what, how far along, and when it is expected', async () => {
        const { h, page, screen } = await open();
        try {
            const html = screen();
            assert.match(html, /data-op-id="op-1"[^>]*data-op-state="pending"/);
            const said = plain(html);
            assert.ok(said.includes(`${h.t('ads.queue.kind.budget')} · ${h.t('ads.queue.state.pending')} · ${h.t('ads.queue.expected', { time: h.UI.formatTime(SOON) })}`), said);
            // While a change is on its way the row offers no second one.
            const row = (id: string): string => (new RegExp(`id="ads-node-${id}"[\\s\\S]*?</div>\\s*</div>\\s*</li>`).exec(html) || [''])[0];
            assert.equal(row('c1').includes('adscamp:pause'), false);
            assert.ok(html.includes('data-action="adscamp:resume"'), 'the other campaign can still be resumed');
        } finally { page.destroy(); }
    });

    it('every status Meta can say has words, and one it has not met is shown as Meta wrote it, never as a key', async () => {
        const known = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'WITH_ISSUES', 'IN_PROCESS', 'PENDING_BILLING_INFO', 'ARCHIVED', 'DELETED'];
        const { h, page } = await open({ items: [RUNNING] });
        try {
            for (const status of known) {
                const word = page.statusWord({ effectiveStatus: status, effectiveLabel: `ads.status.${status.toLowerCase()}` });
                assert.notEqual(word, `ads.status.${status.toLowerCase()}`, status);
                assert.equal(word.startsWith('ads.'), false, status);
            }
            assert.equal(h.t('ads.status.pending_billing_info'), 'Waiting for billing info');
            const odd = page.statusWord({ effectiveStatus: 'SOMETHING_NEW', effectiveLabel: 'ads.status.something_new' });
            assert.ok(odd.includes('SOMETHING_NEW') && !odd.startsWith('ads.'), odd);
            const unknown = page.statusWord({ effectiveStatus: 'FUTURE', effectiveLabel: 'ads.status.unknown' });
            assert.ok(unknown.includes('FUTURE'), unknown);
        } finally { page.destroy(); }
    });

    it('reads the stored copy only: one list, nothing else, and no call that could reach Meta from the page', async () => {
        const { called, page } = await open();
        try {
            assert.deepEqual(JSON.parse(JSON.stringify(called('getAdsObjects').map(([, args]) => args[0]))), [{ level: 'campaign' }]);
            assert.equal(called('requestAdsSync').length, 0);
        } finally { page.destroy(); }
    });

    it('last updated and the tax note are said; the help links go to the Ads article sections', async () => {
        const { h, screen, page } = await open();
        try {
            const html = screen();
            assert.ok(plain(html).includes(h.t('ads.camp.updated', { time: `⁦${h.UI.formatDateTime('2026-10-22T09:30:00.000Z')}⁩` }).replace(/[⁦⁩]/g, '')));
            assert.ok(text(html).includes(h.t('ads.tax.note')));
            assert.match(html, /href="#\/help\/ads#campaigns"/);
            assert.match(html, /href="#\/help\/ads#statuses"/);
            assert.match(html, /href="#\/help\/ads#queued-changes"/, 'shown while a change is queued');
        } finally { page.destroy(); }
    });

    it('with nothing queued the queued-changes help link is not offered', async () => {
        const { screen, page } = await open({ items: [PAUSED] });
        try {
            assert.equal(screen().includes('ads#queued-changes'), false);
        } finally { page.destroy(); }
    });
});

describe('Campaigns tab: the tab bar and the quiet panels (T048)', () => {
    it('the bar renders on the Campaigns tab (current) and on the Overview (current), each linking to the other', async () => {
        const { container, page } = await open();
        try {
            assert.match(container.innerHTML, /id="ads-tabs"/);
            assert.match(container.innerHTML, /href="#\/ads_campaigns"[^>]*aria-current="page"/);
            assert.match(container.innerHTML, /href="#\/ads"(?![^>]*aria-current)/);
        } finally { page.destroy(); }

        const h = loadDashboard({
            lang: 'en',
            files: ['dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads.js'],
            globals: {
                API: new Proxy({ token: 't', getAdsOverview: async () => ({ configured: false, steps: [{ id: 'token', done: false, hint: null }], money: null }) }, { get: (target: Json, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error('not stubbed'))) }),
                App: { canAdminister: () => true },
            },
        });
        const overview = h.el('page-container');
        const ads: Json = h.run('AdsPage');
        await ads.render();
        await settle();
        assert.match(overview.innerHTML, /id="ads-tabs"/);
        assert.match(overview.innerHTML, /href="#\/ads"[^>]*aria-current="page"/);
        assert.match(overview.innerHTML, /href="#\/ads_campaigns"(?![^>]*aria-current)/);
        assert.ok(text(overview.innerHTML).includes(h.t('ads.tabs.overview')) && text(overview.innerHTML).includes(h.t('ads.tabs.campaigns')));
    });

    it('a 404 ADS_DISABLED is the calm "not available" panel, a 403 the "owners only" one; neither has the bar nor an error', async () => {
        for (const status of [403, 404]) {
            const err: Json = Object.assign(new Error('nope'), { status, code: status === 404 ? 'ADS_DISABLED' : 'FORBIDDEN' });
            const { h, container, page } = await open({ api: { getAdsObjects: async () => { throw err; } } });
            try {
                assert.ok(text(container.innerHTML).includes(h.t(status === 404 ? 'ads.disabled.title' : 'ads.owner.title')), `status ${status}`);
                assert.equal(container.innerHTML.includes('id="ads-tabs"'), false);
                assert.equal(container.innerHTML.includes('inline-error'), false);
            } finally { page.destroy(); }
        }
    });

    it('a failed read is the error panel with a retry, not a silent empty list', async () => {
        const { h, page, container } = await open({ api: { getAdsObjects: async () => { throw new Error('boom'); } } });
        try {
            assert.equal(page.view, 'failed');
            assert.equal(text(container.innerHTML).includes(h.t('ads.camp.empty.title')), false);
        } finally { page.destroy(); }
    });

    it('no campaigns: an empty state that says what to do', async () => {
        const { h, screen, page } = await open({ items: [] });
        try {
            assert.ok(text(screen()).includes(h.t('ads.camp.empty.title')));
        } finally { page.destroy(); }
    });
});

describe('Campaigns tab: who sees which buttons (T048)', () => {
    it('the owner can pause, edit the budget, archive; resume, edit, archive and delete a paused one; and refresh results', async () => {
        const { h, screen, page } = await open();
        try {
            const html = screen();
            assert.match(html, /data-action="adscamp:resume"[^>]*data-id="c2"/);
            assert.match(html, /data-action="adscamp:editBudget"[^>]*data-id="c2"/);
            assert.match(html, /data-action="adscamp:archive"[^>]*data-id="c2"/);
            assert.match(html, /data-action="adscamp:remove"[^>]*data-id="c2"/);
            assert.match(html, /data-action="adscamp:sync"/);
            for (const key of ['ads.camp.act.resume', 'ads.camp.refreshResults']) assert.ok(text(html).includes(h.t(key)), key);
        } finally { page.destroy(); }
    });

    it('DELETE is not offered for an ACTIVE object, and is refused in the page if asked anyway', async () => {
        const { page, screen, asked } = await open({ items: [view({ id: 'c3', name: 'Live one', budget: { kind: 'daily', amount: 5, currency: 'USD', editable: true, editsLeftThisHour: 4 } }), PAUSED] });
        try {
            const html = screen();
            assert.equal(/data-action="adscamp:remove"[^>]*data-id="c3"/.test(html), false, 'no Delete on the running one');
            assert.match(html, /data-action="adscamp:pause"[^>]*data-id="c3"/, 'it can be paused');
            assert.match(html, /data-action="adscamp:remove"[^>]*data-id="c2"/, 'the paused one can be deleted');
            page.remove('c3');
            assert.equal(asked.length, 0, 'no question, no request');
        } finally { page.destroy(); }
    });

    it('archived and deleted objects offer nothing, and a deleted one is not listed', async () => {
        const archived = view({ id: 'c4', name: 'Old one', status: 'ARCHIVED', effectiveStatus: 'ARCHIVED', effectiveLabel: 'ads.status.archived' });
        const gone = view({ id: 'c5', name: 'Gone one', status: 'DELETED', effectiveStatus: 'DELETED', effectiveLabel: 'ads.status.deleted' });
        const { screen, page } = await open({ items: [archived, gone] });
        try {
            const html = screen();
            assert.ok(html.includes('Old one'));
            assert.equal(html.includes('Gone one'), false);
            assert.equal(/data-action="adscamp:(pause|resume|editBudget|archive|remove)"/.test(html), false, 'no action on the archived row');
        } finally { page.destroy(); }
    });

    it('a viewer gets no change buttons and no refresh, only the reading', async () => {
        const { screen, page } = await open({ canOperate: false, canAdminister: false });
        try {
            const html = screen();
            for (const action of ['pause', 'resume', 'editBudget', 'archive', 'remove', 'sync']) assert.equal(html.includes(`data-action="adscamp:${action}"`), false, action);
            assert.ok(html.includes('Spring offer'));
        } finally { page.destroy(); }
    });

    it('a member who may operate but is not the owner gets the change buttons and no refresh', async () => {
        const { screen, page } = await open({ canOperate: true, canAdminister: false });
        try {
            const html = screen();
            assert.match(html, /data-action="adscamp:resume"/);
            assert.equal(html.includes('data-action="adscamp:sync"'), false);
        } finally { page.destroy(); }
    });
});

describe('Campaigns tab: changes go through the queue (T048)', () => {
    it('RESUME asks first and sends status ACTIVE with confirm: true only after "yes"; the row then shows the queued change', async () => {
        const { h, page, asked, called, screen, toasts } = await open();
        try {
            page.resume('c2');
            assert.equal(called('setAdsObjectStatus').length, 0, 'nothing is sent before the question is answered');
            assert.equal(asked.length, 1);
            assert.ok(String(asked[0].body).includes('Old promo'));
            assert.ok(String(asked[0].hint).includes(h.t('ads.activate.hint')));
            await asked[0].onConfirm();
            assert.deepEqual(JSON.parse(JSON.stringify(called('setAdsObjectStatus').map(([, args]) => args))), [['c2', { status: 'ACTIVE', confirm: true }]]);
            assert.ok(toasts.some(([m, type]) => m === h.t('ads.camp.queued') && type === 'success'));
            assert.match(screen(), /data-op-id="op-9"[^>]*data-op-state="pending"/, 'the badge is on the row at once');
        } finally { page.destroy(); }
    });

    it('PAUSE is one click, with no confirm flag (it stops spending)', async () => {
        const { h, page, called } = await open({ items: [view({ id: 'c3', name: 'Live one', budget: { kind: 'daily', amount: 5, currency: 'USD', editable: true, editsLeftThisHour: 4 } })] });
        try {
            await page.pause(h.el('pause-btn', { dataset: { id: 'c3' } }));
            assert.deepEqual(JSON.parse(JSON.stringify(called('setAdsObjectStatus').map(([, args]) => args))), [['c3', { status: 'PAUSED' }]]);
        } finally { page.destroy(); }
    });

    it('a refusal while resuming is said inside the question, with the time when the server gives one', async () => {
        const err: Json = Object.assign(new Error('Meta says wait'), { status: 429, code: 'RATE_LIMITED', body: { retryAt: '2026-10-23T08:30:00.000Z' } });
        const { h, page, asked } = await open({ api: { setAdsObjectStatus: async () => { throw err; } } });
        try {
            page.resume('c2');
            await assert.rejects(asked[0].onConfirm(), (thrown: Error) => {
                assert.ok(thrown.message.includes(h.UI.formatTime('2026-10-23T08:30:00.000Z')), thrown.message);
                assert.equal(thrown.message.includes('Meta says wait'), false);
                return true;
            });
        } finally { page.destroy(); }
    });

    it('ARCHIVE asks first; DELETE asks its own question and sends confirm: true', async () => {
        const { page, asked, called } = await open();
        try {
            page.archive('c2');
            assert.equal(asked.length, 1);
            assert.equal(called('archiveAdsObject').length, 0);
            await asked[0].onConfirm();
            assert.deepEqual(called('archiveAdsObject').map(([, args]) => args[0]), ['c2']);

            page.remove('c2');
            assert.equal(asked.length, 2, 'a separate question');
            assert.equal(called('deleteAdsObject').length, 0);
            await asked[1].onConfirm();
            assert.deepEqual(JSON.parse(JSON.stringify(called('deleteAdsObject').map(([, args]) => args))), [['c2', { confirm: true }]]);
        } finally { page.destroy(); }
    });

    it('a queued change is followed: when it is done the badge goes, the person is told, and the row is read again', async () => {
        let polls = 0;
        const { page, h, called, toasts, screen } = await open({
            api: { getAdsOp: async (id: string) => { if (id !== 'op-9') return { op: { id, kind: 'budget', state: 'done' } }; polls++; return { op: { id, kind: 'status', state: polls > 1 ? 'done' : 'running', notBefore: SOON } }; } },
        });
        try {
            await page.resumeConfirmed('c2');
            assert.match(screen(), /data-op-id="op-9"/);
            await new Promise((resolve) => setTimeout(resolve, 80));
            await settle();
            assert.ok(polls >= 2, 'asked about it until it was over');
            assert.ok(toasts.some(([m, type]) => m === h.t('ads.camp.opDone', { kind: h.t('ads.queue.kind.status') }) && type === 'success'), JSON.stringify(toasts));
            assert.equal(screen().includes('data-op-id="op-9"'), false, 'the badge is gone ');
            assert.ok(called('getAdsObject').some(([, args]) => args[0] === 'c2'), 'the row was read again');
        } finally { page.destroy(); }
    });

    it('a change that failed says so, with the server\'s reason', async () => {
        const { page, h, toasts } = await open({
            api: { getAdsOp: async (id: string) => ({ op: { id, kind: 'status', state: 'failed', result: { message: 'The ad account has no payment method.' } } }) },
        });
        try {
            await page.resumeConfirmed('c2');
            await new Promise((resolve) => setTimeout(resolve, 60));
            await settle();
            assert.ok(toasts.some(([m, type]) => type === 'error' && m.includes('The ad account has no payment method.') && m.includes(h.t('ads.queue.kind.status'))), JSON.stringify(toasts));
        } finally { page.destroy(); }
    });

    it('changes already queued when the page opens are followed too (a rule\'s, an earlier visit\'s)', async () => {
        let asked = 0;
        const { page, called } = await open({ api: { getAdsOp: async () => { asked++; return { op: { id: 'op-1', kind: 'budget', state: 'done' } }; } } });
        try {
            await new Promise((resolve) => setTimeout(resolve, 60));
            await settle();
            assert.ok(asked >= 1);
            assert.ok(called('getAdsObject').some(([, args]) => args[0] === 'c1'));
        } finally { page.destroy(); }
    });
});

describe('Campaigns tab: the budget and the hourly limit (T048)', () => {
    const form = (h: Json, amount: string, end = '') => h.el('ads-edit-form', { elements: { amount: { value: amount }, end: { value: end } } });

    it('a RAISE on a running object asks first and sends confirm: true only after "yes"; lowering sends straight away', async () => {
        const { h, page, asked, called } = await open({ items: [view({ id: 'c3', name: 'Live one', budget: { kind: 'daily', amount: 20, currency: 'USD', editable: true, editsLeftThisHour: 4 } })] });
        try {
            h.el('ads-edit-error');
            page.editBudget('c3');
            await page.budgetSubmit(form(h, '35'), { preventDefault() {} });
            assert.equal(called('setAdsObjectBudget').length, 0, 'nothing is sent before the question is answered');
            assert.equal(asked.length, 1);
            assert.equal(asked[0].stack, true, 'drawn over the form');
            await asked[0].onConfirm();
            assert.deepEqual(JSON.parse(JSON.stringify(called('setAdsObjectBudget').map(([, args]) => args))), [['c3', { kind: 'daily', amount: 35, confirm: true }]]);

            page.editBudget('c3');
            await page.budgetSubmit(form(h, '10'), { preventDefault() {} });
            assert.equal(asked.length, 1, 'no question for a lower budget');
            assert.deepEqual(JSON.parse(JSON.stringify(called('setAdsObjectBudget')[1]?.[1])), ['c3', { kind: 'daily', amount: 10 }]);
        } finally { page.destroy(); }
    });

    it('the form says how many budget changes are left this hour', async () => {
        let shown = '';
        const { h, page } = await open();
        try {
            h.UI.showModal = (markup: unknown) => { shown = String(markup); };
            page.editBudget('c1');
            assert.ok(plain(shown).includes(h.t('ads.camp.editsLeft', { count: 3 })));
            assert.ok(plain(shown).includes(h.t('ads.camp.editsLimit')));
        } finally { page.destroy(); }
    });

    it('EDIT_LIMIT and RATE_LIMITED come back inside the form as a sentence with the time to try again', async () => {
        for (const code of ['EDIT_LIMIT', 'RATE_LIMITED']) {
            const err: Json = Object.assign(new Error('English from the server'), { status: 429, code, body: { code, retryAt: '2026-10-23T08:30:00.000Z' } });
            const { h, page } = await open({
                items: [view({ id: 'c3', name: 'Live one', status: 'PAUSED', effectiveStatus: 'PAUSED', budget: { kind: 'daily', amount: 20, currency: 'USD', editable: true, editsLeftThisHour: 0 } })],
                api: { setAdsObjectBudget: async () => { throw err; } },
            });
            try {
                const host = h.el('ads-edit-error');
                page.editBudget('c3');
                await page.budgetSubmit(form(h, '25'), { preventDefault() {} });
                const said = text(host.innerHTML);
                assert.ok(plain(host.innerHTML).includes(h.UI.formatTime('2026-10-23T08:30:00.000Z')), `${code}: ${said}`);
                assert.equal(said.includes('English from the server'), false, code);
            } finally { page.destroy(); }
        }
    });

    it('a blank or non-positive amount is refused in the page, before any request', async () => {
        const { h, page, called } = await open({ items: [PAUSED] });
        try {
            const host = h.el('ads-edit-error');
            page.editBudget('c2');
            for (const value of ['', '0', '-3']) {
                await page.budgetSubmit(form(h, value), { preventDefault() {} });
                assert.ok(text(host.innerHTML).includes(h.t('ads.err.amount')), `value "${value}"`);
            }
            assert.equal(called('setAdsObjectBudget').length, 0);
        } finally { page.destroy(); }
    });
});

describe('Campaigns tab: Refresh results (T048)', () => {
    it('asks the server to refresh and says it is on its way', async () => {
        const { h, page, called, toasts } = await open();
        try {
            await page.sync(h.el('sync-btn'));
            assert.equal(called('requestAdsSync').length, 1);
            assert.ok(toasts.some(([m, type]) => m === h.t('ads.camp.refreshAsked') && type === 'success'));
        } finally { page.destroy(); }
    });

    it('a 429 RATE_LIMITED says when the next refresh is possible, not the server\'s English', async () => {
        const err: Json = Object.assign(new Error('Too soon'), { status: 429, code: 'RATE_LIMITED', body: { retryAt: '2026-10-23T08:30:00.000Z' } });
        const { h, page, toasts } = await open({ api: { requestAdsSync: async () => { throw err; } } });
        try {
            await page.sync(h.el('sync-btn'));
            const message = toasts[toasts.length - 1]?.[0] ?? '';
            assert.ok(message.includes(h.UI.formatTime('2026-10-23T08:30:00.000Z')), message);
            assert.equal(message.includes('Too soon'), false);
        } finally { page.destroy(); }
    });
});

describe('the Campaigns tab title', () => {
    it('has its own page title in both languages, never the raw key (app.js `title(page)` is t(`nav.${page}`))', async () => {
        for (const lang of ['ar', 'en'] as const) {
            const h = await loadDashboard({ lang });
            assert.notEqual(h.t('nav.ads_campaigns'), 'nav.ads_campaigns', lang);
        }
    });
});
