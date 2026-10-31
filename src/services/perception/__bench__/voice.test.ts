/**
 * The voice arm (`voice.ts`): that a voice note is answered as the customer's own words (so the pre-filter reads the transcript as it reads anything typed), that fewer than two words
 * is a request to send it again, that a failure to hear is said and never a guess, that the transcription is counted once, and that the product's own `transcribeVoice` is reached
 * with the case's audio in place of a download and the key-only speech client in place of the settings-bound one. The module the adapter wraps is a stand-in of the shape P3 commits.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import { kitFor } from '../../profile/kits.js';
import { setLogSink } from '../../../utils/log.js';
import type { ArmDeps } from './arms.js';
import { Ledger, makeEvalCaller } from './caller.js';
import type { LoadedMedia } from './cases.js';
import { caseOf, chatAnswer, lastUserText, META_KEY, scriptedFetch, systemText, type Recorded, type Scripted } from './testSupport.js';
import { adaptVoice, keywordsFor, MAX_KEYWORDS, runVoiceCase, type AsrModule, type KeywordsModule, type TranscribeVoice, type VoiceHeard, type VoiceModule, type VoiceModuleResult } from './voice.js';

setLogSink(() => {});

const AUDIO: LoadedMedia = { bytes: Buffer.from('pretend m4a bytes'), mime: 'audio/mp4', mediaKind: 'audio' };
const SALES = (over: Record<string, unknown> = {}) => ({
    intent: 'info', stage: 'handoff', next_action: 'handoff', offer_id: 'none', handoff_reason: 'unsure', text: 'x', quick_replies: [], ...over,
});

function deps(sales: (r: Recorded) => Scripted = () => chatAnswer(SALES())): { deps: ArmDeps; salesCalls: Recorded[]; ledger: Ledger; clock: { t: number } } {
    const { fetch, requests } = scriptedFetch((r) => sales(r));
    const ledger = new Ledger();
    const clock = { t: 0 };
    return {
        deps: { sales: makeEvalCaller({ provider: 'meta', model: 'muse-spark-1.3', effort: 'low', role: 'reply', apiKey: META_KEY, ledger, fetchImpl: fetch }), judge: null, ledger, todayText: true, clock: () => clock.t },
        salesCalls: requests, ledger, clock,
    };
}

const heard = (over: Partial<VoiceHeard> = {}): VoiceHeard => ({ status: 'ok', transcript: 'ممكن ادفع بفودافون كاش معنديش فيزا', ms: 3000, usd: 0.0003, ...over });
const transcriber = (h: VoiceHeard | (() => VoiceHeard), clock?: { t: number }): TranscribeVoice => async () => {
    const value = typeof h === 'function' ? h() : h;
    if (clock) clock.t += value.ms;
    return value;
};

describe('keywordsFor', () => {
    it('is the account\'s offer and brand names, once each, longest first, at most twenty: the words a dialect voice note is likely to get wrong', () => {
        const words = keywordsFor(caseOf('voice-payment'));
        assert.ok(words.length > 0 && words.length <= MAX_KEYWORDS);
        assert.equal(new Set(words).size, words.length);
        const lengths = words.map((w) => w.length);
        assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
        const offers = resolveFixture('owner-ar').ctx.offers.map((o) => o.name);
        assert.ok(offers.some((n) => words.includes(n.trim())), 'an offer\'s name is among them');
    });
});

describe('runVoiceCase', () => {
    it('answers a transcript as the customer\'s own words: the sales turn reads it as the message, with no "what was sent" fact', async () => {
        const w = deps();
        const c = caseOf('voice-payment');
        const r = await runVoiceCase(c, AUDIO, transcriber(heard(), w.clock), w.deps);
        assert.equal(w.salesCalls.length, 1);
        assert.equal(lastUserText(w.salesCalls[0]!), 'ممكن ادفع بفودافون كاش معنديش فيزا');
        assert.doesNotMatch(systemText(w.salesCalls[0]!), /What the customer sent/);
        assert.equal(r.arm, 'voice');
        assert.equal(r.action, 'handoff');
        assert.equal(r.actionOk, true);
        assert.equal(r.understood, true);
        assert.equal(r.seen, 'ممكن ادفع بفودافون كاش معنديش فيزا');
        assert.deepEqual(r.failures, []);
    });

    it('counts the speech call once: its dollars and its time are added to the reply\'s, and the ledger does not hold them a second time', async () => {
        const w = deps();
        const r = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ usd: 0.0007, ms: 3000 }), w.clock), w.deps);
        const reply = w.ledger.totalsFor('voice-payment');
        assert.equal(w.ledger.calls.every((c) => c.role === 'reply'), true);
        assert.equal(r.usd, Math.round((reply.usd + 0.0007) * 1e9) / 1e9);
        assert.ok(r.ms >= 3000, 'hearing it took 3 s, and the answer comes after');
    });

    it('reads the transcript for a refund as it reads anything typed: the pre-filter decides, and no model is asked', async () => {
        const w = deps();
        const r = await runVoiceCase(caseOf('voice-price-certificate'), AUDIO, transcriber(heard({ transcript: 'عايز استرجاع فلوسي حالا' }), w.clock), w.deps);
        assert.equal(w.salesCalls.length, 0);
        assert.equal(r.action, 'handoff');
        assert.equal(r.actionOk, false, 'the case expected an answer about the certificate');
    });

    it('asks for fewer than two words to be sent again: it is not words to answer', async () => {
        const w = deps();
        const r = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ status: 'unreadable', transcript: 'hmm' })), w.deps);
        assert.equal(w.salesCalls.length, 0);
        assert.equal(r.action, 'resend');
        assert.equal(r.reply, kitFor(resolveFixture('owner-ar').ctx.language).attachments.resend);
        assert.equal(r.actionOk, false);
        assert.match(r.actionWhy ?? '', /asked for it to be sent again, because it could not be heard; expected a hand-off to a person/);
        const one = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ status: 'ok', transcript: 'hello' })), deps().deps);
        assert.equal(one.action, 'resend', 'one word, even from an answered call');
    });

    it('says a transcription that failed was not heard, with why, and never guesses', async () => {
        const w = deps();
        const r = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ status: 'failed', transcript: '', reason: 'timeout: asr' })), w.deps);
        assert.equal(r.action, 'resend');
        assert.equal(r.understood, false);
        assert.match(r.understoodWhy ?? '', /it ended failed \(timeout: asr\)/);
        assert.match(r.trace ?? '', /^Could not hear it \(failed: timeout: asr\)\.$/);
        assert.equal(r.seen, null);
    });

    it('survives a transcriber that throws: the case fails with a reason, with a key taken out of it', async () => {
        const w = deps();
        const r = await runVoiceCase(caseOf('voice-payment'), AUDIO, async () => { throw new Error(`boom ${META_KEY}`); }, w.deps);
        assert.equal(r.action, 'resend');
        assert.equal(r.understood, false);
        assert.doesNotMatch(JSON.stringify(r), new RegExp(META_KEY));
    });

    it('reports how far off the words were, against what the note was meant to say', async () => {
        const w = deps();
        const exact = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ transcript: 'ممكن ادفع بفودافون كاش معنديش فيزا' })), w.deps);
        assert.match(exact.trace ?? '', /word error rate 0\.00/);
        const off = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ transcript: 'ممكن ادفع ويب كام كاش معنديش فيزا' })), deps().deps);
        assert.match(off.trace ?? '', /word error rate 0\.(?:17|2\d|3\d)/);
    });

    it('is a miss when the words do not hold what the note was about', async () => {
        const w = deps();
        const r = await runVoiceCase(caseOf('voice-payment'), AUDIO, transcriber(heard({ transcript: 'السلام عليكم كيف الحال اليوم' })), w.deps);
        assert.equal(r.understood, false);
        assert.match(r.understoodWhy ?? '', /what it reported lacks «فودافون»/);
    });
});

// ─── The product's module, as P3 commits it ────────────────────────────────────────────────────────────────────────────────

describe('adaptVoice', () => {
    interface Seen { input?: { creatorId: string; link: string | null | undefined; keywords?: readonly string[] }; asr?: { apiKey: string; wav: Uint8Array; keywords?: readonly string[] }; downloaded?: unknown }

    function modules(result: (heard: { transcript: string; usd: number }) => VoiceModuleResult, seen: Seen = {}): { mod: VoiceModule; asr: AsrModule } {
        const mod: VoiceModule = {
            async transcribeVoice(input, d) {
                seen.input = input;
                seen.downloaded = await d!.download!(input.link);
                const h = await d!.transcribe!({ creatorId: input.creatorId, wav: new Uint8Array([82, 73, 70, 70]), ...(input.keywords ? { keywords: input.keywords } : {}) });
                return result(h);
            },
        };
        const asr: AsrModule = {
            async callMetaAsr(args) { seen.asr = args; return { transcript: 'ممكن ادفع بفودافون كاش', durationMs: 5000, model: 'muse-voice-transcribe-1.0' }; },
            asrUsd: (ms) => Math.round((ms / 3_600_000) * 0.18 * 1e9) / 1e9,
        };
        return { mod, asr };
    }
    const input = { caseId: 'voice-payment', bytes: AUDIO.bytes, mime: AUDIO.mime, keywords: ['Alpha offer', 'Beta'], source: resolveFixture('owner-ar').ctx, language: 'Arabic' as const };

    it('runs the product\'s own transcribeVoice with the case\'s audio for the download and the speech client for the call, priced as the product prices it', async () => {
        const seen: Seen = {};
        const { mod, asr } = modules((h) => ({ ok: true, status: 'ok', transcript: h.transcript, usd: h.usd, ms: 4321 }), seen);
        const out = await adaptVoice(mod, asr, { apiKey: META_KEY })(input);
        assert.deepEqual(seen.downloaded, { ok: true, media: { mediaKind: 'audio', mime: 'audio/mp4', bytes: AUDIO.bytes, host: 'benchmark.local', ms: 0 } });
        assert.equal(seen.asr?.apiKey, META_KEY);
        assert.deepEqual([...(seen.asr?.wav ?? [])], [82, 73, 70, 70]);
        assert.deepEqual(seen.asr?.keywords, ['Alpha offer', 'Beta']);
        assert.deepEqual(seen.input?.keywords, ['Alpha offer', 'Beta']);
        assert.equal(seen.input?.creatorId, 'benchmark-creator');
        assert.match(String(seen.input?.link), /^https:\/\/lookaside\.fbsbx\.com\//, 'a stand-in link that is never fetched');
        assert.deepEqual(out, { status: 'ok', transcript: 'ممكن ادفع بفودافون كاش', ms: 4321, usd: 0.00025 });
    });

    it('uses the product\'s own list of names when that module is there, over the benchmark\'s', async () => {
        const seen: Seen = {};
        const { mod, asr } = modules((h) => ({ ok: true, status: 'ok', transcript: h.transcript, usd: h.usd, ms: 1 }), seen);
        const keywords: KeywordsModule = { voiceKeywords: (profile) => [`from the module: ${profile.offers.length > 0 ? 'offers' : 'none'}`] };
        await adaptVoice(mod, asr, { apiKey: META_KEY, keywords })(input);
        assert.deepEqual(seen.input?.keywords, ['from the module: offers']);
    });

    it('maps what the module says it could not do: unreadable stays unreadable, a skip and a failure are failures with the reason and the detail', async () => {
        const unreadable = modules(() => ({ ok: false, status: 'unreadable', reason: 'empty_transcript', transcript: 'hmm', usd: 0.0001, ms: 900 }));
        assert.deepEqual(await adaptVoice(unreadable.mod, unreadable.asr, { apiKey: META_KEY })(input), { status: 'unreadable', transcript: 'hmm', ms: 900, usd: 0.0001, reason: 'empty_transcript' });
        const skipped = modules(() => ({ ok: false, status: 'skipped', reason: 'no_key', usd: 0, ms: 5 }));
        assert.deepEqual(await adaptVoice(skipped.mod, skipped.asr, { apiKey: META_KEY })(input), { status: 'failed', transcript: '', ms: 5, usd: 0, reason: 'no_key' });
        const failed = modules(() => ({ ok: false, status: 'failed', reason: 'fetch_failed', detail: 'decoder_unavailable: no ffmpeg', usd: 0, ms: 7 }));
        assert.equal((await adaptVoice(failed.mod, failed.asr, { apiKey: META_KEY })(input)).reason, 'fetch_failed: decoder_unavailable: no ffmpeg');
    });
});
