/**
 * Tests only: the whole world the video memory runs in, in memory, for the tests of the indexer, the library and its routes. Not a test file itself, so `npm test` does
 * not run it. Nothing here reaches a database, Meta, Baseten or a CDN.
 *
 *   ai          the AI layer's own stand-in (`../../aiProviders/testDb.ts`): `app_settings` (the switches, the cap, the provider keys, the routes) and `ai_usage`
 *   reel        the video memory's tables (`testDb.ts`): `reel_analyses`, the tenant's `creators` row and the `scheduled_posts` that link a YouTube copy
 *   graph       `metaHttp.get`, answering the two reads the video memory makes: a media node (`GET /{id}`) and the media list (`GET /{ig-user}/media`)
 *   providers   `setProviderFetch`: every request the providers layer makes, by host, so a test can read EXACTLY what Baseten or Meta would have been sent
 *   downloads   the `fetch` handed to `fetchMedia`: the bytes behind each media URL, by URL
 *   queue       `setJobQueue`: the jobs the queue code enqueues, with the dedupe a real queue gives (a second job with the same key is dropped)
 *   logs        every log line, parsed
 *
 * Every key and link in it is made up and built at run time; the "video" is a few bytes.
 */
import { setLogSink } from '../../../utils/log.js';
import { metaHttp } from '../../http.js';
import { GRAPH_BASE } from '../../instagram.js';
import { setJobQueue } from '../../../jobs/queue.js';
import type { EnqueueInput, Job, JobQueue } from '../../../jobs/types.js';
import { installAiDb, type AiDb } from '../../aiProviders/testDb.js';
import { setProviderFetch } from '../../aiProviders/generate.js';
import { FAKE_KEYS } from '../../aiProviders/testKeys.js';
import type { FetchLike } from '../../llm/types.js';
import { jsonResponse, type Recorded, type Scripted } from '../../llm/testFetch.js';
import { installReelDb, type ReelDb } from './testDb.js';

export const OWNER = '11111111-1111-4111-8111-111111111111';
export const TENANT = '44444444-4444-4444-8444-444444444444';
export const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
export const IG_USER = '17841400000000009';
export const PAGE_TOKEN = 'EAAG' + 'PageTokenSentinel'.repeat(3) + 'pg1';
export const BASETEN_MODEL = 'meta-models/muse-spark-open-1026';

/** The bytes of a "video": enough to be recognised in a request body and nowhere else. */
export const VIDEO_BYTES = Buffer.from('VIDEO-BYTES-SENTINEL-not-a-real-mp4');
export const VIDEO_BASE64 = VIDEO_BYTES.toString('base64');

export interface GraphNode {
    id?: string;
    media_type?: string;
    media_product_type?: string;
    permalink?: string;
    timestamp?: string;
    media_url?: string;
}

export interface World {
    ai: AiDb;
    reel: ReelDb;
    logs: { level: string; event: string; [k: string]: unknown }[];
    graph: {
        /** Every Graph read: its path (after the version), params and headers. */
        calls: { path: string; params: Record<string, unknown>; headers: Record<string, string> }[];
        /** The answer for `GET /{id}`: a node, or an error to throw (an axios-shaped one). */
        nodes: Map<string, GraphNode | Error>;
        /** The pages of `GET /{ig-user}/media`, in order: each `{ data, after? }`; an Error is thrown. */
        pages: ({ data: GraphNode[]; after?: string } | Error)[];
    };
    /** Every request the providers layer made, in order, with the host it went to. */
    providers: { calls: (Recorded & { host: string })[]; scripts: Record<string, Scripted[]> };
    /** The bytes (or a refusal) behind each media URL, and the URLs asked for, in order. */
    downloads: { urls: string[]; answers: Map<string, () => Response> };
    queue: { enqueued: (EnqueueInput & { id: string })[]; jobs: Map<string, string> };
    /** Everything every statement mentioned, from both stand-ins, in order: the privacy tests read it. */
    sql(): string[];
    fetchImpl: FetchLike;
    restore(): void;
}

