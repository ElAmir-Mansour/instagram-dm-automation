/**
 * The inbox's visible decision trace (docs/specs/005-muse-sees T039, US5): what Meta Muse SAW under a customer's message with no words, and the
 * "saw → decided → why" line under the reply.
 *
 * The REAL `inbox.js` in the shared `node:vm` harness, in both languages where the words are the claim, as `inboxHandled.test.ts` loads it. What is pinned,
 * because a screenshot cannot show it:
 *
 *   - under a reel, photo, story or story mention that Meta Muse read: its description with the mark, the model, how sure it was and whose content it is; a voice
 *     note's transcript once, with the mark, never twice; the stored description is NOT printed as if the customer had written it (a story mention keeps its
 *     "mentioned you in a story", in the bubble and in the thread list);
 *   - when it could not read it, that, honestly: every status and every reason the server keeps has a sentence in both languages (the page's lists are the
 *     server's, so a new reason fails here), and one outside the lists is escaped text and never a key;
 *   - under the reply, one line: Saw (the flag the turn set) → Decided (the flow's own action word) → Why (the turn's one-line reason, cut to a length), a step the
 *     row lacks left out, and a reply with none of them exactly what it was before this existed (the "Next:" is not said twice);
 *   - everything in `perception` and `ai_meta` comes from a model reading a stranger's media: it is text, never markup, and never a key.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NEXT_ACTIONS } from '../services/dmSales/types.js';
import { perceivedText } from '../services/perception/text.js';
import { WORDLESS_PLACEHOLDERS } from '../webhook/attachments.js';
import { ABOUT_OWNER, FAIL_REASONS, PERCEPTION_STATUSES, SKIP_REASONS, UNREADABLE_REASONS, type Perception } from '../services/perception/types.js';
import { loadDashboard, type Dashboard, type Json } from './_harness.js';

type Lang = 'ar' | 'en';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The tags and attribute names a piece of markup holds, read the way a parser does: what is inside a quoted value is a value. */
const tagsOf = (markup: unknown): string[] => [...String(markup).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase());
const attrNames = (markup: unknown): string[] => [...String(markup).matchAll(/<[a-zA-Z][^>]*>/g)]
    .flatMap((m) => [...m[0].replace(/"[^"]*"/g, '""').matchAll(/\s([a-zA-Z-]+)=/g)].map((a) => a[1]!.toLowerCase()));
const SAFE_TAGS = new Set(['div', 'span', 'p', 'i', 'bdi', 'a', 'img', 'button']);
const SAFE_ATTRS = new Set(['class', 'data-perception', 'data-step', 'data-lucide', 'aria-hidden', 'dir', 'lang', 'data-ai-trace', 'data-ai-meta', 'role', 'aria-label', 'src', 'alt', 'loading',
    'decoding', 'referrerpolicy', 'href', 'target', 'rel', 'title', 'type', 'data-action', 'data-id']);

interface Rig {
    h: Dashboard;
    Inbox: Json;
    t: Dashboard['t'];
}

function load(lang: Lang = 'en'): Rig {
    const App = { canOperate: () => true, setInboxWaiting: () => {}, hashParam: () => '', route: (page: string) => `#/${page}` };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/inbox.js'], globals: { API: { token: 'tok' }, App } });
    h.UI.toast = () => null;
    return { h, Inbox: h.run('InboxPage'), t: h.t };
}

/**
 * What the pipeline stores for a perceived reel: a `Perception` as the server types it (so a field it renames or drops stops this compiling), and the readable text
 * `perceivedText` builds from it (so the format the page has to recognise is the server's own, not a copy of it).
 */
const BASE: Perception = {
    v: 1, kind: 'reel', status: 'ok', seen: 'A 37-second reel showing a Python decorator that times a function.', transcript: '', about_owner: 'own_content', confidence: 0.92,
    model: 'muse-spark-1.3', stored_at: '2026-10-30T10:00:05.000Z', ms: 8200, usd: 0.021,
};
const reel = (over: Json = {}, perception: Json | null = {}): Json => ({
    id: 'm1', direction: 'inbound', sender: 'customer', message_type: 'reel', created_at: '2026-10-30T10:00:00.000Z',
    text: perceivedText('reel', BASE),
    raw_payload: { message: { attachments: [{ type: 'ig_reel', payload: { url: 'https://cdn.example.test/reel.mp4' } }] } },
    perception: perception === null ? null : { ...BASE, ...perception },
    ...over,
});

const reply = (meta: Json | null, over: Json = {}): Json => ({
    id: 'a1', direction: 'outbound', sender: 'ai', message_type: 'text', text: 'ده بيشرح الـ decorators، تحب أرسلك الدليل؟', created_at: '2026-10-30T10:00:12.000Z', ai_meta: meta, ...over,
});

const META = { engine: 'providers', intent: 'info', stage: 'recommend', next_action: 'recommend', offer_id: 'python', perceived: true, reason: 'The reel is about decorators, which the Python guide covers.' };

// ─── Under the customer's message: what was seen ─────────────────────────────────────────────────────────────────────────

describe('Inbox: what Meta Muse saw, under a message with no words', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`draws the description with the mark, the model, how sure it was and whose content it is, and the chip stays (${lang})`, () => {
            const { Inbox, t } = load(lang);
            const bubble = String(Inbox.messageBubble(reel()));
            const block = /<div class="msg-transcript msg-seen" data-perception="ok">([\s\S]*?)<\/div>/.exec(bubble);
            assert.ok(block, 'the block is there');
            const inner = text(block![1]!);
            assert.ok(inner.includes(text(t('inbox.perception.seen'))), inner);
            assert.ok(inner.includes('muse-spark-1.3'), 'the model');
            assert.ok(inner.includes(text(t('inbox.perception.sure', { percent: '92%' }))), inner);
            assert.ok(inner.includes('A 37-second reel showing a Python decorator that times a function.'), 'what was seen');
            assert.ok(inner.includes(text(t('inbox.perception.owner.own_content'))), 'whose content it is');
            assert.match(block![1]!, /<i data-lucide="eye" aria-hidden="true">/);
            assert.match(block![1]!, /<p class="msg-transcript-text" dir="auto" lang="en">A 37-second reel/, 'the description is English, and a screen reader is told so');
            assert.ok(bubble.includes('class="msg-attachment"') && bubble.includes(t('inbox.attach.reel')), 'the reel chip is still the message');
            assert.equal(/inbox\.[a-zA-Z.]+/.test(text(bubble)), false, 'no raw key');
        });
    }

    it('does not print the stored description as the customer\'s words: the chip and the block say it once', () => {
        const { Inbox } = load();
        const bubble = String(Inbox.messageBubble(reel()));
        assert.ok(!bubble.includes('[shared reel]'), 'the placeholder is not shown');
        assert.equal((bubble.match(/A 37-second reel showing/g) ?? []).length, 1, 'and the description is there once');
        assert.ok(!/<p dir="auto"[^>]*>A 37-second/.test(bubble), 'not as a paragraph of words');
    });

    it('reads every kind the pipeline can perceive, a story mention among them, and a voice note as what was HEARD, once', () => {
        const { Inbox, t } = load();
        for (const kind of ['reel', 'share', 'story_reply', 'story_share', 'image', 'video'] as const) {
            // The text the server stores for each kind is its own placeholder with the description after it.
            const stored = perceivedText(kind, { seen: 'Something it saw.' });
            assert.ok(stored.startsWith(WORDLESS_PLACEHOLDERS[kind]), stored);
            const bubble = String(Inbox.messageBubble(reel({ message_type: kind, text: stored }, { kind, seen: 'Something it saw.' })));
            assert.ok(bubble.includes('data-perception="ok"') && text(bubble).includes('Something it saw.'), kind);
            assert.ok(!bubble.includes(WORDLESS_PLACEHOLDERS[kind]), `${kind}: the placeholder is not printed`);
        }
        const voice = String(Inbox.messageBubble(reel({ message_type: 'audio', text: 'كام سعر الباقة وفيه شهادة؟', raw_payload: null }, { kind: 'audio', seen: undefined, transcript: 'كام سعر الباقة وفيه شهادة؟', model: 'muse-voice-transcribe-1.0' })));
        assert.ok(voice.includes(t('inbox.perception.heard')) && voice.includes('data-lucide="music"'), 'heard, not seen');
        assert.equal((voice.match(/كام سعر الباقة/g) ?? []).length, 1, 'the transcript is there once: the old transcript block does not repeat it');
        assert.ok(!voice.includes(t('inbox.voiceTranscript')), 'and it is the perception\'s block, not the WhatsApp one');
        assert.ok(!/lang="en"/.test(voice), 'a transcript is the customer\'s own language');
        assert.ok(!voice.includes('msg-seen-owner'), 'and a voice note has no owner to name, whatever the row says');
        // A voice note that Meta Muse did not read keeps the old behaviour: the transcript block, when its text is a transcript.
        const whatsapp = String(Inbox.messageBubble(reel({ message_type: 'audio', text: 'Hello there', raw_payload: null }, null)));
        assert.ok(whatsapp.includes(t('inbox.voiceTranscript')) && whatsapp.includes('Hello there'));
    });

    it('keeps a story mention as "mentioned you in a story", in the bubble and in the thread list, while the description sits under it', () => {
        const { Inbox, t } = load();
        const mention = reel({ message_type: 'story_mention', text: perceivedText('story_mention', { seen: 'A story showing a laptop with code on the screen.' }), raw_payload: { message: { attachments: [{ type: 'story_mention', payload: { url: 'https://cdn.example.test/s.jpg' } }] } } }, { kind: 'story_mention', seen: 'A story showing a laptop with code on the screen.' });
        const bubble = String(Inbox.messageBubble(mention));
        assert.ok(text(bubble).includes(t('inbox.storyMention')), 'the mention is named');
        assert.ok(!bubble.includes('[Story Mention]'), 'the placeholder with its description is not words they wrote');
        assert.equal((bubble.match(/A story showing a laptop/g) ?? []).length, 1);
        assert.equal(Inbox.threadPreview({ last_message_text: mention.text, last_message_type: 'story_mention' }), t('inbox.storyMention'), 'and so is the row in the list');
        // Words the customer typed with a mention are still theirs, in both places.
        assert.equal(Inbox.threadPreview({ last_message_text: 'love this', last_message_type: 'story_mention' }), 'love this');
        const typed = String(Inbox.messageBubble({ id: 'm', direction: 'inbound', message_type: 'story_mention', text: 'love this', raw_payload: null, perception: null }));
        assert.ok(typed.includes('love this'));
    });

    it('says a personal document is not described, with the generic words that are stored, and says whose it is when it is not the owner\'s', () => {
        const { Inbox, t } = load();
        const personal = String(Inbox.messageBubble(reel({ message_type: 'image', text: '[photo] a personal document' }, { kind: 'image', seen: 'a personal document', about_owner: 'personal', confidence: 0.9 })));
        assert.ok(text(personal).includes('a personal document') && text(personal).includes(text(t('inbox.perception.owner.personal'))));
        const other = String(Inbox.messageBubble(reel({}, { about_owner: 'other_content' })));
        assert.ok(text(other).includes(text(t('inbox.perception.owner.other_content'))));
        const unclear = String(Inbox.messageBubble(reel({}, { about_owner: 'unclear' })));
        assert.ok(!unclear.includes('msg-seen-owner'), 'an unclear owner says nothing');
    });

    it('draws a block only for a customer\'s message that has a perception object: none for NULL, a string that is not JSON, a list, an outbound row or an empty description', () => {
        const { Inbox } = load();
        for (const perception of [null, undefined, '', 'not json', '[1]', [1], 7, true]) {
            const bubble = String(Inbox.messageBubble(reel({ perception }, null)));
            assert.ok(!bubble.includes('msg-seen'), JSON.stringify(perception));
        }
        assert.ok(!String(Inbox.messageBubble(reel({ direction: 'outbound', sender: 'ai' }))).includes('msg-seen'), 'an outbound row carries none');
        assert.equal(Inbox.perceptionOf(reel({ direction: 'outbound', sender: 'ai' })), null, 'and is not read as one');
        assert.equal(Inbox.perceptionOf(null), null);
        assert.equal(Inbox.perceptionOf(reel()).status, 'ok', 'a customer\'s row is');
        assert.ok(!String(Inbox.messageBubble(reel({}, { seen: '   ' }))).includes('msg-seen'), 'an ok perception with nothing to say draws nothing');
        // A driver that hands JSONB back as text is read as the object it is.
        assert.ok(String(Inbox.messageBubble(reel({ perception: JSON.stringify(reel().perception) }, null))).includes('data-perception="ok"'));
    });

    it('shows how sure it was only when that is a number from 0 to 1', () => {
        const { Inbox, t } = load();
        for (const confidence of [0.6, 1, 0, 0.456]) assert.ok(String(Inbox.messageBubble(reel({}, { confidence }))).includes(t('inbox.perception.sure', { percent: '⁦' + Math.round(confidence * 100) + '%⁩' })), String(confidence));
        for (const confidence of [-0.1, 1.5, '0.9', null, NaN, undefined]) assert.ok(!String(Inbox.messageBubble(reel({}, { confidence: confidence as number }))).includes(t('inbox.perception.sure', { percent: '' }).split('{')[0]!.trim() || 'sure'), String(confidence));
    });
});

