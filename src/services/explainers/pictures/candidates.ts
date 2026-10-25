/**
 * Character candidates (spec US2, FR-012; research.md R6): four pictures drawn from a character's description at 448×448, from which the owner
 * approves one as that character's reference, or uploads his own. 448 is under the 512×512 FLUX.2 klein takes a reference at, so an approved
 * candidate can always be sent back as one (draw.ts checks the size of every reference it sends).
 *
 * The four are drawn TOGETHER, and cost four pictures of the allowance: reserved in one reservation before the first call (the whole batch or none of
 * it, so four are never half reserved), settled after: the units of a draw that failed for an ordinary reason are given back, a draw the provider ended
 * with "used up" keeps its units and pauses drawing (allowance.ts). Holding no transaction and no pooled client: there is nothing to claim, only an
 * allowance to reserve and files to store.
 *
 * The guard is the one a scene has (prompt.ts): a description that names a woman or a girl, an empty one and one over 400 characters are refused with
 * 422 `EXPLAINER_PROMPT_REFUSED` BEFORE a provider is looked for, a setting is read or a unit is reserved.
 *
 * What comes back is the pictures that were drawn AND saved, even when fewer than four ("up to 4 candidate pictures", US2): the owner picks from what
 * there is. None at all is an error: 429 when the provider said its allowance is used up, 502 otherwise.
 *
 * The candidates are uploads of the tenant that nothing names until one is approved (Settings → Explainers keeps its `ref_media_id`). The ones he does
 * not approve are collected by the media sweep like any other upload nothing names.
 */
import { randomInt } from 'node:crypto';
import { log } from '../../../utils/log.js';
import { getMediaStore } from '../../storage.js';
import { ExplainerError } from '../errors.js';
import { markExhausted, pausedError, refundAllowance, reserveAllowance } from './allowance.js';
import { readLook } from './look.js';
import { buildCandidatePrompt, CANDIDATE_SIZE, refuseDescription } from './prompt.js';
import { getImageProvider } from './provider.js';
import { asProviderError, type DrawnPicture, type ImageProviderError } from './types.js';

/** Candidates drawn at once. */
export const CANDIDATE_COUNT = 4;

export interface Candidate {
    media_id: string;
    /** `/api/uploads/<media_id>`, on our own address. */
    url: string;
}

/** Four different seeds: two candidates with one seed are one picture twice. */
function distinctSeeds(count: number): number[] {
    const seeds = new Set<number>();
    while (seeds.size < count) seeds.add(randomInt(0, 2 ** 31));
    return [...seeds];
}

const extensionOf = (mime: string): string => (mime === 'image/png' ? 'png' : 'jpg');

export async function drawCandidates(args: { creatorId: string; description: string }): Promise<{ candidates: Candidate[] }> {
    const { creatorId } = args;
    // The guard first, with nothing read: the owner's own words, and a refusal costs nothing.
    const description = refuseDescription(args.description);

    const provider = await getImageProvider();
    if (!provider) {
        throw new ExplainerError('EXPLAINER_NO_PROVIDER', 'No image provider is set up. A platform admin adds the Cloudflare account and token in Settings → Platform → Explainers.');
    }
    const prompt = buildCandidatePrompt({ style: (await readLook(creatorId)).style, description });
    const store = await getMediaStore();

    // The whole batch, before the first call. Throws 429 EXPLAINER_ALLOWANCE_PAUSED when four do not fit.
    const reservation = await reserveAllowance(provider, CANDIDATE_COUNT);
    const started = Date.now();
    const settled = await Promise.allSettled(
        distinctSeeds(CANDIDATE_COUNT).map(async (seed) => provider.draw({ prompt, width: CANDIDATE_SIZE.width, height: CANDIDATE_SIZE.height, seed }))
    );

    const drawn: { index: number; picture: DrawnPicture }[] = [];
    let ordinaryFailures = 0;
    let exhausted = false;
    let firstFailure: ImageProviderError | null = null;
    settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            drawn.push({ index, picture: result.value });
            return;
        }
        const failure = asProviderError(result.reason, { creator_id: creatorId, candidate: index + 1 });
        log('warn', 'explainer.picture_failed', { creator_id: creatorId, candidate: index + 1, kind: failure.kind, status: failure.detail.status, code: failure.detail.code });
        if (failure.kind === 'ALLOWANCE_EXHAUSTED') exhausted = true;
        else ordinaryFailures++;
        firstFailure ??= failure;
    });

    // Settle the allowance: what failed for an ordinary reason was never drawn, so it is given back; what the provider refused as "used up" is kept.
    if (ordinaryFailures > 0) await refundAllowance(reservation, ordinaryFailures);
    const until = exhausted ? await markExhausted(provider.id) : null;

    // The files. A candidate that cannot be saved is lost with the units it cost: Cloudflare did draw it.
    const stored = await Promise.allSettled(drawn.map(({ index, picture }) => store.put({
        creatorId, filename: `explainer-candidate-${index + 1}.${extensionOf(picture.mime)}`, mimeType: picture.mime, data: picture.data,
    })));
    const candidates: Candidate[] = [];
    let unsaved: unknown = null;
    stored.forEach((result) => {
        if (result.status === 'fulfilled') candidates.push({ media_id: result.value.id, url: store.publicUrl(result.value.id, '') });
        else unsaved ??= result.reason;
    });

    log('info', 'explainer.candidates_drawn', {
        creator_id: creatorId, drawn: candidates.length, failed: CANDIDATE_COUNT - candidates.length, exhausted, ms: Date.now() - started,
    });

    if (candidates.length > 0) return { candidates };
    if (until) throw pausedError(until, 'exhausted', provider);
    if (drawn.length > 0) {
        const detail = unsaved instanceof Error ? unsaved.message : String(unsaved);
        throw new ExplainerError('EXPLAINER_PROVIDER_ERROR', `The pictures were drawn but could not be saved: ${detail.slice(0, 200)}`);
    }
    throw new ExplainerError('EXPLAINER_PROVIDER_ERROR', (firstFailure as ImageProviderError | null)?.message ?? 'The image provider drew nothing.');
}
