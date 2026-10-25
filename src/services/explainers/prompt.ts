/**
 * What the writer is asked: the system prompt, the user prompt and the schema of its answer, for an illustrated explainer's script
 * (data-model.md §1, contracts/worker-jobs.md `explainer_write`, research.md R2). Pure: no database, no clock, no network. The same words go to
 * Claude on the owner's Mac (the job's `write` section) and to Gemini on the server (writerGemini.ts), so the two writers are held to one list of rules,
 * and `spec.ts` (`checkDraft`) checks the answer of either against the same limits the prompt states.
 *
 * What the prompt is for. The script is what makes these videos worth watching and what keeps them out of YouTube's "mass-produced" category, so it is
 * written to be right before it is written to be catchy: research first and primary sources only (FR-003), a fixed story (hook, the research story,
 * the explanation, the takeaway, a genuine closing question; FR-004), one drawable sentence per scene (FR-005), فصحى and never dialect (FR-006), no
 * woman or girl in any picture and no text in one (FR-013, FR-014), and the owner's rule that a post must survive expert comments (2026-10-13): the
 * likely objections are written down, with their answers, while the script is still open to being fixed.
 *
 * Every number the prompt states is read from `spec.ts` (`SCENE_BOUNDS`, `DURATION_RANGE_S`, `LIMITS`), never typed twice, and the schema is the
 * file `writerSchema.json`, which must stay byte-for-byte the contract's `writer-output.schema.json` and the worker's `explainerSchema.json`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExplainerLanguage, ExplainerLengthTier } from '../../db/rows.js';
import { dialectLine } from '../studio/infographicSpec.js';
import { DEFAULT_PACE, DURATION_RANGE_S, LIMITS, SCENE_BOUNDS } from './spec.js';

// ─── The schema ────────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * The answer's schema, as a file next to this one. The path is a LITERAL `path.join(__dirname, '…')`, the shape `src/index.ts` reads its pages with:
 * Vercel bundles a function by tracing file references statically, and a path assembled from a variable is not traced.
 */
export const WRITER_SCHEMA_FILE = path.join(__dirname, 'writerSchema.json');

let cachedSchema: Record<string, unknown> | null = null;

/**
 * The writer's answer schema (contracts/writer-output.schema.json), read on first use and not at import: a copy that cannot be read fails the
 * explainers that need it, and never the app's start. A fresh copy each time, so a caller that changes its own cannot change the next one's.
 */
export function writerSchema(): Record<string, unknown> {
    cachedSchema ??= JSON.parse(readFileSync(WRITER_SCHEMA_FILE, 'utf8')) as Record<string, unknown>;
    return structuredClone(cachedSchema);
}

// ─── The plan: how long, how many scenes ───────────────────────────────────────────────────────

/** Words in a sentence a scene is written in: short enough for one picture and for 3 to 6 seconds on screen. */
export const SENTENCE_WORDS = { min: 8, max: 16 } as const;
/** The average the writer is pointed at when it is told how many scenes to aim for. */
const AIM_WORDS_PER_SCENE = 11;

/** How a tier is said to the writer: as a length ("60-90 seconds") and as what it makes of a video ("a 60-90 second video"). */
const TIER_NAME: Readonly<Record<ExplainerLengthTier, string>> = { short: '60-90 seconds', medium: '3-5 minutes', long: '10-15 minutes' };
const TIER_ADJECTIVE: Readonly<Record<ExplainerLengthTier, string>> = { short: '60-90 second', medium: '3-5 minute', long: '10-15 minute' };

export interface WriterPlan {
    scenes_min: number;
    scenes_max: number;
    seconds_min: number;
    seconds_max: number;
    /** Words a second the narrator speaks: the settings' pace for the language, else the language's default. */
    pace: number;
    /** The spoken words that fill `seconds_min` to `seconds_max` at that pace. */
    words_min: number;
    words_max: number;
    /** About how many scenes make the middle of the range. */
    scenes_aim: number;
}

