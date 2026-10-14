/**
 * The proof samples, W5 (docs/onboarding/03 §5, 02 §3; plan P25): two samples written by the production builders from the CONFIRMED
 * profile, judged by the tenant, and what their judgement becomes.
 *
 *   `readProof`         what W5 shows now: the cards that exist, and whether more could be made (no write, no model)
 *   `startProof`        make the cards that are missing: one round, on the `onboarding_proof` route, at most three rounds a UTC day
 *   `recordVerdict`     "Sounds like me", "Not quite", or the tenant's own wording
 *   `regenerateProof`   write one card again, with a hint (a chip, or the tenant's words), three tries at most
 *
 * ─── Which builders ─────────────────────────────────────────────────────────
 * The caption is written with the Studio writer's own prompt pieces (`buildCaptionSystemPrompt`: its kit, voice guide, facts, caption
 * steps, the tenant's save line and keyword ask) and finished by the writer's own normaliser (`normalizeInstagramCaption`). The comment
 * replies are written from the profile's `comment_reply` context and the register's own campaign wording (`kit.importFallback`), then
 * checked (`readCommentAnswer`: the link is the offer's and only ever put in by code, no link in a public reply, no stray placeholder,
 * Meta's 1,000 bytes). Both read the confirmed profile and nothing else: no draft, no scraped text.
 *
 * ─── What a verdict is ──────────────────────────────────────────────────────
 * `voice_examples` holds one row per sample. A verdict is `approved`, `edited` (with the tenant's own words) or `rejected`; the tenant's
 * sets `verdict_by = 'tenant'` and `tenant_confirmed_at`, an admin's sets `verdict_by = 'admin'` and leaves it empty, so a sample the
 * operator approved on the tenant's behalf is not used until the tenant says so. Approved and edited-and-confirmed rows reach the writer's
 * prompt (`voiceExamplesFor`) and, for the comment card, the first campaign (`complete`). A regenerate keeps the old sample as `rejected`.
 *
 * ─── No key, no problem ─────────────────────────────────────────────────────
 * With no AI provider the answer is `state: 'needs_ai_key'`, with nothing spent and no round counted, and the wizard says so and lets the
 * tenant carry on: nothing here is ever needed to finish. A failed call, a refusal and an answer that breaks a rule are `state: 'failed'`
 * with the failure's KIND (never a provider's words), also with nothing needed to carry on.
 *
 * Only while the wizard is open: a tenant whose onboarding is completed (the owner, every tenant that predates it) is refused
 * (`ONBOARDING_COMPLETED`), so nothing here can ever spend the operator's key for him or write him a row.
 */
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import { generate } from '../aiProviders/generate.js';
import { resolveRoute } from '../aiProviders/route.js';
import { isAiError } from '../llm/errors.js';
import type { GeminiSchema } from '../llm/geminiSchema.js';
import type { LlmTurn } from '../llm/types.js';
import { recordEvent, type Actor } from '../onboardingEvents.js';
import { loadOnboarding } from '../onboardingWizard.js';
import { contextFor, type ProfileContext } from '../profile/context.js';
import { kitFor } from '../profile/kits.js';
import { loadProfile } from '../profile/store.js';
import type { CreatorProfile, Offer } from '../profile/types.js';
import { UUID_PATTERN, withTransaction } from '../studio/common.js';
import { normalizeInstagramCaption } from '../studio/generate.js';
import { buildCaptionSystemPrompt } from '../studio/prompts.js';
import { CAPTION_LIMITS } from '../studio/rules.js';
import { getStudioSettings } from '../studio/settings.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { cleanKeyword, primaryOffer } from './proofCampaign.js';
import {
    buildCaptionUser, buildCommentSystem, buildCommentUser, CAPTION_PROOF_SCHEMA, commentProofSchema, type CommentBrief,
} from './proofPrompt.js';
import {
    cardOf, checkCaption, DM_MAX_BYTES, EDIT_MAX_CHARS, HINT_MAX_CHARS, isProofKind, isVerdict, MAX_ATTEMPTS, matchModeFor, PROOF_DEADLINE_MS, PROOF_KINDS, PROOF_MAX_TOKENS,
    PROOF_MIN_REPAIR_MS, PROOF_TIMEOUT_MS,
    PROOFS_PER_DAY, readCaptionAnswer, readCommentAnswer, readHint, readReasons, REGENERATIONS_PER_CARD, utf8Bytes,
    type Checked, type CommentAnswer, type Hint, type ProofCardId, type ProofKind, type ReasonCode, type Verdict,
} from './proofRules.js';
import {
    countRound, currentCards, insertProofRow, listProofRows, loadProofRow, writeVerdict, type ProofRow,
} from './proofStore.js';
import { stripInvisible } from './textClean.js';

