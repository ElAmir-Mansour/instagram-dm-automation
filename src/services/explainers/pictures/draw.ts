/**
 * Drawing a scene (illustrated explainers; tasks.md T047, data-model.md §2 and §7, contracts/http-api.md): the app server draws one picture per
 * scene through the image provider and keeps it in the media store.
 *
 *   drawNext     the loop's one step (the Mac's `explainer_draw` job calls it until it says `done`, `paused` or `failed`): the pending scene with the
 *                lowest position. A scene that continues the one before it is not drawn but given that scene's picture.
 *   drawScene    the owner draws or redraws one scene now, with an optional note.
 *   pickPicture  the owner goes back to one of a scene's earlier pictures.
 *
 * NOTHING IS HELD ACROSS A CALL OUT. A draw is three steps and only the first and the last touch the database:
 *
 *   1. ONE SHORT TRANSACTION marks the scene `drawing`, builds its prompt from the row as it was claimed, and reserves the allowance (allowance.ts).
 *      A refusal of either (a woman in the brief, the cap reached) rolls the claim back with it.
 *   2. THE PROVIDER CALL, then the file into the media store, outside any transaction, holding no pooled client and no row lock.
 *   3. ONE SHORT TRANSACTION writes the result: the picture, the history, the scenes that continue this one, and the deletion of the files that
 *      dropped out.
 *
 * A crash between the steps leaves the scene `drawing`; a scene that has been `drawing` for over two minutes is pending again (`STALE_DRAWING_SECONDS`),
 * so the next call claims it. The claim is an UPDATE that re-checks the state it expects (the queue's own rule, FLOWS.md §5.2), so two callers
 * cannot both draw one scene: the one that loses gets no row and goes round again.
 *
 * WHAT A SCENE KEEPS. `picture` is the chosen picture and `pictures` the last three before it, newest first (data-model §2: "the chosen picture plus the
 * last 3"). A new picture becomes the chosen one and the old chosen one goes to the front of the history; what falls off the end is deleted from the
 * media store, unless another scene of the explainer still names it. Picking an earlier one swaps it with the chosen one and deletes nothing.
 *
 * SCENES THAT CONTINUE. `continues` means "keep the previous scene's picture". Such a scene is never drawn (position 0 has nothing before it, so it
 * is drawn like any other): it takes the chosen picture of the scene before, and whenever that scene's chosen picture changes (a draw, a redraw, a
 * pick) the run of scenes after it that continue gets the new one in the same transaction. A scene that cannot continue because the one before has
 * no picture is marked failed with that reason, and is healed when the scene before is drawn.
 *
 * REFERENCES. The characters a scene names (up to four) go to the provider as `input_image_0..3`, in the order the scene names them. FLUX.2 klein takes
 * a reference only when it is smaller than 512×512 on both sides, and there is no image library here, so the size is read from the file's header
 * (imageSize.ts) and a reference that is too big is refused with its size and what to do. The files are read BEFORE the claim (a Storage download is
 * not something to do inside a transaction) and kept for the next scene in a small cache: an upload's bytes never change under its id.
 *
 * The words are guarded before anything is spent: a brief, a note or a character description that names a woman or a girl is refused with 422
 * `EXPLAINER_PROMPT_REFUSED` (prompt.ts) before a file is read, a unit reserved or the provider called.
 *
 * What this does not do: change `explainers.status`, or check the explainer's job. The caller (the worker route, the dashboard routes) owns the
 * status machine; here an explainer must exist, for this tenant, and that is all.
 */
import { pool } from '../../../config/db.js';
import { queryOne } from '../../../db/query.js';
import type { ExplainerPicture, ExplainerSceneRow } from '../../../db/rows.js';
import { describeError, log } from '../../../utils/log.js';
import { getMediaStore, type MediaStore } from '../../storage.js';
import { type Exec, UUID_PATTERN, withTransaction } from '../../studio/common.js';
import type { ExplainerCharacter } from '../../studio/settingsTypes.js';
import { ExplainerError } from '../errors.js';
import { allowanceStatus, markExhausted, pausedError, refundAllowance, reserveAllowance, type AllowanceStatus, type Reservation } from './allowance.js';
import { readPictureInfo, type PictureMime } from './imageSize.js';
import { readLook, type Look } from './look.js';
import { buildScenePrompt, pictureSeed, promptHash, refuseNote, SCENE_SIZE, type PromptCharacter } from './prompt.js';
import { getImageProvider } from './provider.js';
import { asProviderError, type DrawnPicture, type ImageProvider } from './types.js';

