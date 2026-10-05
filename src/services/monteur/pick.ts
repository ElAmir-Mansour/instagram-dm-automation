/**
 * The Monteur (MONTEUR.md §6 and §6.1): one Gemini call reads a video's transcript and names the
 * moments most likely to spread, as ranges of lines, each with four sub-scores. One repair round
 * when the answer names lines that don't exist or cuts that can't be made; everything else about
 * the cut is code (transcript.ts).
 *
 * The prompt is short on purpose: the transcript is most of the tokens, and it is sent once, as
 * numbered lines. The rules are the research review's (§6.1). The creator's own evidence goes in
 * ahead of the transcript: the Analyst's lessons, and what their best and worst reels were about.
 */
import type { StudioLesson, StudioSettings, TranscriptWord } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import type { GeminiSchema, ModelTurn } from '../studio/generate.js';
import { languageKit } from '../studio/prompts.js';
import { ask, emptyCost, type CallCost } from './model.js';
import { evidenceLine, type ReelEvidenceSet } from './reelEvidence.js';
import { ThinkWaiting, thinkRoute, type ThinkOn } from './think.js';
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
An opening that only narrates the screen (هنا جينا، خلينا نفتح، كما نرى) is hook 0: start where the speaker says the point.
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

/** One reel per this many minutes of video, up to `reels_per_video` (the owner asked on 2026-10-06). */
export const MINUTES_PER_REEL = 10;

/**
 * How many reels to cut from a video: one per started 10 minutes of it, at least one, never more
 * than `reels_per_video`. A 5-minute lesson gives 1, an 11-minute one 2, a 33-minute one 3 (with
 * the maximum at 3). Unknown length: the maximum. Weak moments are still never kept, so this is a
 * ceiling, not a quota.
 */
export function reelsForLength(durationS: number | null | undefined, max: number): number {
    const cap = Math.max(1, Math.floor(max));
    if (typeof durationS !== 'number' || !Number.isFinite(durationS) || durationS <= 0) return cap;
    return Math.min(cap, Math.max(1, Math.ceil(durationS / (MINUTES_PER_REEL * 60))));
}

/** §6.1: `reels_per_video + 2` candidates. */
export function candidatesWanted(reelsPerVideo: number): number {
    return Math.max(1, reelsPerVideo) + EXTRA_CANDIDATES;
}

export function pickUserPrompt(args: {
    lines: readonly TranscriptLine[]; settings: StudioSettings; lessons: readonly StudioLesson[]; reels?: ReelEvidenceSet;
    /** How many reels this video gets (`reelsForLength`); `reels_per_video` when not given. */
    keep?: number;
}): string {
    const { lines, settings, lessons } = args;
    const m = settings.monteur;
    const keep = args.keep ?? m.reels_per_video;
    const avoid = (settings.voice?.avoid ?? []).filter((a) => a.trim());
    const best = args.reels?.best ?? [];
    const worst = args.reels?.worst ?? [];
    return [
        `Pick up to ${candidatesWanted(keep)} clips, best first, each ${m.min_seconds}–${m.max_seconds} seconds, none overlapping.`,
        // Past 90 s only a full walkthrough earns the length: watch time is what Facebook ranks on.
        ...(m.max_seconds > 90 ? [`Most clips should run about ${Math.max(m.min_seconds, 45)}–90 seconds; go up to ${m.max_seconds} only for a complete walkthrough that a shorter cut would leave unfinished.`] : []),
        // The audience's own vote: a moment on a topic that already spread scores higher on send.
        ...(best.length ? ['This creator\'s reels with the most views (90 days). A moment on a topic like these, or of the same kind, is worth more on send:', ...best.map(evidenceLine)] : []),
        ...(worst.length ? ['Their reels with the fewest views. Prefer other moments over ones like these:', ...worst.map(evidenceLine)] : []),
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
    /** Why proposed clips were not kept, as the repair round was told (empty when none were proposed or all were weak). */
    problems: string[];
    lines: TranscriptLine[];
    cost: CallCost;
}

/**
 * The clips for one source. A transcript with no words, or one shorter than the shortest clip,
 * has nothing to pick and costs no call. The repair round runs only when something needs
 * repairing and fewer clips than wanted survived. `think` sends both calls to Claude on the Mac.
 */
export async function pickClips(
    source: { words: readonly TranscriptWord[]; duration: number | null },
    settings: StudioSettings,
    context: { lessons: readonly StudioLesson[]; reels?: ReelEvidenceSet; existingTexts?: readonly string[] },
    deadline: number,
    think?: ThinkOn,
): Promise<PickOutcome> {
    const cost = emptyCost();
    const lines = groupLines(source.words);
    const m = settings.monteur;
    if (!lines.length || spokenSpan(lines) < m.min_seconds) return { kept: [], topic: null, considered: 0, problems: [], lines, cost };

    const keep = reelsForLength(source.duration, m.reels_per_video);
    const opts = {
        minSeconds: m.min_seconds, maxSeconds: m.max_seconds, keep, duration: source.duration,
        existingTexts: context.existingTexts ?? [],
    };
    const system = pickSystemPrompt(settings);
    const turns: ModelTurn[] = [{ role: 'user', text: pickUserPrompt({ lines, settings, lessons: context.lessons, reels: context.reels, keep }) }];
    const call = (purpose: string) => ask({
        purpose, system, turns, schema: PICK_SCHEMA, temperature: 0.4, thinkingBudget: PICK_THINKING,
        maxOutputTokens: PICK_MAX_OUTPUT, capMs: PICK_CALL_MS, think: thinkRoute(think, purpose, 'pick'),
    }, deadline, cost);

    const raw = await call('monteur.pick');
    let choice = chooseClips(raw, lines, source.words, opts);
    if (choice.problems.length && choice.kept.length < keep) {
        turns.push({ role: 'model', text: JSON.stringify(raw) }, { role: 'user', text: repairPrompt(choice.problems) });
        try {
            const again = chooseClips(await call('monteur.pick-repair'), lines, source.words, opts);
            if (again.kept.length > choice.kept.length) {
                choice = { ...again, topic: again.topic ?? choice.topic, considered: Math.max(again.considered, choice.considered) };
            }
        } catch (err) {
            // A repair still on the Mac is waited for, like any call; one that never came is not.
            if (err instanceof ThinkWaiting) throw err;
            // The first answer stands: a repair is an improvement, never a requirement.
            log('warn', 'monteur.pick_repair_failed', { message: err instanceof Error ? err.message : String(err) });
        }
    }
    return { kept: choice.kept, topic: choice.topic, considered: choice.considered, problems: choice.problems, lines, cost };
}
