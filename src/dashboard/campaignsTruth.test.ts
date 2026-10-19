/**
 * Campaigns tells the truth (UX US1: T044, T055, T056; audit CA-03, CA-07, CA-08).
 *
 * The REAL `dashboard/js/pages/campaigns.js` in the shared `node:vm` harness (`_harness.ts`), in both languages:
 *
 *   - **the card's mode chip and risk (T055).** A whole-word campaign wears no short-keyword warning, because the warning is false for
 *     it; a substring one still does. The chip says which mode it is, in both languages, as a glyph and a word.
 *   - **the card's outcome split (T044).** Red belongs to the actionable count alone, and only while it is above zero. Without a split
 *     from the server the card shows what it always showed.
 *   - **the editor's collision check (T056).** It asks `POST /campaigns/try` (stubbed here), once per distinct keyword, with the draft;
 *     the old client `campaignCollisions` is gone. It says "«X» answers instead; this campaign never fires on those comments" with the
 *     two actions; and it never says "safe" before every keyword has been answered, or when one could not be.
 *
 * No network and no real DOM: `API` is a stub, the editor is a handful of `FakeEl`s. Layout and focus are verified live.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, settle, type Json } from './_harness.js';

/** An object built inside the vm context, as one of this realm's: `deepEqual` compares prototypes, and the two realms' differ. */
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function loadCampaigns(lang: 'ar' | 'en', api: Json = {}) {
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/campaigns.js'],
        globals: { API: { token: 't', ...api }, App: { canOperate: () => true } },
    });
    const page: Json = h.run('CampaignsPage');
    return { h, page, t: h.t };
}

const CAMPAIGN = { id: 'c-1', trigger_keyword: 'تم', dm_template: 'x', is_active: true, sent_count: 3, failed_count: 0, total_interactions: 3 };

// ─── The card: mode chip and risk (T055) ─────────────────────────────────────────────────────

describe('the campaign card: the match mode is said, and the warning honours it (CA-08)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`a substring campaign says «${lang === 'ar' ? 'أي موضع' : 'Anywhere'}» and still warns about a keyword that is too short (${lang})`, () => {
            const { page, t } = loadCampaigns(lang);
            const card = String(page.renderCard({ ...CAMPAIGN, match_mode: 'substring' }));
            assert.match(card, /data-match-mode="substring"/);
            assert.ok(text(card).includes(t('campaigns.mode.substring')));
            assert.ok(card.includes('chip-danger'), 'the short keyword is flagged in substring mode');
            assert.ok(card.includes('alert-triangle'));
            assert.ok(card.includes('text-warning'), 'and the paragraph that says why');
        });

        it(`a whole-word campaign says «${lang === 'ar' ? 'كلمة كاملة' : 'Whole word'}» and carries no short-keyword warning at all (${lang})`, () => {
            const { h, page, t } = loadCampaigns(lang);
            const card = String(page.renderCard({ ...CAMPAIGN, match_mode: 'word' }));
            assert.match(card, /data-match-mode="word"/);
            assert.ok(text(card).includes(t('campaigns.mode.word')));
            assert.equal(card.includes('chip-danger'), false, 'no red keyword chip');
            assert.equal(card.includes('alert-triangle'), false, 'no warning glyph');
            assert.equal(card.includes('text-warning'), false, 'no warning paragraph');
            assert.equal(card.includes(t('campaigns.match.riskGeneric', { keyword: 'تم', length: h.UI.formatNumber(2) })), false,
                'the "very short" sentence is not on a whole-word card');
        });

        it(`a row with no match_mode is substring, which is how the server reads it (${lang})`, () => {
            const { page } = loadCampaigns(lang);
            for (const row of [{ ...CAMPAIGN }, { ...CAMPAIGN, match_mode: null }, { ...CAMPAIGN, match_mode: 'exact' }]) {
                assert.match(String(page.renderCard(row)), /data-match-mode="substring"/);
            }
        });

        it(`the chip is a glyph and a word, named for assistive technology, and no raw key reaches the screen (${lang})`, () => {
            const { page, t } = loadCampaigns(lang);
            const card = String(page.renderCard({ ...CAMPAIGN, match_mode: 'word' }));
            assert.match(card, /data-lucide="target"/);
            assert.ok(card.includes(`${t('campaigns.matchMode')}: `), 'the chip is introduced by "Match mode" for a screen reader');
            assert.equal(/campaigns\.(mode|stat)\./.test(text(card)), false);
        });
    }

    it('keywordRisk(…, "word") is never risky, whatever the keyword; substring still is', () => {
        const { page } = loadCampaigns('en');
        for (const keyword of ['تم', 'ai', 'دورة']) {
            assert.equal(page.keywordRisk(keyword, 'word').risky, false, keyword);
        }
        assert.equal(page.keywordRisk('تم', 'substring').risky, true);
        assert.equal(page.keywordRisk('تم').risky, true, 'no mode is substring, the default');
    });

    it('the chip sits outside the keyword list, so the card\'s accessible name stays its keywords', () => {
        const { page } = loadCampaigns('en');
        const card = String(page.renderCard({ ...CAMPAIGN, match_mode: 'word' }));
        const list = /<div class="keyword-list"[^>]*>([\s\S]*?)<\/div>/.exec(card);
        assert.ok(list, 'the keyword list is there');
        assert.equal(list![1]!.includes('data-match-mode'), false);
    });
});