// ─── Errors the routes answer with ──────────────────────────────────────────────────────────

export class ProofError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
        this.name = 'ProofError';
    }
}

/** An answer that came back and broke a rule twice: not a provider's failure, so it has its own kind. */
class UnusableAnswer extends Error {
    readonly kind = 'bad_output';
    constructor(message: string) {
        super(message);
        this.name = 'UnusableAnswer';
    }
}

// ─── What the page is told ──────────────────────────────────────────────────────────────────

export interface ProofCardView {
    id: string;
    card: ProofCardId;
    kind: ProofKind;
    /** What the tenant is judging: their own wording when they edited it, else what was written. */
    text: string;
    /** What was written, whatever was done to it since. */
    written: string;
    /** The post a caption was written beside (the tenant's own confirmed caption), or null. */
    original: string | null;
    /** The comment card: the word that triggers it, and the public replies. */
    keyword: string | null;
    publicReplies: string[];
    verdict: Verdict | null;
    verdictBy: 'tenant' | 'admin' | null;
    /** The tenant has said it themselves (`tenant_confirmed_at`). */
    confirmed: boolean;
    /** An admin judged it and the tenant has not confirmed yet: it is not used until they do. */
    waiting: boolean;
    reasons: ReasonCode[];
    attempt: number;
    canRegenerate: boolean;
}

/**
 * ready         both cards exist
 * empty         cards are missing and a provider could write them: the page asks for a round
 * needs_ai_key  cards are missing and no provider has a key: W5 says so, and Continue still completes
 * failed        a round was run and a card is still missing (`failure` says the kind)
 */
export type ProofState = 'ready' | 'empty' | 'needs_ai_key' | 'failed';

export interface ProofView {
    state: ProofState;
    cards: ProofCardView[];
    /** The kind of what failed (`timeout`, `refusal`, `budget`, `bad_output`…), never a provider's words; null unless `state` is `failed`. */
    failure: string | null;
    limits: { roundsPerDay: number; regenerations: number };
}

const LIMITS = Object.freeze({ roundsPerDay: PROOFS_PER_DAY, regenerations: REGENERATIONS_PER_CARD });

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function attemptOf(row: Pick<ProofRow, 'input'>): number {
    const n = isObj(row.input) ? Number(row.input.attempt) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= MAX_ATTEMPTS ? n : 1;
}

/** One row as the page sees it. Pure. The row is JSONB, so every part of `input` is checked. */
export function describeCard(row: ProofRow): ProofCardView {
    const input = isObj(row.input) ? row.input : {};
    const attempt = attemptOf(row);
    const confirmed = row.tenant_confirmed_at !== null && row.tenant_confirmed_at !== undefined;
    const source = isObj(input.source) && typeof input.source.text === 'string' ? input.source.text : null;
    const edited = row.verdict === 'edited' && typeof row.final_text === 'string' && row.final_text.trim() !== '';
    return {
        id: row.id,
        card: cardOf(row.kind),
        kind: row.kind,
        text: edited ? row.final_text! : row.model_output,
        written: row.model_output,
        original: source,
        keyword: row.kind === 'comment_dm' && typeof input.keyword === 'string' ? input.keyword : null,
        publicReplies: row.kind === 'comment_dm' ? strings(input.public_replies) : [],
        verdict: row.verdict,
        verdictBy: row.verdict_by,
        confirmed,
        waiting: row.verdict !== null && row.verdict_by === 'admin' && !confirmed,
        reasons: readReasons(input.reasons),
        attempt,
        canRegenerate: attempt < MAX_ATTEMPTS,
    };
}

