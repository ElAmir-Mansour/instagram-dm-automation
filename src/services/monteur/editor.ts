/**
 * The Editor: the pro edits on a Monteur reel (MONTEUR.md §6.2).
 *
 * One Gemini call for all of a video's clips, after the Marketer. For each clip it reads the
 * clip's own lines and names the moments worth marking: a pop-up keyword restating the point, a
 * chip for a tool the speaker names, an emoji or a drawn line icon for a concept, a photo of a real-world thing it
 * mentions (from a free photo library, never generated), or a punch-in on a result. Each edit
 * is anchored on a spoken word, so it lands when the word is said, and carries a sound effect from
 * the worker's own library. Code, not the model, decides the timing: the word's start, spacing,
 * and the limits in MonteurClip (aicourse-captions/src/monteur/layout.ts, cleanEdits).
 *
 * The teaching kinds (example, callout, step, define, compare, recap) apply Mayer's multimedia
 * principles to a reel: show the outside thing he refers to, point at what he demonstrates,
 * segment a procedure, pre-train a term, contrast two things, and close on a recap. Code holds
 * the rules it can: their word limits, their per-clip caps, their sounds, and redundancy (a
 * keyword that repeats the words being said is dropped: the captions already show them).
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
import { thinkRoute, type ThinkOn } from './think.js';
import type { TranscriptLine } from './transcript.js';
import { formatStamp } from './transcript.js';

export const EDIT_KINDS = [
    'keyword', 'tool', 'emoji', 'image', 'broll', 'highlight', 'punch',
    'example', 'callout', 'step', 'define', 'compare', 'recap', 'icon',
] as const;
export type EditKind = (typeof EDIT_KINDS)[number];
/** Sound families the worker has (its own files plus Kenney's CC0 packs); 'whip' and 'switch' are the older names. */
export const EDIT_SFX = ['whoosh', 'pop', 'click', 'ding', 'impact', 'glitch', 'error', 'whip', 'switch', 'none'] as const;
/**
 * The picture library's topics (aicourse-captions/scripts/monteur/library.mjs, LIBRARY_TOPICS): the
 * worker keeps free public-domain photos of each, so an image or broll edit names one of these.
 */
export const LIBRARY_TOPICS = [
    'artificial intelligence', 'robot', 'brain', 'computer', 'laptop', 'keyboard', 'code', 'server',
    'data center', 'cloud', 'network', 'database', 'chart', 'analytics', 'office', 'books', 'library',
    'notebook', 'writing', 'document', 'email', 'smartphone', 'lock', 'security', 'key', 'world map',
    'globe', 'city', 'rocket', 'lightbulb', 'puzzle', 'gears', 'factory', 'automation', 'calendar',
    'clock', 'money', 'store', 'shopping cart', 'kitchen', 'recipe', 'camera', 'video', 'microphone',
    'headphones', 'design', 'sketch', 'paint', 'search', 'question', 'checklist', 'target', 'trophy',
    'mountain', 'road', 'maze', 'compass', 'sunrise', 'desert', 'coffee', 'desk', 'translation',
    'arabic', 'magic', 'speed', 'time', 'idea', 'photo', 'map', 'science', 'medicine', 'whiteboard',
    'sticky notes', 'flowchart', 'filing cabinet', 'folders', 'archive', 'card catalog', 'briefcase',
    'paperwork', 'receipt', 'cash register', 'calculator', 'telephone', 'mailbox', 'presentation',
    'delivery truck', 'warehouse', 'boxes', 'assembly line', 'toolbox', 'tools', 'blueprint',
    'restaurant', 'serving tray', 'plug', 'usb', 'circuit board', 'chip', 'terminal', 'router',
    'control panel', 'traffic light', 'signpost', 'stairs', 'pyramid', 'building blocks',
    'construction', 'car', 'radio', 'television', 'safe', 'shipping containers', 'railway', 'scissors',
    'price tag',
] as const;
export type EditSfx = (typeof EDIT_SFX)[number];

