/**
 * Open weights against hosted (`openWeights.ts`), with the network mocked: that both models are asked exactly what the reel indexer asks (its system text, its prompt, its schema, its
 * limit), each at its own host with its own key and never the other's, that the cost is priced from what each response said it used, that an analysis is read by checks on words and
 * ranges and by the product's own parser, and that a failed call is a row that says so and never an exception, with the key out of what it says.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jsonSchemaFor } from '../../llm/schema.js';
import { setLogSink } from '../../../utils/log.js';
import { REEL_ANALYSIS_SCHEMA, REEL_INDEX_PROMPT, REEL_INDEX_SYSTEM, REEL_MAX_TOKENS } from '../reelIndex.js';
import { Ledger } from './caller.js';
import type { LoadedMedia } from './cases.js';
import { analyse, checkAnalysis, HOSTED_MODEL, indexerRequest, OPEN_MODEL, reelAnalyzer } from './openWeights.js';
import { BASETEN_KEY, chatAnswer, messagesOf, META_KEY, scriptedFetch, type Recorded } from './testSupport.js';
import type { OpenWeightsSpec } from './types.js';

setLogSink(() => {});

const VIDEO: LoadedMedia = { bytes: Buffer.from('pretend this is a video'), mime: 'video/mp4', mediaKind: 'video' };
const SPEC: OpenWeightsSpec = {
    file: 'reel.mp4', durationS: 37.7,
    facts: [
        { name: 'the 45-riyal meal', any: ['45', 'forty-five'] },
        { name: 'paid one riyal', any: ['1 riyal', 'ريال واحد'] },
        { name: 'developer tools', any: ['devtools', 'أدوات المطور'] },
        { name: 'the fix', any: ['server.js', 'findMenuItem'] },
    ],
};

const GOOD = {
    summary: 'A reel about a meal priced at 45 riyals that was paid for with 1 riyal: the page checks everything but the server trusts the price.',
    topics: ['backend', 'security'],
    seen_on_screen: ['DevTools console with a fake request', 'server.js before and after'],
    narration: 'وجد أحدهم في موقعه طلبية غريبة وجبة ثمنها خمسة وأربعون ريالا دفع فيها ريال واحد مع أن صفحته تتحقق من كل شيء فالخادم لا يرى صفحتك ولا أين ضغطت كل ما يراه هو الطلب',
    key_moments: [{ second: 0, what: 'the hook' }, { second: 9, what: 'the question' }, { second: 18, what: 'the exploit in DevTools' }, { second: 26, what: 'the fix in server.js' }],
    hook_first_3s: 'A worried man at a laptop and a headline about 45 riyals.',
    hook_score: 9,
    caption_ar: 'وجبة بخمسة وأربعين ريالا دفع فيها ريال واحد فقط تفتكر الغلطة كانت من الصفحة ولا من الخادم',
    cover_second: 6,
    cover_reason: 'Both prices are on screen at once.',
};

const by = (r: Recorded): string => r.host;

describe('what both models are asked', () => {
    it('is what the reel indexer sends: its system text, its prompt, the video as base64, its schema, its limit, at low effort', () => {
        const q = indexerRequest(VIDEO);
        assert.equal(q.system, REEL_INDEX_SYSTEM);
        assert.equal(q.user[0]!.text, REEL_INDEX_PROMPT);
        assert.deepEqual(q.user[0]!.media, [{ kind: 'video', mime: 'video/mp4', base64: VIDEO.bytes.toString('base64') }]);
    });

    it('goes to each model at its own host with its own key: Meta\'s key to Meta, Baseten\'s to Baseten, and neither in a body', async () => {
        const { fetch, requests } = scriptedFetch(() => chatAnswer(GOOD, { prompt: 5863, completion: 3371 }));
        const ledger = new Ledger();
        await reelAnalyzer({ provider: 'meta', model: HOSTED_MODEL, apiKey: META_KEY, ledger, fetchImpl: fetch })(VIDEO);
        await reelAnalyzer({ provider: 'baseten', model: OPEN_MODEL, apiKey: BASETEN_KEY, ledger, fetchImpl: fetch })(VIDEO);
        assert.deepEqual(requests.map(by), ['api.meta.ai', 'inference.baseten.co']);
        assert.equal(requests[0]!.url, 'https://api.meta.ai/v1/chat/completions');
        assert.equal(requests[1]!.url, 'https://inference.baseten.co/v1/chat/completions');
        assert.equal(requests[0]!.authorization, `Bearer ${META_KEY}`);
        assert.equal(requests[1]!.authorization, `Bearer ${BASETEN_KEY}`);
        for (const r of requests) {
            assert.equal(r.rawBody!.includes(META_KEY) || r.rawBody!.includes(BASETEN_KEY), false);
            assert.equal(r.url.includes('b10_') || r.url.includes(META_KEY), false);
        }
    });

    it('sends the same request to both, apart from the model: the indexer\'s texts, the strict schema, its limit, low effort, the video as a data URL', async () => {
        const { fetch, requests } = scriptedFetch(() => chatAnswer(GOOD));
        const ledger = new Ledger();
        await reelAnalyzer({ provider: 'meta', model: HOSTED_MODEL, apiKey: META_KEY, ledger, fetchImpl: fetch })(VIDEO);
        await reelAnalyzer({ provider: 'baseten', model: OPEN_MODEL, apiKey: BASETEN_KEY, ledger, fetchImpl: fetch })(VIDEO);
        const [hosted, open] = requests;
        assert.deepEqual([hosted!.body.model, open!.body.model], [HOSTED_MODEL, OPEN_MODEL]);
        for (const r of requests) {
            assert.equal(r.body.reasoning_effort, 'low');
            assert.ok(r.body.max_tokens >= REEL_MAX_TOKENS);
            assert.equal(r.body.response_format.type, 'json_schema');
            assert.equal(r.body.response_format.json_schema.strict, true);
            assert.deepEqual(r.body.response_format.json_schema.schema.required, jsonSchemaFor(REEL_ANALYSIS_SCHEMA).required);
            const [system, user] = messagesOf(r);
            assert.equal(system.content, REEL_INDEX_SYSTEM);
            assert.equal(user.content[0].text, REEL_INDEX_PROMPT);
            assert.equal(user.content[1].video_url.url, `data:video/mp4;base64,${VIDEO.bytes.toString('base64')}`);
            assert.equal(user.content.length, 2, 'the prompt and the video, and nothing else: no message, no caption, no handle');
        }
        assert.deepEqual(hosted!.body.messages, open!.body.messages);
        assert.deepEqual(hosted!.body.response_format, open!.body.response_format);
    });

    it('prices each from what its response said it used, the open model too (its price is in the table), and keeps the time and the tokens', async () => {
        const { fetch } = scriptedFetch(() => chatAnswer(GOOD, { prompt: 5863, completion: 3371 }));
        const ledger = new Ledger();
        const hosted = await reelAnalyzer({ provider: 'meta', model: HOSTED_MODEL, apiKey: META_KEY, ledger, fetchImpl: fetch })(VIDEO);
        const open = await reelAnalyzer({ provider: 'baseten', model: OPEN_MODEL, apiKey: BASETEN_KEY, ledger, fetchImpl: fetch })(VIDEO);
        const expected = Math.round(((5863 * 1.25 + 3371 * 4.25) / 1e6) * 1e9) / 1e9;
        assert.equal(hosted.usd, expected);
        assert.equal(open.usd, expected);
        assert.equal(hosted.priced && open.priced, true);
        assert.deepEqual([open.tokensIn, open.tokensOut], [5863, 3371]);
        assert.ok(open.ms >= 0);
        assert.deepEqual(ledger.calls.map((c) => [c.role, c.provider]), [['analysis', 'meta'], ['analysis', 'baseten']]);
    });
});

describe('checkAnalysis', () => {
    const verdict = (json: unknown) => checkAnalysis(SPEC, json);
    const failed = (json: unknown): string[] => verdict(json).checks.filter((c) => !c.pass).map((c) => c.name);

    it('passes an analysis that has everything: the product\'s parser takes it, its moments are inside the reel, its numbers are in range, it is Arabic, and it holds every fact', () => {
        assert.deepEqual(failed(GOOD), []);
        assert.deepEqual(verdict(GOOD).facts.map((f) => f.found), [true, true, true, true]);
    });

    it('fails each thing that can be wrong with it, by name, with a reason in a line', () => {
        assert.deepEqual(failed({ ...GOOD, key_moments: GOOD.key_moments.slice(0, 3) }), ['moments']);
        assert.deepEqual(failed({ ...GOOD, key_moments: [...GOOD.key_moments, { second: 99, what: 'after the end' }] }), ['moments']);
        assert.deepEqual(failed({ ...GOOD, key_moments: [...GOOD.key_moments.slice(0, 3), { second: 30, what: '' }] }), ['moments']);
        assert.deepEqual(failed({ ...GOOD, hook_score: 11 }), ['hook_score']);
        assert.deepEqual(failed({ ...GOOD, hook_score: 8.5 }), ['hook_score']);
        assert.deepEqual(failed({ ...GOOD, cover_second: 50 }), ['cover_second']);
        assert.deepEqual(failed({ ...GOOD, cover_second: -1 }), ['cover_second']);
        assert.deepEqual(failed({ ...GOOD, caption_ar: 'A caption in English' }), ['caption_ar']);
        assert.deepEqual(failed({ ...GOOD, caption_ar: '' }), ['caption_ar']);
        assert.deepEqual(failed({ ...GOOD, narration: 'too short' }), ['narration']);
        assert.deepEqual(failed({ ...GOOD, narration: 'This narration is long enough in words but it is written in English and not in the language the reel is spoken in at all today' }), ['narration']);
        const bad = verdict({ ...GOOD, hook_score: 11 }).checks.find((c) => c.name === 'hook_score')!;
        assert.match(bad.detail, /hook_score is 11, not a whole number from 1 to 10/);
    });

    it('fails what the product\'s own parser finds nothing usable in, and finds a fact missing wherever it should be: any word of it, anywhere in the analysis', () => {
        assert.ok(failed({}).includes('usable'));
        assert.ok(failed('nope').includes('usable'));
        assert.ok(failed({ ...GOOD, summary: '' }).includes('usable'));
        const noFix = { ...GOOD, seen_on_screen: ['a console'], key_moments: GOOD.key_moments.map((m) => ({ ...m, what: m.what.replace('server.js', 'the file') })) };
        assert.deepEqual(verdict(noFix).facts.filter((f) => !f.found).map((f) => f.name), ['the fix']);
        assert.deepEqual(verdict({ ...GOOD, topics: ['FORTY-FIVE'], summary: 'about a meal, an order and a price; no figures', narration: GOOD.narration.replace('خمسة وأربعون', '') }).facts[0]!.found, true, 'any case');
    });
});

describe('analyse', () => {
    it('is a row with the checks, the facts and the numbers when the call answers', async () => {
        const { fetch } = scriptedFetch(() => chatAnswer(GOOD, { prompt: 6000, completion: 3000 }));
        const run = reelAnalyzer({ provider: 'baseten', model: OPEN_MODEL, apiKey: BASETEN_KEY, ledger: new Ledger(), fetchImpl: fetch });
        const row = await analyse('Open', OPEN_MODEL, run, VIDEO, SPEC, BASETEN_KEY);
        assert.equal(row.status, 'ok');
        assert.equal(row.error, null);
        assert.equal(row.model, OPEN_MODEL);
        assert.deepEqual(row.checks.filter((c) => !c.pass), []);
        assert.equal(row.facts.every((f) => f.found), true);
        assert.deepEqual([row.tokensIn, row.tokensOut], [6000, 3000]);
        assert.ok(row.usd !== null && row.usd > 0);
    });

    it('is a row that says it failed, and why, when the call is refused, never an exception: the kind and the status, and no key', async () => {
        const { fetch } = scriptedFetch(() => ({ status: 401, json: { error: { message: `bad key ${BASETEN_KEY}` } } }));
        const run = reelAnalyzer({ provider: 'baseten', model: OPEN_MODEL, apiKey: BASETEN_KEY, ledger: new Ledger(), fetchImpl: fetch });
        const row = await analyse('Open', OPEN_MODEL, run, VIDEO, SPEC, BASETEN_KEY);
        assert.equal(row.status, 'failed');
        assert.equal(row.error, 'auth (HTTP 401)');
        assert.deepEqual([row.ms, row.tokensIn, row.usd, row.checks.length], [null, null, null, 0]);
        assert.doesNotMatch(JSON.stringify(row), new RegExp(BASETEN_KEY));
    });

    it('takes a key out of an error that is not the provider\'s own', async () => {
        const row = await analyse('x', 'm', async () => { throw new Error(`connection to ${META_KEY} lost`); }, VIDEO, SPEC, META_KEY);
        assert.equal(row.status, 'failed');
        assert.doesNotMatch(row.error ?? '', new RegExp(META_KEY));
    });
});
