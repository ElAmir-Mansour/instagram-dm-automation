/**
 * Studio truth (Dashboard UX overhaul, User Story 1: T053 and T054).
 *
 * The REAL shipped files in a `node:vm` context (the shared harness), a fake form for the dialog. What a screenshot cannot check:
 *
 *   T053 (IG-01), the infographic Schedule dialog
 *   - the time field is DISABLED while "next free slot" or "now" is the choice, and a layer over it takes the press and makes it
 *     the choice; focusing it, or typing in it, chooses "at a time I choose" too;
 *   - the slot option says its real time and city (read from the server's next-slot answer), and the submit button names the time
 *     and city of whatever is chosen: the slot, the typed time, or "now";
 *   - a typed time is read as wall time in the TENANT's zone, not the browser's: this file runs the process in New York so a
 *     read in the browser's zone is a different instant, and Schedule sends the Dubai one;
 *   - a slot that cannot be read leaves the plain label (Schedule still works), no free slot moves the choice to a time of its
 *     own, and an answer that lands after the dialog was closed is dropped.
 *
 *   T054 (ST-08, live 413), failures as sentences
 *   - `UI.failureError`: Storage's 413 (the text the Mac worker stores) is STORAGE_FILE_TOO_LARGE, any other technical text
 *     (JSON, an HTTP status, a stack) is STUDIO_STEP_FAILED, a readable sentence is left as it is;
 *   - the main sentence of a failure NEVER holds the raw JSON, in Arabic or English: it is behind "Details";
 *   - the Studio's and the Infographics page's failure strips draw from the error, so a code becomes a sentence with its next step;
 *   - a ratchet: no `err.message` / `e.message` goes into `errorStrip` or a toast in the three Studio pages.
 */
// The tenant is in Dubai; this process is not. A time read in the BROWSER's zone is therefore a different instant.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

/** What the Mac worker records for the live failure of 2026-10-19 (the Mac worker's upload script). */
const LIVE_413 = 'storage answered HTTP 400 to the upload: {"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"}';
const TECHNICAL = 'Gemini answered HTTP 503: {"error":{"code":503,"message":"The model is overloaded","status":"UNAVAILABLE"}}';
const NEXT_SLOT = '2026-10-20T15:00:00.000Z'; // 19:00 on Tuesday 20 October in Dubai (UTC+4); 11:00 in New York

/** The text inside the first `<strong class="error-sentence">` of some markup: what the person reads as THE sentence. */
function sentenceOf(markup: unknown): string {
    const m = /<strong class="error-sentence"[^>]*>([\s\S]*?)<\/strong>/.exec(String(markup));
    return m ? m[1]!.trim() : '';
}
/** The folded Details text of some markup, '' when there is none. */
function detailsOf(markup: unknown): string {
    const m = /<p class="error-details-text"[^>]*>([\s\S]*?)<\/p>/.exec(String(markup));
    return m ? m[1]! : '';
}
const ARABIC = /[؀-ۿ]/;
/** A value that came out of the vm context, as a plain object of this realm (deepEqual compares prototypes). */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

// ─── UI.failureError, errorLine, errorBox, errorDetails ─────────────────────────────────────────────

