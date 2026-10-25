/**
 * The payloads of the four Mac jobs (contracts/worker-jobs.md), built from an explainer's rows and the tenant's settings. Pure: no database, no clock, no
 * network. The caller reads the rows and the settings, and the public address the worker downloads from; what is built here is what `studio_jobs.payload` holds.
 *
 * `renderReadiness` is the one list of what a render needs (fresh audio, a picture for every scene, a track when the sound is music), asked by Approve
 * pictures, by Render and by the payload builder, so the three cannot disagree about what is ready.
 */
import type {
    ExplainerAudio, ExplainerDrawPayload, ExplainerPicture, ExplainerRenderPayload, ExplainerRow, ExplainerSceneRow, ExplainerVoicePayload, ExplainerWritePayload,
} from '../../db/rows.js';
import { THINK_MODEL } from '../monteur/think.js';
import type { ExplainerTrack, StudioSettings } from '../studio/settingsTypes.js';
import { ExplainerError } from './errors.js';
import { buildWriterInputs, type PreviousDraft, type WriterRequest } from './prompt.js';
import { isAudioStale } from './state.js';
import { subtitleWordsFor } from './subtitles.js';

/** The longest part the voice is asked for at once (research.md R3: one request per short video, parts of about three minutes beyond). */
export const VOICE_CHUNK_SECONDS_MAX = 180;

// ─── Write ─────────────────────────────────────────────────────────────────────────────────────

/** The previous draft a rewrite is shown: the scenes the owner saw, and what the draft holds besides them. */
export function previousDraftOf(row: Pick<ExplainerRow, 'title' | 'draft'>, scenes: readonly ExplainerSceneRow[]): PreviousDraft {
    return {
        title: row.title,
        scenes: scenes.map((s) => ({ narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: s.characters, continues: s.continues })),
        captions: row.draft?.captions ?? null,
        first_comment: row.draft?.first_comment ?? null,
        replies: row.draft?.replies ?? [],
        sources: row.draft?.sources ?? [],
    };
}

export interface WriteRequestArgs {
    row: Pick<ExplainerRow, 'id' | 'topic' | 'notes' | 'language' | 'length_tier' | 'source_links'>;
    settings: Pick<StudioSettings, 'explainer'> & { voice?: Pick<StudioSettings['voice'], 'avoid'> };
    /** `YYYY-MM-DD`. */
    today: string;
    rewrite?: { note: string; previous: PreviousDraft } | null;
}

/** What the writer is asked about this explainer, whoever writes it: the tenant's characters, art direction and pace, and the owner's words. */
export function writerRequest(args: WriteRequestArgs): WriterRequest {
    const { row, settings } = args;
    return {
        topic: row.topic, notes: row.notes, language: row.language, tier: row.length_tier, sourceLinks: row.source_links.map((link) => link.url),
        characters: settings.explainer.characters.map(({ key, name, description }) => ({ key, name, description })),
        style: settings.explainer.style, avoid: settings.voice?.avoid ?? [], today: args.today,
        ...(args.rewrite ? { rewriteNote: args.rewrite.note, previousDraft: args.rewrite.previous } : {}),
    };
}

/**
 * The `explainer_write` payload (contracts/worker-jobs.md): the explainer's inputs, and `write`, the prompts and the schema Claude on the Mac is run with. The
 * worker reads `explainer_id` and `write` and ignores the rest, which is for whoever reads the job.
 */
export function writePayload(args: WriteRequestArgs): ExplainerWritePayload {
    const { row, settings } = args;
    const request = writerRequest(args);
    const inputs = buildWriterInputs(request, settings.explainer.pace[row.language], 'research');
    return {
        explainer_id: row.id, language: row.language, length_tier: row.length_tier, topic: row.topic, notes: row.notes,
        source_links: request.sourceLinks as string[],
        ...(args.rewrite ? { rewrite_note: args.rewrite.note, previous_draft: args.rewrite.previous } : {}),
        characters: request.characters as { key: string; name: string; description: string }[],
        style: request.style, bounds: inputs.bounds,
        write: { model: THINK_MODEL, system: inputs.system, user: inputs.user, schema: inputs.schema },
    };
}

// ─── Voice ─────────────────────────────────────────────────────────────────────────────────────

/** The `explainer_voice` payload: the spoken script at the version the owner approved (the result of any other version is stale), in his voice and style. */
export function voicePayload(
    row: Pick<ExplainerRow, 'id' | 'language' | 'draft_version'>, scenes: readonly Pick<ExplainerSceneRow, 'position' | 'spoken'>[], settings: Pick<StudioSettings, 'explainer'>
): ExplainerVoicePayload {
    return {
        explainer_id: row.id, version: row.draft_version, language: row.language, voice: settings.explainer.voices[row.language], style: settings.explainer.voice_style,
        scenes: scenes.map((s) => ({ position: s.position, spoken: s.spoken })), chunk_seconds_max: VOICE_CHUNK_SECONDS_MAX,
    };
}

// ─── Draw ──────────────────────────────────────────────────────────────────────────────────────

