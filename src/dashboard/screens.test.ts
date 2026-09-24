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
    tiktokOffersChoice(): boolean;
    tiktokEffectiveMode(): string;
    attachTikTokOptions(payload: Record<string, unknown>): { message: string; field: string | null } | null;
    _ttDelivery: string;
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
    // Carousel + TikTok photo posts
    posts: Array<Record<string, unknown>>;
    typeOptions(platform: string, selected: string): { toString(): string };
    typeAllowedOn(type: string, platform: string): boolean;
    _slides: { main: Slide[]; tiktok: Slide[] } | null;
    _uploadsInFlight: number;
    _ttPhoto: boolean;
    _ttTitle: string;
    _ttTitleTouched: boolean;
    DOWNLOAD_SPACING_MS: number;
    resetSlides(post: Record<string, unknown> | null): void;
    resetTikTokComposer(post: Record<string, unknown> | null): void;
    slideLimits(which: string, platform?: string): SlideLimits;
    validateSlides(slides: unknown, limits: SlideLimits, opts?: Record<string, unknown>): SlideValidation;
    slideCountMarkup(which: string, platform: string): { toString(): string };
    slideTile(which: string, slide: Slide, index: number, total: number): { toString(): string };
    pickSlides(input: unknown): void;
    moveSlide(which: string, id: string, delta: number): void;
    removeSlide(which: string, id: string): void;
    retrySlide(which: string, id: string): void;
    prepareSlideFile: (file: unknown) => Promise<{ dataUrl: string; thumb: string; name: string }>;
    slideTargetSize(width: number, height: number): { width: number; height: number };
    slideNeedsReencode(file: unknown, width: number): boolean;
    jpegFileName(name: string): string;
    showCreateModal(): void;
    showEditModal(id: string): void;
    applyTypeMatrix(): void;
    handleCreate(form: unknown, event: unknown): Promise<void>;
    handleEdit(form: unknown, event: unknown): Promise<void>;
    tiktokTitleFromCaption(caption: string): string;
    clipUtf16(text: string, max: number): string;
    validateTikTokTitle(value: string): { ok: boolean; title?: string; message?: string };
    titleCountMarkup(value: string): { toString(): string };
    onCaptionInput(el: unknown): void;
    onTikTokTitle(el: unknown): void;
    renderTikTokManual(post: Record<string, unknown>, withHint?: boolean): { toString(): string };
    downloadAll(el: unknown): void;
}

interface Slide { id: string; file: unknown; name: string; url: string; thumb: string; status: string; error: string }
interface SlideLimits { min: number; max: number; target: string }
type SlideValidation =
    | { ok: true; urls: string[] }
    | { ok: false; code: string; message: string };

/**
 * `new FormData(form)` for a fake form: the fields a real one would have read. Lets the
 * REAL submit handlers run, so the payload under test is the one `handleCreate` builds.
 */