const ORDER: readonly ProofKind[] = PROOF_KINDS;

function viewOf(cards: Map<ProofKind, ProofRow>, state: ProofState, failure: string | null = null): ProofView {
    return {
        state,
        cards: ORDER.flatMap((k) => (cards.has(k) ? [describeCard(cards.get(k)!)] : [])),
        failure: state === 'failed' ? failure : null,
        limits: LIMITS,
    };
}

// ─── The gate ───────────────────────────────────────────────────────────────────────────────

/**
 * The wizard is open: the tenant has an onboarding row that is not `completed`. A tenant with no row reads as completed (D14), and so does
 * every tenant that predates onboarding, the owner first: the proof is not theirs and writes nothing for them.
 */
async function assertOpen(creatorId: string): Promise<void> {
    const state = await loadOnboarding(creatorId);
    if (!state || state.status === 'completed') {
        throw new ProofError(409, 'ONBOARDING_COMPLETED', 'This tenant has finished onboarding. The sample replies are part of the setup wizard.');
    }
}

/** Is there a provider that could answer? `no_provider` is the one answer that is "no key", and it spends and counts nothing. */
async function hasProvider(creatorId: string): Promise<boolean> {
    try {
        await resolveRoute('onboarding_proof', creatorId);
        return true;
    } catch (err) {
        if (isAiError(err) && err.kind === 'no_provider') return false;
        throw err;
    }
}

// ─── What a sample is made from ─────────────────────────────────────────────────────────────

interface Material {
    profile: CreatorProfile;
    version: number | null;
    settings: StudioSettings;
    carousel: ProfileContext<'carousel'>;
    comment: ProfileContext<'comment_reply'>;
    offer: Offer | null;
}

/** The confirmed profile, the Studio's settings (its save line and keyword ask), and the two contexts the builders read. */
async function loadMaterial(creatorId: string): Promise<Material> {
    try {
        const loaded = await loadProfile(creatorId);
        if (loaded.newerSchema) throw new Error('the stored profile was written by a newer release');
        const settings = await getStudioSettings(creatorId);
        return {
            profile: loaded.profile, version: loaded.version, settings,
            carousel: contextFor(loaded.profile, 'carousel', loaded.version),
            comment: contextFor(loaded.profile, 'comment_reply', loaded.version),
            offer: primaryOffer(loaded.profile),
        };
    } catch (err) {
        log('warn', 'onboarding.proof_profile_unreadable', { creator_id: creatorId, ...describeError(err) });
        throw new ProofError(503, 'PROFILE_UNREADABLE', 'We could not read your profile just now. Please try again in a moment.');
    }
}

interface Made {
    input: Record<string, unknown>;
    output: string;
    model: string;
}

interface Previous {
    row: ProofRow;
    hint: Hint | null;
}

interface Ask<T> {
    system: string;
    user: string;
    schema: GeminiSchema;
    check: (json: unknown) => Checked<T>;
}

/**
 * One answer for the route, checked against the rules; when it breaks one, ONE more call with the problem stated (the Studio's repair
 * turn), so a model's bad day does not cost the tenant a round. Two calls at most per card per round. Whatever `generate` throws (no key,
 * a budget, a timeout…) is thrown as it is: nothing here retries a provider.
 */
