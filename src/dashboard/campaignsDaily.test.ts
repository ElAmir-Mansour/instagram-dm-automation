/**
 * Keyword replies start as Whole word, and the editor offers the other form people type (UX U1, audit DW-K3).
 *
 * The REAL `dashboard/js/pages/campaigns.js` in the shared `node:vm` harness, both languages where the words are the claim.
 *
 *   - the CREATE editor opens on "Whole word only" and sends `match_mode: 'word'` explicitly (never leaves it to the server's default, which stays
 *     `substring` for API callers); a choice of "Anywhere" is sent as made; the EDIT editor shows each existing reply's own mode (no migration);
 *   - `otherForm` / `formSuggestions` are the ONE rule that is always right: «كورس» <-> «الكورس», offered only for a single Arabic word whose stem keeps
 *     3 letters, only in whole-word mode, never twice, and checked against `normalizeArabic` the way the matcher compares (`keywordMatches`).
 *     Plurals are never suggested: Arabic broken plurals follow no rule that is reliably right;
 *   - "Also add" appends the form to the keyword field, asks the inspector again, and puts focus back on the field.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keywordMatches, normalizeArabic } from '../utils/arabic.js';
import { loadDashboard, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function load(lang: 'ar' | 'en' = 'en') {
    const created: Json[] = [];
    const api: Json = { token: 't', createCampaign: async (body: Json) => { created.push(body); return { id: 'new' }; } };
    class FakeFormData {
        constructor(private readonly form: { fields: Record<string, string | null> }) {}
        get(name: string): string | null { return name in this.form.fields ? this.form.fields[name]! : null; }
    }
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/campaigns.js'], globals: { API: api, App: { canOperate: () => true }, FormData: FakeFormData } });
    const page: Json = h.run('CampaignsPage');
    const modals: string[] = [];
    h.UI.showModal = (markup: unknown) => { modals.push(String(markup)); };
    h.UI.closeModal = () => undefined;
    h.UI.toast = () => null;
    page.render = async () => undefined;
    page._busy = () => () => undefined;
    return { h, page, created, modals, t: h.t };
}

const fields = (over: Record<string, string | null> = {}): Json => ({
    fields: { trigger_keyword: 'كورس', match_mode: 'word', dm_template: 'hello', public_reply_template: '', post_id: '', ...over },
});
const event = { preventDefault: () => undefined };

describe('a new keyword reply starts as Whole word (DW-K3)', () => {
    it('the create editor opens with "Whole word only" selected', () => {
        const { page, modals } = load();
        page.showCreateModal();
        const markup = modals[0]!;
        assert.match(markup, /<option value="word"\s+selected/);
        assert.doesNotMatch(markup, /<option value="substring"\s+selected/);
        assert.match(markup, /Whole-word matching: the campaign fires only when/, 'and the explanation under it is the whole-word one');
    });

    it('sends match_mode "word" with a create, explicitly', async () => {
        const { page, created } = load();
        await page.handleCreate(fields(), event);
        assert.equal(created.length, 1);
        assert.equal(created[0]!.match_mode, 'word');
        await page.handleCreate(fields({ match_mode: null }), event);
        assert.equal(created[1]!.match_mode, 'word', 'a form that carries no mode still sends word, never nothing');
    });

    it('sends what was chosen when the owner picks "Anywhere in the comment"', async () => {
        const { page, created } = load();
        await page.handleCreate(fields({ match_mode: 'substring' }), event);
        assert.equal(created[0]!.match_mode, 'substring');
    });

    it('does not change what an existing reply has: the edit editor shows its own mode', () => {
        const { page, modals } = load();
        page.campaigns = [
            { id: 'a', trigger_keyword: 'كورس', dm_template: 'x', match_mode: 'substring' },
            { id: 'b', trigger_keyword: 'كورس', dm_template: 'x', match_mode: 'word' },
            { id: 'c', trigger_keyword: 'كورس', dm_template: 'x' },
        ];
        page.queueCollisionCheck = () => undefined;
        for (const id of ['a', 'b', 'c']) page.showEditModal(id);
        assert.match(modals[0]!, /<option value="substring"\s+selected/);
        assert.match(modals[1]!, /<option value="word"\s+selected/);
        assert.match(modals[2]!, /<option value="substring"\s+selected/, 'a row with no match_mode is substring, as the server reads it');
    });

    it('no longer calls "Anywhere" the default', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { t } = load(lang);
            assert.doesNotMatch(t('campaigns.matchMode.substring'), /default|الافتراضي/i);
        }
    });
});

describe('the other form of an Arabic keyword (DW-K3)', () => {
    const { page } = load();

    it('adds ال to a bare word and drops it from a word that has it', () => {
        assert.equal(page.otherForm('كورس'), 'الكورس');
        assert.equal(page.otherForm('الكورس'), 'كورس');
        assert.equal(page.otherForm('  كورس  '), 'الكورس');
        assert.equal(page.otherForm('اللغة'), 'لغة');
        assert.equal(page.otherForm('لغة'), 'اللغة');
        assert.equal(page.otherForm('الكتب'), 'كتب');
    });

    it('keeps the owner\'s own spelling (hamza, ة)', () => {
        assert.equal(page.otherForm('أدوات'), 'الأدوات');
        assert.equal(page.otherForm('الأدوات'), 'أدوات');
        assert.equal(page.otherForm('الدورة'), 'دورة');
    });

    it('offers nothing it cannot be sure of', () => {
        for (const keyword of ['', 'تم', 'الله', 'الف', 'python', 'C#', '2024', 'رابط الكورس', 'كورس python', 'ab', 'كورس1']) {
            assert.equal(page.otherForm(keyword), '', `"${keyword}"`);
        }
    });

    it('is never a plural: a broken plural has no rule that is always right', () => {
        assert.equal(page.otherForm('كتاب'), 'الكتاب');
        assert.equal(page.otherForm('كتب'), 'الكتب');
    });

    it('the suggestion is exactly what the matcher needs: in whole-word mode each form misses the other, and the pair together catches both', () => {
        for (const [bare, withAl] of [['كورس', 'الكورس'], ['أدوات', 'الأدوات'], ['دورة', 'الدورة']] as const) {
            const a = normalizeArabic(bare);
            const b = normalizeArabic(withAl);
            assert.equal(keywordMatches(normalizeArabic(`ارسل ${withAl} لي`), a, 'word'), false, `${bare} misses ${withAl}`);
            assert.equal(keywordMatches(normalizeArabic(`ارسل ${bare} لي`), b, 'word'), false, `${withAl} misses ${bare}`);
            assert.equal(keywordMatches(normalizeArabic(`ارسل ${withAl} لي`), b, 'word'), true);
            assert.equal(normalizeArabic(page.otherForm(bare)), b);
            assert.equal(normalizeArabic(page.otherForm(withAl)), a);
        }
    });

    it('is offered in whole-word mode only, never twice, and not when the list has it', () => {
        assert.deepEqual([...page.formSuggestions('كورس', 'substring')], []);
        assert.deepEqual([...page.formSuggestions('كورس', 'word')], ['الكورس']);
        assert.deepEqual([...page.formSuggestions('كورس, الكورس', 'word')], [], 'both forms are already listed');
        assert.deepEqual([...page.formSuggestions('كورس، دورة, python', 'word')], ['الكورس', 'الدورة']);
        assert.deepEqual([...page.formSuggestions('كورس, كورس', 'word')], ['الكورس'], 'a repeated keyword gives one button');
        assert.deepEqual([...page.formSuggestions('الكورس, كورس', 'word')], []);
        const many = ['كتاب', 'قلم', 'باب', 'نهر', 'جبل', 'بحر', 'سهل', 'وادي'].join(', ');
        assert.equal(page.formSuggestions(many, 'word').length, page.FORM_MAX_SUGGESTIONS);
    });
});

describe('the "Also add" buttons (DW-K3)', () => {
    it('are drawn in the inspector with the form to add, in both languages', () => {
        for (const [lang, label] of [['en', 'Also add:'], ['ar', 'أضف أيضاً:']] as const) {
            const { page } = load(lang);
            const { verdict } = page.matchVerdict('كورس', 'word');
            const markup = String(verdict);
            assert.match(markup, /data-action="campaigns:addKeywordForm"/);
            assert.match(markup, /data-form="الكورس"/);
            assert.ok(text(markup).includes(`${label} الكورس`), text(markup));
            assert.doesNotMatch(String(page.matchVerdict('كورس', 'substring').verdict), /addKeywordForm/);
            assert.doesNotMatch(String(page.matchVerdict('python', 'word').verdict), /addKeywordForm/);
        }
    });

    it('put the form in the keyword field, ask the inspector again, and give focus back to the field', () => {
        const { page } = load();
        const input: Json = { value: 'كورس', focused: 0, focus() { this.focused += 1; } };
        const form = { querySelector: (sel: string) => (sel === '#campaign-trigger' ? input : null) };
        const asked: unknown[] = [];
        page.inspectKeywords = (el: unknown) => { asked.push(el); };
        page.addKeywordForm({ closest: () => form, dataset: { form: 'الكورس' } });
        assert.equal(input.value, 'كورس, الكورس');
        assert.deepEqual(asked, [input]);
        assert.equal(input.focused, 1);
        input.value = 'كورس،  ';
        page.addKeywordForm({ closest: () => form, dataset: { form: 'الكورس' } });
        assert.equal(input.value, 'كورس, الكورس', 'a trailing comma is not doubled');
    });
});
