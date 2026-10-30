/**
 * `transcribeWithMeta`: the key found the way every chat call finds it, the cost reserved before Meta is asked and settled after, the platform's budgets in force, and the
 * `ai_usage` row a voice note leaves (provider `meta`, model `muse-voice-transcribe-1.0`, purpose `perception_voice`, $0.18 an hour). The wire is `llm/metaAsr.test.ts`'s;
 * here the fetch is a stand-in and the database is the in-memory one of `testDb.ts`.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { AiError, isAiError } from '../llm/errors.js';
import { asrUsd, ASR_MODEL } from '../llm/metaAsr.js';
import { parseMultipart, wavBytes } from '../llm/testAudio.js';
import { hangingFetch, jsonResponse } from '../llm/testFetch.js';
import type { FetchLike } from '../llm/types.js';
import { MUSE_BUDGET_PURPOSES } from '../perception/gate.js';
import { transcribeWithMeta, type TranscribeWithMetaArgs } from './asr.js';
import { setProviderFetch } from './generate.js';
import { PERCEPTION_VOICE } from './purposes.js';
import { installAiDb, type AiDb } from './testDb.js';
import { assertNoKey, FAKE_KEYS } from './testKeys.js';
import { BudgetRefused } from './usage.js';

const TENANT = '44444444-4444-4444-8444-444444444444';
const OWNER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-01T09:30:00.000Z');
const KEY = FAKE_KEYS.meta;
const ENV_KEY = FAKE_KEYS.meta.replace('met7', 'env8');
const THREE_SECONDS = wavBytes({ seconds: 3, info: true, tone: true });

let db: AiDb;
let logs: { level: string; line: string }[];
let restoreSink: (() => void) | undefined;
let savedEnv: Record<string, string | undefined>;

before(() => {
    savedEnv = { TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY, META_MODEL_API_KEY: process.env.META_MODEL_API_KEY };
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});
after(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

beforeEach(() => {
    delete process.env.META_MODEL_API_KEY;
    db = installAiDb({ owner: OWNER });
    db.now = new Date(NOW);
    db.setSetting('ai.providers.meta.api_key', KEY, true);
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
    setProviderFetch(undefined);
    delete process.env.META_MODEL_API_KEY;
});

interface Seen { url: string; headers: Record<string, string>; body: Buffer; reservedAtTheTime: number }

/** A fetch that answers from a script and records what it was sent, and how many rows were still reserved when the request went out. */
function recorder(...answers: Array<Response | Error | (() => Response)>): { fetchImpl: FetchLike; seen: Seen[] } {
    const seen: Seen[] = [];
    const queue = [...answers];
    const fetchImpl: FetchLike = async (url, init) => {
        const body = init.body as Uint8Array;
        seen.push({
            url,
            headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
            body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
            reservedAtTheTime: db.usage.filter((r) => r.outcome === 'reserved').length,
        });
        const next = queue.shift();
        if (!next) throw new Error('unexpected extra fetch');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    };
    return { fetchImpl, seen };
}

const heard = (over: Record<string, unknown> = {}): Response => jsonResponse(200, { sessionId: 'sess-42', transcript: 'بكام الكورس ده', audioDurationMs: 3000, turns: [], ...over });

const call = (fetchImpl: FetchLike | undefined, over: Partial<TranscribeWithMetaArgs> = {}) =>
    transcribeWithMeta({ creatorId: TENANT, wav: THREE_SECONDS, now: NOW, ...(fetchImpl ? { fetchImpl } : {}), ...over });

async function failure(promise: Promise<unknown>): Promise<AiError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(isAiError(err), `expected an AiError, got ${String(err)}`);
        return err;
    }
    return assert.fail('expected a rejection');
}

const logged = (event: string): Record<string, unknown>[] => logs.map((l) => JSON.parse(l.line)).filter((l) => l.event === event);
const budgets = (over: Record<string, string>) => { for (const [k, v] of Object.entries(over)) db.setSetting(k, v); };

