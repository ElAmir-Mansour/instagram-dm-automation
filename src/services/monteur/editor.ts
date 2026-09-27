/**
 * The Editor: the pro edits on a Monteur reel (MONTEUR.md §6.2).
 *
 * One Gemini call for all of a video's clips, after the Marketer. For each clip it reads the
 * clip's own lines and names the moments worth marking: a pop-up keyword restating the point, a
 * chip for a tool the speaker names, an emoji for a concept, a photo of a real-world thing it
 * mentions (from a free photo library, never generated), or a punch-in on a result. Each edit
 * is anchored on a spoken word, so it lands when the word is said, and carries a sound effect from
 * the worker's own library. Code, not the model, decides the timing: the word's start, spacing,
 * and the limits in MonteurClip (aicourse-captions/src/monteur/layout.ts, cleanEdits).
 *
 * Asked for in the owner's words (2026-09-27): "the editing must be more … images or edits
 * related to the topic … with some audio sounds for those things".
 */
import type { GeminiSchema } from '../studio/generate.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { languageKit } from '../studio/prompts.js';
import { normalizeArabic } from '../../utils/arabic.js';
import type { TranscriptWord } from '../../db/rows.js';
import { ask, type CallCost, emptyCost } from './model.js';
import type { TranscriptLine } from './transcript.js';
import { formatStamp } from './transcript.js';

export const EDIT_KINDS = ['keyword', 'tool', 'emoji', 'image', 'punch'] as const;
export type EditKind = (typeof EDIT_KINDS)[number];
export const EDIT_SFX = ['whoosh', 'whip', 'ding', 'click', 'switch', 'none'] as const;
export type EditSfx = (typeof EDIT_SFX)[number];

/** What the render gets: `t` in seconds on the clip's clock. */
export interface ClipEdit {
    t: number;
    kind: EditKind;
    text?: string;
    emoji?: string;
    /**
     * image: 2–4 English words naming one concrete object or scene — what the worker searches a
     * free photo library for (MONTEUR.md §6.2). Letters, digits and spaces, at most 40 characters.
     */
    query?: string;
    sfx?: Exclude<EditSfx, 'none'>;
}

/** About one edit every 7 s, never more than this per clip. */
export const MAX_EDITS_PER_CLIP = 12;
export const EDITOR_MAX_OUTPUT = 8192;
export const EDITOR_THINKING = 1024;
/** The call's own ceiling; the sweep's deadline may cut it shorter. */
export const EDITOR_CALL_MS = 90_000;
const MAX_TEXT = 28;
/** An image's photo library query: at most this many characters, whole words. */
export const MAX_QUERY = 40;
/** Pictures take the worker a library search each, and cover the speaker: at most this many per clip. */
export const MAX_IMAGES_PER_CLIP = 2;

const str = (description: string): GeminiSchema => ({ type: 'STRING', description });

export const EDITOR_SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        clips: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    clip: { type: 'INTEGER', description: 'the clip\'s number, C<n>' },
                    edits: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                line: { type: 'INTEGER', description: 'the n of the line, L<n>' },
                                word: str('the exact word in that line the edit lands on'),
                                kind: { type: 'STRING', enum: [...EDIT_KINDS] },
                                text: str(`keyword: 2-4 words, at most ${MAX_TEXT} characters; tool: the tool's name in Latin script`),
                                emoji: str('emoji: one emoji'),
                                query: str(`image: 2-4 English words naming one concrete object or scene a free photo library has, at most ${MAX_QUERY} characters`),
                                sfx: { type: 'STRING', enum: [...EDIT_SFX] },
                            },
                            required: ['line', 'word', 'kind', 'sfx'],
                            propertyOrdering: ['line', 'word', 'kind', 'text', 'emoji', 'query', 'sfx'],
                        },
                    },
                },
                required: ['clip', 'edits'],
                propertyOrdering: ['clip', 'edits'],
            },
        },
    },
    required: ['clips'],
    propertyOrdering: ['clips'],
};

export function editorSystemPrompt(settings: StudioSettings): string {
    const lang = languageKit(settings).name;
    return `You are the editor of short vertical reels cut from a creator's screen recordings. You add pro edits that make each reel easier to follow and more fun to watch. Answer with JSON only.
For each clip, mark 6-10 moments (about one every 7-9 seconds), none in its first second or last 3 seconds, each on a word from its lines:
- keyword: 2-4 words in ${lang} that restate the point being made right then, like a subtitle headline. Never the title again, never filler.
- tool: when the speaker names a tool or product (Gemini, ChatGPT, Claude, n8n, Python…), its name in Latin script.
- emoji: one emoji for a concept being said (🔒 privacy, ⚡ speed, 🌍 language, 🐍 Python, 🧠 thinking, 📄 document, ✅ it works, ❌ a mistake, 🤯 a surprise, 💡 an idea).
- image: at most 2 per clip, for a real-world thing the speaker mentions or compares to. query: 2-4 English words naming one concrete object or scene a free photo library has (e.g. world map, recipe book).
- punch: a quick zoom-in when a result appears on screen or on a strong claim. At most 2 per clip.
sfx: whoosh for a keyword, tool or image, switch for an emoji, ding for a result or ✅, click for a UI action or punch, none when a sound would be too much. Vary them.
Mix the kinds; never two of the same in a row. Invent nothing: only what the clip says.`;
}

/** The clips as the Editor reads them: C<n>, then its lines numbered from 1 with their clip-relative time. */
export function editorUserPrompt(clips: readonly { lines: readonly { t: number; text: string }[] }[]): string {
    return clips.map((c, i) => [
        `C${i + 1}`,
        ...c.lines.map((l, j) => `L${j + 1} [${formatStamp(l.t)}] ${l.text}`),
    ].join('\n')).join('\n\n');
}

