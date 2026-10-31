/**
 * The two arms (`arms.ts`), with the network mocked: that the Meta arm does what the webhook does with a word-less message, piece for piece (the same parser reads the event, the same
 * decision picks what to show, the pinned prompt goes out with the picture, the sales turn is drafted from the description with the pre-filter off, a personal document is handed over
 * without a model and an unreadable one is sent back), that nothing is sent, typed, told to an owner or fetched from anywhere but Meta, and that the Today arm is the fixed line the
 * agent sent before Muse, with no model.
 *
 * Every model call here is a scripted `fetch`: it answers what Meta would, and records each request, so a test can say what left (and that nothing else did).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setAiCaller } from '../../aiProviders/generate.js';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import type { TurnOutcome } from '../../dmSales/__evals__/types.js';
import { kitFor } from '../../profile/kits.js';
import { setLogSink } from '../../../utils/log.js';
import { primaryRef } from '../dm.js';
import {
    actionOfTurn, judgeUnderstood, messageFor, readCase, runMetaCase, runTodayCase, scoreTurn, type ArmDeps,
} from './arms.js';
import type { LoadedMedia } from './cases.js';
import { Ledger, makeAiCaller, makeEvalCaller } from './caller.js';
import { caseOf, chatAnswer, hasMedia, lastUserText, META_KEY, scriptedFetch, systemText, type Recorded, type Scripted } from './testSupport.js';
import type { MuseCase } from './types.js';

setLogSink(() => {});

const SEEN = (over: Record<string, unknown> = {}) => ({
    readable: true, seen: 'A screenshot of a price: 299 Egyptian pounds, with a 50% discount until 5 November.', transcript: '', about_owner: 'unclear', confidence: 0.9, mention_summary: '', ...over,
});
const SALES = (over: Record<string, unknown> = {}) => ({
    intent: 'price', stage: 'link', next_action: 'send_link', offer_id: 'main', handoff_reason: 'none', text: 'هلا فيك! السعر الحالي موضّح في صفحة العرض، وهذا الرابط.', quick_replies: [], ...over,
});

const PICTURE: LoadedMedia = { bytes: Buffer.from('pretend these are the bytes of a picture'), mime: 'image/png', mediaKind: 'image' };
const CLIP: LoadedMedia = { bytes: Buffer.from('pretend these are the bytes of a video'), mime: 'video/mp4', mediaKind: 'video' };

interface World {
    deps: ArmDeps;
    requests: Recorded[];
    ledger: Ledger;
    perceptionCalls: () => Recorded[];
    salesCalls: () => Recorded[];
}

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

/** A world in which Meta answers perception and sales from the scripts given. Nothing else answers. */
function world(script: { perception?: (r: Recorded, n: number) => Scripted; sales?: (r: Recorded, n: number) => Scripted; todayText?: boolean } = {}): World {
    let perceptions = 0;
    let sales = 0;
    const { fetch, requests } = scriptedFetch((r) => (hasMedia(r)
        ? (script.perception ?? (() => chatAnswer(SEEN())))(r, ++perceptions)
        : (script.sales ?? (() => chatAnswer(SALES())))(r, ++sales)));
    const ledger = new Ledger();
    const previous = setAiCaller(makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger, fetchImpl: fetch }));
    restore = () => { setAiCaller(previous); };
    const caller = makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch });
    return {
        deps: { sales: caller, judge: null, ledger, todayText: script.todayText ?? true }, requests, ledger,
        perceptionCalls: () => requests.filter(hasMedia), salesCalls: () => requests.filter((r) => !hasMedia(r)),
    };
}

const never = (): Scripted => { throw new Error('no model may be asked'); };