describe('a voice note that is heard', () => {
    it('writes one row: the tenant, purpose perception_voice, provider meta, the speech model, no tokens, dollars by the hour of audio, ok, latency; nothing left reserved', async () => {
        const { fetchImpl } = recorder(heard());
        const out = await call(fetchImpl);

        assert.equal(db.usage.length, 1);
        const row = db.usage[0]!;
        assert.equal(row.creator_id, TENANT);
        assert.equal(row.purpose, 'perception_voice');
        assert.equal(row.provider, 'meta');
        assert.equal(row.model, 'muse-voice-transcribe-1.0');
        assert.equal(row.input_tokens, 0);
        assert.equal(row.output_tokens, 0);
        assert.equal(row.usd, 0.00015, '3,000 ms of audio at $0.18 an hour');
        assert.equal(row.priced, true);
        assert.equal(row.outcome, 'ok');
        assert.ok(row.elapsed_ms !== null && row.elapsed_ms >= 0);
        assert.ok(!db.usage.some((r) => r.outcome === 'reserved'));
        assert.equal(out.usageId, row.id);
    });

    it('returns the transcript, how long Meta says the audio was, what it cost, the model, the session and the row', async () => {
        const out = await call(recorder(heard()).fetchImpl);
        assert.equal(out.transcript, 'بكام الكورس ده');
        assert.equal(out.durationMs, 3000);
        assert.equal(out.usd, 0.00015);
        assert.equal(out.model, 'muse-voice-transcribe-1.0');
        assert.equal(out.sessionId, 'sess-42');
        assert.ok(out.elapsedMs >= 0);
    });

    it('charges what Meta says it processed, not what was sent: usd = audioDurationMs / 3,600,000 x 0.18', async () => {
        const out = await call(recorder(heard({ audioDurationMs: 3500 })).fetchImpl);
        assert.equal(out.usd, asrUsd(3500));
        assert.equal(out.usd, 0.000175);
        assert.equal(db.usage[0]!.usd, 0.000175);
    });

    it('reserves the call at the WAV\'s own length BEFORE Meta is asked, and settles the same row afterwards', async () => {
        const { fetchImpl, seen } = recorder(heard());
        await call(fetchImpl);
        assert.equal(seen[0]!.reservedAtTheTime, 1, 'the reservation was committed when the request went out');
        const sql = db.statements.map((s) => s.sql);
        const reserved = sql.findIndex((s) => s.startsWith('INSERT INTO ai_usage (creator_id, purpose, provider, model, usd, priced, outcome)'));
        const settled = sql.findIndex((s) => s.startsWith('UPDATE ai_usage SET provider'));
        assert.ok(reserved >= 0 && settled > reserved, sql.join('\n'));
        assert.deepEqual(db.statements[reserved]!.params, [TENANT, 'perception_voice', 'meta', ASR_MODEL, asrUsd(3000), true]);
    });

    it('is spend the Muse daily cap counts: the label is one of the gate\'s budget purposes, so a voice note is part of "spent today"', async () => {
        await call(recorder(heard()).fetchImpl);
        assert.equal(PERCEPTION_VOICE, 'perception_voice');
        assert.ok(MUSE_BUDGET_PURPOSES.includes(db.usage[0]!.purpose));
    });

    it('sends the keywords and the WAV to Meta\'s speech endpoint, with the key as a Bearer header only', async () => {
        const { fetchImpl, seen } = recorder(heard());
        await call(fetchImpl, { keywords: ['Agentic AI', 'AutoReply'] });
        const sent = seen[0]!;
        assert.equal(sent.url, 'https://api.meta.ai/v1/asr/transcribe');
        assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
        const [request, audio] = parseMultipart(sent.body, sent.headers['content-type']!);
        assert.deepEqual(JSON.parse(request!.data.toString('utf8')).keywords, ['Agentic AI', 'AutoReply']);
        assert.ok(audio!.data.equals(THREE_SECONDS));
        assert.ok(!sent.body.includes(KEY));
    });

    it('logs the call as `ai.call` like every model call: purpose, provider, model, outcome, audio length, dollars, latency, the session; never the words', async () => {
        await call(recorder(heard()).fetchImpl);
        const [line] = logged('ai.call');
        assert.ok(line);
        assert.equal(line.purpose, 'perception_voice');
        assert.equal(line.creator_id, TENANT);
        assert.equal(line.provider, 'meta');
        assert.equal(line.model, 'muse-voice-transcribe-1.0');
        assert.equal(line.outcome, 'ok');
        assert.equal(line.audio_ms, 3000);
        assert.equal(line.usd, 0.00015);
        assert.equal(line.session_id, 'sess-42');
        assert.ok(typeof line.elapsed_ms === 'number');
        const all = logs.map((l) => l.line).join('\n');
        assert.ok(!all.includes('بكام'), 'the transcript is never logged');
        assert.ok(!all.includes('[redacted]'), 'no field of the line is named so the logger blanks it');
        assertNoKey(all, 'the log');
    });

    it('settling that fails does not fail a call that was paid for: the transcript is returned, the failure logged, and the reservation stays counted', async () => {
        db.failOn(/^UPDATE ai_usage SET provider/);
        const out = await call(recorder(heard()).fetchImpl);
        assert.equal(out.transcript, 'بكام الكورس ده');
        assert.equal(logged('ai.usage_settle_failed').length, 1);
        assert.equal(db.usage[0]!.outcome, 'reserved', 'at its ceiling: over-counting is the safe side of a budget');
    });

    it('answers through the providers layer\'s own stand-in fetch (setProviderFetch) when none is passed', async () => {
        const { fetchImpl, seen } = recorder(heard());
        setProviderFetch(fetchImpl);
        const out = await call(undefined);
        assert.equal(out.transcript, 'بكام الكورس ده');
        assert.equal(seen.length, 1);
    });
});

