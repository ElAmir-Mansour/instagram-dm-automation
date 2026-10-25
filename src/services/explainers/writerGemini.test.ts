/**
 * The fallback writer (writerGemini.ts): Gemini with Google Search grounding, in two calls. `fetch` is injected, so nothing here reaches Google: each test says
 * what Gemini answers, and holds what the app sent to it, what it kept of the answer, and what it refused to keep.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ExplainerWriterOutput } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { MISSING_GEMINI_KEY } from '../appSettings.js';
import { STUDIO_MODELS } from '../studio/generate.js';
import { checkDraft } from './spec.js';
import { validWriterOutput, writerScene } from './testFixtures.js';
import {
    annotateNotes, firstCommentFor, GeminiWriteError, GROUNDING_HINT, groundedSources, groundingOf, normalizeUrl, numberedSources, onlyListedSources, researchUserPrompt,
    RESEARCH_SYSTEM, scrubUrls, toGeminiSchema, writeUserPromptWithNotes, writeWithGemini, writerResponseSchema, type GeminiFetch, type GroundedSource,
} from './writerGemini.js';
import { writerSchema, type WriterRequest } from './prompt.js';

const KEY = 'AIzaSyTEST-KEY-never-logged-0123456789';
const REDIRECT = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const ARXIV = 'https://arxiv.org/abs/2005.11401';
const LMSTUDIO = 'https://lmstudio.ai/docs/app/basics/rag';
const GPT3 = 'https://arxiv.org/abs/2005.14165';

let logs: { level: string; line: string }[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { logs.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => { logs = []; });

// ─── A scripted Gemini ─────────────────────────────────────────────────────────────────────────

interface Call { url: string; method: string; headers: Record<string, string>; body: any; redirect?: string }
type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/**
 * A `fetch` that answers by what it is asked: the first route whose `when` matches, for as many calls as it has `times`. A call no route answers fails the
 * test, loudly, so a request the test did not expect is never answered with nothing.
 */
function scripted() {
    const calls: Call[] = [];
    const routes: { when: (call: Call) => boolean; reply: Reply | ((call: Call) => Reply); times: number }[] = [];
    const fetch: GeminiFetch = async (url, init) => {
        const call: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect };
        calls.push(call);
        const route = routes.find((r) => r.times > 0 && r.when(call));
        if (!route) throw new Error(`unexpected request: ${init.method} ${url}`);
        route.times--;
        const reply = typeof route.reply === 'function' ? route.reply(call) : route.reply;
        const status = reply.status ?? 200;
        const text = reply.text ?? JSON.stringify(reply.json ?? {});
        const headers = reply.headers ?? {};
        return { status, ok: status >= 200 && status < 300, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => text };
    };
    const on = (when: (call: Call) => boolean, reply: Reply | ((call: Call) => Reply), times = Number.POSITIVE_INFINITY) => { routes.push({ when, reply, times }); };
    return { fetch, calls, on };
}

const isGemini = (call: Call, purpose?: 'research' | 'write'): boolean =>
    call.url.includes('generativelanguage.googleapis.com/v1beta/models/') && (purpose === undefined
        || (purpose === 'research' ? Boolean(call.body?.tools) : !call.body?.tools));
const modelOf = (call: Call): string => /models\/([^:]+):generateContent/.exec(call.url)![1]!;

const NOTES = 'RAG was introduced by Lewis et al. in 2020. A retriever finds passages and the model writes from them. Experts say retrieval can fail on vague questions.';
const researchAnswer = (over: { chunks?: unknown[]; supports?: unknown[]; text?: string } = {}) => ({
    candidates: [{
        content: { parts: [{ text: over.text ?? NOTES }, { text: 'a hidden thought', thought: true }] }, finishReason: 'STOP',
        groundingMetadata: {
            webSearchQueries: ['rag lewis 2020', 'retrieval augmented generation limits'],
            groundingChunks: over.chunks ?? [{ web: { uri: REDIRECT('AAA'), title: 'arxiv.org' } }, { web: { uri: REDIRECT('BBB'), title: 'lmstudio.ai' } }],
            groundingSupports: over.supports ?? [
                { segment: { startIndex: 0, endIndex: NOTES.indexOf('2020.') + 5, text: 'x' }, groundingChunkIndices: [0] },
                { segment: { startIndex: 50, endIndex: NOTES.indexOf('them.') + 5, text: 'y' }, groundingChunkIndices: [0, 1] },
            ],
        },
    }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80, thoughtsTokenCount: 10 },
});
const writeAnswer = (output: unknown) => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 2500 },
});

const REQUEST: WriterRequest = {
    topic: 'Why AI answers with confidence', notes: 'point to the course', language: 'en', tier: 'short', sourceLinks: [GPT3],
    characters: [{ key: 'karim', name: 'Karim', description: 'a curious young man' }], style: 'warm gouache', today: '2026-10-25',
};

