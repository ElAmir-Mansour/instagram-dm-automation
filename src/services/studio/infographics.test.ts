/**
 * Infographics (v31): what a spec must be, that the caption is about the GIF, what Claude is asked,
 * the worker's result, and the lifecycle — create, edit, render, copy, schedule, delete, and the
 * job's result and failure. The pool answers by SQL; nothing is published.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { THINK_MODEL } from '../monteur/think.js';
import { StudioError } from './common.js';
import {
    BUDGETS, captionProblems, DIAGRAM_KINDS, headline, parseInfographicResult, specProblems, WRITE_SCHEMA, writeSystemPrompt,
    writeUserPrompt, type InfographicSpec,
} from './infographicSpec.js';
import {
    copyInfographic, createInfographic, deleteInfographic, normaliseSpec, rerenderInfographic, scheduleInfographic, updateInfographic,
} from './infographics.js';
import { completeJob, failJob, STUDIO_JOB_KINDS } from './jobs.js';
import { ELAMIR_SETTINGS } from './testFixtures.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const up = (n: number) => `https://msg-response-auto.vercel.app/api/uploads/${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const NOW = Date.parse('2026-10-13T09:00:00Z'); // 12:00 in Riyadh

const column = (name: string): InfographicSpec['columns'][number] => ({
    name,
    hero: { kind: 'docs', badge: '10K+ docs' },
    kind: 'معرفة ضخمة ومتغيّرة',
    note: 'أكبر من السياق، وتتجدّد باستمرار',
    steps: [
        { mini: { kind: 'chunk-db' }, title: 'التقطيع والتضمين', desc: 'تُقسَّم المستندات إلى مقاطع' },
        { mini: { kind: 'icon', name: 'robot' }, title: 'استرجاع الأقرب', desc: 'يُطابَق السؤال مع أقرب المقاطع' },
        { mini: { kind: 'augment', label: 'LLM' }, title: 'الدمج والتوليد', desc: 'تُضاف أفضل المقاطع إلى الموجِّه' },
    ],
});
const SPEC: InfographicSpec = {
    dir: 'rtl',
    title: ['RAG', 'CAG', 'KAG'],
    subtitle: { text: 'كيف يصل الذكاء الاصطناعي إلى المعرفة الخارجية', accent: 'المعرفة الخارجية' },
    columns: [column('RAG'), column('CAG'), column('KAG')],
};
const CAPTION = 'ثلاث طرق ليصل النموذج إلى معرفتك.\n\nRAG يسترجع…\n\ncag يحمّل كل شيء مسبقًا…\n\nKAG يبني رسمًا للمعرفة…\n\nأيها تستخدم؟\n\n#RAG #AI';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const isStudioError = (status: number) => (err: unknown) => err instanceof StudioError && err.status === status;

// ─── The spec ───────────────────────────────────────────────────────────────────────────

describe('specProblems', () => {
    it('passes a spec the page can draw', () => {
        assert.deepEqual(specProblems(SPEC), []);
        assert.deepEqual(specProblems({ ...SPEC, title: ['RAG', 'CAG'], columns: SPEC.columns.slice(0, 2) }), []);
    });

    it('needs 2 or 3 columns, each with exactly three steps', () => {
        assert.match(specProblems({ ...SPEC, columns: [column('A')] }).join(), /2 or 3 columns/);
        assert.match(specProblems({ ...SPEC, columns: ['A', 'B', 'C', 'D'].map(column) }).join(), /2 or 3 columns/);
        const short = { ...column('CAG'), steps: column('CAG').steps.slice(0, 2) };
        assert.match(specProblems({ ...SPEC, columns: [column('RAG'), short, column('KAG')] }).join(), /Column 2 needs exactly 3 steps/);
    });

    it('knows the diagrams the template draws, and an icon needs a name from its set', () => {
        const odd = { ...column('RAG'), hero: { kind: 'pie-chart' } };
        assert.match(specProblems({ ...SPEC, columns: [odd, column('CAG'), column('KAG')] } as unknown as InfographicSpec).join(), /Column 1's main diagram must be one of the diagrams/);
        const icon = column('RAG');
        icon.steps[1]!.mini = { kind: 'icon', name: 'woman' };
        assert.match(specProblems({ ...SPEC, columns: [icon, column('CAG'), column('KAG')] }).join(), /step 2's diagram is an icon/);
    });

    it('holds each line to what fits, with a little slack', () => {
        const long = column('RAG');
        long.steps[0]!.desc = 'ك'.repeat(BUDGETS.stepDesc[3] + 6);
        assert.deepEqual(specProblems({ ...SPEC, columns: [long, column('CAG'), column('KAG')] }), [], 'just over still fits');
        long.steps[0]!.desc = 'ك'.repeat(BUDGETS.stepDesc[3] + 7);
        assert.match(specProblems({ ...SPEC, columns: [long, column('CAG'), column('KAG')] }).join(), /Column 1, step 1's description is 55 characters; it fits 48/);
    });

    it('keeps the highlighted words inside the subtitle, the title equal to the names, and the names distinct', () => {
        assert.match(specProblems({ ...SPEC, subtitle: { text: 'x', accent: 'y' } }).join(), /highlighted words must be part of the subtitle/);
        assert.match(specProblems({ ...SPEC, title: ['RAG', 'KAG', 'CAG'] }).join(), /title must be the columns' names/);
        assert.match(specProblems({ ...SPEC, title: ['RAG', 'rag', 'KAG'], columns: [column('RAG'), column('rag'), column('KAG')] }).join(), /same name/);
    });
});

describe('specProblems — logos', () => {
    const GO = { title: 'Go', hex: '#00ADD8', path: 'M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315z' };
    it('takes a logo the worker found, and refuses one whose path is anything but path data', () => {
        const withLogo = { ...SPEC, columns: [{ ...column('RAG'), logo: GO }, column('CAG'), column('KAG')] };
        assert.deepEqual(specProblems(withLogo), []);
        const evil = { ...SPEC, columns: [{ ...column('RAG'), logo: { ...GO, path: 'M0 0"/><script>alert(1)</script>' } }, column('CAG'), column('KAG')] };
        assert.match(specProblems(evil).join(), /Column 1's logo must be/);
        const badHex = { ...SPEC, columns: [{ ...column('RAG'), logo: { ...GO, hex: 'red' } }, column('CAG'), column('KAG')] };
        assert.match(specProblems(badHex).join(), /Column 1's logo must be/);
    });
});

describe('captionProblems — the caption is about the GIF', () => {
    it('passes a caption that names every column, whatever the case', () => {
        assert.deepEqual(captionProblems(CAPTION, SPEC), []);
    });

    it('names the columns it misses', () => {
        const problems = captionProblems('RAG وحده', SPEC);
        assert.match(problems.join(), /doesn't mention «CAG», «KAG»: it must talk about what the infographic shows/);
    });

    it('matches Arabic names without their diacritics, hamza or taa marbuta forms', () => {
        const spec = { ...SPEC, title: ['الوكيل', 'المحادثة'], columns: [column('الوكيل'), column('المحادثة')] };
        assert.deepEqual(captionProblems('الفرق بين الوكيلُ والمحادثه', spec), []);
    });

    it('refuses an empty caption and one past Instagram’s limit', () => {
        assert.match(captionProblems('  ', SPEC).join(), /empty/);
        assert.match(captionProblems(`${CAPTION}${'x'.repeat(BUDGETS.caption)}`, SPEC).join(), /Instagram takes 2200/);
    });

    it('makes the headline from the names and the subtitle', () => {
        assert.equal(headline(SPEC), 'RAG vs CAG vs KAG: كيف يصل الذكاء الاصطناعي إلى المعرفة الخارجية');
    });
});

describe('what Claude is asked', () => {
    it('in Arabic: فصحى, with the dialect words named, and English terms kept in Latin letters', () => {
        const system = writeSystemPrompt('ar');
        assert.match(system, /Modern Standard Arabic \(العربية الفصحى\)/);
        assert.match(system, /Never use dialect: not يوصل، لين، يسوّي/);
        assert.match(system, /in Latin letters \(RAG, API, KV Cache, LLM\)/);
    });

    it('writes the caption from the same content: every column named, in the page’s order', () => {
        const system = writeSystemPrompt('en');
        assert.match(system, /The caption is about THIS infographic/);
        assert.match(system, /Every column name must appear in the caption/);
        for (const kind of DIAGRAM_KINDS) assert.ok(system.includes(`- ${kind}: `), kind);
    });

    it('asks for one real example carried through every column, the specific feature, and a logo only for real products', () => {
        const system = writeSystemPrompt('en');
        assert.match(system, /Pick ONE real example and carry it through every column/);
        assert.match(system, /Name the specific feature that makes the difference/);
        assert.match(system, /give its brand name in `logo`/);
        assert.match(system, /Never for an idea or a technique/);
        const logo = (WRITE_SCHEMA.properties.columns.items.properties as Record<string, { type: string }>).logo;
        assert.equal(logo?.type, 'string');
        assert.ok(!(WRITE_SCHEMA.properties.columns.items.required as readonly string[]).includes('logo'), 'optional');
    });

    it('gives Claude the topic, the creator’s notes and the words to avoid', () => {
        const user = writeUserPrompt({ topic: 'RAG vs CAG', notes: 'Mention cost', language: 'ar', avoid: ['n8n'] });
        assert.match(user, /^Topic: RAG vs CAG/);
        assert.match(user, /Notes from the creator \(follow them\):\nMention cost/);
        assert.match(user, /Never use these words or topics: n8n\./);
        assert.match(user, /Language: Arabic \(Modern Standard Arabic, الفصحى\)\.$/);
    });

    it('holds the answer to the page’s shape: 2–3 columns of exactly three steps, and a caption', () => {
        const columns = WRITE_SCHEMA.properties.columns;
        assert.equal(columns.minItems, 2);
        assert.equal(columns.maxItems, 3);
        assert.equal(columns.items.properties.steps.minItems, 3);
        assert.equal(columns.items.properties.steps.maxItems, 3);
        assert.ok((WRITE_SCHEMA.required as readonly string[]).includes('caption'));
    });
});

describe('parseInfographicResult', () => {
    const RESULT = { mp4_url: up(1), gif_url: up(2), cover_url: up(3), gif_width: 720, gif_fps: 15 };

    it('takes our own upload URLs, and what was written', () => {
        const parsed = parseInfographicResult({ ...RESULT, written: { spec: SPEC, caption: CAPTION, model: 'claude-opus-5-5' } });
        assert.ok(parsed.ok);
        assert.equal(parsed.result.gif_url, up(2));
        assert.equal(parsed.result.written?.model, 'claude-opus-5-5');
    });

    it('refuses a URL that isn’t ours, and a written block without a spec', () => {
        const bad = parseInfographicResult({ ...RESULT, gif_url: 'https://evil.example/x.gif' });
        assert.ok(!bad.ok && bad.problems.join().includes('gif_url'));
        const written = parseInfographicResult({ ...RESULT, written: { caption: 'x' } });
        assert.ok(!written.ok && written.problems.join().includes('written'));
    });
});

describe('migration v31', () => {
    const sql = fs.readFileSync(new URL('../../config/migration_v31_infographics.sql', import.meta.url), 'utf8');

    it('re-creates the kind CHECK with exactly the kinds the queue knows', () => {
        const list = sql.match(/ADD CONSTRAINT studio_jobs_kind_check CHECK \(kind IN \(([^)]*)\)\)/);
        assert.ok(list);
        assert.deepEqual([...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(), [...STUDIO_JOB_KINDS].sort());
        assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS studio_jobs_kind_check') < sql.indexOf('ADD CONSTRAINT studio_jobs_kind_check'));
    });

    it('creates the table idempotently, with RLS and the settings column', () => {
        assert.match(sql, /CREATE TABLE IF NOT EXISTS infographics/);
        assert.match(sql, /status IN \('writing', 'rendering', 'ready', 'failed', 'scheduled'\)/);
        assert.match(sql, /ALTER TABLE infographics ENABLE ROW LEVEL SECURITY/);
        assert.match(sql, /ALTER TABLE studio_settings ADD COLUMN IF NOT EXISTS infographic JSONB/);
    });
});

// ─── The lifecycle ──────────────────────────────────────────────────────────────────────

const BRAND = {
    name: { ar: 'الأمير منصور', en: 'ElAmir Mansour' }, site: 'elamirmansour.dev', handle: '@elamir.mansour',
    socials: ['instagram', 'youtube'], primary: '#0E3B5C', accent: '#F2A33A', photo_url: up(9),
    theme: 'light', language: 'ar', platforms: ['instagram', 'facebook', 'youtube'],
};

let db: FakeDb;
let row: Record<string, unknown>;
let posts: { platform: string; scheduled_time: Date }[];
let infographicSettings: Record<string, unknown>;

beforeEach(() => {
    db = installFakeDb();
    infographicSettings = { ...BRAND };
    posts = [];
    row = {
        id: ID, creator_id: TENANT, topic: 'RAG vs CAG vs KAG', notes: null, language: 'ar', theme: 'dark', pair_theme: null, status: 'ready',
        spec: SPEC, caption: CAPTION, render: { job_id: JOB, mp4_url: up(1), gif_url: up(2), cover_url: up(3), gif_width: 720, gif_fps: 15, model: 'm' },
        schedule: null, job_id: JOB, error: null, created_at: new Date(), updated_at: new Date(),
    };
    db.routes.push(
        [/FROM studio_settings/, () => ({ rows: [{ ...ELAMIR_SETTINGS, infographic: infographicSettings }] })],
        [/^INSERT INTO infographics/, () => ({ rows: [{ id: ID }] })],
        [/^SELECT \* FROM infographics WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({ rows: [row] })],
        [/^SELECT i\.id, i\.topic/, () => ({ rows: [{ ...row, job_status: null, job_progress: null }] })],
        [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-new', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
        [/^SELECT p\.scheduled_time FROM scheduled_posts p/, () => ({ rows: posts.map((p) => ({ scheduled_time: p.scheduled_time })) })],
        [/^INSERT INTO scheduled_posts/, (p) => {
            posts.push({ platform: p[1], scheduled_time: p[4] });
            return { rows: [{ id: `row-${p[1]}`, platform: p[1] }] };
        }],
    );
});
afterEach(() => db.restore());

const jobPayload = () => JSON.parse(db.ran(/^INSERT INTO studio_jobs/)[0]!.params[2]);

describe('createInfographic', () => {
    it('queues one job that asks Claude (the latest Opus) to write it, then render it in the tenant’s brand', async () => {
        await createInfographic(TENANT, { topic: 'RAG vs CAG vs KAG', notes: 'Mention cost' });
        const insert = db.ran(/^INSERT INTO infographics/)[0]!;
        assert.deepEqual(insert.params, [TENANT, 'RAG vs CAG vs KAG', 'Mention cost', 'ar', 'light', null], 'the settings’ language and theme by default');
        const payload = jobPayload();
        assert.equal(db.ran(/^INSERT INTO studio_jobs/)[0]!.params[1], 'render_infographic');
        assert.equal(payload.infographicId, ID);
        assert.equal(payload.language, 'ar');
        assert.equal(payload.write.model, THINK_MODEL);
        assert.match(payload.write.system, /الفصحى/);
        assert.match(payload.write.user, /Mention cost/);
        assert.deepEqual(payload.brand, {
            name: BRAND.name, site: BRAND.site, handle: BRAND.handle, socials: BRAND.socials, primary: BRAND.primary, accent: BRAND.accent, photo: up(9),
        });
        assert.equal(payload.spec, undefined);
        const update = db.ran(/^UPDATE infographics SET status = \$3, theme = \$4, job_id = \$5/)[0]!;
        assert.deepEqual(update.params.slice(2), ['writing', 'light', 'job-new'], 'the job is the row’s latest');
    });

    it('takes a language and theme of its own, and refuses a topic that says nothing', async () => {
        await createInfographic(TENANT, { topic: 'Chatbot vs Agent', language: 'en', theme: 'dark' });
        assert.deepEqual(db.ran(/^INSERT INTO infographics/)[0]!.params.slice(3), ['en', 'dark', null]);
        await assert.rejects(createInfographic(TENANT, { topic: 'x' }), isStudioError(400));
        await assert.rejects(createInfographic(TENANT, { topic: 'RAG', theme: 'blue' }), isStudioError(400));
    });
});

describe('createInfographic — both themes', () => {
    it('writes once in the settings’ theme and keeps the other to copy into', async () => {
        await createInfographic(TENANT, { topic: 'RAG vs CAG', theme: 'both' });
        assert.deepEqual(db.ran(/^INSERT INTO infographics/)[0]!.params.slice(4), ['light', 'dark']);
        assert.ok(jobPayload().write, 'Claude is asked once');
    });
});

describe('updateInfographic, rerenderInfographic, copyInfographic', () => {
    it('an edited spec is made consistent with the row, then rendered again without Claude', async () => {
        const edited = { ...SPEC, dir: 'ltr', title: ['wrong'], columns: [column('RAG'), column('CAG')] };
        await updateInfographic(TENANT, ID, { spec: edited });
        const payload = jobPayload();
        assert.equal(payload.write, undefined);
        assert.equal(payload.spec.dir, 'rtl', 'from the row’s language');
        assert.deepEqual(payload.spec.title, ['RAG', 'CAG'], 'from the names');
        assert.equal(db.ran(/^UPDATE infographics SET status = \$3/)[0]!.params[2], 'rendering');
    });

    it('a caption alone is saved, and its problems worked out again: no render', async () => {
        await updateInfographic(TENANT, ID, { caption: 'RAG only' });
        assert.equal(db.ran(/^INSERT INTO studio_jobs/).length, 0);
        const save = db.ran(/^UPDATE infographics SET caption = \$3, error = \$4/)[0]!;
        assert.equal(save.params[2], 'RAG only');
        assert.match(save.params[3], /doesn't mention «CAG», «KAG»/);
    });

    it('refuses an edit while a job is open or once scheduled', async () => {
        for (const status of ['writing', 'rendering', 'scheduled']) {
            row.status = status;
            await assert.rejects(updateInfographic(TENANT, ID, { caption: CAPTION }), isStudioError(409), status);
        }
        await assert.rejects(updateInfographic(TENANT, 'nope', { caption: CAPTION }), isStudioError(404));
    });

    it('renders the same spec in another theme, or asks Claude again with rewrite', async () => {
        await rerenderInfographic(TENANT, ID, { theme: 'light' });
        assert.equal(jobPayload().theme, 'light');
        assert.deepEqual(jobPayload().spec, SPEC);
        db.statements.length = 0;
        await rerenderInfographic(TENANT, ID, { rewrite: true });
        assert.ok(jobPayload().write);
        assert.equal(db.ran(/^UPDATE infographics SET status = \$3/)[0]!.params[2], 'writing');
    });

    it('copies it into the other theme as a row of its own', async () => {
        await copyInfographic(TENANT, ID, {});
        const insert = db.ran(/^INSERT INTO infographics/)[0]!;
        assert.equal(insert.params[4], 'light', 'dark → light');
        assert.equal(insert.params[6], CAPTION, 'the caption goes with it');
        assert.deepEqual(jobPayload().spec, SPEC);
    });
});

describe('scheduleInfographic', () => {
    it('posts the MP4 with its caption and cover: Instagram + Facebook as one row, YouTube beside it', async () => {
        const outcome = await scheduleInfographic(TENANT, ID, { scheduled_time: '2026-10-14T16:00:00Z' }, NOW);
        const [meta, youtube] = db.ran(/^INSERT INTO scheduled_posts/);
        assert.deepEqual(meta!.params.slice(0, 4), [TENANT, 'both', CAPTION, up(1)]);
        assert.equal(meta!.params[5], up(3), 'the cover');
        assert.deepEqual(youtube!.params.slice(0, 4), [TENANT, 'youtube', CAPTION, up(1)]);
        assert.equal(youtube!.params[6], meta!.params[6], 'one group');
        assert.deepEqual(JSON.parse(youtube!.params[7]), { title: headline(SPEC), language: 'ar' });
        assert.equal(outcome.scheduled_time, '2026-10-14T16:00:00.000Z');
        assert.ok(db.ran(/pg_advisory_xact_lock/).length, 'under the tenant’s publishing lock');
        const saved = JSON.parse(db.ran(/^UPDATE infographics SET status = 'scheduled'/)[0]!.params[2]);
        assert.deepEqual(saved.row_ids, ['row-both', 'row-youtube']);
    });

    it('takes the next free posting slot (the reels’ times) when no time is given, or now', async () => {
        await scheduleInfographic(TENANT, ID, {}, NOW);
        assert.equal((posts[0]!.scheduled_time as Date).toISOString(), '2026-10-13T16:00:00.000Z', '19:00 in Riyadh, the fixture’s post_at');
        posts = [];
        await scheduleInfographic(TENANT, ID, { now: true }, NOW);
        assert.equal((posts[0]!.scheduled_time as Date).getTime(), NOW);
    });

    it('refuses a caption that isn’t about the GIF, before writing anything', async () => {
        row.caption = 'RAG وحده';
        await assert.rejects(scheduleInfographic(TENANT, ID, {}, NOW), (err: unknown) => isStudioError(409)(err) && /«CAG»/.test(String((err as Error).message) + JSON.stringify((err as { problems?: unknown }).problems ?? '')));
        assert.equal(db.ran(/^INSERT INTO scheduled_posts/).length, 0);
    });

    it('only a ready one, and only where the brand settings post', async () => {
        row.status = 'rendering';
        await assert.rejects(scheduleInfographic(TENANT, ID, {}, NOW), isStudioError(409));
        row.status = 'ready';
        infographicSettings = { ...BRAND, platforms: ['instagram'] };
        await scheduleInfographic(TENANT, ID, {}, NOW);
        assert.deepEqual(posts.map((p) => p.platform), ['instagram']);
    });
});

describe('deleteInfographic', () => {
    it('deletes the row and fails its job if the worker hasn’t taken it yet', async () => {
        db.routes.unshift([/^DELETE FROM infographics/, () => ({ rows: [{ job_id: JOB }] })]);
        await deleteInfographic(TENANT, ID);
        const fail = db.ran(/^UPDATE studio_jobs SET status = 'failed', error = 'The infographic was deleted\.'/)[0]!;
        assert.deepEqual(fail.params, [JOB, TENANT]);
        assert.match(fail.sql, /status = 'pending'/, 'a running render finishes; its result is dropped');
    });

    it('is a 404 for one that isn’t there', async () => {
        await assert.rejects(deleteInfographic(TENANT, ID), isStudioError(404));
    });
});

describe('the job: completeJob and failJob', () => {
    const RESULT = { mp4_url: up(4), gif_url: up(5), cover_url: up(6), gif_width: 720, gif_fps: 15 };
    beforeEach(() => {
        db.routes.unshift([/^SELECT id, creator_id, kind, status, payload FROM studio_jobs/, () => ({
            rows: [{ id: JOB, creator_id: TENANT, kind: 'render_infographic', status: 'claimed', payload: { infographicId: ID } }],
        })]);
        db.routes.unshift([/^SELECT job_id, spec, caption, topic, notes, language, pair_theme FROM infographics/, () => ({ rows: [row] })]);
    });
    const applied = () => db.ran(/^UPDATE infographics SET status = 'ready'/)[0]!;

    it('stores what Claude wrote and the worker rendered, with its files', async () => {
        assert.equal(await completeJob(TENANT, JOB, { ...RESULT, written: { spec: SPEC, caption: CAPTION, model: 'claude-opus-5-5' } }), 'applied');
        const u = applied();
        assert.deepEqual(JSON.parse(u.params[2]), SPEC);
        assert.equal(u.params[3], CAPTION);
        assert.equal(JSON.parse(u.params[4]).gif_url, up(5));
        assert.equal(JSON.parse(u.params[4]).model, 'claude-opus-5-5');
        assert.equal(u.params[5], null, 'nothing to fix');
    });

    it('keeps what to fix on a ready one: here, a caption that misses a column', async () => {
        await completeJob(TENANT, JOB, { ...RESULT, written: { spec: SPEC, caption: 'RAG and CAG', model: 'm' } });
        assert.match(applied().params[5], /doesn't mention «KAG»/);
    });

    it('both themes: once Claude’s answer lands, the copy in the other theme is queued with the same brand, and Claude isn’t asked again', async () => {
        row.pair_theme = 'light';
        db.routes.unshift([/^SELECT id, creator_id, kind, status, payload FROM studio_jobs/, () => ({
            rows: [{ id: JOB, creator_id: TENANT, kind: 'render_infographic', status: 'claimed', payload: {
                infographicId: ID, theme: 'dark', language: 'ar', brand: { site: 'elamirmansour.dev' }, write: { system: 's' },
            } }],
        })]);
        db.routes.unshift([/^INSERT INTO infographics/, () => ({ rows: [{ id: 'copy-1' }] })]);
        await completeJob(TENANT, JOB, { ...RESULT, written: { spec: SPEC, caption: CAPTION, model: 'm' } });
        const copy = db.ran(/^INSERT INTO infographics/)[0]!;
        assert.deepEqual(copy.params.slice(3, 5), ['ar', 'light']);
        assert.deepEqual(JSON.parse(copy.params[5]), SPEC);
        assert.equal(copy.params[6], CAPTION);
        const payload = jobPayload();
        assert.equal(payload.infographicId, 'copy-1');
        assert.equal(payload.theme, 'light');
        assert.deepEqual(payload.spec, SPEC);
        assert.equal(payload.write, undefined);
        assert.deepEqual(payload.brand, { site: 'elamirmansour.dev' });
        assert.ok(db.ran(/^UPDATE infographics SET pair_theme = NULL WHERE id = \$1/).length, 'asked once, done once');
    });

    it('a render without a pair makes no copy', async () => {
        await completeJob(TENANT, JOB, { ...RESULT, written: { spec: SPEC, caption: CAPTION, model: 'm' } });
        assert.equal(db.ran(/^INSERT INTO infographics/).length, 0);
    });

    it('drops the result of a render that is no longer the latest', async () => {
        row.job_id = 'another-job';
        assert.equal(await completeJob(TENANT, JOB, RESULT), 'dropped');
        assert.equal(db.ran(/^UPDATE infographics/).length, 0);
    });

    it('a failure marks it failed only while this job is its latest and still open', async () => {
        await failJob(TENANT, JOB, 'Claude didn’t answer');
        const fail = db.ran(/^UPDATE infographics SET status = 'failed'/)[0]!;
        assert.deepEqual(fail.params, [ID, TENANT, 'Claude didn’t answer', JOB]);
        assert.match(fail.sql, /job_id = \$4 AND status IN \('writing', 'rendering'\)/);
    });
});

describe('normaliseSpec', () => {
    it('refuses what the page can’t draw with a 400', () => {
        assert.throws(() => normaliseSpec({ columns: [column('A')] }, 'ar'), isStudioError(400));
        assert.throws(() => normaliseSpec('x', 'ar'), isStudioError(400));
    });
});