/**
 * The line icons an icon edit can draw on (Tabler Icons, the paper style). Keep this list in step
 * with the worker's own, aicourse-captions/scripts/monteur/icons.mjs ICON_NAMES: an icon the worker
 * doesn't have is left out of the reel. Objects and symbols only, never a person.
 */
export const ICON_NAMES = [
    'heart', 'heartbeat', 'activity-heartbeat', 'brain', 'ambulance', 'first-aid-kit', 'stethoscope', 'pill', 'vaccine', 'dna-2',
    'microscope', 'flask', 'virus', 'droplet', 'lungs', 'bone', 'eye', 'ear', 'bed', 'zzz', 'moon', 'sun', 'alert-triangle', 'alarm',
    'clock', 'hourglass', 'calendar', 'bulb', 'rocket', 'robot', 'code', 'terminal-2', 'database', 'cloud', 'server', 'cpu',
    'device-laptop', 'device-mobile', 'world', 'map-pin', 'map', 'compass', 'target', 'trophy', 'star', 'flame', 'bolt', 'search',
    'question-mark', 'check', 'x', 'circle-check', 'circle-x', 'arrow-big-up', 'arrow-big-down', 'arrow-right', 'trending-up',
    'trending-down', 'chart-bar', 'chart-pie', 'report-analytics', 'file-text', 'files', 'folder', 'book', 'books', 'notebook',
    'pencil', 'writing', 'message-circle', 'messages', 'mail', 'phone', 'lock', 'lock-open', 'key', 'shield-check', 'settings',
    'tool', 'tools', 'puzzle', 'school', 'certificate', 'building-hospital', 'building-bank', 'shopping-cart', 'coin', 'cash', 'gift',
    'camera', 'video', 'microphone', 'headphones', 'music', 'photo', 'palette', 'brush', 'wand', 'sparkles', 'link', 'share',
    'download', 'upload', 'refresh', 'repeat', 'player-play', 'news', 'mood-happy', 'mood-sad', 'chess-knight',
    'stairs-up', 'plant-2', 'coffee', 'home', 'building-store', 'car', 'plane', 'bike', 'battery-charging', 'wifi', 'language',
] as const;

/**
 * The teaching kinds and their sounds, set here rather than by the model (each kind always sounds
 * like itself; the model's 'none' still silences one): a whoosh as a photo or the recap arrives, a
 * click on what he points at, a pop per step, a chime for a new term, and the mistake's buzz as a
 * contrast opens (the worker adds a ding as its right side lands).
 */
export const TEACHING_SFX = {
    example: 'whoosh', callout: 'click', step: 'pop', define: 'ding', compare: 'error', recap: 'whoosh',
} as const satisfies Record<string, Exclude<EditSfx, 'none'>>;
export type TeachingKind = keyof typeof TEACHING_SFX;

/**
 * The teaching kinds' words as [most words, most characters]: what reads in the edit's hold on a
 * phone. Longer is dropped, never cut: a cut phrase says something else. The worker holds the same
 * numbers (layout.ts, PHRASE_LIMITS).
 */
export const PHRASE_LIMITS = {
    example: [4, 28], callout: [3, 24], step: [4, 28], term: [3, 24], meaning: [5, 32], side: [4, 26], takeaway: [5, 32],
} as const satisfies Record<string, readonly [number, number]>;

/** At most this many of a kind in one clip: one recap, and terms and contrasts kept rare enough to matter. */
export const KIND_CAP: Partial<Record<EditKind, number>> = { recap: 1, define: 2, compare: 2, step: 5 };

