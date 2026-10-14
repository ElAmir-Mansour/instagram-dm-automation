/**
 * A draft row as the API shows it, and the defensive readers of its JSON columns. Pure.
 *
 * Two audiences, one shape. The TENANT's wizard polls it every few seconds, so it carries what the screen needs and nothing that
 * is not the tenant's to see: ids and kinds of the sources (never their text: a scraped page may say anything, and the wizard
 * renders the checked draft, escaped), the checked draft, and for a failure a kind and a fixed sentence (a provider's own words may
 * name a key, a quota or a model the tenant has no business with). The ADMIN's screen also gets the provider's message, the steps
 * and calls with their `elapsed_ms`, and what the draft cost.
 *
 * The JSON columns were written by this engine, but they are read back across deploys and by whoever edits a row by hand, so each
 * reader checks what it needs and answers null for anything else rather than throwing in the middle of a wizard's poll.
 */
import { nextDraftStep, isAdvanceable, type StepRow } from './draftStep.js';
import type { AnswersColumn, CallRecord, DraftColumn, DraftRow, DraftView, FetchedBundle, ResultColumn, SourcesStatus, UsageLog, ViewAudience } from './draftTypes.js';
import { DRAFT_CALLS } from './draftSchema.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fetched bundle, or null when the column holds anything else (a draft that has not fetched, or one a newer release wrote). */
export function readBundle(value: unknown): FetchedBundle | null {
    if (!isObj(value) || value.version !== 1) return null;
    if (!Array.isArray(value.sources) || !Array.isArray(value.candidates) || !isObj(value.signals) || !isObj(value.facts)) return null;
    return value as unknown as FetchedBundle;
}

/** The `draft` column, if it holds one of the two shapes this engine writes. */
export function readColumn(value: unknown): DraftColumn | null {
    if (!isObj(value)) return null;
    if (value.stage === 'answers' && isObj(value.calls)) return value as unknown as AnswersColumn;
    if ((value.stage === 'final' || value.stage === 'prefill') && isObj(value.result) && isObj(value.code)) return value as unknown as ResultColumn;
    return null;
}

/** The answers drafted so far, one record per call (a call with nothing yet has an empty one). */
export function readAnswers(value: unknown): AnswersColumn['calls'] {
    const column = readColumn(value);
    const calls = column?.stage === 'answers' ? column.calls : null;
    const out = {} as AnswersColumn['calls'];
    for (const call of DRAFT_CALLS) {
        const rec: unknown = calls?.[call];
        if (!isObj(rec) || !Array.isArray(rec.errors)) {
            out[call] = { errors: [], gaveUp: false };
            continue;
        }
        out[call] = {
            ...(rec.answer !== undefined && rec.answer !== null ? { answer: rec.answer } : {}),
            errors: rec.errors as CallRecord['errors'],
            gaveUp: rec.gaveUp === true,
            ...(typeof rec.provider === 'string' ? { provider: rec.provider } : {}),
            ...(typeof rec.model === 'string' ? { model: rec.model } : {}),
        };
    }
    return out;
}

export function readSourcesStatus(value: unknown): SourcesStatus | null {
    return isObj(value) && isObj(value.instagram) && isObj(value.website) && isObj(value.youtube) && isObj(value.typed) ? (value as unknown as SourcesStatus) : null;
}

/**
 * What a tenant is shown of each source: its state, the road, why it gave nothing (a kind), whether a retry could help, how long it took and
 * what it counted. Not the message: it is for an operator and the log, and may say what the platform's own account or key did ("the platform's
 * API key was rejected"), which a tenant has no business with.
 */
export function forTenant(status: SourcesStatus | null): SourcesStatus | null {
    if (!status) return null;
    const one = (r: SourcesStatus['instagram']): SourcesStatus['instagram'] => ({ ...r, message: null });
    return { instagram: one(status.instagram), website: one(status.website), youtube: one(status.youtube), typed: one(status.typed) };
}

export function readUsage(value: unknown): UsageLog | null {
    return isObj(value) && Array.isArray(value.steps) && Array.isArray(value.calls) && isObj(value.totals) ? (value as unknown as UsageLog) : null;
}

