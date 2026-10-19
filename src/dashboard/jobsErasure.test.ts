/**
 * Platform admin, "trust what every screen says" (UX overhaul, User Story 1; audit JB-01, JB-05, ER-01, ER-02, ER-03):
 * the Jobs screen's buttons and the erasure screen's preview.
 *
 * Both screens were telling the operator things that were false, at the two moments it matters most:
 *
 *   - Jobs offered Retry on a pending job and Cancel on a running or a failed one, which the server refuses with a 409 (it re-queues
 *     only a job that has STOPPED, failed or cancelled, and cancels only one that has not STARTED, pending). It offered nothing for a
 *     cancelled job, which is the one thing Retry can do. A refusal that got through printed the server's English in an Arabic page.
 *   - The erasure preview read the server's `sample` as an array when it is an OBJECT, so the safeguard it describes ("confirm this is
 *     the right person") never rendered and the operator erased from a count alone; it never said which workspaces hold the person's
 *     data although the erasure covers all of them; and any failure said "the deletion may have been partial" although the erasure is
 *     one transaction that deleted everything or nothing.
 *
 * Loaded the way the other dashboard suites load: the REAL shipped files (admin_common.js, jobs.js, erasure.js, the catalogues) in a
 * `node:vm` context through `_harness.ts`. `API` is a stub; nothing here touches a network or a database.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const FILES = ['dashboard/js/pages/admin_common.js','dashboard/js/pages/jobs.js', 'dashboard/js/pages/erasure.js'];

interface Loaded {
    h: Dashboard;
    Jobs: Json;
    Erasure: Json;
    api: Record<string, (...args: unknown[]) => Promise<unknown>>;
    calls: Record<string, unknown[][]>;
    toasts: Array<{ message: string; type: unknown }>;
}

/** The two pages in one context, with `API` and `UI.toast` replaced by recorders. */
function load(lang: 'ar' | 'en', handlers: Record<string, (...args: unknown[]) => unknown> = {}): Loaded {
    const calls: Record<string, unknown[][]> = {};
    const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const name of ['getAdminJobs', 'retryAdminJob', 'cancelAdminJob', 'previewErasure', 'executeErasure']) {
        calls[name] = [];
        api[name] = async (...args: unknown[]) => {
            calls[name]!.push(args);
            const handler = handlers[name];
            if (!handler) throw new Error(`API.${name} is not stubbed`);
            return handler(...args);
        };
    }
    const h = loadDashboard({
        lang,
        files: FILES,
        globals: { API: api, App: { session: { tenants: [] }, dropAdminAccess: () => {} } },
    });
    const toasts: Array<{ message: string; type: unknown }> = [];
    h.UI.toast = (message: string, type: unknown) => { toasts.push({ message, type }); return null; };
    return { h, Jobs: h.run('JobsPage'), Erasure: h.run('ErasurePage'), api, calls, toasts };
}

const text = (value: unknown): string => String(value);

/** The attributes of the first element in `markup` whose opening tag contains `needle`. */
function openingTag(markup: string, needle: string): string {
    const at = markup.indexOf(needle);
    assert.ok(at !== -1, `no element containing ${needle}`);
    const start = markup.lastIndexOf('<', at);
    return markup.slice(start, markup.indexOf('>', at) + 1);
}

const attr = (tag: string, name: string): string | null => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? m[1]! : null;
};

/** The element with this id: its opening tag and its text (the markup here has no nested elements inside the descriptions). */
function byId(markup: string, id: string): { tag: string; text: string } | null {
    const m = new RegExp(`<([a-z0-9]+)\\s[^>]*\\sid="${id}"[^>]*>([^<]*)</\\1>`).exec(markup);
    return m ? { tag: m[0].slice(0, m[0].indexOf('>') + 1), text: m[2]! } : null;
}

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const job = (status: string): Json => ({
    id: JOB_ID, kind: 'dm.process', status, attempts: 1, max_attempts: 3,
    run_after: '2026-10-19T10:00:00.000Z', last_error: null, tenant_key: '178414',
});