/** A Gemini that researches (two sources, found through redirects) and writes `output`. */
function happy(output: ExplainerWriterOutput = validWriterOutput(12)) {
    const g = scripted();
    g.on((c) => c.method === 'GET' && c.url === REDIRECT('AAA'), { status: 302, headers: { location: ARXIV } });
    g.on((c) => c.method === 'GET' && c.url === REDIRECT('BBB'), { status: 302, headers: { location: LMSTUDIO } });
    g.on((c) => isGemini(c, 'research'), { json: researchAnswer() });
    g.on((c) => isGemini(c, 'write'), { json: writeAnswer(output) });
    return g;
}

// ─── The schema, as Gemini takes it ────────────────────────────────────────────────────────────

describe('toGeminiSchema: the writer’s JSON Schema in Gemini’s subset', () => {
    const allowedKeys = new Set(['type', 'description', 'enum', 'properties', 'required', 'propertyOrdering', 'items', 'minItems', 'maxItems']);
    const walk = (node: any, visit: (node: any, path: string) => void, path = 'schema'): void => {
        visit(node, path);
        for (const [key, sub] of Object.entries(node.properties ?? {})) walk(sub, visit, `${path}.${key}`);
        if (node.items) walk(node.items, visit, `${path}[]`);
    };

    it('has upper-case types and only keys Gemini’s schema has: no additionalProperties, maxLength, minimum, $schema or title', () => {
        walk(toGeminiSchema(writerSchema()), (node, path) => {
            assert.match(node.type, /^(OBJECT|ARRAY|STRING|INTEGER|NUMBER|BOOLEAN)$/, path);
            for (const key of Object.keys(node)) assert.ok(allowedKeys.has(key), `${path} has "${key}"`);
        });
    });

    it('lists the keys in the schema’s order, so the model writes the title before the scenes', () => {
        const schema = toGeminiSchema(writerSchema());
        assert.deepEqual(schema.propertyOrdering, ['title', 'scenes', 'captions', 'first_comment', 'replies', 'sources']);
        assert.deepEqual(schema.required, ['title', 'scenes', 'captions', 'first_comment', 'replies', 'sources']);
        assert.deepEqual(schema.items, undefined);
    });

    it('moves the bounds the subset has no keyword for into the description, where the model reads them', () => {
        const schema = toGeminiSchema(writerSchema()) as any;
        assert.match(schema.properties.title.description, /At least 5 characters\. At most 70 characters\./);
        assert.match(schema.properties.scenes.description, /Between 10 and 300 items\./);
        assert.match(schema.properties.scenes.items.properties.narration.description, /Arabic must be Modern Standard Arabic\. At least 2 characters\. At most 300 characters\./);
        assert.match(schema.properties.replies.description ?? '', /Between 5 and 10 items\./);
        assert.match(schema.properties.scenes.items.properties.source_ids.items.description, /At least 0\./);
    });

    it('is sent without array bounds (Gemini 3 has answered a schema carrying them with a bare 400), and with the rest intact', () => {
        const sent = writerResponseSchema();
        const text = JSON.stringify(sent);
        assert.doesNotMatch(text, /minItems|maxItems/);
        assert.equal(sent.type, 'OBJECT');
        assert.deepEqual(Object.keys(sent.properties!), ['title', 'scenes', 'captions', 'first_comment', 'replies', 'sources']);
        // And the contract's own schema still has its bounds: the conversion works on a copy.
        assert.equal((writerSchema() as any).properties.scenes.minItems, 10);
    });

    it('refuses a type it has no equivalent for', () => {
        assert.throws(() => toGeminiSchema({ type: 'null' }), /not a type Gemini's schema has/);
        assert.throws(() => toGeminiSchema({}), /not a type Gemini's schema has/);
    });
});

// ─── Grounding ─────────────────────────────────────────────────────────────────────────────────

describe('groundingOf', () => {
    it('reads the pages, the stretches they back and what was searched, and leaves out what is not shaped like them', () => {
        const g = groundingOf(researchAnswer({
            chunks: [{ web: { uri: REDIRECT('A'), title: 'arxiv.org' } }, { web: {} }, {}],
            supports: [{ segment: { endIndex: 12 }, groundingChunkIndices: [0] }, { segment: {}, groundingChunkIndices: [0] }, { segment: { endIndex: 5 }, groundingChunkIndices: [] }, { segment: { endIndex: 7 }, groundingChunkIndices: ['x', 1] }],
        }));
        assert.deepEqual(g.chunks, [{ uri: REDIRECT('A'), title: 'arxiv.org' }, { uri: '', title: '' }, { uri: '', title: '' }]);
        assert.deepEqual(g.supports, [{ end: 12, chunks: [0] }, { end: 7, chunks: [1] }]);
        assert.deepEqual(g.queries, ['rag lewis 2020', 'retrieval augmented generation limits']);
    });

    it('is empty for an answer with no grounding at all', () => {
        assert.deepEqual(groundingOf({ candidates: [{ content: { parts: [] } }] }), { chunks: [], supports: [], queries: [] });
        assert.deepEqual(groundingOf(null), { chunks: [], supports: [], queries: [] });
    });
});

describe('groundedSources', () => {
    it('follows Google’s redirect once, without following it, to the page it leads to', async () => {
        const g = scripted();
        g.on((c) => c.url === REDIRECT('A'), { status: 302, headers: { location: ARXIV } });
        const { sources, chunkToSource } = await groundedSources({ chunks: [{ uri: REDIRECT('A'), title: 'arxiv.org' }], supports: [], queries: [] }, [], g.fetch);
        assert.deepEqual(sources, [{ title: 'arxiv.org', url: ARXIV, resolved: true }]);
        assert.deepEqual(chunkToSource, [0]);
        assert.equal(g.calls.length, 1);
        assert.equal(g.calls[0]!.method, 'GET');
        assert.equal(g.calls[0]!.redirect, 'manual', 'asked once, never followed');
        assert.equal(g.calls[0]!.headers['x-goog-api-key'], undefined, 'no key goes to the redirect');
    });

    it('keeps the redirect itself when it will not say where it goes: it still opens the page, and is marked unresolved', async () => {
        const g = scripted();
        g.on((c) => c.url === REDIRECT('A'), { status: 200, text: 'no location' });
        g.on((c) => c.url === REDIRECT('B'), () => { throw new Error('socket hang up'); });
        const { sources } = await groundedSources({ chunks: [{ uri: REDIRECT('A'), title: 'a.org' }, { uri: REDIRECT('B'), title: 'b.org' }], supports: [], queries: [] }, [], g.fetch);
        assert.deepEqual(sources, [{ title: 'a.org', url: REDIRECT('A'), resolved: false }, { title: 'b.org', url: REDIRECT('B'), resolved: false }]);
    });

    it('does not follow an address that is already the page, and refuses one that is not http(s)', async () => {
        const g = scripted();
        const { sources, chunkToSource } = await groundedSources({
            chunks: [{ uri: LMSTUDIO, title: '' }, { uri: 'javascript:alert(1)', title: 'x' }, { uri: '', title: 'y' }, { uri: 'ftp://x/y', title: 'z' }], supports: [], queries: [],
        }, [], g.fetch);
        assert.equal(g.calls.length, 0);
        assert.deepEqual(sources, [{ title: 'lmstudio.ai', url: LMSTUDIO, resolved: true }], 'a missing title is the host');
        assert.deepEqual(chunkToSource, [0, -1, -1, -1]);
    });

    it('makes one source of two chunks that lead to the same page, however the address is spelled, and numbers them in the order they first appear', async () => {
        const g = scripted();
        g.on((c) => c.url === REDIRECT('A'), { status: 302, headers: { location: `${ARXIV}/` } });
        g.on((c) => c.url === REDIRECT('B'), { status: 302, headers: { location: `${ARXIV}#section-2` } });
        g.on((c) => c.url === REDIRECT('C'), { status: 302, headers: { location: LMSTUDIO } });
        const { sources, chunkToSource } = await groundedSources({
            chunks: [{ uri: REDIRECT('A'), title: 'arxiv.org' }, { uri: REDIRECT('C'), title: 'lmstudio.ai' }, { uri: REDIRECT('B'), title: 'arxiv.org' }], supports: [], queries: [],
        }, [], g.fetch);
        assert.deepEqual(sources.map((s) => s.url), [`${ARXIV}/`, LMSTUDIO]);
        assert.deepEqual(chunkToSource, [0, 1, 0]);
    });

    it('adds the creator’s links after the found ones, marked as his, unless the search found them already', async () => {
        const g = scripted();
        g.on((c) => c.url === REDIRECT('A'), { status: 302, headers: { location: ARXIV } });
        const { sources } = await groundedSources({ chunks: [{ uri: REDIRECT('A'), title: 'arxiv.org' }], supports: [], queries: [] }, [`${ARXIV}#abstract`, GPT3, 'not a link'], g.fetch);
        assert.deepEqual(sources, [{ title: 'arxiv.org', url: ARXIV, resolved: true }, { title: 'arxiv.org', url: GPT3, resolved: true, given: true }]);
    });

    it('is at most 20 sources', async () => {
        const g = scripted();
        const chunks = Array.from({ length: 30 }, (_, i) => ({ uri: `https://example.org/${i}`, title: `s${i}` }));
        assert.equal((await groundedSources({ chunks, supports: [], queries: [] }, [], g.fetch)).sources.length, 20);
    });
});

describe('annotateNotes', () => {
    it('puts [n] after each stretch a source backs, where the support ends, with the numbers of the sources and not of the chunks', () => {
        const text = 'One fact. Two facts. Three facts.';
        const out = annotateNotes(text, [{ end: 9, chunks: [3] }, { end: 20, chunks: [0, 3] }], [1, -1, -1, 0]);
        assert.equal(out, 'One fact.[0] Two facts.[0][1] Three facts.');
    });

    it('works from the last offset to the first, so an earlier offset stays true after a later insert', () => {
        const out = annotateNotes('aaaa bbbb cccc', [{ end: 14, chunks: [0] }, { end: 4, chunks: [1] }, { end: 9, chunks: [2] }], [0, 1, 2]);
        assert.equal(out, 'aaaa[1] bbbb[2] cccc[0]');
    });

    it('counts offsets in UTF-8 bytes, and never splits a character', () => {
        // "é" is two bytes: an offset of 3 is after "cé", and an offset in the middle of the "é" (2) lands before it.
        assert.equal(annotateNotes('café. ok', [{ end: 5, chunks: [0] }], [0]), 'café[0]. ok');
        assert.equal(annotateNotes('café. ok', [{ end: 4, chunks: [0] }], [0]), 'caf[0]é. ok', 'inside the é: before it');
    });

    it('ignores a support that names no source, and an offset past the end is the end', () => {
        assert.equal(annotateNotes('Fact.', [{ end: 5, chunks: [7] }], [0]), 'Fact.');
        assert.equal(annotateNotes('Fact.', [{ end: 99, chunks: [0] }], [0]), 'Fact.[0]');
    });
});

// ─── The prompts of the two calls ──────────────────────────────────────────────────────────────

describe('what each call is asked', () => {
    it('the research is asked for notes in English, from primary sources, with nothing filled in from memory', () => {
        assert.match(RESEARCH_SYSTEM, /Use Google Search\. Look for primary sources/);
        assert.match(RESEARCH_SYSTEM, /Write the notes in English, as short bullet points/);
        assert.match(RESEARCH_SYSTEM, /Never fill a gap from memory/);
        assert.match(RESEARCH_SYSTEM, /what experts argue about \(so the script can survive expert comments\)/);
    });

    it('its user prompt names the topic, the video’s language (the notes stay in English), the creator’s notes and his links', () => {
        const text = researchUserPrompt({ topic: ' RAG ', notes: ' point to the course ', language: 'ar', sourceLinks: [ARXIV], today: '2026-10-25' });
        assert.match(text, /^Topic: RAG\nThe video will be in Arabic: write your notes in English anyway\.\nToday: 2026-10-25/);
        assert.match(text, /Notes from the creator \(follow them\):\npoint to the course/);
        assert.match(text, /The creator pointed to these pages\. Search for them[^\n]*:\n- https:\/\/arxiv\.org\/abs\/2005\.11401/);
        assert.doesNotMatch(researchUserPrompt({ topic: 'RAG', notes: null, language: 'en', sourceLinks: [] }), /creator/);
    });

    it('the write call gets the request, the notes with their brackets, and the numbered sources it may use: the creator’s own, unread, say so', () => {
        const sources: GroundedSource[] = [{ title: 'arxiv.org', url: ARXIV, resolved: true }, { title: 'arxiv.org', url: GPT3, resolved: true, given: true }];
        const text = writeUserPromptWithNotes('Topic: RAG', { notes: 'fact [0]', sources });
        assert.match(text, /^Topic: RAG\n\nRESEARCH NOTES \(in English; the numbers in square brackets are the numbers of the sources that back the text before them\):\nfact \[0\]\n\nNUMBERED SOURCES \(the only sources you may use\):\n\[0\] arxiv\.org — https:\/\/arxiv\.org\/abs\/2005\.11401\n\[1\] arxiv\.org — https:\/\/arxiv\.org\/abs\/2005\.14165 \(given by the creator; the research did not read it\)$/);
        assert.equal(numberedSources([]), '');
    });

    it('with no source at all it says so, and tells the writer to cite nothing', () => {
        const text = writeUserPromptWithNotes('Topic: RAG', { notes: 'a note', sources: [] });
        assert.match(text, /NUMBERED SOURCES: none were found\. Write `sources` as an empty list and `source_ids` as empty lists/);
    });
});

// ─── What the app keeps of the answer ──────────────────────────────────────────────────────────

const LIST: GroundedSource[] = [
    { title: 'arxiv.org', url: ARXIV, resolved: true }, { title: 'lmstudio.ai', url: LMSTUDIO, resolved: true }, { title: 'arxiv.org', url: GPT3, resolved: true, given: true },
];

describe('onlyListedSources', () => {
    const answer = (sources: ExplainerWriterOutput['sources'], cites: number[][]): ExplainerWriterOutput => {
        const out = validWriterOutput(12, { sources });
        out.scenes = out.scenes.map((scene, i) => ({ ...scene, source_ids: cites[i] ?? [] }));
        return out;
    };
    const src = (url: string, title = 'T', by = 'B', year = '2020') => ({ title, by, year, url });

    it('drops a source whose address is not in the numbered list, and every id that named it: a model can invent a link', () => {
        const out = answer([src(ARXIV), src('https://invented.example/paper'), src(LMSTUDIO)], [[0], [1], [2], [0, 1, 2]]);
        const kept = onlyListedSources(out, LIST, 'en');
        assert.deepEqual(kept.output.sources.map((s) => s.url), [ARXIV, LMSTUDIO]);
        assert.equal(kept.droppedUnknown, 1);
        assert.deepEqual(kept.output.scenes.slice(0, 4).map((s) => s.source_ids), [[0], [], [1], [0, 1]], 'ids renumbered to the sources that are left');
    });

    it('writes each kept address in the list’s own spelling, never the model’s', () => {
        const out = answer([src(`${ARXIV}/#abstract`)], [[0]]);
        assert.equal(onlyListedSources(out, LIST, 'en').output.sources[0]!.url, ARXIV);
    });

    it('drops the sources no scene cites, and renumbers the ids, when some scene cites one', () => {
        const out = answer([src(ARXIV), src(LMSTUDIO), src(GPT3)], [[2], [], [2], [2]]);
        const kept = onlyListedSources(out, LIST, 'en');
        assert.deepEqual(kept.output.sources.map((s) => s.url), [GPT3]);
        assert.equal(kept.droppedUncited, 2);
        assert.deepEqual(kept.output.scenes.filter((s) => s.source_ids.length).map((s) => s.source_ids), [[0], [0], [0]]);
    });

    it('keeps every listed source when no scene cites any: the writer did not tie its claims, and the owner is told by the checks, not left with none', () => {
        const out = answer([src(ARXIV), src(LMSTUDIO)], []);
        const kept = onlyListedSources(out, LIST, 'en');
        assert.equal(kept.output.sources.length, 2);
        assert.equal(kept.droppedUncited, 0);
    });

    it('rebuilds the first comment from the sources that are left, in the video’s language, so it can carry no address nobody found', () => {
        const out = answer([src(ARXIV, 'RAG paper', 'Lewis et al.', '2020'), src('https://invented.example/x')], [[0]]);
        out.first_comment = 'Sources\n1. https://invented.example/x';
        const kept = onlyListedSources(out, LIST, 'en').output;
        assert.equal(kept.first_comment, `Sources:\n1. RAG paper — Lewis et al. (2020)\n${ARXIV}`);
        assert.doesNotMatch(kept.first_comment, /invented/);
        assert.match(onlyListedSources(out, LIST, 'ar').output.first_comment, /^المصادر:\n1\. /);
    });

    it('takes an address out of a caption unless it is a kept source’s, and leaves the rest of the caption as it was', () => {
        const out = answer([src(ARXIV)], [[0]]);
        out.captions = {
            meta: `Read ${ARXIV}. More at https://invented.example/promo today. #AI`, youtube: { title: 'T', description: `Sources: ${ARXIV}\nhttps://evil.example/phish` }, tiktok: 'no links here',
        };
        const { captions } = onlyListedSources(out, LIST, 'en').output;
        assert.equal(captions.meta, `Read ${ARXIV}. More at  today. #AI`);
        assert.equal(captions.youtube.description, `Sources: ${ARXIV}\n`);
        assert.equal(captions.tiktok, 'no links here');
    });

    it('cuts a title, an author and a year to what the schema allows, and has an empty first comment when there is no source', () => {
        const out = answer([src(ARXIV, 'x'.repeat(400), 'y'.repeat(400), '1999-2020-2021-2022')], [[0]]);
        const kept = onlyListedSources(out, LIST, 'en').output.sources[0]!;
        assert.deepEqual([kept.title.length, kept.by.length, kept.year.length], [300, 300, 10]);
        const none = onlyListedSources(answer([], []), LIST, 'en').output;
        assert.deepEqual([none.sources, none.first_comment], [[], '']);
    });

    it('does not change the answer it was given', () => {
        const out = answer([src(ARXIV), src('https://invented.example/x')], [[0], [1]]);
        const before = JSON.stringify(out);
        onlyListedSources(out, LIST, 'en');
        assert.equal(JSON.stringify(out), before);
    });
});

describe('scrubUrls, firstCommentFor, normalizeUrl', () => {
    it('removes an address that is not allowed, keeps one that is, and does not take trailing punctuation for part of it', () => {
        const allowed = new Set([normalizeUrl(ARXIV)]);
        assert.equal(scrubUrls(`See ${ARXIV}, then https://x.example/a.`, allowed), `See ${ARXIV}, then`, 'and the space it leaves at the end of a line goes too');
        assert.equal(scrubUrls('no links', allowed), 'no links');
    });

    it('lists at most as many sources as fit in 1,500 characters, dropping the last ones and never cutting a link in two', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ title: `Title ${i} ${'x'.repeat(60)}`, by: 'Someone', year: '2020', url: `https://example.org/paper/${i}` }));
        const text = firstCommentFor('en', many);
        assert.ok(text.length <= 1500, String(text.length));
        assert.ok(text.endsWith('/' + (text.match(/paper\/(\d+)\s*$/)![1])), 'ends on a whole link');
        assert.ok(/^Sources:\n1\. /.test(text));
    });

    it('compares addresses without the fragment, the trailing slash and the case of the host', () => {
        assert.equal(normalizeUrl('HTTPS://ArXiv.org/abs/2005.11401/#abstract'), 'https://arxiv.org/abs/2005.11401');
        assert.equal(normalizeUrl('https://a.org/p?x=1#y'), 'https://a.org/p?x=1');
        assert.equal(normalizeUrl('not a url'), 'not a url');
    });
});

