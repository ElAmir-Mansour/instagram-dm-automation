/**
 * The voice arm (docs/specs/005-muse-sees US3, P3): a voice note is downloaded, decoded, heard by Meta's speech model, and its transcript is answered by the sales turn as
 * though the customer had typed it. The benchmark measures the PRODUCT's own transcription, so the arm runs `src/services/perception/transcribeVoice` and nothing of its
 * own: while that module is not in this checkout (P3 has not landed) the arm is skipped with a note, behind `--voice`.
 *
 * What the arm needs of that module, in one function (`TranscribeVoice`): the audio and what to listen for in, a status and a transcript out, with the time and the dollars
 * the call took. When P3 lands with another signature, `loadVoice` in `scripts/eval-muse.mts` is the one place that maps it onto this.
 *
 * What happens next is the pipeline's rule for a voice note (contracts/perception.md §2): a transcript of fewer than two words is not understood and the customer is asked to
 * send it again or type it; anything else is answered by the sales turn as the customer's own words, which go through the pre-filter as any typed message does.
 */
import { words } from '../../dmSales/prefilter.js';
import { resolveFixture } from '../../dmSales/__evals__/fixtures.js';
import { kitFor } from '../../profile/kits.js';
import { isAiError } from '../../llm/errors.js';
import {
    accepts, ACTION_WORDS, draftTurn, emptyInvented, finishDrafted, judgeUnderstood, oneLine, spent, type ArmDeps,
} from './arms.js';
import type { Perception } from '../types.js';
import { scrubKey } from './caller.js';
import type { LoadedMedia } from './cases.js';
import { wordErrorRate } from './metrics.js';
import type { ArmCaseResult, Failure, MuseCase } from './types.js';

export interface VoiceInput {
    caseId: string;
    bytes: Buffer;
    mime: string;
    /** What to listen for: the account's offer and brand names, longest first, at most twenty. */
    keywords: string[];
    language: 'Arabic' | 'English';
}

export interface VoiceHeard {
    status: 'ok' | 'unreadable' | 'failed';
    transcript: string;
    /** Milliseconds the module took: decoding and hearing. */
    ms: number;
    /** Dollars the speech call cost. */
    usd: number;
    reason?: string;
}

export type TranscribeVoice = (input: VoiceInput) => Promise<VoiceHeard>;

/** The most names the speech model is told to listen for (contracts/perception.md §2). */
export const MAX_KEYWORDS = 20;

/** The account's offer and brand names, once each, longest first, at most `MAX_KEYWORDS`: the words a dialect voice note is most likely to get wrong. */
export function keywordsFor(c: Pick<MuseCase, 'fixture'>): string[] {
    const fx = resolveFixture(c.fixture);
    const names = [...fx.ctx.offers.map((o) => o.name), fx.ctx.names.display_name.ar, fx.ctx.names.display_name.en, fx.ctx.names.brand_name].map((n) => n.trim()).filter(Boolean);
    return [...new Set(names)].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS);
}

/** A transcript shorter than this is not words to answer: the customer is asked to type, or send it again (contracts/perception.md §2). */
export const MIN_TRANSCRIPT_WORDS = 2;

export async function runVoiceCase(c: MuseCase, media: LoadedMedia, transcribe: TranscribeVoice, deps: ArmDeps): Promise<ArmCaseResult> {
    const fx = resolveFixture(c.fixture);
    const kit = kitFor(fx.ctx.language);
    const clock = deps.clock ?? (() => performance.now());
    deps.ledger.current = c.id;
    try {
        const started = clock();
        let heard: VoiceHeard;
        try {
            heard = await transcribe({ caseId: c.id, bytes: media.bytes, mime: media.mime, keywords: keywordsFor(c), language: kit.dm.schemaLanguage });
        } catch (err) {
            heard = { status: 'failed', transcript: '', ms: clock() - started, usd: 0, reason: isAiError(err) ? err.kind : scrubKey(err instanceof Error ? err.message : String(err)).slice(0, 80) };
        }
        const readMs = Math.max(clock() - started, heard.ms);
        const spoken = words(heard.transcript);
        const wer = c.reference ? wordErrorRate(words(c.reference), spoken) : null;
        const understood = judgeUnderstood(c.understood, { status: heard.status, reason: heard.reason as Perception['reason'], transcript: heard.transcript });
        const base = {
            arm: 'voice' as const, caseId: c.id, status: 'ran' as const, note: null, understood: understood.ok, understoodWhy: understood.why,
            seen: heard.status === 'ok' ? heard.transcript : null, judge: null as ArmCaseResult['judge'],
        };
        const failures: Failure[] = understood.ok ? [] : [{ caseId: c.id, arm: 'voice', what: 'understood', reason: oneLine(understood.why ?? '') }];
        const trace = heard.status === 'ok' ? `Heard the voice note${wer === null ? '' : `, word error rate ${wer.toFixed(2)} against what was said`}.` : `Could not hear it (${heard.status}${heard.reason ? `: ${heard.reason}` : ''}).`;

        if (heard.status !== 'ok' || spoken.length < MIN_TRANSCRIPT_WORDS) {
            const actionOk = accepts(c, 'resend');
            const why = `${ACTION_WORDS.resend}, because it could not be heard; expected ${c.expect.action.map((a) => ACTION_WORDS[a]).join(' or ')}`;
            if (!actionOk) failures.push({ caseId: c.id, arm: 'voice', what: 'action', reason: oneLine(why) });
            return {
                ...base, action: 'resend', actionOk, actionWhy: actionOk ? null : why, reply: kit.attachments.resend, trace, invented: emptyInvented(), failures, ms: readMs,
                ...spent(deps, c.id), usd: Math.round((spent(deps, c.id).usd + heard.usd) * 1e9) / 1e9,
            };
        }
        const outcome = await draftTurn(c, heard.transcript, undefined, deps);
        return finishDrafted(c, 'voice', base, failures, outcome, fx, readMs, deps, null, { trace, usd: heard.usd });
    } finally {
        deps.ledger.current = null;
    }
}