/** What Baseten and Meta answer to a good reel analysis: the same JSON, in the OpenAI chat shape, with the usage of the live reel of 2026-10-29. */
export const GOOD_ANALYSIS = {
    summary: 'A story about a meal priced at 45 SAR that was paid for with 1 SAR, because the server trusted the price the page sent.',
    topics: ['frontend vs backend', 'never trust the client', 'الباك إند', 'DevTools'],
    seen_on_screen: ['Headline: وجبة بـ 45 ريالاً... دُفع فيها ريالٌ واحد!', 'Code: const total = req.body.price'],
    narration: 'وجد كريم في موقعه طلبيّة غريبة.\nالخادم لا يرى صفحتك.',
    key_moments: [{ second: 16, what: 'Real and fake payloads side by side' }, { second: 0, what: 'The 45 vs 1 riyal headline' }],
    hook_first_3s: 'A worried developer and the headline.',
    hook_score: 9,
    caption_ar: 'وجبة بـ 45 ريال والزبون دفع ريال واحد!',
    cover_second: 6,
    cover_reason: 'Both price bubbles are visible together.',
};

export const chatAnswer = (model: string, json: unknown, usage: Record<string, unknown> = { prompt_tokens: 5863, completion_tokens: 3371 }, finish = 'stop'): Response =>
    jsonResponse(200, {
        id: 'chatcmpl-1', object: 'chat.completion', model,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: typeof json === 'string' ? json : JSON.stringify(json), reasoning_content: 'thinking' } }],
        usage,
    });

/** What a Graph failure looks like once axios has thrown it: a response with Meta's `error` body. */
export function graphError(status: number, code: number, subcode?: number): Error {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data: { error: { code, message: 'Graph said no', ...(subcode ? { error_subcode: subcode } : {}) } } },
    });
}

/** A transport failure with no response at all: Meta was not reached. */
export const graphUnreachable = (): Error => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

export function installWorld(opts: { tenants?: boolean } = {}): World {
    const ai = installAiDb({ owner: OWNER });
    const reel = installReelDb();
    const logs: World['logs'] = [];
    const previousSink = setLogSink((level, line) => { logs.push({ level, ...JSON.parse(line) }); });

    if (opts.tenants !== false) {
        reel.creators.set(TENANT, { id: TENANT, instagram_page_id: IG_USER, page_access_token: PAGE_TOKEN, is_active: true });
    }

    const world: World = {
        ai, reel, logs,
        graph: { calls: [], nodes: new Map(), pages: [] },
        providers: { calls: [], scripts: {} },
        downloads: { urls: [], answers: new Map() },
        queue: { enqueued: [], jobs: new Map() },
        sql: () => [...ai.statements.map((s) => s.sql), ...reel.statements.map((s) => s.sql)],
        fetchImpl: async (url) => {
            world.downloads.urls.push(url);
            const answer = world.downloads.answers.get(url);
            if (!answer) throw new Error(`no download scripted for ${new URL(url).host}`);
            return answer();
        },
        restore: () => undefined,
    };

    // Graph: `metaHttp.get` (what `GraphSession` calls).
    const originalGet = metaHttp.get;
    (metaHttp as unknown as { get: unknown }).get = async (url: string, config: { params?: Record<string, unknown>; headers?: Record<string, string> } = {}) => {
        const path = url.startsWith(`${GRAPH_BASE}/`) ? url.slice(GRAPH_BASE.length + 1) : url;
        world.graph.calls.push({ path, params: { ...(config.params ?? {}) }, headers: { ...(config.headers ?? {}) } });
        if (path.endsWith('/media')) {
            const page = world.graph.pages.shift();
            if (!page) throw new Error('no media page scripted');
            if (page instanceof Error) throw page;
            return { data: { data: page.data, ...(page.after ? { paging: { cursors: { after: page.after }, next: 'https://graph.example/next-not-followed' } } : {}) }, headers: {} };
        }
        const node = world.graph.nodes.get(path);
        if (!node) throw new Error(`no node scripted for ${path}`);
        if (node instanceof Error) throw node;
        return { data: { id: path, ...node }, headers: {} };
    };

    // The providers layer: one `fetch` for every provider, scripted per host.
    setProviderFetch(async (url, init) => {
        const host = new URL(url).host;
        const raw = String(init.body ?? '');
        world.providers.calls.push({
            url, method: init.method, host,
            headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
            raw, body: raw ? JSON.parse(raw) : undefined, signal: init.signal, redirect: init.redirect,
        });
        const next = world.providers.scripts[host]?.shift();
        if (!next) throw new Error(`no provider answer scripted for ${host}`);
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    });

    // The job queue: a real queue drops a second job with the same dedupe key, whatever state the first is in.
    let jobNo = 0;
    const queue: JobQueue = {
        async enqueue(input) {
            if (input.dedupeKey && world.queue.jobs.has(input.dedupeKey)) return null;
            const id = `job-${++jobNo}`;
            if (input.dedupeKey) world.queue.jobs.set(input.dedupeKey, id);
            world.queue.enqueued.push({ ...(input as EnqueueInput), id });
            return id;
        },
        async claim(): Promise<Job[]> { return []; },
        async complete() {},
        async fail() {},
        async reapStale() { return 0; },
        async releaseUnrun() { return 0; },
        async pruneCompleted() { return 0; },
    };
    const previousQueue = setJobQueue(queue);

    world.restore = () => {
        ai.restore();
        setLogSink(previousSink);
        (metaHttp as unknown as { get: unknown }).get = originalGet;
        setProviderFetch(undefined);
        setJobQueue(previousQueue);
    };
    return world;
}