// ─── When it could not read it ───────────────────────────────────────────────────────────────────────────────────────────

describe('Inbox: a message Meta Muse did not understand is said honestly', () => {
    it('has the same statuses and reasons as the server, each with a sentence in both languages', () => {
        const { Inbox } = load();
        assert.deepEqual([...Inbox.PERCEPTION_STATUSES], [...PERCEPTION_STATUSES]);
        assert.deepEqual([...Inbox.PERCEPTION_REASONS].sort(), [...SKIP_REASONS, ...FAIL_REASONS, ...UNREADABLE_REASONS].sort(), 'the page\'s list is the three the server keeps');
        assert.deepEqual([...Inbox.PERCEPTION_OWNERS].sort(), ABOUT_OWNER.filter((o) => o !== 'unclear').sort(), 'and "unclear" is the one it does not draw');
        for (const lang of ['en', 'ar'] as const) {
            const { t } = load(lang);
            for (const reason of [...SKIP_REASONS, ...FAIL_REASONS, ...UNREADABLE_REASONS]) {
                const sentence = t(`inbox.perception.reason.${reason}`);
                assert.notEqual(sentence, `inbox.perception.reason.${reason}`, `${lang} ${reason}`);
                assert.equal(/\{\w+\}/.test(sentence), false, `${lang} ${reason}: no placeholder`);
            }
            for (const status of ['unreadable', 'failed', 'skipped', 'seen', 'heard']) assert.notEqual(t(`inbox.perception.${status}`), `inbox.perception.${status}`, `${lang} ${status}`);
            for (const owner of ABOUT_OWNER.filter((o) => o !== 'unclear')) assert.notEqual(t(`inbox.perception.owner.${owner}`), `inbox.perception.owner.${owner}`, `${lang} ${owner}`);
        }
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`says what happened and why for every status and reason, warning for a failure and quietly for a message that was not read at all (${lang})`, () => {
            const { Inbox, t } = load(lang);
            const cases: Array<[string, readonly string[]]> = [['unreadable', UNREADABLE_REASONS], ['failed', FAIL_REASONS], ['skipped', SKIP_REASONS]];
            for (const [status, reasons] of cases) {
                for (const reason of reasons) {
                    const bubble = String(Inbox.messageBubble(reel({ text: '[shared reel]' }, { status, reason, seen: undefined })));
                    const block = /<div class="msg-transcript msg-seen msg-seen--note" data-perception="([^"]+)">([\s\S]*?)<\/div>/.exec(bubble);
                    assert.ok(block, `${status}/${reason}: a note`);
                    assert.equal(block![1], status);
                    const inner = text(block![2]!);
                    assert.ok(inner.includes(text(t(`inbox.perception.${status}`))), `${status}: its title`);
                    assert.ok(inner.includes(text(t(`inbox.perception.reason.${reason}`))), `${status}/${reason}: its sentence`);
                    assert.match(block![2]!, status === 'skipped' ? /data-lucide="info"/ : /data-lucide="alert-triangle"/, `${status}: the icon`);
                    assert.ok(!bubble.includes('data-perception="ok"') && !bubble.includes(t('inbox.perception.seen')), 'and it does not claim to have seen anything');
                }
            }
        });
    }

    it('says only the status for one with no reason, calls an unknown status "not read", and shows a reason it does not know as escaped, isolated text', () => {
        const { Inbox, t } = load();
        const none = String(Inbox.messageBubble(reel({}, { status: 'failed', reason: undefined, seen: undefined })));
        assert.ok(text(none).includes(text(t('inbox.perception.failed'))) && !none.includes('<p class="msg-transcript-text"'), 'no sentence invented');
        const unknown = String(Inbox.messageBubble(reel({}, { status: 'weird', reason: 'no_idea', seen: 'Should never be shown as seen.' })));
        assert.ok(unknown.includes('data-perception="unknown"') && text(unknown).includes(text(t('inbox.perception.skipped'))), 'an unknown status is "not read"');
        assert.ok(!unknown.includes('Should never be shown as seen.'), 'its description is not trusted');
        assert.ok(text(unknown).includes('Reason: no_idea') && unknown.includes('⁨no_idea⁩'), 'the code, as text, isolated');
        const evil = String(Inbox.messageBubble(reel({}, { status: 'failed', reason: '<img src=x onerror=alert(1)>' })));
        assert.ok(!/<img src=x/i.test(evil) && evil.includes('&lt;img src=x onerror=alert(1)&gt;'));
        const long = String(Inbox.messageBubble(reel({}, { status: 'failed', reason: 'x'.repeat(500) })));
        assert.ok(text(long).length < 300 && long.includes('…'), 'cut to a length');
        // A reason is never looked up as a key, so one that names a key shows its own text.
        const key = String(Inbox.messageBubble(reel({}, { status: 'failed', reason: 'inbox.storyMention' })));
        assert.ok(text(key).includes('Reason: inbox.storyMention') && !text(key).includes(t('inbox.storyMention')));
    });
});