// ─── The run ───────────────────────────────────────────────────────────────────────────────────

describe('writeWithGemini: the happy path', () => {
    it('researches with Google Search grounding, then writes from the notes with the writer schema, and gives back a draft that passes the checks', async () => {
        const g = happy();
        const result = await writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch, pace: 2.5 });

        const [research, write] = g.calls.filter((c) => isGemini(c));
        assert.deepEqual(research!.body.tools, [{ google_search: {} }]);
        assert.equal(research!.body.generationConfig.responseMimeType, undefined, 'no JSON type next to a tool: older models refuse it');
        assert.equal(research!.body.systemInstruction.parts[0].text, RESEARCH_SYSTEM);
        assert.match(research!.body.contents[0].parts[0].text, /^Topic: Why AI answers with confidence\nThe video will be in English/);

        assert.equal(write!.body.tools, undefined, 'the write step has no web tools: the notes are the whole truth');
        assert.equal(write!.body.generationConfig.responseMimeType, 'application/json');
        assert.deepEqual(write!.body.generationConfig.responseSchema, writerResponseSchema());
        assert.equal(write!.body.generationConfig.maxOutputTokens, 16_384);
        assert.match(write!.body.systemInstruction.parts[0].text, /RESEARCH \(already done for you\)/);
        assert.doesNotMatch(write!.body.systemInstruction.parts[0].text, /WebSearch|WebFetch/);
        assert.match(write!.body.systemInstruction.parts[0].text, /at 2\.5 words a second/);
        const asked = write!.body.contents[0].parts[0].text as string;
        assert.match(asked, /^Topic: Why AI answers with confidence/);
        assert.match(asked, /RAG was introduced by Lewis et al\. in 2020\.\[0\]/, 'the notes carry the source numbers');
        assert.match(asked, /\[0\] arxiv\.org — https:\/\/arxiv\.org\/abs\/2005\.11401\n\[1\] lmstudio\.ai — https:\/\/lmstudio\.ai\/docs\/app\/basics\/rag\n\[2\] arxiv\.org — https:\/\/arxiv\.org\/abs\/2005\.14165 \(given by the creator/);

        assert.equal(result.model, STUDIO_MODELS[0]);
        assert.equal(result.written.scenes.length, 12);
        assert.deepEqual(checkDraft(result.written, { tier: 'short', language: 'en' }).problems, []);
        assert.deepEqual(result.report, { queries: 2, sources_found: 3, sources_kept: 1, dropped_unknown_url: 0, dropped_uncited: 2, research_model: STUDIO_MODELS[0], repaired: false });
    });

    it('sends the key in a header and never in a URL, a body or a log line', async () => {
        const g = happy();
        await writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch });
        for (const call of g.calls.filter((c) => isGemini(c))) {
            assert.equal(call.headers['x-goog-api-key'], KEY);
            assert.ok(!call.url.includes(KEY), 'not in the URL');
            assert.ok(!JSON.stringify(call.body).includes(KEY), 'not in the body');
        }
        assert.ok(!logs.some((l) => l.line.includes(KEY)), 'not in the logs');
        assert.ok(!logs.some((l) => /Why AI answers with confidence|RAG was introduced/.test(l.line)), 'no prompt, no notes in the logs');
    });

    it('follows each redirect of the research to its page, once, with no key', async () => {
        const g = happy();
        await writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch });
        const gets = g.calls.filter((c) => c.method === 'GET');
        assert.deepEqual(gets.map((c) => c.url).sort(), [REDIRECT('AAA'), REDIRECT('BBB')]);
        assert.ok(gets.every((c) => c.redirect === 'manual' && !c.headers['x-goog-api-key']));
    });

    it('asks the Studio’s models, in order, from the first, and says what it is doing as it goes', async () => {
        const g = happy();
        const said: string[] = [];
        await writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch, onProgress: (t) => { said.push(t); } });
        assert.ok(g.calls.filter((c) => isGemini(c)).every((c) => modelOf(c) === STUDIO_MODELS[0]));
        assert.deepEqual(said, ['Gemini is researching the topic on the web', 'Gemini is writing the script from its notes']);
    });

    it('gives a longer script more room to be written in', async () => {
        const g = happy(validWriterOutput(12));
        await writeWithGemini({ request: { ...REQUEST, tier: 'long' }, key: KEY, fetch: g.fetch });
        assert.equal(g.calls.find((c) => isGemini(c, 'write'))!.body.generationConfig.maxOutputTokens, 65_536);
    });
});