class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) {
        this.fields = (form && form.fields) || {};
    }
    get(name: string): unknown {
        return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null;
    }
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
    I18N: { lang: string };
    Activity: ActivityApi;
    Inbox: InboxApi;
    Ai: AiApi;
    Settings: SettingsApi;
    dom: Map<string, FakeEl>;
    /** Stubbed API responses, per method name. */
    api: Record<string, (...args: unknown[]) => unknown>;
    /** Every loadData() call the page made, so a re-fetch is observable. */
    loads: number[];
    /** Every toast the page raised, in order. */
    toasts: Array<{ message: string; type?: string }>;
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
        FormData: FakeFormData,
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

    const { PostsPage, ActivityPage, InboxPage, AiSettingsPage, SettingsPage, UI, t, I18N } = vm.runInContext(
        '({ PostsPage, ActivityPage, InboxPage, AiSettingsPage, SettingsPage, UI, t, I18N })', ctx
    ) as {
        PostsPage: PostsApi; ActivityPage: ActivityApi; InboxPage: InboxApi;
        AiSettingsPage: AiApi; SettingsPage: SettingsApi; UI: UiApi; t: Translate; I18N: { lang: string };
    };

    // loadData() writes markup and is not what these tests are about; the FACT
    // that it was called is.
    const loads: number[] = [];
    ActivityPage.loadData = (): unknown => { loads.push(ActivityPage.currentPage); return undefined; };

    // The real toast needs a container this DOM does not have; what was said is the point.
    const toasts: Array<{ message: string; type?: string }> = [];
    (UI as unknown as { toast: (message: unknown, type?: string) => void }).toast = (message, type) => {
        toasts.push({ message: String(message), type });
    };

    return {
        Posts: PostsPage, UI, t, I18N, Activity: ActivityPage, Inbox: InboxPage, Ai: AiSettingsPage,
        Settings: SettingsPage, dom, api, loads, toasts,
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

// ─────────────────────────────────────────────────────────────────────────────

describe('PostsPage — choosing direct post or drafts until TikTok approves the app', () => {
    const both = (audited: boolean) => ({
        connection: { connected: true, canUpload: true, canDirectPost: true, postMode: 'direct', audited },
    });

    it('offers the choice only with both permissions, and only while unaudited', () => {
        const { Posts } = load();
        Posts.tiktok = both(false);
        assert.equal(Posts.tiktokOffersChoice(), true);
        Posts.tiktok = both(true);
        assert.equal(Posts.tiktokOffersChoice(), false, 'audited: always direct, nothing to choose');
        Posts.tiktok = { connection: { connected: true, canUpload: false, canDirectPost: true, postMode: 'direct', audited: false } };
        assert.equal(Posts.tiktokOffersChoice(), false, 'publish only: direct, no choice');
        Posts.tiktok = { connection: { connected: true, canUpload: true, canDirectPost: false, postMode: 'inbox', audited: false } };
        assert.equal(Posts.tiktokOffersChoice(), false, 'upload only: inbox, no choice');
    });

    it('has no default, and blocks the submit until a delivery is chosen', () => {
        const { Posts } = load();
        Posts.tiktok = both(false);
        Posts._ttDelivery = '';
        assert.equal(Posts.tiktokEffectiveMode(), '');
        const blocked = Posts.attachTikTokOptions({ platform: 'tiktok' });
        assert.ok(blocked, 'must refuse to submit');
        assert.equal(blocked!.field, 'tiktok-delivery-direct');
    });

    it('sends { mode: "inbox" } for a draft, with none of the direct-post choices', () => {
        const { Posts } = load();
        Posts.tiktok = both(false);
        Posts._ttDelivery = 'inbox';
        const payload: Record<string, unknown> = { platform: 'tiktok' };
        assert.equal(Posts.attachTikTokOptions(payload), null);
        // The object comes from the page's vm realm, so compare by value, not prototype.
        assert.equal(JSON.stringify(payload.tiktok_options), JSON.stringify({ mode: 'inbox' }));
    });

    it('leaves an Instagram-only post alone', () => {
        const { Posts } = load();
        Posts.tiktok = both(false);
        const payload: Record<string, unknown> = { platform: 'instagram' };
        assert.equal(Posts.attachTikTokOptions(payload), null);
        assert.equal(payload.tiktok_options, undefined);
    });

    it('puts Download video on a TikTok card that is not live yet, and not on a published one', () => {
        const { Posts, t } = load();
        const base = {
            id: 'p9', platform: 'tiktok', post_type: 'video', caption: 'c',
            media_url: 'https://msg-response-auto.vercel.app/api/uploads/0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab',
            scheduled_time: '2027-03-04T18:20:00.000Z',
        };
        for (const status of ['PENDING', 'FAILED', 'PROCESSING', 'IN_INBOX']) {
            const card = String(Posts.renderScheduledCard({ ...base, status }));
            assert.ok(card.includes(t('posts.tiktok.download')), `${status}: download offered`);
            assert.ok(card.includes(' download>') || card.includes(' download '), `${status}: a real download link`);
        }
        const published = String(Posts.renderScheduledCard({ ...base, status: 'PUBLISHED' }));
        assert.ok(!published.includes(t('posts.tiktok.download')), 'published: nothing left to do by hand');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Carousel posts: the picker in the composer, how many slides each target takes, what the
 * submit sends, TikTok's options for photo posts, and the card. The backend is built in
 * parallel against a fixed API contract, so these pin the dashboard's half of it — through
 * the REAL submit handlers where the payload is concerned, with FormData and the upload
 * call stubbed rather than a copy of the payload logic.
 */

/** A slide already on the server, shaped as the page itself holds one. */
const readySlide = (id: string, url: string): Slide => ({ id, file: null, name: '', url, thumb: '', status: 'ready', error: '' });

/** `n` ready slides: s1 → https://cdn.test/1.jpg, … */
const readySlides = (n: number): Slide[] =>
    Array.from({ length: n }, (_, i) => readySlide(`s${i + 1}`, `https://cdn.test/${i + 1}.jpg`));

/** A form for the real submit handlers: what its FormData reads, and a submit button. */
function fakeForm(fields: Record<string, unknown>, id?: string): Record<string, unknown> {
    const button = { disabled: false, innerHTML: '' };
    return { fields, dataset: { id }, querySelector: () => button };
}

const submitEvent = { preventDefault: (): void => {} };

/** Let the upload queue's promise chains run out. */
async function settle(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** What the page sent, as a plain object of THIS realm (the page builds it in the vm's). */
const plainJson = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/** An element whose classList really holds classes, for the show/hide logic. */
type ClassyEl = FakeEl & { required?: boolean; has(cls: string): boolean };
function classyEl(id: string, props: Record<string, unknown> = {}): ClassyEl {
    const classes = new Set<string>();
    const el = fakeEl(id) as ClassyEl;
    el.classList = {
        toggle: (name: string, on?: boolean) => {
            const want = on === undefined ? !classes.has(name) : on;
            if (want) classes.add(name); else classes.delete(name);
        },
        add: (name: string) => { classes.add(name); },
        remove: (name: string) => { classes.delete(name); },
        contains: () => false,
    };
    el.has = (cls: string) => classes.has(cls);
    return Object.assign(el, props);
}

const photoCreator = {
    nickname: 'ElAmir',
    username: 'elamir.ai',
    avatarUrl: 'https://p16.tiktokcdn.com/avatar.jpg',
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoPostDurationSec: 600,
};

describe('PostsPage — the Carousel post type', () => {
    it('is offered for Instagram, Facebook, both and TikTok, labelled as the brief names it', () => {
        const { Posts, t, I18N } = load();
        for (const platform of ['instagram', 'facebook', 'both', 'tiktok']) {
            assert.equal(Posts.typeAllowedOn('carousel', platform), true, `carousel on ${platform}`);
            const option = String(Posts.typeOptions(platform, 'carousel')).match(/<option value="carousel"([^>]*)>([^<]*)<\/option>/);
            assert.ok(option, `${platform}: the option is rendered`);
            assert.ok(/\bselected\b/.test(option[1] ?? ''), `${platform}: and can be selected`);
            assert.ok(!/\b(hidden|disabled)\b/.test(option[1] ?? ''), `${platform}: and is not hidden`);
            assert.equal((option[2] ?? '').trim(), t('posts.type.carousel'));
        }
        assert.equal(t('posts.type.carousel'), 'كاروسيل (عدة صور)');
        I18N.lang = 'en';
        assert.equal(t('posts.type.carousel'), 'Carousel (multiple images)');
    });

    it('lets TikTok take a single image as well as a video — and still no story or text post', () => {
        const { Posts } = load();
        assert.equal(Posts.typeAllowedOn('image', 'tiktok'), true);
        assert.equal(Posts.typeAllowedOn('video', 'tiktok'), true);
        assert.equal(Posts.typeAllowedOn('story', 'tiktok'), false);
        assert.equal(Posts.typeAllowedOn('feed', 'tiktok'), false);
        assert.equal(Posts.typeAllowedOn('carousel', 'mastodon'), false);
    });

    it('gives the composer a multi-image picker that takes JPEG, PNG and WebP only', () => {
        const { Posts, dom } = load();
        dom.set('modal-overlay', fakeEl('modal-overlay'));
        dom.set('modal-content', fakeEl('modal-content'));
        Posts.showCreateModal();
        const markup = dom.get('modal-content')!.innerHTML;

        const picker = markup.match(/<input[^>]*id="post-carousel-file"[^>]*>/);
        assert.ok(picker, 'the carousel picker is in the composer');
        assert.ok(/\bmultiple\b/.test(picker[0]), 'it takes several files at once');
        assert.ok(picker[0].includes('accept="image/jpeg,image/png,image/webp"'));
        assert.ok(picker[0].includes('data-change="posts:pickSlides"'));
        // Hidden until the type is Carousel; the single field stays for everything else.
        assert.ok(markup.includes('<div class="form-group hidden" id="carousel-group">'));
        assert.ok(markup.includes('id="post-media-file"'));
        // And the collapsed 9:16 set for TikTok, with a picker of its own.
        assert.ok(/<details class="form-group slide-alt hidden" id="tiktok-slides-group">/.test(markup));
        assert.ok(markup.includes('id="post-tiktok-slides-file"'));
    });

    it('swaps the single media field for the picker, and back, as the type changes', () => {
        const { Posts, dom } = load();
        const el = (id: string, props: Record<string, unknown> = {}): ClassyEl => {
            const e = classyEl(id, props);
            dom.set(id, e);
            return e;
        };
        const type = el('post-type-select', { value: 'carousel' });
        el('post-platform-select', { value: 'instagram' });
        el('cover-url-group');
        const media = el('media-url-group');
        const carousel = el('carousel-group');
        const mediaInput = el('post-media-url', { required: true });
        const alsoGroup = el('tiktok-also-group');
        const also = el('post-also-tiktok', { checked: true });
        const ownSet = el('tiktok-slides-group');
        const title = el('tiktok-title-group');

        Posts.applyTypeMatrix();
        assert.equal(media.has('hidden'), true, 'the single field goes');
        assert.equal(carousel.has('hidden'), false, 'the picker comes');
        assert.equal(mediaInput.required, false, 'and the hidden field is not required');
        assert.equal(alsoGroup.has('hidden'), false, '"Also send to TikTok" is offered for a carousel');
        assert.equal(ownSet.has('hidden'), false, 'and with it on, TikTok’s own 9:16 set');
        assert.equal(title.has('hidden'), false, 'a photo post to TikTok has a title');

        type.value = 'video';
        Posts.applyTypeMatrix();
        assert.equal(media.has('hidden'), false);
        assert.equal(carousel.has('hidden'), true);
        assert.equal(mediaInput.required, true);
        assert.equal(ownSet.has('hidden'), true, 'TikTok’s own images belong to a carousel');
        assert.equal(title.has('hidden'), true, 'a video has no title field');

        type.value = 'story';
        Posts.applyTypeMatrix();
        assert.equal(alsoGroup.has('hidden'), true, 'TikTok takes no story');
        assert.equal(also.checked, false);
    });
});

describe('PostsPage — how many slides a carousel takes', () => {
    it('2-10 with Instagram or Facebook in it, 2-35 for TikTok alone, and 35 for TikTok’s own set', () => {
        const { Posts } = load();
        for (const platform of ['instagram', 'facebook', 'both']) {
            const limits = Posts.slideLimits('main', platform);
            assert.equal(limits.min, 2, platform);
            assert.equal(limits.max, 10, platform);
        }
        assert.equal(Posts.slideLimits('main', 'tiktok').max, 35);
        assert.equal(Posts.slideLimits('tiktok', 'both').max, 35, 'the sibling’s own images are a TikTok post');
    });

    it('accepts exactly the range, and names what is wrong outside it', () => {
        const { Posts, t } = load();
        const meta = Posts.slideLimits('main', 'instagram');
        const tiktok = Posts.slideLimits('main', 'tiktok');
        assert.ok(Posts.validateSlides(readySlides(2), meta).ok);
        assert.ok(Posts.validateSlides(readySlides(10), meta).ok);
        assert.ok(Posts.validateSlides(readySlides(35), tiktok).ok);

        const one = Posts.validateSlides(readySlides(1), meta);
        assert.equal(!one.ok && one.code, 'tooFew');
        assert.equal(!one.ok && one.message, t('posts.carousel.tooFew'));
        const none = Posts.validateSlides([], meta);
        assert.equal(!none.ok && none.code, 'tooFew', 'an empty carousel is too few, not fine');

        const eleven = Posts.validateSlides(readySlides(11), meta);
        assert.equal(!eleven.ok && eleven.message, t('posts.carousel.tooManyMeta', { max: 10, n: 11 }));
        assert.ok(t('posts.carousel.tooManyMeta', { max: 10, n: 11 }).includes('11'), 'and says how many there are');
        const thirtySix = Posts.validateSlides(readySlides(36), tiktok);
        assert.equal(!thirtySix.ok && thirtySix.message, t('posts.carousel.tooManyTikTok', { max: 35, n: 36 }));
    });

    it('refuses a slide that failed or is still on its way, even when the count is right', () => {
        const { Posts, t } = load();
        const meta = Posts.slideLimits('main', 'instagram');
        const failed = readySlides(3);
        failed[1]!.status = 'failed';
        const f = Posts.validateSlides(failed, meta);
        assert.equal(!f.ok && f.code, 'failed');
        assert.equal(!f.ok && f.message, t('posts.carousel.hasFailed'));

        for (const status of ['queued', 'preparing', 'uploading']) {
            const busy = readySlides(3);
            busy[2]!.status = status;
            busy[2]!.url = '';
            const b = Posts.validateSlides(busy, meta);
            assert.equal(!b.ok && b.code, 'uploading', status);
        }
    });

    it('lets TikTok’s own set be empty — the carousel’s images go instead — but not a single image', () => {
        const { Posts, t } = load();
        const limits = Posts.slideLimits('tiktok');
        const empty = Posts.validateSlides([], limits, { optional: true, own: true });
        assert.ok(empty.ok);
        assert.equal(JSON.stringify(empty.ok && empty.urls), '[]');
        const one = Posts.validateSlides(readySlides(1), limits, { optional: true, own: true });
        assert.equal(!one.ok && one.message, t('posts.carousel.tiktokTooFew'));
    });

    it('shows the count against the limit that applies: N/10, or N/35 for TikTok alone', () => {
        const { Posts } = load();
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(3));
        const count = (platform: string): string => String(Posts.slideCountMarkup('main', platform));
        assert.ok(count('instagram').includes('3/10'));
        assert.ok(count('both').includes('3/10'));
        assert.ok(count('tiktok').includes('3/35'));
        // Isolated, so "3/10" is not reordered by the Arabic around it.
        assert.ok(count('instagram').includes('<bdi class="ltr-text" dir="ltr">3/10</bdi>'));
    });

    it('blocks the submit outside the range, marks the picker, and sends nothing', async () => {
        const { Posts, dom, api, t } = load();
        const sent: unknown[] = [];
        api.createScheduledPost = (body: unknown) => { sent.push(body); return Promise.resolve({ id: 'n1' }); };
        const errorHost = fakeEl('post-form-error');
        dom.set('post-form-error', errorHost);
        const picker = fakeEl('post-carousel-file');
        dom.set('post-carousel-file', picker);

        const fields = { platform: 'both', post_type: 'carousel', caption: 'c', media_url: '', cover_url: '', scheduled_time: '2027-03-04T18:20' };
        for (const [n, message] of [
            [1, t('posts.carousel.tooFew')],
            [11, t('posts.carousel.tooManyMeta', { max: 10, n: 11 })],
        ] as Array<[number, string]>) {
            picker.removeAttribute('aria-invalid');
            Posts.resetSlides(null);
            Posts._slides!.main.push(...readySlides(n));
            await Posts.handleCreate(fakeForm(fields), submitEvent);
            assert.ok(errorHost.innerHTML.includes(message), `${n} slides: the reason is shown`);
            assert.equal(picker.getAttribute('aria-invalid'), 'true', `${n} slides: on the picker`);
        }
        assert.equal(sent.length, 0, 'nothing is sent outside the range');

        // The same eleven are fine for TikTok alone.
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(11));
        await Posts.handleCreate(fakeForm({ ...fields, platform: 'tiktok' }), submitEvent);
        assert.equal(sent.length, 1, 'TikTok takes eleven');
        assert.equal((plainJson(sent[0]).media_urls as unknown[]).length, 11);
    });
});

describe('PostsPage — carousel uploads', () => {
    type Upload = Record<string, unknown>;
    const file = (name: string, type = 'image/jpeg'): Record<string, unknown> => ({ name, type, size: 1000 });

    /**
     * The canvas step is not in this DOM, so `prepareSlideFile` is stubbed to what it
     * returns; the upload call is stubbed and recorded. With `manual`, each upload waits
     * until the test releases it, so the order they finish in is the test's to choose.
     */
    function uploader(Posts: PostsApi, api: Loaded['api'], manual: boolean): { uploads: Upload[]; release: Array<() => void> } {
        const uploads: Upload[] = [];
        const release: Array<() => void> = [];
        Posts.prepareSlideFile = async (f: unknown) => {
            const name = String((f as { name: string }).name);
            return { dataUrl: `data:image/jpeg;base64,${Buffer.from(name).toString('base64')}`, thumb: '', name: Posts.jpegFileName(name) };
        };
        api.uploadMedia = (body: unknown) => {
            const b = body as Upload;
            uploads.push(b);
            const answer = { url: `https://cdn.test/${String(b.filename)}` };
            if (!manual) return Promise.resolve(answer);
            return new Promise((resolve) => { release.push(() => resolve(answer)); });
        };
        return { uploads, release };
    }

    const platform = (dom: Map<string, FakeEl>, value: string): void => {
        dom.set('post-platform-select', Object.assign(fakeEl('post-platform-select'), { value }));
    };

    it('uploads each picked image as a JPEG, one call each, and keeps pick order when they finish out of order', async () => {
        const { Posts, api, dom } = load();
        platform(dom, 'instagram');
        const { uploads, release } = uploader(Posts, api, true);
        Posts.resetSlides(null);
        Posts._uploadsInFlight = 0;
        const input = {
            dataset: { picker: 'main' },
            files: [file('one.png', 'image/png'), file('two.webp', 'image/webp'), file('three.jpg')],
            value: 'C:\\fakepath\\one.png',
        };
        Posts.pickSlides(input);
        assert.equal(input.value, '', 'the input is cleared, so the same file can be picked again');
        assert.equal(Posts._uploadsInFlight, 3, 'every queued slide holds the submit');

        await settle();
        assert.equal(uploads.length, 2, 'two at a time; the third waits for a free slot');
        release[1]!();              // the SECOND finishes first
        await settle();
        release[0]!();
        await settle();
        assert.equal(uploads.length, 3);
        release[2]!();
        await settle();

        const slides = Posts._slides!.main;
        assert.equal(JSON.stringify(slides.map((s) => s.status)), JSON.stringify(['ready', 'ready', 'ready']));
        assert.equal(JSON.stringify(slides.map((s) => s.url)), JSON.stringify([
            'https://cdn.test/one.jpg', 'https://cdn.test/two.jpg', 'https://cdn.test/three.jpg',
        ]), 'slide order is pick order, not finishing order');
        for (const u of uploads) {
            assert.equal(u.mime_type, 'image/jpeg', 'Instagram takes JPEG only');
            assert.ok(String(u.filename).endsWith('.jpg'));
            assert.ok(String(u.base64_data).startsWith('data:image/jpeg;base64,'));
        }
        assert.equal(Posts._uploadsInFlight, 0, 'and the submit is released');
    });

    it('takes only as many as the target has room for, and says how many it left out', async () => {
        const { Posts, api, dom, toasts, t } = load();
        platform(dom, 'both');
        uploader(Posts, api, false);
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(8));
        Posts.pickSlides({ dataset: { picker: 'main' }, files: ['a', 'b', 'c', 'd', 'e'].map((n) => file(`${n}.jpg`)), value: '' });
        await settle();
        assert.equal(Posts._slides!.main.length, 10, 'room for two');
        assert.ok(toasts.some((x) => x.type === 'error' && x.message === t('posts.carousel.skipped', { count: 3, max: 10 })));

        // TikTok alone has room for 35.
        platform(dom, 'tiktok');
        Posts.pickSlides({ dataset: { picker: 'main' }, files: ['f', 'g', 'h'].map((n) => file(`${n}.jpg`)), value: '' });
        await settle();
        assert.equal(Posts._slides!.main.length, 13);
    });

    it('refuses a file that is not JPEG, PNG or WebP, by name, and takes the rest', () => {
        const { Posts, api, dom, toasts, t } = load();
        platform(dom, 'instagram');
        uploader(Posts, api, false);
        Posts.resetSlides(null);
        Posts.pickSlides({ dataset: { picker: 'main' }, files: [file('moving.gif', 'image/gif'), file('ok.png', 'image/png')], value: '' });
        assert.equal(Posts._slides!.main.length, 1);
        assert.ok(toasts.some((x) => x.message === t('posts.carousel.notImage', { name: 'moving.gif' })));
    });

    it('a failed upload fails its own tile, gives the submit back, and can be retried', async () => {
        const { Posts, api, dom, toasts } = load();
        platform(dom, 'instagram');
        let attempt = 0;
        Posts.prepareSlideFile = async () => ({ dataUrl: 'data:image/jpeg;base64,AA==', thumb: '', name: 'a.jpg' });
        api.uploadMedia = () => {
            attempt += 1;
            return attempt === 1 ? Promise.reject(new Error('HTTP 502')) : Promise.resolve({ url: 'https://cdn.test/a.jpg' });
        };
        Posts.resetSlides(null);
        Posts._uploadsInFlight = 0;
        Posts.pickSlides({ dataset: { picker: 'main' }, files: [file('a.png', 'image/png')], value: '' });
        await settle();

        const slide = Posts._slides!.main[0];
        assert.ok(slide);
        assert.equal(slide.status, 'failed');
        assert.equal(slide.error, 'HTTP 502');
        assert.equal(Posts._uploadsInFlight, 0, 'a failure does not hold the submit');
        assert.ok(toasts.some((x) => x.type === 'error' && x.message.includes('HTTP 502')), 'one toast, with the reason');
        assert.ok(String(Posts.slideTile('main', slide, 0, 1)).includes('data-action="posts:retrySlide"'), 'the tile offers a retry');

        Posts.retrySlide('main', slide.id);
        await settle();
        assert.equal(slide.status, 'ready');
        assert.equal(slide.url, 'https://cdn.test/a.jpg');
    });

    it('an upload the last modal left running can neither land in this one nor release its submit', async () => {
        const { Posts, api, dom } = load();
        platform(dom, 'instagram');
        const { release } = uploader(Posts, api, true);
        Posts.resetSlides(null);
        Posts._uploadsInFlight = 0;
        Posts.pickSlides({ dataset: { picker: 'main' }, files: [file('old.jpg')], value: '' });
        await settle();

        // The modal closes and a new one opens while that upload is still out.
        Posts.resetSlides(null);
        Posts._uploadsInFlight = 0;
        Posts.pickSlides({ dataset: { picker: 'main' }, files: [file('new.jpg')], value: '' });
        await settle();
        assert.equal(Posts._uploadsInFlight, 1);

        release[0]!();   // the OLD upload lands
        await settle();
        assert.equal(Posts._uploadsInFlight, 1, 'still held for this modal’s own upload');
        assert.equal(JSON.stringify(Posts._slides!.main.map((s) => s.name)), JSON.stringify(['new.jpg']));

        release[1]!();
        await settle();
        assert.equal(Posts._uploadsInFlight, 0);
        assert.equal(Posts._slides!.main[0]!.url, 'https://cdn.test/new.jpg');
    });

    it('prepares: a JPEG within 1440px and the cap goes as-is; anything else is re-encoded, never upscaled', () => {
        const { Posts, api } = load();
        const cap = 3.2 * 1024 * 1024;
        // The cap dashboard/js/api.js declares; the stubbed API here would answer with a function.
        (api as unknown as Record<string, unknown>).MAX_UPLOAD_BYTES = cap;
        assert.equal(Posts.slideNeedsReencode({ type: 'image/jpeg', size: 1000 }, 1440), false);
        assert.equal(Posts.slideNeedsReencode({ type: 'image/jpeg', size: 1000 }, 1441), true, 'wider than 1440px');
        assert.equal(Posts.slideNeedsReencode({ type: 'image/jpeg', size: cap + 1 }, 800), true, 'over the upload cap');
        assert.equal(Posts.slideNeedsReencode({ type: 'image/png', size: 1000 }, 800), true, 'a PNG becomes a JPEG');
        assert.equal(Posts.slideNeedsReencode({ type: 'image/webp', size: 1000 }, 800), true, 'so does a WebP');

        const size = (w: number, h: number): string => JSON.stringify(Posts.slideTargetSize(w, h));
        assert.equal(size(4000, 3000), JSON.stringify({ width: 1440, height: 1080 }));
        assert.equal(size(3000, 4000), JSON.stringify({ width: 1440, height: 1920 }));
        assert.equal(size(1080, 1920), JSON.stringify({ width: 1080, height: 1920 }), 'a 9:16 phone shot is not wider than 1440');
        assert.equal(size(800, 600), JSON.stringify({ width: 800, height: 600 }), 'never upscaled');

        assert.equal(Posts.jpegFileName('IMG_2041.PNG'), 'IMG_2041.jpg');
        assert.equal(Posts.jpegFileName('cover.final.webp'), 'cover.final.jpg');
        assert.equal(Posts.jpegFileName(''), 'slide.jpg');
    });
});

describe('PostsPage — slide order', () => {
    /** One button of a tile, whole: its opening tag and what is inside it. */
    function button(markup: string, dir: string): string {
        const m = markup.match(new RegExp(`<button[^>]*data-dir="${dir}"[^>]*>[\\s\\S]*?</button>`));
        assert.ok(m, `the ${dir} button is rendered`);
        return m[0];
    }

    it('move earlier and move later swap neighbours; the first cannot go earlier, nor the last later', () => {
        const { Posts, t } = load();
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(3));
        const order = (): string => JSON.stringify(Posts._slides!.main.map((s) => s.id));
        Posts.moveSlide('main', 's3', -1);
        assert.equal(order(), JSON.stringify(['s1', 's3', 's2']));
        Posts.moveSlide('main', 's1', 1);
        assert.equal(order(), JSON.stringify(['s3', 's1', 's2']));
        Posts.moveSlide('main', 's3', -1);   // already first
        Posts.moveSlide('main', 's2', 1);    // already last
        assert.equal(order(), JSON.stringify(['s3', 's1', 's2']), 'the ends do not wrap');

        const [first, , last] = Posts._slides!.main;
        const firstTile = String(Posts.slideTile('main', first!, 0, 3));
        const lastTile = String(Posts.slideTile('main', last!, 2, 3));
        assert.ok(/\bdisabled\b/.test(button(firstTile, '-1')), 'slide 1 cannot move earlier');
        assert.ok(!/\bdisabled\b/.test(button(firstTile, '1')));
        assert.ok(/\bdisabled\b/.test(button(lastTile, '1')), 'the last slide cannot move later');
        // Numbered, and every button names its slide.
        assert.ok(firstTile.includes('<span class="slide-num" aria-hidden="true">1</span>'));
        assert.ok(button(firstTile, '1').includes(`aria-label="${t('posts.carousel.moveLater', { n: 1 })}"`));
    });

    it('points each arrow where its slide goes, in Arabic as in English', () => {
        // "Earlier" is arrow-left and "later" arrow-right. The strip flows from the inline
        // start, so under RTL slide 1 is on the right — and the stylesheet mirrors both
        // arrows there, so "earlier" points right. Unmirrored it would point at the END.
        const { Posts } = load();
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(2));
        const tile = String(Posts.slideTile('main', Posts._slides!.main[0]!, 0, 2));
        assert.ok(button(tile, '-1').includes('data-lucide="arrow-left"'), 'earlier is arrow-left');
        assert.ok(button(tile, '1').includes('data-lucide="arrow-right"'), 'later is arrow-right');
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        for (const icon of ['arrow-left', 'arrow-right']) {
            assert.ok(css.includes(`html[dir='rtl'] [data-lucide='${icon}']`), `${icon} mirrors under RTL`);
        }
    });

    it('remove drops the slide, and the rest renumber', () => {
        const { Posts, t } = load();
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(3));
        Posts.removeSlide('main', 's2');
        assert.equal(JSON.stringify(Posts._slides!.main.map((s) => s.url)), JSON.stringify(['https://cdn.test/1.jpg', 'https://cdn.test/3.jpg']));
        const second = String(Posts.slideTile('main', Posts._slides!.main[1]!, 1, 2));
        assert.ok(second.includes(`aria-label="${t('posts.carousel.remove', { n: 2 })}"`), 'the old slide 3 is slide 2 now');
    });
});

describe('PostsPage — the carousel payload on submit', () => {
    const fields = {
        platform: 'instagram', post_type: 'carousel', caption: 'سطر العنوان\nبقية النص',
        media_url: 'https://stale.test/single.jpg', cover_url: '', scheduled_time: '2027-03-04T18:20',
    };

    function capture(api: Loaded['api']): unknown[] {
        const sent: unknown[] = [];
        api.createScheduledPost = (body: unknown) => {
            sent.push(body);
            return Promise.resolve({ id: 'n1', platform: 'instagram', status: 'PENDING' });
        };
        return sent;
    }

    it('sends media_urls in slide order after a move — and no media_url, which the server sets itself', async () => {
        const { Posts, api, UI } = load();
        const sent = capture(api);
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(3));
        Posts.moveSlide('main', 's3', -1);
        await Posts.handleCreate(fakeForm(fields), submitEvent);

        assert.equal(sent.length, 1);
        const body = plainJson(sent[0]);
        assert.equal(JSON.stringify(body.media_urls), JSON.stringify(['https://cdn.test/1.jpg', 'https://cdn.test/3.jpg', 'https://cdn.test/2.jpg']));
        assert.equal('media_url' in body, false, 'a stale single-media value never rides along');
        assert.equal(body.post_type, 'carousel');
        assert.equal(body.platform, 'instagram');
        assert.equal(body.cover_url, null);
        assert.equal(body.scheduled_time, UI.fromLocalInputValue('2027-03-04T18:20'));
        assert.equal('tiktok_options' in body, false);
        assert.equal('tiktok_media_urls' in body, false);
    });

    it('"Also send to TikTok" sends the same images by default, and tiktok_media_urls when TikTok has its own', async () => {
        const { Posts, api, dom, t } = load();
        const sent = capture(api);
        // An inbox-only connection: a photo post's options are its title and nothing else.
        Posts.tiktok = { connection: { connected: true, canUpload: true, postMode: 'inbox' } };
        Posts.resetTikTokComposer(null);
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(3));
        Posts._ttTitle = 'سطر العنوان';
        const carousel = readySlides(3).map((s) => s.url);

        await Posts.handleCreate(fakeForm({ ...fields, platform: 'both', also_tiktok: 'on' }), submitEvent);
        const same = plainJson(sent[0]);
        assert.equal(same.also_tiktok, true);
        assert.equal(JSON.stringify(same.media_urls), JSON.stringify(carousel));
        assert.equal('tiktok_media_urls' in same, false, 'no set of its own: the sibling takes the carousel’s images');
        assert.equal(JSON.stringify(same.tiktok_options), JSON.stringify({ mode: 'inbox', title: 'سطر العنوان' }));

        Posts._slides!.tiktok.push(readySlide('t1', 'https://cdn.test/tall-1.jpg'), readySlide('t2', 'https://cdn.test/tall-2.jpg'));
        await Posts.handleCreate(fakeForm({ ...fields, platform: 'both', also_tiktok: 'on' }), submitEvent);
        const own = plainJson(sent[1]);
        assert.equal(JSON.stringify(own.tiktok_media_urls), JSON.stringify(['https://cdn.test/tall-1.jpg', 'https://cdn.test/tall-2.jpg']));
        assert.equal(JSON.stringify(own.media_urls), JSON.stringify(carousel), 'the carousel keeps its own images');

        // Without the switch, TikTok's set is never sent.
        await Posts.handleCreate(fakeForm({ ...fields, platform: 'both' }), submitEvent);
        const metaOnly = plainJson(sent[2]);
        assert.equal('also_tiktok' in metaOnly, false);
        assert.equal('tiktok_media_urls' in metaOnly, false);

        // A TikTok set of one is refused, on its own picker.
        dom.set('post-form-error', fakeEl('post-form-error'));
        Posts._slides!.tiktok.splice(1);
        await Posts.handleCreate(fakeForm({ ...fields, platform: 'both', also_tiktok: 'on' }), submitEvent);
        assert.equal(sent.length, 3);
        assert.ok(dom.get('post-form-error')!.innerHTML.includes(t('posts.carousel.tiktokTooFew')));
    });

    it('a TikTok-only carousel sends media_urls and direct options with its title and music — never Duet or Stitch', async () => {
        const { Posts, api } = load();
        const sent = capture(api);
        Posts.tiktok = { connection: { connected: true, canUpload: false, canDirectPost: true, postMode: 'direct', audited: true } };
        Posts.resetTikTokComposer(null);
        Posts.tiktokCreator = { status: 'ready', data: { postMode: 'direct', audited: true, creator: photoCreator } };
        Posts._ttChoices = {
            ...Posts.TIKTOK_DEFAULT_CHOICES, privacy_level: 'PUBLIC_TO_EVERYONE',
            allow_comment: true, allow_duet: true, allow_stitch: true, consent: true,
        };
        Posts._ttTitle = 'سطر العنوان';
        Posts.resetSlides(null);
        Posts._slides!.main.push(...readySlides(12));

        await Posts.handleCreate(fakeForm({ ...fields, platform: 'tiktok' }), submitEvent);
        assert.equal(sent.length, 1, 'twelve is fine for TikTok alone');
        const body = plainJson(sent[0]);
        assert.equal((body.media_urls as unknown[]).length, 12);
        assert.deepEqual(body.tiktok_options, {
            privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: true,
            brand_organic: false, brand_content: false, is_aigc: false, consent: true,
            auto_add_music: true, mode: 'direct', title: 'سطر العنوان',
        });
        const options = body.tiktok_options as Record<string, unknown>;
        assert.equal('allow_duet' in options, false, 'TikTok has no Duet for photos');
        assert.equal('allow_stitch' in options, false, 'nor Stitch');
    });

    it('editing a carousel starts from its saved slides, in order, and sends the new order', async () => {
        const { Posts, api, dom } = load();
        dom.set('modal-overlay', fakeEl('modal-overlay'));
        dom.set('modal-content', fakeEl('modal-content'));
        const urls = ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg', 'https://cdn.test/c.jpg'];
        Posts.posts = [{
            id: 'c1', platform: 'instagram', post_type: 'carousel', status: 'PENDING', caption: 'c',
            media_url: urls[0], media_urls: urls, scheduled_time: '2027-03-04T18:20:00.000Z',
        }];
        Posts.showEditModal('c1');
        const markup = dom.get('modal-content')!.innerHTML;
        const shown = [...markup.matchAll(/<li class="slide-tile[^"]*"[\s\S]*?<img src="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(JSON.stringify(shown), JSON.stringify(urls), 'the saved slides, in order');

        const put: Array<{ id: unknown; body: unknown }> = [];
        api.updateScheduledPost = (id: unknown, body: unknown) => { put.push({ id, body }); return Promise.resolve({}); };
        Posts.moveSlide('main', Posts._slides!.main[2]!.id, -1);
        await Posts.handleEdit(fakeForm({ ...fields, caption: 'نص جديد', media_url: urls[0] }, 'c1'), submitEvent);

        assert.equal(put.length, 1);
        assert.equal(put[0]!.id, 'c1');
        const body = plainJson(put[0]!.body);
        assert.equal(JSON.stringify(body.media_urls), JSON.stringify([urls[0], urls[2], urls[1]]));
        assert.equal(body.caption, 'نص جديد');
        assert.equal('media_url' in body, false);
    });
});