/**
 * The tier's bounds with the pace from the settings (`ExplainerWritePayload.bounds`, plus the words they come to). A pace that cannot be one
 * (zero, negative, not a number) is the language's default, as `estimateSeconds` treats it: the plan and the estimate must agree.
 */
export function writerPlan(tier: ExplainerLengthTier, language: ExplainerLanguage, pace?: number): WriterPlan {
    const perSecond = typeof pace === 'number' && Number.isFinite(pace) && pace > 0 ? pace : DEFAULT_PACE[language];
    const scenes = SCENE_BOUNDS[tier];
    const seconds = DURATION_RANGE_S[tier];
    const wordsMin = Math.round(seconds.min * perSecond);
    const wordsMax = Math.round(seconds.max * perSecond);
    const aim = Math.round((wordsMin + wordsMax) / 2 / AIM_WORDS_PER_SCENE);
    return {
        scenes_min: scenes.min, scenes_max: scenes.max, seconds_min: seconds.min, seconds_max: seconds.max, pace: perSecond,
        words_min: wordsMin, words_max: wordsMax, scenes_aim: Math.min(scenes.max, Math.max(scenes.min, aim)),
    };
}

// ─── The system prompt ─────────────────────────────────────────────────────────────────────────

/**
 * What a brief may never contain, said to the writer in both languages. `findFemaleSubject` (spec.ts) refuses a brief that has one of these words,
 * even in "no women", so the writer is told not to write them at all. The list is the guard's headline terms, not all of them: the rule is the point.
 */
export const FEMALE_WORDS_EN = 'woman, women, girl, lady, female, mother, wife, sister, daughter, she, her, princess';
export const FEMALE_WORDS_AR = 'امرأة، نساء، فتاة، بنت، سيدة، أم، زوجة، أخت، ابنة';

/** The words that ask for a comment, a reaction or a share: what the app refuses in the closing line and in every caption (spec.ts `engagementBait`). */
export const BAIT_EXAMPLES = '"comment YES", "type 1", "comment the word GUIDE", "tag a friend", "like if you agree", "share if you learned something", «اكتب نعم», «علّق بكلمة», «شارك إذا استفدت»';

function languageRules(language: ExplainerLanguage): string[] {
    if (language === 'ar') {
        return [
            'LANGUAGE: Modern Standard Arabic (العربية الفصحى)',
            '- Write `narration`, `label`, the title, the captions, the first comment and the replies in Modern Standard Arabic: correct grammar, clear, short and simple, as a good textbook would say it.',
            `- ${dialectLine('egyptian')} The creator's notes may be written in dialect: understand them and never copy their words.`,
            '- Keep the technical terms people say in English in Latin letters in `narration` and `label` (RAG, API, LLM, GPU).',
            '- `spoken` is what the narrator says: word for word the same sentence as `narration`, changed only where the voice needs help, because the subtitles are timed from it. Write every English word, name and acronym in Arabic letters the way an Arabic-speaking engineer says it (RAG → «راغ»، GPT → «جي بي تي»، API → «إيه بي آي»، Transformer → «ترانسفورمر»), and write symbols and abbreviations out. Keep digits as digits. Add no diacritics unless a word would be read wrongly without them.',
            '- Use Arabic punctuation (، ؛ ؟) and end every sentence with a full stop or a question mark.',
        ];
    }
    return [
        'LANGUAGE: English',
        '- Write in clear, plain English. Short words, no hype, and no jargon without its plain meaning.',
        '- `spoken` is what the narrator says: the same words as `narration`, with abbreviations and symbols written the way they are said ("vs." → "versus", "e.g." → "for example"). Keep digits as digits.',
    ];
}

/**
 * How the writer gets its facts. `research`: it has the web tools (Claude on the Mac: WebSearch and WebFetch) and must use them. `notes`: it has none, and
 * is handed the research notes and the numbered sources a first call made (Gemini on the server, writerGemini.ts).
 */
export type WriterMode = 'research' | 'notes';

