/**
 * The operator screens' logic, as opposed to their markup.
 *
 * Four things in `dashboard/js/pages/` decide something rather than render
 * something, and each one is a claim the product makes that a screenshot cannot
 * check:
 *
 * 1. `PostsPage.publishWindow` — WHEN a scheduled post goes out. This is the
 *    number the operator plans their day around, and it has now been wrong
 *    twice in opposite directions: first the minute picker promised precision
 *    the daily cron could not keep, then the correction to "next 00:00 UTC"
 *    outlived the five-minute drain that made it false. Nothing caught either,
 *    because a plausible timestamp looks exactly like a correct one.
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

interface PublishWindow { isPast: boolean; from: Date; until: Date }

interface PostsApi {
    SWEEP_LAG_MS: number;
    publishWindow(iso: unknown, now?: number): PublishWindow | null;
    scheduleNoteText(localValue: string): string;
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
}

/** The page's own local-time parser, so the test cannot disagree with it. */
function vmFromLocal(UI: UiApi, local: string): string | null {
    return UI.fromLocalInputValue(local);
}

interface Loaded {
    Posts: PostsApi;
    UI: UiApi;
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

    const { PostsPage, ActivityPage, InboxPage, AiSettingsPage, UI } = vm.runInContext(
        '({ PostsPage, ActivityPage, InboxPage, AiSettingsPage, UI })', ctx
    ) as {
        PostsPage: PostsApi; ActivityPage: ActivityApi; InboxPage: InboxApi;
        AiSettingsPage: AiApi; UI: UiApi;
    };

    // loadData() writes markup and is not what these tests are about; the FACT
    // that it was called is.
    const loads: number[] = [];
    ActivityPage.loadData = (): unknown => { loads.push(ActivityPage.currentPage); return undefined; };

    return { Posts: PostsPage, UI, Activity: ActivityPage, Inbox: InboxPage, Ai: AiSettingsPage, dom, api, loads };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('PostsPage.publishWindow — when a scheduled post actually goes out', () => {
    const { Posts } = load();
    // A fixed clock. Real `Date.now()` in an assertion about a time window is
    // how a test passes at 09:00 and fails at midnight.
    const NOW = Date.parse('2026-09-22T09:00:00.000Z');

    it('a future time publishes AT that time, not at the next midnight UTC', () => {
        // This is the whole point. The screen used to answer 00:00 the next day
        // for anything after midnight — up to 24 hours late — because the daily
        // Vercel cron was once the only caller of the publish sweep. The drain
        // workflow now calls the same sweep every ~5-15 minutes.
        const win = Posts.publishWindow('2026-09-22T14:35:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.isPast, false);
        assert.equal(win.from.toISOString(), '2026-09-22T14:35:00.000Z');
    });

    it('closes the window 15 minutes later, the slow end of the sweep', () => {
        // 15 and not 5: GitHub Actions does not promise schedule punctuality and
        // throttles under load (FLOWS.md §3.2, drain.yml's own header). Quoting
        // the fast end would make the screen late more often than not.
        assert.equal(Posts.SWEEP_LAG_MS, 15 * 60 * 1000);
        const win = Posts.publishWindow('2026-09-22T14:35:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.until.getTime() - win.from.getTime(), 15 * 60 * 1000);
    });

    it('counts an overdue post from NOW, not from the time that has passed', () => {
        // A window that closed yesterday tells the operator nothing about when
        // the post they are looking at will go out.
        const win = Posts.publishWindow('2026-09-20T08:00:00.000Z', NOW);
        assert.ok(win);
        assert.equal(win.isPast, true);
        assert.equal(win.from.getTime(), NOW);
        assert.equal(win.until.getTime(), NOW + 15 * 60 * 1000);
    });

    it('treats the current instant as past, so it is never a window of zero', () => {
        const win = Posts.publishWindow(new Date(NOW).toISOString(), NOW);
        assert.ok(win);
        assert.equal(win.isPast, true);
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

    it('says something different for a past time than for a future one', () => {
        // The two branches must not collapse into one string: "already passed"
        // is the line that stops the operator waiting for a post that is going
        // out right now.
        const future = Posts.scheduleNoteText('2027-01-01T10:00');
        const past = Posts.scheduleNoteText('2020-01-01T10:00');
        assert.ok(future.length > 0);
        assert.ok(past.length > 0);
        assert.notEqual(future, past);
    });

    it('names the requested time in the note, not a midnight the operator did not pick', () => {
        // The regression this guards is the specific one that shipped: the note
        // quoted `nextCronRun()` — always 00:00 — so whatever time was chosen,
        // the sentence underneath said midnight. Asserting that the formatted
        // requested time is IN the note is what tells those two apart, and it
        // survives any rewording of the copy around it.
        const { Posts: P, UI } = load();
        const local = '2027-01-01T10:35';
        const win = P.publishWindow(vmFromLocal(UI, local));
        assert.ok(win);
        const note = P.scheduleNoteText(local);
        assert.ok(
            note.includes(UI.formatDateTime(win.from)),
            `expected the note to name ${UI.formatDateTime(win.from)}; got: ${note}`
        );
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