/** A scene `drawing` for longer than this is one whose call died: it is pending again. */
export const STALE_DRAWING_SECONDS = 120;
/** The earlier pictures a scene keeps besides the chosen one. */
export const KEPT_HISTORY = 3;
/** The most characters (reference pictures) one picture is drawn with: `input_image_0..3`. */
export const MAX_REFERENCES = 4;
/** FLUX.2 klein takes a reference only when both sides are smaller than this. */
export const REFERENCE_LIMIT_PX = 512;
/** How many times `drawNext` goes round after losing a claim before it says another draw is working here. */
const MAX_CLAIM_TRIES = 5;
const REFERENCE_CACHE_SIZE = 8;
/** The longest piece of a storage or network error that goes into a sentence the owner reads. */
const MAX_DETAIL = 200;

export type DrawNextAnswer =
    | { state: 'drawn'; position: number; remaining: number }
    | { state: 'done' }
    | { state: 'paused'; until: string }
    | { state: 'failed'; position: number; error: string };

// ─── SQL ─────────────────────────────────────────────────────────────────────────────────────────

/** `start_s` and `end_s` are NUMERIC: cast, or `pg` hands them back as strings. */
const COLUMNS = 'id, explainer_id, creator_id, position, narration, spoken, label, brief, characters, continues, '
    + 'start_s::float8 AS start_s, end_s::float8 AS end_s, picture, pictures, draw_status, draw_error, draw_note, draw_attempts, updated_at';
const STALE = `updated_at < NOW() - INTERVAL '${STALE_DRAWING_SECONDS} seconds'`;
const PENDING = `(draw_status = 'pending' OR (draw_status = 'drawing' AND ${STALE}))`;

const EXPLAINER_EXISTS_SQL = 'SELECT 1 FROM explainers WHERE id = $1 AND creator_id = $2';
const PEEK_NEXT_SQL = `SELECT ${COLUMNS} FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2 AND ${PENDING} ORDER BY position LIMIT 1`;
const SCENE_AT_SQL = `SELECT ${COLUMNS} FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2 AND position = $3`;
const COUNT_PENDING_SQL = `SELECT count(*)::int AS n FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2 AND ${PENDING}`;

/** The loop's claim: only a pending scene (or one stuck drawing). The WHERE is re-read after a lock wait, which is what makes it atomic. */
const CLAIM_UNATTENDED_SQL = `UPDATE explainer_scenes SET draw_status = 'drawing', draw_error = NULL, updated_at = NOW()
    WHERE explainer_id = $1 AND creator_id = $2 AND position = $3 AND ${PENDING}
    RETURNING ${COLUMNS}`;
/** The owner's claim: any scene but one being drawn right now, and the note he gave (null clears the last one). */
const CLAIM_EXPLICIT_SQL = `UPDATE explainer_scenes SET draw_status = 'drawing', draw_error = NULL, draw_note = $4, updated_at = NOW()
    WHERE explainer_id = $1 AND creator_id = $2 AND position = $3 AND (draw_status <> 'drawing' OR ${STALE})
    RETURNING ${COLUMNS}`;

const LOCK_FOR_RESULT_SQL = 'SELECT id, position, picture, pictures FROM explainer_scenes WHERE id = $1 AND explainer_id = $2 AND creator_id = $3 FOR UPDATE';
/** A picture was drawn: it becomes the chosen one, and the scene has had one more. */
const STORE_PICTURE_SQL = `UPDATE explainer_scenes SET picture = $4::jsonb, pictures = $5::jsonb, draw_status = 'done', draw_error = NULL, draw_attempts = draw_attempts + 1, updated_at = NOW()
    WHERE id = $1 AND explainer_id = $2 AND creator_id = $3
    RETURNING ${COLUMNS}`;
/** A scene that continues takes the picture of the one before: no history of its own, and nothing was drawn. */
const COPY_PICTURE_SQL = `UPDATE explainer_scenes SET picture = $4::jsonb, pictures = '[]'::jsonb, draw_status = 'done', draw_error = NULL, updated_at = NOW()
    WHERE id = $1 AND explainer_id = $2 AND creator_id = $3
    RETURNING ${COLUMNS}`;

const PICK_LOCK_SQL = `SELECT ${COLUMNS}, (draw_status = 'drawing' AND NOT (${STALE})) AS busy
    FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2 AND position = $3 FOR UPDATE`;
const PICK_SQL = `UPDATE explainer_scenes SET picture = $4::jsonb, pictures = $5::jsonb, draw_status = 'done', draw_error = NULL, updated_at = NOW()
    WHERE id = $1 AND explainer_id = $2 AND creator_id = $3
    RETURNING ${COLUMNS}`;

