/**
 * The 30-day clean-up card (U2, Settings → Messages & alerts): what it shows, what it saves, and who is shown it.
 *
 * The real `settings.js` in the shared harness, in both languages, with `API` stubbed. The server half (the sweep, the route's validation and audit)
 * is `src/services/autoArchive.test.ts`; this pins the owner's side: the default is shown as ON at 30 days, a bad number is refused on the field
 * before anything is sent, a save sends exactly `{ enabled, days }`, and a failed read is a card that says so, not a missing one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) { this.fields = (form && form.fields) || {}; }
    get(name: string): unknown { return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null; }
}

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const SETTING = { enabled: true, days: 30, minDays: 7, maxDays: 365, defaultDays: 30 };

function load(lang: 'ar' | 'en' = 'en') {
    const saved: Json[] = [];
    const h = loadDashboard({
        lang, app: true,
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/settings.js'],
        globals: {
            FormData: FakeFormData,
            API: { token: 't', saveAutoArchive: (body: Json) => { saved.push(body); return Promise.resolve({ ...SETTING, ...body }); } },
        },
    });
    const S = h.run<Json>('SettingsPage');
    const toasts: Array<{ message: string; type: string }> = [];
    h.UI.toast = (message: string, type: string) => { toasts.push({ message, type }); return null; };
    h.UI.formBusy = () => () => {};
    let renders = 0;
    S.render = async () => { renders += 1; };
    const error = h.el('cleanup-error');
    h.el('cleanup-days', { min: '7', max: '365' } as Json);
    h.el('page-container');
    return { h, S, saved, toasts, error, renders: () => renders };
}

const form = (fields: Record<string, unknown>): Json => ({ fields, querySelectorAll: () => [], querySelector: () => null });
const submit = (r: ReturnType<typeof load>, fields: Record<string, unknown>) => r.S.saveAutoArchive(form(fields), { preventDefault() {} });

describe('the clean-up card', () => {
    it('shows the default as ON at 30 days, with the range and what it does to a post and a conversation', () => {
        const { S } = load();
        const markup = String(S.cleanupSection(SETTING, null));
        assert.match(markup, /id="cleanup-enabled" name="enabled" checked/);
        assert.match(markup, /id="cleanup-days"[^>]*min="7"[^>]*max="365"[^>]*value="30"/);
        const said = text(markup);
        assert.match(said, /Clear old items automatically/);
        assert.match(said, /Nothing is deleted/);
        assert.match(said, /A whole number from 7 to 365\. The default is 30\./);
    });

    it('shows an owner\'s choice: off at 60 days', () => {
        const { S } = load();
        const markup = String(S.cleanupSection({ ...SETTING, enabled: false, days: 60 }, null));
        assert.equal(/name="enabled" checked/.test(markup), false);
        assert.match(markup, /value="60"/);
    });

    it('a failed read is a card that says so, with Retry; nothing to show is no card', () => {
        const { S } = load();
        assert.match(text(S.cleanupSection(null, new Error('down'))), /Could not read the clean-up setting: down/);
        assert.equal(String(S.cleanupSection(null, null)), '');
    });

    it('is in both languages, in فصحى, with its own plural-free words', () => {
        const { S, h } = load('ar');
        const said = text(S.cleanupSection(SETTING, null));
        assert.match(said, /تنظيف العناصر القديمة تلقائيًا/);
        assert.match(said, /لا يُحذف أي شيء/);
        assert.ok(said.includes(h.t('settings.cleanup.daysHint', { min: '7', max: '365', def: '30' })));
    });

    it('saves exactly { enabled, days }, then redraws and says it is saved', async () => {
        const r = load();
        await submit(r, { enabled: 'on', days: '45' });
        assert.deepEqual(JSON.parse(JSON.stringify(r.saved)), [{ enabled: true, days: 45 }]);
        assert.equal(r.renders(), 1);
        assert.equal(r.toasts[0]!.message, 'Saved. The clean-up runs once a day.');
        await submit(r, { days: '30' });
        assert.deepEqual(JSON.parse(JSON.stringify(r.saved[1])), { enabled: false, days: 30 }, 'an unticked box is off');
    });

    it('refuses a number outside 7-365, or a fraction, on the field, and sends nothing', async () => {
        const r = load();
        for (const days of ['3', '400', '10.5', '', 'abc']) {
            await submit(r, { enabled: 'on', days });
            assert.match(r.error.innerHTML, /Enter a whole number of days from 7 to 365\./, days);
        }
        assert.deepEqual(r.saved, []);
    });
});
