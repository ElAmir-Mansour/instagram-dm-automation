/**
 * The shell's router (`App` in dashboard/js/app.js): what a page change does besides painting, the leave guard, aliases, addresses and
 * page stylesheets (UX plan F6: T003, T029, T030; audit SH-05, SH-07, SH-09a, SH-18).
 *
 * Every one of these is invisible in a screenshot and silent when it breaks: a tab that says the same thing on every page, a page that
 * opens halfway down, focus left on a nav item that is hidden, a Back button that throws away a half-written post, an old link that
 * lands on the wrong tab. So they are pinned here, against the REAL app.js and the real components, catalogues and Motion, loaded
 * through `_harness.ts`. The pages themselves are small fakes (`fakePage`): the router's contract is what is under test, and a real
 * page's rendering is covered by that page's own suite.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, settle, type Dashboard, type Json, type LoadOptions } from './_harness.js';

const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** A page module as the router sees one: it records what the router asks of it. */
function fakePage(over: Json = {}): Json {
    const log: string[] = [];
    return { log, render: () => { log.push('render'); }, destroy: () => { log.push('destroy'); }, ...over };
}

interface Rig {
    h: Dashboard;
    App: Json;
    pages: Record<string, Json>;
    /** The confirm dialogs the router opened, as the options it passed. */
    confirms: Json[];
    /** Move to `hash` the way the browser does: the address changes, then `hashchange` arrives carrying the old one. */
    hashchange(hash: string): Promise<void>;
    /** Dismiss the open dialog the way Escape, the backdrop or Cancel do. */
    dismiss(): Promise<void>;
    /** Press the dialog's confirm button: its callback, then the dialog closing. */
    accept(index?: number): Promise<void>;
}

/** App.js, the shell's elements, fake pages for the named routes, and `Admin.confirm` as a recorder that draws nothing. */
function rig(options: LoadOptions & { pageNames?: string[] } = {}): Rig {
    const { pageNames = ['overview', 'inbox', 'posts', 'settings'], ...load } = options;
    const confirms: Json[] = [];
    const Admin = {
        // `UI.showModal` runs the previous dialog's close hook before it draws the next one: a recorder that does not would hide a bug.
        confirm: (o: Json): void => { dashboardRef.h.UI._runAfterClose(); confirms.push(o); },
    };
    const dashboardRef = { h: null as unknown as Dashboard };
    const h = loadDashboard({ app: true, ...load, globals: { Admin, ...(load.globals ?? {}) } });
    dashboardRef.h = h;
    // `UI.confirm` exists (UX F5), so the router asks through it. The recorder keeps both of its shapes honest: in place of the
    // modal it runs the previous dialog's close hook first, as `UI.showModal` does; stacked over a modal (`stack: true`) it
    // does not, and "no" arrives through `onCancel`.
    if (h.UI && typeof h.UI.confirm === 'function') {
        h.UI.confirm = (o: Json): void => { if (!o.stack) h.UI._runAfterClose(); confirms.push(o); };
    }
    for (const id of ['page-title', 'page-subtitle', 'page-container', 'sidebar', 'mobile-menu-btn']) h.el(id);
    // The person has just clicked a nav item: it is still where focus is, and it is still on screen.
    h.document.activeElement = h.el('nav-link');
    const pages: Record<string, Json> = {};
    for (const name of pageNames) {
        pages[name] = fakePage();
        h.App.pages[name] = { src: name, page: () => pages[name] };
    }
    const rigged: Rig = {
        h, App: h.App, pages, confirms,
        async hashchange(hash: string): Promise<void> {
            const from = h.location.hash;
            h.location.hash = hash;
            h.App.onHashChange({ oldURL: `https://example.test/dashboard${from}`, newURL: `https://example.test/dashboard${hash}` });
            await settle();
        },
        async dismiss(): Promise<void> {
            const last = confirms[confirms.length - 1];
            if (last && last.stack) last.onCancel(); else h.UI._runAfterClose();
            await settle();
        },
        async accept(index = confirms.length - 1): Promise<void> {
            const o = confirms[index]!;
            o.onConfirm();
            if (!o.stack) h.UI._runAfterClose();
            await settle();
        },
    };
    return rigged;
}

// ─── The tab title ──────────────────────────────────────────────────────────────────────────

describe('router: the tab title names the page (SH-05)', () => {
    it('is "<Page> · <app name>" after a page opens, in the interface language', async () => {
        const { h, App } = rig();
        await App.navigate('inbox');
        assert.equal(h.document.title, `${h.t('nav.inbox')} · ${h.t('app.name')}`);
        assert.match(h.document.title, / · AutoReply Pro$/);
        await App.navigate('posts');
        assert.equal(h.document.title, `${h.t('nav.posts')} · ${h.t('app.name')}`, 'and it follows the page');
        assert.equal(h.el('page-title').textContent, h.t('nav.posts'), 'beside the heading it names');
    });

    it('is written in Arabic when the interface is', async () => {
        const { h, App } = rig({ lang: 'ar' });
        await App.navigate('inbox');
        assert.equal(h.document.title, `${h.t('nav.inbox')} · ${h.t('app.name')}`);
        assert.match(h.document.title, /[؀-ۿ]/);
        assert.equal(/AutoReply/.test(h.document.title), false, 'the Arabic name, not the Latin one');
    });

    it('keeps the unread count in front, through a count change and through a page change', async () => {
        const { h, App } = rig();
        await App.navigate('inbox');
        const base = `${h.t('nav.inbox')} · ${h.t('app.name')}`;
        App.setInboxWaiting(3);
        assert.equal(h.document.title, `(3) ${base}`);
        await App.navigate('posts');
        assert.equal(h.document.title, `(3) ${h.t('nav.posts')} · ${h.t('app.name')}`, 'a new page does not drop the count');
        App.setInboxWaiting(0);
        assert.equal(h.document.title, `${h.t('nav.posts')} · ${h.t('app.name')}`, 'zero removes it');
        App.setInboxWaiting(150);
        assert.match(h.document.title, /^\(99\+\) /);
        App.setInboxWaiting('7');
        assert.match(h.document.title, /^\(7\) /, 'a count that arrives as text is a count');
        App.setInboxWaiting(-4);
        assert.equal(h.document.title.startsWith('('), false, 'a negative is none');
    });

    it('goes back to the app\'s own name on the login screen, with no count and no page', async () => {
        const { h, App } = rig();
        h.el('login-screen');
        h.el('app');
        await App.navigate('inbox');
        App.setInboxWaiting(2);
        App.showLogin();
        assert.equal(h.document.title, `${h.t('app.name')} — ${h.t('app.tagline')}`);
        await App.navigate('posts');
        assert.equal(h.document.title, `${h.t('nav.posts')} · ${h.t('app.name')}`, 'and the next sign-in starts clean: no count carried over');
    });
});