const FOLLOWING_SQL = 'SELECT id, position, continues FROM explainer_scenes WHERE explainer_id = $1 AND creator_id = $2 AND position > $3 ORDER BY position';
const RUN_PICTURES_SQL = 'SELECT picture, pictures FROM explainer_scenes WHERE id = ANY($1::uuid[]) AND explainer_id = $2 AND creator_id = $3 FOR UPDATE';
const SET_RUN_SQL = `UPDATE explainer_scenes SET picture = $4::jsonb, pictures = '[]'::jsonb, draw_status = 'done', draw_error = NULL, updated_at = NOW()
    WHERE id = ANY($1::uuid[]) AND explainer_id = $2 AND creator_id = $3`;

/** A scene that fails keeps a picture it already had: a redraw that failed is an error on the scene, not a scene without a picture. */
const FAIL_SCENE_SQL = `UPDATE explainer_scenes SET draw_status = CASE WHEN picture IS NOT NULL THEN 'done' ELSE 'failed' END, draw_error = $4, updated_at = NOW()
    WHERE id = $1 AND explainer_id = $2 AND creator_id = $3 AND draw_status IN ('pending', 'drawing')`;
/** The allowance ran out: the scene goes back to what it was, so it is drawn after the pause. */
const RELEASE_SCENE_SQL = `UPDATE explainer_scenes SET draw_status = CASE WHEN picture IS NOT NULL THEN 'done' ELSE 'pending' END, draw_error = NULL, updated_at = NOW()
    WHERE id = $1 AND explainer_id = $2 AND creator_id = $3 AND draw_status = 'drawing'`;

/**
 * The files that dropped out: deleted from the media store (a trigger queues the Storage object, which the daily sweep removes), unless a scene of
 * this explainer still names them, as its chosen picture or in its history. A scene that continues another names the same file as the scene it follows.
 */
const DELETE_UNREFERENCED_SQL = `DELETE FROM media_uploads m
    WHERE m.id = ANY($1::uuid[]) AND m.creator_id = $2
      AND NOT EXISTS (SELECT 1 FROM explainer_scenes s WHERE s.explainer_id = $3
          AND (s.picture::text LIKE '%' || m.id::text || '%' OR s.pictures::text LIKE '%' || m.id::text || '%'))`;
const DELETE_FILE_SQL = 'DELETE FROM media_uploads WHERE id = $1 AND creator_id = $2';

// ─── Words ───────────────────────────────────────────────────────────────────────────────────────

/** A scene's number as the owner reads it: the first is 1. */
const nth = (position: number): number => position + 1;
const clip = (text: string): string => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text);
const messageOf = (err: unknown): string => clip(err instanceof Error ? err.message : String(err));

const noScene = (): ExplainerError => new ExplainerError('EXPLAINER_NOT_FOUND', 'No such scene.');
const noProvider = (): ExplainerError => new ExplainerError(
    'EXPLAINER_NO_PROVIDER', 'No image provider is set up. A platform admin adds the Cloudflare account and token in Settings → Platform → Explainers.'
);
const beingDrawn = (position: number): ExplainerError => new ExplainerError(
    'EXPLAINER_BAD_STATE', `Scene ${nth(position)} is being drawn right now. Wait a moment, then try again.`, { position }
);
const continuesError = (position: number, instead: string): ExplainerError => new ExplainerError(
    'EXPLAINER_BAD_STATE', `Scene ${nth(position)} continues the picture of scene ${position}${instead}`, { position }
);

// ─── The explainer and its scenes ────────────────────────────────────────────────────────────────

async function assertExplainer(creatorId: string, explainerId: string): Promise<void> {
    if (!UUID_PATTERN.test(explainerId) || !UUID_PATTERN.test(creatorId)) throw new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');
    if (!(await queryOne(EXPLAINER_EXISTS_SQL, [explainerId, creatorId]))) throw new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');
}

const sceneAt = (creatorId: string, explainerId: string, position: number): Promise<ExplainerSceneRow | null> =>
    queryOne<ExplainerSceneRow>(SCENE_AT_SQL, [explainerId, creatorId, position]);

const isContinuing = (scene: Pick<ExplainerSceneRow, 'continues' | 'position'>): boolean => scene.continues && scene.position > 0;

const uniqueKeys = (keys: readonly string[]): string[] => [...new Set(keys)];

// ─── References ──────────────────────────────────────────────────────────────────────────────────

interface Reference {
    key: string;
    description: string;
    mediaId: string;
    data: Buffer;
    mime: PictureMime;
}

interface CachedFile { data: Buffer; mime: PictureMime; width: number; height: number }

/**
 * References already read and checked, by upload id. An upload's bytes never change under its id, so this can only save a download: a scene
 * after another that names the same character reads nothing. Small and first-in-first-out; a cold instance starts empty.
 */
const referenceCache = new Map<string, CachedFile>();