/** What the render gets: `t` in seconds on the clip's clock. */
export interface ClipEdit {
    t: number;
    kind: EditKind;
    text?: string;
    emoji?: string;
    /**
     * image, broll, example: one picture library topic (LIBRARY_TOPICS) — what the worker takes a
     * checked photo of (MONTEUR.md §6.2). Letters, digits and spaces, at most 40 characters.
     */
    query?: string;
    /** icon: one of ICON_NAMES, the line drawing the video draws on; its `text`, if any, is a 1–3 word label. */
    icon?: string;
    /** define: the term's plain meaning, at most 5 words (`text` is the term). */
    meaning?: string;
    /** compare: [the wrong or before, the right or after]; recap: its 2–3 takeaways. */
    items?: string[];
    sfx?: Exclude<EditSfx, 'none'>;
}

/** About one edit every 7 s, never more than this per clip. */
export const MAX_EDITS_PER_CLIP = 18;
export const EDITOR_MAX_OUTPUT = 8192;
export const EDITOR_THINKING = 1024;
/** The call's own ceiling; the sweep's deadline may cut it shorter. */
export const EDITOR_CALL_MS = 90_000;
const MAX_TEXT = 28;
/** An image's photo library query: at most this many characters, whole words. */
export const MAX_QUERY = 40;
/** Pictures (image, broll, example) take the worker a library search each: at most this many per clip. */
export const MAX_IMAGES_PER_CLIP = 4;
const PICTURE_KINDS: readonly EditKind[] = ['image', 'broll', 'example'];

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
                                text: str(`keyword: 2-4 words, at most ${MAX_TEXT} characters; tool: the tool's name in Latin script; example, callout, step: its label; define: the term`),
                                meaning: str('define: what the term means, at most 5 plain words'),
                                items: { type: 'ARRAY', items: { type: 'STRING' }, description: 'compare: [wrong or before, right or after]; recap: 2-3 takeaways' },
                                emoji: str('emoji: one emoji'),
                                // A plain string too, for the same reason: the icon names are in the prompt, and placeEdits keeps only those.
                                icon: str('icon: one name from the icon list, exactly as written'),
                                // A plain string: an 81-value enum here makes Gemini refuse the whole request (HTTP 400,
                                // 2026-09-27). The topics are in the prompt, and placeEdits keeps only those.
                                query: str('image, broll or example: one topic from the picture library list, exactly as written'),
                                sfx: { type: 'STRING', enum: [...EDIT_SFX] },
                            },
                            required: ['line', 'word', 'kind', 'sfx'],
                            propertyOrdering: ['line', 'word', 'kind', 'text', 'meaning', 'items', 'emoji', 'icon', 'query', 'sfx'],
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
    return `You are the editor of short vertical reels cut from a creator's screen-recorded lessons. Your edits help a viewer learn from the reel and keep watching. Answer with JSON only.
Teach, don't decorate (multimedia learning, on a phone):
- Show what he refers to: a real-world thing, an analogy, an example or a workplace situation outside the lesson gets an example.
- Guide the eye: while he demonstrates on screen, a callout points at what he is using.
- Segment a procedure into steps; pre-train a new term with a define; contrast two things with a compare; close with one recap.
- On time: each edit on the exact word it belongs to (the thing's name, the term, the step's first word).
- Redundancy: the captions already show every word he says, so on-screen words condense and never copy his.
- Coherence: every edit needs a reason in the clip; no reason, no edit.
For each clip, mark a moment about every 5 seconds (12 in a 60-second clip), each with its reason, none in its first second or last 3 seconds, each on a word from its lines. On-screen words are in ${lang}, tech terms in Latin script. The teaching kinds come first whenever the clip gives a reason:
- example: something outside the lesson he refers to. query: the library topic that shows it (none close: no example). text: a label, 1-4 words, e.g. «مثال: مطعم».
- callout: an arrow at the button, menu, field or result he is using on screen. text: its name as shown or said, 1-3 words, never «هنا».
- step: when he walks through a procedure, or lists things to do, add or set one after another, each one is a step as he starts it (2 or more), not a keyword. text: the step in 2-4 words. The video numbers them.
- define: a term he introduces. text: the term; meaning: what it means in at most 5 plain words.
- compare: two things he contrasts. items: [the wrong or before, the right or after], at most 4 words each.
- recap: once, on a word of the clip's last line (the video shows it before the CTA). items: the 2-3 takeaways the clip taught, at most 5 words each.
- keyword: 2-4 words that restate the point right then in other words than his, like a headline. Never the title again, never filler.
- tool: when the speaker names a tool or product (Gemini, ChatGPT, Claude, n8n, Python…), its name in Latin script; never one he doesn't name.
- emoji: one emoji for a concept being said (🔒 privacy, ⚡ speed, 🌍 language, 🐍 Python, 🧠 thinking, 📄 document, ✅ it works, ❌ a mistake, 🤯 a surprise, 💡 an idea); only from this set: 🔒🔓🔑🌍🌎🐍📄📝📋📚📖✅❌⚠🤯💡🧠⚡🤖🚀💻📱🔍🔎⚙🛠📈📉📊💰💸⏳⌛⏱📅💬🎯✨🔥🤩🤔😎🥳🎉🏆📦🧩🔗✉📧🎬🎥🎙🎧🖼🎨🧪🗂🗃💾☁🌐🏠🏢🛒🧾📌🍳🗺🧭🖥⌨🖱🖨💽🔌🔋🪫📡🛰🧮🗄📁📂📇🗒📎📏📐✂✏🖌📓🔖🏷📬📨📤📥📞☎🔔📢📣📻📺📹📷🎤🧰🔧🔨🧲🪜🏗🧱🏭🚚🏪💳🪙💎🎁🔐🗝🛡🚦🚧📍🔭🔬⏰❓❗💯🔄▶⭐🌟🆕🆓🚫🥇🦾🎓💼🪄🍽🛎☕🚗🌱🧯💭🎛🗑.
- icon: an animated line drawing of a concept or object when no photo fits and it's worth a picture (the video draws it on). icon: exactly one name from: ${ICON_NAMES.join(', ')}; text: an optional label, 1-3 words.
- image: a photo card for a concrete object he names in passing, never for an abstract idea. query: the closest library topic.
- broll: a full-screen photo cutaway for a bigger idea or a scene change, never while he demonstrates (the voice goes on). query: the closest library topic.
  At most 4 pictures per clip (example, image and broll together), each a different topic, and only of what he says.
  Picture library topics (query is exactly one of these): ${LIBRARY_TOPICS.join(', ')}.
- highlight: a ring on what he points at, when it needs no name.
- punch: a quick zoom-in when a result appears on screen or on a strong claim. At most 2 per clip.
sfx: whoosh for a keyword, tool, picture, example or recap; pop for an emoji, icon or step; click for a UI action, highlight or callout; ding for a result, ✅ or define; impact for a punch or a strong claim; glitch for a tech moment; error for a mistake, ❌ or compare; none when a sound would be too much.
Mix the kinds, icons included; never two of the same in a row, except steps and callouts. Invent nothing: only what the clip says.
Never a woman or a girl in any picture, emoji or sticker (the creator's rule); prefer objects and scenes to people.`;
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