describe('writeWithGemini: the models', () => {
    it('hands a call to the next model on 404, 429, 500, 503 and 400, and uses the first that answers', async () => {
        for (const status of [404, 429, 500, 503, 400]) {
            const g = scripted();
            g.on((c) => c.method === 'GET', { status: 302, headers: { location: ARXIV } });
            g.on((c) => isGemini(c, 'research') && modelOf(c) === STUDIO_MODELS[0], { status, json: { error: { code: status, message: `no ${status}`, status: 'X' } } });
            g.on((c) => isGemini(c, 'research'), { json: researchAnswer({ chunks: [{ web: { uri: REDIRECT('A'), title: 'arxiv.org' } }], supports: [] }) });
            g.on((c) => isGemini(c, 'write'), { json: writeAnswer(validWriterOutput(12, { sources: [{ title: 'T', by: 'B', year: '2020', url: ARXIV }] })) });
            const result = await writeWithGemini({ request: { ...REQUEST, sourceLinks: [] }, key: KEY, fetch: g.fetch });
            const research = g.calls.filter((c) => isGemini(c, 'research')).map(modelOf);
            assert.deepEqual(research, [STUDIO_MODELS[0], STUDIO_MODELS[1]], `after ${status}`);
            assert.equal(modelOf(g.calls.find((c) => isGemini(c, 'write'))!), STUDIO_MODELS[0], 'the write call starts from the first model again');
            assert.equal(result.report.research_model, STUDIO_MODELS[1]);
        }
    });

    it('stops at the last model’s refusal, saying what Gemini said, and why a free key may be refused', async () => {
        const g = scripted();
        g.on((c) => isGemini(c), { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: grounded_requests, limit: 0' } } });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch }), (err: unknown) => {
            assert.ok(err instanceof GeminiWriteError);
            assert.equal(err.stage, 'research');
            assert.match(err.message, /Gemini refused the research call on every model it tried \(HTTP 429: Quota exceeded for metric: grounded_requests, limit: 0\)\./);
            assert.ok(err.message.endsWith(GROUNDING_HINT));
            assert.match(GROUNDING_HINT, /on the free tier it is not available for Gemini 3 models \(ai\.google\.dev\/gemini-api\/docs\/pricing\)/);
            return true;
        });
        assert.equal(g.calls.filter((c) => isGemini(c)).length, STUDIO_MODELS.length, 'every model was tried once');
    });

    it('does not hand over on a status that is not about the model (401: the key), and the models it is given are the ones it asks', async () => {
        const g = scripted();
        g.on((c) => isGemini(c), { status: 401, json: { error: { code: 401, message: 'API key not valid. Please pass a valid API key.' } } });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch, models: ['m-a', 'm-b'] }), /HTTP 401: API key not valid/);
        assert.deepEqual(g.calls.map(modelOf), ['m-a']);
    });

    it('is a 5xx page that is not JSON: said as what it is, not as a parse error', async () => {
        const g = scripted();
        g.on((c) => isGemini(c), { status: 503, text: '<html>Service Unavailable</html>' });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch, models: ['only'] }), /HTTP 503: <html>Service Unavailable<\/html>/);
    });
});

