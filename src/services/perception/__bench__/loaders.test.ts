/**
 * The loaders (`loaders.ts`) of the two arms that measure another PR's module: that each arm says why it did not run while its file is not in the checkout and runs the module the day
 * it is (with no flag, no edit and no state kept between two looks), that a module that is in but is not what the adapter expects is a note that names the adapter, and never a guess;
 * that a decoder that cannot run is found for nothing before a case is spent on it; and, against the real files of this checkout, that the voice module is wired as merged and that the
 * recall module, when its file arrives, passes the same checks with no change made here.
 *
 * The file system and the importer are stand-ins: no file is added to the repository for a test, and a stand-in module is the whole of what the loader is handed.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setAiCaller } from '../../aiProviders/generate.js';
import { setLogSink } from '../../../utils/log.js';
import { Ledger, makeAiCaller } from './caller.js';
import type { CliKeys } from './cli.js';
import { recallLoader, voiceLoader, type LoaderIo } from './loaders.js';
import { BENCH_LIBRARY_CREATOR, type LibraryRow, type RecallOutcome } from './memory.js';
import { chatAnswer, committed, META_KEY, REPO, scriptedFetch, type Recorded } from './testSupport.js';
import type { VoiceInput } from './voice.js';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';

setLogSink(() => {});

const ROOT = '/repo';
const KEYS: CliKeys = { meta: META_KEY, anthropic: null, baseten: null, from: 'a test' };

/** A checkout in which exactly these modules (named by their path without an extension) are present, and a record of what was imported. */
function checkout(modules: Record<string, unknown>): LoaderIo & { imported: string[]; modules: Record<string, unknown> } {
    const imported: string[] = [];
    const keyOf = (file: string): string => path.relative(ROOT, file).replace(/\.(?:ts|js)$/, '');
    return {
        imported, modules,
        exists: (file) => file.endsWith('.ts') && keyOf(file) in modules,
        importer: async (url) => { imported.push(path.relative(ROOT, fileURLToPath(url))); return modules[keyOf(fileURLToPath(url))]; },
    };
}

const VOICE = 'src/services/perception/voice';
const OLD_VOICE = 'src/services/perception/transcribeVoice';
const ASR = 'src/services/llm/metaAsr';
const DECODER = 'src/services/perception/transcode';
const KEYWORDS = 'src/services/perception/keywords';
const RECALL = 'src/services/perception/recall';

/** A voice module that behaves as the product's does where the adapter touches it: it asks for the download, then for the words, and says what it heard. */
const voiceModule = {
    async transcribeVoice(input: { creatorId: string; link: string; keywords?: string[] }, deps: { download: (l: string, o: unknown) => Promise<unknown>; transcribe: (a: unknown) => Promise<{ transcript: string; usd: number }> }) {
        await deps.download(input.link, { connectMs: 1, totalMs: 1 });
        const heard = await deps.transcribe({ creatorId: input.creatorId, wav: new Uint8Array([82, 73, 70, 70]), keywords: input.keywords, timeoutMs: 20_000 });
        return { ok: true, status: 'ok', transcript: heard.transcript, usd: heard.usd, ms: 7 };
    },
};
const seenByAsr: { apiKey?: string; keywords?: readonly string[] } = {};
const asrModule = {
    async callMetaAsr(args: { apiKey: string; keywords?: readonly string[] }) { seenByAsr.apiKey = args.apiKey; seenByAsr.keywords = args.keywords; return { transcript: 'ممكن ادفع بفودافون كاش', durationMs: 5000, model: 'muse-voice-transcribe-1.0' }; },
    asrUsd: (ms: number) => ms / 20_000_000,
};
const input: VoiceInput = { caseId: 'voice-payment', bytes: Buffer.from('audio'), mime: 'audio/mp4', keywords: ['the benchmark\'s own'], source: resolveFixture('owner-ar').ctx, language: 'Arabic' };