describe('the event a case is read as', () => {
    it('is built the way Instagram sends it, so the webhook\'s own parser reads it: a photo, a video, a story mention, a shared reel with its id and caption', () => {
        const kinds = (id: string) => primaryRef(messageFor(caseOf(id)))?.kind ?? null;
        assert.equal(kinds('image-price'), 'image');
        assert.equal(kinds('video-price'), 'video');
        assert.equal(kinds('story-mention'), 'story_mention');
        assert.equal(kinds('reel-own-riyal'), 'reel');
        assert.equal(kinds('reel-other'), 'reel');
        const own = primaryRef(messageFor(caseOf('reel-own-riyal')))!;
        assert.ok(own.reelVideoId, 'the id the Graph lookup asks for');
        assert.equal(own.url, null, 'a shared reel\'s link is a web page: it is never downloaded');
        assert.equal(own.title, null, 'the account\'s own reel is watched, so the caption is not given to the model');
        const other = primaryRef(messageFor(caseOf('reel-other')))!;
        assert.match(other.title ?? '', /بيتزا/);
    });

    it('holds nothing Muse reads for a voice note: that is the voice arm\'s, and until it lands the pipeline sends the fixed line', () => {
        assert.equal(primaryRef(messageFor(caseOf('voice-payment'))), null);
    });
});

describe('the Meta arm: a picture with no words', () => {
    it('shows Muse the picture with the pinned prompt, then drafts the sales turn from the description, and says what it did', async () => {
        const w = world();
        const typing: string[] = [];
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps, { onTyping: () => typing.push('typing') });

        // Muse was shown the picture: its bytes, as a data URL after the pinned words, and nothing of any person's.
        assert.equal(w.perceptionCalls().length, 1);
        const parts = w.perceptionCalls()[0]!.body.messages.find((m: any) => m.role === 'user').content;
        assert.match(parts[0].text, /^The customer shared the attached photo in an Instagram DM and wrote nothing with it\. Look at the whole photo/);
        assert.match(parts[0].text, /The account receiving this DM is @/);
        assert.equal(parts[1].image_url.url, `data:image/png;base64,${PICTURE.bytes.toString('base64')}`);

        // The sales turn was told what the customer sent, and read the description as the customer's message.
        assert.equal(w.salesCalls().length, 1);
        assert.match(systemText(w.salesCalls()[0]!), /What the customer sent: a photo\. What it shows: A screenshot of a price: 299/);
        assert.match(lastUserText(w.salesCalls()[0]!), /^\[photo\] A screenshot of a price/);

        // The result.
        assert.equal(r.status, 'ran');
        assert.equal(r.understood, true);
        assert.equal(r.action, 'recommend');
        assert.equal(r.actionOk, true);
        assert.deepEqual(r.invented, { draft: [], sent: [] });
        assert.deepEqual(r.failures, []);
        assert.match(r.reply, /^هلا فيك!/);
        assert.match(r.reply, /the system adds the offer's tracked link/);
        assert.match(r.trace ?? '', /^Read a photo; sent the offer's link/);
        assert.match(r.seen ?? '', /299 Egyptian pounds/);
        assert.equal(r.calls, 2);
        assert.ok(r.usd > 0 && r.tokensIn > 0 && r.tokensOut > 0);
        assert.ok(r.ms >= 0);
        assert.deepEqual(typing, ['typing'], 'the person is shown that someone is working on it, once (nothing is sent: the stand-in only records it)');
    });

    it('talks to Meta and to nobody else: every request of the whole case went to api.meta.ai with the key in the header', async () => {
        const w = world();
        await runMetaCase(caseOf('image-price'), PICTURE, w.deps);
        assert.ok(w.requests.length >= 2);
        for (const r of w.requests) {
            assert.equal(r.host, 'api.meta.ai');
            assert.equal(r.authorization, `Bearer ${META_KEY}`);
            assert.equal(r.rawBody!.includes(META_KEY), false);
        }
    });

    it('does not let a description pass for what the customer said: "refund" in what Muse saw is not a refund request (R9)', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ seen: 'A screenshot of a refund policy page with a complaint form.' })) });
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps);
        assert.equal(w.salesCalls().length, 1, 'the model was asked, and no pre-filter decided');
        assert.equal(r.action, 'recommend');
        assert.match(lastUserText(w.salesCalls()[0]!), /refund policy/);
    });

    it('hands a personal document to a person with no model asked, and says nothing of what was on it', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ seen: 'An identity card of Alex Example, number 1234.', about_owner: 'personal', confidence: 0.97 })) });
        const r = await runMetaCase(caseOf('image-id-card'), PICTURE, w.deps);
        assert.equal(w.salesCalls().length, 0, 'no model is asked what to say about a personal document');
        assert.equal(r.action, 'handoff');
        assert.equal(r.actionOk, true);
        assert.equal(r.understood, true);
        assert.equal(r.seen, 'a personal document');
        assert.equal(r.reply, resolveFixture('owner-ar').ctx.handoff?.message.trim() || kitFor(resolveFixture('owner-ar').ctx.language).sales.lines.handoff('x'));
        assert.doesNotMatch(r.reply, /Alex|1234|identity/i);
        assert.match(r.trace ?? '', /it is a personal document, so the chat went to a person without describing it/);
        assert.deepEqual(r.failures, []);
    });

    it('asks for a picture it could not read to be sent again, and never states a guess', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ readable: false, confidence: 0.2, seen: 'Some garbled characters, maybe a price' })) });
        const r = await runMetaCase(caseOf('image-garbled'), PICTURE, w.deps);
        assert.equal(w.salesCalls().length, 0);
        assert.equal(r.action, 'resend');
        assert.equal(r.actionOk, true);
        assert.equal(r.understood, true, 'knowing it could not read it counts as understanding');
        assert.equal(r.reply, kitFor(resolveFixture('owner-ar').ctx.language).attachments.resend);
        assert.equal(r.seen, null, 'a guess is not kept');
    });

    it('counts a picture it read, when the case said it could not be read, as not understood', async () => {
        const w = world();
        const r = await runMetaCase(caseOf('image-garbled'), PICTURE, w.deps);
        assert.equal(r.understood, false);
        assert.match(r.understoodWhy ?? '', /it described what could not be read/);
        assert.ok(r.failures.some((f) => f.what === 'understood'));
    });

    it('finds what a failing Muse leaves: today\'s fixed line, a miss with the reason in a line, and the owner told once when the key is refused', async () => {
        const w = world({ perception: () => ({ status: 500, json: { error: { message: 'down' } } }) });
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps);
        assert.equal(r.action, 'generic_line');
        assert.equal(r.actionOk, false);
        assert.equal(r.actionWhy, 'Could not read it: the reading service could not read it, so it sent the usual line (expected a recommendation or an answer)');
        assert.equal(r.understood, false);
        assert.match(r.understoodWhy ?? '', /it ended failed \(provider_error\)/);
        assert.equal(w.salesCalls().length, 0);
        assert.deepEqual(r.failures.map((f) => f.what).sort(), ['action', 'understood']);
    });

    it('does not tell an owner anything when the key is refused: the stand-in is called, never the default that sends a notice', async () => {
        const w = world({ perception: () => ({ status: 401, json: { error: { message: 'bad key', code: 401 } } }) });
        const trouble: string[] = [];
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps, { onTrouble: (k) => trouble.push(k) });
        assert.deepEqual(trouble, ['auth']);
        assert.equal(r.action, 'generic_line');
        assert.ok(r.failures.length >= 1);
    });

    it('records a model that made no answer as an error and not as a hand-off it did not make', async () => {
        const w = world({ sales: () => ({ status: 500, json: { error: { message: 'down' } } }) });
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps);
        assert.equal(r.action, 'error');
        assert.equal(r.actionOk, false);
        assert.match(r.actionWhy ?? '', /the model did not answer/);
    });
});