// ─── Announce, scroll, focus ────────────────────────────────────────────────────────────────

describe('router: a page change is announced, opens at the top and moves focus where it must (SH-05, SH-07)', () => {
    it('announces the page name to a screen reader on a change, and only on a change', async () => {
        const { h, App } = rig();
        await App.navigate('inbox');
        assert.deepEqual(h.announcements, [h.t('nav.inbox')]);
        await App.navigate('posts');
        assert.deepEqual(h.announcements, [h.t('nav.inbox'), h.t('nav.posts')]);
        await App.navigate('posts');
        assert.equal(h.announcements.length, 2, 're-rendering the same page (Retry, a theme change) is not news');
    });

    it('scrolls the window to the top when the page changes, and not when the same page is drawn again', async () => {
        const { h, App } = rig();
        await App.navigate('inbox');
        assert.deepEqual(plain(h.scrolls), [{ top: 0 }]);
        await App.navigate('posts');
        assert.deepEqual(plain(h.scrolls), [{ top: 0 }, { top: 0 }]);
        await App.navigate('posts');
        assert.equal(h.scrolls.length, 2, 'a re-render keeps the reader where they are');
    });

    it('does not scroll for a hash change the page handles itself (a tab, a filter, a help article)', async () => {
        const { h, App, pages } = rig();
        h.location.hash = '#/inbox';
        await App.navigate('inbox');
        const before = h.scrolls.length;
        const rendered = pages['inbox'].log.length;
        let handled = 0;
        pages['inbox'].onHashChange = () => { handled += 1; };
        h.location.hash = '#/inbox?filter=hot';
        App.onHashChange({ oldURL: 'https://example.test/dashboard#/inbox' });
        await settle();
        assert.equal(handled, 1, 'the page took it');
        assert.equal(h.scrolls.length, before, 'and nothing scrolled');
        assert.equal(pages['inbox'].log.length, rendered, 'nor re-rendered');
    });

    it('moves focus to #page-title after a KEYBOARD navigation, with tabindex="-1" and without scrolling', async () => {
        const { h, App } = rig();
        await App.navigate('inbox');
        assert.equal(h.el('page-title').focusCalls.length, 0, 'not on the first page of a session: that would skip the skip link');
        // Enter on a nav link: a keydown reaches the shell first.
        App.bindShellGuards();
        h.fire('document', 'keydown', { key: 'Enter' });
        await App.navigate('posts');
        assert.deepEqual(plain(h.el('page-title').focusCalls), [{ preventScroll: true }]);
        assert.equal(h.el('page-title').getAttribute('tabindex'), '-1');
    });

    it('leaves focus alone after a mouse click: the thing clicked is still on screen where it was', async () => {
        const { h, App } = rig();
        App.bindShellGuards();
        await App.navigate('inbox');
        h.fire('document', 'pointerdown', {});
        await App.navigate('posts');
        assert.equal(h.el('page-title').focusCalls.length, 0);
    });

    it('moves focus after a pointer navigation too when the drawer was open: its items are about to be hidden', async () => {
        const { h, App } = rig();
        App.bindShellGuards();
        await App.navigate('inbox');
        h.el('sidebar').classList.add('open');
        h.fire('document', 'pointerdown', {});
        await App.navigate('posts');
        assert.equal(h.el('page-title').focusCalls.length, 1);
        assert.equal(h.el('sidebar').classList.contains('open'), false, 'and the drawer closed');
    });

    it('moves focus when it has nowhere to be: the control that held it was replaced with the page', async () => {
        const { h, App } = rig();
        await App.navigate('inbox');
        h.document.activeElement = null; // `<body>`
        await App.navigate('posts');
        assert.equal(h.el('page-title').focusCalls.length, 1);
        h.document.activeElement = h.el('gone');
        h.el('gone').remove();
        await App.navigate('inbox');
        assert.equal(h.el('page-title').focusCalls.length, 2, 'a detached element is not a place focus can be');
    });

    it('does not move focus when only the same page is drawn again, even after a key', async () => {
        const { h, App } = rig();
        App.bindShellGuards();
        await App.navigate('inbox');
        h.fire('document', 'keydown', { key: 'Enter' });
        await App.navigate('inbox');
        assert.equal(h.el('page-title').focusCalls.length, 0);
    });
});

