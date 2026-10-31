/**
 * The arms that measure another PR's module (`--voice`, `--memory`): found in the checkout by the file being there, and wired by the benchmark's adapters.
 *
 * They are written as functions of the repository root, with the file system and the importer as arguments, so that a test can say what each does when the module is absent, is in
 * but is not what the benchmark expects, or is in and is run, without a file being added to the repository. `scripts/eval-muse.mts` calls them with the real root and nothing else.
 *
 * **Nothing is switched on by hand.** A module that is not there is a note ("recall.ts is not in this checkout yet") and the arm is skipped; the day its file is in the checkout, the
 * same command runs it. A module that is there and does not export what the adapter needs is a note that says which adapter to change, and never a guess. A module that is there and
 * breaks when it loads is an error, and is thrown (`loadOptional`): a half-merged file is not an absent one.
 */
import type { CliDeps } from './cli.js';
import { adaptRecall, type RecallModule } from './memory.js';
import { loadOptional } from './optional.js';
import { adaptVoice, decoderMissing, type AsrModule, type KeywordsModule, type VoiceModule } from './voice.js';

/** Where each module lives, from the repository root. The voice module has been called two things; the first of these that is in the checkout is used. */
export const VOICE_FILES = ['src/services/perception/voice', 'src/services/perception/transcribeVoice'] as const;
export const ASR_FILE = 'src/services/llm/metaAsr';
export const DECODER_FILE = 'src/services/perception/transcode';
export const KEYWORDS_FILE = 'src/services/perception/keywords';
export const RECALL_FILE = 'src/services/perception/recall';

/** The file system and the importer a test replaces (`loadOptional`'s own). */
export interface LoaderIo {
    exists?: (file: string) => boolean;
    importer?: (url: string) => Promise<unknown>;
}

/** The voice module, wired to the benchmark's Meta key, or why it is not there. */
export function voiceLoader(root: string, io: LoaderIo = {}): NonNullable<CliDeps['loadVoice']> {
    return async (keys) => {
        for (const rel of VOICE_FILES) {
            const voice = await loadOptional<VoiceModule>(root, rel, 'the voice notes', io);
            if (!voice.present) continue;
            const asr = await loadOptional<AsrModule>(root, ASR_FILE, 'the speech client', io);
            if (!asr.present) return { present: false, why: asr.why };
            if (typeof voice.module.transcribeVoice !== 'function' || typeof asr.module.callMetaAsr !== 'function' || typeof asr.module.asrUsd !== 'function') {
                return { present: false, why: `${rel}.ts is in, but it does not export transcribeVoice() and metaAsr.ts callMetaAsr() and asrUsd() as the benchmark expects: adapt voiceLoader in loaders.ts` };
            }
            // Found now, for nothing: a checkout without the decoder's package would count three voice notes as failures of the product.
            const decoder = await loadOptional<{ ffmpegBinary?: unknown }>(root, DECODER_FILE, 'the decoder', io);
            const missing = decoder.present ? await decoderMissing(decoder.module) : null;
            if (missing) return { present: false, why: missing };
            const names = await loadOptional<Partial<KeywordsModule>>(root, KEYWORDS_FILE, 'the names to listen for', io);
            const keywords = names.present && typeof names.module.voiceKeywords === 'function' ? { keywords: names.module as KeywordsModule } : {};
            return { present: true, value: adaptVoice(voice.module, asr.module, { apiKey: keys.meta!, ...keywords }) };
        }
        return { present: false, why: `${VOICE_FILES[0]}.ts is not in this checkout yet (the voice notes)` };
    };
}

/** The product's recall, wired, or why it is not there. Switches itself on when `recall.ts` is. */
export function recallLoader(root: string, io: LoaderIo = {}): NonNullable<CliDeps['loadRecall']> {
    return async (ledger) => {
        const recall = await loadOptional<RecallModule>(root, RECALL_FILE, 'the video memory\'s recall', io);
        if (!recall.present) return { present: false, why: recall.why };
        if (typeof recall.module.recallForTurn !== 'function') {
            return { present: false, why: `${RECALL_FILE}.ts is in, but it does not export recallForTurn() as the benchmark expects: adapt recallLoader in loaders.ts` };
        }
        return { present: true, value: adaptRecall(recall.module, { ledgerUsd: () => ledger.usdOf('recall') }) };
    };
}
