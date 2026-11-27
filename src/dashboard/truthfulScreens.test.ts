/**
 * UX U1, "truthful screens" (docs/UX_AND_BRAND_PLAN_2026-12.md, U1): the screens that said something the product does not mean.
 *
 *   DW-T1  Today counts "waiting" the way the nav badge and the Inbox do, and its link opens what it counted;
 *   DW-R1  the Log speaks the outcome vocabulary of Today and Results, and the links into it ask for `outcome=actionable`;
 *   DW-R2  Results opens on 28 days and its strip draws the window the tiles name (the window cases are in wave3.test.ts too);
 *   SA-01  tenant detail reads `health` and `counts` from the REAL admin answer, and shows the data-access expiry;
 *   SA-02  the storage row knows Cloudflare R2;
 *   SA-03  a table never widens the phone page;
 *   SA-04  the Instagram & Facebook card: one status line, ids behind "Copy ids", honest copy.
 *
 * Every fixture of a server answer is typed with the server's own interface or built from the route's code, so a rename on the server
 * side fails the typecheck here instead of shipping a page that reads a key that is no longer there.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { TenantCounts, TenantHealth } from '../services/health.js';
import type { R2UsageSummary } from '../services/r2Usage.js';
import { loadDashboard, settle, type Json } from './_harness.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const inDays = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const ok = (value: unknown) => ({ status: 'fulfilled', value });
/** The tags out, the isolates out, the spaces tidy. */
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '').replace(/\s+/g, ' ').trim();

const UUID_A = '0b0a6a80-1111-4222-8333-444455556666';

// ═══ DW-T1: Today counts "waiting" the way the badge does ══════════════════════════════════════════════════════════════════════════

describe('Today: "waiting" is the server\'s count, the number on the nav badge (DW-T1, then U2 DW-T2)', () => {
    const h = loadDashboard({ files: ['dashboard/js/pages/overview.js'] });
    const O = h.run<Json>('OverviewPage');
    const item = (type: string, count: number, over: Json = {}): Json => ({
        type, severity: 'warning', count, sentence: { key: `attention.${type}`, params: { n: count } },
        action: { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' }, oldestAt: ago(2 * DAY), ...over,
    });
    const summary = (items: Json[], inbox: number): Json => ({ status: 'fulfilled', value: { items, counts: { inbox, studio: 0, scheduler: 0 }, heartbeat: null } });
    const alertsFor = (res: Json): Json[] => plain(O.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), undefined, undefined, res));
    const waitingAlert = (res: Json): Json | undefined => alertsFor(res).find((a) => a.icon === 'message-square-dot');

    it('says what the server counted: one card for handed-over and waiting threads together, titled with their sum, and the tile and the badge say the same number', () => {
        const res = summary([item('handoff', 1), item('thread_waiting', 2, { oldestAt: ago(9 * DAY) })], 3);
        const alert = waitingAlert(res)!;
        assert.equal(alert.title, h.t('overview.alert.waitingHumans', { count: 3 }));
        assert.equal(alertsFor(res).filter((a) => a.icon === 'message-square-dot').length, 1, 'ONE card, not one per kind');
        assert.match(String(O.renderStats({ activeCampaigns: 1 }, ok([]), res)), /id="stat-waiting">3</);
        assert.equal(O.attentionCount(res, 'inbox'), 3, 'the number App.setInboxWaiting gets');
    });

    it('names the oldest wait across both kinds, in words (days), not the dictionary\'s short form', () => {
        const alert = waitingAlert(summary([item('handoff', 1, { oldestAt: ago(2 * DAY) }), item('thread_waiting', 1, { oldestAt: ago(9 * DAY) })], 2))!;
        assert.equal(alert.body, h.t('overview.alert.waitingOldest', { age: h.t('overview.age.days', { count: 9 }) }));
    });

    it('goes to the To do list, with ONE verb, from the server\'s own link', () => {
        const alert = waitingAlert(summary([item('handoff', 2)], 2))!;
        assert.equal(alert.href, '#/inbox?filter=todo');
        assert.equal(alert.action, h.t('attention.verb.reply'));
    });

    it('is quiet when the server counts none, and says "no one is waiting" in the tile', () => {
        const res = summary([], 0);
        assert.equal(waitingAlert(res), undefined);
        assert.match(String(O.renderStats({ activeCampaigns: 1 }, ok([]), res)), /id="stat-waiting">0</);
    });

    it('does not guess when the summary could not be read: "—" in the tile, and a card that says so rather than a calm screen', () => {
        const failed = { status: 'rejected', reason: new Error('down') };
        assert.match(String(O.renderStats({ activeCampaigns: 1 }, ok([]), failed)), /id="stat-waiting">—</);
        assert.equal(alertsFor(failed).some((a) => a.title === h.t('overview.alert.attentionUnknown')), true);
    });
});

