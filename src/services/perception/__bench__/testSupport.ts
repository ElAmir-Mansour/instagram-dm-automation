/**
 * What the benchmark's tests share: the committed cases, a scripted stand-in for the network, and a small XML reader. Imported by tests only (a file with this exact name is the repo's
 * exempt kind: `jsonb.test.ts` fails a production module that imports one).
 *
 * The stand-in for the network is the whole of "mocked HTTP": a `fetch` that answers what Meta, Baseten or Anthropic would, from a script, records every request (its host, its
 * key header and its parsed body) and never reaches out. A test that wants to be sure nothing went anywhere else reads `requests`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../llm/types.js';
import { loadCasesFile } from './cases.js';
import type { MuseCase, ParsedCases } from './types.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const CASES_FILE = path.join(REPO, 'scripts', 'eval-muse', 'cases.json');

let loaded: ParsedCases | undefined;

/** The committed cases file, parsed once. */
export function committed(): ParsedCases {
    loaded ??= loadCasesFile(CASES_FILE);
    return loaded;
}

export function caseOf(id: string): MuseCase {
    const c = committed().cases.find((x) => x.id === id);
    if (!c) throw new Error(`no case ${id}`);
    return c;
}

/** A key as a real one looks, so that a test can search everything printed for it. */
export const META_KEY = 'meta-test-key-Hb7vQm3xTz9RnYd2KfP5aLc8JgSe4UoWiNtXrBwEs6Vq';
export const ANTHROPIC_KEY = 'sk-ant-test-key-Zq8Lm2Pw5Xr9Nd3Fk7Gb4Hv6Jt1Cy0Sa';
export const BASETEN_KEY = 'b10_Ab12Cd34.Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv';

export interface Recorded {
    url: string;
    host: string;
    method: string;
    authorization: string | null;
    apiKeyHeader: string | null;
    contentType: string | null;
    /** The JSON body, or null for a body that is not JSON (an audio upload). */
    body: any;
    rawBody: string | null;
}

export type Scripted = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** A `fetch` that answers from `respond` and records every request. */
export function scriptedFetch(respond: (r: Recorded, n: number) => Scripted | Promise<Scripted>): { fetch: FetchLike; requests: Recorded[] } {
    const requests: Recorded[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
        const headers = new Headers(init.headers as HeadersInit | undefined);
        const raw = typeof init.body === 'string' ? init.body : null;
        let body: unknown = null;
        if (raw !== null) {
            try {
                body = JSON.parse(raw);
            } catch {
                body = null;
            }
        }
        const recorded: Recorded = {
            url: input, host: new URL(input).host, method: String(init.method ?? 'GET'), authorization: headers.get('authorization'), apiKeyHeader: headers.get('x-api-key'),
            contentType: headers.get('content-type'), body, rawBody: raw,
        };
        requests.push(recorded);
        const answer = await respond(recorded, requests.length);
        const status = answer.status ?? 200;
        return new Response(answer.text ?? JSON.stringify(answer.json ?? {}), { status, headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) } });
    };
    return { fetch: fetchImpl, requests };
}

/** A chat-completions answer in the shape Meta, Baseten and OpenAI-compatible endpoints send. */
export function chatAnswer(content: unknown, usage: { prompt: number; completion: number; cached?: number } = { prompt: 1000, completion: 400 }, model = 'muse-spark-1.3'): Scripted {
    return {
        json: {
            id: 'chat-test', model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }],
            usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, prompt_tokens_details: { cached_tokens: usage.cached ?? 0 } },
        },
    };
}

/** An Anthropic Messages answer holding `text`, for a stand-in judge. */
export function anthropicAnswer(text: unknown): Scripted {
    return { json: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }], stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 300 } } };
}

/** What a chat request carries, for a test to tell one kind of call from another. */
export function messagesOf(r: Recorded): any[] {
    return Array.isArray(r.body?.messages) ? r.body.messages : [];
}

export const hasMedia = (r: Recorded): boolean => /"(?:image_url|video_url)"/.test(r.rawBody ?? '');

/** The text of the last user message of a chat request, whether it is a string or parts. */
export function lastUserText(r: Recorded): string {
    const users = messagesOf(r).filter((m) => m.role === 'user');
    const content = users[users.length - 1]?.content;
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('') : '';
}

export const systemText = (r: Recorded): string => String(messagesOf(r).find((m) => m.role === 'system')?.content ?? '');

// ─── A small XML reader: well-formed or not ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether `xml` is well-formed in the ways a chart can fail to be: one root, every tag closed in order, attributes quoted with no stray `<` or `&`, text with only the five
 * entities (and numeric ones). Returns the problems (empty is well-formed). Node has no XML parser, and a chart that GitHub cannot draw is a chart that is not there.
 */
export function xmlProblems(xml: string): string[] {
    const problems: string[] = [];
    const stack: string[] = [];
    let roots = 0;
    let i = 0;
    const text = xml.replace(/^﻿/, '');
    const entityOk = (s: string): boolean => !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s);
    while (i < text.length) {
        const lt = text.indexOf('<', i);
        const chunk = text.slice(i, lt === -1 ? text.length : lt);
        if (!entityOk(chunk)) problems.push(`a bad entity in text near "${chunk.slice(0, 30)}"`);
        if (chunk.includes('>') ) problems.push(`a stray ">" in text near "${chunk.slice(0, 30)}"`);
        if (stack.length === 0 && chunk.trim() !== '') problems.push('text outside the root');
        if (lt === -1) break;
        if (text.startsWith('<!--', lt)) {
            const end = text.indexOf('-->', lt + 4);
            if (end === -1) { problems.push('an unclosed comment'); break; }
            i = end + 3;
            continue;
        }
        const gt = text.indexOf('>', lt);
        if (gt === -1) { problems.push('an unclosed tag'); break; }
        const tag = text.slice(lt + 1, gt);
        i = gt + 1;
        if (tag.startsWith('?')) continue;
        if (tag.startsWith('/')) {
            const name = tag.slice(1).trim();
            const open = stack.pop();
            if (open !== name) problems.push(`</${name}> closes ${open ? `<${open}>` : 'nothing'}`);
            continue;
        }
        const selfClosing = tag.endsWith('/');
        const body = selfClosing ? tag.slice(0, -1) : tag;
        const name = /^[A-Za-z_][\w:.-]*/.exec(body)?.[0];
        if (!name) { problems.push(`a tag with no name: <${tag.slice(0, 20)}>`); continue; }
        const attrs = body.slice(name.length);
        // Every attribute is name="value" or name='value', separated by space, and a value holds no raw `<` and no bad entity.
        let rest = attrs;
        while (rest.trim() !== '') {
            const m = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
            if (!m) { problems.push(`a bad attribute in <${name}>: ${rest.trim().slice(0, 30)}`); break; }
            const value = m[3] ?? m[4] ?? '';
            if (value.includes('<') || !entityOk(value)) problems.push(`a bad value in <${name} ${m[1]}>`);
            rest = rest.slice(m[0].length);
        }
        if (stack.length === 0) roots++;
        if (!selfClosing) stack.push(name);
    }
    if (stack.length > 0) problems.push(`unclosed: ${stack.join(', ')}`);
    if (roots !== 1) problems.push(`${roots} roots`);
    return problems;
}