describe('the Meta arm: typed words', () => {
    it('makes the words the question and tells the model what was shared as a fact beside them; the words never go to the reading', async () => {
        const w = world({ sales: () => chatAnswer(SALES({ text: 'Hi! The current price is shown on the offer page. Here is the link.' })) });
        const c = caseOf('image-price-words-en');
        const r = await runMetaCase(c, PICTURE, w.deps);
        const perception = w.perceptionCalls()[0]!;
        assert.match(perception.rawBody!, /wrote a message with it \(you are not shown it\)/);
        assert.equal(perception.rawBody!.includes(c.typed!), false, 'what the customer typed is not sent to the reading');
        assert.match(systemText(w.salesCalls()[0]!), /What the customer sent: a photo/);
        assert.equal(lastUserText(w.salesCalls()[0]!), c.typed);
        assert.equal(r.action, 'recommend');
        assert.deepEqual(r.failures, []);
    });

    it('answers the words alone when the media could not be read (the product does the same for a reply to a story)', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ readable: false, confidence: 0.1 })), sales: () => chatAnswer(SALES({ text: 'Hi! The current price is shown on the offer page. Here is the link.' })) });
        const r = await runMetaCase(caseOf('image-price-words-en'), PICTURE, w.deps);
        assert.doesNotMatch(systemText(w.salesCalls()[0]!), /What the customer sent/);
        assert.equal(r.understood, false);
    });

    it('does not use what a personal document showed, even with words beside it', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ about_owner: 'personal', seen: 'An identity card' })) });
        await runMetaCase(caseOf('image-price-words-en'), PICTURE, w.deps);
        assert.doesNotMatch(systemText(w.salesCalls()[0]!), /identity card/i);
    });
});