describe('PostsPage — TikTok options for photo posts', () => {
    const photo = { audited: true, photo: true };

    it('drops Duet and Stitch, and adds "Auto-add music", on by default', () => {
        const { Posts, t } = load();
        const form = String(Posts.tiktokDirectForm(Posts.tiktokDirectState(photoCreator, null, photo)));
        assert.ok(!form.includes('id="tiktok-allow-duet"'), 'no Duet for photos');
        assert.ok(!form.includes('id="tiktok-allow-stitch"'), 'no Stitch for photos');
        assert.ok(form.includes('id="tiktok-allow-comment"'), 'comments stay');
        const music = form.match(/<input[^>]*id="tiktok-auto-music"[^>]*>/);
        assert.ok(music, 'the music switch is there');
        assert.ok(/\bchecked\b/.test(music[0]), 'and on by default');
        assert.ok(form.includes(t('posts.tiktok.direct.autoMusic')));
        assert.ok(!form.includes('tiktok-duration-note'), 'and no video length limit');

        // The video form is as it was: Duet, Stitch, no music.
        const video = String(Posts.tiktokDirectForm(Posts.tiktokDirectState(photoCreator, null, { audited: true })));
        assert.ok(video.includes('id="tiktok-allow-duet"') && video.includes('id="tiktok-allow-stitch"'));
        assert.ok(!video.includes('id="tiktok-auto-music"'));
    });

    it('keeps privacy with no default, comments off, disclosure and consent — worded for a post, not a video', () => {
        const { Posts, t } = load();
        const state = Posts.tiktokDirectState(photoCreator, null, photo);
        assert.equal(state.privacy, '');
        assert.equal(state.comment.checked, false);
        const form = String(Posts.tiktokDirectForm(state));
        assert.ok(form.includes(t('posts.tiktok.direct.privacyPhoto')));
        assert.ok(form.includes(t('posts.tiktok.direct.disclose')));
        const consent = String(Posts.tiktokConsentBlock(state));
        assert.ok(consent.includes(t('posts.tiktok.direct.consentPhoto')));
        assert.ok(!consent.includes(t('posts.tiktok.direct.consent')), 'not "this video"');
        assert.ok(consent.includes('music-usage-confirmation'), 'the declaration is still above the submit');

        const missing = Posts.validateTikTokOptions(photoCreator, { privacy_level: 'PUBLIC_TO_EVERYONE' }, photo);
        assert.equal(!missing.ok && missing.message, t('posts.tiktok.direct.consentRequiredPhoto'));
    });

    it('sends no allow_duet or allow_stitch for photos, and auto_add_music as chosen', () => {
        const { Posts } = load();
        const chosen = { privacy_level: 'PUBLIC_TO_EVERYONE', consent: true, allow_duet: true, allow_stitch: true };
        const on = Posts.validateTikTokOptions(photoCreator, chosen, photo);
        assert.ok(on.ok);
        assert.deepEqual(JSON.parse(JSON.stringify(on.ok && on.options)), {
            privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: false,
            brand_organic: false, brand_content: false, is_aigc: false, consent: true, auto_add_music: true,
        });
        const off = Posts.validateTikTokOptions(photoCreator, { ...chosen, auto_add_music: false }, photo);
        assert.equal(off.ok && off.options.auto_add_music, false);
        // A long "video" length means nothing to a photo post.
        assert.ok(Posts.validateTikTokOptions(photoCreator, chosen, { ...photo, durationSec: 9999 }).ok);
    });

    it('offers the delivery choice exactly as for video, and a draft sends only its mode and title', () => {
        const { Posts, dom } = load();
        Posts.tiktok = { connection: { connected: true, canUpload: true, canDirectPost: true, postMode: 'direct', audited: false } };
        Posts._ttDelivery = '';
        const blocked = Posts.attachTikTokOptions({ platform: 'tiktok', post_type: 'carousel' });
        assert.equal(blocked && blocked.field, 'tiktok-delivery-direct', 'no default delivery for photos either');

        Posts._ttDelivery = 'inbox';
        const title = Object.assign(fakeEl('tiktok-title'), { value: 'عنوان الصور' });
        dom.set('tiktok-title', title);
        const draft: Record<string, unknown> = { platform: 'tiktok', post_type: 'image' };
        assert.equal(Posts.attachTikTokOptions(draft), null);
        assert.equal(JSON.stringify(draft.tiktok_options), JSON.stringify({ mode: 'inbox', title: 'عنوان الصور' }));

        // An empty title is left out: the server then takes the caption's first line.
        title.value = '   ';
        const untitled: Record<string, unknown> = { platform: 'tiktok', post_type: 'image' };
        assert.equal(Posts.attachTikTokOptions(untitled), null);
        assert.equal(JSON.stringify(untitled.tiktok_options), JSON.stringify({ mode: 'inbox' }));
    });

    it('the title: from the caption’s first line, following it until edited, counted in UTF-16 units', () => {
        const { Posts, dom } = load();
        assert.equal(Posts.tiktokTitleFromCaption('  أول سطر  \nالسطر الثاني'), 'أول سطر');
        assert.equal(Posts.tiktokTitleFromCaption('x'.repeat(120)).length, 90, 'clipped to what TikTok takes');
        // Never half an emoji: 89 letters and one 2-unit emoji is 91 units, and the cut drops the emoji whole.
        assert.equal(Posts.clipUtf16(`${'a'.repeat(89)}😀`, 90), 'a'.repeat(89));

        const input = fakeEl('tiktok-title');
        const count = fakeEl('tiktok-title-count');
        dom.set('tiktok-title', input);
        dom.set('tiktok-title-count', count);
        Posts.resetTikTokComposer(null);
        Posts.onCaptionInput({ value: 'عرض اليوم\nالتفاصيل' });
        assert.equal(input.value, 'عرض اليوم', 'it follows the caption');
        assert.ok(count.innerHTML.includes('9/90'), `the count is the title’s .length: ${count.innerHTML}`);

        Posts.onTikTokTitle({ value: 'عنواني' });
        input.value = 'عنواني';
        Posts.onCaptionInput({ value: 'نص آخر' });
        assert.equal(input.value, 'عنواني', 'an edited title is the operator’s: the caption no longer overwrites it');

        // Emptied, it hands itself back to the caption.
        Posts.onTikTokTitle({ value: '' });
        Posts.onCaptionInput({ value: 'نص آخر' });
        assert.equal(input.value, 'نص آخر');

        // `.length` counts UTF-16 units, as TikTok's limit does: one emoji is 2.
        assert.ok(String(Posts.titleCountMarkup('😀')).includes('2/90'));
    });

    it('blocks a title over 90, on its own field', () => {
        const { Posts, dom, t } = load();
        Posts.tiktok = { connection: { connected: true, canUpload: true, postMode: 'inbox' } };
        dom.set('tiktok-title', Object.assign(fakeEl('tiktok-title'), { value: 'ت'.repeat(91) }));
        const blocked = Posts.attachTikTokOptions({ platform: 'tiktok', post_type: 'carousel' });
        assert.ok(blocked);
        assert.equal(blocked.field, 'tiktok-title');
        assert.equal(blocked.message, t('posts.tiktok.titleTooLong', { max: 90, n: 91 }));
        assert.ok(Posts.validateTikTokTitle('ت'.repeat(90)).ok, 'exactly 90 is fine');
        // A video has no title field, so there is no title to check.
        assert.equal(Posts.attachTikTokOptions({ platform: 'tiktok', post_type: 'video' }), null);
    });

    it('an edit starts from the saved title and music choice, and a row without a title from its caption', () => {
        const { Posts } = load();
        Posts.resetTikTokComposer({
            platform: 'tiktok', post_type: 'carousel', caption: 'سطر\nثان',
            platform_options: { mode: 'inbox', title: 'العنوان المحفوظ' },
        });
        assert.equal(Posts._ttTitle, 'العنوان المحفوظ');
        assert.equal(Posts._ttTitleTouched, true, 'a saved title is the operator’s own');
        assert.equal(Posts._ttPhoto, true);

        Posts.resetTikTokComposer({ platform: 'tiktok', post_type: 'image', caption: 'سطر\nثان', platform_options: null });
        assert.equal(Posts._ttTitle, 'سطر');
        assert.equal(Posts._ttTitleTouched, false);

        assert.equal(Posts.tiktokChoicesFrom({ mode: 'direct', privacy_level: 'SELF_ONLY', auto_add_music: false }).auto_add_music, false);
        assert.equal(Posts.tiktokChoicesFrom({ mode: 'direct', privacy_level: 'SELF_ONLY' }).auto_add_music, true);
    });
});