describe('UI.failureError: a failure that was stored as text', () => {
    it('Storage’s 413, in every spelling the worker may record it, is STORAGE_FILE_TOO_LARGE', () => {
        const { UI } = loadDashboard();
        for (const text of [
            LIVE_413,
            'storage answered HTTP 413 to the upload: Payload Too Large',
            '{"statusCode":413,"error":"x"}',
            'The object exceeded the maximum allowed size',
            'HTTP 413',
        ]) {
            const f = UI.failureError(text);
            assert.equal(f.code, 'STORAGE_FILE_TOO_LARGE', text);
            assert.equal(f.message, text.trim(), 'the text is kept whole, for Details');
        }
    });

    it('any other technical text is STUDIO_STEP_FAILED: JSON, an HTTP status, a socket error, a stack, [object Object]', () => {
        const { UI } = loadDashboard();
        for (const text of [
            TECHNICAL,
            'Remotion exited: HTTP 500 from the render host',
            'connect ECONNREFUSED 127.0.0.1:3000',
            'Error: boom\n    at render (/app/render.mjs:12:3)',
            '[object Object]',
        ]) assert.equal(UI.failureError(text).code, 'STUDIO_STEP_FAILED', text);
    });

    it('a readable sentence is left as it is, uncoded, and nothing is invented for an empty one', () => {
        const { UI, t } = loadDashboard();
        assert.deepEqual({ ...UI.failureError('ffprobe could not read the file') }, { message: 'ffprobe could not read the file' });
        assert.deepEqual({ ...UI.failureError('  Remotion ran out of memory ') }, { message: 'Remotion ran out of memory' });
        for (const empty of ['', '   ', null, undefined, 42]) assert.deepEqual({ ...UI.failureError(empty) }, { message: '' });
        assert.equal(UI.errorText(UI.failureError('')).sentence, t('common.error'));
    });
});

describe('the failure reads as a sentence in both languages, and the raw text is only behind Details', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`${lang}: the 413 says what is wrong and what to do; the JSON is in Details, never in the sentence`, () => {
            const { UI, t } = loadDashboard({ lang });
            const markup = UI.errorHtml(UI.failureError(LIVE_413));
            assert.equal(sentenceOf(markup), t('errors.STORAGE_FILE_TOO_LARGE'));
            assert.doesNotMatch(sentenceOf(markup), /statusCode|Payload|\{|HTTP/);
            assert.ok(String(markup).includes(t('errors.STORAGE_FILE_TOO_LARGE.next').replace(/&/g, '&amp;')), 'and the next step');
            assert.match(detailsOf(markup), /&quot;statusCode&quot;:&quot;413&quot;/, 'the raw text, escaped, behind Details');
            assert.match(detailsOf(markup), /STORAGE_FILE_TOO_LARGE/, 'with its code');
            if (lang === 'ar') assert.match(sentenceOf(markup), ARABIC, 'the sentence is Arabic');
            else assert.doesNotMatch(sentenceOf(markup), ARABIC);
        });

        it(`${lang}: other technical text is a plain "this step did not finish" with the text behind Details`, () => {
            const { UI, t } = loadDashboard({ lang });
            const markup = UI.errorHtml(UI.failureError(TECHNICAL));
            assert.equal(sentenceOf(markup), t('errors.STUDIO_STEP_FAILED'));
            assert.doesNotMatch(sentenceOf(markup), /Gemini|503|\{/);
            assert.match(detailsOf(markup), /The model is overloaded/);
        });
    }

    it('errorLine is the sentence and its next step in one line, for a toast; errorBox is the alert strip with the same content', () => {
        const { UI, t } = loadDashboard();
        const err = UI.failureError(LIVE_413);
        assert.equal(UI.errorLine(err), `${t('errors.STORAGE_FILE_TOO_LARGE')} ${t('errors.STORAGE_FILE_TOO_LARGE.next')}`);
        assert.equal(UI.errorLine({ message: 'Plain.' }), 'Plain.', 'no next step, no trailing space');
        assert.equal(UI.errorLine(null), t('common.error'));
        const box = String(UI.errorBox(err, 'strip-1'));
        assert.match(box, /<div class="inline-error" role="alert" id="strip-1">/);
        assert.match(box, /data-lucide="alert-circle"/);
        assert.equal(sentenceOf(box), t('errors.STORAGE_FILE_TOO_LARGE'));
        assert.doesNotMatch(box, /<script|<img/);
    });

    it('errorBox and errorDetails escape what a worker wrote', () => {
        const { UI } = loadDashboard();
        const evil = '{"x":"<img src=x onerror=alert(1)>"}';
        const box = String(UI.errorBox(UI.failureError(evil)));
        assert.ok(!box.includes('<img'), 'no markup survives');
        assert.ok(box.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.equal(String(UI.errorDetails({ message: 'Plain.' })), '', 'nothing behind a plain sentence: no empty disclosure');
        assert.match(String(UI.errorDetails(UI.failureError(evil))), /<details class="error-details">/);
    });
});