describe('voiceLoader', () => {
    it('says which file it is waiting for while the voice module is not in the checkout, and imports nothing', async () => {
        const io = checkout({});
        const loaded = await voiceLoader(ROOT, io)(KEYS);
        assert.deepEqual(loaded, { present: false, why: 'src/services/perception/voice.ts is not in this checkout yet (the voice notes)' });
        assert.deepEqual(io.imported, []);
    });

    it('finds the module under either name it has had, and the speech client with it', async () => {
        const io = checkout({ [OLD_VOICE]: voiceModule, [ASR]: asrModule });
        const loaded = await voiceLoader(ROOT, io)(KEYS);
        assert.equal(loaded.present, true);
        assert.deepEqual(io.imported, [`${OLD_VOICE}.ts`, `${ASR}.ts`], 'the decoder and the names are looked for too, and are not there to import');
    });

    it('says the speech client is the missing part when the voice module is in and its client is not', async () => {
        const loaded = await voiceLoader(ROOT, checkout({ [VOICE]: voiceModule }))(KEYS);
        assert.deepEqual(loaded, { present: false, why: 'src/services/llm/metaAsr.ts is not in this checkout yet (the speech client)' });
    });

    it('names the adapter to change when a module is in and does not export what it needs, and never guesses', async () => {
        const noVoice = await voiceLoader(ROOT, checkout({ [VOICE]: {}, [ASR]: asrModule }))(KEYS);
        assert.equal(noVoice.present, false);
        assert.match((noVoice as { why: string }).why, /voice\.ts is in, but it does not export transcribeVoice\(\) and metaAsr\.ts callMetaAsr\(\) and asrUsd\(\) as the benchmark expects: adapt voiceLoader in loaders\.ts/);
        const noPrice = await voiceLoader(ROOT, checkout({ [VOICE]: voiceModule, [ASR]: { callMetaAsr: asrModule.callMetaAsr } }))(KEYS);
        assert.equal(noPrice.present, false);
    });

    it('leaves the arm out, with the reason, when the decoder\'s package is not installed, before a single case is read, and does not go on to load the names', async () => {
        const io = checkout({ [VOICE]: voiceModule, [ASR]: asrModule, [DECODER]: { ffmpegBinary: async () => null }, [KEYWORDS]: { voiceKeywords: () => ['x'] } });
        const loaded = await voiceLoader(ROOT, io)(KEYS);
        assert.equal(loaded.present, false);
        assert.match((loaded as { why: string }).why, /the ffmpeg-static package is missing from node_modules\): run npm install, then run this again/);
        assert.equal(io.imported.includes(`${KEYWORDS}.ts`), false);
    });

    it('runs the voice module with the benchmark\'s key and the product\'s own list of names when everything is in', async () => {
        const io = checkout({ [VOICE]: voiceModule, [ASR]: asrModule, [DECODER]: { ffmpegBinary: async () => '/bin/ffmpeg' }, [KEYWORDS]: { voiceKeywords: () => ['from the product'] } });
        const loaded = await voiceLoader(ROOT, io)(KEYS);
        assert.equal(loaded.present, true);
        if (!loaded.present) return;
        const heard = await loaded.value(input);
        assert.deepEqual([heard.status, heard.transcript, heard.usd], ['ok', 'ممكن ادفع بفودافون كاش', 0.00025]);
        assert.equal(seenByAsr.apiKey, META_KEY);
        assert.deepEqual(seenByAsr.keywords, ['from the product']);
    });

    it('uses the benchmark\'s own list of names when the product\'s module for them is not there', async () => {
        const io = checkout({ [VOICE]: voiceModule, [ASR]: asrModule });
        const loaded = await voiceLoader(ROOT, io)(KEYS);
        assert.ok(loaded.present);
        if (loaded.present) await loaded.value(input);
        assert.deepEqual(seenByAsr.keywords, ['the benchmark\'s own']);
    });
});