/** Tests only. */
export function clearReferenceCache(): void {
    referenceCache.clear();
}

function needsReference(message: string, params: Record<string, unknown>): ExplainerError {
    return new ExplainerError('EXPLAINER_NEEDS_REFERENCE', message, params);
}

/** One character's reference picture, read from the media store and checked: it must be there, be a PNG or a JPEG, and be under 512×512. */
async function loadReference(store: MediaStore, character: ExplainerCharacter): Promise<Reference> {
    const key = character.key;
    const mediaId = character.ref_media_id;
    if (!mediaId) {
        throw needsReference(`The character «${key}» has no approved reference picture yet. Generate candidates and approve one in Settings → Explainers.`, { character: key });
    }
    const here = (file: CachedFile): Reference => ({ key, description: character.description, mediaId, data: file.data, mime: file.mime });
    const cached = referenceCache.get(mediaId);
    if (cached) return here(cached);

    let stored: Awaited<ReturnType<MediaStore['get']>>;
    try {
        stored = UUID_PATTERN.test(mediaId) ? await store.get(mediaId) : null;
    } catch (err) {
        throw new ExplainerError('EXPLAINER_PROVIDER_ERROR', `The reference picture of «${key}» could not be read from storage: ${messageOf(err)}`);
    }
    if (!stored) throw needsReference(`The reference picture of «${key}» is missing from storage. Approve a picture again in Settings → Explainers.`, { character: key });

    const info = readPictureInfo(stored.data);
    if (!info) throw needsReference(`The reference picture of «${key}» is not a PNG or a JPEG. Upload a PNG or a JPEG, or generate candidates again.`, { character: key });
    if (info.width >= REFERENCE_LIMIT_PX || info.height >= REFERENCE_LIMIT_PX) {
        throw needsReference(
            `The reference picture of «${key}» is ${info.width}×${info.height} pixels; it must be smaller than ${REFERENCE_LIMIT_PX}×${REFERENCE_LIMIT_PX}. `
            + 'Upload a smaller picture, or generate candidates again: they are drawn at 448×448.',
            { character: key, width: info.width, height: info.height }
        );
    }

    const file: CachedFile = { data: stored.data, mime: info.mime, width: info.width, height: info.height };
    if (referenceCache.size >= REFERENCE_CACHE_SIZE) referenceCache.delete(referenceCache.keys().next().value as string);
    referenceCache.set(mediaId, file);
    return here(file);
}

/** The reference of every character a scene names, in the order the scene names them. Throws 409 `EXPLAINER_NEEDS_REFERENCE` for the first that has none. */
async function loadReferences(store: MediaStore, look: Look, keys: readonly string[], position: number): Promise<Map<string, Reference>> {
    const refs = new Map<string, Reference>();
    for (const key of keys) {
        const character = look.characters.find((candidate) => candidate.key === key);
        if (!character) {
            throw needsReference(`Scene ${nth(position)} names the character «${key}», who is not in the Explainers settings.`, { character: key });
        }
        refs.set(key, await loadReference(store, character));
    }
    return refs;
}

/** The characters a prompt names, from the settings: for the check that runs before any file is read. A key the settings do not have is the reference loader's to report. */
const describedCharacters = (look: Look, keys: readonly string[]): PromptCharacter[] =>
    keys.flatMap((key) => {
        const character = look.characters.find((candidate) => candidate.key === key);
        return character ? [{ key, description: character.description }] : [];
    });

// ─── Keeping and deleting pictures ───────────────────────────────────────────────────────────────

/** The media ids of every picture a row names: the chosen one and the history. */
const mediaIdsOf = (row: { picture: ExplainerPicture | null; pictures: ExplainerPicture[] | null }): string[] =>
    [row.picture, ...(row.pictures ?? [])].flatMap((picture) => (picture ? [picture.media_id] : []));

async function deleteUnreferenced(exec: Exec, creatorId: string, explainerId: string, mediaIds: readonly string[]): Promise<void> {
    const ids = [...new Set(mediaIds.filter((id) => UUID_PATTERN.test(id)))];
    if (ids.length === 0) return;
    await exec.query(DELETE_UNREFERENCED_SQL, [ids, creatorId, explainerId]);
}

/**
 * The scenes after `fromPosition` that continue it, in a run (a scene that does not continue, or a gap in the positions, ends it), take `chosen` as
 * their picture, whatever state they were in: that is also what heals one that failed for want of a picture. Their own earlier files are returned, for
 * `deleteUnreferenced` to decide on once the rows say what is named.
 */