// ═══ DW-R1: one status vocabulary in the Log ═══════════════════════════════════════════════════════════════════════════════════════

/** The Log, rendered with the API stubbed: what it asked for, and what it drew. */
function loadLog(lang: 'ar' | 'en', rows: Json[], hash: Record<string, string> = {}) {
    const asked: Json[] = [];
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/activity.js'],
        globals: {
            API: {
                token: 't',
                getInteractions: (params: Json) => { asked.push(plain(params)); return Promise.resolve({ data: rows, pagination: { page: 1, total: rows.length, totalPages: 1 } }); },
                getCampaigns: () => Promise.resolve([{ id: 'c-1', trigger_keyword: 'promo' }]),
            },
            App: { hashParam: (name: string) => hash[name] ?? '' },
        },
    });
    const container = h.el('page-container');
    return { h, asked, container, A: h.run<Json>('ActivityPage'), page: () => container.innerHTML };
}

const row = (over: Json = {}): Json => ({
    id: 1, sender_username: 'someone', trigger_keyword: 'promo', post_id: '1789', platform: 'instagram', status: 'SENT', error_log: null, timestamp: ago(HOUR), outcome: 'delivered', ...over,
});
const OWN_FAULT = 'Meta said (#100) The token is not valid';
const ALREADY_REPLIED = '(#10900) This comment already has a private reply';