describe('the Meta arm: a reel, a story mention', () => {
    it('watches the account\'s own reel: the video goes out as a data URL, the description says it was watched and that it is the account\'s own', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ seen: 'A reel about a meal priced at 45 riyals and paid for with 1 riyal; the backend server trusts the price.' })), sales: () => chatAnswer(SALES({ next_action: 'ask_qualifier', offer_id: 'none', stage: 'qualify', text: 'هلا فيك! الريل يشرح الفرق بين الفرونت إند والباك إند. وش اللي تبي تعرفه عنه؟' })) });
        const r = await runMetaCase(caseOf('reel-own-riyal'), CLIP, w.deps);
        const parts = w.perceptionCalls()[0]!.body.messages.find((m: any) => m.role === 'user').content;
        assert.match(parts[0].text, /^The customer shared the attached reel in an Instagram DM and wrote nothing with it\. Watch the whole reel/);
        assert.equal(parts[1].video_url.url, `data:video/mp4;base64,${CLIP.bytes.toString('base64')}`);
        assert.match(r.seen ?? '', /^Watched the reel\. /);
        assert.match(systemText(w.salesCalls()[0]!), /It is the account's own content\./);
        assert.match(r.trace ?? '', /^Watched a shared reel; asked one question to place them/);
        assert.equal(r.action, 'answer');
        assert.equal(r.actionOk, true);
        assert.equal(r.understood, true);
    });

    it('reads another creator\'s reel by its caption alone, with no model asked what it shows, and says so and that it is not the account\'s own', async () => {
        const w = world({ sales: () => chatAnswer(SALES({ next_action: 'reply', offer_id: 'none', stage: 'new', intent: 'off_topic', text: 'هلا فيك! هذا الريل مو من محتوى حسابنا. لو عندك سؤال، أنا هنا.' })) });
        const r = await runMetaCase(caseOf('reel-other'), null, w.deps);
        assert.equal(w.perceptionCalls().length, 0, 'there is nothing to watch: no model was shown anything');
        assert.equal(w.salesCalls().length, 1);
        assert.match(r.seen ?? '', /^Read the caption\. It says: «أسهل بيتزا/);
        assert.match(systemText(w.salesCalls()[0]!), /It is NOT the account's own content: never say that it is\./);
        assert.match(r.trace ?? '', /^Read the caption of a shared reel/);
        assert.equal(r.action, 'answer');
        assert.deepEqual(r.failures, []);
    });

    it('thanks a story mention by what was shared when the summary is fit to say back', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ seen: 'A story saying it is their first day learning Python.', mention_summary: 'تعلم بايثون مع القهوة' })) });
        const r = await runMetaCase(caseOf('story-mention'), PICTURE, w.deps);
        assert.equal(w.salesCalls().length, 0, 'a mention is thanked, never answered by a sales turn');
        assert.equal(r.action, 'thank_named');
        assert.equal(r.actionOk, true);
        assert.match(r.reply, /تعلم بايثون مع القهوة/);
        assert.match(r.trace ?? '', /Read their story mention and thanked them for what they shared/);
        assert.match(w.perceptionCalls()[0]!.rawBody!, /in Arabic/, 'the summary is asked for in the account\'s language');
    });

    it('falls back to the usual thanks when the summary holds a number, and counts that as a miss', async () => {
        const w = world({ perception: () => chatAnswer(SEEN({ seen: 'A story: day 3 of learning Python.', mention_summary: 'اليوم 3 من تعلم بايثون' })) });
        const r = await runMetaCase(caseOf('story-mention'), PICTURE, w.deps);
        assert.equal(r.action, 'thank');
        assert.equal(r.actionOk, false);
        assert.match(r.actionWhy ?? '', /what it showed was not fit to say back, so it sent the usual thanks \(expected a thanks that names what was shared\)$/);
        assert.equal(r.reply, kitFor(resolveFixture('owner-ar').ctx.language).attachments.mention);
    });
});

