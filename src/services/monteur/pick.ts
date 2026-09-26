/**
 * The Monteur (MONTEUR.md §6.1): one Gemini call reads a video's transcript and names the moments
 * most likely to spread, as ranges of lines. One repair round when the answer names lines that
 * don't exist or cuts that don't fit; everything else about the cut is code (transcript.ts).
 *
 * The prompt is short on purpose: the transcript is most of the tokens, and it is sent once, as
 * numbered lines. The rubric is the plan's (docs/MONTEUR_PLAN.md §2.1); the creator's own lessons,
 * learnt by the Analyst from their past reels, come before the transcript.
 */
import type { StudioLesson, StudioSettings, TranscriptWord } from '../../db/rows.js';
import type { GeminiSchema, ModelTurn } from '../studio/generate.js';
import { languageKit } from '../studio/prompts.js';
import { log } from '../../utils/log.js';
import { ask, emptyCost, type CallCost } from './model.js';
import { chooseClips, formatLines, groupLines, MAX_TITLE, MIN_SCORE, type PickedClip, type TranscriptLine } from './transcript.js';

/** One call's ceiling. A long transcript with thinking takes 20–60 s. */
export const PICK_CALL_MS = 120_000;
const PICK_THINKING = 1024;
/** Thinking plus up to eight clips of about 80 tokens each, with room to spare. */
const PICK_MAX_OUTPUT = 4096;
/** More candidates than kept, so a dropped one (too short, overlapping) still leaves enough. */
const EXTRA_CANDIDATES = 2;
const MAX_CANDIDATES = 8;

export const PICK_SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        clips: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    start_line: { type: 'INTEGER', description: 'the n of the clip\'s first line, L<n>' },
                    end_line: { type: 'INTEGER', description: 'the n of its last line' },
                    title: { type: 'STRING', description: `the on-screen hook, at most 6 words and ${MAX_TITLE} characters` },
                    why: { type: 'STRING', description: 'one short sentence' },
                    score: { type: 'NUMBER', description: '0–10' },
                },
                required: ['start_line', 'end_line', 'title', 'why', 'score'],
                propertyOrdering: ['start_line', 'end_line', 'title', 'why', 'score'],
            },
        },
    },
    required: ['clips'],
    propertyOrdering: ['clips'],
};

export function pickSystemPrompt(settings: StudioSettings): string {
    const lang = languageKit(settings).name;
    const digits = settings.voice?.digits === 'arabic-indic' ? ' Arabic-Indic digits in titles.' : '';
    return `You are a short-form video editor. From a long video's transcript you pick the moments most likely to spread as standalone vertical reels. Answer with JSON only.
Score each clip 0-10:
- A hook in its first 3 seconds (a result, a number, a bold claim, a question) counts triple.
- It stands alone: no setup, no "as I said".
- One idea, with its payoff inside the clip.
- Surprise or emotion.
Never start a clip on a greeting or an introduction.
A clip is whole lines, start_line to end_line; its length runs from the start line's time to the end of the end line.
title: the on-screen hook in ${lang}, at most 6 words. It may state the payoff sharper than the speech.${digits}
why: one short ${lang} sentence on why it holds viewers.`;
}

/** How many candidates to ask for: a couple more than will be kept. */
export function candidatesWanted(reelsPerVideo: number): number {
    return Math.min(MAX_CANDIDATES, Math.max(1, reelsPerVideo) + EXTRA_CANDIDATES);
}

export function pickUserPrompt(args: {
    lines: readonly TranscriptLine[]; settings: StudioSettings; lessons: readonly StudioLesson[];
}): string {
    const { lines, settings, lessons } = args;
    const m = settings.monteur;
    const avoid = (settings.voice?.avoid ?? []).filter((a) => a.trim());
    return [
        `Pick up to ${candidatesWanted(m.reels_per_video)} clips, best first, each ${m.min_seconds}–${m.max_seconds} seconds, none overlapping. Only a clip scoring ${MIN_SCORE} or more is used.`,
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
    considered: number;
    lines: TranscriptLine[];
    cost: CallCost;
}

/**
 * The clips for one source. A transcript with no words has nothing to pick, and costs no call.
 * The repair round runs only when something needs repairing and fewer clips than wanted survived.
 */
export async function pickClips(
    source: { words: readonly TranscriptWord[]; duration: number | null },
    settings: StudioSettings,
    lessons: readonly StudioLesson[],
    deadline: number,
): Promise<PickOutcome> {
    const cost = emptyCost();
    const lines = groupLines(source.words);
    if (!lines.length) return { kept: [], considered: 0, lines, cost };

    const m = settings.monteur;
    const opts = { minSeconds: m.min_seconds, maxSeconds: m.max_seconds, keep: m.reels_per_video, duration: source.duration };
    const system = pickSystemPrompt(settings);
    const turns: ModelTurn[] = [{ role: 'user', text: pickUserPrompt({ lines, settings, lessons }) }];
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
            if (again.kept.length > choice.kept.length) choice = { ...again, considered: Math.max(again.considered, choice.considered) };
        } catch (err) {
            // The first answer stands: a repair is an improvement, never a requirement.
            log('warn', 'monteur.pick_repair_failed', { message: err instanceof Error ? err.message : String(err) });
        }
    }
    return { kept: choice.kept, considered: choice.considered, lines, cost };
}