// ─── The infographic Schedule dialog (T053, IG-01) ──────────────────────────────────────────────────

interface FakeRadio { name: string; value: string; checked: boolean; disabled: boolean }
interface DialogWorld {
    h: Dashboard;
    P: Json;
    form: Json;
    at: Json;
    radios: Record<'slot' | 'now' | 'at', FakeRadio>;
    claim: { hidden: boolean };
    labels: { slot: { textContent: string }; hint: { textContent: string }; submit: { textContent: string } };
    shown: string[];
    toasts: Array<{ message: string; type?: string }>;
    posted: Array<{ id: string; body: Json }>;
    closed: number;
    focusListeners: Array<(event: Json) => void>;
    api: Record<string, (...args: Json[]) => unknown>;
    open(): void;
}

const ITEM = { id: 'i1', headline: 'RAG vs CAG', status: 'ready', theme: 'dark', language: 'ar', spec: {}, caption: 'x', render: { mp4_url: 'u', gif_url: 'g', cover_url: 'c' } };

/** The page, an open Schedule dialog standing in for the real form, and the API it talks to. */
function dialog(lang: 'ar' | 'en' = 'en', slotAnswer: unknown = { next_slot: NEXT_SLOT, timezone: 'Asia/Dubai' }): DialogWorld {
    const api: Record<string, (...args: Json[]) => unknown> = {
        getInfographicNextSlot: async () => { if (slotAnswer instanceof Error) throw slotAnswer; return slotAnswer; },
        scheduleInfographic: async (id: string, body: Json) => ({ infographic: { ...ITEM, id, status: 'scheduled' }, scheduled_time: body.scheduled_time || NEXT_SLOT }),
    };
    const posted: Array<{ id: string; body: Json }> = [];
    const API = new Proxy(api, {
        get: (target, prop: string) => (prop in target
            ? (...args: Json[]) => { if (prop === 'scheduleInfographic') posted.push({ id: args[0], body: args[1] }); return target[prop]!(...args); }
            : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
    });
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/infographics.js'],
        globals: { API, App: { currentPage: 'infographics', canOperate: () => true } },
    });
    const P = h.run<Json>('InfographicsPage');
    P.items = [{ ...ITEM }];
    P.brand = P.normalizeBrand({ platforms: ['instagram', 'facebook'] });
    P.settingsLoaded = true;

    // A radio group: checking one unchecks the others, as a browser does (the page reads WHICH is checked).
    let selected = 'slot';
    const radio = (value: string): FakeRadio => ({
        name: 'when', value, disabled: false,
        get checked() { return selected === value; },
        set checked(on: boolean) { if (on) selected = value; },
    });
    const radios: DialogWorld['radios'] = { slot: radio('slot'), now: radio('now'), at: radio('at') };
    const claim = { hidden: false };
    const labels = { slot: { textContent: '' }, hint: { textContent: '' }, submit: { textContent: '' } };
    const focusListeners: Array<(event: Json) => void> = [];
    const world = { closed: 0, shown: [] as string[] };
    const at: Json = { name: 'at', value: '', disabled: true, focused: 0, focus() { this.focused += 1; }, closest: () => form };
    const form: Json = {
        dataset: { id: 'i1' },
        elements: { at },
        closest: (sel: string) => (sel === 'form' ? form : null),
        querySelector(sel: string) {
            if (sel === 'input[name="when"]:checked') return Object.values(radios).find((r) => r.checked) ?? null;
            const m = /^input\[name="when"\]\[value="(slot|now|at)"\]$/.exec(sel);
            if (m) return radios[m[1] as 'slot' | 'now' | 'at'];
            if (sel === '#ig-when-at-claim') return claim;
            if (sel === '#ig-when-slot') return labels.slot;
            if (sel === '#ig-when-at-hint') return labels.hint;
            if (sel === '#ig-schedule-submit-label') return labels.submit;
            return null; // 'button[type="submit"]': UI.formBusy then has nothing to hold, and says so by returning a no-op
        },
        addEventListener: (type: string, fn: (event: Json) => void) => { if (type === 'focusin') focusListeners.push(fn); },
    };
    for (const r of Object.values(radios)) Object.assign(r, { closest: () => form });
    h.dom.set('ig-schedule', form);
    h.el('ig-schedule-error');

    const toasts: Array<{ message: string; type?: string }> = [];
    h.UI.toast = (message: unknown, type?: unknown) => { toasts.push({ message: String(message), type: type as string | undefined }); };
    h.UI.showModal = (markup: unknown) => { world.shown.push(String(markup)); };
    h.UI.closeModal = () => { world.closed += 1; };
    P.put = () => {};
    return {
        h, P, form, at, radios, claim, labels, toasts, posted, focusListeners, api,
        get shown() { return world.shown; },
        get closed() { return world.closed; },
        open() { h.UI._actions.infographics.openSchedule({ dataset: { id: 'i1' } }); },
    } as DialogWorld;
}