/**
 * The research rules. With the tools they are MANDATORY and say so with the tool names (the owner's live test of the Mac writer, 2026-10-25: Claude
 * answered a factual question from memory unless it was told to search, and read the live registry when it was). Without them the notes are the whole
 * truth the writer may use.
 */
function researchRules(mode: WriterMode): string[] {
    const claims = 'Say only what a source says, with the conditions it states ("in this benchmark", "for models of this size"). No absolutes: not "always", "never", "only", "X is dead", "scientists proved". Say who found it, in which year, and what it depends on.';
    if (mode === 'notes') {
        return [
            'RESEARCH (already done for you)',
            '- The research notes and the numbered sources below are everything you may rely on. Use no fact, number, name, date or address that is not in them, and do not fill a gap from memory: when the notes do not back a claim, leave the claim out.',
            '- A source is one of the numbered sources, and nothing else. `source_ids` are those numbers (as numbered below), and `sources` lists the ones you cite, each copied exactly from the numbered list: title, authors or publisher, year and address. Never add a source and never change an address.',
            `- ${claims}`,
        ];
    }
    return [
        'RESEARCH IS MANDATORY: do it before you write anything',
        '1. Use WebSearch to find the primary sources for the topic: the paper that reported the result (arXiv, a journal, a conference), the standard or RFC, the official documentation, the maintainers\' or the company\'s own engineering write-up. If the first search does not find them, search again with other words.',
        '2. Open every page you mean to cite with WebFetch, and read the part you rely on, BEFORE you write the script. A search result\'s title or snippet is not a source, and neither is anything you remember.',
        '3. Cite only addresses you actually opened in this session. Never cite from memory. Never reconstruct a title, an author, a year, an address, a quote or a number from what you remember, even when you are sure of it. A fact you could not verify in a page you opened is left out of the script.',
        '4. The creator may give you links: open them first, and judge them like any other source.',
        '5. When the tools fail or nothing reliable can be found, say less, never more: write only what you verified, cite only what you opened, and keep `sources` short. Do not fill the gap from memory.',
        '- Prefer primary sources. A news article, a listicle, a social post, a vendor\'s benchmark and a paywalled page you cannot read are not sources. Wikipedia only helps you find the primary one.',
        `- ${claims}`,
    ];
}

/**
 * The system prompt: the job, the research rules, the story, the scenes and what each field holds, the captions, the likely replies, the picture rules and a
 * last check. `pace` is the settings' words a second for the language (`explainer.pace`); the rest comes from the tier. `mode` is how the writer gets its facts:
 * `research` (the default: it searches and reads the web itself) or `notes` (it is given what a first call found).
 */