// ─── Under the reply: saw → decided → why ────────────────────────────────────────────────────────────────────────────────

describe('Inbox: the decision under a reply', () => {
    const trace = (Inbox: Json, meta: Json | null): string => String(Inbox.aiMetaDetail(reply(meta)));

    for (const lang of ['en', 'ar'] as const) {
        it(`reads Saw → Decided → Why, in that order, with the flow's own word for the action (${lang})`, () => {
            const { Inbox, t } = load(lang);
            const markup = trace(Inbox, META);
            assert.match(markup, /<div class="msg-detail msg-trace" data-ai-trace role="group" aria-label="[^"]+">/);
            assert.ok(markup.includes(`aria-label="${t('inbox.trace.label')}"`));
            const said = text(markup);
            const saw = said.indexOf(text(`${t('inbox.trace.saw')}: ${t('inbox.trace.sawMedia')}`));
            const decided = said.indexOf(text(`${t('inbox.trace.decided')}: ${t('inbox.nextAction.recommend')}`));
            const why = said.indexOf(text(`${t('inbox.trace.why')}: ${META.reason}`));
            assert.ok(saw >= 0 && decided > saw && why > decided, `${said}`);
            assert.equal((markup.match(/data-lucide="arrow-right"/g) ?? []).length, 2, 'an arrow between each step, not after the last');
            assert.ok(/<i data-lucide="arrow-right" class="msg-trace-arrow" aria-hidden="true"><\/i>/.test(markup), 'decorative for a screen reader');
            assert.equal(/inbox\.[a-zA-Z.]+/.test(said), false, 'no raw key');
        });
    }

    it('says Recalled for a video from the library, beside Saw when both are true, and leaves out the step a row does not have', () => {
        const { Inbox, t } = load();
        const recalled = text(trace(Inbox, { ...META, perceived: false, recalled: true }));
        assert.ok(recalled.includes(`${t('inbox.trace.recalled')}: ${t('inbox.trace.recalledVideo')}`) && !recalled.includes(`${t('inbox.trace.saw')}:`));
        const both = text(trace(Inbox, { ...META, recalled: true }));
        assert.ok(both.includes(`${t('inbox.trace.saw')}: ${t('inbox.trace.sawMedia')} · ${t('inbox.trace.recalled')}: ${t('inbox.trace.recalledVideo')}`), both);
        const onlyReason = trace(Inbox, { engine: 'providers', reason: 'Asked a question the facts answer.' });
        assert.ok(!onlyReason.includes(t('inbox.trace.saw') + ':') && text(onlyReason).includes(`${t('inbox.trace.why')}: Asked a question the facts answer.`));
        assert.equal((onlyReason.match(/data-lucide="arrow-right"/g) ?? []).length, 0, 'one step needs no arrow');
        const noAction = text(trace(Inbox, { perceived: true }));
        assert.ok(noAction.includes(t('inbox.trace.saw')) && !noAction.includes(t('inbox.trace.decided')) && !noAction.includes(t('inbox.trace.why')));
    });

    it('is no trace at all for a reply with none of the three, and the line it had before is exactly as it was: the "Next:" is still there', () => {
        const { Inbox, t } = load();
        const old = { engine: 'providers', intent: 'price', stage: 'link', next_action: 'send_link', offer_id: 'python' };
        const markup = trace(Inbox, old);
        assert.ok(!markup.includes('data-ai-trace'));
        assert.ok(markup.includes('data-ai-meta') && text(markup).includes(`${t('inbox.aiMeta.next')}: ${t('inbox.nextAction.send_link')}`));
        for (const meta of [null, {}, { perceived: false, recalled: false, reason: '' }, { perceived: 'true', recalled: 1, reason: { text: 'x' } }]) {
            assert.ok(!trace(Inbox, meta).includes('data-ai-trace'), JSON.stringify(meta));
        }
    });

    it('does not say the action twice: the trace has it, and the line under it leaves "Next:" out but keeps the rest', () => {
        const { Inbox, t } = load();
        const markup = trace(Inbox, META);
        const line = /data-ai-meta>([\s\S]*)$/.exec(markup)![1]!;
        assert.ok(!text(line).includes(`${t('inbox.aiMeta.next')}:`), text(line));
        for (const label of ['intent', 'stage', 'offer', 'engine']) assert.ok(text(line).includes(`${t(`inbox.aiMeta.${label}`)}:`), label);
        // A trace with no action does not take the "Next:" away: there was none to move.
        assert.ok(!text(trace(Inbox, { ...META, next_action: undefined })).includes(`${t('inbox.aiMeta.next')}:`));
        // Each of the flow's own actions is its own word.
        for (const action of NEXT_ACTIONS) assert.ok(text(trace(Inbox, { ...META, next_action: action })).includes(`${t('inbox.trace.decided')}: ${t(`inbox.nextAction.${action}`)}`), action);
    });

    it('cuts a long reason to a line, collapses its breaks, shows an action the flow does not know as escaped text, and ignores a reason that is not text', () => {
        const { Inbox, t } = load();
        // The why step is the trace's last: from its opening tag to the end of the trace's own div.
        const whyOf = (markup: string): string => text(/data-step="why">([\s\S]*?)<\/span><\/div>/.exec(markup)![1]!);
        const why = whyOf(trace(Inbox, { ...META, reason: `${'a '.repeat(300)}\n\n  end` }));
        assert.ok(why.startsWith(`${t('inbox.trace.why')}: a a`) && why.endsWith('…'), why.slice(-20));
        assert.ok(Array.from(why.slice(`${t('inbox.trace.why')}: `.length)).length <= 200, 'at most 200 characters of it');
        const breaks = trace(Inbox, { ...META, reason: 'one\ntwo\r\n\tthree' });
        assert.ok(text(breaks).includes('one two three'));
        const odd = trace(Inbox, { ...META, next_action: '<script>alert(1)</script>' });
        assert.ok(!/<script/i.test(odd) && odd.includes('&lt;script&gt;'));
        for (const reason of [{ text: 'x' }, ['x'], null, true]) assert.ok(!trace(Inbox, { engine: 'providers', reason }).includes(`${t('inbox.trace.why')}:`), JSON.stringify(reason));
        // A number is text, as everywhere else on this screen.
        assert.ok(text(trace(Inbox, { reason: 12 })).includes('Why: 12'));
    });

    it('gives an operator\'s own reply no trace, whatever its ai_meta says', () => {
        const { Inbox } = load();
        assert.equal(String(Inbox.aiMetaDetail(reply(META, { sender: 'operator' }))), '');
        assert.equal(String(Inbox.aiMetaDetail({ direction: 'inbound', ai_meta: META })), '');
    });

    it('takes ai_meta as a string a driver handed back, like every other column of the row', () => {
        const { Inbox } = load();
        assert.ok(String(Inbox.aiMetaDetail(reply(JSON.stringify(META) as unknown as Json))).includes('data-ai-trace'));
    });

    it('is under the reply\'s timing and model line, in the bubble\'s detail', () => {
        const { Inbox } = load();
        const detail = String(Inbox.outboundDetail(reply(META, { ai: { model: 'muse-spark-1.3', source: 'usage' } }), { ms: 12000, attempts: 1 }));
        assert.ok(detail.indexOf('Replied in') < detail.indexOf('data-ai-trace') && detail.indexOf('data-ai-trace') < detail.indexOf('data-ai-meta'));
    });
});