describe('PostsPage — carousel cards', () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://msg-response-auto.vercel.app/api/uploads/0b8a7a0e-3c1f-4f7e-9d0a-00000000000${i}`);
    const row = {
        id: 'k1', platform: 'instagram', post_type: 'carousel', status: 'PENDING', caption: 'c',
        media_url: urls[0], media_urls: urls, scheduled_time: '2027-03-04T18:20:00.000Z',
    };

    it('says Carousel · N, and shows the first four slides plus +N', () => {
        const { Posts, t } = load();
        const card = String(Posts.renderScheduledCard(row));
        assert.equal(t('posts.carousel.badge', { n: 7 }), 'كاروسيل · 7');
        assert.ok(card.includes(t('posts.carousel.badge', { n: 7 })));
        const thumbs = [...card.matchAll(/<li class="post-slide">\s*<img src="([^"]+)"/g)].map((m) => m[1]);
        assert.equal(JSON.stringify(thumbs), JSON.stringify(urls.slice(0, 4)), 'the first four, in order');
        assert.ok(card.includes('<bdi class="ltr-text" dir="ltr">+3</bdi>'), '+3 for the rest, isolated from the Arabic');
        assert.ok(card.includes(t('posts.carousel.more', { count: 3 })), 'and said in words');
        assert.ok(!card.includes('post-media-frame'), 'not a single-image frame as well');

        const small = String(Posts.renderScheduledCard({ ...row, media_urls: urls.slice(0, 3) }));
        assert.equal([...small.matchAll(/<li class="post-slide">/g)].length, 3);
        assert.ok(!small.includes('post-slide-more'), 'nothing more to count');
        // Every other row is exactly as before.
        const single = String(Posts.renderScheduledCard({ ...row, post_type: 'image', media_urls: null }));
        assert.ok(single.includes('post-media-frame'));
        assert.ok(!single.includes('post-slides'));
    });

    it('a TikTok photo post not yet live: every image a real download, in order, plus Download all and Copy caption', () => {
        const { Posts, t } = load();
        const card = String(Posts.renderScheduledCard({ ...row, platform: 'tiktok' }));
        const links = [...card.matchAll(/<a class="btn btn-secondary btn-sm" href="([^"]+)" download="([^"]+)" data-slide-download/g)];
        assert.equal(JSON.stringify(links.map((m) => m[1])), JSON.stringify(urls), 'every image, in slide order');
        assert.equal(JSON.stringify(links.map((m) => m[2])), JSON.stringify(urls.map((_, i) => `slide-0${i + 1}`)), 'named to sort in order');
        assert.ok(card.includes('data-action="posts:downloadAll"'));
        assert.ok(card.includes(t('posts.tiktok.downloadAll')));
        assert.ok(card.includes(`data-copy="${row.caption}"`), 'Copy caption');
        assert.ok(!card.includes(t('posts.tiktok.download')), 'not "Download video"');

        const one = String(Posts.renderScheduledCard({ ...row, platform: 'tiktok', post_type: 'image', media_urls: null }));
        assert.ok(one.includes(t('posts.tiktok.downloadImage')));
        assert.ok(one.includes(`href="${urls[0]}" download="slide-01"`));
        assert.ok(!one.includes('data-action="posts:downloadAll"'), 'one image has nothing to download "all" of');

        const live = String(Posts.renderScheduledCard({ ...row, platform: 'tiktok', status: 'PUBLISHED' }));
        assert.ok(!live.includes('data-slide-download'), 'published: nothing left to do by hand');
    });

    it('Download all clicks the kit’s own anchors in order, and holds its button until the last', async () => {
        const { Posts } = load();
        Posts.DOWNLOAD_SPACING_MS = 0;
        const clicked: string[] = [];
        const anchors = ['a', 'b', 'c'].map((name) => ({ click: (): void => { clicked.push(name); } }));
        const kit = { querySelectorAll: (sel: string) => (sel === 'a[data-slide-download]' ? anchors : []) };
        const trigger = Object.assign(fakeEl('download-all'), {
            closest: (sel: string) => (sel === '[data-photo-kit]' ? kit : null),
            style: {},
        });
        Posts.downloadAll(trigger);
        assert.equal(trigger.disabled, true, 'held while the downloads fire');
        await settle(3);
        assert.equal(JSON.stringify(clicked), JSON.stringify(['a', 'b', 'c']));
        assert.equal(trigger.disabled, false, 'and released after the last');
    });
});

// ─── Carousel Studio (#/studio) ──────────────────────────────────────────────
/**
 * The Studio page is loaded on its own, with the router, the confirm dialog and
 * the API all recorded: what matters here is what the page SENDS (DraftInput,
 * PATCH, schedule, settings) and what it says when the server refuses, so the
 * stubs keep every call and the tests read the real handlers' output.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface StudioApi {
    render(): Promise<void>;
    destroy(): void;
    status: Json;
    settings: Json;
    lessons: Json[];
    selected: string[];
    plan: Json;
    work: Json;
    draft: Json;
    settingsWork: Json;
    newWorker: Json;
    workers: Json[];
    newError: Json;
    plannedSlots: Record<string, string>;
    ANGLES: string[];
    SLIDE_KINDS: string[];
    CTA_SLIDE_KEYS: string[];
    statusMarkup(): { toString(): string };
    isDirty(): boolean;
    toggleLesson(id: string): void;
    generate(form: unknown, event: unknown): Promise<void>;
    planWeek(el: unknown): Promise<void>;
    toggleProposal(key: string): void;
    generateAll(): Promise<void>;
    slideField(el: unknown): void;
    metaField(el: unknown): void;
    keywordField(el: unknown): void;
    campaignField(el: unknown): void;
    campaignToggle(el: unknown): void;
    moveSlide(index: unknown, delta: number): void;
    pickShot(el: unknown): void;
    save(el?: unknown): Promise<void>;
    problemTarget(message: string): Json;
    readSchedule(form: unknown): Json;
    schedule(form: unknown, event: unknown): Promise<void>;
    confirmTikTokBatch(): void;
    setting(el: unknown): void;
    addListItem(path: string): void;
    removeListItem(path: string, index: unknown): void;
    addSwatch(): void;
    removeSwatch(index: unknown): void;
    saveSettings(form: unknown, event: unknown): Promise<void>;
    createWorker(form: unknown, event: unknown): Promise<void>;
    copyToken(): Promise<void>;
    dismissToken(): void;
}

interface StudioLoaded {
    Studio: StudioApi;
    t: Translate;
    I18N: { lang: string; strings: Record<string, Record<string, string>> };
    dom: Map<string, FakeEl>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    confirms: Array<Record<string, Json>>;
    nav: Array<{ page: string; params?: Record<string, unknown> }>;
    toasts: Array<{ message: string; type?: string }>;
    copied: string[];
    hash: Record<string, string>;
    /** The page's localStorage. */
    storage: FakeStorage;
    /** The stubbed App, e.g. to say which page is current. */
    app: Record<string, unknown>;
    /** A fake host for a region the page repaints by id; its innerHTML is what was painted. */
    host(id: string): FakeEl;
}

function unrefTimer<T>(handle: T): T {
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
}

/** A Map-backed localStorage: the page's per-browser memory, readable by the test. */
interface FakeStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    keys(): string[];
}

function fakeStorage(): FakeStorage {
    const map = new Map<string, string>();
    return {
        getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
        keys: () => [...map.keys()],
    };
}

function loadStudio(hash: Record<string, string> = {}, storage: FakeStorage = fakeStorage()): StudioLoaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const confirms: Array<Record<string, Json>> = [];
    const nav: Array<{ page: string; params?: Record<string, unknown> }> = [];
    const copied: string[] = [];
    const stubEl = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null,
        removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
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
        // The page's 15s status refresh and 4s render poll are cleared by destroy(),
        // which a test that fails part-way never reaches. Unref'd, a leftover timer
        // cannot hold this file's process open, so a failure is a failure, not a hang.
        Intl, console, clearTimeout, clearInterval,
        setTimeout: (fn: () => void, ms?: number) => unrefTimer(setTimeout(fn, ms)),
        setInterval: (fn: () => void, ms?: number) => unrefTimer(setInterval(fn, ms)),
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: 'ar', clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_icon: string, title: string) => title, confirm: (o: Record<string, Json>) => { confirms.push(o); } },
        App: {
            currentTheme: () => 'auto', navigate: noop,
            hashParam: (name: string) => hash[name] || '',
            go: (page: string) => { nav.push({ page }); },
            goWithQuery: (page: string, params: Record<string, unknown>) => { nav.push({ page, params }); },
        },
        FormData: FakeFormData,
        localStorage: storage,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js',
        'dashboard/js/motion.js',
        'dashboard/js/pages/studio.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    const { StudioPage, UI, t, I18N } = vm.runInContext('({ StudioPage, UI, t, I18N })', ctx) as {
        StudioPage: StudioApi; UI: { toast: (m: unknown, type?: string) => void }; t: Translate;
        I18N: StudioLoaded['I18N'];
    };
    const toasts: Array<{ message: string; type?: string }> = [];
    UI.toast = (message, type) => { toasts.push({ message: String(message), type }); };
    dom.set('page-container', fakeEl('page-container'));
    const host = (id: string): FakeEl => {
        const el = fakeEl(id);
        dom.set(id, el);
        return el;
    };
    return { Studio: StudioPage, t, I18N, dom, api, calls, confirms, nav, toasts, copied, hash, storage, app: ctx.App as Record<string, unknown>, host };
}

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60 * 1000).toISOString();

const studioStatus = (over: Json = {}): Json => ({
    worker: { online: true, lastSeen: minutesAgo(0.3), name: 'Studio Mac' },
    lessons: { total: 34, indexed: 34, indexing: 0, failed: 0 },
    jobs: { pending: 0, claimed: 0 },
    tiktok: { audited: false, queued: 3 },
    ...over,
});

const studioLessons = (): Json => ({
    lessons: [
        { id: 'l1', lesson_no: '1.1', section_no: 1, section_title: 'Chapter 1 - Prompting', title: 'Goals, not questions', status: 'indexed', summary: 's', moments_count: 12 },
        { id: 'l2', lesson_no: '1.2', section_no: 1, section_title: 'Chapter 1 - Prompting', title: 'Role and context', status: 'indexed', summary: 's', moments_count: 14 },
        { id: 'l3', lesson_no: '2.1', section_no: 2, section_title: 'Chapter 2 - NotebookLM', title: 'Grounded answers', status: 'indexed', summary: 's', moments_count: 20 },
        { id: 'l4', lesson_no: '2.2', section_no: 2, section_title: 'Chapter 2 - NotebookLM', title: 'Audio overviews', status: 'indexed', summary: 's', moments_count: 18 },
        { id: 'l5', lesson_no: 'I.1', section_no: null, section_title: null, title: 'Welcome', status: 'new', summary: null, moments_count: 0 },
    ],
});

/** Eight slides, one of each editable kind but stat. */
const studioCarousel = (): Json => ({
    id: 'GoalsNotQuestions',
    accent: '#FF6B6B',
    keyword: 'برومبت',
    slides: [
        { kind: 'cover', kicker: 'قبل ما تلوم الأداة', title: 'اعطه هدف بدل سؤال', highlight: 'هدف', subtitle: 'الفرق بين رأي وشغل منجز', shot: { name: 'm-mo1' } },
        { kind: 'point', n: 1, title: 'ابدأ بالنتيجة', body: 'قل له وش تبي تستلم في النهاية.', tip: 'النتيجة أولاً' },
        { kind: 'list', title: 'ثلاث أدوات', items: [{ icon: '🔎', text: 'بحث' }, { text: 'كود' }, { text: 'صور', sub: 'أداة للصور' }] },
        { kind: 'compare', title: 'قبل وبعد', left: { label: 'سؤال', items: ['رأي', 'عام'] }, right: { label: 'هدف', items: ['تقرير', 'مخصص'] } },
        { kind: 'steps', title: 'بالخطوات', steps: [{ title: 'الدور' }, { title: 'المهمة', body: 'وش المطلوب' }, { title: 'الصيغة' }] },
        { kind: 'prompt', title: 'انسخ البرومبت', label: 'انسخ', prompt: 'أنت [الدور]. المطلوب: [المهمة].' },
        { kind: 'shot', title: 'النتيجة الحقيقية', shot: { name: 'm-mo2' }, caption: 'من الدرس' },
        { kind: 'cta', promise: 'شرحته خطوة بخطوة' },
    ],
    captions: {
        instagram: 'اكتب "برومبت" بالتعليقات ويوصلك الرابط',
        tiktokTitle: 'هدف بدل سؤال',
        tiktok: 'الكورس كامل — رابطه في البايو',
    },
});

const studioDraft = (over: Json = {}): Json => ({
    id: 'd1',
    status: 'ready',
    input: { lessonIds: ['l1'], angle: 'auto', slides: 8 },
    carousel: studioCarousel(),
    shots: {
        'm-mo1': { lessonId: 'l1', t: 42, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'The vague answer' },
        'm-mo2': { lessonId: 'l1', t: 90, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'The report' },
    },
    campaign: { keyword: 'برومبت', variants: ['البرومبت'], dm: 'هلا {username} 👋', create: true },
    render: {
        ig: Array.from({ length: 8 }, (_, i) => `https://cdn.test/ig-${i + 1}.jpg`),
        tt: Array.from({ length: 8 }, (_, i) => `https://cdn.test/tt-${i + 1}.jpg`),
        rendered_at: minutesAgo(5),
        job_id: 'j1',
    },
    schedule: null,
    error: null,
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-20T10:05:00.000Z',
    ...over,
});

const studioMoments = (): Json => ({
    lesson: { id: 'l1', lesson_no: '1.1', title: 'Goals, not questions', status: 'indexed', notes: { summary: 's', points: [], prompts: [], tools: [], demos: [] } },
    moments: [
        { id: 'mo1', lesson_id: 'l1', t: 42, description: 'The vague answer', kind: 'ui', clean: true, thumb_url: '/api/uploads/t1' },
        { id: 'mo2', lesson_id: 'l1', t: 90, description: 'The report', kind: 'result', clean: true, thumb_url: '/api/uploads/t2' },
        { id: 'mo3', lesson_id: 'l1', t: 120.5, description: 'The finished report, full screen', kind: 'result', clean: true, thumb_url: '/api/uploads/t3' },
    ],
});

const studioSettings = (over: Json = {}): Json => ({
    brand: {
        name: 'Agentic AI', signature: { latin: 'AGENTIC AI', local: 'بالعربي' },
        palette: ['#FF6B6B', '#7C5CFF', '#22C55E'],
        colors: { ink: '#0B0B10', paper: '#F5F5F7', muted: '#8A8A99' },
        fonts: { display: 'Cairo', mono: 'JetBrains Mono' }, direction: 'rtl', theme: 'dark-grid',
    },
    voice: { language: 'ar', guide: 'Short lines.', digits: 'arabic-indic' },
    product: { name: 'The course', url: 'https://example.com/course?ref=1', facts: ['34 lessons', '5h40'], dmBullets: ['Lifetime access', 'Certificate'] },
    cta: {
        instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك الرابط',
        tiktokLine: 'رابطه في البايو',
        dmTemplate: 'هلا {username}\n{question}\n{pitch}\n{url}\n{bullets}',
        slide: { igAsk: 'a', igSub: 'b', save: 'c', ttHeadline: 'd', ttPill: 'e', ttSub: 'f', follow: 'g', swipe: 'h' },
    },
    schedule: { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] },
    library: { root: '/Users/elamir/Desktop/AI Course' },
    examples: [{ id: 'Approved' }],
    ...over,
});

/** Stub everything the home view reads. */
function stubHome(api: StudioLoaded['api'], status: Json = studioStatus(), settings: Json = studioSettings()): void {
    api.getStudioStatus = () => Promise.resolve(status);
    api.getStudioLessons = () => Promise.resolve(studioLessons());
    api.getStudioDrafts = () => Promise.resolve({
        drafts: [
            studioDraft(),
            studioDraft({ id: 'd2', status: 'rendering', render: null }),
            studioDraft({ id: 'd3', status: 'scheduled', schedule: { scheduled_time: '2026-09-26T10:00:00.000Z', tiktok: 'queue' } }),
        ],
    });
    api.getStudioSettings = () => Promise.resolve({ settings });
}

/** Stub everything the editor reads, and open draft `d1`. */
async function openEditor(s: StudioLoaded, draft: Json = studioDraft(), status: Json = studioStatus()): Promise<void> {
    s.hash.draft = String(draft.id);
    s.api.getStudioDraft = () => Promise.resolve({ draft, lessons: [{ id: 'l1', lesson_no: '1.1', title: 'Goals, not questions' }] });
    s.api.getStudioStatus = () => Promise.resolve(status);
    s.api.getStudioSettings = () => Promise.resolve({ settings: studioSettings() });
    s.api.getStudioSlots = () => Promise.resolve({ slots: ['2026-09-26T10:00:00.000Z', '2026-09-26T18:00:00.000Z'] });
    s.api.getStudioLesson = () => Promise.resolve(studioMoments());
    await s.Studio.render();
    await settle();
}