export function writeSystemPrompt(language: ExplainerLanguage, tier: ExplainerLengthTier, pace?: number, mode: WriterMode = 'research'): string {
    const plan = writerPlan(tier, language, pace);
    return [
        mode === 'research'
            ? 'You write ONE narrated, illustrated explainer video for a creator\'s Instagram, Facebook, YouTube and TikTok, in the style of the Psych Toons channel: a calm narrator, one hand-painted still picture for every sentence with a hard cut between pictures, and one recurring cartoon character. You do four jobs in one answer: research the topic on the web, write the script, write the captions, and prepare the answers to the comments an expert will post.'
            : 'You write ONE narrated, illustrated explainer video for a creator\'s Instagram, Facebook, YouTube and TikTok, in the style of the Psych Toons channel: a calm narrator, one hand-painted still picture for every sentence with a hard cut between pictures, and one recurring cartoon character. You do three jobs in one answer, from the research notes you are given: write the script, write the captions, and prepare the answers to the comments an expert will post.',
        '',
        ...researchRules(mode),
        '',
        'THE STORY (the order is fixed)',
        '1. The hook: the first scene. One concrete sentence that makes the viewer want the next one: a surprising fact, a tension, a result from your research. No greeting, no "welcome", no "did you know", no channel introduction.',
        '2. The research story: who found what, when, and in which source: the researchers\' or the company\'s names, the year, what they did and what they saw. This is what makes the video worth watching and what lets a viewer trust it.',
        '3. The explanation, in plain steps: one idea per sentence, a small everyday example carried through if it helps (say it is an analogy). Explain a term the moment you use it.',
        '4. The takeaway: what to do or to remember, and the condition it depends on. One or two sentences.',
        '5. The closing question: the LAST scene, alone. A real question that asks the viewer for an opinion or an experience of their own, specific to the topic, ending in a question mark («؟» in Arabic). Never a request for a keyword, a number, an emoji, a like, a share, a tag or a follow: ' + BAIT_EXAMPLES + '. The app refuses a script, a caption or a comment that does.',
        '',
        'SCENES',
        `- One sentence per scene, ${SENTENCE_WORDS.min} to ${SENTENCE_WORDS.max} words (toward the short end in Arabic, where the narrator speaks about ${DEFAULT_PACE.ar} words a second: a picture should stay on screen 3 to 6 seconds), short and concrete enough to be drawn as one picture. \`narration\` is at most ${LIMITS.narration} characters. Write it the way a narrator speaks it: plain words, active voice, one idea, no parentheses, no lists, and no sentence that cannot be understood without the one before it.`,
        `- Length: ${plan.scenes_min} to ${plan.scenes_max} scenes, spoken in ${plan.seconds_min} to ${plan.seconds_max} seconds at ${plan.pace} words a second, which is ${plan.words_min} to ${plan.words_max} spoken words in all (a ${TIER_ADJECTIVE[tier]} video). Aim for about ${plan.scenes_aim} scenes and the middle of that range. Count as you write: a script outside the range is flagged to the creator.`,
        '- Every scene has:',
        `  narration: the sentence as shown on screen.`,
        `  spoken: what the narrator says (see the language rules; at most ${LIMITS.spoken} characters).`,
        `  label: the key word or short phrase of the sentence, at most ${LIMITS.labelWords} words, or a number (a year, a count, a percentage), as it appears on a tag over the picture, in the video's language. It is what the viewer remembers, not a shortened sentence. An empty string when nothing deserves a label (the closing question usually has none). Never more than ${LIMITS.labelWords} words.`,
        `  brief: the picture (see the picture rules; English; at most ${LIMITS.brief} characters).`,
        `  characters: the keys of the recurring characters in the picture, from the list you are given; at most ${LIMITS.characters}; [] for none. Use no key that is not in the list.`,
        '  continues: true when this sentence still belongs to the previous picture and a new one would add nothing (the same moment explained in two sentences). Never on the first scene, and at most one scene in six.',
        '  source_ids: the 0-based indexes in `sources` of the sources behind the sentence\'s factual claims; an empty list for a sentence that states no fact (a question, a transition, the takeaway\'s advice). EVERY sentence that states a fact (who found it, when, what they measured, how a thing works) cites at least one.',
        '',
        'SOURCES',
        '- `sources`: only the sources you used, each cited by at least one scene, primary ones first: { title, by (the authors or the publisher), year (as text, "2020"), url (the address of the page you opened) }. At least 3 for a 60-90 second video when they exist. Up to 20.',
        '',
        'PICTURES',
        `- A brief is ONE picture, as a still from a hand-painted picture book. Say who is in it (a recurring character by its key, such as karim, which you also list in \`characters\`), what the figure does (a pose or an action, never an abstract idea), where it is (the setting), the objects that carry the idea (a stack of papers, a magnifying glass, gears, a lock), and the composition (wide, close, from the side). Keep the top quarter of the frame calm and empty: the label goes there. Do not describe the art style (the app adds it). Vary the composition from one scene to the next.`,
        '- A scene about an idea with no person in it can be an object, a place or a diagram made of shapes.',
        `- NEVER a woman or a girl, in any picture. In a brief never write ${FEMALE_WORDS_EN} (or ${FEMALE_WORDS_AR}), not even to say "no women": the app refuses a brief that contains one. When the story is about a woman (a researcher, an author), show her work (a paper, a lab bench, a chart, an object) and never her. The people in a picture are only the recurring characters or men or faceless silhouettes, and never the face or likeness of a real, named person.`,
        '- No text of any kind in a picture: no letters, numbers, signs, logos, speech bubbles, labels or readable screens. A chart or a diagram is made of shapes and colours only. The label is added by the video, on top of the picture.',
        '',
        'CAPTIONS (all about THIS video, in the video\'s language)',
        `- title: the on-screen title, 5 to ${LIMITS.title} characters. It stays at the top of the vertical video all the way through, so it names the topic plainly.`,
        '- captions.meta (Instagram and Facebook): a hook line that names the topic; one to three short lines on what the viewer learns, naming each main idea in the order the video explains it; the closing question; then 4 to 6 hashtags on the last line. 300 to 1,000 characters. No links and no "link in bio" (the sources go in the first comment), and no request for a keyword, a comment, a like, a share or a follow.',
        '- captions.youtube.title: up to 100 characters, concrete and honest, with the words people search for, never a promise the video does not keep. captions.youtube.description: two or three sentences on what the video explains, then the sources (title, authors, year, address), then 3 to 5 hashtags. No request for likes, subscriptions or comments.',
        '- captions.tiktok: a short hook, the closing question and 3 to 5 hashtags, up to 300 characters.',
        '- first_comment: the word for "Sources" and then each source on its own line: its number, title, authors or publisher, year and address. Up to 1,500 characters.',
        '',
        'LIKELY REPLIES (the owner\'s rule: a post must survive expert comments)',
        '- Read your script, captions and sources as a senior practitioner or researcher in this field would, someone who builds or studies this every day and will comment if anything is off: an oversimplification, a missing condition, a newer result, "it depends on the setup", a different definition, a counter-example everyone knows. First fix every fixable point in the script itself. Then write 5 to 10 `replies`: the comments such an expert is most likely to post under the video (`q`, in their own words) and a short, friendly, correct answer to each (`a`) that agrees where they are right and shows why the video still holds, naming the source or the condition.',
        '',
        ...languageRules(language),
        '',
        'BEFORE YOU ANSWER, CHECK',
        '1. The first scene is the hook. The last scene is the closing question and nothing else. No request for a keyword, a comment, a like, a share, a tag or a follow anywhere: not in the script, the captions or the first comment.',
        mode === 'research'
            ? '2. Every sentence that states a fact has `source_ids`; every source is cited; every address in `sources` is a page you opened with WebFetch; no name, year, number or address comes from memory.'
            : '2. Every sentence that states a fact has `source_ids`; every source is cited and is one of the numbered sources; no name, year, number or address comes from memory.',
        '3. Every brief is in English, names its characters by key, has no text in the picture, and holds none of the forbidden words.',
        `4. Every label is at most ${LIMITS.labelWords} words or a number.`,
        '5. The scene count and the spoken word count are inside the ranges above.',
        '6. The title, the captions and the first comment are about this video; there are 5 to 10 replies.',
        'Answer with the JSON object of the schema and nothing else.',
    ].join('\n');
}