async function askChecked<T>(creatorId: string, a: Ask<T>): Promise<{ value: T; model: string }> {
    const deadline = Date.now() + PROOF_DEADLINE_MS;
    const call = (user: string | LlmTurn[], timeoutMs: number) => generate({
        purpose: 'onboarding_proof', creatorId, system: a.system, user, schema: a.schema, maxTokens: PROOF_MAX_TOKENS, timeoutMs,
    });
    const first = await call(a.user, PROOF_TIMEOUT_MS);
    const checked = a.check(first.json);
    if (checked.ok) return { value: checked.value, model: first.model };
    const left = deadline - Date.now();
    // No time to ask again: the answer is unusable, and the tenant is told so rather than kept waiting.
    if (left < PROOF_MIN_REPAIR_MS) throw new UnusableAnswer(checked.problem);
    const second = await call([
        { role: 'user', text: a.user },
        { role: 'model', text: JSON.stringify(first.json) },
        { role: 'user', text: `That answer cannot be used: ${checked.problem} Answer again with the same schema, fixing only that.` },
    ], Math.min(PROOF_TIMEOUT_MS, left));
    const again = a.check(second.json);
    if (again.ok) return { value: again.value, model: second.model };
    throw new UnusableAnswer(again.problem);
}

/** The first keyword the offer fixes, or ''. */
const offerKeyword = (offer: Offer | null): string => cleanKeyword(offer?.keyword ?? '');

async function makeCaption(creatorId: string, m: Material, attempt: number, previous: Previous | null): Promise<Made> {
    const keyword = offerKeyword(m.offer);
    const samples = m.profile.voice.samples.filter((s) => typeof s === 'string' && s.trim() !== '');
    const prevSource = previous && isObj(previous.row.input.source) ? Number(previous.row.input.source.index) : NaN;
    // The same post for every try at one card (a regenerate keeps the beside-post the tenant was looking at); a new card starts at the first.
    const index = samples.length === 0 ? -1 : (Number.isInteger(prevSource) && prevSource >= 0 ? prevSource : 0) % samples.length;
    const original = index >= 0 ? samples[index]! : null;
    const wording = { language: m.carousel.language, who: m.carousel.who };
    const { value, model } = await askChecked<string>(creatorId, {
        system: buildCaptionSystemPrompt(m.settings, wording, { keyword }),
        user: buildCaptionUser({ original, offerName: m.offer?.name ?? '', previous: previous ? previous.row.model_output : null, hint: previous?.hint ?? null }),
        schema: CAPTION_PROOF_SCHEMA,
        check: (json) => {
            const answer = readCaptionAnswer(json);
            if (!answer.ok) return answer;
            // The writer's own normaliser: the tenant's exact keyword ask and save line, placed where production places them.
            const caption = normalizeInstagramCaption(answer.value, keyword || null, [], m.settings);
            const problem = checkCaption(caption, CAPTION_LIMITS.instagram);
            return problem ? { ok: false, problem } : { ok: true, value: caption };
        },
    });
    return {
        output: value, model,
        input: {
            card: 'caption', attempt, keyword: keyword || null,
            source: original === null ? null : { index, text: original },
            ...(previous?.hint ? { hint: previous.hint.code ?? previous.hint.note } : {}),
            ...(previous ? { replaces: previous.row.id } : {}),
        },
    };
}

function commentBrief(m: Material, offer: Offer, keyword: string, hasLink: boolean): CommentBrief {
    const { language } = m.comment;
    const kit = kitFor({ code: language.code, register: language.register });
    const name = offer.name.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    const identity = m.profile.identity;
    return {
        lang: language.code, register: language.register,
        creator: identity.brand_name.trim() || identity.display_name[language.code].trim() || identity.display_name.en.trim() || identity.display_name.ar.trim(),
        role: identity.role, niche: identity.niche,
        offer: { name, hasLink }, keyword,
        voice: { guide: m.profile.voice.guide, tone: m.profile.voice.tone, emoji: m.comment.voice.emoji, address: m.comment.voice.address },
        never: [...m.comment.guard.never_mention, ...m.comment.guard.custom_rules],
        example: { dm: kit.importFallback.dm.replace(/\{name\}/g, name), replies: kit.importFallback.replies.split(' | ') },
    };
}

