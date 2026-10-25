/**
 * The DM reply engine (docs/DM_SALES_PLAN.md S3): who writes the answer to a direct message, chosen per tenant in AI settings.
 *
 *   `gemini`     (the default) `generateAiResponse`, the call the bot has always made, untouched: the same request, byte for byte.
 *   `providers`  `generateDmViaLayer`: the same persona, knowledge base, rules, history window and reply coercion, written through
 *                the AI providers layer (`generate`, purpose `dm`), so the operator's route, budgets and `ai_usage` apply.
 *
 * `generateDmReply` is the one dispatch the DM pipeline and the dashboard's sandbox both call. It reads the engine, runs it and
 * applies the failure policy, which is the owner's (2026-10-14):
 *
 *   - A `gemini` engine is exactly today's: an error is thrown to the caller, whose retry rules (src/webhook/messaging.ts) are unchanged.
 *   - A `providers` engine that fails for any reason (no key, no route, a provider outage, a timeout, a refused budget, an answer with no
 *     usable text) is answered with today's Gemini path ONCE when `gemini_fallback` is on. With the fallback off, or with Gemini failing
 *     too, the result is `{ kind: 'handoff' }`, and `dm.engine_failed` says why. Never two replies: the fallback runs only while no reply
 *     exists, before anything is sent.
 *
 * The pipeline answers a handoff with `handoffAfterFailure` (S8): the thread is stamped, the customer gets the handoff line, the owner is told.
 *
 * Nothing here sends a message or writes a row. The pipeline (`messaging.ts`) owns the send, the quota and the claim.
 */