// ═══ Jobs ════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('Jobs: the buttons offer what the server will do (JB-01)', () => {
    const { Jobs } = load('en');
    /** What `POST /api/admin/jobs/:id/retry` and `/cancel` accept: admin.ts re-queues `failed` and `cancelled`, and cancels `pending`. */
    const SERVER: Record<string, { retry: boolean; cancel: boolean }> = {
        pending: { retry: false, cancel: true },
        running: { retry: false, cancel: false },
        failed: { retry: true, cancel: false },
        done: { retry: false, cancel: false },
        cancelled: { retry: true, cancel: false },
    };

    it('Retry is for a job that has stopped (failed or cancelled), Cancel for one that has not started (pending): nothing else', () => {
        for (const [status, allowed] of Object.entries(SERVER)) {
            assert.equal(Jobs.canRetry(Jobs.read(job(status))), allowed.retry, `retry on ${status}`);
            assert.equal(Jobs.canCancel(Jobs.read(job(status))), allowed.cancel, `cancel on ${status}`);
        }
    });

    it('a job whose status is blank or unknown gets neither button: a control that might be refused is not offered as available', () => {
        for (const status of ['', 'queued', 'FAILED?', undefined, null]) {
            const read = Jobs.read({ id: JOB_ID, kind: 'x', status });
            assert.equal(Jobs.canRetry(read), false, String(status));
            assert.equal(Jobs.canCancel(read), false, String(status));
        }
    });

    it('the rendered buttons are disabled exactly when the server would refuse, in the table row and on the card alike', () => {
        for (const [status, allowed] of Object.entries(SERVER)) {
            for (const markup of [text(Jobs.renderRow(job(status))), text(Jobs.renderCard(job(status)))]) {
                const retry = openingTag(markup, 'data-action="jobs:retry"');
                const cancel = openingTag(markup, 'data-action="jobs:confirmCancel"');
                assert.equal(/\sdisabled[\s>]/.test(retry), !allowed.retry, `${status}: retry button`);
                assert.equal(/\sdisabled[\s>]/.test(cancel), !allowed.cancel, `${status}: cancel button`);
            }
        }
    });
});