describe('the key: Settings first, the environment as the fallback, and never another provider', () => {
    it('uses the key saved in Settings (decrypted), over an environment one', async () => {
        process.env.META_MODEL_API_KEY = ENV_KEY;
        const { fetchImpl, seen } = recorder(heard());
        await call(fetchImpl);
        assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
    });

    it('falls back to META_MODEL_API_KEY when none is saved', async () => {
        db.settings.delete('ai.providers.meta.api_key');
        process.env.META_MODEL_API_KEY = ENV_KEY;
        const { fetchImpl, seen } = recorder(heard());
        await call(fetchImpl);
        assert.equal(seen[0]!.headers.authorization, `Bearer ${ENV_KEY}`);
    });

    it('is `no_provider` with no key anywhere: recorded as a refusal, nothing asked of Meta, and no other provider\'s key is touched', async () => {
        db.settings.delete('ai.providers.meta.api_key');
        db.setSetting('ai.providers.groq.api_key', FAKE_KEYS.groq, true);
        db.setSetting('ai.providers.openai.api_key', FAKE_KEYS.openai, true);
        const { fetchImpl, seen } = recorder(heard());
        const err = await failure(call(fetchImpl));
        assert.equal(err.kind, 'no_provider');
        assert.equal(err.provider, 'meta');
        assert.match(err.message, /has no API key saved/);
        assert.match(err.message, /Operations → AI providers/);
        assert.equal(seen.length, 0, 'Meta is not asked, and nothing else is');
        assert.equal(db.usage.length, 1);
        assert.deepEqual([db.usage[0]!.purpose, db.usage[0]!.provider, db.usage[0]!.outcome, db.usage[0]!.usd], ['perception_voice', 'none', 'no_provider', 0]);
        assert.equal(logged('ai.call_refused').length, 1);
    });

    it('is `no_provider` when Meta is switched off in Settings, even with a key saved', async () => {
        db.setSetting('ai.providers', JSON.stringify({ meta: { enabled: false } }));
        const { fetchImpl, seen } = recorder(heard());
        const err = await failure(call(fetchImpl));
        assert.equal(err.kind, 'no_provider');
        assert.match(err.message, /is switched off/);
        assert.equal(seen.length, 0);
    });

    it('never puts the key in a row, an error or a log line', async () => {
        await call(recorder(heard()).fetchImpl);
        const err = await failure(call(recorder(jsonResponse(401, { error: { message: `Incorrect API key provided: ${KEY}` } })).fetchImpl));
        assertNoKey(JSON.stringify(db.usage), 'ai_usage');
        assertNoKey(JSON.stringify(err) + err.message + String(err.stack), 'the error');
        assertNoKey(logs.map((l) => l.line).join('\n'), 'the log');
    });
});

describe('a call that fails', () => {
    it('settles at nothing, as the outcome of the error: Meta does not bill a request that fails before it makes a transcript', async () => {
        const cases: [Response | Error, string][] = [
            [jsonResponse(401, { error: { message: 'Invalid key' } }), 'auth'],
            [jsonResponse(429, { error: { message: 'limit' } }, { 'retry-after': '3' }), 'rate'],
            [jsonResponse(500, { error: { message: 'Transcription failed' } }), 'server'],
            [jsonResponse(400, { error: { message: 'Audio is not a supported WAV file' } }), 'bad_request'],
            [new TypeError('fetch failed'), 'timeout'],
        ];
        for (const [answer, kind] of cases) {
            const before = db.usage.length;
            const err = await failure(call(recorder(answer).fetchImpl));
            assert.equal(err.kind, kind);
            const row = db.usage[before]!;
            assert.equal(row.outcome, kind);
            assert.equal(row.usd, 0, kind);
            assert.equal(row.provider, 'meta');
            assert.equal(row.model, 'muse-voice-transcribe-1.0');
            assert.equal(row.purpose, 'perception_voice');
        }
        assert.ok(!db.usage.some((r) => r.outcome === 'reserved'), 'every reservation was settled');
        assert.equal(logged('ai.call_failed').length, cases.length);
    });

    it('the deadline is a timeout, settled at nothing', async () => {
        const err = await failure(call(hangingFetch, { timeoutMs: 30 }));
        assert.equal(err.kind, 'timeout');
        assert.equal(db.usage[0]!.outcome, 'timeout');
        assert.equal(db.usage[0]!.usd, 0);
    });

    it('an answer that came back unusable (a 200 with no transcript) WAS processed: it is charged at the estimate, the WAV\'s own length', async () => {
        const err = await failure(call(recorder(jsonResponse(200, { result: 'x' })).fetchImpl));
        assert.equal(err.kind, 'bad_output');
        assert.equal(db.usage[0]!.outcome, 'bad_output');
        assert.equal(db.usage[0]!.usd, asrUsd(3000));
    });

    it('is thrown as it came: the same AiError, kind and status', async () => {
        const err = await failure(call(recorder(jsonResponse(503, { error: { message: 'unavailable' } })).fetchImpl));
        assert.equal(err.kind, 'server');
        assert.equal(err.status, 503);
        assert.equal(err.retryable, true);
    });
});