describe('the Meta arm: invented facts', () => {
    it('counts a price copied from the picture in the first draft, and not as sent: the guard refused it and the customer got the safe line', async () => {
        const w = world({ sales: () => chatAnswer(SALES({ text: 'السعر 299 جنيه والخصم 50%' })) });
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps);
        assert.ok(r.invented.draft.some((d) => d.startsWith('no_invented_numbers:')), r.invented.draft.join(' | '));
        assert.ok(r.invented.draft.some((d) => d.startsWith('forbidden_fact:')));
        assert.deepEqual(r.invented.sent, [], 'what the customer is sent is the safe line');
        assert.equal(r.action, 'handoff', 'the guard\'s safe line is a hand-off');
        assert.equal(r.actionOk, false);
        assert.ok(r.failures.some((f) => f.what === 'no_invented_numbers' && /299/.test(f.reason)));
        assert.equal(r.failures.some((f) => f.what === 'guard'), false, 'the number is named by its own check, and the guard is not named twice');
    });

    it('counts a fact the case forbids as sent when the guard cannot know it: a number the account does hold, that the picture is not allowed to put in a reply', async () => {
        const c: MuseCase = { ...caseOf('image-price-priced'), expect: { ...caseOf('image-price-priced').expect, forbid: ['49'] } };
        const w = world({ sales: () => chatAnswer(SALES({ text: 'هلا فيك! السعر الحالي 49 USD، وهذا الرابط.' })) });
        const r = await runMetaCase(c, PICTURE, w.deps);
        assert.equal(r.invented.draft.length, 1);
        assert.equal(r.invented.sent.length, 1);
        assert.match(r.invented.sent[0]!, /^forbidden_fact: must not match \/49\/ but does/);
    });

    it('does not count a price the account really holds as an invented one', async () => {
        const w = world({ sales: () => chatAnswer(SALES({ text: 'هلا فيك! السعر الحالي 49 USD، وهذا الرابط.' })) });
        const r = await runMetaCase(caseOf('image-price-priced'), PICTURE, w.deps);
        assert.deepEqual(r.invented, { draft: [], sent: [] });
    });

    it('fails a reply that says it cannot open the picture: the line the agent used to send must not come back in the model\'s words', async () => {
        const w = world({ sales: () => chatAnswer(SALES({ next_action: 'reply', offer_id: 'none', text: 'ما أقدر أفتح الصور هنا، اكتب سؤالك.' })) });
        const r = await runMetaCase(caseOf('image-price'), PICTURE, w.deps);
        assert.ok(r.failures.some((f) => f.what === 'patterns'));
    });
});