async function makeComment(creatorId: string, m: Material, attempt: number, previous: Previous | null): Promise<Made> {
    const offer = m.offer!;
    const hasLink = offer.order_via === 'url' && offer.url.trim() !== '';
    const url = hasLink ? offer.url.trim() : '';
    // A regenerate keeps the keyword the first answer chose: the tenant has seen it, and it is not what they said was wrong.
    const kept = previous && isObj(previous.row.input) ? cleanKeyword(previous.row.input.keyword) : '';
    const fixed = kept || offerKeyword(offer);
    const brief = commentBrief(m, offer, fixed, hasLink);
    const previousAnswer = previous
        ? { dm: previous.row.model_output, publicReplies: strings(isObj(previous.row.input) ? previous.row.input.public_replies : []) }
        : null;
    const { value, model } = await askChecked<CommentAnswer>(creatorId, {
        system: buildCommentSystem(brief),
        user: buildCommentUser({ offerName: brief.offer.name, hasLink, previous: previousAnswer, hint: previous?.hint ?? null }),
        schema: commentProofSchema(fixed === ''),
        check: (json) => readCommentAnswer(json, { url, keyword: fixed }),
    });
    return {
        output: value.dm, model,
        input: {
            card: 'comment', attempt, offer: { id: offer.id, name: offer.name }, keyword: value.keyword, public_replies: value.publicReplies,
            match_mode: matchModeFor(value.keyword, m.profile.voice.samples),
            ...(previous?.hint ? { hint: previous.hint.code ?? previous.hint.note } : {}),
            ...(previous ? { replaces: previous.row.id } : {}),
        },
    };
}

const make = (kind: ProofKind, creatorId: string, m: Material, attempt: number, previous: Previous | null): Promise<Made> =>
    kind === 'caption' ? makeCaption(creatorId, m, attempt, previous) : makeComment(creatorId, m, attempt, previous);