describe('the budgets', () => {
    it('refuse the call when the platform\'s daily budget is already reached: Meta is not asked, and the refusal is a row', async () => {
        db.seedUsage({ usd: 0.5, purpose: 'dm', creator_id: OWNER, provider: 'anthropic' });
        budgets({ 'ai.budget.daily_usd': '0.5' });
        const { fetchImpl, seen } = recorder(heard());
        const err = await failure(call(fetchImpl));
        assert.ok(err instanceof BudgetRefused);
        assert.equal(err.kind, 'budget');
        assert.equal(seen.length, 0);
        const refusal = db.usage[db.usage.length - 1]!;
        assert.deepEqual([refusal.purpose, refusal.provider, refusal.outcome, refusal.usd], ['perception_voice', 'meta', 'budget', 0]);
        assert.equal(logged('ai.call_refused').at(-1)?.outcome, 'budget');
    });

    it('refuse it when the tenant\'s own daily budget is reached', async () => {
        db.seedUsage({ usd: 0.2, purpose: 'perception_dm', creator_id: TENANT, provider: 'meta' });
        budgets({ 'ai.budget.tenant_daily_usd': '0.2' });
        const err = await failure(call(recorder(heard()).fetchImpl));
        assert.equal(err.kind, 'budget');
    });

    it('count a call in flight: the reservation is held until it settles, so calls racing a budget cannot all pass', async () => {
        // Room for the first note's reservation (0.00015 of 0.0002) and, once a second is on the books, for no third.
        budgets({ 'ai.budget.daily_usd': '0.0002' });
        let release!: () => void;
        const slow = new Promise<void>((resolve) => { release = resolve; });
        let started!: () => void;
        const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
        const first = call(async () => { started(); await slow; return heard(); });
        await fetchStarted;
        assert.equal(db.usage.filter((r) => r.outcome === 'reserved').length, 1, 'the first call is in flight, holding its reservation');
        // The second finds 0.00015 spent of 0.0002: room. It reserves and settles another 0.00015.
        await call(recorder(heard()).fetchImpl);
        // The third finds 0.0003 spent, the first still in flight: none.
        const third = await failure(call(recorder(heard()).fetchImpl));
        assert.equal(third.kind, 'budget');
        release();
        await first;
        assert.ok(!db.usage.some((r) => r.outcome === 'reserved'));
    });

    it('leave a call alone when no budget is set (the default): voice notes are limited by the Muse daily cap in the gate', async () => {
        const out = await call(recorder(heard()).fetchImpl);
        assert.equal(out.transcript, 'بكام الكورس ده');
    });
});

describe('what is wrong with the call itself is refused before a settings read or a row', () => {
    it('a file the endpoint will not take: not a WAV, stereo, 44.1 kHz', async () => {
        const { fetchImpl, seen } = recorder(heard());
        for (const wav of [Buffer.from('not a wav at all'), wavBytes({ channels: 2 }), wavBytes({ rate: 44_100 })]) {
            const err = await failure(call(fetchImpl, { wav }));
            assert.equal(err.kind, 'bad_request');
        }
        assert.equal(seen.length, 0);
        assert.equal(db.statements.length, 0, 'not one statement ran');
        assert.equal(db.usage.length, 0);
    });

    it('a tenant id that is not one', async () => {
        for (const creatorId of ['', 'not-a-uuid', '1', undefined as unknown as string]) {
            const err = await failure(call(recorder(heard()).fetchImpl, { creatorId }));
            assert.equal(err.kind, 'bad_request');
        }
        assert.equal(db.statements.length, 0);
    });
});
