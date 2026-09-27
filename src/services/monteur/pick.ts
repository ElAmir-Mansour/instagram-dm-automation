/**
 * The Monteur (MONTEUR.md §6 and §6.1): one Gemini call reads a video's transcript and names the
 * moments most likely to spread, as ranges of lines, each with four sub-scores. One repair round
 * when the answer names lines that don't exist or cuts that can't be made; everything else about
 * the cut is code (transcript.ts).
 *
 * The prompt is short on purpose: the transcript is most of the tokens, and it is sent once, as
 * numbered lines. The rules are the research review's (§6.1). The creator's own evidence goes in
 * ahead of the transcript: the Analyst's lessons, and the openings of their two most-viewed posts.
 */
import type { StudioLesson, StudioSettings, TranscriptWord } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import type { GeminiSchema, ModelTurn } from '../studio/generate.js';
import { languageKit } from '../studio/prompts.js';
import { ask, emptyCost, type CallCost } from './model.js';
import {
    chooseClips, formatLines, groupLines, HOOK_TYPES, MAX_TITLE, spokenSpan, type PickedClip, type TranscriptLine,
} from './transcript.js';

/** One call's ceiling. A long transcript with thinking takes 20–60 s. */
export const PICK_CALL_MS = 120_000;
const PICK_THINKING = 1024;
/**
 * Thinking counts toward the cap, and Gemini treats the thinking budget as advice: a cap just
 * above it cuts the JSON off (finishReason MAX_TOKENS) and fails the whole attempt.
 */
export const PICK_MAX_OUTPUT = 8192;
/** §6.1: more candidates than kept, so a dropped one (too short, overlapping) still leaves enough. */
const EXTRA_CANDIDATES = 2;

const score = (description: string): GeminiSchema => ({ type: 'INTEGER', description });

export const PICK_SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        topic: { type: 'STRING', description: 'the video\'s main idea, one line' },
        clips: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    start_line: { type: 'INTEGER', description: 'the n of the clip\'s first line, L<n>' },
                    end_line: { type: 'INTEGER', description: 'the n of the line where the payoff is complete' },
                    title: { type: 'STRING', description: `at most 6 words and ${MAX_TITLE} characters` },
                    hook_type: { type: 'STRING', enum: [...HOOK_TYPES] },
                    why: { type: 'STRING', description: 'at most 10 words' },
                    scores: {
                        type: 'OBJECT',
                        properties: {
                            hook: score('0–3'), alone: score('0–3'), payoff: score('0–3'), send: score('0–3'),
                        },
                        required: ['hook', 'alone', 'payoff', 'send'],
                        propertyOrdering: ['hook', 'alone', 'payoff', 'send'],
                    },
                },
                required: ['start_line', 'end_line', 'title', 'hook_type', 'why', 'scores'],
                // `why` before `scores`: the model says what the viewer gets, then scores it.
                propertyOrdering: ['start_line', 'end_line', 'title', 'hook_type', 'why', 'scores'],
            },
        },
    },
    required: ['topic', 'clips'],
    propertyOrdering: ['topic', 'clips'],
};

export function pickSystemPrompt(settings: StudioSettings): string {
    const lang = languageKit(settings).name;
    const digits = settings.voice?.digits === 'arabic-indic' ? ' Arabic-Indic digits.' : '';
    return `You are a short-form video editor. From a long video's transcript you pick the moments most likely to spread as standalone vertical reels. Answer with JSON only.
topic: first, the video's main idea in one line.
Score each clip 0-3:
- hook: 3 = its first sentence states the result, number, mistake or contrast; 2 = its first line has it after a lead-in; 1 = it comes in line 2; 0 = later or never.
- alone: its start needs nothing said before it (no greeting, no intro, no «زي ما قلت / وبعدين / فـ») and its end leaves nothing hanging.
- payoff: it holds the answer or demonstration that proves the claim. Start on the claim; end_line is where the payoff is complete.
- send: worth sending to a colleague: a tool, a prompt, a step, a number or a surprise. Motivation alone is 0.
NEVER a clip where the speaker asks for comments, or one that repeats another clip's idea.
START: of the idea's first 3 lines, the one that states the claim. LENGTH: the shortest span that holds the whole payoff. Never pad.
title: at most 6 words in ${lang}, on screen from frame 0 and read with the sound off: the concrete topic plus the result, problem or mistake, not the method. Not the first spoken sentence. Tech terms in Latin script, no hype words.${digits}
hook_type: how the spoken start line opens: promise, problem, intent or question.
why: at most 10 words in ${lang}: what the viewer gets.
Invent nothing: only numbers, tools and results the clip says.`;
}

