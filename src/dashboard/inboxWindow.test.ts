/**
 * A closed reply window says so on every Instagram or Facebook thread (R1-I1), and the phone gives the conversation the screen (R1-I15).
 *
 * The REAL `inbox.js`, `attention.js` and `components.js` in a `node:vm` context through `_harness.ts`, API stubbed. What is pinned:
 *
 *   - the window is the SERVER's (`reply_window_ends_at`), so the composer never counts its own: a thread past it has the reply box and Send
 *     replaced by the notice, the way to answer instead, and "Open in Instagram" for an Instagram thread with a known handle only;
 *   - "Mark handled" stays on a thread that is still to do; a WhatsApp thread keeps its own window and gets none of this;
 *   - an open window shows its countdown on every thread, muted when nobody has to act;
 *   - a refusal the server (or Meta) gives for the window is a translated sentence and closes the thread on screen, never Meta's English;
 *   - at 860 px and below: three chips and "More about <name>", the short placeholder, and "Mark handled" beside the composer.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** A thread the AI is paused for and the customer wrote last, `age` ago. */
const waiting = (over: Json = {}, age = HOUR): Json => ({
    id: 'w', username: 'sara_dev', profile_name: 'Sara', instagram_user_id: '17841400003051', platform: 'instagram', is_bot_active: false,
    last_message_direction: 'inbound', last_message_at: ago(age), last_inbound_message_at: ago(age), ...over,
});
/** Answered by the assistant: nothing for a person to do. */
const quiet = (over: Json = {}, age = HOUR): Json => ({
    id: 'q', username: 'lina', instagram_user_id: '3', platform: 'instagram', is_bot_active: true,
    last_message_direction: 'outbound', last_message_at: ago(age), last_inbound_message_at: ago(age), ...over,
});

function load(opts: { lang?: 'ar' | 'en'; phone?: boolean; api?: Json } = {}) {
    const toasts: Array<{ message: string; kind: unknown }> = [];
    const App = { canOperate: () => true, setInboxWaiting: () => {}, hashParam: () => '', route: (page: string) => `#/${page}` };
    const api: Json = { token: 'tok', ...(opts.api ?? {}) };
    const h = loadDashboard({ lang: opts.lang ?? 'en', files: ['dashboard/js/pages/inbox.js'], globals: { API: api, App } });
    const Inbox = h.run('InboxPage');
    h.window.matchMedia = () => ({ matches: opts.phone === true, addEventListener: () => {}, removeEventListener: () => {} });
    h.UI.toast = (message: string, kind: unknown) => { toasts.push({ message: String(message), kind }); return null; };
    Inbox.loadMessages = () => Promise.resolve();
    return { h, Inbox, toasts, t: h.t };
}