/** What `nextDraftStep` needs from a row. */
export const stepRowOf = (row: DraftRow): StepRow => ({
    status: row.status,
    attempts: row.attempts,
    created_at: row.created_at,
    next_attempt_at: row.next_attempt_at,
    lease_until: row.lease_until,
    lease_owner: row.lease_owner,
    hasSources: readBundle(row.sources) !== null,
});

/**
 * What a tenant is told when a draft fails: fixed sentences, by kind. The wizard shows its own words (and in the tenant's language)
 * for each kind; these are the fallback, and the whole of what leaves the building about a provider.
 */
export const TENANT_ERROR_TEXT: Readonly<Record<string, string>> = {
    no_provider: 'Drafting needs an AI key, and none is set up yet. You can fill this in yourself, and your operator can add a key.',
    auth: 'The assistant could not be reached with the key that is set up. You can fill this in yourself.',
    quota: 'The AI account has run out of credit. You can fill this in yourself.',
    budget: 'The daily AI budget is used up. You can fill this in yourself, or try again tomorrow.',
    rate: 'The AI service is busy. Try again in a little while, or fill this in yourself.',
    server: 'The AI service had a problem. Try again in a little while, or fill this in yourself.',
    timeout: 'The AI service took too long. Try again, or fill this in yourself.',
    refusal: 'The assistant could not draft this one. You can fill it in yourself.',
    max_tokens: 'The draft was too long for the assistant to finish. You can fill this in yourself.',
    bad_output: 'The assistant gave an answer that could not be used. Try again, or fill this in yourself.',
    bad_request: 'The draft could not be made. You can fill this in yourself.',
    no_source: 'Nothing could be read from what was given. Check the handle and the website, or paste a few lines about yourself.',
    expired: 'The draft took too long and was stopped. Try again, or fill this in yourself.',
    abandoned: 'The draft was interrupted too many times. Try again, or fill this in yourself.',
    internal: 'Something went wrong on our side. Try again, or fill this in yourself.',
};

const GENERIC_TENANT_ERROR = 'The draft could not be made. You can fill this in yourself.';

export interface ViewOptions {
    audience: ViewAudience;
    nowMs: number;
}

export function toDraftView(row: DraftRow, { audience, nowMs }: ViewOptions): DraftView {
    const step = nextDraftStep(stepRowOf(row), nowMs);
    const active = row.status === 'queued' || row.status === 'fetching' || row.status === 'drafting';
    const bundle = readBundle(row.sources);
    const column = readColumn(row.draft);
    const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

    let draft: DraftView['draft'] = null;
    let prefill: DraftView['prefill'] = null;
    if (column && column.stage === 'final' && row.status === 'ready') draft = { ...column.result, code: column.code, models: column.models };
    if (column && column.stage === 'prefill' && row.status === 'failed') prefill = { ...column.result, code: column.code };

    // What the last try said while the draft is still being retried, or what ended it.
    let error: DraftView['error'] = null;
    if (row.error_kind) {
        error = { kind: row.error_kind, message: audience === 'admin' ? (row.error ?? '') : (TENANT_ERROR_TEXT[row.error_kind] ?? GENERIC_TENANT_ERROR) };
    }

    const view: DraftView = {
        id: row.id,
        status: row.status,
        origin: row.origin,
        attempts: row.attempts,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        finishedAt: iso(row.finished_at),
        advanceable: isAdvanceable(step),
        working: active && step.kind === 'wait' && step.why === 'leased',
        retryAt: active && row.next_attempt_at && row.next_attempt_at.getTime() > nowMs ? row.next_attempt_at.toISOString() : null,
        partial: row.partial === true,
        error,
        needsAiKey: row.status === 'failed' && row.error_kind === 'no_provider',
        inputs: {
            instagram: row.inputs?.instagram ?? null, website: row.inputs?.website ?? null, youtube: row.inputs?.youtube ?? null,
            hasAbout: Boolean(row.inputs?.about), via: row.inputs?.via ?? 'discovery',
        },
        sourcesStatus: audience === 'admin' ? readSourcesStatus(row.sources_status) : forTenant(readSourcesStatus(row.sources_status)),
        sources: bundle ? bundle.sources.map((s) => ({ id: s.id, kind: s.kind })) : [],
        draft,
        prefill,
    };
    if (audience === 'admin') view.usage = readUsage(row.usage);
    return view;
}
