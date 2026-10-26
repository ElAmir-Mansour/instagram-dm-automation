/**
 * Explainers (v59, E3): the page, its Settings view, the platform admin's card and the Help article.
 *
 * The REAL `explainers.js`, `settings.js`, `app.js` and `help-content.js` in the shared `node:vm` harness, in both languages, with `API`
 * answering only what a test names. There is no layout and no real DOM, so what touches fields (the script's working copy) is driven with
 * small fake elements that answer exactly the queries the page makes; what only a browser can show (RTL, the players, the picture grid at
 * phone width) is for the live check after the merge.
 *
 *   - the page is a Studio tab: registered, preloaded, with its own stylesheet, and no sidebar item of its own;
 *   - the list shows every status in words, and the new form holds the limits: the topic, the links, the notes, and the Sound choice;
 *   - the script step: the estimate against the target and its warnings, the working copy, Approve sending the version it saved;
 *   - the voice, pictures, video and publish steps, each with what the contract gives it, and the LinkedIn kit with its U+2800 lines;
 *   - the polls: a step is repainted only when what it shows changed, and nothing typed is lost to one;
 *   - the settings view: the voices, the writer, the characters (an upload is resized to 448 px) and the music library;
 *   - the admin card: the switch, the Account ID, the token masked to its last four, the caps and the Test button;
 *   - the Arabic is Modern Standard Arabic (no dialect word in the interface or the article), and the Help article is linked from every step.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkDraft, PICTURE_WARN_SECONDS } from '../services/explainers/spec.js';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const ID = 'e1';
const UUID = '3f2b8c1e-5a6d-4e7f-8a9b-0c1d2e3f4a5b';
/** U+2800, the blank Braille pattern LinkedIn keeps. Built from its code point: a literal one would be invisible in this file. */
const BLANK = String.fromCodePoint(0x2800);
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────────────

const scene = (i: number, over: Json = {}): Json => ({
    position: i, narration: `Sentence ${i}.`, spoken: `Sentence ${i}.`, label: `L${i}`, brief: `A man at a desk, scene ${i}`, characters: ['karim'],
    continues: false, start_s: null, end_s: null, picture: null, pictures: [], draw_status: 'pending', draw_error: null, draw_note: null, ...over,
});

const picture = (n: number): Json => ({ media_id: `m${n}`, url: `/api/uploads/m${n}`, seed: n, provider: 'cloudflare', model: 'flux', prompt_hash: 'h', at: '2026-10-25T10:00:00Z' });

const explainer = (over: Json = {}): Json => ({
    id: ID, status: 'draft', title: 'Why RAG?', topic: 'Why does AI make things up? RAG', language: 'ar', length_tier: 'short', est_seconds: 70,
    sound_mode: 'sfx', music_track_id: null, subtitles: true, notes: null, source_links: [{ url: 'https://arxiv.org/abs/2005.11401' }],
    draft: {
        writer: 'claude_mac',
        captions: { meta: 'First paragraph.\n\nSecond paragraph.', youtube: { title: 'YT title', description: 'YT description' }, tiktok: 'TikTok caption' },
        first_comment: 'Sources: Lewis et al. 2020', replies: [{ q: 'Is it true?', a: 'Yes.' }],
        sources: [{ title: 'Lewis et al.', by: 'Lewis', year: '2020', url: 'https://arxiv.org/abs/2005.11401' }], est_seconds: 70, warnings: [],
    },
    draft_version: 3, audio: null, audio_stale: false, render: null, schedule: null, draw_paused_until: null, failed_step: null, error: null,
    scenes: [scene(0), scene(1), scene(2, { narration: 'Why does it happen?' })], job: null, allowance: null, updated_at: '2026-10-25T10:00:00Z', ...over,
});

const TRACK = { key: 'calm', title: 'Calm', artist: 'Ana', media_id: UUID, url: `/api/uploads/${UUID}`, license: 'CC BY 4.0', credit: 'Music: Calm by Ana', credit_required: true };
const CHARACTER = { key: 'karim', name: 'كريم', description: 'a curious young man with a round head', ref_media_id: null, ref_url: null, approved_at: null };
const CONFIG = {
    style: 'warm hand-painted gouache', characters: [CHARACTER], voices: { ar: 'ar-001-commercial-3', en: 'Sadaltager' }, voice_style: 'calm',
    pace: { ar: 2.1, en: 2.5 }, writer: 'claude_mac', writer_fallback: true, title_color: '#FFD43B',
    defaults: { sound_mode: 'sfx', subtitles: true, language: 'ar', length_tier: 'short' }, music: [TRACK],
};
const SETTINGS = { settings: { explainer: CONFIG, schedule: { timezone: 'Asia/Dubai' } } };

// ─── The world: the real files, an API that records, and the few elements the page reads ─────────────

interface World {
    h: Dashboard;
    P: Json;
    t: Dashboard['t'];
    calls: Array<{ name: string; args: Json[] }>;
    toasts: Array<{ message: string; type?: string }>;
    confirms: Json[];
    clipboard: string[];
    container: Json;
}

function world(options: { lang?: 'ar' | 'en'; hash?: string; api?: Record<string, (...args: Json[]) => unknown>; admin?: boolean; files?: string[] } = {}): World {
    const lang = options.lang ?? 'en';
    const calls: World['calls'] = [];
    const stubs: Record<string, (...args: Json[]) => unknown> = {
        getStudioSettings: async () => SETTINGS,
        getStudioStatus: async () => ({ worker: { online: true } }),
        ...options.api,
    };
    const API = new Proxy({ token: 't' } as Json, {
        get: (target, prop: string) => {
            if (prop === 'token') return 't';
            if (prop in stubs) return (...args: Json[]) => { calls.push({ name: prop, args }); return stubs[prop]!(...args); };
            return () => Promise.reject(new Error(`API.${prop} is not stubbed`));
        },
    });
    const clipboard: string[] = [];
    const h = loadDashboard({
        lang, app: true, hash: options.hash ?? '#/explainers',
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/explainers.js', ...(options.files ?? [])],
        globals: {
            API,
            navigator: { language: lang, languages: [lang], clipboard: { writeText: async (value: string) => { clipboard.push(String(value)); } } },
        },
    });
    h.App.currentPage = 'explainers';
    if (options.admin) h.App.session = { available: true, role: 'platform_admin', userId: null, email: '', tenantId: 't1', tenantRole: 'owner', tenants: [{ id: 't1' }], onboarding: null };
    const container = h.el('page-container');
    const toasts: World['toasts'] = [];
    const confirms: Json[] = [];
    h.UI.toast = (message: unknown, arg?: unknown) => { toasts.push({ message: String(message), type: typeof arg === 'string' ? arg : (arg as Json | undefined)?.type }); };
    h.UI.confirm = (o: Json) => { confirms.push(o); };
    return { h, P: h.run<Json>('ExplainersPage'), t: h.t, calls, toasts, confirms, clipboard, container };
}

/** Put an explainer on the page as the detail view holds it (without drawing anything). */
function open(w: World, over: Json = {}, step?: string): Json {
    const raw = explainer(over);
    w.P.kind = 'detail';
    w.P.id = raw.id;
    w.P.cfg = w.P.normalizeConfig(CONFIG);
    w.P.applyDetail(raw, { first: true, step });
    return w.P.detail;
}

const action = (w: World, name: string, ...args: Json[]): unknown => w.h.UI._actions.explainers[name](...args);
const called = (w: World, name: string): Json[] => w.calls.filter((c) => c.name === name);
const event = (): Json => ({ preventDefault() {} });

/** A form the page can read: named fields, and a radio group for Sound. */
function newForm(over: { topic?: string; language?: string; tier?: string; sound?: string; track?: string; subtitles?: boolean; links?: string; notes?: string } = {}): Json {
    const sound = over.sound ?? 'sfx';
    const elements: Json = {
        topic: { value: over.topic ?? 'Why does AI make things up?', focus() {} },
        language: { value: over.language ?? 'ar' },
        length_tier: { value: over.tier ?? 'short' },
        links: { value: over.links ?? '' },
        notes: { value: over.notes ?? '' },
        subtitles: { checked: over.subtitles ?? true },
        music_track_id: { value: over.track ?? '' },
    };
    return { elements, querySelector: (sel: string) => (sel === 'input[name="sound_mode"]:checked' ? { value: sound } : null) };
}

// ─── The page is a Studio tab ───────────────────────────────────────────────────────────────────────