async function propagate(exec: Exec, creatorId: string, explainerId: string, fromPosition: number, chosen: ExplainerPicture): Promise<string[]> {
    const { rows: after } = await exec.query<{ id: string; position: number; continues: boolean }>(FOLLOWING_SQL, [explainerId, creatorId, fromPosition]);
    const run: string[] = [];
    let expected = fromPosition + 1;
    for (const next of after) {
        if (next.position !== expected || !next.continues) break;
        run.push(next.id);
        expected++;
    }
    if (run.length === 0) return [];

    const { rows: before } = await exec.query<{ picture: ExplainerPicture | null; pictures: ExplainerPicture[] }>(RUN_PICTURES_SQL, [run, explainerId, creatorId]);
    await exec.query(SET_RUN_SQL, [run, explainerId, creatorId, JSON.stringify(chosen)]);
    return before.flatMap(mediaIdsOf);
}

/**
 * Write a drawn picture as the scene's chosen one, in the second short transaction: the scene is read again under its lock, so the history is
 * made from what it holds NOW and not from what it held at the claim. Null when the scene is gone.
 */
async function storePicture(exec: Exec, creatorId: string, explainerId: string, sceneId: string, chosen: ExplainerPicture): Promise<ExplainerSceneRow | null> {
    const { rows: locked } = await exec.query<{ id: string; position: number; picture: ExplainerPicture | null; pictures: ExplainerPicture[] }>(
        LOCK_FOR_RESULT_SQL, [sceneId, explainerId, creatorId]
    );
    const current = locked[0];
    if (!current) return null;

    const history = [...(current.picture ? [current.picture] : []), ...current.pictures];
    const kept = history.slice(0, KEPT_HISTORY);
    const dropped = history.slice(KEPT_HISTORY);
    const { rows } = await exec.query<ExplainerSceneRow>(STORE_PICTURE_SQL, [sceneId, explainerId, creatorId, JSON.stringify(chosen), JSON.stringify(kept)]);
    const scene = rows[0];
    if (!scene) return null;

    const orphans = [...dropped.map((picture) => picture.media_id), ...(await propagate(exec, creatorId, explainerId, scene.position, chosen))];
    await deleteUnreferenced(exec, creatorId, explainerId, orphans);
    return scene;
}

// ─── One draw ────────────────────────────────────────────────────────────────────────────────────

/** What one attempt came to. */
type Outcome =
    | { kind: 'drawn'; scene: ExplainerSceneRow }
    /** The scene was claimed by another caller, or changed under us: nothing was done, nothing is held. */
    | { kind: 'lost' }
    | { kind: 'paused'; until: Date; error: ExplainerError }
    /** The words or the references were refused before anything was spent: the scene is as it was. */
    | { kind: 'refused'; error: ExplainerError }
    /** The draw ran and failed, and the scene has been marked. */
    | { kind: 'failed'; error: ExplainerError };

/** Thrown inside a transaction to roll it back and go round again. */
const LOST = Symbol('lost');

interface DrawArgs {
    creatorId: string;
    explainerId: string;
    /** The scene as it was read a moment ago. The prompt is built from the row the claim returns, not from this. */
    candidate: ExplainerSceneRow;
    /** The owner's draw: any scene but one being drawn now, and the note replaces the last one. The loop's: a pending scene, and the stored note. */
    explicit: boolean;
    note: string | null;
    provider: ImageProvider;
    look: Look;
    store: MediaStore;
}

const fileName = (explainerId: string, position: number, mime: PictureMime): string =>
    `explainer-${explainerId.slice(0, 8)}-scene-${nth(position)}.${mime === 'image/png' ? 'png' : 'jpg'}`;