// ─── The user prompt ───────────────────────────────────────────────────────────────────────────

export interface WriterCharacter {
    key: string;
    name: string;
    description: string;
}

/** The part of the previous draft a rewrite is shown: what the owner saw, in the shape the writer answers in. */
export interface PreviousDraft {
    title: string | null;
    scenes: { narration: string; spoken: string; label: string; brief: string; characters: readonly string[]; continues: boolean }[];
    captions: { meta: string; youtube: { title: string; description: string }; tiktok: string } | null;
    first_comment: string | null;
    replies: readonly { q: string; a: string }[];
    sources: readonly { title: string; by: string; year: string; url: string }[];
}

export interface WriterRequest {
    topic: string;
    notes: string | null;
    language: ExplainerLanguage;
    tier: ExplainerLengthTier;
    /** The links the creator gave, to read first. */
    sourceLinks: readonly string[];
    characters: readonly WriterCharacter[];
    /** The art direction the pictures are drawn in, so a brief does not argue with it. */
    style: string;
    /** Words the creator's voice never uses (`voice.avoid`). */
    avoid?: readonly string[];
    /** `YYYY-MM-DD`: lets the writer say what is current and what is not. Left out of the prompt when not given. */
    today?: string;
    /** The owner's rewrite request, with the draft it is about. */
    rewriteNote?: string | null;
    previousDraft?: PreviousDraft | null;
}