describe('index.html: the page heading', () => {
    const index = readFileSync('dashboard/index.html', 'utf8');
    const heading = /<h1\b[^>]*\bid="page-title"[^>]*>/.exec(index)?.[0] ?? '';

    it('can take focus (tabindex="-1") and carries no hard-coded lang (SH-09a)', () => {
        assert.ok(heading, 'the heading is there');
        assert.match(heading, /\btabindex="-1"/);
        assert.equal(/\blang=/.test(heading), false, 'the title is in the interface language, which <html lang> names: a fixed lang="ar" misread English');
    });
});

// ─── The leave guard ────────────────────────────────────────────────────────────────────────

describe('router: the leave guard (SH-18)', () => {
    /** On Posts, which holds unsaved work, with the address Posts has. */
    async function onDirtyPosts(options: Parameters<typeof rig>[0] = {}): Promise<Rig & { dirty: Json }> {
        const r = rig(options);
        const dirty = fakePage({ canLeave: () => false, discardChanges() { dirty.log.push('discard'); } });
        r.pages['posts'] = dirty;
        r.h.location.hash = '#/posts';
        await r.App.navigate('posts');
        return { ...r, dirty };
    }

    it('asks "Discard changes?" before another page replaces one that says it holds unsaved work, and does nothing yet', async () => {
        const r = await onDirtyPosts();
        await r.hashchange('#/inbox');
        assert.equal(r.confirms.length, 1);
        const asked = r.confirms[0]!;
        assert.equal(asked.title, r.h.t('common.leaveTitle'));
        assert.equal(asked.body, r.h.t('common.leaveBody'));
        assert.equal(asked.confirmLabel, r.h.t('common.leaveConfirm'));
        assert.equal(r.App.currentPage, 'posts', 'still the page that holds the work');
        assert.deepEqual(r.dirty.log, ['render'], 'not torn down while the question is open');
        assert.deepEqual(r.pages['inbox']!.log, [], 'and the other page is not drawn');
        assert.equal(r.h.el('page-title').textContent, r.h.t('nav.posts'));
    });

    it('stays on Cancel, Escape or a click outside, and puts the address back to where the person was, in place', async () => {
        const r = await onDirtyPosts();
        await r.hashchange('#/inbox');
        await r.dismiss();
        assert.equal(r.App.currentPage, 'posts');
        assert.deepEqual(r.dirty.log, ['render']);
        assert.deepEqual(r.pages['inbox']!.log, []);
        assert.deepEqual(r.h.replaced, ['#/posts'], 'replaceState, so no history entry is added and no hashchange fires');
        assert.equal(r.h.location.hash, '#/posts');
        assert.equal(r.confirms.length, 1, 'asked once');
    });

    it('restores the address the page itself had moved to, not the one it was first drawn at', async () => {
        const r = await onDirtyPosts();
        // The page narrowed its own address (the Inbox does for its filter) with replaceState: no hashchange, and no copy the router kept.
        r.h.window.history.replaceState(null, '', '#/posts?filter=needs-you');
        r.h.replaced.length = 0;
        await r.hashchange('#/inbox');
        await r.dismiss();
        assert.deepEqual(r.h.replaced, ['#/posts?filter=needs-you']);
    });

    it('leaves on confirm: the page is told to drop what it kept, torn down, and the new one drawn, in that order', async () => {
        const r = await onDirtyPosts();
        await r.hashchange('#/inbox');
        await r.accept();
        assert.deepEqual(r.dirty.log, ['render', 'discard', 'destroy']);
        assert.deepEqual(r.pages['inbox']!.log, ['render']);
        assert.equal(r.App.currentPage, 'inbox');
        assert.equal(r.h.location.hash, '#/inbox', 'the address stays where the person asked to go');
        assert.deepEqual(r.h.replaced, []);
        assert.equal(r.h.document.title, `${r.h.t('nav.inbox')} · ${r.h.t('app.name')}`);
    });

    it('asks nothing of a page that is clean, a page with no canLeave, or one whose canLeave fails', async () => {
        for (const [name, canLeave] of [['true', () => true], ['undefined', () => undefined], ['absent', undefined], ['throws', () => { throw new Error('broken guard'); }]] as const) {
            const r = rig();
            r.pages['posts'] = fakePage(canLeave ? { canLeave } : {});
            const warn = console.warn;
            console.warn = (): void => {};
            try {
                await r.App.navigate('posts');
                await r.hashchange('#/inbox');
            } finally { console.warn = warn; }
            assert.equal(r.confirms.length, 0, name);
            assert.equal(r.App.currentPage, 'inbox', name);
        }
    });

    it('asks nothing when the same page is drawn again: only leaving loses the work', async () => {
        const r = await onDirtyPosts();
        await r.App.navigate('posts');
        assert.equal(r.confirms.length, 0);
        assert.deepEqual(r.dirty.log, ['render', 'destroy', 'render']);
    });

    it('asks nothing on the first page of a session, when there is nothing to leave', async () => {
        const r = rig();
        r.pages['inbox'] = fakePage({ canLeave: () => false });
        await r.App.navigate('inbox');
        assert.equal(r.confirms.length, 0);
        assert.equal(r.App.currentPage, 'inbox');
    });

    it('also guards an open dialog that holds edits, whatever the page says: Back no longer throws a half-written template away', async () => {
        const r = rig();
        r.h.location.hash = '#/overview';
        await r.App.navigate('overview');
        r.h.UI.isModalDirty = () => true;
        await r.hashchange('#/inbox');
        // Asked OVER the dialog (`stack`), never in place of it: drawing into the modal would destroy the fields it asks about.
        assert.equal(r.confirms.length, 1);
        assert.equal(r.confirms[0]!.stack, true, 'stacked over the open dialog');
        assert.deepEqual(r.h.native.confirms, [], 'never the browser confirm');
        await r.dismiss();
        assert.equal(r.App.currentPage, 'overview');
        assert.deepEqual(r.h.replaced, ['#/overview']);
        assert.deepEqual(r.pages['inbox']!.log, []);
    });

    it('leaves a dirty dialog behind when the person agrees, and closes it', async () => {
        const r = rig();
        r.h.location.hash = '#/overview';
        await r.App.navigate('overview');
        r.h.UI.isModalDirty = () => true;
        let closed = 0;
        r.h.UI.closeModal = (): void => { closed += 1; };
        await r.hashchange('#/inbox');
        assert.equal(r.confirms[0]!.stack, true);
        await r.accept();
        assert.equal(r.App.currentPage, 'inbox');
        assert.ok(closed >= 1, 'navigate closes the modal');
        assert.deepEqual(r.h.replaced, []);
    });

    it('uses UI.confirm for either case once there is one, and the browser only when there is nothing else', async () => {
        const asked: Json[] = [];
        const r = rig();
        r.h.location.hash = '#/overview';
        await r.App.navigate('overview');
        r.h.UI.isModalDirty = () => true;
        r.h.UI.confirm = (o: Json): void => { asked.push(o); };
        await r.hashchange('#/inbox');
        assert.equal(asked.length, 1, 'the shared confirm, even over a dirty dialog');
        assert.equal(r.confirms.length, 0, 'not the admin one');
        assert.deepEqual(r.h.native.confirms, []);

        const bare = rig({ globals: { Admin: undefined } });
        bare.h.UI.confirm = undefined as unknown as (o: Json) => void;
        bare.h.location.hash = '#/posts';
        bare.pages['posts'] = fakePage({ canLeave: () => false });
        await bare.App.navigate('posts');
        bare.h.native.answer = false;
        await bare.hashchange('#/inbox');
        assert.equal(bare.h.native.confirms.length, 1, 'no dialog available: the browser asks');
        assert.equal(bare.App.currentPage, 'posts');
    });

    it('stays when there is nothing at all to ask with: no edit is lost for want of a dialog', async () => {
        const r = rig({ globals: { Admin: undefined, confirm: undefined } });
        r.h.UI.confirm = undefined as unknown as (o: Json) => void;
        r.h.location.hash = '#/posts';
        r.pages['posts'] = fakePage({ canLeave: () => false });
        await r.App.navigate('posts');
        await r.hashchange('#/inbox');
        assert.equal(r.App.currentPage, 'posts');
    });

    it('drops a question that a newer navigation overtook, and does not touch the address it no longer owns', async () => {
        const r = await onDirtyPosts();
        r.pages['settings'] = fakePage();
        await r.hashchange('#/inbox'); // question 1 open
        await r.hashchange('#/settings'); // question 2 replaces it (showModal runs the first one's close hook)
        assert.equal(r.confirms.length, 2);
        assert.deepEqual(r.h.replaced, [], 'the overtaken question did not restore anything');
        await r.accept(1);
        assert.equal(r.App.currentPage, 'settings');
        assert.deepEqual(r.pages['inbox']!.log, [], 'the page the person no longer wants was never drawn');
        assert.equal(r.dirty.log.filter((x: string) => x === 'discard').length, 1, 'discarded once');
    });

    it('asks nothing when no page is current (just signed in, signed out or switched tenant): only a page on screen has unsaved work', async () => {
        const r = rig();
        r.pages['posts'] = fakePage({ canLeave: () => false });
        // No page is current (just signed in, signed out, or switched tenant): nothing to guard.
        r.App.currentPage = null;
        await r.App.navigate('inbox');
        assert.equal(r.confirms.length, 0);
    });

    it('treats a page with canLeave() === false as dirty in unsavedKind(), a dirty dialog first', async () => {
        const r = rig();
        r.pages['posts'] = fakePage({ canLeave: () => false });
        await r.App.navigate('posts');
        assert.equal(r.App.unsavedKind(), 'page');
        r.h.UI.isModalDirty = () => true;
        assert.equal(r.App.unsavedKind(), 'modal');
        r.h.UI.isModalDirty = () => false;
        r.pages['posts'].canLeave = () => true;
        assert.equal(r.App.unsavedKind(), '');
    });
});