describe('Inbox composer: a closed window replaces the box and Send, on every thread', () => {
    it('is the server\'s window, not a count of its own: an ad thread whose longer window is still open keeps its box', () => {
        const { Inbox } = load();
        const adThread = waiting({ last_inbound_message_at: ago(3 * DAY), reply_window_ends_at: ahead(2 * DAY) });
        assert.equal(String(Inbox.windowOfferMarkup(adThread)), '');
        assert.equal(Inbox.windowChip(adThread).text.includes('left to reply'), true);
        // And the reverse: the server says closed while the last message alone would say open.
        const lateThread = waiting({ reply_window_ends_at: ago(HOUR) });
        assert.ok(String(Inbox.windowOfferMarkup(lateThread)).includes('data-window-closed'));
    });

    it('falls back to the standard 24 hours from the last message for a list older than the field', () => {
        const { Attention } = load().h;
        assert.equal(Attention.replyClosed(waiting({}, 25 * HOUR)), true);
        assert.equal(Attention.replyClosed(waiting({}, 23 * HOUR)), false);
        assert.equal(Attention.replyClosed(waiting({ last_inbound_message_at: null, last_inbound_at: null })), false, 'never wrote: nothing to be past');
    });

    it('says what happened and how long ago, where to answer, and offers the Instagram app by its handle', () => {
        const { Inbox } = load();
        const markup = String(Inbox.windowOfferMarkup(waiting({}, 45 * DAY)));
        assert.ok(text(markup).includes('The reply window closed 44d ago, so a reply from here can’t reach them. Reply in the Instagram app.'), text(markup));
        assert.match(markup, /href="https:\/\/ig\.me\/m\/sara_dev"/);
        assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
        assert.ok(text(markup).includes('Open in Instagram'));
    });

    it('is in Arabic, with the Arabic words for the duration and the link', () => {
        const { Inbox } = load({ lang: 'ar' });
        const markup = text(String(Inbox.windowOfferMarkup(waiting({}, 45 * DAY))));
        assert.ok(markup.includes('أُغلقت مهلة الردّ منذ 44 يومًا، فلا يصل ردّ من هنا. ردّ من تطبيق إنستجرام.'), markup);
        assert.ok(markup.includes('افتح في إنستجرام'));
    });

    it('links only an Instagram thread with a known handle: not Facebook, not WhatsApp, not a missing or odd handle', () => {
        const { Inbox } = load();
        const link = (over: Json) => /ig\.me/.test(String(Inbox.openInstagramMarkup(waiting(over, 30 * HOUR))));
        assert.equal(link({}), true);
        assert.equal(link({ platform: null }), true, 'a thread from before platforms is an Instagram one');
        assert.equal(link({ platform: 'facebook' }), false);
        assert.equal(link({ platform: 'whatsapp' }), false);
        assert.equal(link({ username: null }), false, 'the numeric id is not a username');
        assert.equal(link({ username: '' }), false);
        assert.equal(link({ username: 'a/../b' }), false);
        assert.equal(link({ username: '"><script>' }), false);
        assert.equal(link({ username: '@sara_dev' }), true, 'a leading @ is not part of the handle');
        assert.ok(String(Inbox.windowOfferMarkup(waiting({ platform: 'facebook' }, 30 * HOUR))).includes('Page inbox on Facebook'));
    });

    it('keeps "Mark handled" on a thread that is to do, and never on one that is not, or for a viewer', () => {
        const { Inbox, h } = load();
        const todo = waiting({}, 30 * HOUR);
        const other = quiet({}, 30 * HOUR);
        assert.match(String(Inbox.windowOfferMarkup(todo)), /data-action="inbox:markHandled"/);
        assert.doesNotMatch(String(Inbox.windowOfferMarkup(other)), /markHandled/);
        assert.ok(String(Inbox.windowOfferMarkup(other)).includes('data-window-closed'), 'the notice is still there');
        h.run('App').canOperate = () => false;
        assert.doesNotMatch(String(Inbox.windowOfferMarkup(todo)), /markHandled/);
    });

    it('gives a WhatsApp thread nothing of this: its window is its own, and the server answers it', () => {
        const { Inbox, h } = load();
        const wa = waiting({ platform: 'whatsapp' }, 30 * HOUR);
        assert.equal(String(Inbox.windowOfferMarkup(wa)), '');
        assert.equal(h.Attention.replyClosed(wa), false);
        assert.equal(Inbox.windowChip(wa), null);
    });

    it('hides the box and Send in the shell of a closed thread (keeping the draft), and shows them again when the customer writes', () => {
        const { Inbox, h } = load();
        h.el('chat-pane-container');
        const thread = quiet({}, 30 * HOUR);
        Inbox.threads = [thread];
        Inbox.renderChatShell(thread);
        const pane = h.el('chat-pane-container');
        assert.match(pane.innerHTML, /id="chat-send-form"[^>]*data-id="q" hidden/);
        assert.ok(pane.innerHTML.includes('data-window-closed'));
        const form = h.el('chat-send-form');
        const host = h.el('composer-window');
        form.hidden = true;
        thread.last_inbound_message_at = ago(60000);
        thread.last_message_at = ago(60000);
        delete thread.reply_window_ends_at;
        Inbox.paintWindowOffer(thread);
        assert.equal(host.innerHTML, '', 'the notice is gone');
        assert.equal(form.hidden, false, 'and the box is back');
    });

    it('draws an open thread with its box, and no notice', () => {
        const { Inbox, h } = load();
        h.el('chat-pane-container');
        const thread = waiting();
        Inbox.threads = [thread];
        Inbox.renderChatShell(thread);
        const html = h.el('chat-pane-container').innerHTML;
        assert.doesNotMatch(html, /id="chat-send-form"[^>]*hidden/);
        assert.ok(!html.includes('data-window-closed'));
    });
});