// ─── Everything a model wrote is text ───────────────────────────────────────────────────────────────────────────────────

describe('Inbox: what a model said about a stranger\'s media is never markup', () => {
    const PAYLOADS = [
        '<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', '</p><img src=x onerror=alert(1)>', "' onmouseover='alert(1)", 'javascript:alert(1)',
        '<svg onload=alert(1)>', '{{constructor}}', '${alert(1)}', '<a href="javascript:alert(1)">x</a>',
    ];

    it('escapes the description, the transcript, the model, the status, the reason, the owner and every part of ai_meta, in every field', () => {
        const { Inbox } = load();
        for (const payload of PAYLOADS) {
            const markups = [
                String(Inbox.messageBubble(reel({}, { seen: payload, transcript: payload, model: payload, about_owner: payload, confidence: payload as unknown as number }))),
                String(Inbox.messageBubble(reel({}, { status: payload, reason: payload }))),
                String(Inbox.messageBubble(reel({ message_type: 'audio', text: payload }, { kind: 'audio', seen: undefined, transcript: payload }))),
                String(Inbox.aiMetaDetail(reply({ perceived: true, recalled: true, reason: payload, next_action: payload, intent: payload, stage: payload, offer_id: payload, engine: payload }))),
            ];
            for (const markup of markups) {
                for (const tag of tagsOf(markup)) assert.ok(SAFE_TAGS.has(tag), `${JSON.stringify(payload)}: tag ${tag}`);
                for (const attr of attrNames(markup)) assert.ok(SAFE_ATTRS.has(attr), `${JSON.stringify(payload)}: attribute ${attr}`);
                assert.ok(!/<img src=x|<script|<svg/i.test(markup), `${JSON.stringify(payload)}: no element was made`);
            }
        }
    });

    it('never puts a value of perception or ai_meta in a class, a key or a link', () => {
        const { Inbox } = load();
        // The block and the trace on their own: the attachment chip beside them has a link of its own, from the event, and is not what is asked about here.
        const markup = String(Inbox.perceptionMarkup(reel({}, { kind: 'constructor', status: 'ok', about_owner: '__proto__', model: 'a" class="evil', seen: 'http://evil.test/x.png' })))
            + String(Inbox.perceptionMarkup(reel({}, { kind: 'constructor', status: 'failed', reason: '__proto__' })))
            + String(Inbox.aiMetaDetail(reply({ perceived: true, next_action: 'constructor', reason: 'https://evil.test/' })));
        assert.ok(!/class="[^"]*(constructor|__proto__|evil)/.test(markup), 'no class comes from a field');
        assert.ok(!/\s(href|src)=/.test(markup), 'no link or picture comes from a model\'s field, even one that is a URL');
        assert.ok(markup.includes('http://evil.test/x.png') && markup.includes('https://evil.test/'), 'a URL a model wrote is shown as the text it is');
    });
});