const act = (w: DialogWorld, name: string, ...args: Json[]): unknown => w.h.UI._actions.infographics[name](...args);
const inDubai = (w: DialogWorld, iso: string): string => `${w.h.UI.zoneTime(iso, { zone: 'Asia/Dubai' })} (${w.h.UI.zoneCity('Asia/Dubai')})`;

describe('Schedule dialog: the time field, and what it takes to use it (T053)', () => {
    it('opens with the field DISABLED, a layer over it, "the next free slot" chosen, and a hint naming the zone', async () => {
        const w = dialog();
        w.open();
        const markup = w.shown[0]!;
        assert.match(markup, /<input[^>]*type="datetime-local"[^>]*name="at"[^>]*disabled/, 'disabled until "at" is the choice');
        assert.match(markup, /class="ig-at-claim"[^>]*data-action="infographics:pickAt"/, 'the layer that takes the press');
        assert.doesNotMatch(markup, /class="ig-at-claim"[^>]*\shidden/, 'the layer is up');
        assert.match(markup, /name="when" value="slot"[^>]*checked/);
        assert.doesNotMatch(markup, /name="when" value="at"[^>]*checked/);
        assert.match(markup, /id="ig-when-at-hint">[^<]*time \(/, 'In {city} time ({zone})');
        assert.match(markup, /id="ig-schedule-submit-label">Schedule<\/span>/, 'the plain verb until a time is known');
        await settle();
    });

    it('the slot option says its real time and city once the server answers, and the button names them', async () => {
        const w = dialog();
        w.open();
        await settle();
        const where = inDubai(w, NEXT_SLOT);
        assert.match(where, /19:00/);
        assert.equal(w.labels.slot.textContent, w.h.t('infographics.schedule.slotAt', { when: where }));
        assert.equal(w.labels.submit.textContent, w.h.t('infographics.schedule.submitAt', { when: where }), '"Schedule for Tue, 20 Oct, 19:00 (Dubai)"');
        assert.match(w.labels.submit.textContent, /^Schedule for .*19:00 \(Dubai\)$/);
        assert.equal(w.P.zone(), 'Asia/Dubai', 'the zone the answer carried is the one in force');
    });

    it('says it in Arabic too: the city is «دبي», the verb is a verb', async () => {
        const w = dialog('ar');
        w.open();
        await settle();
        assert.match(w.labels.submit.textContent, /^جدولة لموعد .*19:00 \(دبي\)$/);
        assert.match(w.labels.slot.textContent, ARABIC);
    });

    it('choosing "now" keeps the field disabled, the layer over it, and the button says what it will do', async () => {
        const w = dialog();
        w.open();
        await settle();
        w.radios.slot.checked = false;
        w.radios.now.checked = true;
        act(w, 'whenChanged', w.radios.now);
        assert.equal(w.at.disabled, true);
        assert.equal(w.claim.hidden, false);
        assert.equal(w.labels.submit.textContent, w.h.t('infographics.schedule.submitNow'));
        assert.equal(w.radios.slot.checked, false, 'the group has one choice');
    });

    it('choosing "at" enables the field, hides the layer, opens the field on the slot’s wall time in the TENANT zone, and the button names it', async () => {
        const w = dialog();
        w.open();
        await settle();
        w.radios.slot.checked = false;
        w.radios.at.checked = true;
        act(w, 'whenChanged', w.radios.at);
        assert.equal(w.at.disabled, false);
        assert.equal(w.claim.hidden, true);
        assert.equal(w.at.value, '2026-10-20T19:00', 'Dubai wall time, not New York’s 11:00');
        assert.equal(w.labels.submit.textContent, w.h.t('infographics.schedule.submitAt', { when: inDubai(w, NEXT_SLOT) }));
    });

    it('TYPING in the field chooses "at" (and the button follows what is typed, read in the tenant zone)', async () => {
        const w = dialog();
        w.open();
        await settle();
        assert.equal(w.radios.at.checked, false);
        w.at.value = '2026-10-22T21:30';
        act(w, 'atInput', w.at);
        assert.equal(w.radios.at.checked, true, 'typed in, so chosen');
        assert.equal(w.at.disabled, false);
        assert.equal(w.claim.hidden, true);
        assert.match(w.labels.submit.textContent, /^Schedule for .*21:30 \(Dubai\)$/);
    });

    it('FOCUSING the field, however it is reached, chooses "at"; the layer over it does too, and then puts the cursor in it', async () => {
        const w = dialog();
        w.open();
        await settle();
        assert.equal(w.focusListeners.length, 1, 'the dialog listens for focus');
        w.focusListeners[0]!({ target: w.at });
        assert.equal(w.radios.at.checked, true);
        assert.equal(w.at.disabled, false);

        const other = dialog();
        other.open();
        await settle();
        other.focusListeners[0]!({ target: { name: 'something-else', closest: () => other.form } });
        assert.equal(other.radios.at.checked, false, 'focus on anything else changes nothing');
        const layer = { closest: () => other.form };
        act(other, 'pickAt', layer);
        assert.equal(other.radios.at.checked, true);
        assert.equal(other.at.disabled, false);
        assert.equal(other.at.focused, 1, 'the cursor is in the field');
    });

    it('Schedule reads the typed time as wall time in the TENANT zone: 21:30 in Dubai is 17:30Z, whatever zone this browser is in', async () => {
        const w = dialog();
        w.open();
        await settle();
        w.radios.slot.checked = false;
        w.radios.at.checked = true;
        act(w, 'whenChanged', w.radios.at);
        w.at.value = '2026-10-22T21:30';
        await act(w, 'schedule', w.form, { preventDefault() {} });
        assert.deepEqual(plain(w.posted), [{ id: 'i1', body: { scheduled_time: '2026-10-22T17:30:00.000Z' } }]);
        assert.notEqual(w.h.UI.fromLocalInputValue('2026-10-22T21:30'), '2026-10-22T17:30:00.000Z', 'the browser’s own reading is a different instant, as intended');
        assert.equal(w.closed, 1);
        assert.match(w.toasts[0]!.message, /Scheduled for .*21:30 \(Dubai\)/, 'the confirmation says time and city as well');
    });

    it('Schedule with the slot sends nothing but {}, and with "now" sends {now:true}', async () => {
        const w = dialog();
        w.open();
        await settle();
        await act(w, 'schedule', w.form, { preventDefault() {} });
        w.radios.slot.checked = false;
        w.radios.now.checked = true;
        await act(w, 'schedule', w.form, { preventDefault() {} });
        assert.deepEqual(plain(w.posted.map((p) => p.body)), [{}, { now: true }]);
    });

    it('"at" with no time typed is refused here, in words, without a request', async () => {
        const w = dialog(undefined, { next_slot: null, timezone: 'Asia/Dubai' });
        w.open();
        await settle();
        w.at.value = '';
        w.radios.slot.checked = false;
        w.radios.at.checked = true;
        await act(w, 'schedule', w.form, { preventDefault() {} });
        assert.deepEqual(w.posted, []);
        assert.match(String(w.h.dom.get('ig-schedule-error')!.innerHTML), new RegExp(w.h.t('infographics.schedule.atMissing')));
    });

    it('no free slot in the coming weeks: the slot option says so and is off, the choice moves to "at", the field is live', async () => {
        const w = dialog(undefined, { next_slot: null, timezone: 'Asia/Dubai' });
        w.open();
        assert.match(w.shown[0]!, /name="at"/);
        await settle();
        assert.equal(w.labels.slot.textContent, w.h.t('infographics.schedule.slotNone'));
        assert.equal(w.radios.slot.disabled, true);
        assert.equal(w.radios.at.checked, true);
        assert.equal(w.at.disabled, false);
        assert.equal(w.claim.hidden, true);
    });

    it('a slot that cannot be read leaves the plain label, and Schedule still works (the server picks the slot)', async () => {
        const w = dialog('en', new Error('boom'));
        w.open();
        await settle();
        assert.equal(w.labels.slot.textContent, w.h.t('infographics.schedule.slot'));
        assert.equal(w.labels.submit.textContent, w.h.t('infographics.action.schedule'));
        assert.equal(w.radios.slot.disabled, false);
        await act(w, 'schedule', w.form, { preventDefault() {} });
        assert.deepEqual(plain(w.posted.map((p) => p.body)), [{}]);
    });

    it('an answer that lands after the dialog closed, or for another one, is dropped', async () => {
        const w = dialog();
        w.open();
        w.h.dom.delete('ig-schedule');
        await settle();
        assert.equal(w.labels.slot.textContent, '', 'nothing was written into a dialog that is gone');
        assert.equal(w.P.slot.status, 'ready', 'the page still learned it');

        const second = dialog();
        second.open();
        second.form.dataset.id = 'someone-else';
        await settle();
        assert.equal(second.labels.slot.textContent, '');
    });

    it('a refusal inside the dialog is a sentence with its next step, the English only behind Details', async () => {
        const w = dialog();
        w.open();
        await settle();
        const said = 'The caption doesn\'t mention «KAG»: it must talk about what the infographic shows.';
        w.api.scheduleInfographic = async () => { throw Object.assign(new Error(said), { status: 409, code: 'CAPTION_MISSING_COLUMNS', params: { columns: ['KAG'], list: '«KAG»' }, body: { error: said, problems: [said] } }); };
        await act(w, 'schedule', w.form, { preventDefault() {} });
        const box = String(w.h.dom.get('ig-schedule-error')!.innerHTML);
        assert.equal(sentenceOf(box), w.h.t('errors.CAPTION_MISSING_COLUMNS', { list: '⁨«KAG»⁩' }));
        assert.ok(box.includes(w.h.t('errors.CAPTION_MISSING_COLUMNS.next').replace(/&/g, '&amp;')) || /error-next/.test(box), 'with its next step');
        assert.match(detailsOf(box), /doesn&#39;t mention|doesn't mention/);
    });

    it('the card says WHEN it is scheduled in the tenant’s zone, with the city, not in the browser’s', () => {
        const w = dialog();
        w.h.UI.setZone('Asia/Dubai');
        const card = String(w.P.cardMarkup({ ...ITEM, status: 'scheduled', schedule: { scheduled_time: NEXT_SLOT } }));
        assert.ok(card.includes(inDubai(w, NEXT_SLOT)), card);
    });
});

describe('Infographics: failures are sentences (T054)', () => {
    it('a failed infographic’s card never holds the raw JSON as its sentence', () => {
        const w = dialog();
        const card = String(w.P.cardMarkup({ ...ITEM, status: 'failed', render: null, error: LIVE_413 }));
        assert.equal(sentenceOf(card), w.h.t('errors.STORAGE_FILE_TOO_LARGE'));
        assert.match(detailsOf(card), /&quot;statusCode&quot;/);
        const readable = String(w.P.cardMarkup({ ...ITEM, status: 'failed', render: null, error: 'Remotion ran out of memory' }));
        assert.equal(sentenceOf(readable), 'Remotion ran out of memory', 'a readable one stays as it was');
    });

    it('a refused request is drawn from the error: the code’s sentence, the extra problem lines kept', () => {
        const w = dialog();
        const said = 'The caption doesn\'t mention «KAG».';
        const box = String(w.P.errorMarkup(Object.assign(new Error(said), { code: 'CAPTION_MISSING_COLUMNS', params: { columns: ['KAG'], list: '«KAG»' }, body: { problems: ['another problem'] } })));
        assert.equal(sentenceOf(box), w.h.t('errors.CAPTION_MISSING_COLUMNS', { list: '⁨«KAG»⁩' }));
        assert.match(box, /<ul class="ig-problems">[\s\S]*another problem/);
    });

    it('a failed copy or retry toasts the sentence and its next step', async () => {
        const w = dialog();
        w.api.copyInfographic = async () => { throw Object.assign(new Error('x'), { code: 'INFOGRAPHIC_NOT_WRITTEN' }); };
        await act(w, 'copy', { dataset: { id: 'i1', theme: 'light' }, disabled: false, getAttribute: () => null, innerHTML: '', textContent: '', style: {}, setAttribute() {} });
        await settle();
        assert.equal(w.toasts.at(-1)!.type, 'error');
        assert.equal(w.toasts.at(-1)!.message, `${w.h.t('errors.INFOGRAPHIC_NOT_WRITTEN')} ${w.h.t('errors.INFOGRAPHIC_NOT_WRITTEN.next')}`);
    });
});

// ─── The Studio page (T054) ─────────────────────────────────────────────────────────────────────────

function studio(lang: 'ar' | 'en' = 'en'): { h: Dashboard; P: Json } {
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/studio.js'], globals: { App: { currentPage: 'studio', canOperate: () => true } } });
    return { h, P: h.run<Json>('StudioPage') };
}

describe('Studio: failures are sentences, with the raw text behind Details (T054)', () => {
    it('failureEntry: a technical stored failure is the coded sentence; a readable one keeps its wrapper', () => {
        const { h, P } = studio();
        const technical = P.failureEntry('studio.new.failed', LIVE_413);
        assert.equal(technical.code, 'STORAGE_FILE_TOO_LARGE');
        const readable = P.failureEntry('studio.new.failed', 'Gemini quota exceeded');
        assert.equal(readable.message, h.t('studio.new.failed', { message: 'Gemini quota exceeded' }));
        assert.equal(readable.code, undefined);
        assert.equal(P.failureEntry('studio.new.failed', '').message, h.t('studio.new.failed', { message: h.t('error.unexpected') }));
    });

    it('a carousel that was saved failed shows a sentence in the new-carousel strip, not the JSON', () => {
        const { h, P } = studio();
        const entry = P.failureEntry('studio.new.failed', TECHNICAL);
        P.newError = { err: entry, message: h.UI.errorText(entry).sentence };
        const strip = String(P.newErrorMarkup());
        assert.equal(sentenceOf(strip), h.t('errors.STUDIO_STEP_FAILED'));
        assert.match(detailsOf(strip), /The model is overloaded/);
    });

    it('a refused request in the new-carousel strip: the code is the sentence, the extra problem lines stay, the repeated one goes', () => {
        const { h, P } = studio();
        const said = 'scheduled_time: another reel is already on 2026-10-20.';
        const err = Object.assign(new Error(said), { status: 409, code: 'REEL_DAY_TAKEN', params: { day: '2026-10-20' }, body: { problems: [said, 'a second problem'] } });
        assert.deepEqual([...P.extraProblems(err)], ['a second problem'], 'the line the sentence already says is not said twice');
        const uncoded = Object.assign(new Error('x'), { body: { problems: ['a', 'b'] } });
        assert.deepEqual([...P.extraProblems(uncoded)], ['a', 'b'], 'an uncoded refusal keeps every line');
        P.newError = { err, message: h.UI.errorText(err).sentence, problems: P.extraProblems(err) };
        const strip = String(P.newErrorMarkup());
        assert.equal(sentenceOf(strip), h.t('errors.REEL_DAY_TAKEN', { day: '⁨2026-10-20⁩' }));
        assert.match(strip, /a second problem/);
        assert.match(detailsOf(strip), /another reel is already on/);
    });

    it('a lesson that failed to index: the sentence, and the JSON behind Details', () => {
        const { h, P } = studio();
        const modal = String(P.lessonDetailMarkup({ lesson: { id: 'l1', status: 'failed', error: LIVE_413, title: 'T' }, moments: [] }));
        assert.ok(modal.includes(h.t('errors.STORAGE_FILE_TOO_LARGE')));
        assert.match(modal, /<details class="error-details">/);
        assert.doesNotMatch(modal.replace(/<details[\s\S]*?<\/details>/g, ''), /statusCode/, 'the JSON is only inside the disclosure');
    });

    it('the status bar says a coded failure in words, with its next step', () => {
        const { h, P } = studio();
        P.statusError = Object.assign(new Error('Failed to read the Studio status.'), { status: 500, code: 'NEEDS_AI_PROVIDER' });
        const bar = String(P.statusMarkup());
        assert.ok(bar.includes(h.t('errors.NEEDS_AI_PROVIDER')), bar);
        assert.ok(bar.includes(h.t('errors.NEEDS_AI_PROVIDER.next')));
    });

    it('a regenerate that failed shows the sentence from its error, in the editor', () => {
        const { h, P } = studio();
        const entry = P.failureEntry('studio.new.failed', LIVE_413);
        P.draft = { id: 'd1' };
        P.regen = { state: 'failed', draftId: 'd1', message: h.UI.errorText(entry).sentence, err: entry };
        P.regenHere = () => true;
        const strip = String(P.regenHostMarkup());
        assert.equal(sentenceOf(strip), h.t('errors.STORAGE_FILE_TOO_LARGE'));
        assert.match(detailsOf(strip), /&quot;statusCode&quot;/);
    });

    it('the error host (a page that failed to load) gets the sentence and next step as its message and hint', () => {
        const { h, P } = studio();
        const host = String(P.errorHost(Object.assign(new Error('Failed to list.'), { status: 409, code: 'NEEDS_AI_PROVIDER' }), 'Title', 'retry'));
        const options = JSON.parse(/data-error-options="([^"]*)"/.exec(host)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        assert.equal(options.message, h.t('errors.NEEDS_AI_PROVIDER'));
        assert.equal(options.hint, h.t('errors.NEEDS_AI_PROVIDER.next'));
    });
});

// ─── The ratchet ────────────────────────────────────────────────────────────────────────────────────

describe('no Studio page prints a server message as the sentence (T054 ratchet)', () => {
    const FILES = ['dashboard/js/pages/monteur.js', 'dashboard/js/pages/studio.js', 'dashboard/js/pages/infographics.js', 'dashboard/js/pages/explainers.js'];
    /** Source with comments removed, so a rule explained in a comment is not mistaken for code. */
    const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const file of FILES) {
        it(`${file}: no errorStrip or toast is given err.message / e.message`, () => {
            const src = code(file);
            const offenders = [
                ...src.matchAll(/UI\.errorStrip\(\s*\(?\s*(?:err|e|error|failure)\b[^)]*\.message/g),
                ...src.matchAll(/UI\.toast\(\s*\(?\s*(?:err|e|error|failure)\b[^;]*?\.message/g),
                ...src.matchAll(/UI\.toast\(\s*\(?\s*\w+\s*&&\s*\w+\.message/g),
            ].map((m) => m[0]);
            assert.deepEqual(offenders, [], `${file} still prints a message as the sentence`);
        });
    }

    it('every failure the pages draw goes through the shared primitives', () => {
        for (const file of FILES) {
            const src = code(file);
            assert.ok(/UI\.(errorBox|errorHtml|errorLine|errorText)\(/.test(src), `${file} uses them`);
        }
    });
});