/** The owner's settings for the video memory: the switch, a daily cap, the keys, and who answers `reel_index`. */
export function configure(world: World, opts: {
    memory?: boolean; capUsd?: string | null; keys?: ('baseten' | 'meta')[]; route?: 'baseten' | 'meta' | null; tenant?: string;
} = {}): void {
    const tenant = opts.tenant ?? TENANT;
    const { ai } = world;
    if (opts.memory !== false) ai.setSetting(`muse.switches.${tenant}`, JSON.stringify({ dm_media: false, voice: false, memory: true }));
    if (opts.capUsd !== null) ai.setSetting(`muse.daily_usd.${tenant}`, opts.capUsd ?? '3');
    for (const key of opts.keys ?? ['baseten', 'meta']) ai.setSetting(`ai.providers.${key}.api_key`, FAKE_KEYS[key], true);
    if (opts.route === 'baseten') ai.setSetting('ai.routing', JSON.stringify({ reel_index: { provider: 'baseten', model: BASETEN_MODEL, effort: 'low' } }));
    if (opts.route === 'meta') ai.setSetting('ai.routing', JSON.stringify({ reel_index: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' } }));
}

/** A Graph node for a reel, with its own fresh media URL, and the bytes behind that URL. */
export function addReel(world: World, id: string, over: { url?: string; node?: GraphNode; bytes?: Buffer; headers?: Record<string, string> } = {}): { url: string } {
    const url = over.url ?? `https://scontent-fra5-1.cdninstagram.com/o1/v/t16/f2/m69/${id}.mp4?_nc_sid=fresh-${id}&oh=00_${id}&oe=69999999`;
    world.graph.nodes.set(id, {
        media_type: 'VIDEO', media_product_type: 'REELS', permalink: `https://www.instagram.com/reel/${id}/`, timestamp: '2026-10-20T12:00:00+0000', media_url: url, ...over.node,
    });
    const bytes = over.bytes ?? VIDEO_BYTES;
    world.downloads.answers.set(url, () => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length), ...over.headers } }));
    return { url };
}

/** Scripts what a provider host answers next. */
export function answerOn(world: World, host: 'inference.baseten.co' | 'api.meta.ai', ...script: Scripted[]): void {
    world.providers.scripts[host] = [...(world.providers.scripts[host] ?? []), ...script];
}