describe('Inbox header: the window on every thread', () => {
    it('shows the countdown on a thread nobody has to act on, muted, and unmuted where a person has to answer', () => {
        const { Inbox } = load();
        const quietChip = Inbox.windowChip(quiet());
        assert.deepEqual([quietChip.muted, /left to reply/.test(quietChip.text)], [true, true]);
        assert.match(String(Inbox.metaMarkup(quiet())), /class="chip chip-muted"[^>]*>[^]*left to reply/);
        const needs = Inbox.windowChip(waiting());
        assert.equal(needs.muted, false);
        assert.doesNotMatch(String(Inbox.metaMarkup(waiting())), /chip-muted/);
    });

    it('says "closed" on a closed one, with where to reply only where a person has to', () => {
        const { Inbox, t } = load();
        assert.equal(Inbox.windowChip(quiet({}, 30 * HOUR)).text, t('inbox.window.closed'));
        assert.equal(Inbox.windowChip(waiting({}, 30 * HOUR)).text, `${t('inbox.window.closed')}: ${t('inbox.window.closedHint')}`);
    });
});

describe('Inbox failures: the window refusal is a sentence, and code 10 is not "permission" for it', () => {
    const META_TEXT = 'DM Send Failed: (#10) This message is sent outside of allowed window. (Code: 10)';

    it('names Meta\'s refusal by its wording, in both languages, ahead of the generic permission line', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { h, t } = load({ lang });
            assert.equal(h.UI.failureCode(META_TEXT), 'DM_WINDOW_CLOSED');
            assert.equal(h.UI.explainMetaError(META_TEXT), t('failure.DM_WINDOW_CLOSED'));
            const parts = h.UI.failureParts(META_TEXT);
            assert.equal(parts.sentence, t('failure.DM_WINDOW_CLOSED'));
            assert.equal(parts.next, t('failure.DM_WINDOW_CLOSED.next'));
            assert.equal(parts.translated, true);
            assert.notEqual(parts.sentence, t('activity.err.permission'));
        }
    });

    it('names it by its subcode too (Messenger 2018278, Instagram 2534022) when the text carries one', () => {
        const { h } = load();
        for (const sub of ['2018278', '2534022']) assert.equal(h.UI.failureCode(`Meta refused (Code: 10, Subcode: ${sub})`), 'DM_WINDOW_CLOSED', sub);
    });

    it('leaves a code 10 that is something else as "permission", and a code with no window in it alone', () => {
        const { h, t } = load();
        assert.equal(h.UI.explainMetaError('DM Send Failed: (#10) Application does not have permission for this action (Code: 10)'), t('activity.err.permission'));
        assert.equal(h.UI.failureCode('DM Send Failed: Application does not have permission (Code: 10)'), '');
    });

    it('says what the server\'s 409 WINDOW_CLOSED means, in both languages', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { h, t } = load({ lang });
            const parts = h.UI.failureParts({ code: 'WINDOW_CLOSED', message: 'Meta accepts replies only within 24 hours of the customer\'s last message.', status: 409, params: { closedAt: ago(HOUR) } });
            assert.equal(parts.sentence, t('errors.WINDOW_CLOSED'));
            assert.equal(parts.next, t('errors.WINDOW_CLOSED.next'));
        }
        assert.equal(load().t('errors.WINDOW_CLOSED'), 'Meta accepts replies only within 24 hours of the customer’s last message.');
        assert.equal(load({ lang: 'ar' }).t('errors.WINDOW_CLOSED'), 'لا تقبل ميتا الردّ إلا خلال 24 ساعة من آخر رسالة للعميل.');
    });

    async function send(api: Json, thread: Json) {
        const r = load({ api });
        r.h.UI.formBusy = () => () => {};
        const box = r.h.el('chat-input-text');
        box.value = 'Yes, still available';
        r.Inbox.threads = [thread];
        const form = { dataset: { id: thread.id } };
        await r.Inbox.sendMessage(form, { preventDefault() {} });
        await settle();
        return { ...r, box };
    }

    it('a 409 WINDOW_CLOSED toasts the sentence and the next step, keeps the draft, and closes the thread on screen', async () => {
        const closedAt = ago(5 * 60000);
        const thread = waiting();
        const { toasts, Inbox, box } = await send({
            sendConversationMessage: () => Promise.reject(Object.assign(new Error('Meta accepts replies only within 24 hours of the customer\'s last message.'), {
                status: 409, code: 'WINDOW_CLOSED', params: { closedAt },
            })),
        }, thread);
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0]!.message, 'Meta accepts replies only within 24 hours of the customer’s last message. Reply in the Instagram app, or wait until the customer writes again.');
        assert.equal(toasts[0]!.kind, 'error');
        assert.equal(box.value, 'Yes, still available', 'what was typed is not lost');
        assert.equal(thread.reply_window_ends_at, closedAt);
        assert.ok(String(Inbox.windowOfferMarkup(thread)).includes('data-window-closed'), 'the thread now shows the closed notice');
    });

    it('a raw Meta refusal (an older server) is toasted as the same sentence, never as Meta\'s English', async () => {
        const { toasts } = await send({
            sendConversationMessage: () => Promise.reject(new Error('DM Send Failed: (#10) This message is sent outside of allowed window. (Code: 10)')),
        }, waiting());
        assert.ok(!toasts[0]!.message.includes('outside of allowed window'));
        assert.ok(toasts[0]!.message.startsWith('Meta accepts replies only within 24 hours'));
    });

    it('anything the catalogue does not know keeps the plain "could not send"', async () => {
        const { toasts, t } = await send({ sendConversationMessage: () => Promise.reject(new Error('socket hang up')) }, waiting());
        assert.equal(toasts[0]!.message, t('inbox.sendFailed'));
    });
});