/** A word as the redundancy check compares it: normalised, and without a leading و ف ب ل ك or ال while 3 letters are left. */
const stem = (w: string) => {
    const n = norm(w);
    const bare = n.replace(/^(?:و|ف)?(?:ب|ل|ك)?(?:ال)?/u, '');
    return bare.length >= 3 ? bare : n;
};

/**
 * True when `text` is, word for word, what the speaker says around `t` (1.5 s before to 2.5 s
 * after): the captions already show those words, so the same words again in an overlay is
 * redundancy, not signalling (MONTEUR.md §6.2).
 */
export function echoesSpeech(text: string, lines: readonly { words: TranscriptWord[] }[], t: number): boolean {
    const mine = text.split(/\s+/).map(stem).filter(Boolean);
    if (!mine.length) return false;
    const said = lines.flatMap((l) => l.words).filter((w) => w[0] >= t - 1.5 && w[0] <= t + 2.5).map((w) => stem(w[2])).filter(Boolean);
    for (let i = 0; i + mine.length <= said.length; i++) {
        if (mine.every((m, j) => said[i + j] === m)) return true;
    }
    return false;
}

const MARKS = /^[\s✗✓✔✘❌✅×•:.,،\-–—️]+|[\s✗✓✔✘❌✅×•:.,،\-–—️]+$/gu;