describe('Jobs: a disabled button says why (FR-009)', () => {
    for (const lang of ['en', 'ar'] as const) {
        const { h, Jobs } = load(lang);
        const t = h.t;

        it(`${lang}: its title is the reason, and aria-describedby points at a description holding the same sentence`, () => {
            for (const status of ['pending', 'running', 'failed', 'done', 'cancelled']) {
                const markup = text(Jobs.renderRow(job(status)));
                const retryOff = !Jobs.canRetry(Jobs.read(job(status)));
                const cancelOff = !Jobs.canCancel(Jobs.read(job(status)));
                for (const [verb, off, action] of [['retry', retryOff, 'jobs:retry'], ['cancel', cancelOff, 'jobs:confirmCancel']] as const) {
                    const tag = openingTag(markup, `data-action="${action}"`);
                    if (!off) {
                        assert.equal(attr(tag, 'aria-describedby'), null, `${status}: an enabled ${verb} button has nothing to explain`);
                        assert.equal(attr(tag, 'title'), t(`jobs.${verb}`), `${status}: an enabled ${verb} button keeps its name as the title`);
                        continue;
                    }
                    const title = attr(tag, 'title');
                    const describedBy = attr(tag, 'aria-describedby');
                    assert.ok(title && title !== t(`jobs.${verb}`), `${status}: the disabled ${verb} button's title is a reason, not its name`);
                    assert.ok(describedBy, `${status}: the disabled ${verb} button points at a description`);
                    const target = byId(markup, describedBy!);
                    assert.ok(target, `${status}: the description ${describedBy} exists in the same markup`);
                    assert.equal(target!.text, title, `${status}: title and description say the same thing`);
                }
            }
        });

        it(`${lang}: the reason names the state the job is in, not a generic refusal, for each state the server refuses`, () => {
            for (const [verb, statuses] of [['retry', ['pending', 'running', 'done']], ['cancel', ['running', 'done', 'failed', 'cancelled']]] as const) {
                const seen = new Set<string>();
                for (const status of statuses) {
                    const why = Jobs.whyOff(verb, Jobs.read(job(status)));
                    assert.equal(why, t(`jobs.${verb}Why.${status}`), `${verb} on ${status}`);
                    assert.notEqual(why, t(`jobs.${verb}Why.other`), `${verb} on ${status} is not the general rule`);
                    seen.add(why);
                }
                assert.equal(seen.size, statuses.length, `${verb}: each state has its own sentence`);
            }
            assert.equal(Jobs.whyOff('retry', Jobs.read(job('queued'))), t('jobs.retryWhy.other'), 'an unknown state gets the general rule');
        });
    }

    it('the card shows the reason as text, because a phone has no hover for a title; the table keeps it for assistive technology', () => {
        const { Jobs } = load('en');
        const card = text(Jobs.renderCard(job('running')));
        const row = text(Jobs.renderRow(job('running')));
        const cardRetry = byId(card, attr(openingTag(card, 'data-action="jobs:retry"'), 'aria-describedby')!)!;
        const rowRetry = byId(row, attr(openingTag(row, 'data-action="jobs:retry"'), 'aria-describedby')!)!;
        assert.match(cardRetry.tag, /class="text-meta"/, 'visible on the card');
        assert.match(rowRetry.tag, /class="sr-only"/, 'screen-reader only in the table, where a pointer has its title');
    });

    it('the table row and the card of one job never share an id: both are in the page and CSS shows one', () => {
        const { Jobs } = load('en');
        const ids = (markup: string): string[] => [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
        const row = ids(text(Jobs.renderRow(job('running'))));
        const card = ids(text(Jobs.renderCard(job('running'))));
        assert.ok(row.length > 0 && card.length > 0);
        assert.deepEqual(row.filter((id) => card.includes(id)), []);
        assert.equal(new Set(row).size, row.length, 'no repeats within the row');
    });

    it('the reasons are Arabic in the Arabic catalogue and say something the operator can act on', () => {
        const { h } = load('ar');
        for (const key of ['retryWhy.pending', 'retryWhy.running', 'retryWhy.done', 'retryWhy.other',
            'cancelWhy.running', 'cancelWhy.done', 'cancelWhy.failed', 'cancelWhy.cancelled', 'cancelWhy.other']) {
            assert.match(h.t(`jobs.${key}`), /[؀-ۿ]/, key);
        }
    });
});

describe('Jobs: a refusal that still gets through is said in the interface language (JB-05, FR-007)', () => {
    const refusal = (code: string, status: string, message: string): Json => Object.assign(new Error(message), {
        status: 409, code, params: { status }, body: { error: message, code, params: { status } },
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`${lang}: retrying a job that has not stopped toasts the translated sentence and its next step, never the server's English`, async () => {
            const english = 'That job is "running", not failed or cancelled — only a job that has stopped can be retried.';
            const { h, Jobs, toasts, calls } = load(lang, {
                retryAdminJob: () => { throw refusal('JOB_NOT_RETRYABLE', 'running', english); },
                getAdminJobs: () => ({ jobs: [job('running')], counts: {} }),
            });
            h.el('page-container');
            const button = { dataset: { id: JOB_ID }, disabled: false };
            await Jobs.retry(button);

            assert.equal(toasts.length, 1);
            assert.equal(toasts[0]!.type, 'error');
            assert.equal(toasts[0]!.message, `${h.t('errors.JOB_NOT_RETRYABLE')} ${h.t('errors.JOB_NOT_RETRYABLE.next')}`);
            assert.ok(!toasts[0]!.message.includes('only a job that has stopped'), 'no server English');
            assert.equal(button.disabled, false, 'the button is released');
            assert.equal(calls['getAdminJobs']!.length, 1, 'the list is reloaded: the page was stale, so show the job as it is now');
        });

        it(`${lang}: cancelling a job that has started toasts JOB_NOT_CANCELLABLE's sentence`, async () => {
            const { h, Jobs, toasts } = load(lang, {
                cancelAdminJob: () => { throw refusal('JOB_NOT_CANCELLABLE', 'done', 'That job is "done", not pending — only a job that has not started can be cancelled.'); },
                getAdminJobs: () => ({ jobs: [], counts: {} }),
            });
            h.el('page-container');
            await Jobs.cancel(JOB_ID);

            assert.equal(toasts.length, 1);
            assert.equal(toasts[0]!.message, `${h.t('errors.JOB_NOT_CANCELLABLE')} ${h.t('errors.JOB_NOT_CANCELLABLE.next')}`);
            assert.ok(!/only a job that has not started/.test(toasts[0]!.message));
        });
    }

    it('an uncoded failure (a 404 for a job that is gone, a 500) is this screen\'s own line, not the server\'s English', async () => {
        const { h, Jobs, toasts } = load('ar', {
            retryAdminJob: () => { throw Object.assign(new Error('Job not found.'), { status: 404 }); },
            cancelAdminJob: () => { throw Object.assign(new Error('Failed to cancel the job.'), { status: 500 }); },
            getAdminJobs: () => ({ jobs: [], counts: {} }),
        });
        h.el('page-container');
        await Jobs.retry({ dataset: { id: JOB_ID }, disabled: false });
        await Jobs.cancel(JOB_ID);

        assert.deepEqual(toasts.map((x) => x.message), [h.t('jobs.retryFailed'), h.t('jobs.cancelFailed')]);
    });

    it('no answer at all says so in the interface language (the API client has already translated it)', async () => {
        const translated = load('ar').h.t('http.network');
        const { h, Jobs, toasts } = load('ar', {
            retryAdminJob: () => { throw Object.assign(new Error(translated), { isNetworkError: true }); },
        });
        h.el('page-container');
        await Jobs.retry({ dataset: { id: JOB_ID }, disabled: false });

        assert.equal(toasts[0]!.message, h.t('http.network'));
    });

    it('a retry that works says so and reloads the list', async () => {
        const { h, Jobs, toasts, calls } = load('en', {
            retryAdminJob: () => ({ id: JOB_ID, status: 'pending' }),
            getAdminJobs: () => ({ jobs: [job('pending')], counts: {} }),
        });
        h.el('page-container');
        await Jobs.retry({ dataset: { id: JOB_ID }, disabled: false });

        assert.deepEqual(toasts.map((x) => [x.message, x.type]), [[h.t('jobs.retried'), undefined]]);
        assert.equal(calls['getAdminJobs']!.length, 1);
    });
});

// ═══ Erasure ═════════════════════════════════════════════════════════════════════════════════════════════════════════

const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BETA = 'aaaaaaaa-0000-4000-8000-000000000002';

/** What `previewErasure` (src/services/erasure.ts) returns for a person in two workspaces. `sample` is an OBJECT of metadata. */
function preview(over: Json = {}): Json {
    return {
        handle: 'sara',
        found: true,
        matched: { conversationIds: ['c1', 'c2'], usernames: ['sara', 'sara_official'], instagramUserIds: ['17841400000000001', 'sara'] },
        counts: { messages: 7, conversations: 2, interactions: 1, dmSendLog: 0 },
        byTenant: [
            { tenantId: ALPHA, name: 'Alpha Studio', rows: 6 },
            { tenantId: BETA, name: 'Beta Shop', rows: 3 },
            { tenantId: null, name: null, rows: 1 },
        ],
        ranges: {
            conversations: { first: '2026-01-02T08:00:00.000Z', last: '2026-05-06T08:00:00.000Z' },
            messages: { first: '2026-01-02T08:00:00.000Z', last: '2026-05-06T09:00:00.000Z' },
            interactions: { first: '2026-02-01T08:00:00.000Z', last: '2026-02-01T08:00:00.000Z' },
            dmSendLog: { first: null, last: null },
        },
        sample: {
            conversations: [
                { id: 'c1', creatorId: ALPHA, creatorName: 'Alpha Studio', instagramUserId: '17841400000000001', username: 'sara', lastMessageAt: '2026-05-06T08:00:00.000Z' },
                { id: 'c2', creatorId: BETA, creatorName: 'Beta Shop', instagramUserId: '17841400000000001', username: 'sara_official', lastMessageAt: '2026-03-04T08:00:00.000Z' },
            ],
            // Metadata only, as the server sends it. `text` is not a field the server sends; it is here to prove it would not be drawn.
            messages: [{ id: 'm1', direction: 'inbound', messageType: 'text', textLength: 42, hasRawPayload: true, createdAt: '2026-05-06T09:00:00.000Z', text: 'SECRET-MESSAGE-BODY' }],
            interactions: [{ id: 'i1', commentId: 'k1', postId: 'p1', status: 'SENT', platform: 'instagram', timestamp: '2026-02-01T08:00:00.000Z' }],
        },
        token: 'TOKEN-ONE.deadbeef',
        expiresAt: '2026-10-19T10:10:00.000Z',
        ...over,
    };
}

const rejection = (props: Json, message = 'server message'): Json => Object.assign(new Error(message), props);

/** Preview `sara` and hand back what the page drew. */
async function previewed(lang: 'ar' | 'en', first: Json, handlers: Record<string, (...args: unknown[]) => unknown> = {}, handle = 'sara') {
    const loaded = load(lang, { previewErasure: () => first, ...handlers });
    loaded.h.el('erasure-result');
    await loaded.Erasure.loadPreview(handle);
    return { ...loaded, host: loaded.h.el('erasure-result') };
}

describe('Erasure: the preview renders the server\'s object shape (ER-01, ER-02)', () => {
    it('matched usernames and Instagram IDs are drawn, as text', async () => {
        const { host } = await previewed('en', preview());
        for (const shown of ['@sara', '@sara_official', '17841400000000001']) {
            assert.ok(host.innerHTML.includes(shown), `${shown} is on the page`);
        }
    });

    /** The chips of the `<dd>` that follows the `<dt>` with this label. */
    const chipsUnder = (html: string, label: string): string[] => {
        const m = new RegExp(`<dt>${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`).exec(html);
        assert.ok(m, `no field ${label}`);
        return [...m![1]!.matchAll(/<bdi[^>]*>([^<]*)<\/bdi>/g)].map((c) => c[1]!);
    };

    it('the handle as typed is not listed as an Instagram ID (it is the query, not a match), and a numeric handle is not listed as a username', async () => {
        // The server puts the typed handle in BOTH lists, because the delete matches on it either way.
        const byName = await previewed('en', preview(), {}, 'sara');
        assert.deepEqual(chipsUnder(byName.host.innerHTML, 'Usernames'), ['@sara', '@sara_official']);
        assert.deepEqual(chipsUnder(byName.host.innerHTML, 'Instagram IDs'), ['17841400000000001']);

        const byId = await previewed('en', preview({
            matched: { conversationIds: ['c1'], usernames: ['17841400000000001', 'sara'], instagramUserIds: ['17841400000000001'] },
        }), {}, '17841400000000001');
        assert.deepEqual(chipsUnder(byId.host.innerHTML, 'Usernames'), ['@sara']);
        assert.deepEqual(chipsUnder(byId.host.innerHTML, 'Instagram IDs'), ['17841400000000001']);
    });

    it('a list with nothing resolved says so with a dash instead of an empty box', async () => {
        const { host } = await previewed('en', preview({ matched: { conversationIds: [], usernames: ['sara'], instagramUserIds: ['sara'] } }));
        assert.match(host.innerHTML, /<dt>Instagram IDs<\/dt>\s*<dd[^>]*><span class="text-meta">—<\/span><\/dd>/);
    });

    it('the workspaces that hold the person\'s data are named, with their row counts, including rows that belong to none', async () => {
        const { host, h } = await previewed('en', preview());
        const html = host.innerHTML;
        assert.ok(html.includes('Alpha Studio') && html.includes('Beta Shop'), 'both workspaces');
        assert.ok(html.includes(h.t('erasure.workspaceRows', { count: 6 })) && html.includes(h.t('erasure.workspaceRows', { count: 3 })));
        assert.ok(html.includes(h.t('erasure.workspaceUnknown')), 'legacy rows with no workspace are listed, not dropped');
        assert.ok(html.includes(h.t('erasure.workspacesScope')), 'the scope is stated: every workspace listed, not only the current one');
    });

    it('counts and the oldest and newest date are shown per data type, in a fixed order, with the human names of the tables', async () => {
        const { host, h } = await previewed('en', preview());
        const html = host.innerHTML;
        const rows = [...html.matchAll(/<tr data-type="(\w+)">([\s\S]*?)<\/tr>/g)].map((m) => ({ key: m[1]!, cells: [...m[2]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]!.replace(/<[^>]*>/g, '').trim()) }));

        assert.deepEqual(rows.map((r) => r.key), ['conversations', 'messages', 'interactions', 'dmSendLog']);
        assert.deepEqual(rows.map((r) => r.cells[0]), ['Conversations', 'Messages', 'Comments', 'Send log'], 'no raw table names such as dmSendLog');
        assert.deepEqual(rows.map((r) => r.cells[1]), ['2', '7', '1', '0']);

        const day = (iso: string) => h.UI.zoneFormat(iso, { year: 'numeric', month: 'short', day: 'numeric' });
        assert.deepEqual(rows[1]!.cells.slice(2), [day('2026-01-02T08:00:00.000Z'), day('2026-05-06T09:00:00.000Z')], 'messages: first and last');
        assert.deepEqual(rows[2]!.cells.slice(2), [day('2026-02-01T08:00:00.000Z'), day('2026-02-01T08:00:00.000Z')], 'one comment: same day twice');
        assert.deepEqual(rows[3]!.cells.slice(2), ['—', '—'], 'a type with no rows has no dates');
        assert.ok(html.includes(h.t('erasure.datesHint', { city: h.UI.zoneCity() })), 'the page says which zone the dates are in');
    });

    it('the total and the warning count every row the erasure will remove', async () => {
        const { host, h, h: { announcements } } = await previewed('en', preview());
        assert.ok(host.innerHTML.includes(h.t('erasure.warnTitle', { count: 10 })), '7 + 2 + 1 + 0');
        assert.ok(announcements.includes(h.t('erasure.warnTitle', { count: 10 })));
    });

    it('a few conversations are named with their workspace and last message date, and the page says when it shows only the latest', async () => {
        const { host, h } = await previewed('en', preview({ counts: { messages: 7, conversations: 12, interactions: 1, dmSendLog: 0 } }));
        const html = host.innerHTML;
        assert.ok(html.includes(h.t('erasure.conversationLast', { date: h.UI.zoneFormat('2026-05-06T08:00:00.000Z', { year: 'numeric', month: 'short', day: 'numeric' }) })));
        assert.ok(html.includes(h.t('erasure.conversationsShown', { shown: 2, total: 12 })));
    });

    it('no message text is ever drawn: not the one the server never sends, and not a legacy array of strings that would be someone\'s words', async () => {
        const object = await previewed('en', preview());
        assert.ok(!object.host.innerHTML.includes('SECRET-MESSAGE-BODY'));
        assert.ok(!object.host.innerHTML.includes('[object'), 'the object was not stringified as if it were a row');
        assert.ok(!object.host.innerHTML.includes('textLength'), 'raw metadata keys are not dumped as JSON');

        const legacy = await previewed('en', preview({ sample: ['SECRET-LINE-ONE', { text: 'SECRET-LINE-TWO' }] }));
        assert.ok(!legacy.host.innerHTML.includes('SECRET-LINE'), 'an array sample draws nothing');
        assert.ok(legacy.host.innerHTML.includes('@sara'), 'the rest of the preview is still there');
    });

    it('everything attacker-controlled is escaped: a handle, a username, an ID and a workspace name are text', async () => {
        const hostile = '<img src=x onerror=alert(1)>';
        const { host } = await previewed('en', preview({
            matched: { conversationIds: [], usernames: [hostile], instagramUserIds: [hostile] },
            byTenant: [{ tenantId: ALPHA, name: hostile, rows: 3 }],
            sample: { conversations: [{ id: 'c', creatorName: hostile, username: hostile, instagramUserId: hostile, lastMessageAt: null }], messages: [], interactions: [] },
        }));
        assert.ok(!host.innerHTML.includes('<img'), 'no tag survives');
        assert.ok(host.innerHTML.includes('&lt;img'), 'the text is there, escaped');
    });

    it('a long list of identifiers stops at a handful and says how many more', async () => {
        const ids = Array.from({ length: 20 }, (_, i) => `1784${String(i).padStart(4, '0')}`);
        const { host, h } = await previewed('en', preview({ matched: { conversationIds: [], usernames: ['sara'], instagramUserIds: ids } }));
        assert.ok(host.innerHTML.includes(ids[11]!) && !host.innerHTML.includes(ids[12]!));
        assert.ok(host.innerHTML.includes(h.t('erasure.matched.more', { count: 8 })));
    });

    it('the erase token lives in a JS variable and nowhere in the page, and the erase button is on only when there is one', async () => {
        const withToken = await previewed('en', preview());
        assert.equal(withToken.Erasure._token, 'TOKEN-ONE.deadbeef');
        assert.ok(!withToken.host.innerHTML.includes('TOKEN-ONE'));
        assert.ok(!/data-action="erasure:confirmErase"[^>]*disabled/.test(withToken.host.innerHTML));

        const without = await previewed('en', preview({ token: null }));
        assert.match(without.host.innerHTML, /data-action="erasure:confirmErase"[^>]*disabled/);
    });

    it('nothing matched is an empty answer, not a preview with a button', async () => {
        const { host, h } = await previewed('en', preview({
            found: false, counts: { messages: 0, conversations: 0, interactions: 0, dmSendLog: 0 }, byTenant: [], token: null,
        }));
        assert.ok(host.innerHTML.includes(h.t('erasure.noneTitle')));
        assert.ok(!host.innerHTML.includes('erasure:confirmErase'));
    });

    it('in Arabic it is the Arabic catalogue, with the same facts', async () => {
        const { host, h } = await previewed('ar', preview());
        for (const key of ['erasure.matchedTitle', 'erasure.workspacesTitle', 'erasure.type.messages', 'erasure.table.first']) {
            assert.ok(host.innerHTML.includes(h.t(key)), key);
        }
        assert.match(h.t('erasure.matchedTitle'), /[؀-ۿ]/);
        assert.ok(host.innerHTML.includes('Alpha Studio'));
    });
});