async function drawWithProvider(args: DrawArgs): Promise<Outcome> {
    const { creatorId, explainerId, candidate, explicit, provider, look, store } = args;

    // 1. Everything that can be refused without a unit or a call: the words, then the references. Nothing is claimed yet.
    let refs: Map<string, Reference>;
    try {
        const keys = uniqueKeys(candidate.characters);
        if (keys.length > MAX_REFERENCES) {
            throw new ExplainerError(
                'EXPLAINER_PROMPT_REFUSED', `Scene ${nth(candidate.position)} names ${keys.length} characters; at most ${MAX_REFERENCES} can be drawn together.`, { field: 'characters' }
            );
        }
        buildScenePrompt({ style: look.style, characters: describedCharacters(look, keys), brief: candidate.brief, note: args.note });
        refs = await loadReferences(store, look, keys, candidate.position);
    } catch (err) {
        if (err instanceof ExplainerError) return { kind: 'refused', error: err };
        throw err;
    }

    // 2. One short transaction: claim the scene, build the prompt from the row as the claim found it, reserve the allowance. A refusal rolls the claim back.
    let claim: { row: ExplainerSceneRow; keys: string[]; prompt: string; reservation: Reservation };
    try {
        claim = await withTransaction(async (tx) => {
            const { rows } = await tx.query<ExplainerSceneRow>(explicit ? CLAIM_EXPLICIT_SQL : CLAIM_UNATTENDED_SQL,
                explicit ? [explainerId, creatorId, candidate.position, args.note] : [explainerId, creatorId, candidate.position]);
            const row = rows[0];
            if (!row) throw LOST;
            if (!explicit && isContinuing(row)) throw LOST; // edited to continue the one before since it was read: that is not a draw
            const keys = uniqueKeys(row.characters);
            if (keys.some((key) => !refs.has(key))) throw LOST; // edited to name a character whose reference was not read: go round and read it
            const prompt = buildScenePrompt({
                style: look.style, characters: keys.map((key) => ({ key, description: refs.get(key)!.description })), brief: row.brief, note: row.draw_note,
            });
            const reservation = await reserveAllowance(provider, 1, tx);
            return { row, keys, prompt, reservation };
        });
    } catch (err) {
        if (err === LOST) return { kind: 'lost' };
        if (err instanceof ExplainerError) {
            if (err.code === 'EXPLAINER_ALLOWANCE_PAUSED') return { kind: 'paused', until: new Date(String(err.params?.retryAt)), error: err };
            return { kind: 'refused', error: err };
        }
        throw err;
    }

    // 3. The provider, outside any transaction and holding no pooled client.
    const { row, keys, prompt, reservation } = claim;
    const used = keys.map((key) => refs.get(key)!);
    const seed = pictureSeed(explainerId, row.position, row.draw_attempts);
    const started = Date.now();
    let drawn: DrawnPicture;
    try {
        drawn = await provider.draw({
            prompt, width: SCENE_SIZE.width, height: SCENE_SIZE.height, seed, references: used.map((ref) => ({ data: ref.data, mime: ref.mime })),
        });
    } catch (err) {
        const failure = asProviderError(err, { explainer_id: explainerId, position: row.position });
        log('warn', 'explainer.picture_failed', {
            explainer_id: explainerId, position: row.position, kind: failure.kind, status: failure.detail.status, code: failure.detail.code, ms: Date.now() - started,
        });
        if (failure.kind === 'ALLOWANCE_EXHAUSTED') {
            // The provider's allocation is used up: the units stay counted, the day is marked, and the scene waits for the reset.
            const until = await markExhausted(provider.id);
            await pool.query(RELEASE_SCENE_SQL, [row.id, explainerId, creatorId]);
            return { kind: 'paused', until, error: pausedError(until, 'exhausted', provider) };
        }
        await refundAllowance(reservation);
        await pool.query(FAIL_SCENE_SQL, [row.id, explainerId, creatorId, failure.message]);
        return { kind: 'failed', error: new ExplainerError('EXPLAINER_PROVIDER_ERROR', failure.message) };
    }

    // The file, into the media store. The provider drew it, so the units stay spent whatever happens next.
    let stored: { id: string };
    try {
        stored = await store.put({ creatorId, filename: fileName(explainerId, row.position, drawn.mime), mimeType: drawn.mime, data: drawn.data });
    } catch (err) {
        log('error', 'explainer.picture_unsaved', { explainer_id: explainerId, position: row.position, ...describeError(err) });
        const message = `The picture was drawn but could not be saved: ${messageOf(err)}`;
        await pool.query(FAIL_SCENE_SQL, [row.id, explainerId, creatorId, message]);
        return { kind: 'failed', error: new ExplainerError('EXPLAINER_PROVIDER_ERROR', message) };
    }

    // 4. One short transaction: the scene's picture, its history, the scenes that continue it, and the files that dropped out.
    const chosen: ExplainerPicture = {
        media_id: stored.id,
        url: store.publicUrl(stored.id, ''),
        seed,
        provider: drawn.provider,
        model: drawn.model,
        prompt_hash: promptHash(prompt, { width: SCENE_SIZE.width, height: SCENE_SIZE.height, references: used.map((ref) => ref.mediaId) }),
        at: new Date().toISOString(),
    };
    let scene: ExplainerSceneRow | null;
    try {
        scene = await withTransaction((tx) => storePicture(tx, creatorId, explainerId, row.id, chosen));
    } catch (err) {
        // Nothing names the file now. The scene stays `drawing` and is claimed again after two minutes.
        await pool.query(DELETE_FILE_SQL, [stored.id, creatorId]).catch(() => undefined);
        throw err;
    }
    if (!scene) {
        // The scene was deleted while the provider worked: the file belongs to nothing.
        await pool.query(DELETE_FILE_SQL, [stored.id, creatorId]).catch(() => undefined);
        return { kind: 'lost' };
    }
    log('info', 'explainer.picture_drawn', {
        explainer_id: explainerId, position: scene.position, provider: drawn.provider, model: drawn.model, seed, references: used.length, ms: Date.now() - started,
    });
    return { kind: 'drawn', scene };
}