// ─── The card: the outcome split (T044) ──────────────────────────────────────────────────────

describe('the campaign card: the outcome split, with red only for what the owner can fix (CA-03)', () => {
    const split = (all: Json) => ({ ...CAMPAIGN, id: 'c-9', sent_count: 12, failed_count: 5, total_interactions: 17, counts: { all } });

    for (const lang of ['ar', 'en'] as const) {
        it(`delivered, handled by design and failed are three counts, and only the failed one can be red (${lang})`, () => {
            const { h, page, t } = loadCampaigns(lang);
            const n = (v: number) => h.UI.formatNumber(v);
            const card = String(page.renderCard(split({ delivered: 12, by_design: 4, actionable: 1, pending: 0 })));
            const said = text(card);
            assert.ok(said.includes(text(t('campaigns.stat.delivered', { count: n(12) }))), said);
            assert.ok(said.includes(text(t('campaigns.stat.byDesign', { count: n(4) }))), said);
            assert.ok(said.includes(text(t('campaigns.statFailed', { count: n(1) }))), said);
            // by-design: a neutral dot, never the red one.
            const byDesign = /<span class="campaign-stat text-muted" title="[^"]*">\s*<span class="dot neutral"/.exec(card);
            assert.ok(byDesign, 'handled-by-design is neutral');
            assert.equal((card.match(/class="dot bad"/g) || []).length, 1, 'exactly one red dot: the actionable failure');
            // …and what became of the old number: 5 FAILED rows are not "5 failed" any more.
            assert.equal(said.includes(text(t('campaigns.statFailed', { count: n(5) }))), false);
        });
    }

    it('with nothing actionable there is NO red at all, however much was handled by design', () => {
        const { page } = loadCampaigns('en');
        const card = String(page.renderCard(split({ delivered: 3, by_design: 9, actionable: 0, pending: 0 })));
        assert.equal(card.includes('dot bad'), false);
        assert.equal(card.includes('status=FAILED'), false, 'no link to an empty list');
        assert.ok(card.includes('dot neutral'));
    });

    it('a failed count above zero opens exactly this campaign\'s failures in the log', () => {
        const { page, t } = loadCampaigns('en');
        const card = String(page.renderCard(split({ delivered: 3, by_design: 0, actionable: 2, pending: 0 })));
        assert.ok(card.includes('data-action="app:navigate" data-target="activity"'));
        assert.ok(card.includes('data-query="campaign=c-9&amp;status=FAILED"'));
        assert.ok(card.includes(t('campaigns.openFailed')));
    });

    it('by-design and waiting counts appear only when there is something to say', () => {
        const { page, t } = loadCampaigns('en');
        const quiet = text(page.renderCard(split({ delivered: 3, by_design: 0, actionable: 0, pending: 0 })));
        assert.equal(quiet.includes('handled by design'), false);
        assert.equal(quiet.includes('waiting to send'), false);
        const busy = text(page.renderCard(split({ delivered: 3, by_design: 0, actionable: 0, pending: 2 })));
        assert.ok(busy.includes(text(t('campaigns.stat.pending', { count: '2' }))));
    });

    it('accepts the flat shape (`counts.delivered`) as well as `counts.all`', () => {
        const { page } = loadCampaigns('en');
        const flat = { ...CAMPAIGN, counts: { delivered: 7, by_design: 1, actionable: 0, pending: 0 } };
        assert.deepEqual(plain(page.outcomeSplit(flat)), { delivered: 7, byDesign: 1, actionable: 0, pending: 0 });
        assert.deepEqual(plain(page.outcomeSplit({ ...CAMPAIGN, counts: { all: { delivered: 7, by_design: 1, actionable: 0 } } })),
            { delivered: 7, byDesign: 1, actionable: 0, pending: 0 }, 'a missing pending is 0: it is only shown above zero');
    });

    it('falls back to sent / failed when the split is absent or unusable, and says nothing is "handled by design"', () => {
        const { page, t } = loadCampaigns('en');
        for (const counts of [undefined, null, {}, { all: {} }, { all: { delivered: 3 } }, { delivered: 'x', by_design: 1, actionable: 0 }, 'nope']) {
            const row = { ...CAMPAIGN, sent_count: 8, failed_count: 2, total_interactions: 10, counts };
            assert.equal(page.outcomeSplit(row), null, JSON.stringify(counts));
            const markup = String(page.renderCard(row));
            const card = text(markup);
            assert.ok(card.includes(text(t('campaigns.statSent', { count: '8' }))));
            assert.ok(card.includes(text(t('campaigns.statFailed', { count: '2' }))));
            assert.equal(markup.includes('data-outcomes="split"'), false);
            assert.equal(card.includes('handled by design'), false);
        }
    });

    it('a zero failed count is never a red dot, with the split or without it', () => {
        const { page } = loadCampaigns('en');
        assert.equal(String(page.renderCard({ ...CAMPAIGN, failed_count: 0 })).includes('dot bad'), false);
        assert.equal(String(page.renderCard({ ...CAMPAIGN, failed_count: 3 })).includes('dot bad'), true, 'a real failure still is');
    });

    it('a number the server did not send is not a count of zero', () => {
        const { page } = loadCampaigns('en');
        assert.equal(page.outcomeSplit({ ...CAMPAIGN, counts: { all: { delivered: null, by_design: 0, actionable: 0 } } }), null);
        assert.equal(page.outcomeSplit({ ...CAMPAIGN, counts: { all: { delivered: '', by_design: 0, actionable: 0 } } }), null);
    });
});