/**
 * A teaching kind's words: trimmed, one space between words, a leading or trailing ✗ ✓ or
 * punctuation stripped (the worker draws its own), within `limit` = [words, characters], else ''.
 */
export function phrase(raw: unknown, limit: readonly [number, number]): string {
    if (typeof raw !== 'string') return '';
    const s = raw.replace(/\s+/g, ' ').replace(MARKS, '').trim();
    if (!s || s.length > limit[1] || s.split(' ').length > limit[0]) return '';
    return s;
}

/** The phrases of an `items` list that fit `limit`, in order. */
const phrases = (raw: unknown, limit: readonly [number, number]) => (Array.isArray(raw) ? raw : []).map((v) => phrase(v, limit)).filter(Boolean);

/**
 * An image's query as the library gets it: Latin letters, digits and single spaces, whole words up
 * to 40 characters. Anything else — punctuation, another script — is a word break, so a query
 * with no English left is empty, and the image is dropped.
 */
function cleanQuery(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const topic = raw.trim().toLowerCase();
    if ((LIBRARY_TOPICS as readonly string[]).includes(topic)) return topic;
    let query = '';
    for (const word of raw.replace(/[^A-Za-z0-9 ]+/g, ' ').split(' ').filter(Boolean)) {
        const next = query ? `${query} ${word}` : word;
        if (next.length > MAX_QUERY) break;
        query = next;
    }
    return query;
}

/** The fields an edit of `kind` carries beyond t, kind and sfx, or null when what it needs is missing. */
function fieldsOf(kind: EditKind, e: Record<string, unknown>): Omit<ClipEdit, 't' | 'kind' | 'sfx'> | null {
    const text = typeof e.text === 'string' ? e.text.trim().slice(0, MAX_TEXT) : '';
    switch (kind) {
        case 'keyword': case 'tool': return text ? { text } : null;
        case 'emoji': {
            const emoji = typeof e.emoji === 'string' ? [...e.emoji.trim()].slice(0, 2).join('') : '';
            return emoji ? { emoji } : null;
        }
        case 'icon': {
            const icon = typeof e.icon === 'string' ? e.icon.trim().toLowerCase() : '';
            if (!(ICON_NAMES as readonly string[]).includes(icon)) return null;
            // The label is optional: one over a callout's limits (3 words, 24 characters) is dropped, the icon kept.
            const label = phrase(e.text, PHRASE_LIMITS.callout);
            return label ? { icon, text: label } : { icon };
        }
        case 'image': case 'broll': {
            const query = cleanQuery(e.query);
            return query ? { query } : null;
        }
        case 'example': {
            const query = cleanQuery(e.query);
            const label = phrase(e.text, PHRASE_LIMITS.example);
            return query && label ? { text: label, query } : null;
        }
        case 'callout': case 'step': {
            const label = phrase(e.text, PHRASE_LIMITS[kind]);
            return label ? { text: label } : null;
        }
        case 'define': {
            const term = phrase(e.text, PHRASE_LIMITS.term);
            const meaning = phrase(e.meaning, PHRASE_LIMITS.meaning);
            return term && meaning && norm(term) !== norm(meaning) ? { text: term, meaning } : null;
        }
        case 'compare': {
            // Exactly two sides: a third makes it a list, not a contrast.
            const sides = Array.isArray(e.items) && e.items.length === 2 ? phrases(e.items, PHRASE_LIMITS.side) : [];
            return sides.length === 2 && norm(sides[0]!) !== norm(sides[1]!) ? { items: sides } : null;
        }
        case 'recap': {
            const takeaways = phrases(e.items, PHRASE_LIMITS.takeaway).slice(0, 3);
            return takeaways.length >= 2 ? { items: takeaways } : null;
        }
        default: return {};
    }
}