import { queryOne, queryRows } from '../db/query.js';
import type { AiAgentRow, MessageRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import {
    coerceAiResponse, decideAgent, dmResponseSchema, dmSystemInstruction, enforceMetaConstraints, generateAiResponse, HISTORY_WINDOW,
    type AiResponse, type DmContext,
} from './ai.js';
import { generate } from './aiProviders/generate.js';
import { EVAL } from './aiProviders/purposes.js';
import { isAiError, scrub } from './llm/errors.js';
import type { LlmSchema } from './llm/schema.js';
import type { LlmTurn } from './llm/types.js';
import { profileContextOrLegacy } from './profile/context.js';

// ─── The setting ─────────────────────────────────────────────────────────────────────────────────

export const DM_ENGINES = ['gemini', 'providers'] as const;
export type DmEngine = (typeof DM_ENGINES)[number];

export const isDmEngine = (value: unknown): value is DmEngine => typeof value === 'string' && (DM_ENGINES as readonly string[]).includes(value);

/** What a row that says nothing means, and what the column defaults to (`migration_v37_dm_engine.sql`): today's behaviour. */
export const DEFAULT_DM_ENGINE: DmEngine = 'gemini';
export const DEFAULT_GEMINI_FALLBACK = true;

export interface DmEngineSettings {
    engine: DmEngine;
    geminiFallback: boolean;
}

/**
 * The tenant's engine and fallback switch.
 *
 * Fails safe, toward what the bot did before this existed: a tenant with no agent row, a row from before v37 (the columns are missing
 * until `npm run migrate` has run) or a read that errors all answer `gemini`, and the last two are logged. A DM must not be lost to the
 * lookup that decides how it is answered.
 */
export async function readDmEngine(creatorId: string): Promise<DmEngineSettings> {
    try {
        const row = await queryOne<Pick<AiAgentRow, 'engine' | 'gemini_fallback'>>(
            'SELECT engine, gemini_fallback FROM ai_agents WHERE creator_id = $1',
            [creatorId]
        );
        return {
            engine: isDmEngine(row?.engine) ? row.engine : DEFAULT_DM_ENGINE,
            geminiFallback: typeof row?.gemini_fallback === 'boolean' ? row.gemini_fallback : DEFAULT_GEMINI_FALLBACK,
        };
    } catch (err) {
        log('warn', 'dm.engine_read_failed', { creator_id: creatorId, ...describeError(err) });
        return { engine: DEFAULT_DM_ENGINE, geminiFallback: DEFAULT_GEMINI_FALLBACK };
    }
}

// ─── The providers engine ────────────────────────────────────────────────────────────────────────

/** A DM is answered while the person waits (target p50 under 10 s), so the layer gets less time than Gemini's 30 s (DM plan §3). */
export const DM_TIMEOUT_MS = 20_000;
/**
 * Caps the whole answer, thinking included. The reply is a few hundred tokens of JSON; this is the floor the layer raises any
 * Anthropic model's limit to at `low` effort anyway (`limits.ts`), so asking for it keeps the budget's worst-case estimate honest.
 */
export const DM_MAX_TOKENS = 4_000;

/**
 * The schema the model answers in, for every provider: `dmResponseSchema`, the same object Gemini is sent, as the library's schema
 * type. The library converts it to JSON Schema for the others (`toJsonSchema`: lower-case types, objects closed, array bounds dropped).
 *
 * One schema and not a copy that could drift from its golden (`dm.response-schema.json`, which pins Gemini's bytes). It is within what
 * Anthropic's structured output accepts: 7 optional properties against a cap of 24, no unions (dmEngine.test.ts counts them, so a field
 * added to the Gemini schema that Anthropic would refuse fails a test and not a customer's DM). The model's `message_type` and the
 * rest are then coerced exactly as Gemini's are (`coerceAiResponse`, `enforceMetaConstraints`).
 */
export function dmLlmSchema(ctx: DmContext): LlmSchema {
    return dmResponseSchema(ctx) as LlmSchema;
}

type HistoryRow = Pick<MessageRow, 'direction' | 'text'>;

/**
 * The conversation as the layer's turns: `history` oldest first (already cut to `HISTORY_WINDOW` by the caller), then the message being
 * answered unless it is already the last stored row. The same rule `generateAiResponse` follows, plus the two things Anthropic refuses
 * and Gemini tolerates: a conversation that does not start with the user, and a turn with no text. Dropping a leading reply of ours
 * leaves a window that begins one message later; the model only loses the oldest line of an eight-message window.
 */
export function dmTurns(history: readonly HistoryRow[], userMessage: string): LlmTurn[] {
    const turns: LlmTurn[] = history.map((row) => ({ role: row.direction === 'inbound' ? 'user' : 'model', text: row.text }));
    const last = history[history.length - 1];
    if (!last || last.text !== userMessage || last.direction !== 'inbound') turns.push({ role: 'user', text: userMessage });

    const usable = turns.filter((turn) => typeof turn.text === 'string' && turn.text.trim() !== '');
    const firstUser = usable.findIndex((turn) => turn.role === 'user');
    return firstUser < 0 ? [] : usable.slice(firstUser);
}

/** A failure of the engine that is not an `AiError`: the model answered with nothing a customer could be sent. */
export class DmEngineError extends Error {
    constructor(readonly reason: 'empty_reply', message: string) {
        super(message);
        this.name = 'DmEngineError';
    }
}

/** What the sandbox may substitute for this call only, as `generateAiResponse` takes it. Its presence means "the dashboard's test box". */
export interface DmOverrides {
    system_prompt?: string;
    knowledge_base?: string;
    model?: string;
    temperature?: number;
}

/**
 * `generateAiResponse` through the AI providers layer. The same contract: `null` when the agent is switched off (or has no row), the
 * reply otherwise, a thrown error for every failure.
 *
 * The system text is `dmSystemInstruction`'s, the same bytes Gemini is sent, so what the persona and the rules say does not depend on
 * the engine. The model and temperature in the agent row (and in `overrides`) are Gemini's: the provider, model and effort come from the
 * `dm` route the operator saved in Operations (an unsaved route falls to the first provider with a key, at `low`).
 *
 * `cacheSystem: true`: the system text (persona, knowledge base, rules) is the same on every message of every conversation, so
 * Anthropic's prompt cache (5 minutes) pays off within a live back-and-forth, and it is the largest part of the prompt.
 *
 * The sandbox (`overrides` given) is labelled `eval` in `ai_usage`: it is the operator trying a draft, and `purpose = 'dm'` stays what
 * real customers cost and how long they waited. It is still charged to the tenant, so the tenant's budget bounds it.
 */
export async function generateDmViaLayer(
    conversationId: string,
    userMessage: string,
    creatorId: string,
    overrides?: DmOverrides,
    ctx?: DmContext
): Promise<AiResponse | null> {
    const dmCtx: DmContext = ctx ?? await profileContextOrLegacy(creatorId, 'dm');

    type AgentRow = Pick<AiAgentRow, 'is_active' | 'system_prompt' | 'knowledge_base' | 'model' | 'temperature'>;
    const stored = await queryOne<AgentRow>(
        `SELECT is_active, system_prompt, knowledge_base, model, temperature
           FROM ai_agents WHERE creator_id = $1`,
        [creatorId]
    );

    const isSandbox = overrides !== undefined;
    const decision = decideAgent(stored, isSandbox, dmCtx.language.code);
    if (!decision.speak) {
        // The same two lines `generateAiResponse` writes: a switched-off agent is doing what the toggle is for, an unconfigured one is a fault.
        log(decision.reason === 'unconfigured' ? 'warn' : 'debug', `ai.${decision.reason}`, { creator_id: creatorId });
        return null;
    }
    const agent = decision.agent;

    const historyRows = await queryRows<HistoryRow>(
        `SELECT direction, text
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [conversationId, HISTORY_WINDOW]
    );
    const turns = dmTurns(historyRows.reverse(), userMessage);

    const system = dmSystemInstruction(overrides?.system_prompt ?? agent.system_prompt, overrides?.knowledge_base ?? agent.knowledge_base, dmCtx);

    const result = await generate({
        purpose: 'dm',
        creatorId,
        ...(isSandbox ? { usageAs: EVAL } : {}),
        system,
        user: turns,
        schema: dmLlmSchema(dmCtx),
        maxTokens: DM_MAX_TOKENS,
        timeoutMs: DM_TIMEOUT_MS,
        cacheSystem: true,
    });

    const coerced = coerceAiResponse(result.json);
    // An empty reply is a failure and not a message, as on the Gemini path: sent, it is a Meta rejection blamed on the send, and stored,
    // it is a blank turn fed back as history.
    if (!coerced.text.trim() && coerced.message_type === 'text') {
        throw new DmEngineError('empty_reply', 'The model returned a structured response with no usable text.');
    }
    return enforceMetaConstraints(coerced);
}

// ─── The dispatch ────────────────────────────────────────────────────────────────────────────────

/** Why an engine failed, as a short code and a message safe to log and show: an `AiError`'s kind and its already-scrubbed text. */
export interface DmFailure {
    reason: string;
    message: string;
}

export function failureOf(err: unknown): DmFailure {
    if (isAiError(err)) return { reason: err.kind, message: err.message };
    if (err instanceof DmEngineError) return { reason: err.reason, message: err.message };
    return { reason: 'unexpected', message: scrub(err instanceof Error ? err.message : String(err)) };
}

/** `fellBackFrom` is set when the `providers` engine failed and Gemini answered in its place. */
export type DmReply =
    | { kind: 'reply'; response: AiResponse; engine: DmEngine; fellBackFrom?: DmFailure }
    /** The agent is switched off, or the tenant has none: say nothing, which is a decision and not a failure. */
    | { kind: 'off' }
    /** Nothing can be sent: the `providers` engine failed and the fallback is off or failed too. `dm.engine_failed` has been logged. */
    | { kind: 'handoff'; engine: DmEngine; failure: DmFailure; fallbackFailure?: DmFailure };

/** The sandbox's on-screen choices, which win over the saved ones for that call. */
export interface DmReplyOverrides extends DmOverrides {
    engine?: DmEngine;
    gemini_fallback?: boolean;
}

/**
 * Answer one message with the engine the tenant chose. See the header for the policy; the Gemini engine is `generateAiResponse` and
 * nothing else, called with the arguments it always had (only the sandbox's own fields, none of the engine's).
 */
export async function generateDmReply(
    conversationId: string,
    userMessage: string,
    creatorId: string,
    overrides?: DmReplyOverrides,
    ctx?: DmContext
): Promise<DmReply> {
    const saved = await readDmEngine(creatorId);
    const engine = overrides?.engine ?? saved.engine;
    const geminiFallback = overrides?.gemini_fallback ?? saved.geminiFallback;
    const source = overrides === undefined ? 'dm' : 'sandbox';

    // `overrides` being present is what makes `generateAiResponse` the sandbox, so it is rebuilt without the engine's fields and not spread.
    const geminiOverrides: DmOverrides | undefined = overrides === undefined ? undefined : {
        system_prompt: overrides.system_prompt, knowledge_base: overrides.knowledge_base, model: overrides.model, temperature: overrides.temperature,
    };
    const viaGemini = (): Promise<AiResponse | null> => generateAiResponse(conversationId, userMessage, creatorId, geminiOverrides, ctx);

    if (engine === 'gemini') {
        const response = await viaGemini();
        return response ? { kind: 'reply', response, engine } : { kind: 'off' };
    }

    let failure: DmFailure;
    try {
        const response = await generateDmViaLayer(conversationId, userMessage, creatorId, geminiOverrides, ctx);
        return response ? { kind: 'reply', response, engine } : { kind: 'off' };
    } catch (err) {
        failure = failureOf(err);
    }

    if (!geminiFallback) {
        log('error', 'dm.engine_failed', { creator_id: creatorId, source, engine, reason: failure.reason, message: failure.message, fallback: 'off' });
        return { kind: 'handoff', engine, failure };
    }

    log('warn', 'dm.engine_fallback', { creator_id: creatorId, source, from: engine, to: 'gemini', reason: failure.reason, message: failure.message });
    try {
        const response = await viaGemini();
        return response ? { kind: 'reply', response, engine: 'gemini', fellBackFrom: failure } : { kind: 'off' };
    } catch (err) {
        const fallbackFailure = failureOf(err);
        log('error', 'dm.engine_failed', {
            creator_id: creatorId, source, engine, reason: failure.reason, message: failure.message,
            fallback: 'failed', fallback_reason: fallbackFailure.reason, fallback_message: fallbackFailure.message,
        });
        return { kind: 'handoff', engine, failure, fallbackFailure };
    }
}
