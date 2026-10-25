/**
 * Tests only: a writer's answer, and the rows an explainer is made of, as the tests of this feature need them. Nothing here is read by the app.
 */
import type { ExplainerRow, ExplainerSceneRow, ExplainerWriterOutput } from '../../db/rows.js';

export const SOURCES: ExplainerWriterOutput['sources'] = [
    { title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks', by: 'Lewis et al.', year: '2020', url: 'https://arxiv.org/abs/2005.11401' },
    { title: 'Language Models are Few-Shot Learners', by: 'Brown et al.', year: '2020', url: 'https://arxiv.org/abs/2005.14165' },
    { title: 'Retrieval-augmented generation (RAG) documentation', by: 'LM Studio', year: '2026', url: 'https://lmstudio.ai/docs/app/basics/rag' },
];

/** Eleven words: a sentence in the range the prompt asks for. */
export const SENTENCE = 'The model reads the question and finds the passages it needs.';
export const CLOSING_QUESTION = 'Which of these have you seen fail in your own project?';

/** Scene `i` of a script: a picture of karim, one source, a label. The last scene of a script is the closing question (`writerScenes`). */
export function writerScene(i: number, over: Partial<ExplainerWriterOutput['scenes'][number]> = {}): ExplainerWriterOutput['scenes'][number] {
    return {
        narration: `${SENTENCE} (${i})`, spoken: `${SENTENCE} (${i})`, label: `idea ${i}`, brief: `karim reads a book at a desk with a stack of papers, wide shot ${i}`,
        characters: ['karim'], continues: false, source_ids: [0], ...over,
    };
}

/** `n` scenes: a hook, facts, and a closing question. */
export function writerScenes(n: number): ExplainerWriterOutput['scenes'] {
    return Array.from({ length: n }, (_, i) => (i === n - 1
        ? writerScene(i, { narration: CLOSING_QUESTION, spoken: CLOSING_QUESTION, label: '', source_ids: [] })
        : writerScene(i)));
}

/** A draft the writer could have answered with: it passes the schema and every check of `spec.ts`, for a short English explainer. */
export function validWriterOutput(n = 12, over: Partial<ExplainerWriterOutput> = {}): ExplainerWriterOutput {
    return {
        title: 'Why AI answers with confidence',
        scenes: writerScenes(n),
        captions: {
            meta: 'Why does AI sound sure when it is wrong? Retrieval helps. Which of these have you seen fail in your own project?\n\n#AI #RAG',
            youtube: { title: 'Why AI answers with confidence', description: 'How retrieval grounds an answer.\n\nSources: Lewis et al. 2020.\n\n#AI #RAG' },
            tiktok: 'Why does AI sound sure when it is wrong? Which of these have you seen fail? #AI #RAG',
        },
        first_comment: 'Sources\n1. Lewis et al., 2020: https://arxiv.org/abs/2005.11401',
        replies: Array.from({ length: 5 }, (_, i) => ({ q: `Objection ${i + 1}: it depends on the setup.`, a: `Agreed, and the video states the condition (${i + 1}).` })),
        sources: SOURCES.map((s) => ({ ...s })),
        ...over,
    };
}

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const EXPLAINER = '22222222-2222-4222-8222-222222222222';
export const JOB = '33333333-3333-4333-8333-333333333333';

export function explainerRow(over: Partial<ExplainerRow> = {}): ExplainerRow {
    return {
        id: EXPLAINER, creator_id: TENANT, status: 'draft', failed_step: null, error: null, topic: 'Why AI makes things up', language: 'en', length_tier: 'short',
        sound_mode: 'sfx', music_track_id: null, subtitles: true, notes: null, source_links: [], title: 'Why AI answers with confidence', draft: null, draft_version: 1,
        rewrite_note: null, audio: null, words: null, render: null, schedule: null, job_id: null, draw_paused_until: null,
        created_at: new Date('2026-10-25T09:00:00Z'), updated_at: new Date('2026-10-25T09:00:00Z'), ...over,
    };
}

export function sceneRow(position: number, over: Partial<ExplainerSceneRow> = {}): ExplainerSceneRow {
    return {
        id: `44444444-4444-4444-8444-${String(position).padStart(12, '0')}`, explainer_id: EXPLAINER, creator_id: TENANT, position,
        narration: `${SENTENCE} (${position})`, spoken: `${SENTENCE} (${position})`, label: `idea ${position}`, brief: `karim reads a book at a desk, wide shot ${position}`,
        characters: ['karim'], continues: false, start_s: null, end_s: null, picture: null, pictures: [], draw_status: 'pending', draw_error: null, draw_note: null,
        draw_attempts: 0, updated_at: new Date('2026-10-25T09:00:00Z'), ...over,
    };
}
