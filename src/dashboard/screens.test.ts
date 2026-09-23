/**
 * The operator screens' logic, as opposed to their markup.
 *
 * Four things in `dashboard/js/pages/` decide something rather than render
 * something, and each one is a claim the product makes that a screenshot cannot
 * check:
 *
 * 1. `PostsPage.publishWindow` — WHEN a scheduled post goes out. This is the
 *    number the operator plans their day around, and it has been wrong twice in
 *    opposite directions: first the minute picker promised precision the daily
 *    cron could not keep, then a "publishes within ~15 minutes" written from
 *    FLOWS.md's description of a drain schedule that has never actually run.
 *    Nothing caught either, because a plausible timestamp looks exactly like a
 *    correct one. The second was the worse mistake — an optimistic answer makes
 *    the operator watch a window lapse and conclude the product is broken — and
 *    it came from reading documented intent as measured behaviour.
 *
 * 2. `ActivityPage.hasFilters` — whether zero rows means "nothing happened" or
 *    "your own filter is hiding it". The two render different copy and only one
 *    of them offers a way out, so the predicate is the whole distinction.
 *
 * 3. `InboxPage.resetViewState` — which fields survive leaving the screen. The
 *    bug this replaces was one field missing from one of three hand-copied
 *    lists, which is the failure mode a list has.
 *
 * 4. `AiSettingsPage.loadSettings` — whether Save is usable after a failed load
 *    and a successful retry. It was not: the failure path disabled the button
 *    and no path ever turned it back on.
 *
 * Loaded the same way as escaping.test.ts, charts.test.ts and buttons.test.ts:
 * the REAL dashboard files in a `node:vm` context, so these test what ships.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

interface PublishWindow { isPast: boolean; from: Date; until: Date; frequent: boolean }

interface PostsApi {
    FREQUENT_SWEEP: boolean;
    FREQUENT_SWEEP_LAG_MS: number;
    sweepLagMinutes(): number;
    publishWindow(iso: unknown, now?: number): PublishWindow | null;
    publishWindowText(win: PublishWindow | null): string;
    scheduleNoteText(localValue: string): string;
    renderScheduledCard(post: Record<string, unknown>): { toString(): string };
    platformBadge(platform: unknown): { cls: string; icon: string; label: string };
    tiktokRowOf(result: unknown): Record<string, unknown> | null;
    tiktokOutcomeText(status: string): string;
    tiktok: unknown;
    tiktokReady(): boolean;
}

interface ActivityApi {
    currentStatus: string;
    currentSearch: string;
    currentPlatform: string;
    currentCampaignId: string;
    currentPage: number;
    hasFilters(): boolean;
    clearFilters(): void;
    loadData(container?: unknown): unknown;
}

interface InboxApi {
    searchTerm: string;
    threads: unknown[];
    selectedConversationId: string | null;
    messagesPainted: boolean;
    lastMessageStamp: string | null;
    pendingBotState: Map<unknown, unknown>;
    renderedMessageIds: Set<unknown>;
    resetViewState(): void;
    destroy(): void;
    resetTenantState(): void;
    visibleThreads(): Array<Record<string, unknown>>;
}

interface AiApi {
    loadSettings(): Promise<void>;
}

interface FakeEl {
    id: string;
    value: string;
    checked: boolean;
    disabled: boolean;
    innerHTML: string;
    textContent: string;
    classList: { toggle(name: string, on?: boolean): void; add(n: string): void; remove(n: string): void; contains(): boolean };
    setAttribute(n: string, v: string): void;
    removeAttribute(n: string): void;
    getAttribute(n: string): string | null;
    focus(): void;
    // `UI.renderError` writes into the host and then looks for its own Retry
    // button, so an element that cannot be queried is not a usable stub.
    querySelector(): null;
    querySelectorAll(): never[];
}

function fakeEl(id: string): FakeEl {
    const attrs = new Map<string, string>();
    return {
        id,
        value: '',
        checked: false,
        disabled: false,
        innerHTML: '',
        textContent: '',
        classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
        setAttribute: (n, v) => { attrs.set(n, String(v)); },
        removeAttribute: (n) => { attrs.delete(n); },
        getAttribute: (n) => (attrs.has(n) ? (attrs.get(n) as string) : null),
        focus: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

interface UiApi {
    formatDateTime(iso: unknown): string;
    fromLocalInputValue(value: string): string | null;
    toLocalInputValue(iso: unknown): string;
}

/** The page's own local-time parser, so the test cannot disagree with it. */
function vmFromLocal(UI: UiApi, local: string): string | null {
    return UI.fromLocalInputValue(local);
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface Loaded {
    Posts: PostsApi;
    UI: UiApi;
    t: Translate;
    Activity: ActivityApi;
    Inbox: InboxApi;
    Ai: AiApi;
    dom: Map<string, FakeEl>;
    /** Stubbed API responses, per method name. */
    api: Record<string, (...args: unknown[]) => unknown>;
    /** Every loadData() call the page made, so a re-fetch is observable. */
    loads: number[];
}

function load(): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const stubEl = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null,
        removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const api: Record<string, (...args: unknown[]) => unknown> = {};

    const ctx: Record<string, unknown> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang: 'ar', dir: 'rtl' },
            getElementById: (id: string) => dom.get(id) ?? null,
            activeElement: null,
            visibilityState: 'visible',
        },
        window: {
            addEventListener: noop, removeEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location: { hash: '' },
        },
        Intl, console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: 'ar' },
        CSS: { escape: (v: string) => String(v) },
        // The pages reach for these; none is under test here.
        API: new Proxy(api, {
            get: (target, prop: string) => (prop in target
                ? target[prop]
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: () => '', confirm: noop },
        App: { currentTheme: () => 'auto', navigate: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js',
        'dashboard/js/motion.js',
        'dashboard/js/charts.js',
        'dashboard/js/pages/posts.js',
        'dashboard/js/pages/activity.js',
        'dashboard/js/pages/inbox.js',
        'dashboard/js/pages/ai_settings.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }

    const { PostsPage, ActivityPage, InboxPage, AiSettingsPage, UI, t } = vm.runInContext(
        '({ PostsPage, ActivityPage, InboxPage, AiSettingsPage, UI, t })', ctx
    ) as {
        PostsPage: PostsApi; ActivityPage: ActivityApi; InboxPage: InboxApi;
        AiSettingsPage: AiApi; UI: UiApi; t: Translate;
    };

    // loadData() writes markup and is not what these tests are about; the FACT
    // that it was called is.
    const loads: number[] = [];
    ActivityPage.loadData = (): unknown => { loads.push(ActivityPage.currentPage); return undefined; };

    return { Posts: PostsPage, UI, t, Activity: ActivityPage, Inbox: InboxPage, Ai: AiSettingsPage, dom, api, loads };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('PostsPage.publishWindow — when a scheduled post actually goes out', () => {
    const { Posts } = load();
    // A fixed clock. Real `Date.now()` in an assertion about a time window is
    // how a test passes at 09:00 and fails at midnight.
    const NOW = Date.parse('2026-09-22T09:00:00.000Z');

    // The daily cron is now the FALLBACK, not the live regime — it is what runs
    // if the worker is scaled back to zero. These tests still have to hold, so
    // they ask for that regime rather than inheriting whatever the module ships.
    const dailyRegime = (): { Posts: Loaded['Posts'] } => {
        const { Posts: P } = load();
        P.FREQUENT_SWEEP = false;
        return { Posts: P };
    };

    it('is in the FREQUENT regime, because a 60s worker is now measurably running', () => {
        // The load-bearing assertion in this file, and it has been both values.
        //
        // `publishDuePosts()` has two callers: `GET /api/jobs/drain` and the
        // Vercel cron at 00:00 UTC. For a long time only the daily one ran —
        // the GitHub Actions schedule backing the first has never produced a
        // single successful run — so this was `false`, and it was correct.
        //
        // On 2026-09-22 the Heroku worker was scaled to 1. It polls
        // `/api/jobs/drain` every 60s, which is the caller that sweeps posts.
        // Proven, not assumed: three probe jobs inserted directly into the
        // queue were claimed after 15s, 26s and 61s — the 0-60s spread a 60s
        // poll produces depending on where the insert lands in its cycle.
        //
        // Flip back to `false` if `heroku ps:scale worker=0` is ever run. The
        // earlier mistake was flipping this to `true` from FLOWS.md describing
        // the INTENT; measure the sweep, do not read about it.
        assert.equal(Posts.FREQUENT_SWEEP, true);
        assert.equal(Posts.FREQUENT_SWEEP_LAG_MS, 5 * 60 * 1000);
    });

    it('a future time publishes at the next 00:00 UTC, not at that time', () => {
        const { Posts } = dailyRegime();
        const win = Posts.publishWindow('2026-09-22T14:35:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.isPast, false);
        assert.equal(win.frequent, false);
        assert.equal(win.from.toISOString(), '2026-09-23T00:00:00.000Z');
    });

    it('a time before midnight still waits for the NEXT midnight, not the last one', () => {
        // 23:59 on the 22nd publishes on the 23rd's run, not the 22nd's, which
        // has already happened. `UI.nextCronRun` is strict about this and the
        // screen depends on it.
        const { Posts } = dailyRegime();
        const win = Posts.publishWindow('2026-09-22T23:59:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.from.toISOString(), '2026-09-23T00:00:00.000Z');
    });

    it('collapses the window to an instant, because a daily cron has no spread', () => {
        const { Posts } = dailyRegime();
        const win = Posts.publishWindow('2026-09-22T14:35:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.until.getTime(), win.from.getTime());
    });

    it('counts an overdue post from NOW, not from the time that has passed', () => {
        // A run that happened yesterday tells the operator nothing about when
        // the post in front of them will go out.
        const { Posts } = dailyRegime();
        const win = Posts.publishWindow('2026-09-20T08:00:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.isPast, true);
        assert.equal(win.from.toISOString(), '2026-09-23T00:00:00.000Z');
    });

    it('switches regime, and only the regime, when FREQUENT_SWEEP flips', () => {
        // The flip has to be one line. This asserts that it is: the same input,
        // the same function, a different claim — with the 15-minute tail being
        // the slow end of "every ~5-15 minutes" rather than the flattering end.
        const { Posts: P } = load();

        // Live regime: the post goes out at about the time asked for, plus a tail.
        const win = P.publishWindow('2026-09-22T14:35:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.frequent, true);
        assert.equal(win.from.toISOString(), '2026-09-22T14:35:00.000Z');
        assert.equal(win.until.getTime() - win.from.getTime(), 5 * 60 * 1000);

        // Fallback regime: the same input, the same function, a different claim.
        P.FREQUENT_SWEEP = false;
        const daily = P.publishWindow('2026-09-22T14:35:00.000Z', NOW);
        assert.ok(daily);
        assert.equal(daily.frequent, false);
        assert.equal(daily.from.toISOString(), '2026-09-23T00:00:00.000Z');
        assert.equal(daily.until.getTime(), daily.from.getTime());

        // An overdue post is recognised as past in BOTH regimes, and in both it
        // is measured forward from NOW rather than from the time that lapsed.
        // Where it lands still differs, and that difference is the regime:
        // frequent publishes on the next sweep, i.e. now; daily waits for the
        // next 00:00 UTC. Asserting NOW for both was wrong, and the daily branch
        // caught it.
        for (const [frequent, expectedFrom] of [
            [true, NOW],
            [false, Date.parse('2026-09-23T00:00:00.000Z')],
        ] as [boolean, number][]) {
            P.FREQUENT_SWEEP = frequent;
            const late = P.publishWindow('2026-09-20T08:00:00.000Z', NOW);
            assert.ok(late);
            assert.equal(late.isPast, true, `overdue must be past when frequent=${frequent}`);
            assert.equal(late.from.getTime(), expectedFrom, `overdue lands wrong when frequent=${frequent}`);
        }
    });

    it('treats the current instant as past, so it is never a window of zero', () => {
        const win = Posts.publishWindow(new Date(NOW).toISOString(), NOW);
        assert.ok(win);
        assert.equal(win.isPast, true);
    });

    it('the queue card and the form field say the same thing about the same post', () => {
        // They did not. `scheduleNoteText` was corrected to the daily reality
        // while `renderScheduledCard` kept its own copy of the branch and went
        // on promising "within about 15 minutes" for the very same post — two
        // answers, one screen. Both now go through `publishWindowText`, and this
        // is what stops them drifting apart again.
        const { Posts: P, UI } = load();
        const iso = '2027-03-04T18:20:00.000Z';
        const win = P.publishWindow(iso, NOW);
        assert.ok(win);

        // The REAL card markup, not the shared helper called twice — asserting
        // `publishWindowText` agrees with itself is what the first version of
        // this test did, and a card that had gone back to building its own
        // sentence sailed straight through it.
        const card = String(P.renderScheduledCard({
            id: 9, platform: 'instagram', post_type: 'image', status: 'PENDING',
            scheduled_time: iso, caption: 'c',
        }));
        const fieldText = P.scheduleNoteText(UI.toLocalInputValue(iso));

        assert.ok(fieldText.length > 0);
        assert.ok(
            card.includes(fieldText),
            `the card does not carry the sentence the form field shows.\n  field: ${fieldText}`
        );
    });

    it('returns null rather than an Invalid Date for anything unparseable', () => {
        // The caller renders this straight into the form. `Invalid Date` reaching
        // Intl throws inside a template literal, which is past the try/catch and
        // blanks the modal — the exact shape of the pagination crash in
        // activity.js that this project has already been bitten by.
        for (const bad of [null, undefined, '', 'not a date', {}]) {
            assert.equal(Posts.publishWindow(bad, NOW), null, `expected null for ${JSON.stringify(bad)}`);
        }
    });

    it('accepts a Date as readily as an ISO string', () => {
        // renderScheduledCard passes whatever the API row holds.
        const win = Posts.publishWindow(new Date('2026-09-23T10:00:00.000Z'), NOW);
        assert.ok(win);
        assert.equal(win.isPast, false);
    });

    it('uses the overdue wording for a past time, not merely a different timestamp', () => {
        // The first version of this compared the future note to the past note
        // and asserted they differed — which a mutation collapsing both branches
        // into the FUTURE string passed anyway, because the two still carried
        // different `{when}` values. The strings differed for a reason that had
        // nothing to do with the branch under test.
        //
        // So each note is pinned against the key it is supposed to come from,
        // rendered with the instant `publishWindow` actually computed. The
        // `notEqual` is the one that fails on a collapse.
        //
        // Run in BOTH regimes: the branch is what is under test, and it has to
        // be right whichever caller is sweeping. Pinning one regime is how this
        // test went stale the moment the worker was switched on.
        for (const frequent of [false, true]) {
            const { Posts: P, UI, t } = load();
            P.FREQUENT_SWEEP = frequent;
            const local = '2020-01-01T10:00';
            const win = P.publishWindow(vmFromLocal(UI, local));
            assert.ok(win);
            assert.equal(win.isPast, true);

            const when = UI.formatDateTime(win.from);
            const minutes = P.sweepLagMinutes();
            const pastKey = frequent ? 'posts.schedule.pastExpected' : 'posts.schedule.pastExpectedDaily';
            const fwdKey = frequent ? 'posts.schedule.expected' : 'posts.schedule.expectedDaily';
            const note = P.scheduleNoteText(local);
            assert.equal(note, t(pastKey, { when, minutes }), `past wording, frequent=${frequent}`);
            assert.notEqual(note, t(fwdKey, { when, minutes }), `must not use forward wording, frequent=${frequent}`);
        }
    });

    it('uses the forward wording for a future time', () => {
        for (const frequent of [false, true]) {
            const { Posts: P, UI, t } = load();
            P.FREQUENT_SWEEP = frequent;
            const local = '2027-01-01T10:00';
            const win = P.publishWindow(vmFromLocal(UI, local));
            assert.ok(win);
            assert.equal(win.isPast, false);

            const when = UI.formatDateTime(win.from);
            const minutes = P.sweepLagMinutes();
            const fwdKey = frequent ? 'posts.schedule.expected' : 'posts.schedule.expectedDaily';
            const pastKey = frequent ? 'posts.schedule.pastExpected' : 'posts.schedule.pastExpectedDaily';
            const note = P.scheduleNoteText(local);
            assert.equal(note, t(fwdKey, { when, minutes }), `forward wording, frequent=${frequent}`);
            assert.notEqual(note, t(pastKey, { when, minutes }), `must not use past wording, frequent=${frequent}`);
        }
    });

    it('takes the minutes in the copy FROM the constant, not from a second copy of it', () => {
        // The tail used to be written into the translation string as a literal
        // "15 minutes" while `FREQUENT_SWEEP_LAG_MS` held the real value. The two
        // could drift silently, and did: the constant moved to 5 and every test
        // still passed while the screen went on saying 15.
        //
        // Pinning the CURRENT number would not catch that — the string and the
        // constant would simply be wrong together. So this moves the constant to
        // a value nothing else in the file uses and asserts the sentence follows.
        const { Posts: P, UI, t } = load();
        P.FREQUENT_SWEEP = true;
        P.FREQUENT_SWEEP_LAG_MS = 7 * 60 * 1000;

        assert.equal(P.sweepLagMinutes(), 7, 'the helper must derive from the constant');

        const local = '2027-01-01T10:00';
        const win = P.publishWindow(vmFromLocal(UI, local));
        assert.ok(win);
        const note = P.scheduleNoteText(local);
        assert.equal(
            note,
            t('posts.schedule.expected', { when: UI.formatDateTime(win.from), minutes: 7 }),
            'the rendered note must carry the constant\'s value'
        );
        assert.ok(note.includes('7'), `the sentence must name 7 minutes, got: ${note}`);
        assert.ok(!note.includes('15'), `a stale hardcoded 15 is still in the copy: ${note}`);

        // And the window itself moves with it, so copy and behaviour cannot part.
        assert.equal(win.until.getTime() - win.from.getTime(), 7 * 60 * 1000);
    });

    it('names the run the post will go out on, whichever regime is active', () => {
        // The note must quote the same instant `publishWindow` computed, not a
        // second opinion — this is the seam where a correct function and a lying
        // sentence could coexist, which is exactly what happened when the copy
        // said "~15 minutes" while the backend published at midnight.
        for (const frequent of [false, true]) {
            const { Posts: P, UI } = load();
            P.FREQUENT_SWEEP = frequent;
            const local = '2027-01-01T10:35';
            const win = P.publishWindow(vmFromLocal(UI, local));
            assert.ok(win);
            const note = P.scheduleNoteText(local);
            assert.ok(
                note.includes(UI.formatDateTime(win.from)),
                `frequent=${frequent}: expected the note to name ${UI.formatDateTime(win.from)}; got: ${note}`
            );
        }
    });
});

describe('ActivityPage.hasFilters — "nothing happened" vs "you filtered it out"', () => {
    it('is false with nothing set', () => {
        const { Activity } = load();
        assert.equal(Activity.hasFilters(), false);
    });

    it('is true for any one of the four filters on its own', () => {
        // Each is an independent way to empty the table, and missing one means
        // that case renders the wrong empty state with no way out.
        for (const field of ['currentStatus', 'currentSearch', 'currentPlatform', 'currentCampaignId'] as const) {
            const { Activity } = load();
            Activity[field] = 'x';
            assert.equal(Activity.hasFilters(), true, `${field} alone must count as filtered`);
        }
    });

    it('ignores the page number, which is not a filter', () => {
        const { Activity } = load();
        Activity.currentPage = 4;
        assert.equal(Activity.hasFilters(), false);
    });

    it('clearFilters drops all four and returns to page one', () => {
        const { Activity, loads } = load();
        Activity.currentStatus = 'FAILED';
        Activity.currentSearch = 'sara';
        Activity.currentPlatform = 'instagram';
        Activity.currentCampaignId = '7';
        Activity.currentPage = 5;

        Activity.clearFilters();

        assert.equal(Activity.hasFilters(), false);
        // Page one, not page five: page five of the unfiltered log is not where
        // the operator was, and may not exist.
        assert.equal(Activity.currentPage, 1);
        assert.deepEqual(loads, [1], 'clearing must re-fetch exactly once');
    });

    it('does nothing at all when there is nothing to clear', () => {
        // The button is not rendered in this state, but a stale delegated click
        // must not fire a pointless request.
        const { Activity, loads } = load();
        Activity.clearFilters();
        assert.deepEqual(loads, []);
    });
});

describe('InboxPage.resetViewState — what a returning operator inherits', () => {
    it('clears the search term, which is the field that used to survive', () => {
        const { Inbox } = load();
        Inbox.searchTerm = 'sara';
        Inbox.resetViewState();
        assert.equal(Inbox.searchTerm, '');
    });

    it('is applied by destroy() and by a tenant switch alike', () => {
        // The bug was three hand-copied lists that had drifted. Both entry
        // points must land on the same state.
        for (const method of ['destroy', 'resetTenantState'] as const) {
            const { Inbox } = load();
            Inbox.searchTerm = 'sara';
            Inbox.selectedConversationId = 'c1';
            Inbox.messagesPainted = true;
            Inbox.lastMessageStamp = '2026-09-22T09:00:00Z';
            Inbox.pendingBotState.set('c1', true);
            Inbox.renderedMessageIds.add('m1');
            Inbox.threads = [{ id: 'c1' }];

            Inbox[method]();

            assert.equal(Inbox.searchTerm, '', `${method} must clear searchTerm`);
            assert.equal(Inbox.selectedConversationId, null, `${method} must clear the open thread`);
            assert.equal(Inbox.messagesPainted, false, `${method} must clear messagesPainted`);
            assert.equal(Inbox.lastMessageStamp, null, `${method} must clear lastMessageStamp`);
            assert.equal(Inbox.pendingBotState.size, 0, `${method} must clear pendingBotState`);
            assert.equal(Inbox.renderedMessageIds.size, 0, `${method} must clear renderedMessageIds`);
            // `.length`, not deepEqual: the array is built inside the vm realm,
            // so its prototype is not this realm's Array and a strict deep
            // comparison against `[]` fails on identity rather than contents.
            assert.equal(Inbox.threads.length, 0, `${method} must drop the thread list`);
        }
    });

    it('a stale term really would have hidden conversations', () => {
        // Why the reset matters, stated as the behaviour rather than the field:
        // the filter is applied to the list whether or not the box shows it.
        const { Inbox } = load();
        Inbox.threads = [
            { id: '1', username: 'sara_dev', last_message_text: 'hello' },
            { id: '2', username: 'omar', last_message_text: 'كم السعر' },
        ];
        Inbox.searchTerm = 'sara';
        assert.equal(Inbox.visibleThreads().length, 1);

        Inbox.resetViewState();
        assert.equal(Inbox.visibleThreads().length, 2);
    });
});

describe('AiSettingsPage — Save survives a failed load followed by a retry', () => {
    const ids = [
        'ai-active-toggle', 'system-prompt-text', 'knowledge-base-text',
        'model-selector', 'temp-slider', 'temp-value', 'save-settings-btn',
        'ai-settings-error',
    ];

    it('disables Save when the load fails, so an empty form cannot overwrite a real prompt', async () => {
        const { Ai, dom, api } = load();
        ids.forEach((id) => dom.set(id, fakeEl(id)));
        api.getAiSettings = () => Promise.reject(new Error('502'));

        await Ai.loadSettings();

        assert.equal(dom.get('save-settings-btn')!.disabled, true);
    });

    it('re-enables Save when a retry succeeds', async () => {
        // The regression: nothing turned it back on, so a single blip left the
        // operator looking at their real system prompt above a dead button with
        // no way out but a full page reload.
        const { Ai, dom, api } = load();
        ids.forEach((id) => dom.set(id, fakeEl(id)));

        let attempt = 0;
        api.getAiSettings = () => {
            attempt += 1;
            return attempt === 1
                ? Promise.reject(new Error('502'))
                : Promise.resolve({ is_active: true, system_prompt: 'p', knowledge_base: 'k', temperature: 0.7 });
        };

        await Ai.loadSettings();
        assert.equal(dom.get('save-settings-btn')!.disabled, true, 'precondition: the first load failed');

        await Ai.loadSettings();
        assert.equal(dom.get('save-settings-btn')!.disabled, false, 'a successful retry must make Save usable again');
        assert.equal(dom.get('system-prompt-text')!.value, 'p', 'and the form must actually hold the loaded prompt');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PostsPage — TikTok rows', () => {
    const base = { id: 'p1', post_type: 'video', scheduled_time: '2027-03-04T18:20:00.000Z', caption: 'تعلم #AI' };

    it('labels a TikTok row TikTok, and an unknown platform as itself — never "Both platforms"', () => {
        // platformBadge used to fall through to "Both platforms" for any value it
        // did not know, which is a claim about where the post goes. A `tiktok`
        // row was labelled exactly that before this branch existed.
        const { Posts, t } = load();
        assert.equal(Posts.platformBadge('tiktok').label, t('common.tiktok'));
        assert.equal(Posts.platformBadge('both').label, t('common.both'));
        assert.notEqual(Posts.platformBadge('mastodon').label, t('common.both'));
        assert.equal(Posts.platformBadge('mastodon').label, 'mastodon');
    });

    it('an IN_INBOX card says what to do next and puts the caption one tap from the clipboard', () => {
        const { Posts, t } = load();
        const card = String(Posts.renderScheduledCard({ ...base, platform: 'tiktok', status: 'IN_INBOX' }));

        assert.ok(card.includes(t('posts.tiktok.inboxTitle')), 'the next step must be on the card');
        assert.ok(card.includes('data-action="app:copyValue"'), 'copy-caption button');
        assert.ok(card.includes(`data-copy="${base.caption}"`), 'the button copies THIS caption');
        assert.ok(card.includes(t('state.in_inbox')), 'the status reads "in your TikTok inbox"');
        // TikTok picks its own cover, so the Instagram cover warning is noise here.
        assert.ok(!card.includes(t('posts.cover.missingBadge')));
    });

    it('a PROCESSING card is visibly in flight, not "Pending"', () => {
        const { Posts, t } = load();
        const card = String(Posts.renderScheduledCard({ ...base, platform: 'tiktok', status: 'PROCESSING' }));
        assert.ok(card.includes(t('state.processing')));
        assert.ok(card.includes('dot-blink'));
        assert.ok(!card.includes(t('state.pending')));
    });

    it('a PENDING row held by TikTok\u2019s draft limit shows the reason as a warning, not an error', () => {
        const { Posts, t } = load();
        const note = 'Waiting for TikTok: 5 drafts are still in your inbox.';
        const card = String(Posts.renderScheduledCard({ ...base, platform: 'tiktok', status: 'PENDING', error_log: note }));
        assert.ok(card.includes(note));
        assert.ok(card.includes('text-warning'));
        assert.ok(!card.includes(t('posts.errorLabel')), 'held is not failed');
    });

    it('finds the TikTok half of a create response, whichever row it is', () => {
        const { Posts } = load();
        const tt = { id: 'b', platform: 'tiktok', status: 'IN_INBOX' };
        assert.equal(Posts.tiktokRowOf({ id: 'a', platform: 'both', group: [{ id: 'a', platform: 'both' }, tt] }), tt);
        assert.equal(Posts.tiktokRowOf(tt), tt);
        assert.equal(Posts.tiktokRowOf({ id: 'a', platform: 'instagram' }), null);
        assert.equal(Posts.tiktokRowOf(null), null);
    });

    it('offers TikTok only when the connection can actually upload', () => {
        const { Posts } = load();
        Posts.tiktok = null;
        assert.equal(Posts.tiktokReady(), false);
        Posts.tiktok = { connection: { connected: true, canUpload: false } };
        assert.equal(Posts.tiktokReady(), false, 'connected without video.upload is not ready');
        Posts.tiktok = { connection: { connected: true, canUpload: true } };
        assert.equal(Posts.tiktokReady(), true);
    });
});