describe('recallLoader', () => {
    const ledger = new Ledger();

    it('says which file it is waiting for while recall is not in the checkout', async () => {
        const io = checkout({});
        assert.deepEqual(await recallLoader(ROOT, io)(ledger), { present: false, why: 'src/services/perception/recall.ts is not in this checkout yet (the video memory\'s recall)' });
        assert.deepEqual(io.imported, []);
    });

    it('names the adapter to change when recall.ts is in and has no recallForTurn()', async () => {
        const loaded = await recallLoader(ROOT, checkout({ [RECALL]: { somethingElse: () => null } }))(ledger);
        assert.equal(loaded.present, false);
        assert.match((loaded as { why: string }).why, /recall\.ts is in, but it does not export recallForTurn\(\) as the benchmark expects: adapt recallLoader in loaders\.ts/);
    });

    it('switches itself on the day the file is there: the same loader, asked again, finds it, and nothing was kept from the first look', async () => {
        const modules: Record<string, unknown> = {};
        const io = checkout(modules);
        const load = recallLoader(ROOT, io);
        assert.equal((await load(new Ledger())).present, false);
        modules[RECALL] = { recallForTurn: async () => null };
        assert.equal((await load(new Ledger())).present, true);
        assert.deepEqual(io.imported, [`${RECALL}.ts`]);
    });

    it('asks recall as the product does, with the gate open and the library handed in, and takes its cost from the ledger', async () => {
        const mine = new Ledger();
        const calls: { input: unknown; gate: unknown; library: unknown }[] = [];
        const recallModule = {
            async recallForTurn(i: unknown, deps: { gate: (a: unknown) => Promise<unknown>; library: (c: string) => Promise<unknown> }) {
                calls.push({ input: i, gate: await deps.gate({}), library: await deps.library(BENCH_LIBRARY_CREATOR) });
                mine.add({ role: 'recall', provider: 'meta', model: 'muse-spark-1.3', usd: 0.004, priced: true, tokensIn: 9000, tokensOut: 200, cacheRead: 0, ms: 3000, ok: true });
                return { line: 'x', link: 'https://www.instagram.com/reel/r1/', match: { reelId: 'r1', second: 12 } };
            },
        };
        const loaded = await recallLoader(ROOT, checkout({ [RECALL]: recallModule }))(mine);
        assert.ok(loaded.present);
        if (!loaded.present) return;
        const rows = [{ id: 'r1' }] as unknown as LibraryRow[];
        const outcome = await loaded.value('عندك فيديو عن X؟', rows);
        assert.deepEqual(calls, [{ input: { creatorId: BENCH_LIBRARY_CREATOR, senderId: 'benchmark-sender', text: 'عندك فيديو عن X؟' }, gate: { ok: true }, library: rows }]);
        assert.deepEqual([outcome.kind, (outcome as { id?: string }).id, outcome.usd], ['match', 'r1', 0.004]);
    });
});

// ─── The real files of this checkout ──────────────────────────────────────────────────────────────────────────────────────

describe('the voice module of this checkout', () => {
    it('is found, and either wired (when the decoder\'s package is installed) or left out with the decoder as the reason (when it is not): never "not in this checkout"', async () => {
        const loaded = await voiceLoader(REPO)(KEYS);
        if (loaded.present) assert.equal(typeof loaded.value, 'function');
        else assert.match(loaded.why, /the ffmpeg-static package is missing from node_modules\): run npm install/);
    });
});

const RECALL_FILE = path.join(REPO, `${RECALL}.ts`);