export function drawPayload(row: Pick<ExplainerRow, 'id'>): ExplainerDrawPayload {
    return { explainer_id: row.id };
}

// ─── Render ────────────────────────────────────────────────────────────────────────────────────

/** An upload of ours as the worker downloads it: a path becomes an address on the public base, an address is kept. */
export function absoluteUrl(url: string, base: string): string {
    return url.startsWith('/') ? `${base.replace(/\/+$/, '')}${url}` : url;
}

/** The picture a scene shows: its own, or, when it only continues, the one before it. */
export function pictureOf(scenes: readonly Pick<ExplainerSceneRow, 'picture' | 'continues'>[], index: number): ExplainerPicture | null {
    for (let i = index; i >= 0; i--) {
        const scene = scenes[i]!;
        if (scene.picture) return scene.picture;
        if (!scene.continues) return null;
    }
    return null;
}

/** The track a render uses: the library's entry the explainer names, when the sound is music. */
export function trackOf(row: Pick<ExplainerRow, 'sound_mode' | 'music_track_id'>, settings: Pick<StudioSettings, 'explainer'>): ExplainerTrack | null {
    if (row.sound_mode !== 'music') return null;
    return settings.explainer.music.find((track) => track.key === row.music_track_id) ?? null;
}

/**
 * Throws what stops a render, in the order a person fixes it: the audio is not there or is out of date (`EXPLAINER_AUDIO_STALE`: voice it again), the sound
 * is music and its track is gone (`EXPLAINER_NO_TRACK`: choose another or switch to sound effects), a scene has no picture (`EXPLAINER_PICTURES_MISSING`).
 * Used by Approve pictures and by Render, and by the payload builder, which therefore never builds a payload a render could not run.
 */
export function renderReadiness(
    row: Pick<ExplainerRow, 'audio' | 'words' | 'draft_version' | 'sound_mode' | 'music_track_id'>, scenes: readonly ExplainerSceneRow[], settings: Pick<StudioSettings, 'explainer'>
): { audio: ExplainerAudio; track: ExplainerTrack | null } {
    if (!row.audio || !row.words) throw new ExplainerError('EXPLAINER_BAD_STATE', 'This explainer has no voiced narration yet, so there is nothing to render.', { status: 'unvoiced' });
    if (isAudioStale(row as Pick<ExplainerRow, 'audio' | 'draft_version'>)) {
        throw new ExplainerError('EXPLAINER_AUDIO_STALE', 'The narration changed after it was voiced. Voice it again before the pictures are approved or the video is rendered.');
    }
    const track = trackOf(row, { explainer: settings.explainer });
    if (row.sound_mode === 'music' && !track) {
        throw new ExplainerError('EXPLAINER_NO_TRACK', 'The sound is music, but its track is not in the library. Choose another track, or switch to sound effects only.');
    }
    const missing = scenes.flatMap((scene, index) => (pictureOf(scenes, index) ? [] : [scene.position]));
    if (missing.length) {
        throw new ExplainerError(
            'EXPLAINER_PICTURES_MISSING', `${missing.length} scene${missing.length === 1 ? ' has' : 's have'} no picture yet: ${missing.slice(0, 20).map((p) => p + 1).join(', ')}.`,
            { missing: missing.length }, { positions: missing }
        );
    }
    return { audio: row.audio, track };
}

/**
 * The `explainer_render` payload: the audio, the scenes with their times, labels and pictures, the subtitle words (each scene's narration as written,
 * timed by its spoken words: subtitles.ts), the owner's brand (the
 * infographic settings: his names, handle, site and portrait) and the sound. `base` is the public address the worker downloads from. Throws what
 * `renderReadiness` throws.
 */
export function renderPayload(
    row: ExplainerRow, scenes: readonly ExplainerSceneRow[], settings: StudioSettings, base: string
): ExplainerRenderPayload {
    const { audio, track } = renderReadiness(row, scenes, settings);
    const brand = settings.infographic;
    const name = row.language === 'ar' ? brand.name.ar || brand.name.en : brand.name.en || brand.name.ar;
    return {
        explainer_id: row.id, version: row.draft_version, title: row.title ?? '', language: row.language, subtitles: row.subtitles, sound_mode: row.sound_mode,
        ...(track ? { music: { url: absoluteUrl(track.url, base), credit_required: track.credit_required } } : {}),
        sfx: row.sound_mode === 'sfx',
        audio: { url: absoluteUrl(audio.url, base), duration: audio.duration },
        scenes: scenes.map((scene, index) => ({
            position: scene.position, start: scene.start_s ?? 0, end: scene.end_s ?? 0, label: scene.label,
            picture_url: absoluteUrl(pictureOf(scenes, index)!.url, base),
        })),
        // The narration as written (OpenAI, not «أوبن إيه آي»), on the spoken words' times: subtitles.ts.
        words: subtitleWordsFor(scenes, row.words ?? {}),
        brand: { name, handle: brand.handle, site: brand.site, ...(brand.photo_url ? { photo_url: absoluteUrl(brand.photo_url, base) } : {}) },
        title_color: settings.explainer.title_color,
        formats: ['vertical', 'horizontal'],
    };
}