/**
 * The loop's step for a scene that continues the one before: claim it, take that scene's chosen picture, and carry it on to the run of scenes after
 * that continue too. One transaction, no provider, no allowance. A scene before with no picture cannot be continued: this one is marked failed with
 * that reason (and healed when the one before is drawn).
 */
async function copyContinuing(creatorId: string, explainerId: string, candidate: ExplainerSceneRow): Promise<Outcome> {
    return withTransaction(async (tx): Promise<Outcome> => {
        const { rows } = await tx.query<ExplainerSceneRow>(CLAIM_UNATTENDED_SQL, [explainerId, creatorId, candidate.position]);
        const claimed = rows[0];
        if (!claimed || !isContinuing(claimed)) throw LOST; // taken by another caller, or no longer a scene that continues: go round again
        const { rows: before } = await tx.query<ExplainerSceneRow>(SCENE_AT_SQL, [explainerId, creatorId, claimed.position - 1]);
        const source = before[0]?.picture ?? null;
        if (!source) {
            const message = `Scene ${claimed.position} has no picture yet, so scene ${nth(claimed.position)} cannot continue it.`;
            await tx.query(FAIL_SCENE_SQL, [claimed.id, explainerId, creatorId, message]);
            return { kind: 'failed', error: new ExplainerError('EXPLAINER_BAD_STATE', message, { position: claimed.position }) };
        }
        const { rows: copied } = await tx.query<ExplainerSceneRow>(COPY_PICTURE_SQL, [claimed.id, explainerId, creatorId, JSON.stringify(source)]);
        const scene = copied[0];
        if (!scene) throw LOST;
        const orphans = [...mediaIdsOf(claimed), ...(await propagate(tx, creatorId, explainerId, scene.position, source))];
        await deleteUnreferenced(tx, creatorId, explainerId, orphans);
        return { kind: 'drawn', scene };
    }).catch((err) => {
        if (err === LOST) return { kind: 'lost' } as const;
        throw err;
    });
}

async function countPending(creatorId: string, explainerId: string): Promise<number> {
    const row = await queryOne<{ n: number }>(COUNT_PENDING_SQL, [explainerId, creatorId]);
    return row?.n ?? 0;
}

// ─── The loop's step ─────────────────────────────────────────────────────────────────────────────

/**
 * Draw the pending scene with the lowest position, or copy it if it continues the one before. Answers:
 *
 *   drawn    the position it handled, and how many scenes are still pending
 *   done     nothing is pending (scenes that failed are not pending: the owner redraws them, or retries)
 *   paused   the allowance is used up or the cap is reached: `until` is when drawing may resume (ISO)
 *   failed   that scene could not be drawn, and has been marked with the reason; the next call goes on to the next scene
 *
 * Throws 404 for an explainer that is not the tenant's, 409 `EXPLAINER_NO_PROVIDER` when a scene needs drawing and none is set up, and 409
 * `EXPLAINER_BAD_STATE` when it keeps losing the claim to other callers.
 */
export async function drawNext(args: { creatorId: string; explainerId: string }): Promise<DrawNextAnswer> {
    const { creatorId, explainerId } = args;
    for (let tries = 0; tries < MAX_CLAIM_TRIES; tries++) {
        await assertExplainer(creatorId, explainerId);
        const candidate = await queryOne<ExplainerSceneRow>(PEEK_NEXT_SQL, [explainerId, creatorId]);
        if (!candidate) return { state: 'done' };

        let outcome: Outcome;
        if (isContinuing(candidate)) {
            outcome = await copyContinuing(creatorId, explainerId, candidate);
        } else {
            const provider = await getImageProvider();
            if (!provider) throw noProvider();
            outcome = await drawWithProvider({
                creatorId, explainerId, candidate, explicit: false, note: candidate.draw_note, provider, look: await readLook(creatorId), store: await getMediaStore(),
            });
        }

        switch (outcome.kind) {
            case 'lost':
                continue;
            case 'drawn':
                return { state: 'drawn', position: candidate.position, remaining: await countPending(creatorId, explainerId) };
            case 'paused':
                return { state: 'paused', until: outcome.until.toISOString() };
            case 'refused':
                // Nothing was claimed or spent, so the scene is still pending: mark it, or the loop would meet it again on the next call.
                await pool.query(FAIL_SCENE_SQL, [candidate.id, explainerId, creatorId, outcome.error.message]);
                return { state: 'failed', position: candidate.position, error: outcome.error.message };
            case 'failed':
                return { state: 'failed', position: candidate.position, error: outcome.error.message };
        }
    }
    throw new ExplainerError('EXPLAINER_BAD_STATE', 'Another draw is already working on this explainer.');
}