// ─── The editor: collisions from the server's rule (T056) ────────────────────────────────────

/** An editor on screen: the form, its three fields, and the inspector's two elements, as `FakeEl`s the page can find. */
function openEditor(h: Json, fields: { keywords: string; mode?: 'word' | 'substring'; post?: string; id?: string | null }) {
    const form = new FakeEl('campaign-form', 'form');
    form.dataset = fields.id === null ? {} : { id: fields.id ?? 'c-self' };
    const trigger: Json = { value: fields.keywords, form };
    const mode: Json = { value: fields.mode ?? 'substring', form, focusCalls: [], focus() { this.focusCalls.push(1); } };
    const post: Json = { value: fields.post ?? '', form };
    const byId: Record<string, Json> = { '#campaign-trigger': trigger, '#campaign-match-mode': mode, '#campaign-post-id': post };
    (form as Json).querySelector = (selector: string) => byId[selector] ?? null;
    h.dom.set('campaign-form', form);
    h.dom.set('campaign-match-mode', mode as unknown as FakeEl);
    const host = h.el('match-inspector');
    const verdict = h.el('match-inspector-verdict');
    return { form, trigger, mode, post, host, verdict };
}

/** An answer of `POST /campaigns/try`. */
const answers = {
    shadowed: (id = 'c-other', keywords = ['دورة', 'الدورة']) => ({ normalized: 'x', winner: { id, keywords, matched: keywords[0], matchMode: 'substring', reason: 'longer_list' }, draftMatches: false, draftMissReason: 'shadowed', nearMisses: [] }),
    alone: () => ({ normalized: 'x', winner: { id: 'draft', keywords: ['k'], matched: 'k', matchMode: 'substring', reason: 'only_match' }, draftMatches: true, nearMisses: [] }),
    first: () => ({ normalized: 'x', winner: { id: 'draft', keywords: ['k'], matched: 'k', matchMode: 'substring', reason: 'longer_list' }, draftMatches: true, nearMisses: [] }),
};

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('the editor asks the server which campaign answers (CA-07)', () => {
    it('is not the client\'s own rule any more: campaignCollisions is gone from the page and from the file', () => {
        const { page } = loadCampaigns('en');
        assert.equal(page.campaignCollisions, undefined);
        assert.equal(readFileSync('dashboard/js/pages/campaigns.js', 'utf8').includes('campaignCollisions'), false);
        assert.equal(readFileSync('dashboard/js/i18n.en.js', 'utf8').includes("'campaigns.match.collision'"), false, 'the "could trigger both" sentence is gone');
        assert.equal(readFileSync('dashboard/js/i18n.ar.js', 'utf8').includes("'campaigns.match.collision'"), false);
    });

    it('sends one request per distinct keyword, the keyword as the comment, with the draft the editor holds', async () => {
        const calls: Json[] = [];
        const { h, page } = loadCampaigns('en', { tryCampaign: async (body: Json) => { calls.push(body); return answers.alone(); } });
        const ed = openEditor(h, { keywords: 'دورة، بايثون، دورة', mode: 'word', post: '1784', id: 'c-self' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.deepEqual(calls.map((c) => c.comment), ['دورة', 'بايثون'], 'a repeated keyword is asked once; the duplicate row reports the repeat');
        for (const c of calls) {
            assert.deepEqual(plain(c.draft), { id: 'c-self', trigger_keyword: 'دورة، بايثون، دورة', match_mode: 'word', post_id: '1784', is_active: true });
            assert.equal(c.postId, '1784', 'the comment is on the post the draft is tied to');
        }
    });

    it('a new campaign has no id to replace, and no post means "any post"', async () => {
        const calls: Json[] = [];
        const { h, page } = loadCampaigns('en', { tryCampaign: async (body: Json) => { calls.push(body); return answers.alone(); } });
        const ed = openEditor(h, { keywords: 'بايثون', id: null });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.equal(calls[0]!.draft.id, null);
        assert.equal(calls[0]!.draft.post_id, null);
        assert.equal(calls[0]!.postId, null);
        assert.equal(calls[0]!.draft.match_mode, 'substring');
    });

    for (const lang of ['ar', 'en'] as const) {
        it(`says "«X» answers instead; this campaign never fires on those comments", with both actions (${lang})`, async () => {
            const { h, page, t } = loadCampaigns(lang, { tryCampaign: async () => answers.shadowed('c-other', ['دورة', 'الدورة']) });
            page.campaigns = [{ id: 'c-other', trigger_keyword: 'دورة، الدورة', dm_template: 'x' }];
            const ed = openEditor(h, { keywords: 'دورة' });
            page.queueCollisionCheck(ed.form, { now: true });
            await settle();
            const verdict = ed.verdict.innerHTML;
            assert.ok(verdict.includes(t('campaigns.try.shadowed', { keyword: '⁨دورة⁩', other: '⁨دورة، الدورة⁩' })), verdict);
            assert.match(verdict, /data-collision="shadowed"/);
            assert.match(verdict, /data-action="campaigns:useWholeWord"/);
            assert.ok(text(verdict).includes(t('campaigns.try.useWord')));
            assert.match(verdict, /data-action="campaigns:editOther"[^>]*data-id="c-other"|data-id="c-other"[^>]*data-action="campaigns:editOther"/);
            assert.ok(text(verdict).includes(t('campaigns.try.editOther')));
            assert.equal(ed.host.className.includes('is-risky'), true);
            assert.equal(verdict.includes(t('campaigns.match.safe')), false, 'a collision is never also "safe"');
            assert.equal(/campaigns\.try\./.test(text(verdict)), false, 'no raw key');
        });
    }

    it('the English sentence is the one the spec asks for', async () => {
        const { h, page } = loadCampaigns('en', { tryCampaign: async () => answers.shadowed('c-other', ['دورة', 'الدورة']) });
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'دورة، الدورة', dm_template: 'x' }];
        const ed = openEditor(h, { keywords: 'دورة' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.match(text(ed.verdict.innerHTML), /answers instead; this campaign never fires on those comments/);
    });

    it('offers whole-word mode only where it is not already the mode', async () => {
        const { h, page } = loadCampaigns('en', { tryCampaign: async () => answers.shadowed() });
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'دورة', dm_template: 'x' }];
        const ed = openEditor(h, { keywords: 'دورة', mode: 'word' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.equal(ed.verdict.innerHTML.includes('campaigns:useWholeWord'), false);
        assert.ok(ed.verdict.innerHTML.includes('campaigns:editOther'));
    });

    it('offers "Edit the other campaign" only for a campaign this page knows', async () => {
        const { h, page } = loadCampaigns('en', { tryCampaign: async () => answers.shadowed('c-unknown') });
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'x', dm_template: 'x' }];
        const ed = openEditor(h, { keywords: 'دورة' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(ed.verdict.innerHTML.includes('data-collision="shadowed"'));
        assert.equal(ed.verdict.innerHTML.includes('campaigns:editOther'), false);
    });

    it('when this campaign answers and another also matches, it says the other never fires: and offers nothing it cannot back', async () => {
        const { h, page, t } = loadCampaigns('en', { tryCampaign: async () => answers.first() });
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.try.first', { keyword: '⁨بايثون⁩' })));
        assert.match(ed.verdict.innerHTML, /data-collision="first"/);
        assert.equal(ed.verdict.innerHTML.includes('campaigns:'), false, 'no action: which campaign is not known');
        assert.equal(ed.host.className.includes('is-risky'), true);
    });

    it('a keyword nobody else matches is "safe", but only once it has been asked', async () => {
        const gate = deferred<Json>();
        const { h, page, t } = loadCampaigns('en', { tryCampaign: () => gate.promise });
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        page.inspect('بايثون', 'substring');
        assert.equal(ed.verdict.innerHTML.includes(t('campaigns.match.safe')), false, 'asked, not answered: not safe');
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.try.checking')), 'it says it is checking');
        assert.equal(ed.host.className.includes('is-safe'), false);
        gate.resolve(answers.alone());
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.match.safe')));
        assert.equal(ed.verdict.innerHTML.includes(t('campaigns.try.checking')), false);
        assert.equal(ed.host.className.includes('is-safe'), true);
    });

    it('with an editor that has asked nothing yet, the inspector says "checking", never "safe"', () => {
        const { page, t } = loadCampaigns('en');
        const out = text(page.matchVerdict('بايثون', 'substring').verdict);
        assert.ok(out.includes(t('campaigns.try.checking')));
        assert.equal(out.includes(t('campaigns.match.safe')), false);
    });

    it('a check that could not run is said, with Retry: never "safe", and the answers that did arrive still show', async () => {
        let attempt = 0;
        const { h, page, t } = loadCampaigns('en', {
            tryCampaign: async (body: Json) => {
                attempt++;
                if (attempt <= 2 && body.comment === 'بايثون') throw new Error('offline');
                return body.comment === 'دورة' ? answers.shadowed() : answers.alone();
            },
        });
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'دورة', dm_template: 'x' }];
        const ed = openEditor(h, { keywords: 'دورة، بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.try.failed')));
        assert.match(ed.verdict.innerHTML, /data-action="campaigns:retryCollisions"/);
        assert.equal(ed.verdict.innerHTML.includes(t('campaigns.match.safe')), false);
        assert.match(ed.verdict.innerHTML, /data-collision="shadowed"/, 'the keyword that was answered is still reported');
    });

    it('Retry asks again, and a second answer in full replaces the failure', async () => {
        let attempt = 0;
        const { h, page, t } = loadCampaigns('en', { tryCampaign: async () => { attempt++; if (attempt === 1) throw new Error('offline'); return answers.alone(); } });
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.try.failed')));
        assert.equal(ed.verdict.innerHTML.includes(t('campaigns.match.safe')), false, 'nothing was found, and nothing could be checked: that is not "safe"');
        assert.equal(ed.host.className.includes('is-safe'), false);
        page.retryCollisions({ closest: () => ed.form });
        await settle();
        assert.equal(attempt, 2);
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.match.safe')));
        assert.equal(ed.verdict.innerHTML.includes(t('campaigns.try.failed')), false);
    });

    it('an API that is not even there is a failed check, not an unhandled rejection', async () => {
        const { h, page, t } = loadCampaigns('en', {});
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.try.failed')));
    });

    it('an answer for an older draft is dropped: only the newest check may speak', async () => {
        const first = deferred<Json>();
        const second = deferred<Json>();
        const queue = [first, second];
        const { h, page, t } = loadCampaigns('en', { tryCampaign: () => queue.shift()!.promise });
        const ed = openEditor(h, { keywords: 'دورة' });
        page.queueCollisionCheck(ed.form, { now: true });
        ed.trigger.value = 'بايثون';
        page.queueCollisionCheck(ed.form, { now: true });
        second.resolve(answers.alone());
        await settle();
        first.resolve(answers.shadowed());
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.match.safe')), 'the late answer about «دورة» did not overwrite the one about «بايثون»');
        assert.equal(ed.verdict.innerHTML.includes('data-collision'), false);
    });

    it('an answer is only believed for the keywords and mode it was about', async () => {
        const { h, page, t } = loadCampaigns('en', { tryCampaign: async () => answers.alone() });
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(text(page.matchVerdict('بايثون', 'substring').verdict).includes(t('campaigns.match.safe')));
        const other = text(page.matchVerdict('بايثون، دورة', 'substring').verdict);
        assert.equal(other.includes(t('campaigns.match.safe')), false, 'a different list is not covered by the old answer');
        const modeChanged = text(page.matchVerdict('بايثون', 'word').verdict);
        assert.equal(modeChanged.includes(t('campaigns.match.safe')), false, 'nor is a different mode');
    });

    it('more keywords than one check asks about are said not to have been checked, and are not "safe"', async () => {
        const { h, page, t } = loadCampaigns('en', { tryCampaign: async () => answers.alone() });
        page.COLLISION_MAX_KEYWORDS = 2;
        const ed = openEditor(h, { keywords: 'بايثون، دورة، جولانج' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.try.partial', { count: '2' })));
        assert.equal(ed.verdict.innerHTML.includes(t('campaigns.match.safe')), false);
    });

    it('typing asks the server once, after the pause, and shows "checking" at once', async () => {
        const calls: Json[] = [];
        const { h, page, t } = loadCampaigns('en', { tryCampaign: async (body: Json) => { calls.push(body); return answers.alone(); } });
        page.COLLISION_DEBOUNCE_MS = 20;
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.inspectKeywords(ed.trigger);
        ed.trigger.value = 'بايثون، ك';
        page.inspectKeywords(ed.trigger);
        ed.trigger.value = 'بايثون، دورة';
        page.inspectKeywords(ed.trigger);
        assert.equal(calls.length, 0, 'nothing is sent while the owner types');
        await new Promise((resolve) => setTimeout(resolve, 80));
        await settle();
        assert.deepEqual(calls.map((c) => c.comment).sort(), ['بايثون', 'دورة'].sort(), 'one round, for the final text');
        page.inspect('بايثون، دورة', 'substring');
        assert.ok(ed.verdict.innerHTML.includes(t('campaigns.match.safe')));
    });

    it('an empty keyword field asks nothing and forgets the last answer', async () => {
        const calls: Json[] = [];
        const { h, page } = loadCampaigns('en', { tryCampaign: async (body: Json) => { calls.push(body); return answers.alone(); } });
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        ed.trigger.value = '  ، ';
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.equal(calls.length, 1);
        assert.equal(page._collide.state, 'idle');
    });

    it('changing the post the campaign is tied to asks again; a repaint with nothing changed does not', async () => {
        const calls: Json[] = [];
        const { h, page } = loadCampaigns('en', { tryCampaign: async (body: Json) => { calls.push(body); return answers.alone(); } });
        const ed = openEditor(h, { keywords: 'بايثون' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.equal(calls.length, 1, 'unchanged: no second request');
        ed.post.value = '1784';
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        assert.equal(calls.length, 2);
        assert.equal(calls[1]!.postId, '1784');
    });
});

describe('the two actions on a collision', () => {
    it('"Use whole-word mode" switches the mode, puts focus back on it, and asks again in that mode', async () => {
        const calls: Json[] = [];
        const { h, page } = loadCampaigns('en', { tryCampaign: async (body: Json) => { calls.push(body); return answers.alone(); } });
        page.COLLISION_DEBOUNCE_MS = 5;
        const ed = openEditor(h, { keywords: 'دورة' });
        page.queueCollisionCheck(ed.form, { now: true });
        await settle();
        page.useWholeWord({ closest: () => ed.form });
        assert.equal(ed.mode.value, 'word');
        assert.equal(ed.mode.focusCalls.length, 1);
        await new Promise((resolve) => setTimeout(resolve, 40));
        await settle();
        assert.equal(calls.length, 2);
        assert.equal(calls[1]!.draft.match_mode, 'word');
    });

    it('"Edit the other campaign" opens it straight away when nothing here is unsaved', () => {
        const { h, page } = loadCampaigns('en');
        const opened: string[] = [];
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'x', dm_template: 'x' }];
        page.showEditModal = (id: string) => { opened.push(id); };
        h.UI.isModalDirty = () => false;
        let asked = 0;
        h.UI.confirm = () => { asked++; };
        page.editOther('c-other');
        assert.deepEqual(opened, ['c-other']);
        assert.equal(asked, 0);
    });

    it('…and asks first, over the editor, when there are unsaved edits: Keep editing leaves them alone, Discard goes on', () => {
        const { h, page } = loadCampaigns('en');
        const opened: string[] = [];
        let closed = 0;
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'x', dm_template: 'x' }];
        page.showEditModal = (id: string) => { opened.push(id); };
        h.UI.isModalDirty = () => true;
        h.UI.closeModal = () => { closed++; };
        let question: Json | null = null;
        h.UI.confirm = (options: Json) => { question = options; };
        page.editOther('c-other');
        assert.deepEqual(opened, [], 'nothing is lost before the owner says so');
        assert.ok(question, 'the owner is asked');
        assert.equal(question!.stack, true, 'over the editor, not in place of it');
        assert.equal(question!.title, h.t('ui.discard.title'));
        question!.onConfirm();
        assert.deepEqual(opened, ['c-other']);
        assert.equal(closed, 1);
    });

    it('an unknown campaign id opens nothing', () => {
        const { h, page } = loadCampaigns('en');
        const opened: string[] = [];
        page.campaigns = [];
        page.showEditModal = (id: string) => { opened.push(id); };
        h.UI.isModalDirty = () => false;
        page.editOther('ghost');
        assert.deepEqual(opened, []);
    });

    it('the buttons\' action names are registered, and "Edit the other campaign" reads the id off the button', () => {
        const { h, page } = loadCampaigns('en');
        const registered = Object.keys(h.run('UI._actions.campaigns') as Json);
        for (const name of ['useWholeWord', 'editOther', 'retryCollisions', 'draftChange']) assert.ok(registered.includes(name), name);
        const opened: string[] = [];
        page.campaigns = [{ id: 'c-other', trigger_keyword: 'x', dm_template: 'x' }];
        page.showEditModal = (id: string) => { opened.push(id); };
        h.UI.isModalDirty = () => false;
        (h.run('UI._actions.campaigns') as Json).editOther({ dataset: { id: 'c-other' } });
        assert.deepEqual(opened, ['c-other']);
    });
});

describe('the API client', () => {
    it('tryCampaign posts the body to /campaigns/try and nothing else', async () => {
        const seen: Array<{ path: string; method: string; body: string | undefined }> = [];
        const h = loadDashboard({
            globals: {
                fetch: (url: string, options: Json = {}) => {
                    seen.push({ path: String(url).replace(/^\/api/, ''), method: options.method || 'GET', body: options.body });
                    return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') });
                },
            },
            files: ['dashboard/js/api.js'],
        });
        // `loadDashboard` stubs API as a rejecting proxy before the files run; api.js then declares the real one.
        await h.run('API').tryCampaign({ comment: 'دورة', draft: { id: null, trigger_keyword: 'دورة', match_mode: 'word' } });
        assert.deepEqual(seen, [{ path: '/campaigns/try', method: 'POST', body: '{"comment":"دورة","draft":{"id":null,"trigger_keyword":"دورة","match_mode":"word"}}' }]);
    });
});