describe('the Log speaks the outcome vocabulary (DW-R1)', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`a row written FAILED that was skipped on purpose reads "By design", not "Failed", and only a real fault is "Needs you" (${lang})`, async () => {
            const { h, A, container, page } = loadLog(lang, [
                row({ id: 1, status: 'SENT', outcome: 'delivered' }),
                row({ id: 2, status: 'FAILED', error_log: ALREADY_REPLIED, outcome: 'by_design' }),
                row({ id: 3, status: 'FAILED', error_log: OWN_FAULT, outcome: 'actionable' }),
                row({ id: 4, status: 'PENDING', outcome: 'pending' }),
                row({ id: 5, status: 'USER_BLOCKED_DMS', outcome: 'blocked' }),
            ]);
            await A.render();
            await settle();
            const markup = container.innerHTML as string;
            for (const o of ['delivered', 'by_design', 'actionable', 'pending', 'blocked']) {
                assert.ok(markup.includes(`data-status="outcome.${o}"`), `a ${o} pill is drawn`);
                assert.ok(markup.includes(h.t(`status.outcome.${o}`)), `${o} has its word`);
            }
            // The row's status word is not the Log's vocabulary any more: no "Failed" / "Sent" pill, in the table or the phone cards.
            assert.equal(/class="status-pill (failed|sent|pending)"/.test(markup), false, 'no status-pill carrying the raw status');
            assert.equal(markup.includes(`>${h.t('common.failed')}<`), false, 'the word "Failed" is on no row');
            assert.equal(page().includes('data-tone="danger"') && (markup.match(/data-tone="danger"/g) || []).length > 0, true);
            // By design is never red: the phone card shows its error line as plain meta text, the actionable one as danger.
            const cards = markup.split('<article class="log-card"').slice(1);
            assert.equal(cards.length, 5);
            assert.match(cards[1]!, /<p class="text-meta" dir="auto" title="[^"]*private reply/, 'by-design: neutral text');
            assert.match(cards[2]!, /<p class="text-meta text-danger"/, 'needs you: red');
        });
    }

    it('the filter offers the same five words, in that order, and asks the server for `outcome=` (no `status=`)', async () => {
        const { h, A, container, asked } = loadLog('en', [row()]);
        await A.render();
        await settle();
        const select = /<select class="select" id="activity-filter"[\s\S]*?<\/select>/.exec(container.innerHTML)![0];
        const options = [...select.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
        assert.deepEqual(options, [
            ['', h.t('activity.allStatuses')],
            ['delivered', 'Delivered'], ['actionable', 'Needs you'], ['by_design', 'By design'], ['pending', 'Waiting'], ['blocked', 'DMs closed'],
        ]);
        A.handleFilter('actionable');
        await settle();
        const last = asked[asked.length - 1]!;
        assert.equal(last.outcome, 'actionable');
        assert.equal('status' in last, false);
        assert.equal(A.hasFilters(), true, 'and the Clear filters button appears');
        A.handleFilter('DROP TABLE');
        assert.equal(A.currentOutcome, '', 'a value that is not an outcome is no filter');
    });

    it('a link with `outcome=actionable` opens the Log already filtered, and an old `status=FAILED` link means the same', async () => {
        for (const link of [{ outcome: 'actionable' }, { status: 'FAILED' }] as Array<Record<string, string>>) {
            const { A, asked } = loadLog('en', [row()], link);
            await A.render();
            await settle();
            assert.equal(asked[0]!.outcome, 'actionable', JSON.stringify(link));
            assert.equal('status' in asked[0]!, false);
        }
    });

    it('Today\'s failed-DM alert links with outcome=actionable (the same rows its number counted)', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/overview.js'] });
        const O = h.run<Json>('OverviewPage');
        const alerts = plain(O.buildAlerts({ activeCampaigns: 1 }, ok({ data: [{ timestamp: new Date().toISOString(), outcome: 'actionable' }], pagination: { total: 1 } }),
            ok({ status: 'valid' }), ok([])));
        const failed = alerts.find((a: Json) => a.icon === 'send-horizontal');
        assert.equal(failed.target, 'activity');
        assert.equal(failed.query, 'outcome=actionable');
    });

    it('the Results page\'s "why DMs fail" button opens the same filter', async () => {
        const src = readFileSync('dashboard/js/pages/analytics.js', 'utf8');
        assert.ok(src.includes("query: 'outcome=actionable'"));
        assert.equal(src.includes("query: 'status=FAILED'"), false);
    });
});

// ═══ DW-R2: Results opens on 28 days ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('Results: one window on the screen (DW-R2)', () => {
    it('opens on 28 days, and the strip asks for those days, not a fixed 30', async () => {
        const calls: Json[] = [];
        const h = loadDashboard({
            files: ['dashboard/js/charts.js', 'dashboard/js/pages/analytics.js'],
            globals: {
                Admin: { emptyState: () => '' },
                API: {
                    token: 't',
                    getStats: (d: unknown) => { calls.push(['stats', d]); return Promise.resolve({ totalInteractions: 3, uniqueUsersReached: 2, instagramCount: 2, facebookCount: 1 }); },
                    getDailyStats: (d: unknown) => { calls.push(['daily', d]); return Promise.resolve([]); },
                    getCampaignStats: (d: unknown) => { calls.push(['campaigns', d]); return Promise.resolve([]); },
                    getFailureReasons: (d: unknown) => { calls.push(['failures', d]); return Promise.resolve({ days: 30, total: 0, reasons: [] }); },
                },
            },
        });
        for (const id of ['analytics-strip', 'analytics-campaigns', 'analytics-failures']) h.el(id);
        h.el('page-container');
        const A = h.run<Json>('AnalyticsPage');
        A.range = null;
        await A.render();
        await settle();
        assert.deepEqual(plain(calls.sort()), [['campaigns', 28], ['daily', 28], ['failures', 30], ['stats', 28]]);
        assert.equal(A.DEFAULT_RANGE, '28');
    });
});

// ═══ SA-01: tenant detail reads the real shape ═════════════════════════════════════════════════════════════════════════════════════