/** The kind of a failure, for the page and the log: an AI error's own kind, `bad_output` for an answer that broke a rule, else `internal`. */
function failureKind(err: unknown): string {
    if (isAiError(err)) return err.kind;
    if (err instanceof UnusableAnswer) return err.kind;
    return 'internal';
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────────

/** What W5 shows now. Writes nothing and calls no model; asks the settings only whether a provider has a key, and only when cards are missing. */
export async function readProof(creatorId: string): Promise<ProofView> {
    await assertOpen(creatorId);
    const cards = currentCards(await listProofRows(pool, creatorId));
    if (isComplete(cards, true)) return viewOf(cards, 'ready');
    return viewOf(cards, (await hasProvider(creatorId)) ? 'empty' : 'needs_ai_key');
}

/** Both cards are there. `commentOwed` is false only for a profile with no offer (it cannot be activated, but it is not asked for a campaign). */
const isComplete = (cards: Map<ProofKind, ProofRow>, commentOwed: boolean): boolean =>
    PROOF_KINDS.every((k) => cards.has(k) || (k === 'comment_dm' && !commentOwed));

// ─── A round ────────────────────────────────────────────────────────────────────────────────

/**
 * Make the cards that are missing. Idempotent: with both cards there it answers them as they are, spends nothing and counts nothing, so a
 * page reload (or a second tab) is free. With no provider it answers `needs_ai_key` before counting. Otherwise it counts the round (the
 * day's limit is `PROOFS_PER_DAY`: a fourth is a 429), asks for each missing card in parallel, and keeps the ones that came back.
 */
export async function startProof(creatorId: string, actor: { userId: string | null; by: Actor }): Promise<ProofView> {
    await assertOpen(creatorId);
    const cards = currentCards(await listProofRows(pool, creatorId));
    const missing = PROOF_KINDS.filter((k) => !cards.has(k));
    if (missing.length === 0) return viewOf(cards, 'ready');
    if (!(await hasProvider(creatorId))) return viewOf(cards, 'needs_ai_key');

    if (!(await countRound(pool, creatorId, PROOFS_PER_DAY))) {
        throw new ProofError(429, 'PROOF_LIMIT', `Sample replies are limited to ${PROOFS_PER_DAY} rounds a day, and today's are used up. You can carry on without them.`, { limit: PROOFS_PER_DAY });
    }

    const material = await loadMaterial(creatorId);
    // A profile with no offer has nothing to write a campaign about: the comment card is not made (and not owed).
    const kinds = missing.filter((k) => k !== 'comment_dm' || material.offer !== null);
    const started = Date.now();
    const settled = await Promise.allSettled(kinds.map((k) => make(k, creatorId, material, 1, null)));
    let failure: string | null = null;
    let made = 0;
    for (const [i, result] of settled.entries()) {
        const kind = kinds[i]!;
        if (result.status === 'fulfilled') {
            const sample = result.value;
            cards.set(kind, await insertProofRow(pool, { creatorId, profileVersion: material.version, kind, input: sample.input, modelOutput: sample.output, model: sample.model }));
            made++;
        } else {
            failure ??= failureKind(result.reason);
            log('warn', 'onboarding.proof_card_failed', { creator_id: creatorId, card: cardOf(kind), outcome: failureKind(result.reason), ...(isAiError(result.reason) ? {} : describeError(result.reason)) });
        }
    }
    log('info', 'onboarding.proof_round', { creator_id: creatorId, by: actor.by, asked: kinds.length, made, elapsed_ms: Date.now() - started });
    return viewOf(cards, isComplete(cards, material.offer !== null) ? 'ready' : 'failed', failure);
}

// ─── A verdict ──────────────────────────────────────────────────────────────────────────────

export interface VerdictBody {
    verdict?: unknown;
    reasons?: unknown;
    edited_text?: unknown;
}

const clean = (raw: string): string => stripInvisible(raw).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Load the row of this tenant, which must be the CURRENT card of its kind: a sample that was regenerated is history. */
async function currentRow(creatorId: string, id: unknown): Promise<ProofRow> {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new ProofError(404, 'PROOF_NOT_FOUND', 'There is no such sample.');
    const row = await loadProofRow(pool, creatorId, id);
    if (!row || !isProofKind(row.kind)) throw new ProofError(404, 'PROOF_NOT_FOUND', 'There is no such sample.');
    const current = currentCards(await listProofRows(pool, creatorId)).get(row.kind);
    if (!current || current.id !== row.id) throw new ProofError(409, 'PROOF_NOT_CURRENT', 'This sample was replaced by a newer one.');
    return row;
}

/**
 * Record what the tenant (or an admin for them) said about a card. `edited` needs `edited_text`; an edit that changes nothing is an
 * approval. The reasons (the chips) are kept in `input.reasons`, replacing any earlier ones, so a later approval clears an earlier "too long".
 */
export async function recordVerdict(
    creatorId: string, id: unknown, body: VerdictBody, actor: { userId: string | null; by: Actor },
): Promise<{ card: ProofCardView }> {
    await assertOpen(creatorId);
    if (!isVerdict(body.verdict)) throw new ProofError(400, 'BAD_REQUEST', 'verdict must be "approved", "edited" or "rejected".');
    const row = await currentRow(creatorId, id);
    let verdict: Verdict = body.verdict;
    let finalText: string | null = null;
    if (verdict === 'edited') {
        if (typeof body.edited_text !== 'string' || clean(body.edited_text) === '') throw new ProofError(400, 'BAD_REQUEST', 'edited_text is the wording you want.');
        const text = clean(body.edited_text);
        if (Array.from(text).length > EDIT_MAX_CHARS) throw new ProofError(400, 'BAD_REQUEST', `edited_text is at most ${EDIT_MAX_CHARS} characters.`);
        if (row.kind === 'comment_dm') {
            if (utf8Bytes(text) > DM_MAX_BYTES) throw new ProofError(400, 'BAD_REQUEST', `A message is at most ${DM_MAX_BYTES} bytes (about 450 Arabic characters).`);
            if (/[{}]/.test(text.replace(/\{username\}/g, ''))) throw new ProofError(400, 'BAD_REQUEST', 'Only {username} can stand in for a follower\'s name.');
        }
        if (text === row.model_output.trim()) verdict = 'approved';
        else finalText = text;
    }
    const reasons = readReasons(body.reasons);
    const saved = await writeVerdict(pool, creatorId, row.id, { verdict, finalText, by: actor.by, input: { reasons } });
    if (!saved) throw new ProofError(404, 'PROOF_NOT_FOUND', 'There is no such sample.');
    await recordEvent({ creatorId, userId: actor.userId, actor: actor.by }, 'proof_verdict', 'proof', { kind: cardOf(row.kind), verdict, reason: reasons[0] });
    return { card: describeCard(saved) };
}

// ─── Writing a card again ───────────────────────────────────────────────────────────────────

export interface RegenerateResult {
    state: 'ready' | 'needs_ai_key' | 'failed';
    /** The new card when one was made. Absent otherwise: the card the tenant was looking at is unchanged. */
    card?: ProofCardView;
    failure: string | null;
    limits: ProofView['limits'];
}

/**
 * Write one card again, with a hint: one of the chips, or the tenant's own words (at most 200 characters). The call comes first; only when
 * it has answered is the old sample marked `rejected` and the new one inserted, in one transaction, so a failed call leaves the card as it
 * was. Three regenerations per card (`REGENERATIONS_PER_CARD`: the fourth is a 429); they are not rounds and do not count against the day's
 * three, the operator's budget (`ai.budget.tenant_daily_usd`) is what bounds them across a day.
 */
export async function regenerateProof(
    creatorId: string, id: unknown, body: { hint?: unknown }, actor: { userId: string | null; by: Actor },
): Promise<RegenerateResult> {
    await assertOpen(creatorId);
    if (body.hint !== undefined && body.hint !== null && typeof body.hint !== 'string') throw new ProofError(400, 'BAD_REQUEST', `hint is one of the chips, or up to ${HINT_MAX_CHARS} characters of your own.`);
    const row = await currentRow(creatorId, id);
    const attempt = attemptOf(row);
    if (attempt >= MAX_ATTEMPTS) {
        throw new ProofError(429, 'REGENERATE_LIMIT', `A sample can be written again ${REGENERATIONS_PER_CARD} times, and this one has been. You can edit it yourself.`, { limit: REGENERATIONS_PER_CARD });
    }
    if (!(await hasProvider(creatorId))) return { state: 'needs_ai_key', failure: null, limits: LIMITS };

    const material = await loadMaterial(creatorId);
    if (row.kind === 'comment_dm' && material.offer === null) throw new ProofError(409, 'NO_OFFER', 'There is no offer to write the replies about.');
    const hint = readHint(body.hint);
    let made: Made;
    try {
        made = await make(row.kind, creatorId, material, attempt + 1, { row, hint });
    } catch (err) {
        const kind = failureKind(err);
        log('warn', 'onboarding.proof_card_failed', { creator_id: creatorId, card: cardOf(row.kind), outcome: kind, regenerate: true, ...(isAiError(err) ? {} : describeError(err)) });
        return { state: 'failed', failure: kind, limits: LIMITS };
    }
    const reasons: ReasonCode[] = hint?.code ? [hint.code] : [];
    const created = await withTransaction(async (tx) => {
        // "A regenerate stores the old sample as rejected. Rejected samples are never used in prompts." (03 §5)
        await writeVerdict(tx, creatorId, row.id, { verdict: 'rejected', finalText: row.final_text, by: actor.by, input: { reasons } });
        return insertProofRow(tx, { creatorId, profileVersion: material.version, kind: row.kind, input: made.input, modelOutput: made.output, model: made.model });
    });
    await recordEvent({ creatorId, userId: actor.userId, actor: actor.by }, 'proof_regenerated', 'proof', { kind: cardOf(row.kind), attempt: attempt + 1 });
    return { state: 'ready', card: describeCard(created), failure: null, limits: LIMITS };
}