describe('Explainers: a tab of the Studio, with its own stylesheet', () => {
    it('is registered under Studio with a stylesheet that exists, preloaded by its hash, and has no sidebar item of its own', () => {
        const { h } = world({ hash: '#/explainers?id=e1' });
        const entry = h.App.pages.explainers;
        assert.equal(entry.src, 'explainers');
        assert.equal(entry.navAs, 'studio');
        assert.equal(entry.css, true);
        assert.ok(existsSync('dashboard/css/pages/explainers.css'));
        assert.equal(h.App.pageFromHash(), 'explainers');
        const index = readFileSync('dashboard/index.html', 'utf8');
        assert.match(index, /var PAGES = \[[^\]]*'explainers'/);
        assert.equal(index.includes('data-page="explainers"'), false, 'Studio is the one entry');
    });

    it('the tab bar lists the Studio, the Monteur, Infographics, Explainers and the settings, and marks Explainers', () => {
        const { P } = world();
        const bar = String(P.toolbarMarkup('videos'));
        const hrefs = [...bar.matchAll(/<a class="btn btn-sm btn-ghost" href="([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(hrefs, ['#/studio', '#/monteur', '#/infographics', '#/explainers', '#/studio?tab=settings']);
        assert.match(bar, /href="#\/explainers"\s+aria-current="page"/);
        assert.match(bar, /href="#\/explainers\?tab=settings"/, 'and its own two views');
    });

    it('answers a viewer with a calm message and asks nothing of the server', async () => {
        const w = world();
        w.h.App.canOperate = () => false;
        await w.P.render();
        assert.match(String(w.container.innerHTML), new RegExp(w.t('explainers.viewer.title')));
        assert.equal(w.calls.length, 0);
    });

    it('says a switch that is off in the server’s words, and sends the platform admin to the card', async () => {
        // 404 `EXPLAINERS_DISABLED`: the sentence and its next step are E2b's (`errors.EXPLAINERS_DISABLED`), not this page's own copy.
        const off = Object.assign(new Error('off'), { status: 404, code: 'EXPLAINERS_DISABLED' });
        const member = world({ api: { getExplainers: async () => { throw off; } } });
        await member.P.render();
        const memberPage = text(member.container.innerHTML);
        assert.ok(memberPage.includes(member.t('errors.EXPLAINERS_DISABLED')), 'the server’s sentence');
        assert.ok(memberPage.includes(member.t('errors.EXPLAINERS_DISABLED.next')), 'and its next step: ask the platform admin');
        assert.equal(String(member.container.innerHTML).includes('card=explainers'), false, 'a member is not sent to a card they cannot open');
        const admin = world({ admin: true, api: { getExplainers: async () => { throw off; } } });
        await admin.P.render();
        assert.match(String(admin.container.innerHTML), /#\/settings\?s=platform&amp;card=explainers/);
        assert.ok(text(admin.container.innerHTML).includes(admin.t('explainers.disabled.bodyAdmin')), 'the admin is told where the switch is');
        // A 404 that names no code is not the switch: the routes exist now, so it is an error like any other, with Retry.
        const other = world({ api: { getExplainers: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); } } });
        await other.P.render();
        assert.equal(text(other.container.innerHTML).includes(other.t('errors.EXPLAINERS_DISABLED')), false);
        assert.match(String(other.container.innerHTML), /class="inline-error"/);
    });
});

// ─── The list: every status, in words ───────────────────────────────────────────────────────────────

describe('Explainers: the list', () => {
    const STATUSES = ['writing', 'draft', 'voicing', 'drawing', 'review', 'rendering', 'ready', 'scheduled', 'failed'];

    for (const lang of ['en', 'ar'] as const) {
        it(`shows each of the nine statuses in ${lang} with its own word, and what an open one is doing`, () => {
            const { P, t } = world({ lang });
            for (const status of STATUSES) {
                const item = { id: `i-${status}`, status, title: `Title ${status}`, topic: 'topic', language: 'ar', length_tier: 'medium', est_seconds: 200, updated_at: '2026-10-25T10:00:00Z' };
                const card = String(P.cardMarkup(item));
                assert.ok(card.includes(`>${t(`explainers.status.${status}`)}<`), `${lang}: ${status}`);
                assert.ok(card.includes(`href="#/explainers?id=i-${status}"`), 'opens the explainer');
                assert.equal(card.includes('class="ex-progress"'), ['writing', 'voicing', 'drawing', 'rendering'].includes(status), `${status}: progress only while a step runs`);
            }
            const words = new Set(STATUSES.map((s) => t(`explainers.status.${s}`)));
            assert.equal(words.size, 9, 'nine different words');
        });
    }

    it('a running step says what it is doing: its own progress line, the Mac offline, or the allowance', () => {
        const { P, t } = world();
        assert.equal(P.progressText({ status: 'writing', job: { status: 'running', progress: 'researching 3 sources' } }), 'researching 3 sources');
        assert.equal(P.progressText({ status: 'voicing', job: null }), t('explainers.progress.voicing'));
        assert.equal(P.progressText({ status: 'drawing', draw_paused_until: '2026-10-26T00:05:00Z', job: { status: 'pending' } }), t('explainers.progress.waiting'), 'a pending job is waiting for the Mac');
        assert.equal(P.progressText({ status: 'drawing', draw_paused_until: '2026-10-26T00:05:00Z', job: null }), t('explainers.progress.paused'));
        P.worker = { online: false };
        assert.equal(P.progressText({ status: 'writing', job: { status: 'pending' } }), t('explainers.progress.waitingOffline'));
        assert.equal(P.progressLabel({ done: 3, total: 20 }), t('explainers.progress.drawn', { n: '3', m: '20' }));
    });

    it('a failed card says where to read why (the list carries no reason), and a stored failure is a sentence with a technical error behind Details', () => {
        const { P, t } = world();
        // The server's list row is `{ id, status, title, topic, language, length_tier, est_seconds, progress, updated_at, thumb_url }`: no `error`, no `failed_step`.
        const card = String(P.cardMarkup({ id: 'f', status: 'failed', title: 'x', topic: 'x', language: 'ar', length_tier: 'short', est_seconds: null, progress: null, updated_at: '2026-10-25T10:00:00Z', thumb_url: null }));
        assert.ok(text(card).includes(t('explainers.list.failedHint')), 'it says it stopped and where to see why');
        assert.equal(card.includes('error-sentence'), false, 'and invents no reason');
        // In the detail, the reason is stored on the explainer, and is shown as a sentence.
        const raw = 'storage answered HTTP 503: {"error":{"code":503}}';
        const html = String(P.failureHtml(raw));
        assert.match(html, /class="error-sentence"[^>]*>[^<]*this step/i, 'the generic sentence');
        assert.equal(/<strong class="error-sentence"[^>]*>[^<]*HTTP/.test(html), false);
        assert.ok(html.includes('error-details'));
        // The voice waiting for Gemini's allowance is recognised by its prefix, and said in the server's own sentence (`errors.EXPLAINER_VOICE_LIMIT`).
        const limit = text(P.failureHtml('VOICE_LIMIT: voice limit reached, trying again at 2026-10-26T08:05:00.000Z.'));
        assert.ok(limit.includes(t('errors.EXPLAINER_VOICE_LIMIT')) && limit.includes(t('errors.EXPLAINER_VOICE_LIMIT.next')));
        assert.equal(String(P.failureHtml('The draft says VOICE_LIMIT: as an example')).includes(t('errors.EXPLAINER_VOICE_LIMIT')), false, 'only a note that starts with it');
        // A signed-out Claude: the server's own list of what that looks like, and nothing looser.
        const signedOut = String(P.failureHtml('Failed to authenticate. OAuth session expired'));
        assert.ok(signedOut.includes(t('explainers.failed.macSignedOut')) && signedOut.includes(t('explainers.failed.macSignedOutNext')));
        for (const sentence of ['claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed', 'Not logged in · Please run /login', 'authentication_error']) {
            assert.equal(P.isSignInFailure(sentence), true, sentence);
        }
        for (const other of ['A draft about OAuth failed to parse', 'Please sign in to the other app', 'HTTP 401 from the page it read', 'rate limit reached']) {
            assert.equal(P.isSignInFailure(other), false, other);
            assert.equal(String(P.failureHtml(other)).includes(t('explainers.failed.macSignedOut')), false, `${other}: not said to be a signed-out Mac`);
        }
    });

    it('paints the new form and the list from the server, and says when there is nothing yet', async () => {
        const w = world({ api: { getExplainers: async () => ({ items: [{ id: 'a1', status: 'draft', title: 'One', topic: 'one', language: 'ar', length_tier: 'short', est_seconds: 75, thumb_url: '/api/uploads/m1' }] }) } });
        await w.P.render();
        const html = String(w.container.innerHTML);
        assert.match(html, /id="ex-new-form"/);
        assert.match(html, /class="surface ex-card"/);
        assert.match(html, /src="\/api\/uploads\/m1"/, 'the first scene’s picture is the thumbnail');
        assert.match(html, /href="#\/help\/explainers#start"/);
        const empty = world({ api: { getExplainers: async () => ({ items: [] }) } });
        await empty.P.render();
        assert.match(String(empty.container.innerHTML), new RegExp(empty.t('explainers.empty.title')));
    });
});

// ─── The new form: the limits, and the Sound choice ─────────────────────────────────────────────────

describe('Explainers: the five steps', () => {
    it('names every step on the link itself, because a phone hides all but one label', () => {
        for (const lang of ['en', 'ar'] as const) {
            const w = world({ lang });
            open(w, { status: 'ready' });
            const markup = String(w.P.stepsMarkup());
            const names = ['script', 'voice', 'pictures', 'video', 'publish'].map((k) => w.t(`explainers.step.${k}`));
            for (const name of names) {
                assert.match(markup, new RegExp(`<(a|span) class="ex-step-link[^"]*"[^>]*aria-label="${name}"`), `${lang}: ${name} has an accessible name`);
            }
            assert.equal((markup.match(/aria-label="/g) ?? []).length, 5, 'one name per step, and nothing else named twice');
        }
    });

    it('a step with nothing to show yet is a disabled link, not a link that goes nowhere', () => {
        const w = world();
        open(w, { status: 'draft' });
        const markup = String(w.P.stepsMarkup());
        assert.match(markup, /<span class="ex-step-link is-off" role="link" aria-disabled="true" aria-label="Voice"/);
        assert.equal((markup.match(/data-action="explainers:goStep"/g) ?? []).length, 2, 'only the script and the publish step (the captions are there from the first draft) are links');
        assert.match(markup, /aria-current="step"/, 'the open step is marked');
    });
});

describe('Explainers: the new-explainer form', () => {
    it('holds the limits in its fields: 3 to 300 characters, three lengths, notes to 2,000, links as lines', () => {
        const { P, t } = world();
        P.cfg = P.normalizeConfig(CONFIG);
        const form = String(P.newFormMarkup());
        assert.match(form, /<textarea[^>]*name="topic"[^>]*maxlength="300"/);
        assert.match(form, /<textarea[^>]*name="notes"[^>]*maxlength="2000"/);
        assert.match(form, /<select[^>]*name="language"[\s\S]*?value="ar"[\s\S]*?value="en"/);
        const tiers = /<select[^>]*name="length_tier">([\s\S]*?)<\/select>/.exec(form)![1]!;
        assert.deepEqual([...tiers.matchAll(/value="([^"]+)"/g)].map((m) => m[1]), ['short', 'medium', 'long']);
        for (const tier of ['short', 'medium', 'long']) assert.ok(tiers.includes(`>${t(`explainers.tier.${tier}`)}<`));
        assert.match(form, /<textarea[^>]*name="links"/);
        assert.match(form, /type="checkbox" name="subtitles" checked/, 'subtitles are on by default');
        assert.match(form, /select[^>]*name="language">\s*<option value="ar" selected/, 'Arabic by default');
        assert.equal(P.TOPIC_MIN, 3);
        assert.equal(P.LINKS_MAX, 10);
    });

    it('Sound is a choice: sound effects only, or music (which shows the track picker from the library)', () => {
        const { P, t } = world();
        P.cfg = P.normalizeConfig(CONFIG);
        const sfx = String(P.soundFieldsMarkup('x', { sound_mode: 'sfx', music_track_id: '', subtitles: true }));
        assert.match(sfx, /name="sound_mode" value="sfx"[^>]*checked/);
        assert.doesNotMatch(sfx, /name="sound_mode" value="music"[^>]*checked/);
        assert.match(sfx, /data-ex-tracks hidden/, 'the picker is hidden until music is chosen');
        assert.ok(sfx.includes(t('explainers.sound.sfx')) && sfx.includes(t('explainers.sound.music')));
        const music = String(P.soundFieldsMarkup('x', { sound_mode: 'music', music_track_id: 'calm', subtitles: true }));
        assert.match(music, /name="sound_mode" value="music"[^>]*checked/);
        assert.doesNotMatch(music, /data-ex-tracks hidden/);
        assert.match(music, /<option value="calm" selected>Calm — Ana \(credit required\)<\/option>/);
        P.cfg = P.normalizeConfig({ ...CONFIG, music: [] });
        const none = String(P.soundFieldsMarkup('x', { sound_mode: 'music', music_track_id: '', subtitles: true }));
        assert.ok(none.includes(t('explainers.sound.noTracks')) && none.includes('href="#/explainers?tab=settings"'));
        assert.doesNotMatch(none, /<select/);
    });

    it('choosing music shows the picker and choosing sound effects hides it', () => {
        const { P } = world();
        const wrap = { hidden: true };
        let checked: Json = { value: 'music' };
        const form = { querySelector: (sel: string) => (sel === 'input[name="sound_mode"]:checked' ? checked : sel === '[data-ex-tracks]' ? wrap : null) };
        P.syncSoundFields(form);
        assert.equal(wrap.hidden, false);
        checked = { value: 'sfx' };
        P.syncSoundFields(form);
        assert.equal(wrap.hidden, true);
    });

    it('refuses a topic outside 3 to 300 characters before asking the server', async () => {
        const w = world();
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        w.h.el('ex-new-error');
        for (const topic of ['', 'ab', '  a ', 'x'.repeat(301)]) {
            await action(w, 'create', newForm({ topic }), event());
        }
        assert.equal(called(w, 'createExplainer').length, 0);
        assert.match(String(w.h.dom.get('ex-new-error')!.innerHTML), /3 to 300/);
    });

    it('sends a valid one with exactly what was chosen, and goes to the new explainer', async () => {
        const w = world({ api: { createExplainer: async () => ({ id: 'new1', status: 'writing' }) } });
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        w.h.el('ex-new-error');
        w.P.go = (params: Json) => { w.calls.push({ name: 'go', args: [params] }); };
        await action(w, 'create', newForm({ topic: '  Why RAG?  ', language: 'en', tier: 'medium', subtitles: false, notes: ' point to the paper ', links: 'https://a.example/x\nhttps://a.example/x\n https://b.example/y ' }), event());
        assert.deepEqual(plain(called(w, 'createExplainer')[0]!.args[0]), {
            topic: 'Why RAG?', language: 'en', length_tier: 'medium', sound_mode: 'sfx', subtitles: false, notes: 'point to the paper',
            source_links: ['https://a.example/x', 'https://b.example/y'],
        });
        assert.deepEqual(plain(called(w, 'go')[0]!.args[0]), { id: 'new1' });
    });

    it('music needs a track from the library: refused without one, and sent with its key when chosen; sound effects send none', async () => {
        const w = world({ api: { createExplainer: async () => ({ id: 'n' }) } });
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        w.P.go = () => {};
        w.h.el('ex-new-error');
        await action(w, 'create', newForm({ sound: 'music', track: '' }), event());
        assert.equal(called(w, 'createExplainer').length, 0);
        assert.match(String(w.h.dom.get('ex-new-error')!.innerHTML), /Choose a track/);
        await action(w, 'create', newForm({ sound: 'music', track: 'calm' }), event());
        assert.equal(called(w, 'createExplainer')[0]!.args[0].music_track_id, 'calm');
        assert.equal(called(w, 'createExplainer')[0]!.args[0].sound_mode, 'music');
        await action(w, 'create', newForm({ sound: 'sfx', track: 'calm' }), event());
        const sfx = called(w, 'createExplainer')[1]!.args[0];
        assert.equal(sfx.sound_mode, 'sfx');
        assert.equal('music_track_id' in sfx, false);
    });

    it('allows up to 10 source links, only http and https, and notes up to 2,000 characters', async () => {
        const w = world({ api: { createExplainer: async () => ({ id: 'n' }) } });
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        w.P.go = () => {};
        w.h.el('ex-new-error');
        const link = (n: number): string => `https://example.com/${n}`;
        await action(w, 'create', newForm({ links: Array.from({ length: 11 }, (_, n) => link(n)).join('\n') }), event());
        await action(w, 'create', newForm({ links: 'ftp://x.example/file' }), event());
        await action(w, 'create', newForm({ links: 'not a link' }), event());
        await action(w, 'create', newForm({ notes: 'n'.repeat(2001) }), event());
        assert.equal(called(w, 'createExplainer').length, 0);
        await action(w, 'create', newForm({ links: Array.from({ length: 10 }, (_, n) => link(n)).join('\n'), notes: 'n'.repeat(2000) }), event());
        assert.equal(called(w, 'createExplainer')[0]!.args[0].source_links.length, 10);
        assert.deepEqual(plain(w.P.parseLinks('https://a.example, https://b.example\nbad')), { links: ['https://a.example', 'https://b.example'], bad: ['bad'] });
    });
});

// ─── The script: the estimate, the warnings and the working copy ────────────────────────────────────

describe('Explainers: the script step', () => {
    it('counts spoken words as the server does and estimates words over pace, to a tenth of a second', () => {
        const { P } = world();
        assert.equal(P.countWords('  one two — three  ؟ '), 3, 'a dash or a lone mark is not a word');
        assert.equal(P.countWords('هل تعلم أن RAG مفيد؟'), 5);
        assert.equal(P.estimateSeconds([{ spoken: 'a b c d e f g h i j k l m n o p q r s t u' }], 'ar'), 11.7, '21 words at 1.8 a second: the Arabic pace measured on 2026-10-25');
        assert.deepEqual(plain(P.PACE), { ar: 1.8, en: 2.5 }, 'the server’s DEFAULT_EXPLAINER_PACE');
        assert.equal(P.estimateSeconds([{ spoken: 'a b c d e' }], 'en'), 2, '5 words at 2.5 a second');
        assert.equal(P.estimateSeconds([{ spoken: 'a b c d e' }], 'en', 0), 2, 'a pace that cannot be one is the default');
        assert.equal(P.estimateSeconds([], 'ar'), 0);
    });

    it('holds a script to the same ranges as the server: scenes, seconds and sources, per length', () => {
        const { P } = world();
        const scenes = (n: number, words = 7): Json[] => Array.from({ length: n }, () => ({ spoken: Array.from({ length: words }, () => 'w').join(' ') }));
        const codes = (list: Json[]): string[] => Array.from(list, (x) => String(x.code));
        const sources = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];
        // short: 10-30 scenes, 55-95 s; at 1.8 w/s a 7-word scene is 3.89 s
        assert.deepEqual(codes(P.scriptWarnings(scenes(20), sources, 'short', 'ar')), [], '20 scenes, 77.8 s');
        assert.deepEqual(codes(P.scriptWarnings(scenes(9), sources, 'short', 'ar')), ['scene_count', 'duration_short'], '9 scenes: too few, and 35 s');
        assert.deepEqual(codes(P.scriptWarnings(scenes(31), sources, 'short', 'ar')), ['scene_count', 'duration_long'], '31 scenes, 120.6 s');
        assert.deepEqual(codes(P.scriptWarnings(scenes(10), sources, 'short', 'ar')), ['duration_short'], '10 scenes is in range; 38.9 s is not');
        assert.deepEqual(plain(P.DURATION_RANGE), { short: { min: 55, max: 95 }, medium: { min: 170, max: 310 }, long: { min: 570, max: 930 } });
        assert.deepEqual(plain(P.SCENE_BOUNDS), { short: { min: 10, max: 30 }, medium: { min: 30, max: 90 }, long: { min: 120, max: 300 } });
        // sources: none is a warning for every length, and too few is a warning for short only
        assert.ok(codes(P.scriptWarnings(scenes(20), [], 'short', 'ar')).includes('needs_sources'));
        assert.deepEqual(codes(P.scriptWarnings(scenes(60, 8), [], 'medium', 'ar')), ['needs_sources']);
        assert.deepEqual(codes(P.scriptWarnings(scenes(20), [{ title: 'a' }], 'short', 'ar')), ['few_sources']);
        assert.deepEqual(codes(P.scriptWarnings(scenes(60, 8), [{ title: 'a' }], 'medium', 'ar')), [], '60 scenes of 8 words: 267 s, inside 170-310');
        assert.equal(codes(P.scriptWarnings(scenes(20), [{ title: '' }, { url: '' }], 'short', 'ar')).includes('needs_sources'), true, 'an empty source is not a source');
    });

    it('warns about how long each picture stays, as the server does: a slow first picture, then long and fast ones by scene number', () => {
        const { P } = world();
        const said = (counts: readonly number[], kept: readonly number[] = []): Json[] =>
            counts.map((n, i) => ({ spoken: Array.from({ length: n }, () => 'w').join(' '), continues: kept.includes(i) }));
        const codes = (list: Json[]): string[] => Array.from(list, (x) => String(x.code));
        assert.deepEqual(plain(P.PICTURE_WARN), PICTURE_WARN_SECONDS, 'the server’s PICTURE_WARN_SECONDS');
        // At 1.8 words a second: 7 words is 3.9 s, 9 is 5 s, 13 is 7.2 s and 3 is 1.7 s.
        assert.deepEqual(plain(P.pacingWarnings(said([7, 9, 9, 9]), 'ar')), []);
        assert.deepEqual(plain(P.pacingWarnings(said([9, 9, 13, 9, 3, 13]), 'ar')), [
            { code: 'slow_opening', secs: 5 }, { code: 'scene_long', scenes: [3, 6] }, { code: 'scene_short', scenes: [5] },
        ]);
        assert.deepEqual(plain(P.pacingWarnings(said([7, 7, 7, 9], [2]), 'ar')), [{ code: 'scene_long', scenes: [2] }], 'a kept picture is one picture: 3.9 + 3.9 s');
        assert.deepEqual(plain(P.pacingWarnings(said([7, 0, 9]), 'ar')), [], 'no spoken words is a problem of its own, not a fast picture');
        assert.deepEqual(plain(P.pacingWarnings(said([16, 16, 2]), 'ar', 4)), [{ code: 'scene_short', scenes: [3] }], 'the settings’ pace: at 4 words a second that is 4, 4 and 0.5 s');
        // The same codes as checkDraft on the server, for the same scenes at the same pace.
        assert.deepEqual(plain(P.pacingWarnings(said([16, 5, 5]), 'ar', 1)), [{ code: 'slow_opening', secs: 16 }], 'a long first picture is a slow opening only');
        for (const sample of [[9, 9, 13, 9, 3, 13], [7, 9, 9, 9], [16, 16, 2], [4, 12, 1], [16, 5, 5]]) {
            for (const pace of [undefined, 1, 2.5]) {
                const scenes = said(sample).map((s) => ({ narration: 'x', label: '', brief: 'b', characters: [], spoken: String(s.spoken), continues: s.continues === true }));
                const server = checkDraft({ scenes }, { tier: 'short', language: 'ar', ...(pace === undefined ? {} : { pace }) })
                    .warnings.filter((w) => ['slow_opening', 'scene_long', 'scene_short'].includes(w.code)).map((w) => w.code);
                assert.deepEqual(codes(P.pacingWarnings(said(sample), 'ar', pace)), server, `${sample.join(',')} at ${pace ?? 'the default pace'}`);
            }
        }
        // In the script's list, between the length and the sources, as the server orders them.
        const sources = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];
        assert.deepEqual(codes(P.scriptWarnings(said([9, ...Array.from({ length: 19 }, () => 7)]), sources, 'short', 'ar')), ['slow_opening'], '20 scenes, 78.9 s');
        assert.deepEqual(codes(P.scriptWarnings(said([13, 13, 13]), [], 'short', 'ar')), ['scene_count', 'duration_short', 'slow_opening', 'scene_long', 'needs_sources']);
        // A warning the server stored gets its numbers from the script as it stands, like the others.
        const stored = P.savedWarnings({ draft: { warnings: [{ code: 'scene_long', message: 'm' }, { code: 'slow_opening', message: 'm' }], sources: [] }, scenes: said([9, 16, 7]), length_tier: 'short', language: 'ar' }, 30);
        assert.deepEqual(Array.from(stored, (w: Json) => [w.code, plain(w.scenes ?? null), w.secs ?? null]), [['scene_long', [2], null], ['slow_opening', null, 5]]);
        // Said with the scene numbers, in the interface's language.
        assert.match(P.warningText({ code: 'scene_long', scenes: [3, 6] }), /Scenes to split, where one picture stays more than 7 seconds: 3, 6\./);
        assert.match(P.warningText({ code: 'scene_short', scenes: [5] }), /under 2 seconds: 5\./);
        assert.match(P.warningText({ code: 'slow_opening', secs: 5.6 }), /The first picture stays about ⁦0:06⁩\./);
        assert.match(world({ lang: 'ar' }).P.warningText({ code: 'scene_long', scenes: [3, 6] }), /تبقى أكثر من 7 ثوانٍ: 3، 6\./);
    });

    it('a closing question ends in ? or ؟, with closing quotes and brackets allowed', () => {
        const { P } = world();
        for (const ok of ['Why?', 'لماذا؟', 'Why? ”', 'هل؟»', 'Is it (really)?)']) assert.equal(P.endsWithQuestion(ok), true, ok);
        for (const no of ['Comment YES.', '', 'Why', 'Why?!']) assert.equal(P.endsWithQuestion(no), false, no);
    });

    it('draws the editor from the draft: every field with its limit, the characters of the settings, the writer, and Approve for a draft', () => {
        const w = world({ lang: 'en' });
        open(w);
        const markup = String(w.P.scriptMarkup());
        assert.match(markup, /id="ex-editor"[^>]*data-submit="explainers:saveScript"/);
        assert.match(markup, /data-field="title" maxlength="70"/);
        assert.equal((markup.match(/data-scene-row="/g) ?? []).length, 3);
        assert.match(markup, /data-field="narration" rows="2" maxlength="300"/);
        assert.match(markup, /data-field="spoken" rows="2" maxlength="400"/);
        assert.match(markup, /data-field="label" maxlength="40"/);
        assert.match(markup, /data-field="brief" rows="2" maxlength="500" dir="ltr"/);
        assert.match(markup, /data-char="karim" data-change="explainers:characterChanged" checked/, 'the scene names its character');
        assert.match(markup, /data-field="continues"/);
        for (const field of ['caption-meta', 'caption-yt-title', 'caption-yt-description', 'caption-tiktok', 'first-comment']) assert.ok(markup.includes(`data-field="${field}"`), field);
        assert.ok(markup.includes('Written by Claude on your Mac'));
        assert.match(markup, /data-action="explainers:approve"/);
        assert.match(markup, /data-action="explainers:openRewrite"/);
        assert.match(markup, /href="#\/help\/explainers#script"/, 'every step links to its section of the article');
        for (const control of ['sceneUp', 'sceneDown', 'sceneAdd', 'sceneRemove']) assert.ok(markup.includes(`data-action="explainers:${control}"`), control);
    });

    it('shows the server’s answer about the saved script: its estimate, its stored warnings by code, and what Approve will refuse', () => {
        const w = world({ lang: 'en' });
        open(w, {
            language: 'en', length_tier: 'short',
            draft: { ...explainer().draft, est_seconds: 70, warnings: [
                { code: 'scene_count', message: 'This script has 3 scenes; a 60-90 second explainer usually has 10-30.' },
                { code: 'few_sources', message: 'Only 1 source is listed; a 60-90 second explainer should cite at least 3.' },
                { code: 'research_limited', message: 'The writer did not read any web page for this script: it was written from memory.' },
                { code: 'a_new_code', message: 'A warning this page has no sentence for.' },
            ] },
            problems: [
                { code: 'field_too_long', scene: 2, field: 'spoken', message: 'Scene 3: the spoken is 450 characters; the limit is 400.' },
                { code: 'closing_question', scene: 2, field: 'narration', message: 'The last scene must ask the viewer a genuine question, ending in ? or ؟.' },
                { code: 'field_empty', field: 'title', message: 'The title is empty.' },
            ],
        });
        w.P.ensureWork();
        const est = text(w.P.estimateMarkup(w.P.work.scenes, w.P.work.sources));
        assert.match(est, /About .*1:10.* spoken; the target is .*0:55.*1:35.*Scenes: 3\./, 'the stored estimate, 70 s');
        assert.match(est, /Scenes in this script: 3\. For 60–90 seconds it is usually 10 to 30/);
        assert.match(est, /Sources listed: 1\. A short explainer should cite at least 3/, 'a count is never put in front of a noun, so one source reads correctly');
        assert.match(est, /did not read any web page for this script, so its facts and sources are unchecked/, 'the flag the writer’s answer carries is shown');
        assert.ok(est.includes('A warning this page has no sentence for.'), 'a code it does not know is shown as the server worded it');
        assert.ok(est.includes('To fix before approving'));
        assert.ok(est.includes('Scene 3: Longer than 400 characters: Spoken text.'), 'a finding by its code, its 0-based scene shown as 3, its field by the editor’s label');
        assert.ok(est.includes('Scene 3: The last scene must ask the viewer a genuine question.'));
        assert.ok(est.includes('Empty field: Video title.'), 'a finding with no scene has no scene prefix');
        assert.equal(est.includes('Save to check'), false, 'nothing is unsaved');
        // Only a draft is waiting for approval: once voiced, the script was clean, and the list of what to fix is not shown.
        const voiced = world({ lang: 'en' });
        open(voiced, { status: 'drawing', problems: [{ code: 'field_empty', field: 'title', message: 'The title is empty.' }] });
        voiced.P.ensureWork();
        assert.equal(text(voiced.P.estimateMarkup(voiced.P.work.scenes, voiced.P.work.sources)).includes('To fix before approving'), false);
    });

    it('while the fields hold unsaved edits, the estimate and the warnings follow what is typed, and the page says the server has not checked it yet', () => {
        const w = world({ lang: 'en' });
        open(w, {
            language: 'en', length_tier: 'short',
            draft: { ...explainer().draft, est_seconds: 70, warnings: [{ code: 'research_limited', message: 'The writer did not read any web page for this script.' }] },
            problems: [{ code: 'closing_question', scene: 2, field: 'narration', message: 'x' }],
        });
        w.P.ensureWork();
        w.P.work.scenes[2].narration = 'Comment YES.';
        w.P.work.scenes[0].spoken = 'one two three four five six seven eight nine ten';
        assert.equal(w.P.editorDirty(), true);
        const est = text(w.P.estimateMarkup(w.P.work.scenes, w.P.work.sources));
        assert.equal(est.includes('1:10'), false, 'not the stored estimate: the fields were edited');
        assert.match(est, /shorter than the 60–90 seconds you chose/, 'the mirror of the server’s warnings, from the fields');
        assert.match(est, /should end with a genuine question/, 'the closing question, as the owner types it');
        assert.match(est, /did not read any web page for this script, so its facts and sources are unchecked/, 'how it was written does not change by typing');
        assert.ok(est.includes(w.t('explainers.script.saveToCheck')));
        assert.equal(est.includes('To fix before approving'), false, 'the server’s list is about the saved script, not these fields');
    });

    it('is read-only while a step that reads the script is running: no Save, no Approve, fields locked', () => {
        for (const status of ['voicing', 'rendering', 'writing']) {
            const w = world();
            open(w, { status });
            const markup = String(w.P.scriptMarkup());
            assert.equal(markup.includes('data-action="explainers:approve"'), false, status);
            assert.equal(markup.includes('id="ex-save"'), false, status);
            assert.match(markup, /data-field="narration"[^>]*readonly/, status);
            assert.equal(markup.includes('data-action="explainers:sceneRemove"'), false, status);
        }
        const draft = world();
        open(draft, { status: 'drawing' });
        assert.equal(String(draft.P.scriptMarkup()).includes('id="ex-save"'), true, 'editable once voiced');
        assert.equal(String(draft.P.scriptMarkup()).includes('data-action="explainers:approve"'), false, 'Approve is the draft’s alone');
    });

    it('waits calmly when nothing is written yet: the writing panel, then the Mac when it is offline', () => {
        const w = world();
        open(w, { status: 'writing', scenes: [], draft: null, job: { status: 'pending', progress: null } });
        w.P.worker = { online: false };
        const markup = String(w.P.scriptMarkup());
        assert.ok(markup.includes(w.t('explainers.script.writingTitle')));
        assert.ok(markup.includes(w.t('explainers.progress.waitingOffline')));
        assert.equal(markup.includes('id="ex-editor"'), false);
        assert.ok(String(w.P.workerMarkup()).includes(w.t('explainers.worker.offline')), 'and says why nothing moves');
    });
});

// ─── The working copy: nothing typed is lost ────────────────────────────────────────────────────────

/** A fake editor that answers the queries `captureEditor` makes, holding the values the owner typed. */
function fakeEditor(w: World, values: Json): Json {
    const field = (value: unknown): Json => ({ value });
    const scenes = (values.scenes as Json[]).map((s) => ({
        querySelector: (sel: string) => {
            const name = /data-field="([^"]+)"/.exec(sel)?.[1];
            if (name === 'continues') return { checked: !!s.continues };
            return name && name in s ? field(s[name]) : null;
        },
        querySelectorAll: () => (s.characters as string[]).map((c) => ({ checked: true, dataset: { char: c } })),
    }));
    const form = {
        querySelector: (sel: string) => {
            const name = /data-field="([^"]+)"/.exec(sel)?.[1];
            return name && name in values.fields ? field(values.fields[name]) : null;
        },
        querySelectorAll: (sel: string) => (sel === '[data-scene-row]' ? scenes : []),
    };
    w.h.dom.set('ex-editor', form as never);
    return form;
}

describe('Explainers: the script is a working copy', () => {
    it('reads the fields into the copy, and is dirty only when it differs from what was saved', () => {
        const w = world();
        open(w);
        w.P.ensureWork();
        assert.equal(w.P.editorDirty(), false);
        assert.equal(w.P.canLeave(), true);
        fakeEditor(w, { fields: { title: 'A new title' }, scenes: w.P.work.scenes.map((s: Json) => ({ ...s })) });
        assert.equal(w.P.canLeave(), false, 'a typed title is work that leaving would lose');
        assert.equal(w.P.work.title, 'A new title');
        fakeEditor(w, { fields: { title: 'Why RAG?' }, scenes: w.P.work.scenes.map((s: Json) => ({ ...s })) });
        assert.equal(w.P.canLeave(), true, 'typed back to what it was: nothing to lose');
        fakeEditor(w, { fields: { title: 'Why RAG?' }, scenes: w.P.work.scenes.map((s: Json, i: number) => ({ ...s, narration: i === 1 ? 'Edited.' : s.narration })) });
        assert.equal(w.P.canLeave(), false);
        assert.equal(w.P.work.scenes[1].narration, 'Edited.');
        w.P.discardChanges();
        assert.equal(w.P.canLeave(), true, 'discarded: nothing is held');
    });

    it('a poll that finds the same draft never touches the working copy, and one that finds a new version keeps typed edits', () => {
        const w = world();
        open(w);
        w.P.ensureWork();
        fakeEditor(w, { fields: { title: 'Typed' }, scenes: w.P.work.scenes.map((s: Json) => ({ ...s })) });
        w.P.applyDetail(explainer({ title: 'Why RAG?' }), { poll: true });
        assert.equal(w.P.work.title, 'Typed', 'the same version: the copy is as the owner left it');
        w.P.applyDetail(explainer({ draft_version: 4 }), { poll: true });
        assert.equal(w.P.work.title, 'Typed', 'a new version: typed edits stay');
        assert.equal(w.P.work.base, 4, 'and follow it');
        w.P.discardChanges();
        w.h.dom.delete('ex-editor');
        w.P.ensureWork();
        w.P.applyDetail(explainer({ draft_version: 5, title: 'From the server' }), { poll: true });
        assert.equal(w.P.work, null, 'untouched, a new version is read again from the server');
    });

    it('changes the scene list without losing what is typed: move, add, remove', () => {
        const w = world();
        open(w);
        w.P.ensureWork();
        const host = w.h.el('ex-scenes');
        const typed = (): Json => ({ fields: { title: 'Why RAG?' }, scenes: w.P.work.scenes.map((s: Json) => ({ ...s })) });
        const rows = typed();
        rows.scenes[0].narration = 'Typed in the first scene.';
        fakeEditor(w, rows);
        action(w, 'sceneDown', { dataset: { i: '0' } });
        assert.equal(w.P.work.scenes[1].narration, 'Typed in the first scene.', 'it moved with what was typed');
        assert.equal(w.P.work.scenes.length, 3);
        action(w, 'sceneAdd', { dataset: { i: '1' } });
        assert.equal(w.P.work.scenes.length, 4);
        assert.equal(w.P.work.scenes[2].narration, '', 'a blank scene after scene 2');
        action(w, 'sceneRemove', { dataset: { i: '2' } });
        assert.equal(w.P.work.scenes.length, 3);
        assert.match(String(host.innerHTML), /data-scene-row="2"/, 'the list was repainted from the copy');
        action(w, 'sceneUp', { dataset: { i: '0' } });
        assert.equal(w.P.work.scenes.length, 3, 'the first scene cannot move up');
    });

    it('refuses a fifth character on a scene, and a script of more than 300 scenes', () => {
        const w = world();
        open(w);
        const box = { checked: true, closest: () => ({ querySelectorAll: () => [1, 2, 3, 4, 5] }) };
        action(w, 'characterChanged', box);
        assert.equal(box.checked, false);
        assert.match(w.toasts[0]!.message, /at most 4 characters/);
        w.P.ensureWork();
        w.P.work.scenes = Array.from({ length: 300 }, () => w.P.blankScene());
        fakeEditor(w, { fields: {}, scenes: w.P.work.scenes.map((s: Json) => ({ ...s })) });
        action(w, 'sceneAdd', { dataset: { i: '299' } });
        assert.equal(w.P.work.scenes.length, 300);
        assert.match(w.toasts[1]!.message, /at most 300 scenes/);
    });

    it('saves the whole script: the title, the scenes in order, the captions, the replies and the sources, trimmed and without empty rows', async () => {
        const saved = explainer({ title: 'Saved', draft_version: 4 });
        const w = world({ api: { updateExplainer: async () => saved } });
        open(w);
        w.P.ensureWork();
        w.h.el('ex-script-error');
        w.P.paintDetail = () => {};
        w.P.paintBody = () => {};
        const rows = { fields: { title: '  Saved  ', 'caption-meta': ' meta ' }, scenes: w.P.work.scenes.map((s: Json) => ({ ...s, narration: ` ${s.narration} ` })) };
        fakeEditor(w, rows);
        w.P.work.replies.push({ q: '', a: '' });
        w.P.work.sources.push({ title: '', by: '', year: '', url: '' });
        await action(w, 'saveScript', { querySelector: () => null }, event());
        const body = called(w, 'updateExplainer')[0]!.args[1];
        assert.equal(called(w, 'updateExplainer')[0]!.args[0], ID);
        assert.equal(body.title, 'Saved');
        assert.equal(body.draft.captions.meta, 'meta');
        assert.equal(body.draft.replies.length, 1, 'the empty reply is dropped');
        assert.equal(body.draft.sources.length, 1, 'the empty source is dropped');
        assert.deepEqual(plain(body.scenes.map((s: Json) => s.narration)), ['Sentence 0.', 'Sentence 1.', 'Why does it happen?']);
        assert.deepEqual(plain(Object.keys(body.scenes[0]).sort()), ['brief', 'characters', 'continues', 'label', 'narration', 'spoken']);
        assert.equal(w.P.detail.draft_version, 4, 'the answer is the explainer now');
        assert.ok(w.P.work && w.P.work.base === 4, 'and the working copy is read again from it');
        assert.equal(w.P.editorDirty(), false);
    });

    it('Approve saves what was typed first and names the version that save answered with', async () => {
        const w = world({ api: {
            updateExplainer: async () => explainer({ draft_version: 4 }),
            approveExplainer: async () => explainer({ status: 'voicing', draft_version: 4 }),
        } });
        open(w);
        w.P.ensureWork();
        w.P.afterAction = (res: Json) => { w.P.applyDetail(res); };
        const rows = { fields: { title: 'Edited before approving' }, scenes: w.P.work.scenes.map((s: Json) => ({ ...s })) };
        fakeEditor(w, rows);
        action(w, 'approve');
        assert.equal(w.confirms.length, 1, 'it asks first: this is the first gate');
        assert.equal(w.confirms[0]!.tone, 'primary');
        await w.confirms[0]!.onConfirm();
        assert.deepEqual(w.calls.map((c) => c.name), ['updateExplainer', 'approveExplainer'], 'saved, then approved');
        assert.deepEqual(plain(called(w, 'approveExplainer')[0]!.args), [ID, 4]);
        assert.equal(w.P.detail.status, 'voicing');
    });

    it('Approve with nothing edited names the version that was read, and does not save', async () => {
        const w = world({ api: { approveExplainer: async () => explainer({ status: 'voicing' }) } });
        open(w);
        w.P.ensureWork();
        w.P.afterAction = (res: Json) => { w.P.applyDetail(res); };
        action(w, 'approve');
        await w.confirms[0]!.onConfirm();
        assert.deepEqual(w.calls.map((c) => c.name), ['approveExplainer']);
        assert.deepEqual(plain(called(w, 'approveExplainer')[0]!.args), [ID, 3]);
    });

    it('does not offer Approve to anything but a draft, and a refused approval stays in the dialog (the dialog shows the error)', async () => {
        const w = world({ api: { approveExplainer: async () => { throw Object.assign(new Error('stale'), { status: 409, code: 'EXPLAINER_BAD_STATE' }); } } });
        open(w, { status: 'review' });
        action(w, 'approve');
        assert.equal(w.confirms.length, 0);
        const d = world({ api: { approveExplainer: async () => { throw Object.assign(new Error('stale'), { status: 409 }); } } });
        open(d);
        d.P.ensureWork();
        action(d, 'approve');
        await assert.rejects(() => d.confirms[0]!.onConfirm(), /stale/);
    });

    it('asks for a note before a rewrite, sends it, and drops the edits that were never saved', async () => {
        const w = world({ api: { rewriteExplainer: async () => explainer({ status: 'writing' }) } });
        open(w);
        w.P.ensureWork();
        w.P.work.title = 'unsaved';
        w.h.el('ex-rewrite-error');
        w.P.afterAction = () => {};
        const form = (note: string): Json => ({ elements: { note: { value: note } }, querySelector: () => null });
        await action(w, 'rewrite', form('   '), event());
        assert.equal(called(w, 'rewriteExplainer').length, 0);
        assert.match(String(w.h.dom.get('ex-rewrite-error')!.innerHTML), /Say what should change/);
        await action(w, 'rewrite', form(' a shorter hook '), event());
        assert.deepEqual(plain(called(w, 'rewriteExplainer')[0]!.args), [ID, { note: 'a shorter hook' }]);
        assert.equal(w.P.work, null);
        assert.match(String(w.P.rewriteMarkup()), /data-guard-dirty/, 'the dialog asks before it throws a typed note away');
    });
});

// ─── The voice ──────────────────────────────────────────────────────────────────────────────────────

describe('Explainers: the voice step', () => {
    const voiced = (over: Json = {}): Json => ({
        status: 'drawing', audio: { url: '/api/uploads/a1', media_id: 'a1', duration: 82.4, voice: 'ar-001-commercial-3', version: 3, words_version: 3, fallback: false },
        scenes: [scene(0, { start_s: 0, end_s: 4.2 }), scene(1, { start_s: 4.2, end_s: 9 }), scene(2, { start_s: 9, end_s: 12.5 })], ...over,
    });

    it('plays the audio and lists the time of every scene, with a button that plays from it', () => {
        const w = world();
        open(w, voiced(), 'voice');
        const markup = String(w.P.voiceMarkup());
        assert.match(markup, /<audio id="ex-audio" controls[^>]*src="\/api\/uploads\/a1"/);
        assert.equal((markup.match(/class="ex-time"/g) ?? []).length, 3);
        assert.match(markup, /0:00–0:04/);
        assert.match(markup, /data-action="explainers:playFrom"[^>]*data-t="4.2"/);
        assert.match(markup, /href="#\/help\/explainers#voice"/);
        assert.equal(markup.includes(w.t('explainers.voice.checkTiming.title')), false);
        const audio = { currentTime: 0, played: 0, play() { this.played += 1; return Promise.resolve(); } };
        w.h.dom.set('ex-audio', audio as never);
        action(w, 'playFrom', { dataset: { t: '4.2' } });
        assert.deepEqual([audio.currentTime, audio.played], [4.2, 1]);
    });

    it('flags "check timing" when some words could not be aligned, and asks for a new voice when the narration changed', () => {
        const w = world();
        open(w, voiced({ audio: { ...voiced().audio, fallback: true }, audio_stale: true }), 'voice');
        assert.ok(String(w.P.voiceMarkup()).includes(w.t('explainers.voice.checkTiming.title')));
        const notice = String(w.P.noticesMarkup());
        assert.ok(notice.includes(w.t('errors.EXPLAINER_AUDIO_STALE')), 'the server’s sentence for a narration that changed after it was voiced');
        assert.ok(notice.includes(w.t('errors.EXPLAINER_AUDIO_STALE.next')));
        assert.match(notice, /data-action="explainers:revoice"/);
        w.P.step = 'script';
        assert.equal(String(w.P.noticesMarkup()).includes('explainers:revoice'), false, 'on the script step the hint is in the editor, not a button');
    });

    it('re-voices through the route and follows the pipeline to the voice step', async () => {
        const w = world({ api: { revoiceExplainer: async () => explainer(voiced({ status: 'voicing', audio_stale: false })) } });
        open(w, voiced({ audio_stale: true }), 'pictures');
        w.P.paintDetail = () => {};
        const button = { disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'Voice it again', offsetWidth: 0 };
        await action(w, 'revoice', button);
        assert.equal(called(w, 'revoiceExplainer').length, 1);
        assert.equal(w.P.detail.status, 'voicing');
        assert.equal(w.P.step, 'voice', 'the pictures step was the pipeline’s; the pipeline moved to the voice');
    });

    it('waits with the job’s own words while it voices', () => {
        const w = world();
        open(w, { status: 'voicing', audio: null, job: { status: 'running', progress: 'voicing 2 of 4 parts' } }, 'voice');
        const markup = String(w.P.voiceMarkup());
        assert.ok(markup.includes('voicing 2 of 4 parts'));
        assert.ok(markup.includes(w.t('explainers.voice.workingTitle')));
    });
});

// ─── The pictures ───────────────────────────────────────────────────────────────────────────────────

describe('Explainers: the pictures step', () => {
    // As the server keeps them (draw.ts): `picture` is the one in use and `pictures` the EARLIER ones, newest first, never the one in use.
    const scenes = (): Json[] => [
        scene(0, { picture: picture(1), pictures: [], draw_status: 'done' }),
        scene(1, { picture: picture(3), pictures: [picture(2), picture(1)], draw_status: 'done', draw_note: 'he is holding a book' }),
        scene(2, { continues: true, picture: picture(3), draw_status: 'done' }),
        scene(3, { draw_status: 'pending' }),
    ];

    it('shows each picture with its text and label, the history of a redrawn scene, and counts a continuing scene as not drawn', () => {
        const w = world();
        open(w, { status: 'review', scenes: scenes(), allowance: { pictures: 23, cap: 80, est_left: 57 } }, 'pictures');
        const markup = String(w.P.picturesMarkup());
        assert.equal((markup.match(/class="ex-pic"/g) ?? []).length, 4);
        assert.match(markup, /src="\/api\/uploads\/m1"[^>]*alt="Scene 1: L0"/);
        assert.match(markup, /class="ex-tag"[^>]*>L1</);
        assert.equal((markup.match(/data-action="explainers:pick"/g) ?? []).length, 2, 'two EARLIER pictures in scene 2’s history');
        assert.equal((markup.match(/class="ex-history"/g) ?? []).length, 1, 'a scene with no earlier picture has no strip: there is nothing to go back to');
        assert.match(markup, /data-scene="1" data-index="0"[^>]*aria-label="Use earlier picture 1"/, 'the newest earlier picture is number 1, and its index is 0');
        assert.match(markup, /data-scene="1" data-index="1"[^>]*aria-label="Use earlier picture 2"/);
        assert.doesNotMatch(markup, /aria-pressed/, 'the picture in use is shown, not offered');
        assert.match(markup, /<span class="ex-hist is-current" role="img" aria-label="The picture in use"><img src="\/api\/uploads\/m3"/, 'the strip starts with the one in use');
        assert.equal((markup.match(/class="ex-hist is-current"/g) ?? []).length, 1);
        const oneEarlier = String(w.P.sceneMediaMarkup(scene(0, { picture: picture(5), pictures: [picture(4)], draw_status: 'done' })));
        assert.match(oneEarlier, /class="ex-history"/, 'a single earlier picture is already something to go back to');
        assert.equal((oneEarlier.match(/data-action="explainers:pick"/g) ?? []).length, 1);
        assert.ok(markup.includes('he is holding a book'));
        assert.ok(markup.includes(w.t('explainers.pictures.continues')), 'the continuing scene is copied, not drawn');
        assert.equal((markup.match(/data-action="explainers:redraw"/g) ?? []).length, 3, 'and has no redraw of its own');
        assert.ok(text(markup).includes('2 of 3 drawn'), 'three scenes of their own, two drawn');
        assert.ok(text(markup).includes('Today’s free allowance: 23 of 80 pictures used, about 57 left'));
        assert.match(markup, /href="#\/help\/explainers#pictures"/);
    });

    it('says "waiting for tomorrow’s allowance (n of m drawn)" when drawing is paused, and offers to continue', () => {
        const w = world();
        open(w, { status: 'drawing', draw_paused_until: '2026-10-26T00:05:00Z', scenes: scenes(), job: { status: 'done' } }, 'pictures');
        const summary = text(w.P.picSummaryMarkup());
        assert.match(summary, /Waiting for tomorrow’s allowance \(2 of 3 drawn\)/);
        assert.match(summary, /continues by itself after .*Nothing is charged/);
        assert.match(String(w.P.picSummaryMarkup()), /data-action="explainers:drawAll"/);
        assert.ok(String(w.P.picSummaryMarkup()).includes(w.t('explainers.pictures.continue')), 'Continue, not Draw all, once some are drawn');
        const fresh = world();
        open(fresh, { status: 'drawing', scenes: [scene(0), scene(1)], job: { status: 'running', progress: 'drawn 0 of 2' } }, 'pictures');
        assert.equal(String(fresh.P.picSummaryMarkup()).includes('explainers:drawAll'), false, 'not while the Mac is drawing');
        assert.ok(String(fresh.P.picSummaryMarkup()).includes('drawn 0 of 2'));
    });

    it('says when the allowance itself is paused (a redraw is refused until then), and only while that time is ahead', () => {
        const w = world();
        const future = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
        open(w, { status: 'review', scenes: scenes(), allowance: { pictures: 80, cap: 80, est_left: 0, paused_until: future } }, 'pictures');
        const paused = text(w.P.picSummaryMarkup());
        assert.match(paused, /Drawing is paused until .*: today’s allowance is used up\./);
        assert.match(paused, /about 0 left/);
        const past = world();
        open(past, { status: 'review', scenes: scenes(), allowance: { pictures: 23, cap: 80, est_left: 57, paused_until: '2020-01-01T00:00:00Z' } }, 'pictures');
        assert.equal(text(past.P.picSummaryMarkup()).includes('Drawing is paused'), false, 'a time that has passed is not a pause');
        const none = world();
        open(none, { status: 'review', scenes: scenes(), allowance: { pictures: 23, cap: 80, est_left: 57, paused_until: null } }, 'pictures');
        assert.equal(text(none.P.picSummaryMarkup()).includes('Drawing is paused'), false);
    });

    it('Approve is for the review: disabled while drawing, with a scene missing, or with the audio out of date', () => {
        const state = (over: Json): string => { const w = world(); open(w, over, 'pictures'); return String(w.P.picApproveMarkup()); };
        const all = [scene(0, { picture: picture(1), draw_status: 'done' }), scene(1, { picture: picture(2), draw_status: 'done' })];
        assert.match(state({ status: 'drawing', scenes: scenes() }), /id="ex-approve-pictures"[^>]*disabled/);
        assert.match(state({ status: 'drawing', scenes: all }), /disabled/, 'every scene has a picture, but the Mac has not finished: not yet');
        assert.match(state({ status: 'review', scenes: scenes() }), /disabled/, 'scene 4 has no picture');
        const ready = state({ status: 'review', scenes: all });
        assert.doesNotMatch(ready, /disabled/);
        assert.match(state({ status: 'review', scenes: all, audio_stale: true }), /disabled/);
        assert.equal(state({ status: 'ready', scenes: all }), '', 'nothing to approve once rendering has started');
    });

    it('Approve is the second gate: it asks, then calls the route and follows the pipeline to the video', async () => {
        const w = world({ api: { approveExplainerPictures: async () => explainer({ status: 'rendering' }) } });
        open(w, { status: 'review', scenes: scenes() }, 'pictures');
        w.P.paintDetail = () => {};
        action(w, 'approvePictures');
        assert.equal(w.confirms[0]!.tone, 'primary');
        await w.confirms[0]!.onConfirm();
        assert.equal(called(w, 'approveExplainerPictures').length, 1);
        assert.equal(w.P.step, 'video');
    });

    it('redraws one scene with its note, only that scene changes, and the note is cleared', async () => {
        const answer = { scene: scene(3, { picture: picture(9), pictures: [], draw_status: 'done', draw_note: 'pointing at books' }), allowance: { pictures: 24, cap: 80, est_left: 56 } };
        const w = world({ api: { drawExplainerScene: async () => answer, getExplainer: async () => explainer({ status: 'review', scenes: scenes() }) } });
        open(w, { status: 'review', scenes: scenes(), allowance: { pictures: 23, cap: 80, est_left: 57 } }, 'pictures');
        const note: Json = { value: '  pointing at books ' };
        w.h.dom.set('ex-note-3', note as never);
        w.P.notes[3] = 'pointing at books';
        const button = { disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'Redraw', offsetWidth: 0, dataset: { scene: '3' } };
        await action(w, 'redraw', button);
        assert.deepEqual(plain(called(w, 'drawExplainerScene')[0]!.args), [ID, 3, { note: 'pointing at books' }]);
        assert.equal(w.P.detail.scenes[3].picture.media_id, 'm9');
        assert.equal(w.P.detail.scenes[0].picture.media_id, 'm1', 'the others are as they were');
        assert.equal(w.P.detail.allowance.pictures, 24, 'and the meter went down by one picture');
        assert.equal(note.value, '');
        assert.equal('3' in w.P.notes, false);
        assert.match(w.toasts[0]!.message, /Scene 4 redrawn/);
        // no note: nothing is sent under `note`
        const bare = world({ api: { drawExplainerScene: async () => answer, getExplainer: async () => explainer({ status: 'review' }) } });
        open(bare, { status: 'review', scenes: scenes() }, 'pictures');
        await action(bare, 'redraw', { ...button });
        assert.deepEqual(plain(called(bare, 'drawExplainerScene')[0]!.args), [ID, 3, {}]);
    });

    it('a refused redraw says so as a sentence and leaves the scene as it was', async () => {
        const refusal = Object.assign(new Error('Drawing is paused'), { status: 429, code: 'EXPLAINER_ALLOWANCE_PAUSED', params: { retryAt: '2026-10-26T00:05:00Z' } });
        const w = world({ api: { drawExplainerScene: async () => { throw refusal; } } });
        open(w, { status: 'review', scenes: scenes() }, 'pictures');
        const button = { disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'Redraw', offsetWidth: 0, dataset: { scene: '0' } };
        await action(w, 'redraw', button);
        assert.equal(w.toasts[0]!.type, 'error');
        assert.equal(w.P.detail.scenes[0].picture.media_id, 'm1');
    });

    it('picks one of the earlier pictures by its index in the scene’s `pictures`, and the one in use takes its place there', async () => {
        // Picking the older earlier picture (index 1, m1): the server makes it the chosen one and sets the old chosen one (m3) aside as the newest earlier.
        const w = world({ api: {
            pickExplainerPicture: async () => ({ scene: scene(1, { picture: picture(1), pictures: [picture(3), picture(2)], draw_status: 'done' }) }),
            getExplainer: async () => explainer({ status: 'review' }),
        } });
        open(w, { status: 'review', scenes: scenes() }, 'pictures');
        await action(w, 'pick', { dataset: { scene: '1', index: '1' } });
        assert.deepEqual(plain(called(w, 'pickExplainerPicture')[0]!.args), [ID, 1, { index: 1 }]);
        assert.equal(w.P.detail.scenes[1].picture.media_id, 'm1');
        assert.deepEqual(w.P.detail.scenes[1].pictures.map((p: Json) => p.media_id), ['m3', 'm2'], 'the one that was in use is now the newest earlier picture');
        const strip = String(w.P.sceneMediaMarkup(w.P.detail.scenes[1]));
        assert.match(strip, /<span class="ex-hist is-current"[^>]*><img src="\/api\/uploads\/m1"/);
        assert.equal((strip.match(/data-action="explainers:pick"/g) ?? []).length, 2);
    });

    it('a refused pick is a sentence and leaves the scene as it was', async () => {
        const refusal = Object.assign(new Error('Scene 2 has no earlier picture number 3.'), { status: 404, code: 'EXPLAINER_NOT_FOUND' });
        const w = world({ api: { pickExplainerPicture: async () => { throw refusal; } } });
        open(w, { status: 'review', scenes: scenes() }, 'pictures');
        await action(w, 'pick', { dataset: { scene: '1', index: '2' } });
        assert.equal(w.toasts[0]!.type, 'error');
        assert.equal(w.P.detail.scenes[1].picture.media_id, 'm3');
    });

    it('a repaint of the grid keeps a note that was typed, and a poll patches only the scene whose picture changed', () => {
        const w = world();
        open(w, { status: 'drawing', scenes: scenes() }, 'pictures');
        const field: Json = { value: 'typed note' };
        w.h.dom.set('ex-note-1', field as never);
        w.P.capturePictureNotes();
        field.value = '';
        w.P.restorePictureNotes();
        assert.equal(field.value, 'typed note');
        const media = (n: number): Json => w.h.el(`ex-media-${n}`, { dataset: { sig: w.P.sceneSig(w.P.detail.scenes[n]) } as never });
        const untouched = media(0);
        const stale = media(3);
        untouched.innerHTML = 'unchanged';
        w.h.el('ex-pic-summary');
        w.h.el('ex-pic-approve');
        w.P.detail.scenes[3] = { ...w.P.detail.scenes[3], picture: picture(7), pictures: [], draw_status: 'done' };
        w.P.patchBody();
        assert.equal(untouched.innerHTML, 'unchanged');
        assert.match(String(stale.innerHTML), /ex-pic-img/);
    });
});

// ─── The video ──────────────────────────────────────────────────────────────────────────────────────

describe('Explainers: the video step', () => {
    const render = (over: Json = {}): Json => ({ vertical_url: '/api/uploads/v1', horizontal_url: '/api/uploads/h1', cover_url: '/api/uploads/c1', duration: 82, sound_mode: 'sfx', version: 3, job_id: 'j', ...over });

    it('plays both videos, shows the cover, and downloads each under a name made of the title and the part', () => {
        const w = world();
        open(w, { status: 'ready', render: render() }, 'video');
        const markup = String(w.P.videoMarkup());
        assert.equal((markup.match(/<video /g) ?? []).length, 2);
        assert.match(markup, /<video[^>]*poster="\/api\/uploads\/c1"[^>]*src="\/api\/uploads\/v1"/);
        assert.match(markup, /src="\/api\/uploads\/c1" alt="The cover"/);
        for (const name of ['Why-RAG-vertical.mp4', 'Why-RAG-horizontal.mp4', 'Why-RAG-cover.jpg']) assert.ok(markup.includes(`download="${name}"`), name);
        assert.match(markup, /href="#\/help\/explainers#video"/);
        assert.match(markup, /id="ex-sound-form" data-submit="explainers:rerender"/, 'Render again, with the Sound choice');
    });

    it('says the video was made before the latest edits when the server says so (`render_stale`), and only then', () => {
        const stale = world();
        open(stale, { status: 'ready', render: render({ version: 2 }), draft_version: 3, render_stale: true }, 'video');
        const notice = String(stale.P.noticesMarkup());
        assert.ok(notice.includes(stale.t('errors.EXPLAINER_RENDER_STALE')) && notice.includes(stale.t('errors.EXPLAINER_RENDER_STALE.next')), 'in the server’s words');
        // The page does not work it out for itself: a render whose version differs, with no flag from the server, is not called stale.
        const guess = world();
        open(guess, { status: 'ready', render: render({ version: 2 }), draft_version: 3, render_stale: false }, 'video');
        assert.equal(String(guess.P.noticesMarkup()).includes(guess.t('errors.EXPLAINER_RENDER_STALE')), false);
        const fresh = world();
        open(fresh, { status: 'ready', render: render(), draft_version: 3 }, 'video');
        assert.equal(String(fresh.P.noticesMarkup()).includes(fresh.t('errors.EXPLAINER_RENDER_STALE')), false);
    });

    it('does not offer Schedule for a video the server calls stale, and says what to do instead', () => {
        const w = world();
        open(w, { status: 'ready', render: render({ version: 2 }), draft_version: 3, render_stale: true }, 'publish');
        const markup = String(w.P.publishMarkup());
        assert.equal(markup.includes('id="ex-schedule-form"'), false, 'Schedule would be refused with 409 EXPLAINER_RENDER_STALE');
        assert.ok(String(w.P.noticesMarkup()).includes(w.t('errors.EXPLAINER_RENDER_STALE.next')), 'make it again, then schedule it');
        assert.match(String(w.P.noticesMarkup()), /data-action="explainers:goStep" data-step="video">Go to the video</, 'and one press takes the owner to where it is made again');
        const fresh = world();
        open(fresh, { status: 'ready', render: render() }, 'publish');
        assert.match(String(fresh.P.publishMarkup()), /id="ex-schedule-form"/);
    });

    it('keeps the previous files visible while a new render runs, and offers no re-render once scheduled', () => {
        const running = world();
        open(running, { status: 'rendering', render: render(), job: { status: 'running', progress: 'rendering the vertical video' } }, 'video');
        const markup = String(running.P.videoMarkup());
        assert.match(markup, /<video/);
        assert.ok(markup.includes('rendering the vertical video'));
        assert.equal(markup.includes('id="ex-sound-form"'), false);
        const scheduled = world();
        open(scheduled, { status: 'scheduled', render: render(), schedule: { scheduled_time: '2026-10-26T15:00:00Z', group_id: 'g', row_ids: ['p1'] } }, 'video');
        assert.equal(String(scheduled.P.videoMarkup()).includes('id="ex-sound-form"'), false);
    });

    it('waits with a panel before the first render', () => {
        const w = world();
        open(w, { status: 'rendering', render: null, job: { status: 'pending' } }, 'video');
        const markup = String(w.P.videoMarkup());
        assert.ok(markup.includes(w.t('explainers.video.workingTitle')));
        assert.equal(markup.includes('<video'), false);
    });

    it('Render again saves a changed Sound first (the track only for music), then renders; music without a track is refused', async () => {
        const w = world({ api: {
            updateExplainer: async () => explainer({ status: 'ready', sound_mode: 'music', music_track_id: 'calm', render: render() }),
            renderExplainer: async () => explainer({ status: 'rendering', sound_mode: 'music', music_track_id: 'calm', render: render() }),
        } });
        open(w, { status: 'ready', render: render() }, 'video');
        w.P.afterAction = (res: Json) => { w.P.applyDetail(res); };
        const form = (sound: string, track: string, subtitles = true): Json => ({
            elements: { music_track_id: { value: track }, subtitles: { checked: subtitles } },
            querySelector: (sel: string) => (sel === 'input[name="sound_mode"]:checked' ? { value: sound } : null),
        });
        w.h.el('ex-sound-error');
        await action(w, 'rerender', form('music', ''), event());
        assert.equal(w.calls.filter((c) => c.name === 'renderExplainer').length, 0);
        await action(w, 'rerender', form('music', 'calm'), event());
        assert.deepEqual(w.calls.map((c) => c.name), ['updateExplainer', 'renderExplainer']);
        assert.deepEqual(plain(called(w, 'updateExplainer')[0]!.args), [ID, { sound_mode: 'music', subtitles: true, music_track_id: 'calm' }]);
        const same = world({ api: { renderExplainer: async () => explainer({ status: 'rendering' }) } });
        open(same, { status: 'ready', render: render() }, 'video');
        same.P.afterAction = () => {};
        await action(same, 'rerender', form('sfx', ''), event());
        assert.deepEqual(same.calls.map((c) => c.name), ['renderExplainer'], 'nothing changed: only the render');
    });
});

// ─── Publish, and the LinkedIn kit ──────────────────────────────────────────────────────────────────

describe('Explainers: publish and the LinkedIn kit', () => {
    it('turns every blank line into one U+2800 line, and drops the blank lines at the ends', () => {
        const { P } = world();
        assert.equal(P.linkedinText('One.\n\nTwo.'), `One.\n${BLANK}\nTwo.`);
        assert.equal(P.linkedinText('A\n\n\nB'), `A\n${BLANK}\n${BLANK}\nB`, 'every blank line, not one per gap');
        assert.equal(P.linkedinText('\n\n  Start\r\n \r\nEnd  \n\n'), `Start\n${BLANK}\nEnd`, 'CRLF, spaces-only lines and the ends');
        assert.equal(P.linkedinText('no breaks'), 'no breaks');
        assert.equal(P.linkedinText('  \n\n '), '', 'an empty caption stays empty: no lone invisible character');
        assert.equal(P.linkedinText('a\n\nb').includes('\n\n'), false, 'no empty line survives');
    });

    it('copies the Instagram and Facebook caption in that form, with the credit line when the track needs one, and the first comment as it is', async () => {
        const w = world();
        open(w, { status: 'ready', sound_mode: 'music', music_track_id: 'calm' }, 'publish');
        action(w, 'copyLinkedIn');
        await settle();
        assert.deepEqual(w.clipboard, [`First paragraph.\n${BLANK}\nSecond paragraph.\n${BLANK}\nMusic: Calm by Ana`]);
        action(w, 'copyFirstComment');
        await settle();
        assert.equal(w.clipboard[1], 'Sources: Lewis et al. 2020');
        assert.equal(w.toasts.filter((x) => x.type === 'error').length, 0);
        const sfx = world();
        open(sfx, { status: 'ready' }, 'publish');
        action(sfx, 'copyLinkedIn');
        await settle();
        assert.deepEqual(sfx.clipboard, [`First paragraph.\n${BLANK}\nSecond paragraph.`], 'sound effects only: no credit line');
    });

    it('says so when the clipboard is not there, instead of saying it copied', async () => {
        const w = world();
        open(w, { status: 'ready' }, 'publish');
        w.h.ctx.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
        action(w, 'copyLinkedIn');
        await settle();
        assert.equal(w.toasts[0]!.type, 'error');
    });

    it('the kit is there from the first draft, before the video is ready, with the captions and no Schedule form', () => {
        const w = world();
        open(w, { status: 'draft' }, 'publish');
        const markup = String(w.P.publishMarkup());
        assert.match(markup, /data-action="explainers:copyLinkedIn"/);
        assert.match(markup, /data-action="explainers:copyFirstComment"/);
        assert.ok(markup.includes('YT title') && markup.includes('TikTok caption'), 'a caption for each platform');
        assert.equal(markup.includes('id="ex-schedule-form"'), false);
        assert.ok(markup.includes(w.t('explainers.publish.notReady')));
        assert.match(markup, /href="#\/help\/explainers#publish"/);
        assert.ok(markup.includes(BLANK), 'the kit’s caption holds the blank lines it will copy');
    });

    it('sends the YouTube video by the rule: the horizontal one over 3 minutes, the vertical one as a Short otherwise', () => {
        const long = world();
        long.P.platforms = ['instagram', 'facebook', 'youtube'];
        open(long, { status: 'ready', render: { vertical_url: '/v', horizontal_url: '/h', cover_url: '/c', duration: 181, sound_mode: 'sfx', version: 3, job_id: 'j' } }, 'publish');
        assert.ok(text(long.P.planMarkup()).includes(long.t('explainers.plan.youtubeLong')));
        const short = world();
        short.P.platforms = ['instagram', 'facebook', 'youtube', 'tiktok'];
        open(short, { status: 'ready', render: { vertical_url: '/v', horizontal_url: '/h', cover_url: '/c', duration: 180, sound_mode: 'sfx', version: 3, job_id: 'j' } }, 'publish');
        assert.ok(text(short.P.planMarkup()).includes(short.t('explainers.plan.youtubeShort')));
        assert.ok(text(short.P.planMarkup()).includes(short.t('explainers.plan.tiktok')));
    });

    it('lists the platforms Schedule will really post to: all four follow the brand’s settings, LinkedIn never', async () => {
        const plan = (platforms: string[] | null): string => {
            const w = world({ lang: 'en' });
            w.P.platforms = platforms;
            open(w, { status: 'ready', render: { vertical_url: '/v', horizontal_url: '/h', cover_url: '/c', duration: 82, sound_mode: 'sfx', version: 3, job_id: 'j' } }, 'publish');
            return text(w.P.planMarkup());
        };
        // The default `infographic.platforms` is Instagram and Facebook: no YouTube row until the owner ticks it.
        const byDefault = plan(['instagram', 'facebook']);
        assert.ok(byDefault.includes('Instagram and Facebook'));
        assert.equal(byDefault.includes('YouTube'), false, 'YouTube is not posted unless the brand says so');
        assert.equal(byDefault.includes('TikTok'), false, 'no TikTok draft unless the brand ticks it');
        assert.ok(byDefault.includes('LinkedIn'));
        assert.ok(plan(['instagram', 'tiktok']).includes('TikTok'), 'TikTok, ticked, is a draft');
        const all = plan(['instagram', 'facebook', 'youtube']);
        assert.ok(all.includes('YouTube'));
        assert.ok(plan(['instagram']).includes('Instagram the vertical video'), 'one Meta platform is named alone');
        assert.equal(plan(['youtube']).includes('Instagram'), false, 'no Meta platform: no Meta row');
        // The settings answer feeds it.
        const w = world();
        w.P.acceptSettings({ status: 'fulfilled', value: { settings: { explainer: CONFIG, schedule: { timezone: 'Asia/Dubai' }, infographic: { platforms: ['facebook', 'youtube', 'tiktok'] } } } });
        assert.deepEqual(plain(w.P.platforms), ['facebook', 'youtube', 'tiktok']);
        w.P.acceptSettings({ status: 'fulfilled', value: { settings: { explainer: CONFIG } } });
        assert.equal(w.P.platforms, null, 'a settings answer without them leaves the plan unknown, not empty');
    });

    it('Schedule sends next, now, or an instant read in the tenant’s zone, and refuses a time that is missing', async () => {
        const w = world({ api: {
            scheduleExplainer: async () => explainer({ status: 'scheduled', schedule: { scheduled_time: '2026-10-26T15:00:00Z', group_id: 'g', row_ids: ['p1'] } }),
            getScheduledPosts: async () => [{ id: 'p1', platform: 'both', status: 'PENDING', scheduled_time: '2026-10-26T15:00:00Z' }, { id: 'zz', platform: 'tiktok', status: 'PENDING' }],
        } });
        open(w, { status: 'ready' }, 'publish');
        w.P.paintDetail = () => {};
        w.P.paintBody = () => {};
        w.P.schedulePoll = () => {};
        w.h.UI.setZone('Asia/Dubai');
        w.h.el('ex-schedule-error');
        const form = (when: string, at = ''): Json => ({
            elements: { at: { value: at } },
            querySelector: (sel: string) => (sel === 'input[name="when"]:checked' ? { value: when } : null),
        });
        await action(w, 'schedule', form('at', ''), event());
        assert.equal(called(w, 'scheduleExplainer').length, 0);
        assert.match(String(w.h.dom.get('ex-schedule-error')!.innerHTML), /Choose a day and a time/);
        await action(w, 'schedule', form('now'), event());
        await action(w, 'schedule', form('next'), event());
        await action(w, 'schedule', form('at', '2026-10-27T19:00'), event());
        assert.deepEqual(plain(called(w, 'scheduleExplainer').map((c) => c.args[1])), [{ when: 'now' }, { when: 'next' }, { when: '2026-10-27T15:00:00.000Z' }]);
        assert.deepEqual(plain(w.P.rows.map((r: Json) => r.id)), ['p1'], 'only this explainer’s posts, by the ids the schedule names');
    });

    it('shows each post’s status and link once scheduled, and a YouTube link when it is published', () => {
        const w = world();
        open(w, { status: 'scheduled', render: { vertical_url: '/v', horizontal_url: '/h', cover_url: '/c', duration: 82, sound_mode: 'sfx', version: 3, job_id: 'j' }, schedule: { scheduled_time: '2026-10-26T15:00:00Z', group_id: 'g', row_ids: ['p1', 'p2', 'p3'] } }, 'publish');
        w.P.rows = [
            { id: 'p1', platform: 'both', status: 'PUBLISHED', published_post_id: 'FB:1 | IG:2', scheduled_time: '2026-10-26T15:00:00Z' },
            { id: 'p2', platform: 'youtube', status: 'PUBLISHED', published_post_id: 'YT:abc_DEF-1', scheduled_time: '2026-10-26T15:00:00Z' },
            { id: 'p3', platform: 'tiktok', status: 'FAILED', error_log: 'The token expired', scheduled_time: '2026-10-26T15:00:00Z' },
        ];
        w.P.rowsLoaded = true;
        const markup = String(w.P.scheduledMarkup());
        assert.equal((markup.match(/class="ex-row-post"/g) ?? []).length, 3);
        assert.match(markup, /href="https:\/\/www\.youtube\.com\/shorts\/abc_DEF-1"[^>]*target="_blank" rel="noopener noreferrer"/);
        assert.match(markup, /badge-success/);
        assert.match(markup, /badge-danger/);
        assert.ok(markup.includes('The token expired'));
        assert.match(markup, /href="#\/posts"/);
        assert.equal(w.P.rowsOpen(), false, 'nothing is pending: no more polls');
        w.P.rows[0].status = 'PENDING';
        assert.equal(w.P.rowsOpen(), true);
        const bad = w.P.rowLink({ platform: 'youtube', published_post_id: 'YT:"><script>' });
        assert.equal(bad.href, '#/posts', 'an id that is not an id is never put in a link');
    });
});

// ─── Polls ──────────────────────────────────────────────────────────────────────────────────────────

describe('Explainers: live updates', () => {
    it('polls while a step runs and the tab is visible, and stops with the page', () => {
        const w = world();
        open(w, { status: 'voicing', job: { status: 'running' } }, 'voice');
        assert.equal(w.P.wantsPoll(), true);
        w.P.schedulePoll(w.P._seq);
        assert.ok(w.P._timer, 'a poll is scheduled');
        w.P.destroy();
        assert.equal(w.P._timer, null);
        for (const status of ['draft', 'review', 'ready', 'failed']) {
            const q = world();
            open(q, { status });
            assert.equal(q.P.wantsPoll(), false, `${status}: nothing is running`);
        }
        const list = world();
        list.P.kind = 'list';
        list.P.items = [{ id: 'a', status: 'draft' }, { id: 'b', status: 'drawing' }];
        assert.equal(list.P.wantsPoll(), true);
        list.P.items = [{ id: 'a', status: 'draft' }];
        assert.equal(list.P.wantsPoll(), false);
    });

    it('does not poll while the tab is hidden, and a hidden tab resumes it when it is shown again', () => {
        const w = world();
        open(w, { status: 'rendering', job: { status: 'running' } }, 'video');
        w.h.document.visibilityState = 'hidden';
        w.P.schedulePoll(w.P._seq);
        assert.equal(w.P._timer, null);
    });

    it('repaints a step only when what it shows changed: a poll must not reset a playing video or a chosen option', () => {
        const w = world();
        open(w, { status: 'ready', render: { vertical_url: '/v1', horizontal_url: '/h1', cover_url: '/c1', duration: 82, sound_mode: 'sfx', version: 3, job_id: 'j' } }, 'video');
        const body = w.h.el('ex-body');
        for (const id of ['ex-head', 'ex-worker', 'ex-notices', 'ex-steps']) w.h.el(id);
        w.h.el('ex-detail');
        w.P.paintBody(true);
        assert.match(String(body.innerHTML), /<video/);
        body.innerHTML = 'what the player is showing now';
        w.P.applyDetail(explainer({ status: 'ready', updated_at: 'later', render: { vertical_url: '/v1', horizontal_url: '/h1', cover_url: '/c1', duration: 82, sound_mode: 'sfx', version: 3, job_id: 'j' } }), { poll: true });
        w.P.paintDetail();
        assert.equal(body.innerHTML, 'what the player is showing now', 'nothing new: not repainted');
        w.P.applyDetail(explainer({ status: 'ready', render: { vertical_url: '/v2', horizontal_url: '/h1', cover_url: '/c1', duration: 82, sound_mode: 'sfx', version: 4, job_id: 'j2' } }), { poll: true });
        w.P.paintDetail();
        assert.match(String(body.innerHTML), /\/v2/, 'a new render: repainted');
    });

    it('moves on with the pipeline only for an owner who was watching the step that finished', () => {
        const watching = world();
        open(watching, { status: 'voicing' }, 'voice');
        watching.P.applyDetail(explainer({ status: 'drawing', scenes: [scene(0)] }), { poll: true });
        assert.equal(watching.P.step, 'pictures');
        const reading = world();
        open(reading, { status: 'voicing' }, 'script');
        reading.P.applyDetail(explainer({ status: 'drawing', scenes: [scene(0)] }), { poll: true });
        assert.equal(reading.P.step, 'script', 'someone editing the script is not moved off it');
        const failed = world();
        open(failed, { status: 'failed', failed_step: 'render', error: 'ffmpeg exited' });
        assert.equal(failed.P.step, 'video', 'a failure opens the step that failed');
        assert.match(String(failed.P.noticesMarkup()), /data-action="explainers:retry"/);
    });

    it('retries the failed step through the route', async () => {
        const w = world({ api: { retryExplainer: async () => explainer({ status: 'voicing' }) } });
        open(w, { status: 'failed', failed_step: 'voice', error: 'VOICE_LIMIT: tomorrow' });
        w.P.afterAction = (res: Json) => { w.P.applyDetail(res); };
        const button = { disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'Try again', offsetWidth: 0 };
        await action(w, 'retry', button);
        assert.equal(called(w, 'retryExplainer').length, 1);
        assert.equal(w.P.detail.status, 'voicing');
    });

    it('draws the failure with its step named, its sentence and a link to the article', () => {
        const w = world();
        open(w, { status: 'failed', failed_step: 'voice', error: 'VOICE_LIMIT: retry in 24h' });
        const notice = text(w.P.noticesMarkup());
        assert.ok(notice.includes('It stopped while voicing'));
        assert.ok(notice.includes(w.t('errors.EXPLAINER_VOICE_LIMIT')), 'the server’s sentence for the voice allowance');
        assert.match(String(w.P.noticesMarkup()), /href="#\/help\/explainers#troubleshooting"/);
    });
});

// ─── What the server decides: read from its answers, not guessed ────────────────────────────────────

describe('Explainers: what the server decides', () => {
    // Reconciled with src/routes/studio.ts and src/services/explainers/ (explainers.ts, scenes.ts, spec.ts, schedule.ts): the page shows these answers and
    // offers only what the server accepts, instead of guessing.
    const AUDIO = { url: '/api/uploads/a1', media_id: 'a1', duration: 12, voice: 'v', version: 3, words_version: 3, fallback: false };
    const voicedScenes = (): Json[] => [
        scene(0, { start_s: 0, end_s: 4, picture: picture(1), pictures: [picture(4)], draw_status: 'done' }),
        scene(1, { start_s: 4, end_s: 8, picture: picture(2), draw_status: 'done' }),
        scene(2, { start_s: 8, end_s: 12, picture: picture(3), draw_status: 'done' }),
    ];
    const button = (dataset: Json = {}): Json => ({ disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'x', offsetWidth: 0, dataset });

    it('a scheduled explainer is read-only: the server refuses an edit of it (409), so the page does not offer one', () => {
        const scheduled = world();
        open(scheduled, { status: 'scheduled', schedule: { scheduled_time: '2026-10-26T15:00:00Z', group_id: 'g', row_ids: ['p1'] }, audio: AUDIO, scenes: voicedScenes() }, 'script');
        assert.equal(scheduled.P.isEditable(), false);
        const markup = String(scheduled.P.scriptMarkup());
        assert.equal(markup.includes('id="ex-save"'), false);
        assert.match(markup, /data-field="narration"[^>]*readonly/);
        for (const status of ['draft', 'drawing', 'review', 'ready', 'failed']) {
            const w = world();
            open(w, { status });
            assert.equal(w.P.isEditable(), true, `${status} can be edited`);
        }
    });

    it('scenes can be added, removed or moved only before the narration is voiced: after it a scene’s picture and time belong to its place', () => {
        const before = world({ lang: 'en' });
        open(before, { status: 'draft' });
        assert.equal(before.P.canRestructure(), true);
        const open1 = String(before.P.scriptMarkup());
        for (const control of ['sceneUp', 'sceneDown', 'sceneAdd', 'sceneRemove']) assert.ok(open1.includes(`data-action="explainers:${control}"`), control);
        assert.equal(open1.includes(before.t('explainers.scene.fixedAfterVoice')), false);

        const after = world({ lang: 'en' });
        open(after, { status: 'drawing', audio: AUDIO, scenes: voicedScenes() }, 'script');
        assert.equal(after.P.canRestructure(), false);
        const locked = String(after.P.scriptMarkup());
        for (const control of ['sceneUp', 'sceneDown', 'sceneAdd', 'sceneRemove']) assert.equal(locked.includes(`data-action="explainers:${control}"`), false, `${control} is not offered`);
        assert.equal(locked.includes('id="ex-scene-add-btn"'), false);
        assert.ok(locked.includes(after.t('explainers.scene.fixedAfterVoice')), 'and the page says why');
        assert.match(locked, /data-field="narration" rows="2" maxlength="300"/, 'the text of each scene is still edited in place');
        // A picture or a time on any scene is enough: a draft with a scene already timed is not restructured either.
        const timed = world();
        open(timed, { status: 'draft', scenes: [scene(0, { start_s: 0, end_s: 3 }), scene(1)] });
        assert.equal(timed.P.canRestructure(), false);
        // The actions refuse as the server would.
        after.P.ensureWork();
        action(after, 'sceneRemove', { dataset: { i: '0' } });
        action(after, 'sceneAdd', { dataset: { i: '0' } });
        action(after, 'sceneDown', { dataset: { i: '0' } });
        assert.equal(after.P.work.scenes.length, 3);
        assert.equal(after.P.work.scenes[0].narration, 'Sentence 0.', 'nothing moved');
    });

    it('holds the fields to the limits of an edit, and refuses the 11th reply and the 21st source', () => {
        const w = world({ lang: 'en' });
        open(w, { status: 'draft' });
        const markup = String(w.P.scriptMarkup());
        assert.match(markup, /data-field="first-comment" rows="4" maxlength="1500"/);
        assert.match(markup, /data-field="q" rows="2" maxlength="300"/);
        assert.match(markup, /data-field="a" rows="3" maxlength="600"/);
        assert.match(markup, /data-field="url" maxlength="500"/);
        w.P.ensureWork();
        w.P.work.replies = Array.from({ length: 10 }, () => ({ q: 'q', a: 'a' }));
        action(w, 'replyAdd');
        assert.equal(w.P.work.replies.length, 10);
        assert.match(w.toasts[0]!.message, /At most 10 likely objections/);
        w.P.work.sources = Array.from({ length: 20 }, () => ({ title: 't', by: '', year: '', url: '' }));
        action(w, 'sourceAdd');
        assert.equal(w.P.work.sources.length, 20);
        assert.match(w.toasts[1]!.message, /At most 20 sources/);
        assert.ok(w.t('explainers.script.repliesHint', { max: 10 }).startsWith('Up to 10'));
    });

    it('says each finding by its code, with its 0-based scene shown as a number and its field by the editor’s own label, in both languages', () => {
        const en = world({ lang: 'en' });
        const say = (f: Json): string => en.P.findingText(f);
        assert.equal(say({ code: 'field_empty', scene: 0, field: 'brief', message: 'x' }), 'Scene 1: Empty field: Picture brief (English).');
        assert.equal(say({ code: 'field_too_long', scene: 4, field: 'narration', message: 'x' }), 'Scene 5: Longer than 300 characters: On-screen text.');
        assert.equal(say({ code: 'field_too_long', field: 'title', message: 'x' }), 'Longer than 70 characters: Video title.');
        assert.equal(say({ code: 'label_too_long', scene: 1, field: 'label', message: 'x' }), 'Scene 2: The label is longer than 4 words or 40 characters: it has to fit on a tag.');
        assert.equal(say({ code: 'too_many_characters', scene: 1, field: 'characters', message: 'x' }), 'Scene 2: A scene can draw at most 4 characters together.');
        assert.equal(say({ code: 'too_many_scenes', message: 'x' }), 'The script has more than 300 scenes.');
        assert.equal(say({ code: 'closing_question', scene: 9, field: 'narration', message: 'x' }), 'Scene 10: The last scene must ask the viewer a genuine question.');
        assert.equal(say({ code: 'female_subject', scene: 0, field: 'brief', message: 'x' }), 'Scene 1: A picture brief names a woman or a girl. Explainers never draw them.');
        // What the page has no sentence for is shown as the server worded it.
        assert.equal(say({ code: 'field_empty', field: 'something_new', message: 'The something_new is empty.' }), 'The something_new is empty.');
        assert.equal(say({ code: 'a_new_rule', scene: 2, message: 'A rule this page does not know.' }), 'Scene 3: A rule this page does not know.');
        assert.equal(say('A plain sentence'), 'A plain sentence');
        const ar = world({ lang: 'ar' });
        const arabic = ar.P.findingText({ code: 'field_empty', scene: 0, field: 'spoken', message: 'x' });
        assert.ok(arabic.includes('حقل فارغ: النص المنطوق.') && arabic.startsWith('المشهد'), arabic);
        // A refusal's list: `findings` (each with a code) win over `problems` (the same sentences, in English).
        const err = Object.assign(new Error('The script has problems to fix first: 1.'), {
            code: 'EXPLAINER_DRAFT_REFUSED', params: { found: 1 }, body: { findings: [{ code: 'field_empty', scene: 0, field: 'brief', message: 'x' }], problems: ['Scene 1: the brief is empty.'] },
        });
        const box = text(en.P.errorMarkup(err));
        assert.ok(box.includes('Scene 1: Empty field: Picture brief (English).') && !box.includes('the brief is empty'));
        assert.ok(box.includes(en.t('errors.EXPLAINER_DRAFT_REFUSED', { found: 1 })), 'above the list, the server’s own sentence');
    });

    it('a refused approval lists what to fix beside the script, not in the dialog; a script that changed meanwhile is read again', async () => {
        const findings = [{ code: 'closing_question', scene: 2, field: 'narration', message: 'x' }, { code: 'field_empty', field: 'title', message: 'The title is empty.' }];
        const refused = Object.assign(new Error('2 problems with this script.'), { status: 422, code: 'EXPLAINER_DRAFT_REFUSED', params: { found: 2 }, body: { findings, problems: ['x', 'The title is empty.'] } });
        const w = world({ lang: 'en', api: { approveExplainer: async () => { throw refused; } } });
        open(w, { status: 'draft' });
        w.h.el('ex-script-error');
        action(w, 'approve');
        assert.equal(w.confirms.length, 1);
        await w.confirms[0]!.onConfirm();
        const box = text(w.h.el('ex-script-error').innerHTML);
        assert.ok(box.includes('Scene 3: The last scene must ask the viewer a genuine question.') && box.includes('Empty field: Video title.'));
        assert.equal(w.P.detail.status, 'draft', 'nothing moved');

        const changed = Object.assign(new Error('The script changed since you opened it. Read it again, then approve.'), { status: 409, code: 'CHANGED_MEANWHILE' });
        const w2 = world({ api: { approveExplainer: async () => { throw changed; }, getExplainer: async () => explainer({ draft_version: 4, title: 'Written meanwhile' }) } });
        open(w2, { status: 'draft' });
        action(w2, 'approve');
        await assert.rejects(() => Promise.resolve(w2.confirms[0]!.onConfirm()), (e: Json) => e.code === 'CHANGED_MEANWHILE');
        await settle();
        assert.equal(called(w2, 'getExplainer').length, 1, 'the page looks at what is there now');
        assert.equal(w2.P.detail.draft_version, 4);
    });

    it('a scene’s picture can be drawn, redrawn or chosen from the voice until the post, and not while the video renders', () => {
        const withPictures = (over: Json): Json => ({ audio: AUDIO, scenes: voicedScenes(), ...over });
        const controls = (over: Json): { redraw: boolean; pick: boolean; locked: boolean } => {
            const w = world({ lang: 'en' });
            open(w, withPictures(over), 'pictures');
            const markup = String(w.P.picturesMarkup());
            return { redraw: markup.includes('data-action="explainers:redraw"'), pick: markup.includes('data-action="explainers:pick"'), locked: markup.includes(w.t('explainers.pictures.lockedRendering')) };
        };
        for (const status of ['drawing', 'review', 'ready', 'scheduled']) assert.deepEqual(controls({ status }), { redraw: true, pick: true, locked: false }, status);
        assert.deepEqual(controls({ status: 'failed', failed_step: 'draw' }), { redraw: true, pick: true, locked: false }, 'a failed drawing is where the owner fixes a scene by hand');
        assert.deepEqual(controls({ status: 'rendering' }), { redraw: false, pick: false, locked: true }, 'the renderer has the pictures: the server answers 409, and the page says why');
        assert.deepEqual(controls({ status: 'failed', failed_step: 'render' }), { redraw: false, pick: false, locked: false });
        assert.deepEqual(controls({ status: 'voicing' }), { redraw: false, pick: false, locked: false });
    });

    it('says the notes the server keeps while Gemini writes in the Mac’s place in the interface language, and shows any other note as the server worded it', () => {
        for (const lang of ['en', 'ar'] as const) {
            const w = world({ lang });
            const unclaimed = text(w.P.failureHtml('The Mac did not pick this up in 10 minutes and is off or asleep, so Gemini is writing it.'));
            const signedOut = text(w.P.failureHtml('Claude on the Mac is signed out, so Gemini is writing it. Sign in again on the Mac to have Claude write.'));
            assert.equal(unclaimed, w.t('explainers.note.gemini_unclaimed'), lang);
            assert.equal(signedOut, w.t('explainers.note.gemini_signed_out'), lang);
        }
        const w = world({ lang: 'en' });
        assert.ok(text(w.P.failureHtml('Some other note the server kept.')).includes('Some other note the server kept.'));
        // while it writes, the note is on the explainer and shown beside the step
        open(w, { status: 'writing', draft: null, scenes: [], error: 'Claude on the Mac is signed out, so Gemini is writing it. Sign in again on the Mac to have Claude write.', job: { status: 'running', progress: 'Gemini is writing it', not_before: null } });
        assert.ok(text(w.P.noticesMarkup()).includes(w.t('explainers.note.gemini_signed_out')));
    });

    it('while it draws, the count of pictures is the server’s own `progress`, the same as the list’s card; otherwise it counts the scenes that hold one', () => {
        const scenes = [
            scene(0, { picture: picture(1), draw_status: 'done' }), scene(1, { continues: true, picture: picture(1), draw_status: 'done' }),
            scene(2, { picture: picture(2), draw_status: 'done' }), scene(3, { draw_status: 'pending' }),
        ];
        const drawing = world({ lang: 'en' });
        open(drawing, { status: 'drawing', progress: { done: 3, total: 4 }, scenes, job: { status: 'running', progress: null, not_before: null } }, 'pictures');
        assert.ok(text(drawing.P.picSummaryMarkup()).includes('3 of 4 drawn'));
        assert.ok(text(drawing.P.cardMarkup({ id: 'a', status: 'drawing', progress: { done: 3, total: 4 }, title: 't', topic: 't', language: 'ar', length_tier: 'short' })).includes('3 of 4 drawn'), 'the list says the same');
        const review = world({ lang: 'en' });
        open(review, { status: 'review', progress: null, scenes }, 'pictures');
        assert.ok(text(review.P.picSummaryMarkup()).includes('2 of 3 drawn'), 'a scene that continues is copied, not drawn: three scenes of their own, two drawn');
    });

    it('Rewrite with a note is offered to a draft only: the server rewrites nothing else (409 EXPLAINER_BAD_STATE)', () => {
        const draft = world();
        open(draft, { status: 'draft' });
        assert.match(String(draft.P.scriptMarkup()), /id="ex-rewrite"/);
        for (const status of ['drawing', 'review', 'ready', 'failed']) {
            const w = world();
            open(w, { status, audio: AUDIO, scenes: voicedScenes() });
            assert.equal(String(w.P.scriptMarkup()).includes('id="ex-rewrite"'), false, `${status}: no rewrite`);
        }
    });

    it('Continue drawing exists only while the explainer is drawing (the server’s startDraw answers nothing else)', () => {
        const rest = [scene(0, { picture: picture(1), draw_status: 'done' }), scene(1, { draw_status: 'pending' })];
        const drawing = world();
        open(drawing, { status: 'drawing', scenes: rest, job: { status: 'done', progress: null, not_before: null } }, 'pictures');
        assert.match(String(drawing.P.picSummaryMarkup()), /data-action="explainers:drawAll"/);
        const review = world();
        open(review, { status: 'review', scenes: rest }, 'pictures');
        assert.equal(String(review.P.picSummaryMarkup()).includes('explainers:drawAll'), false);
    });

    it('says why Approve pictures is off in the server’s own sentences: what is missing, or a voice out of date', () => {
        const missing = world({ lang: 'en' });
        open(missing, { status: 'review', scenes: [scene(0, { picture: picture(1), draw_status: 'done' }), scene(1), scene(2)] }, 'pictures');
        const hint = text(missing.P.picApproveMarkup());
        assert.ok(hint.includes('Some scenes have no picture yet (2).') && hint.includes('Draw the missing pictures, then approve again.'));
        assert.match(String(missing.P.picApproveMarkup()), /id="ex-approve-pictures"[^>]*disabled/);
        const stale = world({ lang: 'en' });
        open(stale, { status: 'review', audio_stale: true, scenes: voicedScenes(), audio: AUDIO }, 'pictures');
        const staleHint = text(stale.P.picApproveMarkup());
        assert.ok(staleHint.includes('The narration changed after it was voiced.') && staleHint.includes('Voice it again, then approve the pictures or make the video.'));
        const ready = world({ lang: 'en' });
        open(ready, { status: 'review', scenes: voicedScenes(), audio: AUDIO }, 'pictures');
        assert.equal(/id="ex-approve-pictures"[^>]*disabled/.test(String(ready.P.picApproveMarkup())), false);
        const ar = world({ lang: 'ar' });
        open(ar, { status: 'review', scenes: [scene(0), scene(1)] }, 'pictures');
        assert.ok(text(ar.P.picApproveMarkup()).includes('بعض المشاهد بلا صورة بعد (2).'));
    });

    it('whether the Mac is there comes with the explainer: the detail asks nothing else, and the list still reads the status', async () => {
        const detail = world({ lang: 'en', hash: `#/explainers?id=${ID}`, api: {
            getExplainer: async () => explainer({ status: 'writing', worker: { online: false, lastSeen: null, name: 'Mac' }, job: { status: 'pending', progress: null, not_before: null } }),
        } });
        await detail.P.render();
        assert.equal(called(detail, 'getStudioStatus').length, 0, 'the explainer’s own answer says it');
        assert.equal(detail.P.worker.online, false);
        assert.ok(text(detail.container.innerHTML).includes(detail.t('explainers.worker.offline')), 'and the notice that nothing moves is drawn');
        // An answer that carries no worker (an action's) leaves what was known.
        detail.P.applyDetail(explainer({ status: 'writing', worker: null, job: { status: 'pending', progress: null, not_before: null } }));
        assert.equal(detail.P.worker.online, false);
        const list = world({ api: { getExplainers: async () => ({ items: [] }), getStudioStatus: async () => ({ worker: { online: true } }) } });
        await list.P.render();
        assert.equal(called(list, 'getStudioStatus').length, 1, 'a list row has no worker: it reads the status once');
    });

    it('says what a waiting job waits for: a time, a Mac that is busy (the server’s note, in the interface language), or a Mac that is away', () => {
        const BUSY = 'Waiting for your Mac: it is busy with another job';
        for (const [lang, said] of [['en', 'Waiting for your Mac: it is busy with another job'], ['ar', 'بانتظار جهازك الماك: فهو مشغول بمهمة أخرى']] as const) {
            const w = world({ lang });
            assert.equal(w.P.progressText({ status: 'writing', job: { status: 'pending', progress: BUSY, not_before: null } }), said, lang);
        }
        const w = world({ lang: 'en' });
        w.P.worker = { online: true };
        const later = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
        assert.match(w.P.progressText({ status: 'voicing', job: { status: 'pending', progress: null, not_before: later } }), /^Waiting until /, 'a voice that waits for its allowance to reset waits for a time, not for the Mac');
        assert.equal(w.P.progressText({ status: 'voicing', job: { status: 'pending', progress: null, not_before: '2020-01-01T00:00:00Z' } }), w.t('explainers.progress.waiting'), 'a time that has passed is not a wait');
        w.P.worker = { online: false };
        assert.equal(w.P.progressText({ status: 'writing', job: { status: 'pending', progress: null, not_before: null } }), w.t('explainers.progress.waitingOffline'));
        assert.equal(w.P.progressText({ status: 'writing', job: { status: 'running', progress: 'Gemini is writing it', not_before: null } }), 'Gemini is writing it', 'a running job’s own line');
    });

    it('a redraw refused because the allowance is used up asks again, so the meter says until when', async () => {
        const later = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
        const refusal = Object.assign(new Error('Drawing is paused'), { status: 429, code: 'EXPLAINER_ALLOWANCE_PAUSED', params: { retryAt: later }, body: { retryAt: later } });
        const w = world({ lang: 'en', api: {
            drawExplainerScene: async () => { throw refusal; },
            getExplainer: async () => explainer({ status: 'review', scenes: voicedScenes(), audio: AUDIO, allowance: { provider: 'cloudflare', day: '2026-10-25', used_units: 8800, pictures: 80, cap: 80, est_left: 0, paused_until: later } }),
        } });
        open(w, { status: 'review', scenes: voicedScenes(), audio: AUDIO, allowance: { pictures: 79, cap: 80, est_left: 1, paused_until: null } }, 'pictures');
        await action(w, 'redraw', button({ scene: '0' }));
        await settle();
        assert.equal(w.toasts[0]!.message, `${w.t('errors.EXPLAINER_ALLOWANCE_PAUSED')} ${w.t('errors.EXPLAINER_ALLOWANCE_PAUSED.next')}`);
        assert.equal(called(w, 'getExplainer').length, 1);
        assert.match(text(w.P.picSummaryMarkup()), /Drawing is paused until .*: today’s allowance is used up\./);
    });

    it('says there is no image provider when the allowance answers JSON null, and claims nothing when it could not be read', async () => {
        const card = (allowance: unknown): string => {
            const w = world({ lang: 'en' });
            w.P.cfg = w.P.normalizeConfig(CONFIG);
            w.P.allowance = allowance;
            return text(w.P.charactersMarkup());
        };
        const none = card(null);
        assert.ok(none.includes('No image provider is set up, so no picture can be drawn.') && none.includes('The platform admin adds the provider’s account and token in the Explainers settings.'));
        assert.equal(card(undefined).includes('No image provider'), false, 'a failed read says nothing about the provider');
        const used = card({ provider: 'cloudflare', day: '2026-10-25', used_units: 2530, pictures: 23, cap: 80, est_left: 57, paused_until: null });
        assert.equal(used.includes('No image provider'), false);
        assert.ok(used.includes('Today’s free allowance: 23 of 80 pictures used, about 57 left.'));
        // The read itself: `null` is kept as null, a failure is undefined, and the switch being off is the switch's panel.
        const read = world({ hash: '#/explainers?tab=settings', api: { getExplainerAllowance: async () => null } });
        await read.P.render();
        assert.equal(read.P.allowance, null);
        const failed = world({ hash: '#/explainers?tab=settings', api: { getExplainerAllowance: async () => { throw new Error('HTTP 500'); } } });
        await failed.P.render();
        assert.equal(failed.P.allowance, undefined);
        const off = world({ lang: 'en', hash: '#/explainers?tab=settings', api: { getExplainerAllowance: async () => { throw Object.assign(new Error('off'), { status: 404, code: 'EXPLAINERS_DISABLED' }); } } });
        await off.P.render();
        assert.ok(text(off.container.innerHTML).includes(off.t('errors.EXPLAINERS_DISABLED')));
    });
});

// ─── Settings ───────────────────────────────────────────────────────────────────────────────────────

describe('Explainers: the settings view', () => {
    it('offers the voices of each language: Arabic also has the native voice', () => {
        const w = world();
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        const look = String(w.P.lookMarkup());
        const ar = /name="voice_ar">([\s\S]*?)<\/select>/.exec(look)![1]!;
        const en = /name="voice_en">([\s\S]*?)<\/select>/.exec(look)![1]!;
        assert.match(ar, /value="ar-001-commercial-3" selected/);
        assert.match(ar, /value="Charon"/);
        assert.equal(en.includes('ar-001-commercial-3'), false);
        assert.match(en, /value="Sadaltager" selected/);
        assert.match(look, /name="title_color" type="color" value="#FFD43B"/);
        assert.match(look, /name="style"[^>]*maxlength="600"/);
        assert.match(look, /name="voice_style"[^>]*maxlength="300"/);
        assert.match(look, /name="default_sound"[\s\S]*?value="sfx" selected/);
        assert.match(look, /name="default_subtitles" checked/);
        assert.match(look, /href="#\/help\/explainers#music"|data-submit="explainers:saveLook"/);
    });

    it('reads the look into the section the server validates, with a colour in capitals and defaults that are values', () => {
        const w = world();
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        const el = (value: string): Json => ({ value });
        const form = { elements: {
            style: el(' warm '), voice_style: el(' calm '), voice_ar: el('Charon'), voice_en: el('Gacrux'), pace_ar: el('2.4'), pace_en: el(''),
            title_color: el('#aabbcc'), default_language: el('en'), default_tier: el('nonsense'), default_sound: el('music'), default_subtitles: { checked: false },
        } };
        assert.deepEqual(plain(w.P.readLook(form)), {
            style: 'warm', voice_style: 'calm', voices: { ar: 'Charon', en: 'Gacrux' }, pace: { ar: 2.4, en: 2.5 }, title_color: '#AABBCC',
            defaults: { sound_mode: 'music', subtitles: false, language: 'en', length_tier: 'short' },
        });
    });

    it('saves the look, the writer and the characters through the one settings route, each as its own `explainer` section', async () => {
        const w = world({ api: { saveStudioSettings: async () => SETTINGS } });
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        for (const id of ['ex-card-look', 'ex-card-writer', 'ex-card-characters', 'ex-look-error', 'ex-writer-error', 'ex-characters-error']) w.h.el(id);
        const form = { elements: { writer: { value: 'gemini' }, writer_fallback: { checked: false } }, querySelector: () => null };
        await action(w, 'saveWriter', form, event());
        assert.deepEqual(plain(called(w, 'saveStudioSettings')[0]!.args[0]), { explainer: { writer: 'gemini', writer_fallback: false } });
        assert.match(String(w.P.writerMarkup()), /name="writer_fallback"[^>]*checked/, 'the fall-back switch, on by default');
        w.P.cfg.characters = [{ ...CHARACTER }];
        w.h.dom.set('ex-characters-form', { querySelectorAll: () => [] } as never);
        await action(w, 'saveCharacters', { querySelector: () => null }, event());
        const sent = called(w, 'saveStudioSettings')[1]!.args[0];
        assert.deepEqual(Object.keys(sent), ['explainer']);
        assert.deepEqual(Object.keys(sent.explainer), ['characters']);
        assert.equal(sent.explainer.characters[0].key, 'karim');
    });

    it('asks for a name, a description and a unique lower-case key before it asks the server', async () => {
        const w = world({ api: { saveStudioSettings: async () => SETTINGS } });
        w.P.cfg = w.P.normalizeConfig({ ...CONFIG, characters: [{ ...CHARACTER }, { ...CHARACTER, name: '', description: '', key: 'Bad Key' }] });
        w.h.el('ex-characters-error');
        w.h.dom.set('ex-characters-form', { querySelectorAll: () => [] } as never);
        await action(w, 'saveCharacters', { querySelector: () => null }, event());
        assert.equal(called(w, 'saveStudioSettings').length, 0);
        const shown = text(w.h.dom.get('ex-characters-error')!.innerHTML);
        assert.match(shown, /Character 2: the key is 1 to 30/);
        assert.match(shown, /Character 2: add a name/);
        assert.match(shown, /Character 2: add a description/);
        assert.deepEqual(w.P.characterProblems([{ ...CHARACTER }, { ...CHARACTER }]).length, 1, 'the same key twice');
    });

    it('draws four candidates, approves one as the reference and saves it with its three fields set together', async () => {
        const cands = Array.from({ length: 5 }, (_, n) => ({ media_id: `${UUID.slice(0, -1)}${n}`, url: `/api/uploads/${UUID.slice(0, -1)}${n}` }));
        const saved = { settings: { explainer: { ...CONFIG, characters: [{ ...CHARACTER, ref_media_id: cands[1]!.media_id, ref_url: cands[1]!.url, approved_at: '2026-10-25T10:00:00.000Z' }] } } };
        const w = world({ api: { createExplainerCandidates: async () => ({ candidates: cands }), saveStudioSettings: async () => saved } });
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        w.h.el('ex-card-characters');
        w.h.el('ex-c-0-status');
        w.h.dom.set('ex-characters-form', { querySelectorAll: () => [] } as never);
        const button = (data: Json): Json => ({ disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'x', offsetWidth: 0, dataset: data });
        await action(w, 'candidates', button({ i: '0' }));
        assert.deepEqual(plain(called(w, 'createExplainerCandidates')[0]!.args[0]), { description: 'a curious young man with a round head' });
        assert.equal(w.P.candidates[0].length, 4, 'four, never five');
        assert.equal((String(w.P.characterMarkup(w.P.cfg.characters[0], 0)).match(/data-action="explainers:approveCandidate"/g) ?? []).length, 4);
        await action(w, 'approveCandidate', button({ i: '0', k: '1' }));
        const sent = called(w, 'saveStudioSettings')[0]!.args[0].explainer.characters[0];
        assert.equal(sent.ref_media_id, cands[1]!.media_id);
        assert.equal(sent.ref_url, cands[1]!.url);
        assert.ok(Date.parse(sent.approved_at) > 0);
        assert.equal(w.P.cfg.characters[0].ref_url, cands[1]!.url);
        assert.equal(w.P.candidates[0], undefined, 'the candidates are gone once one is approved');
    });

    it('a refused description (a woman or a girl) is shown as the server’s sentence and nothing is approved', async () => {
        const refusal = Object.assign(new Error('Explainers never draw women or girls'), { status: 422, code: 'EXPLAINER_PROMPT_REFUSED' });
        const w = world({ api: { createExplainerCandidates: async () => { throw refusal; } } });
        w.P.cfg = w.P.normalizeConfig({ ...CONFIG, characters: [{ ...CHARACTER, description: 'a young woman' }] });
        const status = w.h.el('ex-c-0-status');
        w.h.dom.set('ex-characters-form', { querySelectorAll: () => [] } as never);
        await action(w, 'candidates', { disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'x', offsetWidth: 0, dataset: { i: '0' } });
        assert.match(String(status.innerHTML), /never draw women or girls/);
        assert.equal(w.P.candidates[0], undefined);
    });

    it('resizes an upload to at most 448 px on its longest side, never up, and a candidate name is a key of lower-case letters', () => {
        const { P } = world();
        assert.equal(P.REFERENCE_PX, 448);
        assert.deepEqual(plain(P.fitWithin(2000, 1000, 448)), { width: 448, height: 224 });
        assert.deepEqual(plain(P.fitWithin(1000, 3000, 448)), { width: 149, height: 448 });
        assert.deepEqual(plain(P.fitWithin(300, 200, 448)), { width: 300, height: 200 });
        assert.deepEqual(plain(P.fitWithin(448, 448, 448)), { width: 448, height: 448 });
        assert.deepEqual(plain(P.fitWithin(0, 100, 448)), { width: 1, height: 1 });
        assert.equal(P.keyFrom('Calm Piano — Take 2', [], 'track'), 'calm-piano-take-2');
        assert.equal(P.keyFrom('بيانو هادئ', [], 'track'), 'track', 'a name with no Latin letters falls back');
        assert.equal(P.keyFrom('Calm', ['calm'], 'track'), 'calm-2');
        assert.match(P.keyFrom('x'.repeat(80), [], 'track'), /^[a-z0-9][a-z0-9_-]{0,29}$/);
    });

    it('draws the library with each track’s licence and credit, previews it, and refuses a credit-required track without a credit line', () => {
        const w = world();
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        const music = String(w.P.musicMarkup());
        assert.match(music, /data-field="license"[^>]*value="CC BY 4.0"/);
        assert.match(music, /data-field="credit_required" checked/);
        assert.match(music, /<audio class="ex-track-audio" controls preload="none" src="\/api\/uploads\//);
        assert.match(music, /id="ex-track-form" data-submit="explainers:addTrack"/);
        assert.match(music, /type="file" accept="audio\/mpeg,audio\/mp4,audio\/x-m4a,audio\/wav/);
        assert.equal(w.P.trackProblems([{ ...TRACK, credit: '' }]).length, 1);
        assert.equal(w.P.trackProblems([{ ...TRACK, license: '', title: '' }]).length, 2);
        assert.equal(w.P.trackProblems([{ ...TRACK, credit_required: false, credit: '' }]).length, 0);
        assert.equal(w.P.audioType({ name: 'a.M4A', type: '' }), 'audio/mp4');
        assert.equal(w.P.audioType({ name: 'a.mp3', type: 'audio/mpeg' }), 'audio/mpeg');
        assert.equal(w.P.audioType({ name: 'a.ogg', type: 'audio/ogg' }), '');
    });

    it('adds a track by a signed upload: the file goes to the signed address, then the library is saved with the track', async () => {
        const saved = { settings: { explainer: { ...CONFIG, music: [TRACK, { ...TRACK, key: 'new-song', title: 'New song', media_id: UUID.replace('3f', '4f'), url: `/api/uploads/${UUID.replace('3f', '4f')}` }] } } };
        const w = world({ api: {
            signExplainerUpload: async () => ({ upload_url: 'https://x.supabase.co/storage/v1/object/upload/sign/media/p?token=t', media_id: UUID.replace('3f', '4f'), url: `/api/uploads/${UUID.replace('3f', '4f')}` }),
            saveStudioSettings: async () => saved,
        } });
        w.P.cfg = w.P.normalizeConfig(CONFIG);
        const puts: Json[] = [];
        w.P.putFile = async (signed: Json, body: Json) => { puts.push({ signed, type: body.type, size: body.size }); };
        for (const id of ['ex-card-music', 'ex-track-error', 'ex-track-progress']) w.h.el(id);
        w.h.dom.set('ex-music-form', { querySelectorAll: () => [] } as never);
        const file = { name: 'song.mp3', type: 'audio/mpeg', size: 3_000_000 };
        const form = (over: Json = {}): Json => ({ elements: {
            file: { files: [over.file ?? file] }, title: { value: over.title ?? 'New song' }, artist: { value: 'Ana' }, license: { value: over.license ?? 'CC0' },
            credit: { value: over.credit ?? '' }, credit_required: { checked: over.required ?? false },
        }, querySelector: () => null });
        await action(w, 'addTrack', form({ title: '' }), event());
        await action(w, 'addTrack', form({ file: { ...file, size: 26 * 1024 * 1024 } }), event());
        await action(w, 'addTrack', form({ required: true }), event());
        assert.equal(w.calls.filter((c) => c.name === 'signExplainerUpload').length, 0, 'every refusal comes before a byte is uploaded');
        await action(w, 'addTrack', form(), event());
        assert.deepEqual(plain(called(w, 'signExplainerUpload')[0]!.args[0]), { purpose: 'music', mime: 'audio/mpeg', size: 3_000_000 });
        assert.equal(puts.length, 1);
        const sent = called(w, 'saveStudioSettings')[0]!.args[0].explainer.music;
        assert.equal(sent.length, 2);
        assert.equal(sent[1].key, 'new-song');
        assert.equal(sent[1].license, 'CC0');
        assert.equal(w.P._uploads, 0, 'the upload counter is back to zero');
    });

    it('does not let the page be left while an upload is in flight', () => {
        const w = world();
        w.P._uploads = 1;
        assert.equal(w.P.canLeave(), false);
        w.P._uploads = 0;
        assert.equal(w.P.canLeave(), true);
    });
});

// ─── The platform admin's card ──────────────────────────────────────────────────────────────────────

describe('Settings → Platform → Explainers (the platform admin’s card)', () => {
    const ACCOUNT = '0123456789abcdef0123456789abcdef';
    const TOKEN = 'cf-api-token-0123456789-ABCDEFGHIJ';
    // The answer of GET /api/admin/explainers (src/routes/adminExplainers.ts): every tenant with its switch, and the provider as the card is shown it.
    const provider = { provider: 'cloudflare', account_id: ACCOUNT, token_last4: 'abcd', model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 80, units_per_picture: 110 };
    const answer = { enabled: { t1: true }, provider };

    function settingsWorld(extra: Json = {}): World & { S: Json } {
        const w = world({ admin: true, files: ['dashboard/js/pages/settings.js'], ...extra });
        const S = w.h.run<Json>('SettingsPage');
        S.render = async () => { w.calls.push({ name: 'render', args: [] }); };
        return Object.assign(w, { S });
    }
    const sact = (w: World, name: string, ...args: Json[]): unknown => w.h.UI._actions.settings[name](...args);

    it('is the platform admin’s card in the Platform tab, drawn from the card list like the apps', () => {
        const w = settingsWorld();
        const card = w.h.run<Json>('SettingsPage').CARDS.find((c: Json) => c.id === 'explainers');
        assert.deepEqual({ group: card.group, who: card.who, platform: card.platform }, { group: 'platform', who: 'admin', platform: true });
        assert.equal(w.S.renderCard('explainers', { explainers: null, explainersError: null }), '', 'nothing to draw until the read answers');
    });

    it('shows the token as its last four characters and never puts a token, or a value for the field, in the page', () => {
        const w = settingsWorld();
        const markup = String(w.S.explainersSection({ explainers: answer, explainersError: null }));
        assert.ok(markup.includes('••••abcd'), 'the mask');
        assert.match(markup, /<input[^>]*id="explainers-token"[^>]*type="password"/);
        assert.doesNotMatch(markup, /id="explainers-token"[^>]*value=/, 'the field is never filled');
        assert.match(markup, new RegExp(`id="explainers-account-id"[^>]*value="${ACCOUNT}"`));
        assert.match(markup, /name="daily_cap"[^>]*value="80"/);
        assert.match(markup, /name="units_per_picture"[^>]*value="110"/);
        assert.match(markup, /id="explainers-on"[^>]*checked/, 'the switch is on for this workspace');
        assert.match(markup, /data-action="settings:testExplainers"/);
        assert.match(markup, /href="#\/help\/explainers#settings"/);
        // a response that carried more than it should (a full token) never reaches the page
        const leaky = String(w.S.explainersSection({ explainers: { ...answer, provider: { ...provider, token: 'cf-secret-token-ABCDEFGH', token_enc: 'enc:xyz' } }, explainersError: null }));
        assert.equal(leaky.includes('cf-secret-token'), false);
        assert.equal(leaky.includes('enc:xyz'), false);
        const none = String(w.S.explainersSection({ explainers: { enabled: {}, provider: { ...provider, token_last4: '' } }, explainersError: null }));
        assert.ok(none.includes(w.t('settings.explainers.tokenNone')));
        assert.equal(none.includes('••••'), false);
        assert.doesNotMatch(none, /id="explainers-on"[^>]*checked/, 'off by default');
    });

    it('finds this workspace’s switch whatever the case of the id the server keyed it by', () => {
        const w = settingsWorld();
        assert.match(String(w.S.explainersSection({ explainers: { enabled: { T1: true }, provider }, explainersError: null })), /id="explainers-on"[^>]*checked/);
        assert.doesNotMatch(String(w.S.explainersSection({ explainers: { enabled: { T1: false, other: true }, provider }, explainersError: null })), /id="explainers-on"[^>]*checked/, 'another tenant’s switch is not this one');
        assert.doesNotMatch(String(w.S.explainersSection({ explainers: { enabled: {}, provider: null }, explainersError: null })), /id="explainers-on"[^>]*checked/, 'nothing saved yet: off');
        assert.match(String(w.S.explainersSection({ explainers: { enabled: {}, provider: null }, explainersError: null })), /data-saved="false"/, 'and the form knows the first save needs a token');
        assert.match(String(w.S.explainersSection({ explainers: answer, explainersError: null })), /data-saved="true"/);
    });

    it('says the setup in one line, with the path through Cloudflare and the rule for staying on the free plan', () => {
        for (const lang of ['en', 'ar'] as const) {
            const w = settingsWorld({ lang });
            const markup = text(w.S.explainersSection({ explainers: answer, explainersError: null }));
            assert.ok(markup.includes(w.t('settings.explainers.setup')), lang);
            assert.ok(w.t('settings.explainers.setup').includes('Use REST API'), lang);
            assert.ok(w.t('settings.explainers.setup').includes('Create a Workers AI API Token'), lang);
            assert.ok(markup.includes('Workers Free'), lang);
        }
    });

    it('a failed read is an error with Retry, not an empty card', () => {
        const w = settingsWorld();
        const markup = String(w.S.explainersSection({ explainers: null, explainersError: Object.assign(new Error('Not Found'), { status: 404 }) }));
        assert.match(markup, /class="inline-error"/);
        assert.match(markup, /data-action="settings:render"/);
    });

    /** The form as the page reads it: the fields by name, and whether a provider is already saved (`data-saved`). */
    const providerForm = (over: Record<string, string> = {}, saved = true): Json => {
        const field = (name: string, value: string): Json => ({ value, focus() { (this as Json).focused = true; } });
        const values: Record<string, string> = { account_id: ACCOUNT, token: '', daily_cap: '', units_per_picture: '', ...over };
        return { elements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, field(k, v)])), dataset: { saved: String(saved) }, querySelector: () => null };
    };

    it('saves the account and the caps, and sends the token only when one was typed', async () => {
        const w = settingsWorld({ api: { saveAdminExplainersProvider: async () => answer } });
        await sact(w, 'saveExplainers', providerForm({ account_id: `  ${ACCOUNT} `, daily_cap: '60' }), event());
        assert.deepEqual(plain(called(w, 'saveAdminExplainersProvider')[0]!.args[0]), { account_id: ACCOUNT, daily_cap: 60 }, 'a blank token is not sent: it stays as it is');
        await sact(w, 'saveExplainers', providerForm({ token: ` ${TOKEN} `, daily_cap: '60', units_per_picture: '104.5' }), event());
        assert.deepEqual(plain(called(w, 'saveAdminExplainersProvider')[1]!.args[0]), { account_id: ACCOUNT, token: TOKEN, daily_cap: 60, units_per_picture: 104.5 }, 'the cost of a picture may have a fraction: the server takes any positive number');
        assert.equal(w.toasts.filter((x) => x.type === 'success').length, 2);
        await sact(w, 'saveExplainers', providerForm({ daily_cap: '0' }), event());
        assert.equal(called(w, 'saveAdminExplainersProvider')[2]!.args[0].daily_cap, 0, 'a cap of 0 is allowed: the server takes 0 to 1,000');
    });

    it('checks what the server checks, and says so in its own words before any request is made', async () => {
        const w = settingsWorld({ api: { saveAdminExplainersProvider: async () => answer } });
        const refused = async (over: Record<string, string>, saved: boolean, expected: string): Promise<void> => {
            const before = called(w, 'saveAdminExplainersProvider').length;
            const toasts = w.toasts.length;
            const form = providerForm(over, saved);
            await sact(w, 'saveExplainers', form, event());
            assert.equal(called(w, 'saveAdminExplainersProvider').length, before, `${JSON.stringify(over)}: refused before the server`);
            assert.equal(w.toasts[toasts]!.type, 'error');
            assert.ok(w.toasts[toasts]!.message.includes(expected), `${JSON.stringify(over)} says "${expected}", not "${w.toasts[toasts]!.message}"`);
        };
        await refused({ account_id: '   ' }, true, 'Enter the Cloudflare Account ID');
        await refused({ account_id: 'acct-123' }, true, 'letters and digits only, 8 to 64');
        await refused({ account_id: 'abc1234' }, true, 'letters and digits only');
        await refused({ account_id: ACCOUNT, token: '' }, false, 'the first save needs it');
        await refused({ token: 'short-token' }, true, '20 to 200 characters');
        await refused({ token: `Bearer ${TOKEN}` }, true, 'without “Bearer”');
        await refused({ daily_cap: '1001' }, true, 'from 0 to 1,000');
        await refused({ daily_cap: '12.5' }, true, 'whole number');
        await refused({ daily_cap: '-1' }, true, 'whole number');
        await refused({ units_per_picture: '0' }, true, 'positive number, at most 10,000');
        await refused({ units_per_picture: '10001' }, true, 'at most 10,000');
        // the first save with everything in place goes through, and a later one may leave the token blank
        await sact(w, 'saveExplainers', providerForm({ token: TOKEN }, false), event());
        await sact(w, 'saveExplainers', providerForm({}, true), event());
        assert.equal(called(w, 'saveAdminExplainersProvider').length, 2);
        // the same rules in Arabic
        const ar = settingsWorld({ lang: 'ar' });
        await sact(ar, 'saveExplainers', providerForm({ account_id: 'acct-1' }), event());
        assert.match(ar.toasts[0]!.message, /معرّف الحساب أحرف لاتينية وأرقام فقط، من 8 إلى 64 خانة/);
    });

    it('a refused save is read through the shared error text: the server’s sentence and its next step, never the raw server text', async () => {
        const w = settingsWorld({ api: { saveAdminExplainersProvider: async () => { throw Object.assign(new Error('HTTP 502 {"error":"x"}'), { status: 502, code: 'EXPLAINER_PROVIDER_ERROR' }); } } });
        await sact(w, 'saveExplainers', providerForm(), event());
        assert.equal(w.toasts[0]!.type, 'error');
        assert.equal(w.toasts[0]!.message, `${w.t('errors.EXPLAINER_PROVIDER_ERROR')} ${w.t('errors.EXPLAINER_PROVIDER_ERROR.next')}`);
        assert.equal(w.toasts[0]!.message.includes('HTTP 502'), false);
    });

    it('a refusal of the fields lists every problem the server found, and one problem is its own sentence', async () => {
        // The envelope of a 400 here (src/routes/adminExplainers.ts): `error` counts the problems, `problems` names them.
        const three = ['account_id is the Cloudflare account id.', 'token is the Cloudflare API token.', 'daily_cap is the pictures a day.'];
        const many = settingsWorld({ api: { saveAdminExplainersProvider: async () => { throw Object.assign(new Error('3 problems with the provider settings.'), { status: 400, body: { error: '3 problems with the provider settings.', problems: three } }); } } });
        await sact(many, 'saveExplainers', providerForm(), event());
        assert.equal(many.toasts[0]!.message, three.join(' '));
        const one = settingsWorld({ api: { saveAdminExplainersProvider: async () => { throw Object.assign(new Error(three[2]), { status: 400, body: { error: three[2], problems: [three[2]] } }); } } });
        await sact(one, 'saveExplainers', providerForm(), event());
        assert.equal(one.toasts[0]!.message, three[2]);
    });

    it('reads the flat error envelope of the routes: the code and the retry time reach the sentence', () => {
        // `{ error, message, code, params }`, flat, as the app has always answered; a 429 also carries `retryAt` beside them and a `Retry-After` header.
        const h = loadDashboard({ lang: 'en', files: ['dashboard/js/api.js'] });
        const API = h.run<Json>('API');
        const body = { error: 'Drawing is paused.', message: 'Drawing is paused.', code: 'EXPLAINER_ALLOWANCE_PAUSED', params: { retryAt: '2026-10-26T00:00:00.000Z' }, retryAt: '2026-10-26T00:00:00.000Z' };
        const read = API.readError(body);
        assert.deepEqual(plain({ message: read.message, code: read.code, params: read.params }), { message: 'Drawing is paused.', code: 'EXPLAINER_ALLOWANCE_PAUSED', params: { retryAt: '2026-10-26T00:00:00.000Z' } });
        assert.equal(read.flat.retryAt, '2026-10-26T00:00:00.000Z', 'the top-level field stays on the body');
        const err = Object.assign(new Error(read.message), { status: 429, code: read.code, params: read.params });
        assert.equal(h.UI.errorLine(err), `${h.t('errors.EXPLAINER_ALLOWANCE_PAUSED')} ${h.t('errors.EXPLAINER_ALLOWANCE_PAUSED.next')}`, 'the catalogue’s sentence replaces the server’s English');
        // Every code the Explainers routes send has its sentence and next step in both languages.
        const codes = ['EXPLAINERS_DISABLED', 'EXPLAINER_NOT_FOUND', 'EXPLAINER_BAD_STATE', 'EXPLAINER_PROMPT_REFUSED', 'EXPLAINER_NO_PROVIDER', 'EXPLAINER_ALLOWANCE_PAUSED', 'EXPLAINER_PROVIDER_ERROR',
            'EXPLAINER_NO_TRACK', 'EXPLAINER_NEEDS_REFERENCE', 'EXPLAINERS_OWNER_ONLY', 'EXPLAINER_DRAFT_REFUSED', 'EXPLAINER_AUDIO_STALE', 'EXPLAINER_PICTURES_MISSING', 'EXPLAINER_RENDER_STALE', 'EXPLAINER_VOICE_LIMIT'];
        for (const lang of ['en', 'ar'] as const) {
            const strings = loadDashboard({ lang }).run<Record<string, Record<string, string>>>('I18N.strings')[lang]!;
            for (const code of codes) assert.ok(strings[`errors.${code}`] && strings[`errors.${code}.next`], `${lang}: errors.${code}`);
        }
    });

    it('the Test button draws one picture and says how it went in words', async () => {
        const out: Json = { textContent: '', className: '' };
        const ok = settingsWorld({ api: { testAdminExplainersProvider: async () => ({ ok: true, ms: 1840 }) } });
        ok.h.dom.set('explainers-test-result', out as never);
        const button = { disabled: false, getAttribute: () => null, setAttribute() {}, removeAttribute() {}, style: {}, innerHTML: '', textContent: 'Test', offsetWidth: 0 };
        await sact(ok, 'testExplainers', button);
        assert.match(out.textContent, /It works: a test picture was drawn in 1,840 ms/);
        assert.match(out.className, /text-success/);
        const bad = settingsWorld({ api: { testAdminExplainersProvider: async () => ({ ok: false, ms: 90, error: 'Authentication error (code 10000)' }) } });
        bad.h.dom.set('explainers-test-result', out as never);
        await sact(bad, 'testExplainers', { ...button });
        assert.match(out.textContent, /The test failed: Authentication error \(code 10000\)/);
        assert.match(out.className, /text-warning/);
    });

    it('the switch names this workspace and goes back to what it was when the server refuses', async () => {
        const w = settingsWorld({ api: { setAdminExplainersEnabled: async () => answer } });
        const box: Json = { checked: true, disabled: false };
        await sact(w, 'toggleExplainers', box);
        assert.deepEqual(plain(called(w, 'setAdminExplainersEnabled')[0]!.args[0]), { tenant_id: 't1', enabled: true });
        assert.equal(box.checked, true);
        const refused = settingsWorld({ api: { setAdminExplainersEnabled: async () => { throw Object.assign(new Error('only the owner'), { status: 409, code: 'EXPLAINERS_OWNER_ONLY' }); } } });
        const other: Json = { checked: true, disabled: false };
        await sact(refused, 'toggleExplainers', other);
        assert.equal(other.checked, false, 'back to off');
        assert.equal(other.disabled, false);
        assert.equal(refused.toasts[0]!.type, 'error');
    });
});

// ─── The words: Modern Standard Arabic, and every string in both languages ──────────────────────────

describe('Explainers: the words', () => {
    /** Words of the spoken dialects: none belongs in the interface or the article, which are Modern Standard Arabic. */
    const DIALECT = ['ايش', 'إيش', 'شلون', 'وين', 'ليش', 'لسه', 'لسا', 'دحين', 'هلأ', 'هلق', 'مو', 'مش', 'كده', 'كدا', 'دلوقتي', 'عشان', 'هيك', 'شو', 'بدي', 'عايز', 'إزاي', 'ازاي', 'فين', 'ايوه', 'بس', 'اللي', 'وش', 'يبغى', 'ابغى', 'أبغى', 'شوي', 'تبي'];
    const dialectIn = (value: string): string[] => DIALECT.filter((word) => new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'u').test(value));

    function strings(lang: 'ar' | 'en'): Record<string, string> {
        const h = loadDashboard({ lang });
        return h.run<Record<string, Record<string, string>>>('I18N.strings')[lang]!;
    }

    it('has every Explainers string in both languages, with the same placeholders', () => {
        const ar = strings('ar');
        const en = strings('en');
        const mine = (dict: Record<string, string>): string[] => Object.keys(dict).filter((k) => /^(explainers\.|settings\.explainers\.|nav\.explainers$|page\.explainers\.|studio\.tabs\.explainers$)/.test(k));
        assert.ok(mine(en).length > 300, `${mine(en).length} English strings`);
        assert.deepEqual(mine(ar).sort(), mine(en).sort());
        const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
        for (const key of mine(en)) assert.deepEqual(holes(ar[key]!), holes(en[key]!), key);
    });

    it('is Modern Standard Arabic: no dialect word in an Explainers string, and the status words are different words', () => {
        const ar = strings('ar');
        const offenders = Object.keys(ar).filter((k) => /^(explainers\.|settings\.explainers\.|nav\.explainers$|page\.explainers\.|studio\.tabs\.explainers$)/.test(k))
            .map((k) => [k, dialectIn(ar[k]!)] as const).filter(([, found]) => found.length > 0).map(([k, found]) => `${k}: ${found.join(', ')}`);
        assert.deepEqual(offenders, []);
        assert.deepEqual(dialectIn('وش تبي ليش').sort(), ['ليش', 'وش', 'تبي'].sort(), 'the scan finds what it is meant to');
        assert.deepEqual(dialectIn('يجب أن يكون الموضوع بين ثلاثة وثلاثمائة حرف'), []);
    });

    it('the Help article is in Modern Standard Arabic too, and names the picture providers, the allowance and the $0 rule', () => {
        const h = loadDashboard({ files: ['dashboard/js/help-content.js'] });
        const article = h.run<Json>('HelpContent').articles.find((a: Json) => a.slug === 'explainers');
        assert.ok(article, 'the article exists');
        const arabic: string[] = [];
        const walk = (v: unknown): void => {
            if (typeof v === 'string') arabic.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        for (const section of article.sections) { walk(section.title.ar); walk(section.body.ar); }
        const offenders = arabic.map((s) => [s, dialectIn(s)] as const).filter(([, f]) => f.length > 0).map(([s, f]) => `${f.join(', ')} in «${s.slice(0, 60)}»`);
        assert.deepEqual(offenders, []);
        const ids = article.sections.map((s: Json) => s.id);
        for (const id of ['flow', 'start', 'script', 'voice', 'pictures', 'video', 'publish', 'linkedin', 'settings', 'allowance', 'rules', 'music', 'troubleshooting']) assert.ok(ids.includes(id), id);
        const english = JSON.stringify(article.sections.map((s: Json) => s.body.en));
        for (const needle of ['Workers Free', '$0 rule', 'Pixabay', 'incompetech', 'Free Music Archive', 'YouTube Audio Library', 'engagement bait', 'women or girls', '/login']) assert.ok(english.includes(needle), needle);
    });

    it('says where the voice is made and what the sound effects are: Gemini on Google’s servers, the project’s own whoosh and Kenney’s CC0 pop', () => {
        const h = loadDashboard({ files: ['dashboard/js/help-content.js'] });
        const article = h.run<Json>('HelpContent').articles.find((a: Json) => a.slug === 'explainers');
        const body = (lang: 'ar' | 'en'): string => JSON.stringify(article.sections.map((s: Json) => s.body[lang]));
        const en = body('en');
        const ar = body('ar');
        // The voice: the Mac sends the approved script to Google's Gemini, which reads it aloud; then the Mac times every scene. Never "on your Mac".
        assert.ok(en.includes('your Mac sends the approved script to Google’s Gemini, which reads it aloud, and then your Mac times every scene'), 'the flow list');
        assert.ok(en.includes('your Mac sends the script to Google’s Gemini, which runs on Google’s servers, not on your Mac, and reads it aloud'), 'the voice section');
        assert.equal(/Gemini reads the (approved )?script on your Mac/.test(en), false);
        assert.ok(ar.includes('يرسل جهازك الماك النص المعتمد إلى Gemini من Google فيقرؤه بصوت مسموع، ثم يضبط جهازك الماك توقيت كل مشهد'), 'the flow list, in Arabic');
        assert.ok(ar.includes('يرسل جهازك الماك النص إلى Gemini من Google، وهو يعمل على خوادم Google لا على جهازك'), 'the voice section, in Arabic');
        assert.equal(/يقرأ Gemini النص[^"]*على جهازك الماك/.test(ar), false);
        // The sound effects: the project's own whoosh at each cut, Kenney's public-domain (CC0) pop when a label appears; no licence needed from the owner.
        assert.ok(en.includes('**Sound effects only** uses the project’s own whoosh at each cut and a public-domain (CC0) pop from Kenney when a label appears, and needs no licence from you'));
        assert.equal(en.includes('free (CC0) set'), false);
        assert.ok(ar.includes('وصوت «بوب» (pop) من Kenney في الملكية العامة (CC0) حين تظهر تسمية، ولا تحتاج إلى ترخيص منك'));
        assert.ok(ar.includes('صوت «ووش» (whoosh) من إنتاج المشروع نفسه عند كل قطع'));
        assert.equal(ar.includes('مجموعة مجانية (CC0)'), false);
        // The words of the interface say the same: the working panel and the approval dialog name Gemini, and none puts the reading on the Mac.
        for (const lang of ['en', 'ar'] as const) {
            const dict = strings(lang);
            for (const key of ['explainers.voice.workingBody', 'explainers.approve.body']) {
                assert.ok(dict[key]!.includes(lang === 'en' ? 'Google’s Gemini' : 'Gemini من Google'), `${lang} ${key} names Gemini at Google`);
            }
            assert.equal(/Gemini reads|يقرأ Gemini/.test(dict['explainers.voice.workingBody']!), false, `${lang}: Gemini does not read “on your Mac”`);
            assert.equal(/Mac voices|يسجّل (جهازك )?الماك الصوت/.test(Object.keys(dict).filter((k) => k.startsWith('explainers.')).map((k) => dict[k]).join('\n')), false, `${lang}: the Mac does not voice, it runs the step`);
        }
    });

    it('links every step to its section of the article, and every link names a section that exists', () => {
        const source = readFileSync('dashboard/js/pages/explainers.js', 'utf8');
        const linked = new Set([...source.matchAll(/UI\.helpLink\(\s*'explainers#([a-z0-9-]+)'/g)].map((m) => m[1]));
        for (const step of ['script', 'voice', 'pictures', 'video', 'publish']) assert.ok(linked.has(step), `the ${step} step links to the article`);
        for (const extra of ['start', 'settings', 'music', 'troubleshooting']) assert.ok(linked.has(extra), extra);
        const h = loadDashboard({ files: ['dashboard/js/help-content.js'] });
        const article = h.run<Json>('HelpContent').articles.find((a: Json) => a.slug === 'explainers');
        const ids = new Set(article.sections.map((s: Json) => s.id));
        for (const id of linked) assert.ok(ids.has(id), `explainers#${id} is a section`);
    });
});

// ─── Housekeeping: the cache, the stylesheet and the Studio's own error rule ────────────────────────

describe('Explainers: housekeeping', () => {
    it('has a stylesheet that closes every block and holds no colour of its own', () => {
        const css = readFileSync('dashboard/css/pages/explainers.css', 'utf8');
        assert.match(css, /^\/\*[\s\S]*?\*\//, 'it opens with the header comment');
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.equal((rules.match(/\{/g) ?? []).length, (rules.match(/\}/g) ?? []).length, 'every block closes');
        assert.equal(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(rules), false, 'tokens only');
        assert.equal(/\b(margin|padding)-(left|right)\b|\b(left|right)\s*:/.test(rules), false, 'logical properties only: this page is read right to left first');
    });

    it('keeps its API methods in api.js, one per route of the contract', () => {
        const api = readFileSync('dashboard/js/api.js', 'utf8');
        for (const [method, route] of [
            ['getExplainers', "'/studio/explainers'"], ['createExplainer', "'/studio/explainers'"], ['getExplainer', '/studio/explainers/${encodeURIComponent(id)}'],
            ['updateExplainer', "method: 'PATCH'"], ['rewriteExplainer', '/rewrite'], ['approveExplainer', '/approve`'], ['revoiceExplainer', '/revoice'],
            ['drawExplainerScene', '/scenes/${encodeURIComponent(position)}/draw'], ['pickExplainerPicture', '/pick'], ['drawExplainer', '/draw`'],
            ['approveExplainerPictures', '/approve-pictures'], ['renderExplainer', '/render`'], ['scheduleExplainer', '/schedule`'], ['retryExplainer', '/retry'],
            ['deleteExplainer', "method: 'DELETE'"], ['getExplainerAllowance', '/studio/explainers/allowance'], ['createExplainerCandidates', '/characters/candidates'],
            ['signExplainerUpload', '/uploads/sign'], ['getAdminExplainers', "'/admin/explainers'"], ['saveAdminExplainersProvider', '/admin/explainers/provider'],
            ['setAdminExplainersEnabled', '/admin/explainers/enabled'], ['testAdminExplainersProvider', '/admin/explainers/provider/test'],
        ] as const) {
            const at = api.indexOf(`${method}:`);
            assert.ok(at > 0, `${method} exists`);
            assert.ok(api.slice(at, at + 400).includes(route), `${method} → ${route}`);
        }
        assert.match(api, /approveExplainer: \(id, version\) => [\s\S]*?JSON\.stringify\(\{ version \}\)/, 'Approve sends the version');
    });
});