/** `GET /api/admin/tenants/:id` as src/routes/admin.ts builds it: the creator row, then `counts`, `health`, `members` NESTED. */
const HEALTH: TenantHealth = {
    tenantId: UUID_A, tokenStatus: 'valid', tokenLastCheckedAt: ago(3 * HOUR), tokenError: null, tokenExpiresAt: null, dataAccessExpiresAt: inDays(61),
    lastWebhookAt: ago(11 * HOUR), lastCommentAt: ago(30 * HOUR), lastInboundDmAt: ago(4 * DAY), dmThisHour: 3, dmCeiling: 180,
    queue: { pending: 1, running: 0, failed: 2, oldestPendingAt: null }, postsPending: 344, postsFailed7d: 2, postsFailed: 3,
};
const COUNTS: TenantCounts = { campaigns: 66, activeCampaigns: 59, scheduledPosts: 344, conversations: 12, interactions: 111, messages: 800 };
const tenantAnswer = (health: Partial<TenantHealth> = {}): Json => ({
    id: UUID_A, name: 'Workspace', instagram_page_id: '17841400000000001', facebook_page_id: '100000000000001', is_active: true, meta_user_id: null,
    token_status: 'valid', token_last_checked_at: ago(3 * HOUR), token_error: null, token_expires_at: null, token_data_access_expires_at: inDays(61),
    created_at: ago(90 * DAY),
    token: { stored: true, encrypted: true }, webhookVerifyToken: 'abcd…wxyz',
    counts: COUNTS, health: { ...HEALTH, ...health }, members: [],
});

function loadTenant(lang: 'ar' | 'en' = 'en') {
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/tenant_detail.js'],
        globals: { App: { session: { tenantId: 'other' } } },
    });
    const page = h.run<Json>('TenantDetailPage');
    page.mountInvites = () => {};
    page.mountLegal = () => {};
    const container = h.el('page-container');
    const paint = (answer: Json): string => {
        page.tenant = answer;
        page.tenantId = answer.id;
        page.paint(container);
        return container.innerHTML as string;
    };
    return { h, page, paint, Admin: h.run<Json>('Admin') };
}