// ─── The owner's draw ────────────────────────────────────────────────────────────────────────────

/**
 * Draw or redraw one scene now (`POST /explainers/:id/scenes/:position/draw`, synchronous, at most the provider's 55 s). `note` is the owner's
 * redraw note: it goes into the prompt for this drawing and replaces the last one on the scene. The scene's earlier chosen picture goes to the
 * history; a draw that fails leaves the scene's picture as it was.
 *
 * Errors: 422 `EXPLAINER_PROMPT_REFUSED` (a woman or a girl in the note, the brief or a character's description, a note over 300 characters, an empty
 * brief), 409 `EXPLAINER_NEEDS_REFERENCE`, 409 `EXPLAINER_NO_PROVIDER`, 429 `EXPLAINER_ALLOWANCE_PAUSED` (`retryAt`), 502 `EXPLAINER_PROVIDER_ERROR`, 404
 * for an explainer or a scene that is not there, and 409 `EXPLAINER_BAD_STATE` for a scene that continues the one before it or is being drawn now.
 */
export async function drawScene(args: { creatorId: string; explainerId: string; position: number; note?: string | null }): Promise<{ scene: ExplainerSceneRow; allowance: AllowanceStatus | null }> {
    const { creatorId, explainerId, position } = args;
    // The owner's own words, first: refused before a thing is read.
    const note = refuseNote(args.note);
    if (!Number.isInteger(position) || position < 0) throw noScene();
    await assertExplainer(creatorId, explainerId);

    const candidate = await sceneAt(creatorId, explainerId, position);
    if (!candidate) throw noScene();
    if (isContinuing(candidate)) {
        throw continuesError(position, `, so it is not drawn: redraw scene ${position}, or switch off «continues» for scene ${nth(position)} first.`);
    }
    const provider = await getImageProvider();
    if (!provider) throw noProvider();

    const outcome = await drawWithProvider({ creatorId, explainerId, candidate, explicit: true, note, provider, look: await readLook(creatorId), store: await getMediaStore() });
    switch (outcome.kind) {
        case 'drawn':
            return { scene: outcome.scene, allowance: await allowanceStatus() };
        case 'lost':
            // The claim found no scene to take: it is gone, or it is being drawn.
            if (!(await sceneAt(creatorId, explainerId, position))) throw noScene();
            throw beingDrawn(position);
        case 'paused':
        case 'refused':
        case 'failed':
            throw outcome.error;
    }
}

// ─── Going back ──────────────────────────────────────────────────────────────────────────────────

/**
 * Make one of a scene's earlier pictures the chosen one (`POST /explainers/:id/scenes/:position/pick`). The chosen one is set aside as the newest of
 * the history in its place, so nothing is lost and nothing is deleted, and the scenes that continue this one take the picked picture. 404 for an
 * index there is no picture at, 409 `EXPLAINER_BAD_STATE` for a scene being drawn now or one that continues the scene before it.
 */
export async function pickPicture(args: { creatorId: string; explainerId: string; position: number; index: number }): Promise<{ scene: ExplainerSceneRow }> {
    const { creatorId, explainerId, position, index } = args;
    if (!Number.isInteger(position) || position < 0) throw noScene();
    await assertExplainer(creatorId, explainerId);

    return withTransaction(async (tx) => {
        const { rows } = await tx.query<ExplainerSceneRow & { busy: boolean }>(PICK_LOCK_SQL, [explainerId, creatorId, position]);
        const row = rows[0];
        if (!row) throw noScene();
        if (row.busy) throw beingDrawn(position);
        if (isContinuing(row)) throw continuesError(position, `: pick one for scene ${position} instead.`);
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= row.pictures.length) {
            throw new ExplainerError('EXPLAINER_NOT_FOUND', `Scene ${nth(position)} has no earlier picture number ${Number.isInteger(index) ? index + 1 : String(index)}.`);
        }

        const chosen = row.pictures[index]!;
        const rest = row.pictures.filter((_, at) => at !== index);
        const history = (row.picture ? [row.picture, ...rest] : rest).slice(0, KEPT_HISTORY);
        const { rows: updated } = await tx.query<ExplainerSceneRow>(PICK_SQL, [row.id, explainerId, creatorId, JSON.stringify(chosen), JSON.stringify(history)]);
        const scene = updated[0];
        if (!scene) throw noScene();
        await deleteUnreferenced(tx, creatorId, explainerId, await propagate(tx, creatorId, explainerId, scene.position, chosen));
        return { scene };
    });
}