/**
 * A clip's lines on its own clock: the source's lines that fall inside [start, end], with times
 * made relative to `start`, and each line's words (clip-relative) for anchoring.
 */
export function clipLines(
    lines: readonly TranscriptLine[], words: readonly TranscriptWord[], start: number, end: number
): { t: number; text: string; words: TranscriptWord[] }[] {
    const out: { t: number; text: string; words: TranscriptWord[] }[] = [];
    for (const l of lines) {
        const ws = words.slice(l.first, l.last + 1).filter((w) => w[0] >= start - 0.05 && w[1] <= end + 0.05);
        if (!ws.length) continue;
        const rel = ws.map(([a, b, t]) => [Math.max(0, a - start), Math.max(0, b - start), t] as TranscriptWord);
        out.push({ t: rel[0]![0], text: rel.map((w) => w[2].trim()).filter(Boolean).join(' '), words: rel });
    }
    return out;
}

const norm = (s: string) => normalizeArabic(String(s)).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/**
 * An image's query as the library gets it: Latin letters, digits and single spaces, whole words up
 * to 40 characters. Anything else — punctuation, another script — is a word break, so a query
 * with no English left is empty, and the image is dropped.
 */
function cleanQuery(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    let query = '';
    for (const word of raw.replace(/[^A-Za-z0-9 ]+/g, ' ').split(' ').filter(Boolean)) {
        const next = query ? `${query} ${word}` : word;
        if (next.length > MAX_QUERY) break;
        query = next;
    }
    return query;
}

/**
 * The model's edits for one clip, placed on the clip's clock: each lands on the start of its word
 * in its line (the first match, else the line's start). Unknown kinds, missing text, emoji or
 * query, a third image, and lines that don't exist are dropped; spacing and the other limits are
 * the renderer's (cleanEdits).
 */
export function placeEdits(raw: unknown, lines: readonly { t: number; words: TranscriptWord[] }[]): ClipEdit[] {
    const list = Array.isArray(raw) ? raw : [];
    const out: ClipEdit[] = [];
    for (const item of list) {
        const e = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const kind = e.kind as EditKind;
        if (!(EDIT_KINDS as readonly string[]).includes(kind)) continue;
        const n = typeof e.line === 'number' && Number.isInteger(e.line) ? e.line : 0;
        const line = lines[n - 1];
        if (!line) continue;
        const target = norm(typeof e.word === 'string' ? e.word : '');
        const hit = target ? line.words.find((w) => norm(w[2]) === target) ?? line.words.find((w) => norm(w[2]).includes(target)) : undefined;
        const t = Math.round((hit ? hit[0] : line.t) * 100) / 100;
        const text = typeof e.text === 'string' ? e.text.trim().slice(0, MAX_TEXT) : '';
        const emoji = typeof e.emoji === 'string' ? [...e.emoji.trim()].slice(0, 2).join('') : '';
        const query = cleanQuery(e.query);
        if ((kind === 'keyword' || kind === 'tool') && !text) continue;
        if (kind === 'emoji' && !emoji) continue;
        if (kind === 'image' && (!query || out.filter((o) => o.kind === 'image').length >= MAX_IMAGES_PER_CLIP)) continue;
        const sfx = (EDIT_SFX as readonly string[]).includes(e.sfx as string) && e.sfx !== 'none' ? (e.sfx as ClipEdit['sfx']) : undefined;
        out.push({
            t, kind, ...(kind === 'keyword' || kind === 'tool' ? { text } : {}), ...(kind === 'emoji' ? { emoji } : {}),
            ...(kind === 'image' ? { query } : {}), ...(sfx ? { sfx } : {}),
        });
        if (out.length === MAX_EDITS_PER_CLIP) break;
    }
    return out.sort((a, b) => a.t - b.t);
}

/** The model's answer mapped back to clips by their C<n>, never by position. */
export function editsByClip(raw: unknown, clipLinesList: readonly { t: number; words: TranscriptWord[] }[][]): ClipEdit[][] {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const items = Array.isArray(r.clips) ? r.clips : [];
    return clipLinesList.map((lines, i) => {
        const mine = items.find((c) => c && typeof c === 'object' && (c as Record<string, unknown>).clip === i + 1) as Record<string, unknown> | undefined;
        return mine ? placeEdits(mine.edits, lines) : [];
    });
}

export interface EditResult {
    /** One list per clip, in the clips' order; `[]` for a clip the answer skipped. */
    edits: ClipEdit[][];
    cost: CallCost;
}

/**
 * The Editor's one call for every clip of a video, C1… in the order given (the clips that got
 * copy), each read on its own clock. Throws what the call throws: the sweep catches it, since a
 * failed Editor call must never hold a reel back.
 */
export async function writeEdits(
    clips: readonly { start: number; end: number }[],
    lines: readonly TranscriptLine[],
    words: readonly TranscriptWord[],
    settings: StudioSettings,
    deadline: number,
): Promise<EditResult> {
    const cost = emptyCost();
    const perClip = clips.map((c) => clipLines(lines, words, c.start, c.end));
    const raw = await ask({
        purpose: 'monteur.edit',
        system: editorSystemPrompt(settings),
        turns: [{ role: 'user', text: editorUserPrompt(perClip.map((l) => ({ lines: l }))) }],
        schema: EDITOR_SCHEMA,
        temperature: 0.6,
        thinkingBudget: EDITOR_THINKING,
        maxOutputTokens: EDITOR_MAX_OUTPUT,
        capMs: EDITOR_CALL_MS,
    }, deadline, cost);
    return { edits: editsByClip(raw, perClip), cost };
}