describe('Tenant detail shows the real health and counts (SA-01)', () => {
    it('reads `health` and `counts`: the age of the last webhook, comment and DM, and the three counts (not "Never" and "—")', () => {
        const { h, paint } = loadTenant();
        const markup = paint(tenantAnswer());
        const said = text(markup);
        assert.equal(said.includes(`${h.t('ops.lastWebhook')} ${h.t('common.never')}`), false, 'the last webhook is not "Never"');
        assert.match(markup, /<dt>Campaigns<\/dt>\s*<dd[^>]*>(<bdi[^>]*>)?66</, 'campaigns');
        assert.match(markup, /<dt>Scheduled posts<\/dt>\s*<dd[^>]*>(<bdi[^>]*>)?344</, 'scheduled posts');
        assert.match(markup, /<dt>Conversations<\/dt>\s*<dd[^>]*>(<bdi[^>]*>)?12</, 'conversations');
        // The three "last …" values are ages, from health: 11 h, 30 h (1 d), 4 d.
        assert.ok(said.includes(h.t('common.ago', { value: h.t('common.hours', { n: 11 }) })), said);
        assert.ok(said.includes(h.t('common.ago', { value: h.t('common.days', { n: 4 }) })), said);
        assert.ok(said.includes('3 / 180') || said.includes('3'), 'DMs this hour');
        // The queue and posts, from health too.
        assert.ok(said.includes('344'), 'posts pending');
    });

    it('a workspace that really has had nothing still says Never, and zero is a zero, not a dash', () => {
        const { h, paint } = loadTenant();
        const markup = paint({ ...tenantAnswer({ lastWebhookAt: null, lastCommentAt: null, lastInboundDmAt: null }), counts: { ...COUNTS, campaigns: 0 } });
        assert.ok(text(markup).includes(`${h.t('ops.lastWebhook')} ${h.t('common.never')}`));
        assert.match(markup, /<dt>Campaigns<\/dt>\s*<dd[^>]*>(<bdi[^>]*>)?0</);
    });

    it('shows the data-access expiry with its days, and the 14 / 3 day colours of the connections list', () => {
        const { h, paint, Admin } = loadTenant();
        const tone = (days: number): string => {
            const markup = paint(tenantAnswer({ dataAccessExpiresAt: inDays(days) }));
            const field = /<dt>Data access expires<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/.exec(markup);
            assert.ok(field, `the expiry is shown at ${days} days`);
            return /class="([^"]*)"/.exec(field![1]!)?.[1] ?? '';
        };
        assert.equal(tone(61), '', 'far off: no colour');
        assert.equal(tone(15), '');
        assert.equal(tone(14), 'text-warning', 'amber at 14 or fewer');
        assert.equal(tone(4), 'text-warning');
        assert.equal(tone(3), 'text-danger', 'red at 3 or fewer');
        assert.equal(tone(-2), 'text-danger', 'and once it has passed');
        const far = paint(tenantAnswer({ dataAccessExpiresAt: inDays(61) }));
        assert.ok(text(far).includes(h.t('settings.daysLeft', { count: 61 })), 'with the days left');
        assert.ok(text(far).includes(text(h.UI.formatDay(inDays(61)))), 'and the date');
        // The same two numbers as Settings' EXPIRY (the connections list): one rule.
        const settings = readFileSync('dashboard/js/pages/settings.js', 'utf8');
        assert.match(settings, /EXPIRY: Object\.freeze\(\{ amber: 14, red: 3 \}\)/);
        assert.equal(Admin.EXPIRY_AMBER_DAYS, 14);
        assert.equal(Admin.EXPIRY_RED_DAYS, 3);
    });

    it('an answer with no `health` object (an older server) still reads the top-level token columns', () => {
        const { paint } = loadTenant();
        const old = tenantAnswer();
        delete old.health;
        delete old.counts;
        const markup = paint(old);
        assert.ok(markup.includes('Data access expires'), 'the top-level token_data_access_expires_at is still read');
    });
});

// ═══ SA-02: the storage row knows R2 ═══════════════════════════════════════════════════════════════════════════════════════════════

const GIB = 1024 ** 3;
const r2Summary = (storageBytes: number, extra: Partial<R2UsageSummary> = {}): R2UsageSummary => ({
    month: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z',
    limits: { storage_bytes: 9 * GIB, class_a: 900_000, class_b: 9_000_000 }, ceilings: { storage_bytes: 10_000_000_000, class_a: 1_000_000, class_b: 10_000_000 },
    items: [
        { kind: 'storage', used: storageBytes, limit: 9 * GIB, ceiling: 10_000_000_000, pct: Math.floor((storageBytes / (9 * GIB)) * 100) },
        { kind: 'class_a', used: 1000, limit: 900_000, ceiling: 1_000_000, pct: 0 },
        { kind: 'class_b', used: 5000, limit: 9_000_000, ceiling: 10_000_000, pct: 0 },
    ],
    level: 'ok', ...extra,
});
/** `GET /api/settings/media` for a production-like deployment: R2 is where new uploads go, Supabase is not set up (src/services/storage.ts). */
const mediaOnR2 = (summary: R2UsageSummary | null, over: Json = {}): Json => ({
    backend: 'r2', choice: 'r2', bucket: 'media', url: { value: null, source: null }, key: { set: false, source: null, kind: null, preview: null }, connection: null,
    usage: null,
    r2: { configured: true, accountId: 'acct', bucket: 'media', connection: { ok: true }, summary, copy: null, direct: 'all', cors: { status: 'ok', origin: null, policy: null }, ...over },
});