describe('scoring one drafted turn', () => {
    const fx = resolveFixture('owner-ar');
    const turn = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
        index: 1, user: 'u', route: 'model', prefilter: 'pass', repaired: [], guardFallback: false, sent: { kind: 'model', text: 'ok' }, paused: false, checks: [],
        model: { text: 'ok', quick_replies: [], intent: 'price', stage: 'link', next_action: 'send_link', offer_id: 'main', handoff_reason: 'none' }, ...over,
    });

    it('names the kind of action: a recommendation, an answer, a hand-off, silence, an error', () => {
        assert.equal(actionOfTurn(turn()), 'recommend');
        assert.equal(actionOfTurn(turn({ model: { ...turn().model!, next_action: 'recommend' } })), 'recommend');
        assert.equal(actionOfTurn(turn({ model: { ...turn().model!, next_action: 'reply' } })), 'answer');
        assert.equal(actionOfTurn(turn({ model: { ...turn().model!, next_action: 'ask_qualifier' } })), 'answer');
        assert.equal(actionOfTurn(turn({ sent: { kind: 'handoff', text: 'x' } })), 'handoff');
        assert.equal(actionOfTurn(turn({ sent: { kind: 'unsure', text: 'x' } })), 'handoff');
        assert.equal(actionOfTurn(turn({ sent: { kind: 'none', text: '' } })), 'silent');
        assert.equal(actionOfTurn(turn({ sent: { kind: 'none', text: '' }, model: undefined })), 'error');
        assert.equal(actionOfTurn(turn({ error: { kind: 'timeout', message: 'x' } })), 'error');
    });

    it('is a miss, with the check\'s own line, when the offer is the wrong one even though the action is a recommendation', () => {
        const c = caseOf('image-price');
        const t = turn({ checks: [{ name: 'offer_id', pass: false, detail: 'got course-golang, expected one of main, none' }] });
        const s = scoreTurn(c, 'meta', t, fx);
        assert.equal(s.action, 'recommend');
        assert.equal(s.actionOk, false);
        assert.equal(s.actionWhy, 'offer_id: got course-golang, expected one of main, none');
        assert.deepEqual(s.failures.map((f) => f.what), ['action']);
    });

    it('turns a failing language check into a failure of its own and leaves the action alone', () => {
        const c = caseOf('image-price');
        const s = scoreTurn(c, 'meta', turn({ checks: [{ name: 'reply_language', pass: false, detail: 'expected Arabic, but only 10% of its letters are Arabic' }] }), fx);
        assert.equal(s.actionOk, true);
        assert.deepEqual(s.failures, [{ caseId: c.id, arm: 'meta', what: 'reply_language', reason: 'reply_language'.length ? 'expected Arabic, but only 10% of its letters are Arabic' : '' }]);
    });

    it('reads the judge\'s scores into a mean and a lowest, and fails a score under the floor with the judge\'s own note', () => {
        const c = caseOf('image-price');
        const judged = turn({ judge: { scores: { tone: 5, helpfulness: 4, no_pressure: 5, right_recommendation: 2 }, notes: 'recommended where nothing supports it', usd: 0.03, usage: { in: 1, out: 1 } } });
        const s = scoreTurn(c, 'meta', judged, fx);
        assert.deepEqual(s.judge, { mean: 4, lowest: 2, notes: 'recommended where nothing supports it' });
        assert.ok(s.failures.some((f) => f.what === 'judge' && /scored 2: recommended where nothing supports it/.test(f.reason)));
        const failed = scoreTurn(c, 'meta', turn({ judge: { error: 'the judge said no' } }), fx);
        assert.equal(failed.judge, null);
        assert.ok(failed.failures.some((f) => f.what === 'judge' && /not scored: the judge said no/.test(f.reason)));
    });
});

describe('judgeUnderstood', () => {
    const ok = (over: Record<string, unknown> = {}) => ({ status: 'ok' as const, seen: 'A price of 299 pounds', transcript: undefined, mention_summary: undefined, about_owner: 'unclear' as const, ...over });

    it('wants a word of every group, in any case and any script, in what was seen, said or summarised', () => {
        const spec = { mode: 'shows' as const, groups: [['299', '٢٩٩'], ['price', 'سعر']] };
        assert.equal(judgeUnderstood(spec, ok()).ok, true);
        assert.equal(judgeUnderstood(spec, ok({ seen: 'THE PRICE: ٢٩٩' })).ok, true);
        assert.equal(judgeUnderstood(spec, ok({ seen: 'a number', transcript: 'السعر 299' })).ok, true, 'speech counts');
        const miss = judgeUnderstood(spec, ok({ seen: 'a price list' }));
        assert.equal(miss.ok, false);
        assert.match(miss.why ?? '', /what it reported lacks «299»/);
    });

    it('is not met by a personal document, or by a perception that did not end ok', () => {
        const spec = { mode: 'shows' as const, groups: [['x']] };
        assert.match(judgeUnderstood(spec, ok({ about_owner: 'personal', seen: 'x' })).why ?? '', /personal document/);
        assert.match(judgeUnderstood(spec, { status: 'failed', reason: 'timeout' }).why ?? '', /it ended failed \(timeout\)/);
        assert.match(judgeUnderstood(spec, { status: 'unreadable', reason: 'low_confidence' }).why ?? '', /it ended unreadable/);
    });

    it('has two other modes: it said it could not read it, and it recognised a personal document', () => {
        assert.equal(judgeUnderstood({ mode: 'unreadable' }, { status: 'unreadable' }).ok, true);
        assert.equal(judgeUnderstood({ mode: 'unreadable' }, ok()).ok, false);
        assert.match(judgeUnderstood({ mode: 'unreadable' }, { status: 'failed', reason: 'timeout' }).why ?? '', /not as unreadable/);
        assert.equal(judgeUnderstood({ mode: 'personal' }, ok({ about_owner: 'personal' })).ok, true);
        assert.equal(judgeUnderstood({ mode: 'personal' }, ok()).ok, false);
    });
});

