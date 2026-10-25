/**
 * Character candidates (T047, spec US2): four pictures at 448×448 drawn from a description, for the owner to approve one as a character's
 * reference. They are drawn together, cost four pictures of the allowance (reserved together, before the first call), and the same guard
 * applies as for a scene: a description that names a woman or a girl is refused before anything is read, reserved or called.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../../config/db.js';
import { setLogSink } from '../../../utils/log.js';
import { installFakeDb, type FakeDb } from '../../monteur/testDb.js';
import { setMediaStore, type MediaStore } from '../../storage.js';
import { ExplainerError } from '../errors.js';
import { resumeAt, utcDay } from './allowance.js';
import { CANDIDATE_COUNT, drawCandidates } from './candidates.js';
import { buildCandidatePrompt, CANDIDATE_SIZE } from './prompt.js';
import { setImageProvider, type ImageProvider } from './provider.js';
import {
    exhausted, FakeMediaStore, installAllowanceTable, installSettings, jpegHeader, PNG_1X1, refused, SAVED_PROVIDER, ScriptedProvider, type AllowanceTableRow,
} from './testSupport.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const STYLE = 'warm hand-painted gouache illustration, beige and terracotta palette';
const DESCRIPTION = 'a curious young man with a round head, short dark hair, dot eyes, dark green sweater';
const OK = { data: PNG_1X1, mime: 'image/png', provider: 'cloudflare', model: MODEL } as const;

let db: FakeDb;
let store: FakeMediaStore;
let provider: ScriptedProvider;
let table: AllowanceTableRow[];
let held: number;
let explainerSettings: unknown;
let previousStore: MediaStore | null;
let previousProvider: ImageProvider | null | undefined;
let logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink((level, line) => { const { ts: _ts, level: _level, event, ...fields } = JSON.parse(line); logs.push({ level, event, fields }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    logs = [];
    held = 0;
    explainerSettings = { style: STYLE };
    db = installFakeDb();
    store = new FakeMediaStore();
    installSettings(db, { 'explainers.image_provider': SAVED_PROVIDER });
    table = installAllowanceTable(db);
    db.routes.push([/^SELECT explainer FROM studio_settings WHERE creator_id = \$1$/, () => ({ rows: explainerSettings === null ? [] : [{ explainer: explainerSettings }] })]);
    const connect = (pool as unknown as { connect: () => Promise<{ query: unknown; release: () => void }> }).connect;
    (pool as unknown as { connect: unknown }).connect = async () => {
        const client = await connect.call(pool);
        held++;
        return { query: client.query, release() { held--; client.release(); } };
    };
    provider = new ScriptedProvider([OK]);
    previousStore = setMediaStore(store);
    previousProvider = setImageProvider(provider);
});

afterEach(() => {
    setMediaStore(previousStore);
    setImageProvider(previousProvider);
    db.restore();
});

const today = (): AllowanceTableRow | undefined => table.find((r) => r.day === utcDay());
const rejects = (code: string, status: number, text?: RegExp) => (err: unknown) => {
    assert.ok(err instanceof ExplainerError, `an ExplainerError, not ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    if (text) assert.match(err.message, text);
    return true;
};
const isResumeTime = (iso: unknown): boolean => [resumeAt(new Date(Date.now() - 2000)).toISOString(), resumeAt(new Date()).toISOString()].includes(String(iso));

describe('drawCandidates — what is drawn', () => {
    it('draws four pictures at 448×448 from the description, in the style of the settings, with no reference', async () => {
        assert.equal(CANDIDATE_COUNT, 4);
        await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.equal(provider.requests.length, 4);
        for (const request of provider.requests) {
            assert.deepEqual([request.width, request.height], [CANDIDATE_SIZE.width, CANDIDATE_SIZE.height]);
            assert.equal(request.prompt, buildCandidatePrompt({ style: STYLE, description: DESCRIPTION }));
            assert.deepEqual(request.references ?? [], []);
        }
        assert.ok(CANDIDATE_SIZE.width < 512 && CANDIDATE_SIZE.height < 512, 'an approved candidate is small enough to be a reference');
    });

    it('gives each of the four its own seed, a whole number below 2^31, and a different set every time', async () => {
        await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        const first = provider.requests.map((r) => r.seed);
        assert.equal(new Set(first).size, 4);
        for (const seed of first) assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31, String(seed));
        await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.notDeepEqual(provider.requests.slice(4).map((r) => r.seed), first);
    });

    it('stores each picture as an upload of the tenant, with the type its bytes have, and answers with their ids and URLs on our own address, in draw order', async () => {
        provider.answers = [OK, { ...OK, data: jpegHeader(448, 448), mime: 'image/jpeg' }, OK, OK];
        const { candidates } = await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.equal(store.puts.length, 4);
        assert.deepEqual(candidates, store.puts.map((put) => ({ media_id: put.id, url: `/api/uploads/${put.id}` })));
        assert.deepEqual(store.puts.map((put) => put.mimeType), ['image/png', 'image/jpeg', 'image/png', 'image/png']);
        assert.deepEqual(store.puts.map((put) => put.filename), ['explainer-candidate-1.png', 'explainer-candidate-2.jpg', 'explainer-candidate-3.png', 'explainer-candidate-4.png']);
        for (const put of store.puts) assert.equal(put.creatorId, TENANT);
    });

    it('uses the default style when the tenant has saved none', async () => {
        explainerSettings = null;
        await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.match(provider.requests[0]!.prompt, /^Style: warm hand-painted gouache illustration/);
    });

    it('logs how many were drawn and nothing of the description', async () => {
        await drawCandidates({ creatorId: TENANT, description: `${DESCRIPTION} SECRET-WORDS` });
        const logged = logs.find((l) => l.event === 'explainer.candidates_drawn');
        assert.ok(logged);
        assert.deepEqual([logged.fields.drawn, logged.fields.failed], [4, 0]);
        assert.equal(JSON.stringify(logs).includes('SECRET-WORDS'), false);
    });
});

describe('drawCandidates — the allowance', () => {
    it('reserves all four pictures in one reservation, before the first call, and counts them against the day', async () => {
        provider.onDraw = () => { db.statements.push({ sql: '-- provider.draw', params: [] }); };
        await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        const all = db.statements.map((s) => s.sql);
        const reserves = all.flatMap((sql, i) => (/^INSERT INTO image_allowance AS a \(provider, day, units, pictures\) SELECT/.test(sql) ? [i] : []));
        assert.equal(reserves.length, 1, 'one reservation for the four');
        assert.ok(reserves[0]! < all.indexOf('-- provider.draw'), 'and it comes first');
        assert.deepEqual(db.statements[reserves[0]!]!.params, ['cloudflare', utcDay(), 110, 4, 80]);
        assert.deepEqual([today()?.units, today()?.pictures], [440, 4]);
    });

    it('holds no transaction and no pooled client while the provider draws', async () => {
        const seen: number[] = [];
        provider.onDraw = () => { seen.push(held); };
        await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.deepEqual(seen, [0, 0, 0, 0]);
        assert.equal(db.ran(/^BEGIN$/).length, 0);
    });

    it('is 429 EXPLAINER_ALLOWANCE_PAUSED, with nothing reserved and nothing called, when the four do not fit in what is left of today’s cap', async () => {
        table.push({ provider: 'cloudflare', day: utcDay(), units: 78 * 110, pictures: 78, exhausted_at: null });
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), (err: unknown) => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_ALLOWANCE_PAUSED');
            assert.equal(err.status, 429);
            assert.ok(isResumeTime(err.params?.retryAt));
            return true;
        });
        assert.equal(provider.requests.length, 0);
        assert.equal(today()?.pictures, 78);
        assert.equal(store.puts.length, 0);
    });

    it('is 429 while the provider has said the allowance is used up', async () => {
        table.push({ provider: 'cloudflare', day: utcDay(), units: 110, pictures: 1, exhausted_at: new Date() });
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), rejects('EXPLAINER_ALLOWANCE_PAUSED', 429, /used up/));
        assert.equal(provider.requests.length, 0);
    });

    it('gives back the units of the pictures that failed, and returns the ones that were drawn', async () => {
        provider.answers = [OK, refused(), OK, OK];
        const { candidates } = await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.equal(candidates.length, 3);
        assert.deepEqual([today()?.units, today()?.pictures], [330, 3]);
        assert.deepEqual(store.puts.map((p) => p.filename), ['explainer-candidate-1.png', 'explainer-candidate-3.png', 'explainer-candidate-4.png']);
        assert.equal(logs.find((l) => l.event === 'explainer.candidates_drawn')?.fields.failed, 1);
    });

    it('when the provider says the allowance is used up on one of them: marks the day, keeps those units, and still returns the others', async () => {
        provider.answers = [OK, exhausted(), OK, OK];
        const { candidates } = await drawCandidates({ creatorId: TENANT, description: DESCRIPTION });
        assert.equal(candidates.length, 3);
        assert.ok(today()?.exhausted_at, 'the day is marked');
        assert.deepEqual([today()?.units, today()?.pictures], [440, 4]);
    });

    it('is 502 EXPLAINER_PROVIDER_ERROR with the provider’s words when none was drawn, and gives all four back', async () => {
        provider.answers = [refused('Cloudflare refused the picture: bad token')];
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), rejects('EXPLAINER_PROVIDER_ERROR', 502, /^Cloudflare refused the picture: bad token$/));
        assert.deepEqual([today()?.units, today()?.pictures], [0, 0]);
        assert.equal(store.puts.length, 0);
    });

    it('is 429 when none was drawn and the provider said the allowance is used up; an exhaustion outranks the other errors, and only the failures are given back', async () => {
        provider.answers = [exhausted(), refused(), refused(), refused()];
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), (err: unknown) => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_ALLOWANCE_PAUSED');
            assert.ok(isResumeTime(err.params?.retryAt));
            return true;
        });
        assert.deepEqual([today()?.units, today()?.pictures], [110, 1]);
        assert.ok(today()?.exhausted_at);
    });

    it('is 429 when all four say the allowance is used up, with the units kept', async () => {
        provider.answers = [exhausted()];
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), rejects('EXPLAINER_ALLOWANCE_PAUSED', 429, /used up/));
        assert.deepEqual([today()?.units, today()?.pictures], [440, 4]);
    });

    it('is 502 and keeps the units when the pictures were drawn and none could be saved', async () => {
        store.failPut = new Error('Storage is not reachable');
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), rejects('EXPLAINER_PROVIDER_ERROR', 502, /drawn but could not be saved: Storage is not reachable/));
        assert.deepEqual([today()?.units, today()?.pictures], [440, 4]);
    });

    it('treats an error that is not the provider’s own as a failed draw with a plain message', async () => {
        provider.answers = [new TypeError('x is not a function')];
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), (err: unknown) => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_PROVIDER_ERROR');
            assert.match(err.message, /failed unexpectedly/);
            assert.equal(err.message.includes('x is not a function'), false);
            return true;
        });
        assert.equal(today()?.units, 0);
    });
});

describe('drawCandidates — the women guard, before anything', () => {
    const nothingHappened = (): void => {
        assert.equal(provider.requests.length, 0, 'the provider was not called');
        assert.equal(db.statements.length, 0, 'not one statement was sent: nothing read, nothing reserved');
        assert.equal(store.puts.length + store.gets.length, 0);
    };

    it('refuses a description that names a woman or a girl: 422 EXPLAINER_PROMPT_REFUSED, the allowance unchanged', async () => {
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: 'a young woman with long hair' }), (err: unknown) => {
            assert.ok(err instanceof ExplainerError);
            assert.equal(err.code, 'EXPLAINER_PROMPT_REFUSED');
            assert.equal(err.status, 422);
            assert.deepEqual(err.params, { field: 'description', word: 'woman' });
            assert.match(err.message, /«woman»/);
            return true;
        });
        nothingHappened();
        assert.equal(today(), undefined);
    });

    it('refuses the same in Arabic, and a girl, a mother, a daughter, and a woman named only by «she»', async () => {
        for (const description of ['رجل وبنت صغيرة', 'امرأة ترتدي وشاحا', 'a girl with a red balloon', 'his mother in a kitchen', 'the daughter of the owner', 'she wears a long coat']) {
            await assert.rejects(drawCandidates({ creatorId: TENANT, description }), rejects('EXPLAINER_PROMPT_REFUSED', 422), description);
        }
        nothingHappened();
    });

    it('refuses an empty description and one over 400 characters', async () => {
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: '   ' }), rejects('EXPLAINER_PROMPT_REFUSED', 422, /Describe the character/));
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: 'x'.repeat(401) }), rejects('EXPLAINER_PROMPT_REFUSED', 422, /400/));
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: undefined as unknown as string }), rejects('EXPLAINER_PROMPT_REFUSED', 422));
        nothingHappened();
    });

    it('refuses the description before it looks for a provider: a woman with no provider set up is still the 422', async () => {
        setImageProvider(null);
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: 'a woman reading' }), rejects('EXPLAINER_PROMPT_REFUSED', 422));
        nothingHappened();
    });

    it('does not refuse what only looks like a female word: a human, a manual', async () => {
        await drawCandidates({ creatorId: TENANT, description: 'a human in a hoodie holding a manual' });
        assert.equal(provider.requests.length, 4);
    });
});

describe('drawCandidates — no provider', () => {
    it('is 409 EXPLAINER_NO_PROVIDER when none is set up, with nothing reserved', async () => {
        setImageProvider(null);
        await assert.rejects(drawCandidates({ creatorId: TENANT, description: DESCRIPTION }), rejects('EXPLAINER_NO_PROVIDER', 409, /No image provider/));
        assert.equal(db.ran(/image_allowance/).length, 0);
        assert.equal(store.puts.length, 0);
    });
});