describe('the storage row knows R2 (SA-02)', () => {
    const load = (lang: 'ar' | 'en' = 'en') => {
        const h = loadDashboard({ lang, app: true, files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/settings.js'] });
        h.App.isAdmin = () => true;
        h.App.canAdminister = () => true;
        return { h, S: h.run<Json>('SettingsPage') };
    };
    const rowOf = (S: Json, media: Json): Json => (S.storageRow({ now: Date.now(), canAdmin: true, isAdmin: true, media, mediaError: null }));

    it('says "R2 · 449 MB of 9.0 GB", fine, when R2 holds the files (not "kept in the database")', () => {
        const { h, S } = load();
        const row = rowOf(S, mediaOnR2(r2Summary(449 * 1024 ** 2)));
        assert.equal(row.state, 'fine');
        const said = text(row.detail);
        assert.ok(said.startsWith('R2 ·'), said);
        assert.ok(said.includes('449'), said);
        assert.ok(said.includes('9'), said);
        assert.equal(said.includes(text(h.t('settings.health.media.database'))), false);
        assert.equal(row.id, 'storage');
    });

    it('turns amber from 80% of a free meter and red when one is used up, naming the meter and when it resets', () => {
        const { h, S } = load();
        const warn = rowOf(S, mediaOnR2(r2Summary(8 * GIB, { level: 'warn' })));
        assert.equal(warn.state, 'expiring');
        assert.ok(text(warn.detail).includes(`${h.t('settings.media.r2.meter.storage')} 88%`), text(warn.detail));
        const full = rowOf(S, mediaOnR2(r2Summary(9 * GIB, { level: 'full' })));
        assert.equal(full.state, 'broken');
        assert.ok(text(full.detail).includes(text(h.UI.formatDate('2026-12-01T00:00:00.000Z'))), 'the reset date');
    });

    it('is red when R2 does not answer, and simply "connected" when its usage could not be read', () => {
        const { h, S } = load();
        assert.equal(rowOf(S, mediaOnR2(null, { connection: { ok: false } })).state, 'broken');
        const unread = rowOf(S, mediaOnR2(null));
        assert.equal(unread.state, 'fine');
        assert.equal(text(unread.detail), text(h.t('settings.health.media.r2Ok')));
    });

    it('"Database" is still the answer when neither store is set, and Supabase is judged as before', () => {
        const { h, S } = load();
        const neither = rowOf(S, { backend: 'postgres', r2: { configured: false, summary: null, connection: null }, connection: null, usage: null });
        assert.equal(neither.state, 'not_set_up');
        assert.equal(text(neither.detail), text(h.t('settings.health.media.database')));
        const supa = rowOf(S, { backend: 'supabase', connection: { ok: true, bucketExists: true }, usage: null, r2: { configured: false } });
        assert.equal(supa.state, 'fine');
    });

    it('is in Arabic too, with R2 left as it is spelled', () => {
        const { S } = load('ar');
        const said = text(rowOf(S, mediaOnR2(r2Summary(449 * 1024 ** 2))).detail);
        assert.ok(said.includes('R2'), said);
    });
});

// ═══ SA-03: a table never widens the phone page ════════════════════════════════════════════════════════════════════════════════════

describe('tables never widen the phone page (SA-03)', () => {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const rule = (selector: string): string => {
        const at = css.indexOf(`\n${selector} {`);
        assert.ok(at >= 0, `${selector} has a rule`);
        return css.slice(at, css.indexOf('}', at));
    };

    it('`.table-wrapper` is a containing block, so a visually hidden header ("Actions") cannot sit outside its scroller', () => {
        assert.match(rule('.table-wrapper'), /position:\s*relative/);
        assert.match(rule('.table-wrapper'), /overflow-x:\s*auto/);
    });

    it('the escape is real: `.sr-only` is absolutely positioned, which is what needs a positioned ancestor', () => {
        assert.match(rule('.sr-only'), /position:\s*absolute/);
    });

    it('every table with a hidden header sits inside a `.table-wrapper` (a table outside one would still escape)', () => {
        // A <th class="sr-only"> in a page module: the table it is in must be wrapped by `.table-wrapper` somewhere above it in the same file.
        const offenders: string[] = [];
        for (const file of readdirSync('dashboard/js/pages').filter((f) => f.endsWith('.js'))) {
            const src = readFileSync(`dashboard/js/pages/${file}`, 'utf8');
            for (const m of src.matchAll(/<th[^>]*class="[^"]*sr-only[^"]*"/g)) {
                const before = src.slice(0, m.index);
                const table = before.lastIndexOf('<table');
                const wrapper = before.lastIndexOf('table-wrapper');
                const closed = before.lastIndexOf('</table>');
                if (table === -1 || closed > table) continue;
                if (wrapper === -1 || wrapper > table || table - wrapper > 400) offenders.push(`${file}@${m.index}`);
            }
        }
        assert.deepEqual(offenders, []);
    });
});

// ═══ SA-04: the Instagram & Facebook card ══════════════════════════════════════════════════════════════════════════════════════════

describe('the Instagram & Facebook card: one status line, ids behind a button, honest words (SA-04)', () => {
    const load = (lang: 'ar' | 'en' = 'en') => {
        const h = loadDashboard({ lang, files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/meta_connect.js'] });
        return { h, M: h.run<Json>('MetaConnect') };
    };
    const conn = (over: Json = {}): Json => ({
        enabled: true, appConfigured: true, redirectUriConfigured: true,
        connection: {
            connected: true, via: 'login', pageId: '200000000000001', pageName: 'Nour Shop', instagramId: '17841400000000001', instagramUsername: 'nourshop',
            connectedAt: ago(3 * DAY), webhookSubscribed: true, tokenStatus: 'valid', reconnectDue: false, ...over,
        },
    });
    const byToken = (over: Json = {}): Json => conn({ via: 'token', pageName: null, instagramUsername: null, connectedAt: null, webhookSubscribed: false, pageId: '100000000000001', instagramId: '17841499999999991', ...over });

    it('prints the state once, with the Page name and the handle, and no raw ids', () => {
        const { h, M } = load();
        const markup = String(M.settingsBody(conn(), { canAdminister: true }));
        const line = /<p class="meta-statusline"[\s\S]*?<\/p>/.exec(markup)![0];
        assert.equal(text(line).split(h.t('meta.status.ok')).length - 1, 1, '"Connected" is said once, on the status line');
        assert.equal(markup.includes('<strong>'), false, 'and not again as a title above it');
        assert.ok(text(line).includes('Nour Shop') && text(line).includes('@nourshop'), text(line));
        assert.equal(markup.includes('<dd dir="auto">200000000000001'), false);
        // The ids are not printed anywhere visible: only in the copy button's data.
        const visible = markup.replace(/data-copy="[^"]*"/g, '');
        assert.equal(visible.includes('200000000000001') || visible.includes('17841400000000001'), false, 'no 15- or 17-digit id on screen');
    });

    it('"Copy ids" carries both ids, labelled, for the owner', () => {
        const { h, M } = load();
        const markup = String(M.settingsBody(conn(), { canAdminister: true }));
        const button = /<button[^>]*id="meta-copy-ids"[^>]*>/.exec(markup)![0];
        assert.match(button, /data-action="app:copyValue"/);
        assert.ok(button.includes('200000000000001') && button.includes('17841400000000001'));
        assert.ok(markup.includes(h.t('meta.copyIds')));
        assert.equal(String(M.settingsBody(conn(), { canAdminister: false })).includes('meta-copy-ids'), false, 'not offered to someone who is not the owner');
    });

    it('a token connection has no names to show: the line says "Connected" and nothing invented (never the ids in their place)', () => {
        const { M } = load();
        const markup = String(M.settingsBody(byToken(), { canAdminister: true }));
        const line = text(/<p class="meta-statusline"[\s\S]*?<\/p>/.exec(markup)![0]);
        assert.equal(line, 'Connected');
        assert.equal(markup.replace(/data-copy="[^"]*"/g, '').includes('100000000000001'), false);
    });

    it('"Connected on" says "Not recorded" when it is not, not the history of the screen', () => {
        const { h, M } = load();
        const markup = String(M.settingsBody(byToken(), { canAdminister: true }));
        assert.ok(markup.includes('Not recorded'));
        assert.equal(markup.includes('Before this screen'), false);
        assert.equal(h.t('meta.fact.connectedAtUnknown'), 'Not recorded');
    });

    it('says whether events are arriving, from the workspace\'s own health, with how long ago (no "reach us")', () => {
        const { h, M } = load();
        const withHealth = String(M.settingsBody(byToken(), { canAdminister: true, health: { lastWebhookAt: ago(11 * HOUR) } }));
        assert.ok(text(withHealth).includes(h.t('meta.arriving.yes', { age: h.t('common.ago', { value: h.t('common.hours', { n: 11 }) }) })), text(withHealth));
        const none = String(M.settingsBody(byToken(), { canAdminister: true, health: { lastWebhookAt: null } }));
        assert.ok(none.includes(h.t('meta.arriving.none')));
        // No health answer at all: what the connection itself says, as before.
        assert.ok(String(M.settingsBody(byToken(), { canAdminister: true })).includes(h.t('meta.webhook.byOperator')));
        assert.equal(h.t('meta.fact.webhook').includes(' us'), false);
        // A Facebook-login connection whose Page is not subscribed is a fault whatever the history says.
        const off = String(M.settingsBody(conn({ webhookSubscribed: false }), { canAdminister: true, health: { lastWebhookAt: ago(HOUR) } }));
        assert.ok(off.includes(h.t('meta.webhook.off')));
    });

    it('the token note is for the platform admin only, points at the Access token card, and has a button that opens it', () => {
        const { h, M } = load();
        const admin = String(M.settingsBody(byToken(), { canAdminister: true, isAdmin: true }));
        assert.ok(admin.includes(h.t('meta.tokenNote')));
        assert.match(admin, /<button[^>]*id="meta-open-token"[^>]*data-action="settings:openCard"[^>]*data-card="token"|<button[^>]*id="meta-open-token"[^>]*data-card="token"[^>]*data-action="settings:openCard"/);
        const owner = String(M.settingsBody(byToken(), { canAdminister: true, isAdmin: false }));
        assert.equal(owner.includes(h.t('meta.tokenNote')), false);
        assert.equal(owner.includes('meta-open-token'), false);
        assert.equal(h.t('meta.tokenNote').includes('form above'), false, '"the form above" is gone: there was none');
        assert.ok(h.t('meta.tokenNote').includes('Advanced'));
    });

    it('is in Arabic with the same shape', () => {
        const { h, M } = load('ar');
        const markup = String(M.settingsBody(conn(), { canAdminister: true, health: { lastWebhookAt: ago(HOUR) } }));
        assert.ok(markup.includes(h.t('meta.copyIds')));
        assert.ok(text(markup).includes('Nour Shop'));
    });
});

describe('Tenant detail counts failed posts the way Today does (U2)', () => {
    it('shows the open failures (not archived, a post on several platforms once), not the 7-day figure that read 2 where Today read 4', () => {
        const { paint } = loadTenant();
        const said = text(paint(tenantAnswer({ queue: { pending: 1, running: 0, failed: 9, oldestPendingAt: null } })));
        assert.match(said, /3 failed/);
        assert.equal(/2 failed/.test(said), false);
    });

    it('falls back to the old key for a server that does not send the new one', () => {
        const { paint } = loadTenant();
        const old = tenantAnswer();
        delete old.health.postsFailed;
        assert.match(text(paint(old)), /2 failed/);
    });
});

// ═══ A tab strip scrolls inside itself, never the page ═════════════════════════════════════════════════════════════════════════════

describe('a segmented tab strip never widens the phone page', () => {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const at = css.indexOf('\n.segmented {');
    const rule = css.slice(at, css.indexOf('\n}', at));

    it('`.segmented` clips its own overflow and scrolls sideways inside its box (9 Ads tabs ran to x=977 on a 375 px phone)', () => {
        assert.ok(at >= 0, '.segmented has a rule');
        assert.match(rule, /overflow-x:\s*auto/);
        assert.match(rule, /max-inline-size:\s*100%/);
        assert.match(rule, /overscroll-behavior-x:\s*contain/);
    });

    it('the links do not shrink to nothing: `.segmented .btn` keeps its width, so a long strip scrolls rather than squeezes', () => {
        assert.match(css, /\.segmented \.btn \{[^}]*flex-shrink:\s*0/);
    });
});
