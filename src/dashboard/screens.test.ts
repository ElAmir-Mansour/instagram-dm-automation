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
    tiktokOutcomeText(status: string, mode?: string): string;
    tiktok: unknown;
    tiktokReady(): boolean;
    // Direct Post
    tiktokCreator: unknown;
    _ttChoices: Record<string, unknown> | null;
    _ttDurationSec: number | null;
    TIKTOK_DEFAULT_CHOICES: Record<string, unknown>;
    tiktokDirectState(creator: unknown, choices: Record<string, unknown> | null, opts?: Record<string, unknown>): DirectState;
    validateTikTokOptions(creator: unknown, choices: Record<string, unknown> | null, opts?: Record<string, unknown>): DirectValidation;
    tiktokDirectForm(view: DirectState): { toString(): string };
    tiktokConsentBlock(view: DirectState): { toString(): string };
    tiktokDeclaration(kind: string): { toString(): string };
    renderTikTokDirect(): { toString(): string };
    tiktokChoicesFrom(options: unknown): Record<string, unknown>;
    attachTikTokOptions(payload: Record<string, unknown>): { message: string; field: string | null } | null;
    tiktokPostMode(): string;
    privacyLabel(level: string): string;
    formatDuration(sec: number): string;
}

interface DirectState {
    privacy: string;
    audited: boolean;
    privacyOptions: Array<{ value: string; disabled: boolean }>;
    selfOnlyBlocked: boolean;
    comment: { checked: boolean; disabled: boolean };
    duet: { checked: boolean; disabled: boolean };
    stitch: { checked: boolean; disabled: boolean };
    disclose: boolean;
    brandOrganic: boolean;
    brandContent: boolean;
    brandContentDisabled: boolean;
    brandContentReason: string | null;
    needsDisclosureChoice: boolean;
    label: string | null;
    declaration: string;
    isAigc: boolean;
    consent: boolean;
    tooLong: boolean;
}

type DirectValidation =
    | { ok: true; options: Record<string, unknown> }
    | { ok: false; code: string; field: string | null; message: string };

interface SettingsApi {
    tiktokModeLabel(connection: unknown): string;
    tiktokIntro(connection: unknown): string;
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
    Settings: SettingsApi;
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
        'dashboard/js/pages/settings.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }

    const { PostsPage, ActivityPage, InboxPage, AiSettingsPage, SettingsPage, UI, t } = vm.runInContext(
        '({ PostsPage, ActivityPage, InboxPage, AiSettingsPage, SettingsPage, UI, t })', ctx
    ) as {
        PostsPage: PostsApi; ActivityPage: ActivityApi; InboxPage: InboxApi;
        AiSettingsPage: AiApi; SettingsPage: SettingsApi; UI: UiApi; t: Translate;
    };

    // loadData() writes markup and is not what these tests are about; the FACT
    // that it was called is.
    const loads: number[] = [];
    ActivityPage.loadData = (): unknown => { loads.push(ActivityPage.currentPage); return undefined; };