describe('writeWithGemini: what goes wrong', () => {
    it('has no key to ask with: it says where to save one', async () => {
        const g = scripted();
        await assert.rejects(writeWithGemini({ request: REQUEST, key: '', fetch: g.fetch }), (err: unknown) => err instanceof GeminiWriteError && err.stage === 'key' && err.message === MISSING_GEMINI_KEY);
        assert.equal(g.calls.length, 0);
    });

    it('research that comes back empty is an error, with the reason Gemini gave', async () => {
        const g = scripted();
        g.on((c) => isGemini(c, 'research'), { json: { candidates: [{ finishReason: 'SAFETY' }], promptFeedback: { blockReason: 'OTHER' } } });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch }), /research came back empty \(finishReason SAFETY, blockReason OTHER\)/);
    });

    it('a script that is not JSON (cut off by the output limit) is an error, with the reason Gemini gave', async () => {
        const g = scripted();
        g.on((c) => c.method === 'GET', { status: 302, headers: { location: ARXIV } });
        g.on((c) => isGemini(c, 'research'), { json: researchAnswer() });
        g.on((c) => isGemini(c, 'write'), { json: { candidates: [{ content: { parts: [{ text: '{"title": "Why AI' }] }, finishReason: 'MAX_TOKENS' }] } });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch }), /script is not valid JSON \(.*finishReason MAX_TOKENS/);
    });

    it('asks again once when the script does not fit the schema, showing its own answer and the problems, and keeps the repaired one', async () => {
        const g = scripted();
        g.on((c) => c.method === 'GET', { status: 302, headers: { location: ARXIV } });
        g.on((c) => isGemini(c, 'research'), { json: researchAnswer() });
        const broken: any = validWriterOutput(12);
        delete broken.first_comment;
        broken.scenes = broken.scenes.slice(0, 9);
        let writes = 0;
        g.on((c) => isGemini(c, 'write'), () => ({ json: writeAnswer(++writes === 1 ? broken : validWriterOutput(12)) }));
        const result = await writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch });
        assert.equal(result.report.repaired, true);
        const repair = g.calls.filter((c) => isGemini(c, 'write'))[1]!;
        assert.deepEqual(repair.body.contents.map((t: any) => t.role), ['user', 'model', 'user']);
        assert.equal(JSON.parse(repair.body.contents[1].parts[0].text).scenes.length, 9, 'shown its own answer');
        assert.match(repair.body.contents[2].parts[0].text, /does not fit the schema:\n- the answer is missing "first_comment"\n- scenes has 9 items; at least 10 are needed/);
        assert.equal(result.written.scenes.length, 12);
    });

    it('gives up after the one repair, naming the problems', async () => {
        const g = scripted();
        g.on((c) => c.method === 'GET', { status: 302, headers: { location: ARXIV } });
        g.on((c) => isGemini(c, 'research'), { json: researchAnswer() });
        g.on((c) => isGemini(c, 'write'), { json: writeAnswer({ title: 'x' }) });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch }), (err: unknown) =>
            err instanceof GeminiWriteError && err.stage === 'answer' && /does not fit the schema, even after one repair: .*title is 1 character/.test(err.message));
        assert.equal(g.calls.filter((c) => isGemini(c, 'write')).length, 2, 'one repair and no more');
    });

    it('runs out of time rather than start a call it cannot finish', async () => {
        const g = scripted();
        let clock = 1_000_000;
        const now = () => clock;
        g.on((c) => c.method === 'GET', { status: 302, headers: { location: ARXIV } });
        g.on((c) => isGemini(c, 'research'), () => { clock += 245_000; return { json: researchAnswer() }; });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch, now }), (err: unknown) => err instanceof GeminiWriteError && err.stage === 'time' && /Out of time before trying/.test(err.message));
    });

    it('says a call timed out as that, and a network failure as that', async () => {
        const timeout = scripted();
        timeout.on((c) => isGemini(c), () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: timeout.fetch }), /did not answer the research call in time/);
        const down = scripted();
        down.on((c) => isGemini(c), () => { throw new Error('ECONNRESET'); });
        await assert.rejects(writeWithGemini({ request: REQUEST, key: KEY, fetch: down.fetch }), /Gemini could not be reached/);
    });
});