/** The previous draft as the rewrite sees it: JSON, with nothing the writer did not write. */
function draftForPrompt(draft: PreviousDraft): string {
    return JSON.stringify({
        title: draft.title ?? '',
        scenes: draft.scenes.map((s) => ({
            narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: [...s.characters], continues: s.continues,
        })),
        ...(draft.captions ? { captions: draft.captions } : {}),
        first_comment: draft.first_comment ?? '',
        replies: draft.replies,
        sources: draft.sources,
    });
}

export function writeUserPrompt(req: WriterRequest): string {
    const plan = writerPlan(req.tier, req.language);
    const lines: string[] = [
        `Topic: ${req.topic.trim()}`,
        `Language: ${req.language === 'ar' ? 'Arabic (Modern Standard Arabic, الفصحى)' : 'English'}`,
        `Length: ${TIER_NAME[req.tier]}: ${plan.scenes_min} to ${plan.scenes_max} scenes.`,
    ];
    if (req.today) lines.push(`Today: ${req.today}`);
    if (req.notes?.trim()) lines.push('', `Notes from the creator (follow them):\n${req.notes.trim()}`);
    if (req.sourceLinks.length) lines.push('', `Links from the creator (read them first):\n${req.sourceLinks.map((url) => `- ${url}`).join('\n')}`);
    lines.push(
        '',
        req.characters.length
            ? `Recurring characters (use the key in a brief and in \`characters\`; use no other key):\n${req.characters.map((c) => `- ${c.key}: ${c.name}, ${c.description}`).join('\n')}`
            : 'Recurring characters: none yet. When a scene needs a person, describe a man or a faceless silhouette in the brief, and leave `characters` empty.',
        '',
        `Art direction the pictures are drawn in (for your information; never repeat it in a brief): ${req.style.trim()}`
    );
    if (req.avoid?.length) lines.push('', `Never use these words or topics: ${req.avoid.join(', ')}.`);
    if (req.rewriteNote?.trim() && req.previousDraft) {
        lines.push(
            '',
            `REWRITE REQUEST from the creator: ${req.rewriteNote.trim()}`,
            'The previous draft is below. Write a NEW, complete draft that follows the request. Keep what the request does not touch, but check every rule again, and keep the research honest: a source you did not read stays out.',
            `Previous draft:\n${draftForPrompt(req.previousDraft)}`
        );
    }
    return lines.join('\n');
}

/** What every writer is given: the prompts, the schema, and the bounds the answer is checked against. */
export interface WriterInputs {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    bounds: Pick<WriterPlan, 'scenes_min' | 'scenes_max' | 'seconds_min' | 'seconds_max' | 'pace'>;
}

/** The prompts, the schema and the bounds for one request, with the pace from the settings. `mode`: see `WriterMode`. */
export function buildWriterInputs(req: WriterRequest, pace?: number, mode: WriterMode = 'research'): WriterInputs {
    const plan = writerPlan(req.tier, req.language, pace);
    return {
        system: writeSystemPrompt(req.language, req.tier, pace, mode),
        user: writeUserPrompt(req),
        schema: writerSchema(),
        bounds: { scenes_min: plan.scenes_min, scenes_max: plan.scenes_max, seconds_min: plan.seconds_min, seconds_max: plan.seconds_max, pace: plan.pace },
    };
}