    return {
        Posts: PostsPage, UI, t, Activity: ActivityPage, Inbox: InboxPage, Ai: AiSettingsPage,
        Settings: SettingsPage, dom, api, loads,
    };
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
        // A Direct Post connection holds video.publish only — that is enough.
        Posts.tiktok = { connection: { connected: true, canUpload: false, canDirectPost: true } };
        assert.equal(Posts.tiktokReady(), true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * TikTok Direct Post. Every rule below is one TikTok's app audit checks against
 * its Content Sharing Guidelines, so each is pinned on the pure state/validation
 * helpers AND, where it is visible, on the markup the composer actually renders.
 */
describe('PostsPage — TikTok Direct Post composer', () => {
    const creator = {
        nickname: 'ElAmir',
        username: 'elamir.ai',
        avatarUrl: 'https://p16.tiktokcdn.com/avatar.jpg',
        privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
    };
    const audited = { audited: true };
    const publicOk = { privacy_level: 'PUBLIC_TO_EVERYONE', consent: true };

    /** The `<select id="tiktok-privacy">` and its options, parsed out of the form markup. */
    function privacySelect(markup: string): { open: string; options: Array<{ value: string; attrs: string }> } {
        const m = markup.match(/<select[^>]*id="tiktok-privacy"[^>]*>([\s\S]*?)<\/select>/);
        assert.ok(m, 'the privacy dropdown must be rendered');
        const open = m[0].slice(0, m[0].indexOf('>') + 1);
        const options = [...(m[1] ?? '').matchAll(/<option value="([^"]*)"([^>]*)>/g)]
            .map((o) => ({ value: o[1] ?? '', attrs: o[2] ?? '' }));
        return { open, options };
    }

    /** The opening tag of the input with this id. */
    function inputTag(markup: string, id: string): string {
        const m = markup.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
        assert.ok(m, `input #${id} must be rendered`);
        return m[0];
    }

    const plain = (markup: string): string => markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

    it('shows which account posts: avatar, nickname and @username', () => {
        const { Posts } = load();
        const form = String(Posts.tiktokDirectForm(Posts.tiktokDirectState(creator, null, audited)));
        assert.ok(form.includes('ElAmir'));
        assert.ok(form.includes('@elamir.ai'));
        assert.ok(form.includes('src="https://p16.tiktokcdn.com/avatar.jpg"'));
    });

    it('has NO default privacy level: an empty, selected placeholder and a required select', () => {
        const { Posts, t } = load();
        const state = Posts.tiktokDirectState(creator, null, audited);
        assert.equal(state.privacy, '');

        const { open, options } = privacySelect(String(Posts.tiktokDirectForm(state)));
        assert.ok(/\brequired\b/.test(open), 'the dropdown must be required');
        const [placeholder] = options;
        assert.ok(placeholder);
        assert.equal(placeholder.value, '', 'the first option is the empty placeholder');
        assert.ok(/\bselected\b/.test(placeholder.attrs), 'and it is the one selected');
        assert.equal(options.filter((o) => /\bselected\b/.test(o.attrs)).length, 1, 'no real level is pre-selected');
        assert.deepEqual(options.slice(1).map((o) => o.value), creator.privacyLevelOptions);

        const form = String(Posts.tiktokDirectForm(state));
        assert.ok(form.includes(t('posts.tiktok.direct.privacyPlaceholder')));
        // Each level carries a translated label, not TikTok's enum.
        assert.ok(form.includes(t('posts.tiktok.privacy.selfOnly')));
        assert.notEqual(t('posts.tiktok.privacy.selfOnly'), 'SELF_ONLY');

        const v = Posts.validateTikTokOptions(creator, { consent: true }, audited);
        assert.equal(v.ok, false);
        assert.equal(!v.ok && v.code, 'privacyRequired');
    });

    it('starts every interaction, disclosure and AI switch OFF', () => {
        const { Posts } = load();
        const state = Posts.tiktokDirectState(creator, null, audited);
        for (const k of ['comment', 'duet', 'stitch'] as const) assert.equal(state[k].checked, false, `${k} must start off`);
        assert.equal(state.disclose, false);
        assert.equal(state.isAigc, false);
        assert.equal(state.consent, false);

        const markup = String(Posts.tiktokDirectForm(state)) + String(Posts.tiktokConsentBlock(state));
        assert.ok(!/\bchecked\b/.test(markup), 'nothing in the Direct Post form is pre-ticked');
    });

    it('greys out an interaction TikTok has switched off, and sends it as off whatever was saved', () => {
        const { Posts, t } = load();
        const locked = { ...creator, commentDisabled: true, stitchDisabled: true };
        const state = Posts.tiktokDirectState(locked, { allow_comment: true, allow_duet: true, allow_stitch: true }, audited);
        assert.deepEqual({ ...state.comment }, { checked: false, disabled: true });
        assert.deepEqual({ ...state.duet }, { checked: true, disabled: false });

        const form = String(Posts.tiktokDirectForm(state));
        assert.ok(/\bdisabled\b/.test(inputTag(form, 'tiktok-allow-comment')));
        assert.ok(!/\bdisabled\b/.test(inputTag(form, 'tiktok-allow-duet')));
        assert.ok(form.includes('is-disabled'), 'the row is greyed');
        assert.ok(form.includes(t('posts.tiktok.direct.interactionOff')), 'and says why');

        const v = Posts.validateTikTokOptions(locked, { ...publicOk, allow_comment: true, allow_duet: true, allow_stitch: true }, audited);
        assert.ok(v.ok);
        assert.equal(v.ok && v.options.allow_comment, false);
        assert.equal(v.ok && v.options.allow_duet, true);
        assert.equal(v.ok && v.options.allow_stitch, false);
    });

    it('branded content cannot be private — in both directions', () => {
        const { Posts, t } = load();

        // Branded content ticked -> "Only me" is disabled.
        const branded = Posts.tiktokDirectState(creator, { disclose: true, brand_content: true }, audited);
        assert.equal(branded.brandContent, true);
        assert.equal(branded.selfOnlyBlocked, true);
        for (const o of branded.privacyOptions) {
            assert.equal(o.disabled, o.value === 'SELF_ONLY', `${o.value}: only SELF_ONLY is blocked by branded content`);
        }
        const brandedSelect = privacySelect(String(Posts.tiktokDirectForm(branded)));
        const selfOnly = brandedSelect.options.find((o) => o.value === 'SELF_ONLY');
        assert.ok(selfOnly && /\bdisabled\b/.test(selfOnly.attrs));

        // "Only me" selected -> Branded content is disabled, with the reason.
        const priv = Posts.tiktokDirectState(creator, { privacy_level: 'SELF_ONLY', disclose: true }, audited);
        assert.equal(priv.privacy, 'SELF_ONLY');
        assert.equal(priv.brandContentDisabled, true);
        assert.equal(priv.brandContentReason, 'private');
        const form = String(Posts.tiktokDirectForm(priv));
        assert.ok(/\bdisabled\b/.test(inputTag(form, 'tiktok-brand-content')));
        assert.ok(form.includes(t('posts.tiktok.direct.brandedPrivate')));
        assert.ok(!/\bdisabled\b/.test(inputTag(form, 'tiktok-brand-organic')), 'your-brand stays available');

        // A saved row carrying both is named, not silently resolved.
        const v = Posts.validateTikTokOptions(creator,
            { privacy_level: 'SELF_ONLY', disclose: true, brand_content: true, consent: true }, audited);
        assert.equal(v.ok, false);
        assert.equal(!v.ok && v.code, 'brandedPrivate');
    });

    it('disclosure ON requires "Your brand" or "Branded content", and each maps to its own flag and label', () => {
        const { Posts, t } = load();

        const none = Posts.validateTikTokOptions(creator, { ...publicOk, disclose: true }, audited);
        assert.equal(none.ok, false);
        assert.equal(!none.ok && none.code, 'discloseChoose');
        assert.equal(!none.ok && none.message, t('posts.tiktok.direct.discloseChoose'));
        const noneState = Posts.tiktokDirectState(creator, { disclose: true }, audited);
        assert.equal(noneState.needsDisclosureChoice, true);
        assert.ok(String(Posts.tiktokDirectForm(noneState)).includes(t('posts.tiktok.direct.discloseChoose')),
            'the panel says so before submit, too');

        const organic = Posts.validateTikTokOptions(creator, { ...publicOk, disclose: true, brand_organic: true }, audited);
        assert.ok(organic.ok);
        assert.equal(organic.ok && organic.options.brand_organic, true);
        assert.equal(organic.ok && organic.options.brand_content, false);
        const organicState = Posts.tiktokDirectState(creator, { disclose: true, brand_organic: true }, audited);
        assert.equal(organicState.label, 'promotional');
        assert.ok(String(Posts.tiktokDirectForm(organicState)).includes(t('posts.tiktok.direct.labelPromotional')));

        const content = Posts.validateTikTokOptions(creator, { ...publicOk, disclose: true, brand_content: true }, audited);
        assert.ok(content.ok);
        assert.equal(content.ok && content.options.brand_content, true);
        assert.equal(Posts.tiktokDirectState(creator, { disclose: true, brand_content: true }, audited).label, 'paid');
        // Both ticked is labelled Paid partnership, per TikTok.
        assert.equal(Posts.tiktokDirectState(creator, { disclose: true, brand_organic: true, brand_content: true }, audited).label, 'paid');

        // Both hints are on screen under the options.
        const form = String(Posts.tiktokDirectForm(noneState));
        assert.ok(form.includes(t('posts.tiktok.direct.yourBrandHint')));
        assert.ok(form.includes(t('posts.tiktok.direct.brandedContentHint')));

        // Ticks left over under a switched-off disclosure are never sent.
        const off = Posts.validateTikTokOptions(creator, { ...publicOk, disclose: false, brand_organic: true, brand_content: true }, audited);
        assert.ok(off.ok);
        assert.equal(off.ok && off.options.brand_organic, false);
        assert.equal(off.ok && off.options.brand_content, false);
    });

    it('blocks a video longer than the account may post, and only then', () => {
        const { Posts, t } = load();
        const over = Posts.validateTikTokOptions(creator, publicOk, { ...audited, durationSec: 600.4 });
        assert.equal(over.ok, false);
        assert.equal(!over.ok && over.code, 'tooLong');
        assert.equal(!over.ok && over.field, 'post-media-url');
        assert.equal(!over.ok && over.message, t('posts.tiktok.direct.tooLong', { duration: '10:01', max: '10:00' }));

        const state = Posts.tiktokDirectState(creator, null, { ...audited, durationSec: 601 });
        assert.equal(state.tooLong, true);
        assert.ok(String(Posts.tiktokDirectForm(state)).includes(t('posts.tiktok.direct.tooLong', { duration: '10:01', max: '10:00' })));

        assert.ok(Posts.validateTikTokOptions(creator, publicOk, { ...audited, durationSec: 600 }).ok, 'exactly the limit is fine');
        // An unreadable length is not proof of a long video; TikTok still checks.
        assert.ok(Posts.validateTikTokOptions(creator, publicOk, { ...audited, durationSec: null }).ok);

        assert.equal(Posts.formatDuration(600), '10:00');
        assert.equal(Posts.formatDuration(60.4), '1:01', 'rounded up, so a too-long video never reads as the limit');
        assert.equal(Posts.formatDuration(3725), '1:02:05');
    });

    it('requires express consent, and sends consent: true only once it is given', () => {
        const { Posts } = load();
        const v = Posts.validateTikTokOptions(creator, { privacy_level: 'PUBLIC_TO_EVERYONE' }, audited);
        assert.equal(v.ok, false);
        assert.equal(!v.ok && v.code, 'consentRequired');
        assert.equal(!v.ok && v.field, 'tiktok-consent-check');

        const block = String(Posts.tiktokConsentBlock(Posts.tiktokDirectState(creator, null, audited)));
        const tag = inputTag(block, 'tiktok-consent-check');
        assert.ok(/\brequired\b/.test(tag));
        assert.ok(!/\bchecked\b/.test(tag));

        const ok = Posts.validateTikTokOptions(creator, publicOk, audited);
        assert.ok(ok.ok);
        assert.deepEqual(JSON.parse(JSON.stringify(ok.ok && ok.options)), {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            allow_comment: false, allow_duet: false, allow_stitch: false,
            brand_organic: false, brand_content: false, is_aigc: false,
            consent: true,
        });
    });

    it('an unaudited app offers only "Only me" — still with no default — and never branded content', () => {
        const { Posts, t } = load();
        const state = Posts.tiktokDirectState(creator, null, { audited: false });
        assert.equal(state.privacy, '', 'no default even when only one level is possible');
        for (const o of state.privacyOptions) {
            assert.equal(o.disabled, o.value !== 'SELF_ONLY', `${o.value} must be ${o.value === 'SELF_ONLY' ? 'enabled' : 'disabled'}`);
        }
        assert.equal(state.brandContentDisabled, true);
        assert.equal(state.brandContentReason, 'unaudited');
        assert.equal(Posts.tiktokDirectState(creator, { disclose: true, brand_content: true }, { audited: false }).brandContent, false);

        const form = String(Posts.tiktokDirectForm(state));
        assert.ok(form.includes(t('posts.tiktok.direct.unaudited')), 'the restriction is explained');
        assert.ok(!String(Posts.tiktokDirectForm(Posts.tiktokDirectState(creator, null, audited))).includes(t('posts.tiktok.direct.unaudited')));

        const pub = Posts.validateTikTokOptions(creator, publicOk, { audited: false });
        assert.equal(!pub.ok && pub.code, 'unauditedPrivate');
        assert.ok(Posts.validateTikTokOptions(creator, { privacy_level: 'SELF_ONLY', consent: true }, { audited: false }).ok);

        // Anything but an explicit `true` is the restrictive reading.
        assert.equal(Posts.tiktokDirectState(creator, null, {}).audited, false);
    });

    it('the declaration switches to the Branded Content Policy when branded content is ticked', () => {
        const { Posts, t } = load();
        const musicLink = t('posts.tiktok.declaration.musicLink');
        const policyLink = t('posts.tiktok.declaration.policyLink');
        const musicUrl = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
        const policyUrl = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

        assert.equal(Posts.tiktokDirectState(creator, null, audited).declaration, 'music');
        assert.equal(Posts.tiktokDirectState(creator, { disclose: true, brand_organic: true }, audited).declaration, 'music');
        assert.equal(Posts.tiktokDirectState(creator, { disclose: true, brand_content: true }, audited).declaration, 'branded');

        const music = String(Posts.tiktokDeclaration('music'));
        assert.ok(music.includes(`<a href="${musicUrl}" target="_blank" rel="noopener noreferrer">${musicLink}</a>`));
        assert.ok(!music.includes(policyUrl));
        assert.equal(plain(music), t('posts.tiktok.declaration.music', { music: musicLink }));

        const branded = String(Posts.tiktokDeclaration('branded'));
        assert.ok(branded.includes(`<a href="${policyUrl}" target="_blank" rel="noopener noreferrer">${policyLink}</a>`));
        assert.ok(branded.includes(musicUrl));
        assert.equal(plain(branded), t('posts.tiktok.declaration.branded', { policy: policyLink, music: musicLink }));

        // And the consent block — the thing above the submit button — follows the state.
        const block = String(Posts.tiktokConsentBlock(Posts.tiktokDirectState(creator, { disclose: true, brand_content: true }, audited)));
        assert.ok(block.includes(policyUrl));
    });

    it('sends tiktok_options only when TikTok is a target in direct mode', () => {
        const { Posts } = load();
        Posts.tiktok = { connection: { connected: true, canUpload: true, postMode: 'direct', audited: true } };
        Posts.tiktokCreator = { status: 'ready', data: { postMode: 'direct', audited: true, creator } };
        Posts._ttChoices = { ...Posts.TIKTOK_DEFAULT_CHOICES, ...publicOk, allow_duet: true };

        const tiktokOnly: Record<string, unknown> = { platform: 'tiktok', post_type: 'video' };
        assert.equal(Posts.attachTikTokOptions(tiktokOnly), null);
        assert.equal(JSON.parse(JSON.stringify(tiktokOnly.tiktok_options)).allow_duet, true);

        const also: Record<string, unknown> = { platform: 'both', post_type: 'video', also_tiktok: true };
        assert.equal(Posts.attachTikTokOptions(also), null);
        assert.ok(also.tiktok_options, 'the "Also send to TikTok" row carries them too');

        const metaOnly: Record<string, unknown> = { platform: 'instagram', post_type: 'video' };
        assert.equal(Posts.attachTikTokOptions(metaOnly), null);
        assert.equal(metaOnly.tiktok_options, undefined);

        // Inbox mode: nothing extra, as before.
        const { Posts: Inbox } = load();
        Inbox.tiktok = { connection: { connected: true, canUpload: true, postMode: 'inbox' } };
        const inboxPost: Record<string, unknown> = { platform: 'tiktok', post_type: 'video' };
        assert.equal(Inbox.attachTikTokOptions(inboxPost), null);
        assert.equal(inboxPost.tiktok_options, undefined);

        // The live answer wins over the page-load summary.
        Posts.tiktokCreator = { status: 'ready', data: { postMode: 'inbox', audited: false, creator: null } };
        assert.equal(Posts.tiktokPostMode(), 'inbox');
    });

    it('blocks submit while the creator info is loading or failed, and shows the failure with Retry', () => {
        const { Posts, t } = load();
        Posts.tiktok = { connection: { connected: true, canUpload: true, postMode: 'direct' } };

        Posts.tiktokCreator = { status: 'loading' };
        const blocked = Posts.attachTikTokOptions({ platform: 'tiktok' });
        assert.ok(blocked);
        assert.equal(blocked.message, t('posts.tiktok.direct.notReady'));

        Posts.tiktokCreator = { status: 'error', error: { message: 'TikTok refused: spam_risk_too_many_posts' } };
        const panel = String(Posts.renderTikTokDirect());
        assert.ok(panel.includes('TikTok refused: spam_risk_too_many_posts'));
        assert.ok(panel.includes('data-action="posts:retryTikTokCreator"'));
        assert.ok(Posts.attachTikTokOptions({ platform: 'tiktok' }), 'an error is not a green light');
    });

    it('an edit starts from the row’s saved options — except consent, which is asked again', () => {
        const { Posts } = load();
        const saved = Posts.tiktokChoicesFrom({
            mode: 'direct', privacy_level: 'FOLLOWER_OF_CREATOR',
            allow_comment: true, allow_duet: false, allow_stitch: true,
            brand_organic: false, brand_content: true, is_aigc: true, consent_at: '2026-09-24T10:00:00Z',
        });
        assert.equal(saved.privacy_level, 'FOLLOWER_OF_CREATOR');
        assert.equal(saved.allow_comment, true);
        assert.equal(saved.allow_stitch, true);
        assert.equal(saved.disclose, true, 'a saved brand flag turns the disclosure switch on');
        assert.equal(saved.brand_content, true);
        assert.equal(saved.is_aigc, true);
        assert.equal(saved.consent, false);

        for (const none of [null, undefined, { mode: 'inbox' }]) {
            assert.deepEqual(JSON.parse(JSON.stringify(Posts.tiktokChoicesFrom(none))),
                JSON.parse(JSON.stringify(Posts.TIKTOK_DEFAULT_CHOICES)));
        }
    });

    it('a direct-mode card says TikTok may take a few minutes, and a posted one shows its privacy', () => {
        const { Posts, t } = load();
        const row = {
            id: 'd1', platform: 'tiktok', post_type: 'video', scheduled_time: '2027-03-04T18:20:00.000Z', caption: 'c',
            platform_options: { mode: 'direct', privacy_level: 'MUTUAL_FOLLOW_FRIENDS' },
        };

        const processing = String(Posts.renderScheduledCard({ ...row, status: 'PROCESSING' }));
        assert.ok(processing.includes(t('posts.tiktok.direct.processingNote')));
        assert.ok(!processing.includes(t('posts.tiktok.processingNote')), 'not the inbox-mode note');

        const published = String(Posts.renderScheduledCard({ ...row, status: 'PUBLISHED', published_post_id: 'TT:1' }));
        assert.ok(published.includes(t('posts.tiktok.postedNoId')), '"Posted on TikTok", even with an id');
        assert.ok(published.includes(Posts.privacyLabel('MUTUAL_FOLLOW_FRIENDS')), 'the privacy chip');

        // An inbox row is exactly as before.
        const inbox = String(Posts.renderScheduledCard({ ...row, platform_options: null, status: 'PROCESSING' }));
        assert.ok(inbox.includes(t('posts.tiktok.processingNote')));
        assert.ok(!inbox.includes(Posts.privacyLabel('MUTUAL_FOLLOW_FRIENDS')));

        assert.equal(Posts.tiktokOutcomeText('PROCESSING', 'direct'), t('posts.tiktok.direct.processingToast'));
        assert.equal(Posts.tiktokOutcomeText('PUBLISHING', 'direct'), t('posts.tiktok.direct.processingToast'));
        assert.equal(Posts.tiktokOutcomeText('IN_INBOX'), t('posts.tiktok.sentToInbox'), 'inbox wording unchanged');
    });
});

describe('SettingsPage — TikTok posting mode', () => {
    it('names the mode in force, and the unaudited restriction with it', () => {
        const { Settings, t } = load();
        assert.equal(Settings.tiktokModeLabel({ postMode: 'inbox' }), t('settings.tiktok.mode.inbox'));
        assert.equal(Settings.tiktokModeLabel(null), t('settings.tiktok.mode.inbox'));
        assert.equal(Settings.tiktokModeLabel({ postMode: 'direct', audited: true }), t('settings.tiktok.mode.direct'));
        assert.equal(Settings.tiktokModeLabel({ postMode: 'direct', audited: false }), t('settings.tiktok.mode.directUnaudited'));
    });

    it('the intro describes the mode posts will actually go out in', () => {
        const { Settings, t } = load();
        assert.equal(Settings.tiktokIntro({ connected: true, postMode: 'direct' }), t('settings.tiktok.introDirect'));
        assert.equal(Settings.tiktokIntro({ connected: true, postMode: 'inbox' }), t('settings.tiktok.introInbox'));
        // Switched on, but this connection lacks video.publish: still inbox until reconnect.
        assert.equal(Settings.tiktokIntro({ connected: true, postMode: 'inbox', directPostEnabled: true }), t('settings.tiktok.introInbox'));
        // Not connected yet with Direct Post on: connecting will ask for it.
        assert.equal(Settings.tiktokIntro({ connected: false, directPostEnabled: true }), t('settings.tiktok.introDirect'));
        assert.equal(Settings.tiktokIntro(null), t('settings.tiktok.introInbox'));
        assert.notEqual(t('settings.tiktok.introDirect'), t('settings.tiktok.introInbox'));
    });
});