/** Run a confirmed erase: the preview has been drawn, the person typed the handle, and the request goes out. */
async function erased(lang: 'ar' | 'en', failure: Json | null, second: Json = preview({ token: 'TOKEN-TWO.cafebabe' })) {
    let previews = 0;
    const loaded = await previewed(lang, preview(), {
        previewErasure: () => (++previews === 1 ? preview() : second),
        executeErasure: () => { if (failure) throw failure; return { handle: 'sara', deleted: {}, auditId: 7 }; },
    });
    await loaded.Erasure.erase();
    await settle();
    return { ...loaded, previews: () => previews };
}

describe('Erasure: a failure says what happened (ER-03)', () => {
    const drifted = (): Json => rejection({
        status: 409, code: 'ERASURE_COUNTS_DRIFTED',
        body: { error: 'What this handle matches has changed since the preview', code: 'ERASURE_COUNTS_DRIFTED', expected: { messages: 7, conversations: 2, interactions: 1, dmSendLog: 0 }, actual: { messages: 9, conversations: 2, interactions: 1, dmSendLog: 0 } },
    }, 'What this handle matches has changed since the preview — a new message arrived. Nothing was deleted.');

    for (const lang of ['en', 'ar'] as const) {
        it(`${lang}: new data since the preview is told as "nothing was deleted" and the preview is redone by itself, once, with the new numbers`, async () => {
            const second = preview({ token: 'TOKEN-TWO.cafebabe', counts: { messages: 9, conversations: 2, interactions: 1, dmSendLog: 0 } });
            const { host, h, previews, Erasure } = await erased(lang, drifted(), second);
            const html = host.innerHTML;

            assert.equal(previews(), 2, 'the first preview and exactly one automatic re-preview');
            assert.ok(html.includes(h.t('errors.ERASURE_COUNTS_DRIFTED')), 'the catalogue sentence, with nothing deleted in it');
            assert.ok(html.includes(h.t('erasure.driftReview')));
            assert.ok(html.includes(h.t('erasure.driftChange', { before: '⁦10⁩', after: '⁦12⁩' })), 'the total went from 10 to 12');
            assert.ok(html.includes(h.t('erasure.warnTitle', { count: 12 })), 'the numbers on the page are the new ones');
            assert.equal(Erasure._token, 'TOKEN-TWO.cafebabe', 'a fresh token, not the spent one');
            assert.ok(!html.includes('What this handle matches has changed'), 'the server\'s English is not on the page');
            assert.ok(h.announcements.some((a: string) => a.includes(h.t('errors.ERASURE_COUNTS_DRIFTED'))));
        });
    }

    it('the drift notice belongs to the preview it explains: a preview the person asks for next starts without it', async () => {
        const { Erasure, host, h } = await erased('en', drifted());
        assert.ok(host.innerHTML.includes(h.t('erasure.driftReview')));
        await Erasure.loadPreview('sara');
        assert.ok(!host.innerHTML.includes(h.t('erasure.driftReview')));
        Erasure.cancelPreview();
        assert.equal(Erasure.notice, null);
    });

    it('a drift without a code (an older server) is still the 409 it is', async () => {
        const { host, h, previews } = await erased('en', rejection({ status: 409 }, 'counts changed'));
        assert.equal(previews(), 2);
        assert.ok(host.innerHTML.includes(h.t('errors.ERASURE_COUNTS_DRIFTED')));
    });

    for (const [code, status] of [['ERASURE_PREVIEW_EXPIRED', 400], ['ERASURE_TOKEN_INVALID', 400]] as const) {
        for (const lang of ['en', 'ar'] as const) {
            it(`${lang}: ${code} says the preview expired and offers Preview again; it does not preview by itself`, async () => {
                const { host, h, previews } = await erased(lang, rejection({ status, code }, 'That erasure token has expired.'));
                const html = host.innerHTML;

                assert.equal(previews(), 1, 'no automatic preview: the person decides');
                assert.ok(html.includes(h.t('erasure.expiredTitle')));
                assert.ok(html.includes(h.t(`errors.${code}`)), 'the catalogue sentence');
                assert.ok(html.includes('data-action="erasure:previewAgain"') && html.includes(h.t('erasure.previewAgain')));
                assert.ok(html.includes(h.t(`errors.${code}.next`)));
            });
        }
    }

    it('an expired token without a code (400, 410, 422) is the same answer', async () => {
        for (const status of [400, 410, 422]) {
            const { host, h } = await erased('en', rejection({ status }, 'no good'));
            assert.ok(host.innerHTML.includes(h.t('erasure.expiredTitle')), String(status));
        }
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`${lang}: any other refusal says nothing was deleted and that the erasure is all-or-nothing; the server's English is behind Details`, async () => {
            const { host, h } = await erased(lang, rejection({ status: 500 }, 'The erasure failed and nothing was deleted.'));
            const html = host.innerHTML;

            assert.ok(html.includes(h.t('erasure.nothingDeleted')));
            assert.ok(html.includes(h.t('erasure.eraseFailed')));
            assert.ok(html.includes('<details class="error-details">'), 'the raw text is folded away');
            assert.ok(html.indexOf('<details') < html.indexOf('The erasure failed and nothing was deleted.'), 'only inside the disclosure');
            assert.ok(html.includes('data-action="erasure:previewAgain"'));
        });
    }

    it('a refusal the catalogue knows (the audit log could not be written) says its own sentence', async () => {
        const { host, h } = await erased('en', rejection({ status: 500, code: 'ERASURE_AUDIT_FAILED' }, 'Apply migration v15'));
        assert.ok(host.innerHTML.includes(h.t('errors.ERASURE_AUDIT_FAILED')));
        assert.ok(host.innerHTML.includes(h.t('errors.ERASURE_AUDIT_FAILED.next')));
    });

    it('a failure never says the deletion may have been partial, in any catalogue string or any rendered failure', async () => {
        for (const lang of ['en', 'ar'] as const) {
            const { h } = load(lang);
            const strings = h.I18N.strings[lang] as Record<string, string>;
            for (const [key, value] of Object.entries(strings)) {
                if (!/^erasure\.|^errors\.ERASURE_/.test(key)) continue;
                assert.ok(!/partial|partly|جزئي/i.test(String(value)), `${lang} ${key}: ${value}`);
            }
        }
        for (const failure of [rejection({ status: 500 }), rejection({ status: 400, code: 'ERASURE_TOKEN_INVALID' }), rejection({ isNetworkError: true })]) {
            const { host } = await erased('en', failure);
            assert.ok(!/partial/i.test(host.innerHTML));
        }
    });

    it('no answer is not "nothing was deleted": the request may have run, so the page says it is not certain and how to find out', async () => {
        const cases: Json[] = [
            rejection({ isNetworkError: true }, 'network'),
            rejection({ status: 502 }, 'Bad gateway'),
            rejection({ status: 504 }, 'Gateway timeout'),
            rejection({ status: 200 }, 'the server answered but the body could not be read'),
        ];
        for (const failure of cases) {
            const { host, h } = await erased('en', failure);
            const html = host.innerHTML;
            assert.ok(html.includes(h.t('erasure.unknownTitle')), String(failure.status ?? 'network'));
            assert.ok(html.includes(h.t('erasure.unknownBody')));
            assert.ok(!html.includes(h.t('erasure.nothingDeleted')), 'it does not claim what it cannot know');
            assert.ok(html.includes('data-action="erasure:previewAgain"'), 'the preview is how the person finds out');
        }
    });

    it('an erase that worked but could not be drawn is not reported as a failed erase', async () => {
        // The try wraps the request and nothing else: a rendering error after a 200 must not be read as "nothing was deleted".
        const loaded = await previewed('en', preview(), { executeErasure: () => ({ handle: 'sara', deleted: { messages: 7 }, auditId: 9 }) });
        loaded.Erasure.paintResult = () => { throw new Error('render bug'); };
        loaded.h.el('erasure-result');

        await assert.rejects(() => loaded.Erasure.erase(), /render bug/);
        assert.ok(!loaded.h.el('erasure-result').innerHTML.includes(loaded.h.t('erasure.nothingDeleted')));
        assert.equal(loaded.Erasure._token, null, 'and the token stays spent');
    });

    it('a successful erase is reported as one, with the notice cleared', async () => {
        const { host, h, toasts, Erasure } = await erased('en', null);
        assert.ok(host.innerHTML.includes(h.t('erasure.resultTitle')));
        assert.deepEqual(toasts.map((x) => x.message), [h.t('erasure.done', { handle: 'sara' })]);
        assert.equal(Erasure.notice, null);
    });

    it('the token is spent by the first press, whatever happens: a second erase has nothing to send', async () => {
        const { Erasure, calls } = await erased('en', rejection({ status: 500 }));
        const before = calls['executeErasure']!.length;
        await Erasure.erase();
        assert.equal(calls['executeErasure']!.length, before, 'no second request without a new preview');
    });
});

describe('Erasure and Jobs: every string the two screens use exists in both languages', () => {
    it('no key the pages read is missing from either catalogue', () => {
        const source = ['dashboard/js/pages/jobs.js', 'dashboard/js/pages/erasure.js'];
        for (const lang of ['en', 'ar'] as const) {
            const { h } = load(lang);
            const strings = h.I18N.strings[lang] as Record<string, string>;
            const missing: string[] = [];
            for (const file of source) {
                const code = readFileSync(file, 'utf8');
                for (const m of code.matchAll(/\bt\('((?:jobs|erasure)\.[\w.]+)'/g)) {
                    const key = m[1]!;
                    const has = key in strings || Object.keys(strings).some((k) => k.startsWith(`${key}_`));
                    if (!has) missing.push(`${lang}: ${key}`);
                }
            }
            assert.deepEqual(missing, []);
        }
    });
});