describe('the Today arm', () => {
    it('sends the fixed line of the language kit for a message with no words, with no model asked: that is all the agent did before Muse', async () => {
        const w = world({ perception: never, sales: never });
        const kit = kitFor(resolveFixture('owner-ar').ctx.language).attachments;
        const photo = await runTodayCase(caseOf('image-price'), w.deps);
        assert.equal(photo!.action, 'generic_line');
        assert.equal(photo!.reply, kit.media);
        assert.equal(photo!.understood, false);
        assert.equal(photo!.actionOk, false);
        assert.equal(photo!.calls + photo!.usd + photo!.ms, 0);
        const reel = await runTodayCase(caseOf('reel-own-riyal'), w.deps);
        assert.equal(reel!.reply, kit.media);
        assert.equal(w.requests.length, 0, 'no request left');
    });

    it('thanks a story mention without saying what was shared', async () => {
        const w = world({ perception: never, sales: never });
        const r = await runTodayCase(caseOf('story-mention'), w.deps);
        assert.equal(r!.action, 'thank');
        assert.equal(r!.reply, kitFor(resolveFixture('owner-ar').ctx.language).attachments.mention);
        assert.equal(r!.actionOk, false);
    });

    it('sends nothing to a second photo the same day: the once-a-day rule', async () => {
        const w = world({ perception: never, sales: never });
        const r = await runTodayCase(caseOf('image-price-again'), w.deps);
        assert.equal(r!.action, 'silent');
        assert.equal(r!.reply, '');
        assert.match(r!.actionWhy ?? '', /sent nothing; expected a recommendation or an answer/);
    });

    it('answers a message with words from the words alone, the media never opened: the same sales turn on the same model, with nothing about the picture in front of it', async () => {
        const w = world({ sales: () => chatAnswer(SALES({ next_action: 'ask_qualifier', offer_id: 'none', stage: 'qualify', text: 'Which one do you mean? Tell me what you would like to know.' })) });
        const c = caseOf('image-price-words-en');
        const r = await runTodayCase(c, w.deps);
        assert.equal(w.perceptionCalls().length, 0);
        assert.equal(w.salesCalls().length, 1);
        assert.doesNotMatch(systemText(w.salesCalls()[0]!), /What the customer sent/);
        assert.equal(lastUserText(w.salesCalls()[0]!), c.typed);
        assert.equal(hasMedia(w.requests[0]!), false);
        assert.equal(r!.action, 'answer');
        assert.equal(r!.understood, false);
        assert.ok(r!.calls === 1 && r!.usd > 0);
    });

    it('leaves the cases with words out of the arm when told to: they ask a model, and today\'s answer to a message with no words never does', async () => {
        const w = world({ todayText: false, perception: never, sales: never });
        assert.equal(await runTodayCase(caseOf('image-price-words-en'), w.deps), null);
        assert.equal((await runTodayCase(caseOf('image-price'), w.deps))?.action, 'generic_line');
    });

    it('is the baseline of the voice notes too, under its own name', async () => {
        const w = world({ perception: never, sales: never });
        const r = await runTodayCase(caseOf('voice-payment'), w.deps, 'today_voice');
        assert.equal(r!.arm, 'today_voice');
        assert.equal(r!.reply, kitFor(resolveFixture('owner-ar').ctx.language).attachments.media);
    });
});

describe('reading a case on its own', () => {
    let previous: ReturnType<typeof setAiCaller>;
    beforeEach(() => { previous = setAiCaller(async () => { throw new Error('not set'); }); });
    afterEach(() => { setAiCaller(previous); });

    it('stores nothing, sends nothing and tells no one: every stand-in is called and the real ones are not', async () => {
        const w = world();
        const calls: string[] = [];
        const reading = await readCase(caseOf('image-price'), PICTURE, resolveFixture('owner-ar'), {
            onTyping: () => calls.push('typing'), onTrouble: () => calls.push('trouble'),
            deps: { store: async ({ perception }) => { calls.push('store'); return { ...perception, stored_at: 'then' } as never; } },
        });
        assert.equal(reading.perception.status, 'ok');
        assert.deepEqual(calls, ['typing', 'store']);
        assert.equal(w.requests.length, 1);
    });
});