describe('writeWithGemini: what it refuses to keep', () => {
    it('drops a source the model invented, and every id that named it: the first comment is rebuilt from what is left', async () => {
        const out = validWriterOutput(12, { sources: [
            { title: 'Real', by: 'Lewis et al.', year: '2020', url: ARXIV }, { title: 'Invented', by: 'Nobody', year: '2031', url: 'https://invented.example/paper' },
        ] });
        out.scenes = out.scenes.map((scene, i) => ({ ...scene, source_ids: i === 0 ? [0, 1] : i === 1 ? [1] : i === 2 ? [0] : [] }));
        out.first_comment = 'Sources\n1. https://invented.example/paper';
        const g = happy(out);
        const result = await writeWithGemini({ request: REQUEST, key: KEY, fetch: g.fetch });
        assert.deepEqual(result.written.sources, [{ title: 'Real', by: 'Lewis et al.', year: '2020', url: ARXIV }]);
        assert.deepEqual(result.written.scenes.slice(0, 3).map((s) => s.source_ids), [[0], [], [0]]);
        assert.equal(result.written.first_comment, `Sources:\n1. Real — Lewis et al. (2020)\n${ARXIV}`);
        assert.equal(result.report.dropped_unknown_url, 1);
        assert.deepEqual(checkDraft(result.written, { tier: 'short', language: 'en' }).problems, [], 'no id points at a source that is gone');
    });

    it('with no source found it still writes, with none: the draft is flagged by the checks, not made up', async () => {
        const g = scripted();
        g.on((c) => isGemini(c, 'research'), { json: researchAnswer({ chunks: [], supports: [] }) });
        g.on((c) => isGemini(c, 'write'), () => ({ json: writeAnswer(validWriterOutput(12, { sources: [{ title: 'Memory', by: 'x', year: '2020', url: 'https://from-memory.example' }] })) }));
        const result = await writeWithGemini({ request: { ...REQUEST, sourceLinks: [] }, key: KEY, fetch: g.fetch });
        assert.deepEqual(result.written.sources, []);
        assert.equal(result.written.first_comment, '');
        assert.ok(result.written.scenes.every((s) => s.source_ids.length === 0));
        assert.match(g.calls.find((c) => isGemini(c, 'write'))!.body.contents[0].parts[0].text, /NUMBERED SOURCES: none were found/);
        assert.deepEqual(checkDraft(result.written, { tier: 'short', language: 'en' }).warnings.map((w) => w.code), ['needs_sources']);
    });

    it('an Arabic script gets an Arabic first comment', async () => {
        const out = validWriterOutput(12, { sources: [{ title: 'Real', by: 'B', year: '2020', url: ARXIV }] });
        const g = happy(out);
        const result = await writeWithGemini({ request: { ...REQUEST, language: 'ar', sourceLinks: [] }, key: KEY, fetch: g.fetch });
        assert.match(result.written.first_comment, /^المصادر:\n1\. Real/);
    });

    it('does not mutate the request it was given', async () => {
        const request = structuredClone(REQUEST);
        await writeWithGemini({ request, key: KEY, fetch: happy().fetch });
        assert.deepEqual(request, REQUEST);
    });
});

describe('the scene fixture', () => {
    it('is what the tests above rely on: a scene that passes every check', () => {
        assert.deepEqual(checkDraft({ ...validWriterOutput(12), scenes: [writerScene(0), ...validWriterOutput(12).scenes.slice(1)] }, { tier: 'short', language: 'en' }).problems, []);
    });
});