describe('Inbox on a phone (860 px and below, a conversation open)', () => {
    /** A thread with every kind of chip. */
    const full = (over: Json = {}): Json => waiting({
        stage: 'link', is_user_follow_business: true, is_business_follow_user: false, is_verified_user: true, follower_count: 1200,
        created_at: ago(30 * DAY), message_count: 12, ad: { name: 'Autumn' }, last_link_at: ago(HOUR), ...over,
    });

    it('shows three chips (the stage, the window, follows you) and "More about <name>", with the rest behind it', () => {
        const { Inbox } = load({ phone: true });
        const thread = full();
        const markup = String(Inbox.metaMarkup(thread));
        const chips = (markup.match(/class="chip[ "]/g) || []).length;
        assert.equal(chips, 4, '3 chips and the More chip');
        const words = text(markup);
        assert.ok(words.includes('Stage:') || /link/i.test(words), words);
        assert.ok(words.includes('left to reply'));
        assert.ok(words.includes('Follows you'));
        assert.ok(words.includes('More about Sara'));
        assert.ok(!words.includes('12 messages') && !words.includes('Verified') && !words.includes('Autumn'), 'the rest is not in the strip');
        assert.match(markup, /id="chat-meta-more"[^>]*aria-expanded="false"/);
    });

    it('opens the rest, and says "Show less", for the open conversation only', () => {
        const { Inbox, h } = load({ phone: true });
        const thread = full();
        Inbox.threads = [thread];
        Inbox.chatShellThreadId = thread.id;
        h.el('chat-meta');
        Inbox.toggleMeta(thread.id);
        const markup = String(Inbox.metaMarkup(thread));
        assert.ok(text(markup).includes('12 messages') && text(markup).includes('Autumn'));
        assert.ok(text(markup).includes('Show less'));
        assert.match(markup, /aria-expanded="true"/);
        assert.doesNotMatch(String(Inbox.metaMarkup({ ...thread, id: 'other' })), /aria-expanded="true"/);
    });

    it('is "المزيد عن سارة" in Arabic', () => {
        const { Inbox } = load({ lang: 'ar', phone: true });
        assert.ok(text(Inbox.metaMarkup(full({ profile_name: 'سارة' }))).includes('المزيد عن سارة'));
    });

    it('uses a hot lead as the first chip when there is no stage, and draws no More chip when there is nothing to put behind it', () => {
        const { Inbox } = load({ phone: true });
        const bare = quiet({ is_user_follow_business: true });
        const markup = String(Inbox.metaMarkup(bare));
        assert.ok(!markup.includes('chat-meta-more'));
        assert.ok(text(markup).includes('Follows you') && text(markup).includes('left to reply'));
    });

    it('draws every chip on a wide screen, and no More chip', () => {
        const { Inbox } = load({ phone: false });
        const markup = String(Inbox.metaMarkup(full()));
        assert.ok(!markup.includes('chat-meta-more'));
        assert.ok(text(markup).includes('12 messages') && text(markup).includes('Verified') && text(markup).includes('Autumn'));
    });

    it('uses the short placeholder: "Type a reply…" / «اكتب ردًّا…», and the long one on a wide screen', () => {
        assert.equal(load({ phone: true }).Inbox.placeholderText(), 'Type a reply…');
        assert.equal(load({ phone: true, lang: 'ar' }).Inbox.placeholderText(), 'اكتب ردًّا…');
        assert.match(load({ phone: false }).Inbox.placeholderText(), /pauses the AI/);
        const { Inbox, h } = load({ phone: true });
        h.el('chat-pane-container');
        const thread = waiting();
        Inbox.threads = [thread];
        Inbox.renderChatShell(thread);
        assert.ok(h.el('chat-pane-container').innerHTML.includes('placeholder="Type a reply…"'));
    });

    it('puts "Mark handled" beside the composer as well as in the header (the stylesheet shows one), and the closed notice has its own, once', () => {
        const { Inbox, h } = load({ phone: true });
        h.el('chat-pane-container');
        const thread = waiting();
        Inbox.threads = [thread];
        Inbox.renderChatShell(thread);
        const html = h.el('chat-pane-container').innerHTML;
        assert.ok(html.includes('id="composer-handled-slot"'));
        assert.ok(html.includes('id="composer-handled-btn"') && html.includes('id="chat-mark-handled"'), 'both slots, with different ids');
        const closed = waiting({}, 30 * HOUR);
        Inbox.threads = [closed];
        Inbox.renderChatShell(closed);
        const closedHtml = h.el('chat-pane-container').innerHTML;
        assert.equal((closedHtml.match(/data-action="inbox:markHandled"/g) || []).length, 2, 'the header\'s and the notice\'s, none beside a composer that is not there');
        assert.ok(!closedHtml.includes('composer-handled-btn'));
    });

    it('keeps a handled, closed thread\'s "Reopen" beside the composer, where the header has none on a phone', () => {
        const { Inbox } = load({ phone: true });
        const thread = waiting({ handled_at: new Date().toISOString() }, 30 * HOUR);
        assert.match(String(Inbox.composerHandledMarkup(thread)), /data-action="inbox:unmarkHandled"/);
    });

    it('the stylesheet gives the conversation the screen: no title, one header row, the state words and the header\'s button moved', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        const block = css.slice(css.indexOf('One screen, one conversation (R1-I15)'));
        const phone = block.slice(block.indexOf('@media (max-width: 860px)'));
        assert.match(phone, /\.inbox-layout\[data-pane='chat'\]\) \.page-header \.header-start > div \{ display: none; \}/);
        assert.match(phone, /\.chat-header \.ai-state, \.chat-header \.chat-handled-slot \{ display: none; \}/);
        assert.match(phone, /\.composer-handled-slot:not\(:empty\) \{ display: inline-flex/);
        assert.doesNotMatch(css, /\.chat-header \{ flex-wrap: wrap; \}/, 'the header no longer wraps to a second row');
        assert.match(css, /\.composer-handled-slot \{ display: none; \}/, 'and on a wide screen the header\'s button is the only one');
    });
});
