/**
 * The statements of illustrated explainers that more than one file runs: lock a row, read its scenes, replace them, change a field that is not the status.
 * The status itself is `transitionExplainer` (state.ts) and nothing else writes it. Nothing here imports the Studio queue (jobs.ts), which imports the
 * appliers (apply.ts) that import this: a cycle would be a module read before it is built.
 *
 * Every query names the tenant (`creator_id`), as every Studio query does: an id from a URL or a job payload is never enough to reach a row.
 */
import type { ExplainerRow, ExplainerSceneRow } from '../../db/rows.js';
import type { Exec } from '../studio/common.js';

/** The scene columns as the app reads them: `NUMERIC` as a float, since `pg` hands back a string for it. */
export const SCENE_COLUMNS = `id, explainer_id, creator_id, position, narration, spoken, label, brief, characters, continues,
       start_s::float8 AS start_s, end_s::float8 AS end_s, picture, pictures, draw_status, draw_error, draw_note, draw_attempts, updated_at`;

/** The row of one explainer of this tenant, locked until the transaction ends, or null. */
export async function lockExplainer(exec: Exec, creatorId: string, id: string): Promise<ExplainerRow | null> {
    const { rows } = await exec.query<ExplainerRow>('SELECT * FROM explainers WHERE id = $1 AND creator_id = $2 FOR UPDATE', [id, creatorId]);
    return rows[0] ?? null;
}

/** The row of one explainer of this tenant, not locked, or null. */
export async function readExplainer(exec: Exec, creatorId: string, id: string): Promise<ExplainerRow | null> {
    const { rows } = await exec.query<ExplainerRow>('SELECT * FROM explainers WHERE id = $1 AND creator_id = $2', [id, creatorId]);
    return rows[0] ?? null;
}

/** The scenes of an explainer, in order. */
export async function loadScenes(exec: Exec, creatorId: string, explainerId: string, lock = false): Promise<ExplainerSceneRow[]> {
    const { rows } = await exec.query<ExplainerSceneRow>(
        `SELECT ${SCENE_COLUMNS} FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2 ORDER BY position${lock ? ' FOR UPDATE' : ''}`,
        [explainerId, creatorId]
    );
    return rows;
}

/** A scene as the writer or the owner gives it: what a row holds before it has been voiced or drawn. */
export interface SceneInput {
    narration: string;
    spoken: string;
    label: string;
    brief: string;
    characters: readonly string[];
    continues: boolean;
}

/**
 * Put these scenes in place of the explainer's, in order (position = index). One statement for all of them: a long script is 300 rows, and a statement
 * per row is 300 round trips inside a transaction that holds the explainer's lock. Every row starts `pending`, with no times and no picture: this is for a
 * script that has not been voiced, which is the only one whose scenes may be replaced whole (editExplainer refuses it after).
 */
export async function replaceScenes(exec: Exec, creatorId: string, explainerId: string, scenes: readonly SceneInput[]): Promise<void> {
    await exec.query('DELETE FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2', [explainerId, creatorId]);
    if (scenes.length === 0) return;
    const rows = scenes.map((scene, position) => ({
        position, narration: scene.narration, spoken: scene.spoken, label: scene.label, brief: scene.brief, characters: [...scene.characters], continues: scene.continues,
    }));
    await exec.query(
        `INSERT INTO explainer_scenes (explainer_id, creator_id, position, narration, spoken, label, brief, characters, continues)
         SELECT $1::uuid, $2::uuid, x.position, x.narration, x.spoken, x.label, x.brief,
                ARRAY(SELECT t.key FROM jsonb_array_elements_text(x.characters) WITH ORDINALITY AS t(key, n) ORDER BY t.n), x.continues
           FROM jsonb_to_recordset($3::jsonb)
                AS x(position INT, narration TEXT, spoken TEXT, label TEXT, brief TEXT, characters JSONB, continues BOOLEAN)`,
        [explainerId, creatorId, JSON.stringify(rows)]
    );
}

/**
 * Change the text of scenes in place, by position, and nothing else: their pictures, times and draw status stay as they are. For the owner's edit of a
 * script that has been voiced, where a scene is its position and a picture belongs to it.
 */
export async function updateSceneText(exec: Exec, creatorId: string, explainerId: string, scenes: readonly (SceneInput & { position: number })[]): Promise<void> {
    if (scenes.length === 0) return;
    const rows = scenes.map((scene) => ({
        position: scene.position, narration: scene.narration, spoken: scene.spoken, label: scene.label, brief: scene.brief, characters: [...scene.characters],
        continues: scene.continues,
    }));
    await exec.query(
        `UPDATE explainer_scenes s
            SET narration = x.narration, spoken = x.spoken, label = x.label, brief = x.brief,
                characters = ARRAY(SELECT t.key FROM jsonb_array_elements_text(x.characters) WITH ORDINALITY AS t(key, n) ORDER BY t.n),
                continues = x.continues, updated_at = NOW()
           FROM jsonb_to_recordset($3::jsonb)
                AS x(position INT, narration TEXT, spoken TEXT, label TEXT, brief TEXT, characters JSONB, continues BOOLEAN)
          WHERE s.explainer_id = $1 AND s.creator_id = $2 AND s.position = x.position`,
        [explainerId, creatorId, JSON.stringify(rows)]
    );
}

/** The columns `updateExplainerFields` may set, and how a value is cast. Not `status`: only `transitionExplainer` moves that. */
const FIELD_COLUMNS = {
    title: '', topic: '', notes: '', sound_mode: '', music_track_id: '', subtitles: '', error: '', rewrite_note: '', job_id: '', draft_version: '', draw_paused_until: '',
    source_links: '::jsonb', draft: '::jsonb', audio: '::jsonb', words: '::jsonb', render: '::jsonb', schedule: '::jsonb',
} as const;

export type ExplainerFields = { -readonly [K in keyof typeof FIELD_COLUMNS]?: unknown };

/**
 * Set columns of an explainer that is already locked, without moving its status: a value sets the column, `null` clears it, `undefined` leaves it alone,
 * and a key that is not in `FIELD_COLUMNS` throws before the database is touched (the column names in the statement come from the whitelist, never from
 * the caller). Returns the row as written.
 */
export async function updateExplainerFields(exec: Exec, creatorId: string, id: string, fields: ExplainerFields): Promise<ExplainerRow> {
    for (const key of Object.keys(fields)) {
        if (!Object.hasOwn(FIELD_COLUMNS, key)) throw new Error(`updateExplainerFields: "${key}" is not a column it may set.`);
    }
    const params: unknown[] = [id, creatorId];
    const sets: string[] = [];
    for (const [column, cast] of Object.entries(FIELD_COLUMNS) as [keyof typeof FIELD_COLUMNS, string][]) {
        const value = fields[column];
        if (value === undefined) continue;
        params.push(cast && value !== null ? JSON.stringify(value) : value);
        sets.push(`${column} = $${params.length}${cast}`);
    }
    sets.push('updated_at = NOW()');
    const { rows } = await exec.query<ExplainerRow>(`UPDATE explainers SET ${sets.join(', ')} WHERE id = $1 AND creator_id = $2 RETURNING *`, params);
    if (!rows[0]) throw new Error('explainers update returned no row.');
    return rows[0];
}