/** The opening tag of the element with this id, from a painted region. */
const tagOf = (markup: string, id: string): string => (markup.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`)) || [''])[0];

describe('StudioPage — the home view, from stubbed responses', () => {
    it('online worker: a green pill, when it was seen, the library count and the TikTok queue', async () => {
        const s = loadStudio();
        stubHome(s.api);
        await s.Studio.render();
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();

        assert.ok(tagOf(page, 'studio-worker-pill').includes('health-fresh'), 'green');
        assert.ok(page.includes(s.t('studio.worker.online')));
        assert.ok(page.includes('Studio Mac'));
        assert.ok(page.includes(s.t('studio.worker.lastSeen', { when: s.t('common.justNow') })), 'last seen, as a relative age');
        assert.ok(!page.includes('id="studio-worker-hint"'), 'no "start the worker" while it is running');
        assert.ok(page.includes('<bdi class="ltr-text" dir="ltr">34/34</bdi>'), 'indexed/total, isolated inside Arabic');
        assert.ok(page.includes(s.t('studio.library.indexedLabel')));
        assert.ok(page.includes('data-action="studio:scanLibrary"') && page.includes('data-action="studio:indexMissing"'));
        const batch = tagOf(page, 'studio-tiktok-batch');
        assert.ok(batch.includes('data-action="studio:confirmTikTokBatch"'), 'the batch button, while TikTok is unaudited');
        assert.ok(!/\sdisabled\b/.test(batch), 'three are queued, so it is live');
        assert.ok(tagOf(page, 'studio-tiktok-queued') !== '', 'the queue count');
        assert.equal(s.t('nav.studio'), 'الاستوديو');
    });

    it('offline worker: grey, "start the worker on your Mac", and jobs said to be waiting for it', async () => {
        const s = loadStudio();
        stubHome(s.api, studioStatus({
            worker: { online: false, lastSeen: minutesAgo(180), name: 'Studio Mac' },
            lessons: { total: 34, indexed: 30, indexing: 2, failed: 1 },
            jobs: { pending: 4, claimed: 0 },
            tiktok: { audited: false, queued: 0 },
        }));
        await s.Studio.render();
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();

        assert.ok(tagOf(page, 'studio-worker-pill').includes('health-off'), 'grey, not green and not red');
        assert.ok(page.includes(s.t('studio.worker.offline')));
        assert.ok(page.includes('id="studio-worker-hint"'));
        assert.ok(page.includes(s.t('studio.worker.startHint')));
        assert.ok(page.includes(s.t('studio.jobs.waitingForMac')));
        assert.ok(page.includes('30/34'));
        assert.ok(page.includes(s.t('studio.library.failed', { n: '1' })));
        // A disabled button with nothing to do is noise: the TikTok item appears only
        // when something is queued (or the audit has retired the batch).
        assert.ok(!page.includes('id="studio-tiktok-batch"'), 'nothing queued: no batch button at all');
        // Offline is a state with a way out: what the worker is, how to start it, and a real re-check.
        assert.ok(page.includes(s.t('studio.worker.what')) && page.includes(s.t('studio.worker.howTo')));
        assert.ok(tagOf(page, 'studio-worker-retry').includes('data-action="studio:retryWorker"'), 'Retry re-reads the status');
    });

    it('hides the batch button once TikTok has audited the app', () => {
        const s = loadStudio();
        s.Studio.status = studioStatus({ tiktok: { audited: true, queued: 2 } });
        const bar = String(s.Studio.statusMarkup());
        assert.ok(!bar.includes('studio-tiktok-batch'));
        assert.ok(bar.includes(s.t('studio.tiktok.auditedNote')));
    });

    it('turns Scan library off, with a way to Settings, while no library folder is set', () => {
        const s = loadStudio();
        s.Studio.status = studioStatus();
        s.Studio.settings = studioSettings({ library: { root: null } });
        let bar = String(s.Studio.statusMarkup());
        assert.ok(/\sdisabled\b/.test(tagOf(bar, 'studio-scan')));
        assert.ok(bar.includes('id="studio-no-folder"') && bar.includes('href="#/studio?tab=settings"'));

        s.Studio.settings = studioSettings();
        bar = String(s.Studio.statusMarkup());
        assert.ok(!/\sdisabled\b/.test(tagOf(bar, 'studio-scan')), 'a folder is set');
        assert.ok(!bar.includes('studio-no-folder'));

        // A failed settings read leaves Scan on: the server says why if it refuses.
        s.Studio.settings = null;
        assert.ok(!/\sdisabled\b/.test(tagOf(String(s.Studio.statusMarkup()), 'studio-scan')));
    });

    it('groups lessons by section, and offers only indexed ones', async () => {
        const s = loadStudio();
        stubHome(s.api);
        await s.Studio.render();
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        assert.ok(page.includes('Chapter 1 - Prompting') && page.includes('Chapter 2 - NotebookLM'));
        assert.ok(page.includes(s.t('studio.lessons.extras')), 'intro videos under their own heading');
        const chip = (id: string): string => (page.match(new RegExp(`<button[^>]*data-action="studio:toggleLesson" data-id="${id}"[^>]*>`)) || [''])[0];
        assert.ok(chip('l1') !== '' && !/\sdisabled\b/.test(chip('l1')));
        assert.ok(/\sdisabled\b/.test(chip('l5')), 'not indexed: nothing to write from');
        assert.ok(page.includes('data-action="studio:showLesson" data-id="l1"'), 'every chip has its info button');
    });

    it('draft cards: the IG cover, the status, when it was made, and where it is headed', async () => {
        const s = loadStudio();
        stubHome(s.api);
        await s.Studio.render();
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        assert.ok(page.includes('src="https://cdn.test/ig-1.jpg"'), 'render.ig[0] is the thumbnail');
        assert.ok(page.includes('href="#/studio?draft=d1"'), 'a real link into the editor');
        assert.ok(page.includes(s.t('studio.state.ready')) && page.includes(s.t('studio.state.rendering')));
        assert.ok(page.includes('class="skel skel-block"'), 'a draft still rendering shows a skeleton cover');
        assert.ok(page.includes('status-pill scheduled'));
        assert.ok(page.includes(s.t('studio.drafts.created', { when: '' }).trim()), 'when it was made');
    });

    it('picks up to three indexed lessons, and says so at the limit', () => {
        const s = loadStudio();
        s.Studio.lessons = studioLessons().lessons;
        for (const id of ['l1', 'l2', 'l3']) s.Studio.toggleLesson(id);
        assert.equal(JSON.stringify(s.Studio.selected), '["l1","l2","l3"]');
        s.Studio.toggleLesson('l4');
        assert.equal(s.Studio.selected.length, 3, 'a fourth is refused');
        assert.equal(s.toasts.at(-1)?.type, 'error');
        s.Studio.toggleLesson('l2');
        s.Studio.toggleLesson('l5');
        assert.equal(JSON.stringify(s.Studio.selected), '["l1","l3"]', 'a lesson that is not indexed cannot be picked');
    });
});

describe('StudioPage — Generate', () => {
    const newForm = (fields: Record<string, unknown>): Record<string, unknown> => fakeForm({ angle: 'auto', slides: '8', ...fields });

    it('POSTs the DraftInput — picked lessons, then the form — and opens the new draft', async () => {
        const s = loadStudio();
        const sent: Json[] = [];
        s.api.createStudioDraft = (body: Json) => { sent.push(body); return Promise.resolve({ draft: { id: 'new1', status: 'rendering' } }); };
        s.Studio.selected = ['l1', 'l3'];
        await s.Studio.generate(newForm({ idea: '  focus on reports  ', angle: 'mistakes', slides: '7', keyword: 'تقرير', accent: '#00aa55' }), submitEvent);
        assert.deepEqual(plainJson(sent[0]), {
            lessonIds: ['l1', 'l3'], idea: 'focus on reports', angle: 'mistakes', slides: 7, keyword: 'تقرير', accent: '#00AA55',
        });
        assert.deepEqual(plainJson(s.nav.at(-1)), { page: 'studio', params: { draft: 'new1' } }, 'straight into the editor');
        assert.equal(s.Studio.selected.length, 0, 'the next carousel starts with a clean pick');
    });

    it('leaves optional fields out rather than sending them empty, and keeps angle and slides in range', async () => {
        const s = loadStudio();
        const sent: Json[] = [];
        s.api.createStudioDraft = (body: Json) => { sent.push(body); return Promise.resolve({ draft: { id: 'n', status: 'rendering' } }); };
        s.Studio.selected = ['l2'];
        await s.Studio.generate(newForm({ idea: '', keyword: '', accent: '', angle: 'sideways', slides: '14' }), submitEvent);
        assert.deepEqual(plainJson(sent[0]), { lessonIds: ['l2'], angle: 'auto', slides: 10 });
        s.Studio.selected = ['l2'];
        await s.Studio.generate(newForm({ slides: '2' }), submitEvent);
        assert.equal(plainJson(sent[1]).slides, 6);
    });

    it('an idea alone is enough; neither a lesson nor an idea sends nothing and says why', async () => {
        const s = loadStudio();
        (s.Studio as Json).mode = 'idea';
        const errorHost = s.host('studio-new-error');
        const idea = s.host('studio-idea');
        const sent: Json[] = [];
        s.api.createStudioDraft = (body: Json) => { sent.push(body); return Promise.resolve({ draft: { id: 'n', status: 'rendering' } }); };
        await s.Studio.generate(newForm({ idea: '' }), submitEvent);
        assert.equal(sent.length, 0);
        assert.ok(errorHost.innerHTML.includes(s.t('studio.new.needSource')));
        assert.equal(idea.getAttribute('aria-invalid'), 'true', 'on the idea field');

        await s.Studio.generate(newForm({ idea: 'Local RAG in ten minutes', keyword: 'two words' }), submitEvent);
        assert.equal(sent.length, 0, 'the keyword is one word');
        assert.ok(errorHost.innerHTML.includes(s.t('studio.keywordOneWord')));

        await s.Studio.generate(newForm({ idea: 'Local RAG in ten minutes' }), submitEvent);
        assert.deepEqual(plainJson(sent[0]), { lessonIds: [], idea: 'Local RAG in ten minutes', angle: 'auto', slides: 8 });
    });

    it('a generation that failed is reported where it was asked for, and not opened', async () => {
        const s = loadStudio();
        const errorHost = s.host('studio-new-error');
        s.api.getStudioDrafts = () => Promise.resolve({ drafts: [] });
        s.api.createStudioDraft = () => Promise.resolve({ draft: { id: 'x', status: 'failed', error: 'Gemini timed out' } });
        s.Studio.selected = ['l1'];
        await s.Studio.generate(newForm({}), submitEvent);
        assert.equal(s.nav.length, 0);
        assert.ok(errorHost.innerHTML.includes('Gemini timed out'));
        assert.equal(s.Studio.selected.length, 1, 'the pick survives, to try again');

        s.api.createStudioDraft = () => Promise.reject(Object.assign(new Error('Invalid input'), {
            status: 400, body: { error: 'Invalid input', problems: ['idea is required when lessonIds is empty'] },
        }));
        await s.Studio.generate(newForm({}), submitEvent);
        assert.ok(errorHost.innerHTML.includes('Invalid input') && errorHost.innerHTML.includes('idea is required'));
    });
});

describe('StudioPage — Plan my week', () => {
    it('lists the proposals, drops the removed one, and POSTs /drafts for the rest one after another', async () => {
        const s = loadStudio();
        s.host('studio-plan');
        s.Studio.lessons = studioLessons().lessons;
        s.Studio.selected = ['l1'];
        const planBodies: Json[] = [];
        s.api.planStudioWeek = (body: Json) => {
            planBodies.push(body);
            return Promise.resolve({
                proposals: [
                    { lessonIds: ['l1'], angle: 'tips', slides: 8, title: 'Five goal prompts', rationale: 'Most saved format', slot: '2026-09-26T10:00:00.000Z' },
                    { lessonIds: ['l3'], angle: 'steps', title: 'NotebookLM in 4 steps', rationale: 'Fresh lesson', slot: '2026-09-26T18:00:00.000Z' },
                    { lessonIds: [], idea: 'Local AI', angle: 'compare', keyword: 'محلي', title: 'Cloud vs local', rationale: 'Asked in DMs', slot: '2026-09-27T10:00:00.000Z' },
                ],
            });
        };
        const count = Object.assign(fakeEl('studio-plan-count'), { value: '3' });
        s.dom.set('studio-plan-count', count);
        await s.Studio.planWeek(null);
        assert.deepEqual(plainJson(planBodies[0]), { count: 3, lessonIds: ['l1'] });
        const plan = s.dom.get('studio-plan')!.innerHTML;
        assert.ok(plan.includes('Five goal prompts') && plan.includes('Most saved format'), 'each with its rationale');
        assert.ok(plan.includes(s.t('studio.plan.generateAll', { n: '3' })));

        s.Studio.toggleProposal('p2');
        const resolvers: Array<(v: Json) => void> = [];
        const posted: Json[] = [];
        s.api.createStudioDraft = (body: Json) => new Promise((resolve) => { posted.push(body); resolvers.push(resolve); });
        s.api.getStudioDrafts = () => Promise.resolve({ drafts: [] });
        const run = s.Studio.generateAll();
        await settle();
        assert.equal(posted.length, 1, 'one at a time: the second waits for the first');
        assert.ok(s.dom.get('studio-plan')!.innerHTML.includes(s.t('studio.plan.writing')), 'per-item progress');
        resolvers[0]!({ draft: { id: 'dA', status: 'rendering' } });
        await settle();
        assert.equal(posted.length, 2);
        resolvers[1]!({ draft: { id: 'dB', status: 'rendering' } });
        await run;
        // Title, rationale and slot are the plan's; the POST is a DraftInput.
        assert.deepEqual(plainJson(posted), [
            { lessonIds: ['l1'], angle: 'tips', slides: 8 },
            { lessonIds: [], idea: 'Local AI', angle: 'compare', keyword: 'محلي' },
        ]);
        assert.equal(s.Studio.plannedSlots.dA, '2026-09-26T10:00:00.000Z', 'the slot is remembered for scheduling');
        assert.ok(s.dom.get('studio-plan')!.innerHTML.includes('href="#/studio?draft=dB"'), 'each done item opens its draft');
        assert.equal(s.toasts.at(-1)?.message, s.t('studio.plan.finished', { n: '2' }));
    });
});

describe('StudioPage — Post queued TikTok carousels', () => {
    it('asks first, says the account has to be private, and posts only on confirm', async () => {
        const s = loadStudio();
        s.Studio.status = studioStatus();
        s.api.getStudioStatus = () => Promise.resolve(studioStatus({ tiktok: { audited: false, queued: 0 } }));
        s.api.getStudioDrafts = () => Promise.resolve({ drafts: [] });
        s.api.postStudioTikTokBatch = () => Promise.resolve({ queued: 3 });

        s.Studio.confirmTikTokBatch();
        assert.equal(s.confirms.length, 1);
        const dialog = s.confirms[0]!;
        assert.ok(String(dialog.body).includes('3'), 'how many will go');
        assert.equal(dialog.hint, s.t('studio.tiktok.batchPrivate'));
        assert.ok(String(dialog.hint).includes('خاص'), 'Arabic: the account must be private');
        assert.equal(dialog.tone, 'primary', 'consequential, not destructive');
        assert.ok(!s.calls.some((c) => c.method === 'postStudioTikTokBatch'), 'nothing is posted by asking');

        await dialog.onConfirm();
        assert.ok(s.calls.some((c) => c.method === 'postStudioTikTokBatch'));
        assert.equal(s.toasts.at(-1)?.message, s.t('studio.tiktok.batchDone', { n: '3' }));

        s.I18N.lang = 'en';
        assert.ok(s.t('studio.tiktok.batchPrivate').includes('private'));
    });
});

describe('StudioPage — the draft editor', () => {
    it('paints previews, one form per slide with live budgets, captions and the campaign', async () => {
        const s = loadStudio();
        await openEditor(s);
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        assert.ok(page.includes('src="https://cdn.test/ig-1.jpg"'), 'the Instagram strip by default');
        assert.ok(page.includes('data-action="studio:previewTab" data-tab="tt"'), 'with a TikTok tab');
        for (let i = 0; i < 8; i++) assert.ok(page.includes(`id="st-${i}"`), `slide ${i + 1} has its card`);
        assert.ok(page.includes('<bdi class="ltr-text" dir="ltr">17/34</bdi>'), 'the cover title against its 34 budget');
        assert.ok(tagOf(page, 'st-0-up').includes('disabled') && !tagOf(page, 'st-0-down').includes('disabled'), 'the first slide cannot move up');
        assert.ok(page.includes('id="st-2-items-0-text"') && page.includes('id="st-3-right-items-1"') && page.includes('id="st-4-steps-2-title"'));
        assert.ok(page.includes('data-action="studio:openRewrite"'), 'Rewrite with AI on every slide');
        assert.ok(page.includes('id="st-cap-tt-title"') && page.includes('data-max="90"'), 'the TikTok title against 90');
        assert.ok(tagOf(page, 'st-cap-ig-check').includes('text-success'), 'the IG caption carries the settings’ ask line');
        assert.ok(tagOf(page, 'st-cap-tt-check').includes('text-success'), 'the TikTok caption carries the settings’ line');
        assert.ok(page.includes('id="st-keyword"') && page.includes('id="st-dm"') && page.includes('id="st-create"'));
    });

    it('while rendering: skeletons, then the poll brings the slides in by itself', async () => {
        const s = loadStudio();
        assert.equal((s.Studio as Json).RENDER_POLL_MS, 4000, 'every 4 seconds');
        (s.Studio as Json).RENDER_POLL_MS = 30;
        const previews = s.host('studio-previews');
        await openEditor(s, studioDraft({ status: 'rendering', render: null }));
        const page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes('class="phone-wire is-busy"'), 'a skeleton in the phone frame');
        assert.ok(/class="rail-tab[^"]*"[^>]*>\s*<span class="skel skel-block"><\/span>/.test(page), 'and on every slide in the rail');
        assert.ok(page.includes(s.t('studio.preview.rendering')));
        assert.ok(tagOf(page, 'studio-schedule-submit').includes('disabled'), 'nothing to schedule until the render is in');

        let polls = 0;
        s.api.getStudioDraft = () => { polls++; return Promise.resolve({ draft: studioDraft(), lessons: [] }); };
        await new Promise((resolve) => setTimeout(resolve, 120));
        s.Studio.destroy();
        assert.equal(polls, 1, 'asked again, and stopped once it was ready');
        assert.ok(previews.innerHTML.includes('src="https://cdn.test/ig-1.jpg"'), 'the rendered slides replace the skeletons');
        assert.ok(s.toasts.some((x) => x.message === s.t('studio.preview.rendered')));
    });

    it('PATCHes the working copy after edits: text, a move, a screenshot swap, captions, keyword and DM', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio;
        S.slideField({ dataset: { slide: '1', path: 'title' }, value: 'ابدأ بالنتيجة دائماً' });
        S.slideField({ dataset: { slide: '1', path: 'n', kind: 'int' }, value: '2' });
        S.slideField({ dataset: { slide: '0', path: 'kicker', optional: '1' }, value: '' });
        S.slideField({ dataset: { slide: '2', path: 'items.1.text' }, value: 'برمجة' });
        S.slideField({ dataset: { slide: '3', path: 'right.items.0' }, value: 'تقرير جاهز' });
        S.moveSlide('1', 1);
        S.pickShot({ dataset: { slide: '6', moment: 'mo3', lesson: 'l1' } });
        S.metaField({ dataset: { path: 'captions.tiktokTitle' }, value: 'عنوان جديد' });
        S.keywordField({ value: 'هدف' });
        S.campaignField({ dataset: { path: 'dm' }, value: 'هلا {username}، هذا الرابط' });
        S.campaignToggle({ checked: false });
        assert.equal(S.isDirty(), true);

        const sent: Json[] = [];
        s.api.updateStudioDraft = (id: string, body: Json) => {
            sent.push({ id, body });
            return Promise.resolve({ draft: studioDraft({ status: 'rendering', carousel: body.carousel, shots: body.shots, campaign: body.campaign }) });
        };
        await S.save();
        S.destroy();

        assert.equal(sent.length, 1);
        assert.equal(sent[0].id, 'd1');
        const body: Json = plainJson(sent[0].body);
        assert.deepEqual(Object.keys(body).sort(), ['campaign', 'carousel', 'shots']);
        const slides = body.carousel.slides;
        assert.equal(slides[1].kind, 'list', 'the point moved below the list');
        assert.deepEqual(slides[2], { kind: 'point', n: 2, title: 'ابدأ بالنتيجة دائماً', body: 'قل له وش تبي تستلم في النهاية.', tip: 'النتيجة أولاً' });
        assert.equal('kicker' in slides[0], false, 'an emptied optional field is left out, not sent as ""');
        assert.equal(slides[1].items[1].text, 'برمجة');
        assert.deepEqual(slides[3].right.items, ['تقرير جاهز', 'مخصص']);
        assert.deepEqual(slides[6].shot, { name: 'm-mo3' }, 'the slide points at the moment it now shows');
        assert.deepEqual(Object.keys(body.shots).sort(), ['m-mo1', 'm-mo3'], 'the swapped-out shot is not rendered for nothing');
        assert.deepEqual(body.shots['m-mo3'], { lessonId: 'l1', t: 120.5, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'The finished report, full screen' });
        assert.equal(body.carousel.captions.tiktokTitle, 'عنوان جديد');
        assert.equal(body.carousel.keyword, 'هدف', 'one keyword: the CTA…');
        assert.equal(body.campaign.keyword, 'هدف', '…and the campaign that answers it');
        assert.equal(body.campaign.dm, 'هلا {username}، هذا الرابط');
        assert.equal(body.campaign.create, false);
        assert.deepEqual(body.campaign.variants, ['البرومبت'], 'what the page does not edit, it sends back as it came');
        assert.equal(S.isDirty(), false, 'saved');
        assert.ok(s.toasts.some((x) => x.message === s.t('studio.editor.savedToast')));
    });

    it('a 400 puts each problem next to the slide or field it names, and the rest above Save', async () => {
        const s = loadStudio();
        await openEditor(s);
        const slidesHost = s.host('studio-slides');
        const captionsHost = s.host('studio-captions');
        const campaignHost = s.host('studio-campaign');
        const saveBar = s.host('studio-savebar');
        const panel = s.host('studio-problems');
        s.Studio.slideField({ dataset: { slide: '2', path: 'title' }, value: 'عنوان طويل جداً لا يتسع في مكانه على الشريحة أبداً' });
        const problems = [
            'GoalsNotQuestions[3:list].title: 45 > 36 «عنوان طويل»',
            'GoalsNotQuestions[4:compare].items[2]: 31 > 30 «تقرير»',
            'GoalsNotQuestions[4:compare]: compare sides differ in length',
            'GoalsNotQuestions: instagram caption doesn\'t mention the keyword',
            'GoalsNotQuestions: keyword must be one word',
            'Something the page cannot place',
        ];
        s.api.updateStudioDraft = () => Promise.reject(Object.assign(new Error('Invalid carousel'), {
            status: 400, body: { error: 'Invalid carousel', problems },
        }));
        await s.Studio.save();
        s.Studio.destroy();

        const slides = slidesHost.innerHTML;
        const title = tagOf(slides, 'st-2-title');
        assert.ok(title.includes('aria-invalid="true"') && title.includes('st-2-title-problems'), 'the list title is marked, and points at why');
        assert.ok(/id="st-2-title-problems"[^>]*>\s*<li dir="auto">GoalsNotQuestions\[3:list\]\.title: 45 &gt; 36/.test(slides), 'the message sits under that field');
        assert.ok(tagOf(slides, 'st-3-right-items-0').includes('aria-invalid="true"'), 'compare counts both sides as one run: items[2] is the right side’s first');
        assert.ok(/id="st-3-rows-problems"[\s\S]*compare sides differ in length/.test(slides), 'a slide-level problem sits with the slide');
        assert.ok(tagOf(captionsHost.innerHTML, 'st-cap-ig').includes('aria-invalid="true"'), 'caption problems go to the caption');
        assert.ok(tagOf(campaignHost.innerHTML, 'st-keyword').includes('aria-invalid="true"'), 'keyword problems go to the keyword');
        const bar = saveBar.innerHTML;
        assert.ok(bar.includes(s.t('studio.problems.title', { n: '6' })), 'the count in the save bar');
        assert.ok(bar.includes('data-action="studio:focusFirstProblem"'), 'with a way to the first one');
        // The whole list sits in the panel above the forms, not in the sticky bar.
        for (const p of problems) assert.ok(panel.innerHTML.includes(esc4(p)), `listed in the problems panel: ${p}`);
        assert.ok(panel.innerHTML.includes(s.t('studio.problems.onSlide', { n: 3, kind: s.t('studio.kind.list') })), 'each says which slide it is on');
        assert.equal((s.Studio as Json).selectedSlide, 2, 'the first slide with a problem is the one brought up');
        assert.equal(s.Studio.isDirty(), true, 'nothing was saved');
        assert.ok(!s.toasts.some((x) => x.message === s.t('studio.editor.savedToast')));
    });

    it('reads check-carousels messages onto slides and fields', () => {
        const s = loadStudio();
        s.Studio.work = { carousel: studioCarousel(), shots: {}, campaign: {} };
        assert.deepEqual(plainJson(s.Studio.problemTarget('X[3:list].items[0].text: 40 > 36 «…»')), { slide: 2, path: 'items.0.text' });
        assert.deepEqual(plainJson(s.Studio.problemTarget('X[1:cover].highlight not in title')), { slide: 0, path: 'highlight' });
        assert.deepEqual(plainJson(s.Studio.problemTarget('X[4:compare].items[1]: 31 > 30')), { slide: 3, path: 'left.items.1' });
        assert.deepEqual(plainJson(s.Studio.problemTarget('X: tiktokTitle 95 > 90 UTF-16')), { field: 'captions.tiktokTitle' });
        assert.deepEqual(plainJson(s.Studio.problemTarget('X: tiktok caption is missing the link-in-bio line')), { field: 'captions.tiktok' });
        assert.deepEqual(plainJson(s.Studio.problemTarget('X: accent "red" is not #RRGGBB')), { field: 'accent' });
        assert.deepEqual(plainJson(s.Studio.problemTarget('X.slides: 11 items, expected 6–10')), { field: 'slides' });
        assert.equal(s.Studio.problemTarget('Gemini returned nothing'), null);
    });
});

/** The page's own escaping, for comparing a message with what was painted. */
const esc4 = (value: string): string => value.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);

describe('StudioPage — Schedule', () => {
    const slotA = '2026-09-26T10:00:00.000Z';
    const slotB = '2026-09-26T18:00:00.000Z';

    it('defaults to the first free slot and, while TikTok is unaudited, to queueing the TikTok post', async () => {
        const s = loadStudio();
        const panel = s.host('studio-schedule');
        await openEditor(s);
        s.Studio.destroy();
        const markup = panel.innerHTML;
        assert.ok(new RegExp(`<option value="${slotA}" selected>`).test(markup), 'the first slot');
        assert.ok(/<input type="radio" name="tiktok" value="queue" checked>/.test(markup));
        assert.ok(!markup.includes('value="scheduled"'), 'no same-time TikTok post before the audit');
        assert.ok(/<input type="radio" name="tiktok" value="none"/.test(markup));
        assert.ok(tagOf(markup, 'st-sched-campaign').includes('checked'), 'create_campaign follows the draft’s campaign');
    });

    it('POSTs { scheduled_time, tiktok, create_campaign }, then shows the TikTok checklist', async () => {
        const s = loadStudio();
        await openEditor(s);
        const sent: Json[] = [];
        s.api.scheduleStudioDraft = (id: string, body: Json) => {
            sent.push({ id, body });
            return Promise.resolve({
                draft: studioDraft({ status: 'scheduled', schedule: { scheduled_time: body.scheduled_time, meta_row_id: 'r1', tiktok: body.tiktok, tiktok_row_id: null, tiktok_public_done: false } }),
                rows: [{ id: 'r1' }],
            });
        };
        await s.Studio.schedule(fakeForm({ slot: slotB, tiktok: 'queue', create_campaign: 'on' }), submitEvent);
        s.Studio.destroy();
        assert.deepEqual(plainJson(sent), [{ id: 'd1', body: { scheduled_time: slotB, tiktok: 'queue', create_campaign: true } }]);
        const page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes(s.t('studio.tiktokCheck.madePublic')), 'the "made public on TikTok" checklist');
        assert.ok(tagOf(page, 'st-tt-public').includes('disabled'), 'not tickable until the batch has posted it');
        assert.ok(!page.includes('data-action="studio:save"'), 'a scheduled draft is closed to edits');
        assert.ok(!page.includes('data-action="studio:deleteDraft"'), 'and cannot be deleted');
    });

    it('sends only what TikTok’s audit state allows, a custom time as UTC, and nothing while there are unsaved edits', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio;
        assert.equal(S.readSchedule(fakeForm({ slot: slotA, tiktok: 'scheduled' })).body.tiktok, 'queue', 'unaudited: never "scheduled"');
        assert.equal(S.readSchedule(fakeForm({ slot: slotA, tiktok: 'none' })).body.tiktok, 'none');
        assert.equal(S.readSchedule(fakeForm({ slot: slotA })).body.create_campaign, false);
        const custom = S.readSchedule(fakeForm({ slot: 'custom', custom_time: '2031-03-04T18:20' }));
        assert.equal(custom.body.scheduled_time, new Date('2031-03-04T18:20').toISOString());
        assert.equal(S.readSchedule(fakeForm({ slot: 'custom', custom_time: '2020-01-01T10:00' })).ok, false, 'not in the past');
        S.status = studioStatus({ tiktok: { audited: true, queued: 0 } });
        assert.equal(S.readSchedule(fakeForm({ slot: slotA, tiktok: 'queue' })).body.tiktok, 'scheduled', 'audited: posted at the same time');

        let posted = 0;
        s.api.scheduleStudioDraft = () => { posted++; return Promise.resolve({}); };
        S.slideField({ dataset: { slide: '1', path: 'title' }, value: 'تعديل لم يُحفظ' });
        await S.schedule(fakeForm({ slot: slotA, tiktok: 'none' }), submitEvent);
        S.destroy();
        assert.equal(posted, 0, 'the post would use the old render');
    });
});

describe('StudioPage — every string in Arabic and English', () => {
    it('has each key the page uses in both dictionaries, including the ones built from a list', () => {
        const { Studio, I18N } = loadStudio();
        const source = readFileSync('dashboard/js/pages/studio.js', 'utf8');
        const keys = new Set<string>(['nav.studio', 'page.studio.subtitle']);
        // Literals, whether passed to t() or held in a field table as a labelKey.
        for (const m of source.matchAll(/'(studio\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
        // Keys built from a list: the list is the page's own, so a new entry cannot slip by.
        Studio.ANGLES.forEach((a) => keys.add(`studio.angle.${a}`));
        Studio.SLIDE_KINDS.forEach((k) => keys.add(`studio.kind.${k}`));
        Studio.CTA_SLIDE_KEYS.forEach((k) => keys.add(`studio.settings.slide.${k}`));
        ['generating', 'rendering', 'ready', 'scheduled', 'failed'].forEach((st) => keys.add(`studio.state.${st}`));
        ['slide', 'ui', 'result', 'code', 'prompt', 'other'].forEach((k) => keys.add(`studio.moment.kind.${k}`));
        assert.ok(keys.size > 250, `found ${keys.size} keys`);
        const missing: string[] = [];
        for (const key of keys) {
            for (const lang of ['ar', 'en']) {
                const value = I18N.strings[lang]![key];
                if (typeof value !== 'string' || !value.trim()) missing.push(`${lang}:${key}`);
            }
        }
        assert.deepEqual(missing, []);
        assert.equal(I18N.strings.en!['nav.studio'], 'Studio');
        assert.equal(I18N.strings.ar!['nav.studio'], 'الاستوديو');
    });

    it('keeps product and CTA words out of the page: they come from settings', () => {
        const source = readFileSync('dashboard/js/pages/studio.js', 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // No Arabic outside i18n.js, and none of the course's own words or links.
        assert.equal(/[؀-ۿ]/.test(source), false, 'Arabic copy belongs in i18n.js');
        for (const word of ['udemy', 'referralCode', 'agentic']) {
            assert.equal(source.toLowerCase().includes(word.toLowerCase()), false, `no "${word}" in the page`);
        }
    });
});

describe('StudioPage — Settings', () => {
    async function openSettings(s: StudioLoaded, settings: Json = studioSettings(), workers: Json[] = []): Promise<void> {
        s.hash.tab = 'settings';
        s.api.getStudioSettings = () => Promise.resolve({ settings });
        s.api.getStudioWorkers = () => Promise.resolve({ workers });
        s.api.getStudioStatus = () => Promise.resolve(studioStatus());
        await s.Studio.render();
    }

    it('shows every section, and never a form built from blanks when the read failed', async () => {
        const s = loadStudio();
        await openSettings(s);
        const page = s.dom.get('page-container')!.innerHTML;
        for (const id of ['sts-section-brand', 'sts-section-voice', 'sts-section-product', 'sts-section-schedule', 'sts-section-library', 'studio-workers']) {
            assert.ok(page.includes(`id="${id}"`), id);
        }
        assert.ok(page.includes('aria-current="page"') && page.includes('href="#/studio?tab=settings"'), 'the Settings tab is current');
        for (const key of s.Studio.CTA_SLIDE_KEYS) assert.ok(page.includes(`id="sts-cta-slide-${key}"`), `cta.slide.${key}`);
        assert.ok(page.includes('id="sts-brand-palette-2"'), 'one swatch per palette colour');
        assert.ok(page.includes('<option value="Asia/Riyadh" selected>'), 'the time zone');

        const failed = loadStudio();
        failed.hash.tab = 'settings';
        failed.api.getStudioSettings = () => Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
        failed.api.getStudioWorkers = () => Promise.resolve({ workers: [] });
        failed.api.getStudioStatus = () => Promise.resolve(studioStatus());
        await failed.Studio.render();
        const broken = failed.dom.get('page-container')!.innerHTML;
        assert.ok(!broken.includes('id="studio-settings-form"'), 'saving blanks over real settings is worse than no form');
        assert.ok(broken.includes('data-error-host'));
    });

    it('PUTs all six sections as edited — and not the examples, which the merge keeps', async () => {
        const s = loadStudio();
        await openSettings(s);
        const S = s.Studio;
        S.setting({ dataset: { path: 'brand.name' }, value: 'Acme Studio' });
        S.setting({ dataset: { path: 'brand.signature.latin' }, value: 'ACME' });
        S.setting({ dataset: { path: 'brand.palette.1', kind: 'color', hex: 'none' }, value: '#00aa55' });
        S.removeSwatch(0);
        S.addSwatch();
        S.setting({ dataset: { path: 'brand.colors.ink', kind: 'color' }, value: '#101010' });
        S.setting({ dataset: { path: 'brand.fonts.display' }, value: 'Tajawal' });
        S.setting({ dataset: { path: 'brand.direction' }, value: 'ltr' });
        S.setting({ dataset: { path: 'voice.language' }, value: 'en' });
        S.setting({ dataset: { path: 'voice.digits' }, value: 'latin' });
        S.setting({ dataset: { path: 'voice.guide' }, value: 'Plain, short sentences.' });
        S.setting({ dataset: { path: 'product.url' }, value: 'https://acme.test/course' });
        S.addListItem('product.facts');
        S.setting({ dataset: { path: 'product.facts.2' }, value: '12 projects' });
        S.addListItem('product.facts');
        S.removeListItem('product.dmBullets', 0);
        S.setting({ dataset: { path: 'cta.instagramAsk' }, value: 'Comment "{keyword}" for the link' });
        S.setting({ dataset: { path: 'cta.tiktokLine' }, value: 'Link in bio' });
        S.setting({ dataset: { path: 'cta.slide.swipe' }, value: 'Swipe' });
        S.setting({ dataset: { path: 'schedule.timezone' }, value: 'Europe/London' });
        S.removeListItem('schedule.slots', 1);
        S.addListItem('schedule.slots');
        S.setting({ dataset: { path: 'schedule.slots.1' }, value: '18:30' });
        S.setting({ dataset: { path: 'library.root' }, value: '   ' });
        S.setting({ dataset: { path: 'examples.0' }, value: 'not a section' });

        const sent: Json[] = [];
        s.api.saveStudioSettings = (body: Json) => { sent.push(body); return Promise.resolve({ settings: { ...studioSettings(), ...body } }); };
        await S.saveSettings(fakeForm({}), submitEvent);
        S.destroy();

        assert.equal(sent.length, 1);
        const body: Json = plainJson(sent[0]);
        assert.deepEqual(Object.keys(body).sort(), ['brand', 'cta', 'library', 'product', 'schedule', 'voice']);
        assert.equal(body.brand.name, 'Acme Studio');
        assert.deepEqual(body.brand.signature, { latin: 'ACME', local: 'بالعربي' });
        assert.deepEqual(body.brand.palette, ['#00AA55', '#22C55E', '#22C55E'], 'upper-case hex; removed and added swatches');
        assert.equal(body.brand.colors.ink, '#101010');
        assert.deepEqual(body.brand.fonts, { display: 'Tajawal', mono: 'JetBrains Mono' });
        assert.equal(body.brand.direction, 'ltr');
        assert.equal(body.brand.theme, 'dark-grid', 'kept, though there is nothing to choose yet');
        assert.deepEqual(body.voice, { language: 'en', guide: 'Plain, short sentences.', digits: 'latin' });
        assert.deepEqual(body.product.facts, ['34 lessons', '5h40', '12 projects'], 'the empty row is dropped');
        assert.deepEqual(body.product.dmBullets, ['Certificate']);
        assert.equal(body.product.url, 'https://acme.test/course');
        assert.equal(body.cta.instagramAsk, 'Comment "{keyword}" for the link');
        assert.equal(body.cta.tiktokLine, 'Link in bio');
        assert.equal(body.cta.slide.swipe, 'Swipe');
        assert.equal(body.cta.slide.igAsk, 'a', 'untouched words go back as they came');
        assert.deepEqual(body.schedule, { timezone: 'Europe/London', slots: ['13:00', '18:30'] });
        assert.deepEqual(body.library, { root: null }, 'an emptied folder is "not set"');
        assert.equal(s.toasts.at(-1)?.message, s.t('studio.settings.saved'));
    });

    it('previews the IG line with a sample keyword, and the DM filled in', async () => {
        const s = loadStudio();
        await openSettings(s);
        const previews = s.host('sts-previews');
        s.Studio.setting({ dataset: { path: 'cta.instagramAsk' }, value: 'Comment "{keyword}" below' });
        s.Studio.setting({ dataset: { path: 'cta.dmTemplate' }, value: 'Hi {username}!\n{question}\n{url}\n{bullets}\n{unknown}' });
        s.Studio.destroy();
        const html = previews.innerHTML;
        const keyword = s.t('studio.settings.sample.keyword');
        assert.ok(html.includes(`Comment &quot;${keyword}&quot; below`), 'the keyword filled in');
        assert.ok(html.includes(`Hi ${s.t('studio.settings.sample.username')}!`));
        assert.ok(html.includes(s.t('studio.settings.sample.question')));
        assert.ok(html.includes('https://example.com/course?ref=1'), 'the product link');
        assert.ok(html.includes('Lifetime access\nCertificate'), 'the DM bullets, one per line');
        assert.ok(html.includes('{unknown}'), 'what is not a placeholder is left as typed');
    });

    it('shows a new worker’s token once — with Copy and a warning — and never again', async () => {
        const s = loadStudio();
        await openSettings(s, studioSettings(), [{ id: 'w0', name: 'Old Mac', last_seen_at: minutesAgo(0.5), created_at: '2026-09-01T00:00:00.000Z' }]);
        const listed = s.dom.get('page-container')!.innerHTML;
        assert.ok(listed.includes('Old Mac') && listed.includes('data-action="studio:revokeWorker"'), 'each worker, with Revoke');
        assert.ok(listed.includes(s.t('studio.worker.online')), 'seen within 90s');

        const workers = s.host('studio-workers');
        const names: string[] = [];
        s.api.createStudioWorker = (name: string) => {
            names.push(name);
            return Promise.resolve({ worker: { id: 'w1', name, created_at: new Date().toISOString() }, token: 'stw_secret_123' });
        };
        await s.Studio.createWorker(fakeForm({ name: '  Mac mini  ' }), submitEvent);
        assert.deepEqual(names, ['Mac mini']);
        const shown = workers.innerHTML;
        assert.equal(shown.split('stw_secret_123').length - 1, 1, 'the token is on screen, once');
        assert.ok(shown.includes(s.t('studio.workers.tokenOnce')), 'with the warning');
        assert.ok(shown.includes('data-action="studio:copyToken"'), 'and a Copy button');
        assert.ok(!shown.includes('data-copy='), 'Copy reads it from memory, not from an attribute');
        await s.Studio.copyToken();
        assert.deepEqual(s.copied, ['stw_secret_123']);

        s.Studio.dismissToken();
        assert.equal(s.Studio.newWorker, null);
        assert.ok(!workers.innerHTML.includes('stw_secret_123'), 'gone after Done');
        assert.ok(workers.innerHTML.includes('Mac mini'), 'the worker itself stays listed');
        assert.ok(!JSON.stringify(s.Studio.workers).includes('stw_secret_123'), 'and the list never held it');

        s.Studio.newWorker = { worker: { id: 'w2', name: 'x' }, token: 'stw_other' };
        s.Studio.destroy();
        assert.equal(s.Studio.newWorker, null, 'leaving the page ends "once"');

        const before = names.length;
        await s.Studio.createWorker(fakeForm({ name: '   ' }), submitEvent);
        assert.equal(names.length, before, 'a worker needs a name');
    });
});

// ─── The three-step flow (Studio UX v2) ──────────────────────────────────────
const currentStep = (markup: string): string => ((markup.match(/<li class="studio-step is-current" aria-current="step">[\s\S]*?<span class="studio-step-label">([^<]*)<\/span>/) || [])[1] || '');

describe('StudioPage — one path in three steps', () => {
    it('a stepper says where the operator is: 1 on the home view, 3 in the editor, all done once scheduled', async () => {
        const s = loadStudio();
        stubHome(s.api);
        await s.Studio.render();
        const home = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        assert.equal(currentStep(home), s.t('studio.step.topic'));
        assert.equal((home.match(/class="studio-step is-/g) || []).length, 3);

        const e = loadStudio();
        await openEditor(e);
        const editor = e.dom.get('page-container')!.innerHTML;
        e.Studio.destroy();
        assert.equal(currentStep(editor), e.t('studio.step.review'));
        assert.equal((editor.match(/class="studio-step is-done"/g) || []).length, 2, 'topic and generate are behind it');

        const S = e.Studio as Json;
        S.draft = studioDraft({ status: 'scheduled' });
        assert.equal(S.editorStep(), 4);
        assert.equal((String(S.stepperMarkup(4)).match(/is-done/g) || []).length, 3);
    });

    it('one primary button per step: Generate at home, then Save while there are edits, else the way to Schedule', async () => {
        const s = loadStudio();
        stubHome(s.api);
        await s.Studio.render();
        const home = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        assert.deepEqual((home.match(/class="btn btn-primary[^"]*"/g) || []).length, 1, 'Generate is the only primary');
        assert.ok(tagOf(home, 'studio-generate').includes('btn-primary'));

        const e = loadStudio();
        const bar = e.host('studio-savebar');
        await openEditor(e);
        let markup = String((e.Studio as Json).saveBarMarkup());
        assert.ok(!markup.includes('btn-primary') && markup.includes('data-action="studio:goSchedule"'), 'clean and ready: the way to Schedule');
        e.Studio.slideField({ dataset: { slide: '1', path: 'title' }, value: 'عنوان جديد' });
        markup = bar.innerHTML;
        e.Studio.destroy();
        assert.equal((markup.match(/btn-primary/g) || []).length, 1);
        assert.ok(tagOf(markup, 'studio-save').includes('btn-primary'), 'with edits: Save is the one');
        assert.ok(markup.includes(e.t('studio.editor.unsaved')));
    });

    it('only the picker and Generate up front; angle, slides, keyword and accent under a closed "More options"', async () => {
        const s = loadStudio();
        stubHome(s.api);
        await s.Studio.render();
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        const more = (page.match(/<details class="studio-more" id="studio-more">[\s\S]*?<\/details>/) || [''])[0];
        assert.ok(more, 'a <details>, closed');
        for (const id of ['studio-angle', 'studio-slides', 'studio-keyword', 'studio-accent']) assert.ok(more.includes(`id="${id}"`), `${id} is inside it`);
        assert.ok(more.includes(s.t('studio.new.summaryAngleAuto')) && more.includes(s.t('studio.new.summarySlides', { n: '8' })), 'the closed state says what will be sent');
        assert.ok(page.includes('id="studio-lesson-q"') && page.includes('data-action="studio:setMode" data-mode="idea"'), 'search, and the switch to an idea');
    });

    it('remembers angle, slides and accent in this browser — but never the keyword', async () => {
        const storage = fakeStorage();
        const s = loadStudio({}, storage);
        s.api.createStudioDraft = () => Promise.resolve({ draft: { id: 'n1', status: 'rendering' } });
        s.Studio.selected = ['l1'];
        await s.Studio.generate(fakeForm({ angle: 'mistakes', slides: '7', keyword: 'هدف', accent: '#7C5CFF' }), submitEvent);
        const saved = JSON.parse(storage.getItem('studio:prefs') || '{}');
        assert.deepEqual(saved, { mode: 'lesson', angle: 'mistakes', slides: 7, accent: '#7C5CFF' });

        const next = loadStudio({}, storage);
        stubHome(next.api);
        await next.Studio.render();
        const page = next.dom.get('page-container')!.innerHTML;
        next.Studio.destroy();
        assert.ok(page.includes('<option value="mistakes" selected>'), 'the angle comes back');
        assert.ok(/<option value="7" selected>/.test(page), 'and the slide count');
        assert.ok(tagOf(page, 'studio-accent').includes('value="#7C5CFF"'), 'and the accent');
        assert.ok(tagOf(page, 'studio-keyword').includes('value=""'), 'a reused keyword would answer the next post with this one’s DM');

        const broken = fakeStorage();
        broken.setItem('studio:prefs', '{"angle":"sideways","slides":40,"accent":"red"}');
        const b = loadStudio({}, broken);
        assert.deepEqual(plainJson((b.Studio as Json).prefs()), { mode: null, angle: 'auto', slides: 8, accent: '' }, 'junk is re-checked, not trusted');
    });

    it('a carousel finished for the tenant the operator switched away from opens nothing and says nothing', async () => {
        const s = loadStudio();
        let resolve: (v: Json) => void = () => {};
        s.api.createStudioDraft = () => new Promise((r) => { resolve = r; });
        s.Studio.selected = ['l1'];
        const run = s.Studio.generate(fakeForm({}), submitEvent);
        await settle(2);
        assert.equal((s.Studio as Json).generating, true);
        (s.Studio as Json).resetTenantState();
        // The operator is now on the NEW tenant's Studio home: exactly where a stale answer would open.
        s.app.currentPage = 'studio';
        s.host('studio-new');
        resolve({ draft: { id: 'old-tenant', status: 'rendering' } });
        await run;
        assert.equal(s.nav.length, 0, 'not opened under the new tenant');
        assert.equal(s.toasts.length, 0, 'and not announced');
        assert.equal((s.Studio as Json).generating, false);
    });

    it('lesson mode with nothing picked says so on the picker, and an idea is sent without lessons', async () => {
        const s = loadStudio();
        const sent: Json[] = [];
        s.api.createStudioDraft = (body: Json) => { sent.push(body); return Promise.resolve({ draft: { id: 'x', status: 'rendering' } }); };
        const search = s.host('studio-lesson-q');
        const errorHost = s.host('studio-new-error');
        await s.Studio.generate(fakeForm({ idea: '' }), submitEvent);
        assert.equal(sent.length, 0);
        assert.ok(errorHost.innerHTML.includes(s.t('studio.new.needLesson')));
        assert.equal(search.getAttribute('aria-invalid'), 'true');

        (s.Studio as Json).mode = 'idea';
        s.Studio.selected = ['l1'];
        await s.Studio.generate(fakeForm({ idea: 'Local RAG in ten minutes' }), submitEvent);
        assert.deepEqual(plainJson(sent[0]).lessonIds, [], '"From an idea" means the idea alone');
    });
});

describe('StudioPage — empty and blocked states', () => {
    const homeWith = async (status: Json, settings: Json, lessons: Json[] = [], drafts: Json[] = []): Promise<{ s: StudioLoaded; page: string }> => {
        const s = loadStudio();
        s.api.getStudioStatus = () => Promise.resolve(status);
        s.api.getStudioLessons = () => Promise.resolve({ lessons });
        s.api.getStudioDrafts = () => Promise.resolve({ drafts });
        s.api.getStudioSettings = () => Promise.resolve({ settings });
        await s.Studio.render();
        const page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        return { s, page };
    };
    const setupSteps = (page: string): string[] => [...page.matchAll(/<li class="setup-step( is-done)?">/g)].map((m) => (m[1] ? 'done' : 'todo'));

    it('a brand-new tenant gets a three-step setup list, each step with its way forward, and an idea still works', async () => {
        const { s, page } = await homeWith(
            studioStatus({ worker: { online: false, lastSeen: null, name: null }, lessons: { total: 0, indexed: 0, indexing: 0, failed: 0 } }),
            studioSettings({ library: { root: null } }),
        );
        assert.ok(page.includes('id="studio-setup"'));
        assert.deepEqual(setupSteps(page), ['todo', 'todo', 'todo']);
        assert.ok(page.includes('href="#/studio?tab=settings&amp;focus=library"'), 'the folder step goes to the field itself');
        assert.ok(page.includes('href="#/studio?tab=settings&amp;focus=workers"'), 'the worker step to Workers');
        assert.ok(/\sdisabled\b/.test(tagOf(page, 'studio-setup-scan')), 'nothing to scan without a folder');
        assert.ok(/\sdisabled\b/.test(tagOf(page, 'studio-generate')), 'Generate waits for a lesson…');
        assert.ok(page.includes(s.t('studio.new.blockedHint')), '…and says why');
        assert.ok(page.includes('data-action="studio:setMode" data-mode="idea"'), 'with the way out');
        assert.ok(page.includes(s.t('studio.worker.neverTitle')), 'and what the worker is, before it has ever connected');
    });

    it('folder set, not scanned: the Scan button is live; indexing: a progress bar that reads "12 of 34"', async () => {
        const scanned = await homeWith(studioStatus({ lessons: { total: 0, indexed: 0, indexing: 0, failed: 0 } }), studioSettings());
        assert.deepEqual(setupSteps(scanned.page), ['done', 'done', 'todo']);
        const scan = tagOf(scanned.page, 'studio-setup-scan');
        assert.ok(scan.includes('data-action="studio:scanLibrary"') && !/\sdisabled\b/.test(scan));

        const lessons = studioLessons().lessons.map((l: Json, i: number) => ({ ...l, status: i < 2 ? 'indexed' : 'indexing' }));
        const indexing = await homeWith(studioStatus({ lessons: { total: 34, indexed: 12, indexing: 5, failed: 0 } }), studioSettings(), lessons);
        const bar = tagOf(indexing.page, 'studio-library-meter');
        assert.ok(bar.startsWith('<progress') && bar.includes('value="12"') && bar.includes('max="34"'));
        assert.ok(bar.includes(`aria-valuetext="${indexing.s.t('studio.countSr', { n: '12', max: '34' })}"`));
        assert.ok(tagOf(indexing.page, 'studio-index-meter').includes('value="2"'), 'the picker says the same about its own list');
    });

    it('no drafts yet: an example of what a draft looks like, and how to get one', async () => {
        const { s, page } = await homeWith(studioStatus(), studioSettings(), studioLessons().lessons, []);
        assert.ok(page.includes('id="studio-drafts-example"'));
        assert.ok(page.includes(s.t('studio.drafts.emptyBody')) && page.includes(s.t('studio.drafts.exampleCaption')));
    });

    it('Retry on the offline notice re-reads the status and says what came back', async () => {
        const s = loadStudio();
        const S = s.Studio as Json;
        s.api.getStudioStatus = () => Promise.resolve(studioStatus({ worker: { online: false, lastSeen: minutesAgo(200), name: 'Mac' } }));
        s.api.getStudioDrafts = () => Promise.resolve({ drafts: [] });
        await S.retryWorker(null);
        assert.equal(s.toasts.at(-1)?.message, s.t('studio.worker.stillOffline'));
        s.api.getStudioStatus = () => Promise.resolve(studioStatus());
        await S.retryWorker(null);
        assert.equal(s.toasts.at(-1)?.message, s.t('studio.worker.backOnline'));
    });
});

describe('StudioPage — editing, preview first', () => {
    it('every slide has its form in the page, one shown: the rail is tabs, and a tab opens its slide', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio as Json;
        const page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes('role="tablist"') && (page.match(/role="tab"/g) || []).length === 8);
        assert.ok(tagOf(page, 'st-0-tab').includes('aria-selected="true"') && tagOf(page, 'st-1-tab').includes('tabindex="-1"'), 'one tab stop');
        assert.ok(!tagOf(page, 'st-0').includes('hidden') && tagOf(page, 'st-1').includes('hidden'), 'slide 1 shown, the rest hidden');
        assert.ok(page.includes('aria-roledescription="') && page.includes('data-action="studio:editSlide"'), 'the preview is a carousel you can click into');
        const previews = s.host('studio-previews');
        S.selectSlide(3);
        s.Studio.destroy();
        assert.equal(S.selectedSlide, 3);
        assert.ok(previews.innerHTML.includes('src="https://cdn.test/ig-4.jpg"'), 'the phone shows slide 4');
        assert.ok(tagOf(previews.innerHTML, 'st-3-tab').includes('aria-selected="true"'));
    });

    it('arrow keys follow the reading direction: in Arabic, left is the next slide', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio as Json;
        const stage = { closest: (sel: string) => (sel === '.phone-stage' ? {} : null) };
        const key = (k: string): void => S.onKeydown({ key: k, target: stage, preventDefault: () => {} }, 'editor');
        key('ArrowLeft');
        assert.equal(S.selectedSlide, 1, 'RTL: left is forward');
        key('ArrowRight');
        assert.equal(S.selectedSlide, 0);
        key('End');
        assert.equal(S.selectedSlide, 7);
        key('ArrowLeft');
        assert.equal(S.selectedSlide, 7, 'and stops at the end');
        s.Studio.destroy();
    });

    it('Cmd/Ctrl+S saves the edits, and does nothing when there are none', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio as Json;
        let prevented = 0;
        let patches = 0;
        s.api.updateStudioDraft = (_id: string, body: Json) => { patches++; return Promise.resolve({ draft: studioDraft({ status: 'rendering', carousel: body.carousel }) }); };
        S.onKeydown({ key: 's', metaKey: true, preventDefault: () => { prevented++; } }, 'editor');
        await settle();
        assert.equal(patches, 0, 'nothing to save');
        assert.equal(prevented, 1, 'but the browser still does not "Save page"');
        s.Studio.slideField({ dataset: { slide: '1', path: 'title' }, value: 'ابدأ بالنتيجة دائماً' });
        S.onKeydown({ key: 'S', ctrlKey: true, preventDefault: () => { prevented++; } }, 'editor');
        await settle();
        s.Studio.destroy();
        assert.equal(patches, 1, 'Ctrl+S saved');
        assert.equal(s.Studio.isDirty(), false);
    });

    it('never loses typing: edits are kept in this browser, offered back on the next visit, and dropped once saved', async () => {
        const storage = fakeStorage();
        const s = loadStudio({}, storage);
        await openEditor(s);
        s.Studio.slideField({ dataset: { slide: '1', path: 'title' }, value: 'لم يُحفظ بعد' });
        s.Studio.destroy();
        const kept = JSON.parse(storage.getItem('studio:edits:d1') || 'null');
        assert.equal(kept.work.carousel.slides[1].title, 'لم يُحفظ بعد', 'every edit is written at once');

        const back = loadStudio({}, storage);
        const notices = back.host('studio-notices');
        await openEditor(back);
        const S = back.Studio as Json;
        assert.equal(S.restored.state, 'restored');
        assert.equal(S.work.carousel.slides[1].title, 'لم يُحفظ بعد');
        assert.equal(back.Studio.isDirty(), true);
        assert.ok(back.dom.get('page-container')!.innerHTML.includes(back.t('studio.restore.restored')), 'and it says so');
        back.api.updateStudioDraft = (_id: string, body: Json) => Promise.resolve({ draft: studioDraft({ status: 'rendering', carousel: body.carousel }) });
        await back.Studio.save();
        back.Studio.destroy();
        assert.equal(storage.getItem('studio:edits:d1'), null, 'saved: the copy is gone');
        assert.ok(!notices.innerHTML.includes(back.t('studio.restore.restored')));

        // Made against an older server copy: offered, not applied blind.
        storage.setItem('studio:edits:d1', JSON.stringify({ baseline: '{"old":true}', work: kept.work }));
        const stale = loadStudio({}, storage);
        await openEditor(stale);
        const T = stale.Studio as Json;
        assert.equal(T.restored.state, 'stale');
        assert.equal(stale.Studio.isDirty(), false, 'nothing applied yet');
        T.applyRestored();
        stale.Studio.destroy();
        assert.equal(T.work.carousel.slides[1].title, 'لم يُحفظ بعد', 'applied on request');
    });

    it('a deleted slide can be put back exactly where it was', async () => {
        const s = loadStudio();
        const notices = s.host('studio-notices');
        await openEditor(s);
        const S = s.Studio as Json;
        const original = plainJson(S.work.carousel.slides[2]);
        S.deleteSlide(2);
        assert.equal(S.work.carousel.slides.length, 7);
        assert.ok(notices.innerHTML.includes('data-action="studio:undo"') && notices.innerHTML.includes(s.t('studio.undo.deleted', { n: 3, kind: s.t('studio.kind.list') })));
        S.undoLast();
        s.Studio.destroy();
        assert.equal(S.work.carousel.slides.length, 8);
        assert.deepEqual(plainJson(S.work.carousel.slides[2]), original);
        assert.equal(s.Studio.isDirty(), false, 'deleted and restored is no change at all');
        assert.ok(!notices.innerHTML.includes('data-action="studio:undo"'), 'the offer is gone once used');
    });

    it('duplicates a slide, and changes a slide’s type keeping what both types share — with Undo', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio as Json;
        S.duplicateSlide(1);
        assert.equal(S.work.carousel.slides.length, 9);
        assert.deepEqual(plainJson(S.work.carousel.slides[2]), plainJson(S.work.carousel.slides[1]));
        assert.equal(S.selectedSlide, 2, 'the copy is the slide now open');
        S.duplicateSlide(0);
        assert.equal(S.work.carousel.slides.length, 9, 'one cover only');

        // Slide 6 (index 5 after the copy) is the steps slide: to a list, the steps become items.
        const steps = plainJson(S.work.carousel.slides[5]);
        assert.equal(steps.kind, 'steps');
        S.changeKind({ dataset: { slide: '5' }, value: 'list' });
        const list: Json = plainJson(S.work.carousel.slides[5]);
        assert.equal(list.kind, 'list');
        assert.equal(list.title, 'بالخطوات', 'the title carries over');
        assert.deepEqual(list.items.map((i: Json) => i.text), ['الدور', 'المهمة', 'الصيغة']);
        assert.equal(list.items[1].sub, 'وش المطلوب');
        S.undoLast();
        s.Studio.destroy();
        assert.deepEqual(plainJson(S.work.carousel.slides[5]), steps, 'Undo restores it exactly');
    });

    it('the screenshot picker shows clean frames only by default, and says how many it hides', () => {
        const s = loadStudio();
        const S = s.Studio as Json;
        S.work = { carousel: studioCarousel(), shots: {}, campaign: {} };
        S._shotSlide = 0;
        const moments = [...studioMoments().moments, { id: 'mo4', lesson_id: 'l1', t: 130, description: 'Arrows drawn on it', kind: 'other', clean: false, thumb_url: '/api/uploads/t4' }];
        let markup = String(S.shotPickerMarkup({ lesson: {}, moments }));
        assert.ok(markup.includes(s.t('studio.shot.showing', { n: '3', total: '4' })));
        assert.ok(!markup.includes('data-moment="mo4"'));
        S.cleanOnly = false;
        markup = String(S.shotPickerMarkup({ lesson: {}, moments }));
        assert.ok(markup.includes('data-moment="mo4"') && markup.includes(s.t('studio.shot.showing', { n: '4', total: '4' })));
        assert.ok(String(S.shotHeroMarkup(moments[3])).includes(s.t('studio.moment.notClean')), 'the large view says what is wrong with it');
    });

    it('"Write it again" makes a new draft from the same source, at the chosen angle, and goes to watch it', async () => {
        const s = loadStudio();
        await openEditor(s);
        const S = s.Studio as Json;
        assert.deepEqual(plainJson(S.regenInput(fakeForm({ angle: 'steps', slides: '7' }))), {
            lessonIds: ['l1'], angle: 'steps', slides: 7, keyword: 'برومبت', accent: '#FF6B6B',
        });
        const posted: Json[] = [];
        s.api.createStudioDraft = (body: Json) => { posted.push(body); return Promise.resolve({ draft: { id: 'v2', status: 'rendering' } }); };
        s.api.getStudioDrafts = () => Promise.resolve({ drafts: [] });
        await S.regenerate(fakeForm({ angle: 'mistakes', slides: '8' }), submitEvent);
        s.Studio.destroy();
        assert.deepEqual(plainJson(s.nav[0]), { page: 'studio' }, 'to the home view, where the progress is');
        assert.equal(posted.length, 1);
        assert.equal(plainJson(posted[0]).angle, 'mistakes');
        assert.equal(S.draftId === 'v2', false, 'this draft is left as it was');
    });
});

describe('StudioPage — scheduling says exactly what will happen', () => {
    const slotB = '2026-09-26T18:00:00.000Z';

    it('names the platforms, the time in the tenant’s zone and city, the TikTok outcome and the DM', async () => {
        const s = loadStudio();
        s.I18N.lang = 'en';
        await openEditor(s);
        const S = s.Studio as Json;
        s.Studio.destroy();
        const time = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Riyadh' }).format(new Date(slotB));
        assert.ok(time.includes('9:00 PM'), '18:00Z is 9 PM in Riyadh');
        assert.equal(S.zoneTime(slotB), time);
        const lines = (choice: Json): string[] => (JSON.parse(JSON.stringify(S.scheduleSummary(choice))) as Json[]).map((l) => String(l.text));
        const queued = lines({ when: slotB, tiktok: 'queue', campaign: true });
        assert.equal(queued[0], s.t('studio.schedule.sumMeta', { when: s.t('studio.schedule.sumWhen', { time, city: 'Riyadh' }) }));
        assert.equal(queued[1], s.t('studio.schedule.sumTikTokQueue'));
        assert.equal(queued[2], s.t('studio.schedule.sumDm', { keyword: 'برومبت' }));
        assert.equal(lines({ when: slotB, tiktok: 'none', campaign: false })[1], s.t('studio.schedule.sumTikTokNone'));
        assert.equal(lines({ when: slotB, tiktok: 'none', campaign: false })[2], s.t('studio.schedule.sumNoDm', { keyword: 'برومبت' }));
        assert.ok(String(lines({ when: slotB, tiktok: 'scheduled', campaign: true })[1]).includes(time));
        const markup = String(S.scheduleMarkup());
        assert.ok(markup.includes('id="studio-schedule-summary"') && markup.includes('aria-live="polite"'));
        assert.ok(markup.includes(s.t('studio.schedule.zoneHint', { city: 'Riyadh', zone: 'Asia/Riyadh' })), 'the zone is said, not assumed');
        s.I18N.lang = 'ar';
        assert.equal(S.zoneCity('Asia/Riyadh'), 'الرياض', 'in Arabic, the city in Arabic');
    });
});

describe('StudioPage — settings problems sit next to their fields', () => {
    it('checks the server’s rules first, and files a 400’s problems under the fields they name', async () => {
        const s = loadStudio();
        s.hash.tab = 'settings';
        s.api.getStudioSettings = () => Promise.resolve({ settings: studioSettings() });
        s.api.getStudioWorkers = () => Promise.resolve({ workers: [] });
        s.api.getStudioStatus = () => Promise.resolve(studioStatus());
        await s.Studio.render();
        const S = s.Studio as Json;
        let puts = 0;
        s.api.saveStudioSettings = () => { puts++; return Promise.reject(Object.assign(new Error('Some settings need fixing.'), { status: 400, body: { error: 'Some settings need fixing.', problems: ['schedule.slots[1] must be a time like 13:00', 'a problem with no path'] } })); };
        S.setting({ dataset: { path: 'product.url' }, value: 'http://acme.test' });
        await S.saveSettings(fakeForm({}), submitEvent);
        let page = s.dom.get('page-container')!.innerHTML;
        assert.equal(puts, 0, 'caught before the round trip');
        assert.ok(tagOf(page, 'sts-product-url').includes('aria-invalid="true"'));
        assert.ok(/id="sts-product-url-problems"[^>]*>\s*<li dir="auto">/.test(page) && page.includes(s.t('studio.settings.err.url')));

        S.setting({ dataset: { path: 'product.url' }, value: 'https://acme.test' });
        await S.saveSettings(fakeForm({}), submitEvent);
        page = s.dom.get('page-container')!.innerHTML;
        s.Studio.destroy();
        assert.equal(puts, 1);
        assert.equal(S.settingsProblemPath('schedule.slots[1] must be a time like 13:00'), 'schedule.slots.1');
        assert.ok(tagOf(page, 'sts-schedule-slots-1').includes('aria-invalid="true"'), 'the second slot is the one marked');
        assert.ok(page.includes('a problem with no path'), 'and what names no field stays in the list by Save');
    });
});