describe('router: one shared beforeunload (SH-18)', () => {
    const event = (): Json => { const e: Json = { prevented: 0, returnValue: undefined, preventDefault() { e.prevented += 1; } }; return e; };

    it('asks the browser to confirm a reload, a closed tab or the language switch while the page holds unsaved work', async () => {
        const r = rig();
        r.App.bindShellGuards();
        r.pages['posts'] = fakePage({ canLeave: () => false });
        await r.App.navigate('posts');
        const e = event();
        r.h.fire('window', 'beforeunload', e);
        assert.equal(e.prevented, 1);
        assert.equal(e.returnValue, '');
    });

    it('stays out of the way when nothing is unsaved', async () => {
        const r = rig();
        r.App.bindShellGuards();
        await r.App.navigate('inbox');
        const e = event();
        r.h.fire('window', 'beforeunload', e);
        assert.equal(e.prevented, 0);
        assert.equal(e.returnValue, undefined);
    });

    it('asks for a dirty dialog on any page, on the login screen included', async () => {
        const r = rig();
        r.App.bindShellGuards();
        r.h.UI.isModalDirty = () => true;
        const e = event();
        r.h.fire('window', 'beforeunload', e);
        assert.equal(e.prevented, 1);
    });

    it('is bound once, by the shell: no page module binds a beforeunload of its own any more', () => {
        const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const files = readdirSync('dashboard/js/pages').filter((f) => f.endsWith('.js')).map((f) => `dashboard/js/pages/${f}`);
        for (const file of files) assert.equal(/beforeunload/.test(strip(readFileSync(file, 'utf8'))), false, `${file} binds its own beforeunload`);
        assert.equal((strip(readFileSync('dashboard/js/app.js', 'utf8')).match(/addEventListener\('beforeunload'/g) ?? []).length, 1);
    });
});

describe('pages that hold unsaved work say so with canLeave() (and drop their copy on discardChanges())', () => {
    it('Posts: the composer open with typed-in fields or an upload still going, and nothing else', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/posts.js'] });
        const Posts = h.run('PostsPage');
        assert.equal(Posts.canLeave(), true, 'no composer on screen');
        h.el('post-schedule-form');
        h.el('modal-overlay');
        h.UI.isModalDirty = () => false;
        Posts._uploadsInFlight = 0;
        assert.equal(Posts.canLeave(), true, 'composer open and untouched');
        h.UI.isModalDirty = () => true;
        assert.equal(Posts.canLeave(), false, 'typed-in fields');
        h.UI.isModalDirty = () => false;
        Posts._uploadsInFlight = 1;
        assert.equal(Posts.canLeave(), false, 'an upload in flight: a closed tab or another page would drop it');
        h.el('modal-overlay').classList.add('hidden');
        assert.equal(Posts.canLeave(), true, 'a stale count from a closed composer holds nothing');
    });

    it('AI Settings: the page\'s own idea of unsaved, and a discard that really discards the parked draft', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/ai_settings.js'] });
        const Ai = h.run('AiSettingsPage');
        h.el('system-prompt-text', { value: 'prompt' });
        h.el('knowledge-base-text', { value: 'facts' });
        Ai._saved = { system_prompt: 'prompt', knowledge_base: 'facts', settings: null };
        assert.equal(Ai.canLeave(), true, 'untouched');
        h.el('knowledge-base-text').value = 'facts, edited';
        assert.equal(Ai.canLeave(), false, 'an edited text');

        // A logout or a tenant switch never asks, so the draft is parked for the next visit: unchanged.
        Ai.destroy();
        assert.deepEqual(plain(Ai._draft), { system_prompt: 'prompt', knowledge_base: 'facts, edited' });

        // The person was asked and said discard: the draft must not come back.
        Ai._draft = null;
        Ai.discardChanges();
        Ai.destroy();
        assert.equal(Ai._draft, null);
        Ai.destroy();
        assert.deepEqual(plain(Ai._draft), { system_prompt: 'prompt', knowledge_base: 'facts, edited' }, 'and the next, unasked, leave parks again');
    });

    it('Studio: the editor\'s draft or the settings form, whichever view is on screen, and the browser copy goes on discard', () => {
        const h = loadDashboard({ files: ['dashboard/js/pages/studio.js'] });
        const Studio = h.run('StudioPage');
        assert.equal(Studio.canLeave(), true, 'no view bound');

        Studio.bindKeys('editor');
        Studio.work = { carousel: { slides: [] } };
        Studio._baseline = JSON.stringify(Studio.work);
        assert.equal(Studio.canLeave(), true);
        Studio.work = { carousel: { slides: [{ text: 'edited' }] } };
        assert.equal(Studio.canLeave(), false, 'an edited draft');

        let forgotten = 0;
        Studio.forgetEdits = (): void => { forgotten += 1; };
        Studio.discardChanges();
        assert.equal(forgotten, 1, 'the editor keeps a copy in this browser; discard means that too');

        Studio.bindKeys('settings');
        Studio.settingsWork = { a: 1 };
        Studio._settingsBaseline = JSON.stringify({ a: 1 });
        assert.equal(Studio.canLeave(), true, 'the settings form is what counts now, and it is clean (the editor\'s edits are not its business)');
        Studio.settingsWork = { a: 2 };
        assert.equal(Studio.canLeave(), false);
        Studio.discardChanges();
        assert.equal(forgotten, 1, 'the settings form keeps no copy');

        Studio.unbindKeys();
        assert.equal(Studio.canLeave(), true, 'unbound: loading, or gone');
    });
});