/**
 * The model's edits for one clip, placed on the clip's clock: each lands on the start of its word
 * in its line (the first match, else the line's start); a recap with no such line takes the last
 * one, since the worker moves it to just before the CTA anyway. Dropped: unknown kinds, lines that
 * don't exist, an edit without what its kind needs (text, emoji, query, a define's meaning, a
 * compare's two sides, a recap's 2–3 takeaways), an icon not in ICON_NAMES, a teaching kind's words over
 * their limits, a keyword that repeats the words being said, a fifth picture, and a kind past its KIND_CAP. A lone
 * step becomes a keyword: one step is no procedure.
 * Spacing and the other limits are the renderer's (cleanEdits).
 */
export function placeEdits(raw: unknown, lines: readonly { t: number; words: TranscriptWord[] }[]): ClipEdit[] {
    const list = Array.isArray(raw) ? raw : [];
    const out: ClipEdit[] = [];
    for (const item of list) {
        const e = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const kind = e.kind as EditKind;
        if (!(EDIT_KINDS as readonly string[]).includes(kind)) continue;
        const n = typeof e.line === 'number' && Number.isInteger(e.line) ? e.line : 0;
        const line = lines[n - 1] ?? (kind === 'recap' ? lines[lines.length - 1] : undefined);
        if (!line) continue;
        const target = norm(typeof e.word === 'string' ? e.word : '');
        const hit = target ? line.words.find((w) => norm(w[2]) === target) ?? line.words.find((w) => norm(w[2]).includes(target)) : undefined;
        const t = Math.round((hit ? hit[0] : line.t) * 100) / 100;
        const fields = fieldsOf(kind, e);
        if (!fields) continue;
        if (kind === 'keyword' && echoesSpeech(fields.text!, lines, t)) continue;
        if (PICTURE_KINDS.includes(kind) && out.filter((o) => PICTURE_KINDS.includes(o.kind)).length >= MAX_IMAGES_PER_CLIP) continue;
        const cap = KIND_CAP[kind];
        if (cap !== undefined && out.filter((o) => o.kind === kind).length >= cap) continue;
        const said = (EDIT_SFX as readonly string[]).includes(e.sfx as string) && e.sfx !== 'none' ? (e.sfx as ClipEdit['sfx']) : undefined;
        const sfx = kind in TEACHING_SFX ? (e.sfx === 'none' ? undefined : TEACHING_SFX[kind as TeachingKind]) : said;
        out.push({ t, kind, ...fields, ...(sfx ? { sfx } : {}) });
        if (out.length === MAX_EDITS_PER_CLIP) break;
    }
    // One step is no procedure: a badge «1» with nothing after it promises steps that never come. It
    // stays as the headline it is, unless that repeats the words being said.
    const steps = out.filter((e) => e.kind === 'step');
    if (steps.length === 1) {
        const lone = steps[0]!;
        out.splice(out.indexOf(lone), 1);
        if (!echoesSpeech(lone.text!, lines, lone.t)) out.push({ t: lone.t, kind: 'keyword', text: lone.text!, ...(lone.sfx ? { sfx: 'whoosh' as const } : {}) });
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
 * failed Editor call must never hold a reel back. `think` sends the call to Claude on the Mac.
 */
export async function writeEdits(
    clips: readonly { start: number; end: number }[],
    lines: readonly TranscriptLine[],
    words: readonly TranscriptWord[],
    settings: StudioSettings,
    deadline: number,
    think?: ThinkOn,
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
        think: thinkRoute(think, 'monteur.edit', 'edit'),
    }, deadline, cost);
    return { edits: editsByClip(raw, perClip), cost };
}