// ─── The whole log ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Inbox: a reel, then the reply that answered it', () => {
    it('paints the description under the reel and the trace under the reply, in the order they happened', () => {
        const { h, Inbox, t } = load();
        const container = h.el('chat-messages-container', {
            scrollHeight: 0, scrollTop: 0, clientHeight: 0,
            insertAdjacentHTML(this: Json, _where: string, markup: string) { this.innerHTML += markup; },
        } as Json);
        Inbox.messagesPainted = false;
        Inbox.renderedMessageIds = new Set();
        Inbox.renderMessages([reel({ handled_at: '2026-10-30T10:00:12.000Z' }), reply(META)], true);
        const log = String(container.innerHTML);
        const seen = log.indexOf('data-perception="ok"');
        const bubble = log.indexOf('ده بيشرح الـ decorators');
        const traced = log.indexOf('data-ai-trace');
        assert.ok(seen > 0 && bubble > seen && traced > bubble, `${seen} < ${bubble} < ${traced}`);
        assert.ok(text(log).includes(t('inbox.perception.seen')) && text(log).includes(META.reason));
    });
});

// ─── The server's answer, and the stylesheet ─────────────────────────────────────────────────────────────────────────────

describe('Inbox: where the data and the look come from', () => {
    it('reads `perception` and `ai_meta` off the row the messages route sends, with no field of its own to ask for', () => {
        const route = readFileSync('src/routes/api.ts', 'utf8');
        assert.match(route, /'SELECT \* FROM messages WHERE conversation_id = \$1 ORDER BY created_at DESC LIMIT 100'/, 'the whole row, so the column v60 added comes with it');
    });

    it('mirrors the trace\'s arrow for Arabic, and styles the block it adds in the transcript\'s own way', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /html\[dir='rtl'\] \[data-lucide='arrow-right'\]/, 'the arrow points the reading way');
        for (const rule of ['.msg-seen .msg-transcript-label', '.msg-trace {', '.msg-trace-step', '.msg-trace-arrow']) assert.ok(css.includes(rule), rule);
        assert.equal(/\.(msg-seen|msg-trace)[^{]*\{[^}]*\b(margin-left|margin-right|padding-left|padding-right|left|right|text-align:\s*(left|right))\b/.test(css), false, 'logical properties only');
    });
});