// ─── Aliases, route(), hashParams() ─────────────────────────────────────────────────────────

describe('router: aliases in App.pages (T030)', () => {
    /** The real routes, plus fake alias entries: no alias ships yet, so the mechanism is tested with fakes. */
    function aliased(options: Parameters<typeof rig>[0] = {}): Rig {
        const r = rig(options);
        r.App.pages.ghost = { aliasOf: 'inbox', tab: 'old' };
        r.App.pages.ghostChain = { aliasOf: 'ghost' };
        r.App.pages.plainAlias = { aliasOf: 'posts' };
        r.App.pages.loopA = { aliasOf: 'loopB' };
        r.App.pages.loopB = { aliasOf: 'loopA' };
        r.App.pages.dangling = { aliasOf: 'nowhere', tab: 'x' };
        return r;
    }

    it('resolves an alias to the page that has a module, with the tab it names', () => {
        const { App } = aliased();
        assert.deepEqual(plain(App.resolveAlias('inbox')), { page: 'inbox', tab: '' });
        assert.deepEqual(plain(App.resolveAlias('ghost')), { page: 'inbox', tab: 'old' });
        assert.deepEqual(plain(App.resolveAlias('plainAlias')), { page: 'posts', tab: '' });
        assert.deepEqual(plain(App.resolveAlias('ghostChain')), { page: 'inbox', tab: 'old' }, 'a chain is followed, keeping the tab');
    });

    it('never leads nowhere: a loop, a dangling alias and a name that is not a page are the default page', () => {
        const { App } = aliased();
        for (const name of ['loopA', 'dangling', 'nowhere', '', undefined, null, 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            assert.deepEqual(plain(App.resolveAlias(name)), { page: App.DEFAULT_PAGE, tab: '' }, String(name));
        }
    });

    it('answers pageFromHash with the target page, and an address that is not a page with the default', () => {
        const { h, App } = aliased();
        for (const hash of ['#/ghost', '#/ghost?x=1', '#/ghost/sub#frag', '#ghost']) {
            h.location.hash = hash;
            assert.equal(App.pageFromHash(), 'inbox', hash);
        }
        h.location.hash = '#/ghostly';
        assert.equal(App.pageFromHash(), 'overview');
        h.location.hash = '#/constructor';
        assert.equal(App.pageFromHash(), 'overview', '#/constructor is not a page');
        h.location.hash = '#/invite';
        assert.equal(App.pageFromHash(), 'overview', 'a module that is not a route is still not one');
    });

    it('writes an alias address as the page\'s own, with its tab: query, sub-path and fragment kept, and a tab the link names wins', () => {
        const { App } = aliased();
        assert.equal(App.aliasAddress('#/ghost'), '#/inbox?tab=old');
        assert.equal(App.aliasAddress('#/ghost?x=1'), '#/inbox?tab=old&x=1');
        assert.equal(App.aliasAddress('#/ghost?x=1&tab=mine'), '#/inbox?tab=mine&x=1', 'the link\'s own tab beats the alias\'s');
        assert.equal(App.aliasAddress('#/ghost/sub?x=1#frag'), '#/inbox/sub?tab=old&x=1#frag');
        assert.equal(App.aliasAddress('#/ghost#frag'), '#/inbox?tab=old#frag');
        assert.equal(App.aliasAddress('#/ghostChain'), '#/inbox?tab=old');
        assert.equal(App.aliasAddress('#/plainAlias'), '#/posts', 'an alias that names no tab adds none');
        assert.equal(App.aliasAddress('#/plainAlias?filter=hot'), '#/posts?filter=hot');
        assert.equal(App.aliasAddress('#/inbox?tab=old'), null, 'an ordinary page is left alone');
        assert.equal(App.aliasAddress('#/nowhere'), null);
        assert.equal(App.aliasAddress(''), null);
        assert.equal(App.aliasAddress('#/dangling'), `#/${App.DEFAULT_PAGE}`, 'a dangling alias lands on the default page');
    });

    it('rewrites the address in place, before routing: no history entry, no hashchange', () => {
        const { h, App } = aliased();
        h.location.hash = '#/ghost?x=1';
        App.settleAliasAddress();
        assert.deepEqual(h.replaced, ['#/inbox?tab=old&x=1']);
        assert.equal(h.location.hash, '#/inbox?tab=old&x=1');
        h.replaced.length = 0;
        App.settleAliasAddress();
        assert.deepEqual(h.replaced, [], 'an address that is already the page\'s own is not rewritten');
    });

    it('opens the target page on a hashchange to an alias, which reads its tab from the settled address', async () => {
        const r = aliased();
        let tabSeen = '';
        r.pages['inbox']!.render = () => { tabSeen = r.App.hashParam('tab'); r.pages['inbox']!.log.push('render'); };
        await r.App.navigate('overview');
        await r.hashchange('#/ghost');
        assert.equal(r.App.currentPage, 'inbox');
        assert.equal(tabSeen, 'old', 'the page sees ?tab= like on any visit');
        assert.equal(r.h.location.hash, '#/inbox?tab=old');
        assert.equal(r.h.document.title, `${r.h.t('nav.inbox')} · ${r.h.t('app.name')}`, 'titled for the page it is');
    });

    it('survives sign-in: showApp settles an alias deep link once and navigates to the target', async () => {
        const API = { token: 'tok', getMe: () => Promise.resolve({ userId: 'u', role: 'user', tenantId: 't', tenants: [{ id: 't' }] }) };
        const r = aliased({ hash: '#/ghost?x=1', globals: { API } });
        r.h.el('login-screen');
        r.h.el('app');
        r.App.applyChrome = (): void => {};
        const navigated: string[] = [];
        r.App.navigate = (page: string): Promise<void> => { navigated.push(page); return Promise.resolve(); };
        await r.App.showApp();
        assert.deepEqual(navigated, ['inbox']);
        assert.deepEqual(r.h.replaced, ['#/inbox?tab=old&x=1'], 'once, and with the query kept');
    });

    it('navigate() given an alias draws its target', async () => {
        const r = aliased();
        await r.App.navigate('ghost');
        assert.equal(r.App.currentPage, 'inbox');
        assert.deepEqual(r.pages['inbox']!.log, ['render']);
        assert.equal(r.h.el('page-title').textContent, r.h.t('nav.inbox'));
    });

    it('loads the target\'s module for an alias, never a script of its own', () => {
        // `inbox` is left as the real entry here, whose module is not in the context: loading it appends a script.
        const r = aliased({ pageNames: ['overview', 'posts'] });
        void r.App.loadPageModule('ghost');
        const scripts = r.h.head.children.filter((c: FakeEl) => c.tag === 'script');
        assert.equal(scripts.length, 1);
        assert.match(scripts[0]!.src, /^\/dashboard\/js\/pages\/inbox\.js\?v=/);
        assert.equal(scripts.some((s: FakeEl) => /undefined|ghost/.test(s.src)), false);
    });

    it('go() and goWithQuery() write the target\'s address for an alias, and the old behaviour for a page', () => {
        const { h, App } = aliased();
        App.go('ghost');
        assert.equal(h.location.hash, '#/inbox?tab=old');
        App.go('overview');
        assert.equal(h.location.hash, '#/overview');
        App.goWithQuery('growth', { tab: 'seo', empty: '', none: null });
        assert.equal(h.location.hash, '#/growth?tab=seo');
        App.goWithQuery('ghost', { x: 'y z' });
        assert.equal(h.location.hash, '#/inbox?tab=old&x=y+z');
        const before = h.location.hash;
        App.go('nowhere');
        App.go('constructor');
        App.goWithQuery('__proto__', { a: 1 });
        assert.equal(h.location.hash, before, 'a name that is not a page changes nothing');
    });

    it('a navigation to the address already showing draws the page again, as before', async () => {
        const r = aliased();
        await r.App.navigate('inbox');
        r.h.location.hash = '#/inbox';
        const shown: string[] = [];
        r.App.show = (page: string): Promise<void> => { shown.push(page); return Promise.resolve(); };
        r.App.go('inbox');
        assert.deepEqual(shown, ['inbox']);
    });
});

describe('router: route() and hashParams() (T030)', () => {
    it('route() writes #/<page> and #/<page>?a=b, leaving out what is empty and encoding the rest', () => {
        const { App } = rig();
        assert.equal(App.route('inbox'), '#/inbox');
        assert.equal(App.route('inbox', {}), '#/inbox');
        assert.equal(App.route('inbox', { filter: 'hot', c: 'x y&z=1', empty: '', none: null, undef: undefined, zero: 0, off: false }), '#/inbox?filter=hot&c=x+y%26z%3D1&zero=0&off=false');
        assert.equal(App.route('inbox', { 'a b': 'c' }), '#/inbox?a+b=c', 'a name is encoded too');
        assert.equal(App.route('inbox', { x: '<script>alert(1)</script>' }), '#/inbox?x=%3Cscript%3Ealert%281%29%3C%2Fscript%3E', 'nothing a person typed lands in the address raw');
    });

    it('route() of an alias is the target\'s address on its tab, and a tab in params beats the alias\'s', () => {
        const { App } = rig();
        App.pages.ghost = { aliasOf: 'inbox', tab: 'old' };
        assert.equal(App.route('ghost'), '#/inbox?tab=old');
        assert.equal(App.route('ghost', { tab: 'new', c: '1' }), '#/inbox?tab=new&c=1');
        assert.equal(App.route('ghost', { filter: 'hot' }), '#/inbox?tab=old&filter=hot');
    });

    it('route() of something that is not a page is the default page, not a dead link', () => {
        const { App } = rig();
        for (const name of ['nowhere', '', undefined, null, 'constructor', '__proto__', 'toString']) {
            assert.equal(App.route(name), `#/${App.DEFAULT_PAGE}`, String(name));
        }
        assert.equal(App.route('nowhere', { a: 1 }), `#/${App.DEFAULT_PAGE}?a=1`);
    });

    it('hashParams() reads the current hash\'s query as a plain object, the first of a repeated name', () => {
        const { h, App } = rig();
        h.location.hash = '#/inbox?filter=hot&c=abc&filter=waiting&x=%E2%9C%93+y';
        assert.deepEqual(plain(App.hashParams()), { filter: 'hot', c: 'abc', x: '✓ y' });
        h.location.hash = '#/inbox';
        assert.deepEqual(plain(App.hashParams()), {});
        h.location.hash = '';
        assert.deepEqual(plain(App.hashParams()), {});
        h.location.hash = '#/inbox?';
        assert.deepEqual(plain(App.hashParams()), {});
        h.location.hash = '#/inbox?flag&empty=';
        assert.deepEqual(plain(App.hashParams()), { flag: '', empty: '' }, 'a bare name and an empty value are both empty text');
    });

    it('hashParams() has no prototype, so a hostile name is only a key and pollutes nothing', () => {
        const { h, App } = rig();
        h.location.hash = '#/inbox?__proto__=x&constructor=y&toString=z&polluted=1';
        const params = App.hashParams();
        assert.equal(Object.getPrototypeOf(params), null);
        assert.equal(params.constructor, 'y');
        assert.equal(params.polluted, '1');
        assert.equal(({} as Json).polluted, undefined);
        assert.equal(h.run<Json>('({})').polluted, undefined);
        assert.equal(h.run<Json>('Object.prototype.polluted'), undefined);
    });

    it('round-trips every parameter name the pages share: what route() writes, hashParams() and hashParam() read', () => {
        const { h, App } = rig();
        // The names documented at App.hashParams: tab, filter, status, since, s, post, c.
        const shared: Record<string, string> = {
            status: 'FAILED', filter: 'needs_you', s: 'meta', post: '3f9c2a40-7b1e-4c8d-9a55-0123456789ab', tab: 'reels',
            c: '0b9d5e6a-1111-4222-8333-444455556666', since: '2026-10-19T08:30:00+03:00',
        };
        for (const [name, value] of Object.entries(shared)) {
            h.location.hash = App.route('inbox', { [name]: value });
            assert.equal(App.hashParams()[name], value, name);
            assert.equal(App.hashParam(name), value, name);
        }
        h.location.hash = App.route('activity', shared);
        assert.deepEqual(plain(App.hashParams()), shared, 'all together');
        assert.equal(App.pageFromHash(), 'activity');
    });

    it('round-trips awkward values: Arabic, spaces, ampersands, equals signs, percent signs and a plus', () => {
        const { h, App } = rig();
        const awkward = { s: 'إعدادات الربط', filter: 'a&b=c', c: '100% + more', post: ' padded ', tab: '#hash' };
        h.location.hash = App.route('settings', awkward);
        assert.deepEqual(plain(App.hashParams()), awkward);
    });
});

// ─── Page stylesheets ───────────────────────────────────────────────────────────────────────

describe('router: a page\'s own stylesheet (T003)', () => {
    /** The real routes with no page module in the context, as on a first visit: `loadPageModule` has to fetch it. */
    function fresh(): Rig {
        const r = rig({ pageNames: [] });
        // rig() replaced nothing: the real entries are back to their `() => OverviewPage` thunks, whose global is not defined yet.
        return r;
    }
    const link = (r: Rig): FakeEl[] => r.h.head.children.filter((c) => c.tag === 'link');
    const scripts = (r: Rig): FakeEl[] => r.h.head.children.filter((c) => c.tag === 'script');

    it('is declared by the Overview, and every page that declares one has the file (a missing one is a 404 on that page\'s every visit)', () => {
        const { App } = fresh();
        assert.equal(App.pages.overview.css, true);
        let declared = 0;
        for (const [name, entry] of Object.entries(App.pages as Record<string, Json>)) {
            if (entry.css !== true) continue;
            declared += 1;
            assert.ok(existsSync(`dashboard/css/pages/${entry.src}.css`), `${name}: dashboard/css/pages/${entry.src}.css is missing`);
        }
        assert.ok(declared >= 1);
    });

    it('ships overview.css as a commented, empty file: nothing to cascade yet, and a header that says why', () => {
        const css = readFileSync('dashboard/css/pages/overview.css', 'utf8');
        assert.match(css, /^\/\*[\s\S]*\*\/\s*$/, 'one comment and nothing after it');
        assert.equal(/[{}]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'no rules');
    });

    it('adds the <link> once, before the module\'s <script>, with the same ?v= as every other asset', () => {
        const r = fresh();
        void r.App.loadPageModule('overview');
        void r.App.loadPageModule('overview');
        assert.equal(link(r).length, 1, 'two asks, one link');
        assert.equal(scripts(r).length, 1, 'and one script');
        const [first] = r.h.head.children;
        assert.equal(first?.tag, 'link', 'the stylesheet is requested first');
        const l = link(r)[0]!;
        const index = readFileSync('dashboard/index.html', 'utf8');
        const version = (index.match(/\?v=([\w.]+)/) || [])[1];
        assert.equal(l.href, `/dashboard/css/pages/overview.css?v=${r.App.ASSET_VERSION}`);
        assert.equal(r.App.ASSET_VERSION, version, 'the asset version the shell loads everything else at');
        assert.equal(l.rel, 'stylesheet');
        assert.equal(l.getAttribute('data-page-css'), 'overview');
        assert.equal(scripts(r)[0]!.src, `/dashboard/js/pages/overview.js?v=${r.App.ASSET_VERSION}`);
    });

    it('holds the module back until the stylesheet has arrived, so the page never paints unstyled', async () => {
        const r = fresh();
        let page: unknown = 'pending';
        void r.App.loadPageModule('overview').then((p: unknown) => { page = p; });
        r.h.ctx.OverviewPage = { render: () => {} };
        scripts(r)[0]!.onload!();
        await settle();
        assert.equal(page, 'pending', 'the script is in, the stylesheet is not');
        link(r)[0]!.onload!();
        await settle();
        assert.equal(page, r.h.ctx.OverviewPage);
    });

    it('opens the page without its stylesheet when that fails, and forgets the failure so the next visit asks again', async () => {
        const r = fresh();
        const warnings: string[] = [];
        const warn = console.warn;
        console.warn = (m: unknown): void => { warnings.push(String(m)); };
        let dead: FakeEl;
        try {
            let page: unknown = 'pending';
            void r.App.loadPageModule('overview').then((p: unknown) => { page = p; });
            r.h.ctx.OverviewPage = { render: () => {} };
            dead = link(r)[0]!;
            dead.onerror!();
            scripts(r)[0]!.onload!();
            await settle();
            assert.equal(page, r.h.ctx.OverviewPage, 'a missing page stylesheet costs styling, never the page');
        } finally { console.warn = warn; }
        assert.equal(warnings.length, 1);
        assert.equal(dead.isConnected, false, 'the dead <link> is removed');
        assert.equal(link(r).length, 0);
        assert.equal(r.App._pageCss.overview, undefined, 'and not remembered as loaded');
    });

    it('does not ask for the stylesheet again when only the script failed and is retried', async () => {
        const r = fresh();
        const first = r.App.loadPageModule('overview');
        link(r)[0]!.onload!();
        scripts(r)[0]!.onerror!();
        assert.equal(await first, null, 'the failure is reported as null, as before');
        void r.App.loadPageModule('overview');
        assert.equal(scripts(r).length, 2, 'the module is asked for again');
        assert.equal(link(r).length, 1, 'the stylesheet is not');
    });

    it('adds no <link> for a page that does not declare css: true, so it cannot 404', () => {
        const r = fresh();
        for (const name of ['inbox', 'posts', 'settings']) void r.App.loadPageModule(name);
        assert.equal(link(r).length, 0);
        assert.equal(scripts(r).length, 3);
    });

    it('loads the target\'s stylesheet for an alias, once', () => {
        const r = fresh();
        r.App.pages.today = { aliasOf: 'overview' };
        void r.App.loadPageModule('today');
        void r.App.loadPageModule('overview');
        assert.equal(link(r).length, 1);
        assert.equal(scripts(r).length, 1);
    });
});