describe('the recall module, the day it is in this checkout', { skip: existsSync(RECALL_FILE) ? false : 'src/services/perception/recall.ts is not in this checkout yet: this block runs by itself once it is' }, () => {
    const row = (id: string, posted: string, result: Record<string, unknown>): LibraryRow => ({
        id, creator_id: BENCH_LIBRARY_CREATOR, ig_media_id: `ig-${id}`, permalink: `https://www.instagram.com/reel/${id}/`, youtube_url: null, posted_at: posted, status: 'ok', result, model: 'm', ms: 1, usd: 0.01,
        created_at: posted, updated_at: posted,
    });
    const LIBRARY = [
        row('first', '2026-10-01T10:00:00.000Z', { summary: 'A meal priced at 45 riyals paid for with 1 riyal.', topics: ['backend'], seen_on_screen: ['a man in a green sweater'], narration: 'the server never sees your page', key_moments: [{ second: 12, what: 'the exploit' }] }),
        row('second', '2026-10-05T10:00:00.000Z', { summary: 'Turning study files into a podcast.', topics: ['podcast'], seen_on_screen: ['a purple button that says podcast'], narration: 'comment podcast', key_moments: [] }),
    ];

    it('is switched on by the loader with nothing else changed, and every one of the ten questions has the word the module looks for before it asks a model', async () => {
        const loaded = await recallLoader(REPO)(new Ledger());
        assert.equal(loaded.present, true, loaded.present ? '' : loaded.why);
        const mod = (await import(pathToFileURL(RECALL_FILE).href)) as { hasContentCue(text: unknown): boolean };
        for (const q of committed().memory) assert.equal(mod.hasContentCue(q.ask), true, `${q.id}: recall returns nothing for a message with no cue, which would be scored as a miss`);
    });

    it('answers a question from the library it was handed, with the gate open and no database reached, and says which reel the model chose', async () => {
        const ledger = new Ledger();
        const { fetch, requests } = scriptedFetch((r: Recorded) => chatAnswer({ is_content_request: true, match: 2, second: 0, why: 'the podcast one' }, { prompt: 4000, completion: 300 }, r.body?.model));
        const previous = setAiCaller(makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger, fetchImpl: fetch }));
        try {
            const loaded = await recallLoader(REPO)(ledger);
            assert.ok(loaded.present);
            if (!loaded.present) return;
            const outcome: RecallOutcome = await loaded.value('عندك فيديو بيشرح إزاي أحول ملفات المذاكرة لبودكاست؟', LIBRARY);
            assert.equal(outcome.kind, 'match');
            assert.equal((outcome as { id: string }).id, 'second', 'the library is numbered oldest first, and 2 is the newer reel');
            assert.equal((outcome as { link: string | null }).link, 'https://www.instagram.com/reel/second/');
            assert.ok(outcome.usd > 0, 'what the call cost is read from what the response reported');
            assert.equal(requests.length, 1);
            assert.equal(requests[0]!.host, 'api.meta.ai');
            assert.equal(requests[0]!.authorization, `Bearer ${META_KEY}`);
            assert.match(JSON.stringify(requests[0]!.body.messages), /A meal priced at 45 riyals/, 'the library is in what is asked');
        } finally {
            setAiCaller(previous);
        }
    });

    it('says there is no such video when the model finds no reel for a topic, and nothing when the message was not a request', async () => {
        const answers = [{ is_content_request: true, match: 0, second: 0, why: 'none fits' }, { is_content_request: false, match: 0, second: 0, why: 'a greeting' }];
        let n = 0;
        const ledger = new Ledger();
        const { fetch } = scriptedFetch(() => chatAnswer(answers[n++]));
        const previous = setAiCaller(makeAiCaller('muse-spark-1.3', { apiKey: META_KEY, ledger, fetchImpl: fetch }));
        try {
            const loaded = await recallLoader(REPO)(ledger);
            assert.ok(loaded.present);
            if (!loaded.present) return;
            assert.equal((await loaded.value('عندك فيديو عن طريقة عمل الكبسة؟', LIBRARY)).kind, 'none');
            assert.equal((await loaded.value('فيديو؟ لا شكرا', LIBRARY)).kind, 'nothing');
        } finally {
            setAiCaller(previous);
        }
    });
});