/** §6.1: `reels_per_video + 2` candidates. */
export function candidatesWanted(reelsPerVideo: number): number {
    return Math.max(1, reelsPerVideo) + EXTRA_CANDIDATES;
}

export function pickUserPrompt(args: {
    lines: readonly TranscriptLine[]; settings: StudioSettings; lessons: readonly StudioLesson[]; examples?: readonly string[];
}): string {
    const { lines, settings, lessons } = args;
    const m = settings.monteur;
    const avoid = (settings.voice?.avoid ?? []).filter((a) => a.trim());
    const examples = (args.examples ?? []).filter((e) => e.trim()).slice(0, 2);
    return [
        `Pick up to ${candidatesWanted(m.reels_per_video)} clips, best first, each ${m.min_seconds}–${m.max_seconds} seconds, none overlapping.`,
        ...(examples.length ? ['Openings of this creator\'s most-viewed posts:', ...examples.map((e) => `- ${e}`)] : []),
        ...(lessons.length ? ['Lessons from this creator\'s past reels:', ...lessons.map((l) => `- ${l.rule}`)] : []),
        ...(avoid.length ? [`Never pick a moment about: ${avoid.join(', ')}.`] : []),
        `Transcript (${languageKit(settings).name}):`,
        formatLines(lines),
    ].join('\n');
}

function repairPrompt(problems: readonly string[]): string {
    return [
        'Some of those clips can\'t be used. Fix them and return every clip again, in the same schema:',
        ...problems.slice(0, 12).map((p) => `- ${p}`),
    ].join('\n');
}

export interface PickOutcome {
    kept: PickedClip[];
    topic: string | null;
    considered: number;
    lines: TranscriptLine[];
    cost: CallCost;
}

/**
 * The clips for one source. A transcript with no words, or one shorter than the shortest clip,
 * has nothing to pick and costs no call. The repair round runs only when something needs
 * repairing and fewer clips than wanted survived.
 */
export async function pickClips(
    source: { words: readonly TranscriptWord[]; duration: number | null },
    settings: StudioSettings,
    context: { lessons: readonly StudioLesson[]; examples?: readonly string[]; existingTexts?: readonly string[] },
    deadline: number,
): Promise<PickOutcome> {
    const cost = emptyCost();
    const lines = groupLines(source.words);
    const m = settings.monteur;
    if (!lines.length || spokenSpan(lines) < m.min_seconds) return { kept: [], topic: null, considered: 0, lines, cost };

    const opts = {
        minSeconds: m.min_seconds, maxSeconds: m.max_seconds, keep: m.reels_per_video, duration: source.duration,
        existingTexts: context.existingTexts ?? [],
    };
    const system = pickSystemPrompt(settings);
    const turns: ModelTurn[] = [{ role: 'user', text: pickUserPrompt({ lines, settings, lessons: context.lessons, examples: context.examples }) }];
    const call = (purpose: string) => ask({
        purpose, system, turns, schema: PICK_SCHEMA, temperature: 0.4, thinkingBudget: PICK_THINKING,
        maxOutputTokens: PICK_MAX_OUTPUT, capMs: PICK_CALL_MS,
    }, deadline, cost);

    const raw = await call('monteur.pick');
    let choice = chooseClips(raw, lines, source.words, opts);
    if (choice.problems.length && choice.kept.length < m.reels_per_video) {
        turns.push({ role: 'model', text: JSON.stringify(raw) }, { role: 'user', text: repairPrompt(choice.problems) });
        try {
            const again = chooseClips(await call('monteur.pick-repair'), lines, source.words, opts);
            if (again.kept.length > choice.kept.length) {
                choice = { ...again, topic: again.topic ?? choice.topic, considered: Math.max(again.considered, choice.considered) };
            }
        } catch (err) {
            // The first answer stands: a repair is an improvement, never a requirement.
            log('warn', 'monteur.pick_repair_failed', { message: err instanceof Error ? err.message : String(err) });
        }
    }
    return { kept: choice.kept, topic: choice.topic, considered: choice.considered, lines, cost };
}
