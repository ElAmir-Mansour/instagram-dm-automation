/**
 * The voice arm (`voice.ts`): that a voice note is answered as the customer's own words (so the pre-filter reads the transcript as it reads anything typed), that fewer than two words
 * is a request to send it again, that a failure to hear is said and never a guess, that the transcription is counted once, and that the product's own `transcribeVoice` is reached
 * with the case's audio in place of a download and the key-only speech client in place of the settings-bound one. The adapter is tried twice: against a stand-in module (the mapping of
 * what it says), and against the product's own module as merged, with only the network and the decoder's binary replaced (what it really sends, to whom, and what it does with a refusal).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import { kitFor } from '../../profile/kits.js';
import { setLogSink } from '../../../utils/log.js';
import type { ArmDeps } from './arms.js';
import { Ledger, makeEvalCaller } from './caller.js';
import type { LoadedMedia } from './cases.js';
import { asrUrl } from '../../llm/metaAsr.js';
import * as realAsr from '../../llm/metaAsr.js';
import { parseMultipart, wavBytes } from '../../llm/testAudio.js';
import * as realKeywords from '../keywords.js';
import * as realVoice from '../voice.js';
import { caseOf, chatAnswer, lastUserText, META_KEY, scriptedFetch, systemText, type Recorded, type Scripted } from './testSupport.js';
import { adaptVoice, decoderMissing, keywordsFor, MAX_KEYWORDS, runVoiceCase, type AsrModule, type KeywordsModule, type TranscribeVoice, type VoiceHeard, type VoiceModule, type VoiceModuleResult } from './voice.js';

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
    interface Seen { input?: { creatorId: string; link: string | null | undefined; keywords?: readonly string[] }; asr?: { apiKey: string; wav: Uint8Array; keywords?: readonly string[]; timeoutMs?: number }; downloaded?: unknown }

    function modules(result: (heard: { transcript: string; usd: number }) => VoiceModuleResult, seen: Seen = {}): { mod: VoiceModule; asr: AsrModule } {
        const mod: VoiceModule = {
            async transcribeVoice(input, d) {
                seen.input = input;
                seen.downloaded = await d!.download!(input.link, { connectMs: 15_000, totalMs: 30_000 });
                const h = await d!.transcribe!({ creatorId: input.creatorId, wav: new Uint8Array([82, 73, 70, 70]), timeoutMs: 21_000, ...(input.keywords ? { keywords: input.keywords } : {}) });
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
        assert.equal(seen.asr?.timeoutMs, 21_000, 'the deadline the module cut for the call is the one the call gets');
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

// ─── The product's own module, as merged ────────────────────────────────────────────────────────────────────────────────

describe('the product\'s own voice module, with only the network and the decoder\'s binary replaced', () => {
    const input = { caseId: 'voice-payment', bytes: AUDIO.bytes, mime: AUDIO.mime, keywords: ['not used: the module\'s own list is'], source: resolveFixture('owner-ar').ctx, language: 'Arabic' as const };
    const asrAnswer = (over: Record<string, unknown> = {}): Scripted => ({ json: { transcript: 'ممكن ادفع بفودافون كاش', audioDurationMs: 5000, sessionId: 'sess-1', ...over } });

    function world(respond: (r: Recorded, n: number) => Scripted = () => asrAnswer(), decodeAs: 'wav' | { reason: 'decode_failed' | 'empty' | 'too_long' | 'decoder_unavailable'; detail?: string } = 'wav') {
        const { fetch, requests } = scriptedFetch(respond);
        const decoded: { bytes: Uint8Array; timeoutMs: number }[] = [];
        const wav = wavBytes({ seconds: 2, tone: true });
        const decode = async (bytes: Uint8Array, options: { timeoutMs: number }) => {
            decoded.push({ bytes, timeoutMs: options.timeoutMs });
            return decodeAs === 'wav' ? { ok: true as const, wav, durationMs: 2000, ms: 12 } : { ok: false as const, ...decodeAs, ms: 3 };
        };
        const transcribe = adaptVoice(realVoice, realAsr, { apiKey: META_KEY, fetchImpl: fetch, decode, keywords: realKeywords });
        return { transcribe, requests, decoded, wav };
    }

    it('sends what the product sends and no more: one multipart upload to Meta\'s speech address, the key in the header, the account\'s own names to listen for, the decoded audio', async () => {
        const w = world();
        const out = await w.transcribe(input);
        assert.deepEqual([out.status, out.transcript, out.usd], ['ok', 'ممكن ادفع بفودافون كاش', 0.00025], '5 s of audio at $0.18 an hour');
        assert.ok(out.ms >= 0);

        // The case's own bytes went to the decoder, with the deadline the module cut for it; nothing was downloaded from anywhere.
        assert.equal(w.decoded.length, 1);
        assert.deepEqual([...w.decoded[0]!.bytes], [...AUDIO.bytes]);
        assert.ok(w.decoded[0]!.timeoutMs > 0 && w.decoded[0]!.timeoutMs <= 10_000);
        assert.equal(w.requests.length, 1, 'one request in all: the speech call');

        const r = w.requests[0]!;
        assert.equal(r.url, asrUrl());
        assert.equal(r.host, 'api.meta.ai');
        assert.equal(r.method, 'POST');
        assert.equal(r.authorization, `Bearer ${META_KEY}`);
        assert.match(r.contentType ?? '', /^multipart\/form-data; boundary=/);
        const parts = parseMultipart(r.bytes!, r.contentType!);
        assert.deepEqual(parts.map((p) => p.name), ['request', 'audio']);
        const request = JSON.parse(parts[0]!.data.toString('utf8')) as { model: string; audioEncoding: string; languageBias: string[]; keywords?: string[] };
        assert.deepEqual([request.model, request.audioEncoding, request.languageBias], ['muse-voice-transcribe-1.0', 'WAV', ['Arabic', 'English']]);
        assert.deepEqual(request.keywords, realKeywords.voiceKeywords(input.source), 'the product\'s own list of names, and not the one the case offered');
        assert.ok((request.keywords ?? []).length > 0);
        assert.deepEqual([...parts[1]!.data], [...w.wav], 'the audio the decoder made');
        assert.equal(Buffer.from(r.bytes!).includes(META_KEY), false, 'the key is in the header and nowhere in the upload');
    });

    it('is an unreadable note, with what little it heard, when Meta hears one word', async () => {
        const out = await world(() => asrAnswer({ transcript: 'ألو', audioDurationMs: 1000 })).transcribe(input);
        assert.deepEqual([out.status, out.transcript, out.reason], ['unreadable', 'ألو', 'empty_transcript']);
    });

    it('is a failure that says the audio would not decode, with the decoder\'s own words, and asks Meta nothing', async () => {
        const w = world(() => asrAnswer(), { reason: 'decode_failed', detail: 'Invalid data found' });
        const out = await w.transcribe(input);
        assert.deepEqual([out.status, out.reason], ['failed', 'decode_failed: decode_failed: Invalid data found']);
        assert.equal(w.requests.length, 0);
    });

    it('tries a passing failure once more, as the product does, and a refusal never: a 500 then an answer is heard, a 429 and a 401 are one request each', async () => {
        const flaky = world((_r, n) => (n === 1 ? { status: 500, json: { error: { message: 'upstream' } } } : asrAnswer()));
        assert.equal((await flaky.transcribe(input)).status, 'ok');
        assert.equal(flaky.requests.length, 2);

        const limited = world(() => ({ status: 429, json: { error: { message: 'slow down' } }, headers: { 'retry-after': '30' } }));
        const rate = await limited.transcribe(input);
        assert.deepEqual([rate.status, rate.reason], ['failed', 'provider_error: rate_429']);
        assert.equal(limited.requests.length, 1);

        const refused = world(() => ({ status: 401, text: JSON.stringify({ error: { message: `bad key ${META_KEY}` } }) }));
        const auth = await refused.transcribe(input);
        assert.deepEqual([auth.status, auth.reason], ['failed', 'provider_error: auth_401']);
        assert.equal(refused.requests.length, 1);
        assert.equal(JSON.stringify(auth).includes(META_KEY), false);
    });

    it('is priced from the audio Meta says it processed, with no row written anywhere', async () => {
        const out = await world(() => asrAnswer({ audioDurationMs: 36_000 })).transcribe(input);
        assert.equal(out.usd, realAsr.asrUsd(36_000));
        assert.equal(out.usd, 0.0018);
    });
});

describe('decoderMissing', () => {
    it('says the package is missing when the module finds no binary, and nothing when it finds one or says nothing', async () => {
        assert.match(String(await decoderMissing({ ffmpegBinary: async () => null })), /ffmpeg-static package is missing from node_modules\): run npm install/);
        assert.equal(await decoderMissing({ ffmpegBinary: async () => '/bin/ffmpeg' }), null);
        assert.equal(await decoderMissing({}), null, 'a decoder with no such check is not guessed about');
        assert.equal(await decoderMissing(null), null);
    });
});
