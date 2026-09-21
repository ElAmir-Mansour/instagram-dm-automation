import axios from 'axios';
import { queryOne, queryRows } from '../db/query.js';
import type { AiAgentRow, MessageRow } from '../db/rows.js';
import { log } from '../utils/log.js';

/** The two columns the history window actually needs. */
type HistoryRow = Pick<MessageRow, 'direction' | 'text'>;

/**
 * `ai_agents.model` is dashboard-settable and gets interpolated straight into the request
 * path, so it is checked against a list rather than trusted. An unrecognised value falls back
 * instead of throwing: a typo in Settings should not take every DM reply down with it.
 */
const SUPPORTED_MODELS = new Set([
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro'
]);
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TEMPERATURE = 0.7;

/**
 * Turns sent on every single call: the system prompt and the whole knowledge base are resent
 * verbatim each time, and Arabic runs ~2-2.5x more tokens per character than English, so this
 * window is the dominant marginal cost of the product. Trimmed from 15. The real fix is
 * Gemini context caching (`cachedContents`), which bills the static prefix once per TTL
 * instead of once per message — worth doing before the knowledge base grows further.
 * @see https://ai.google.dev/gemini-api/docs/caching
 */
const HISTORY_WINDOW = 8;

/** Gemini can sit on a request indefinitely; a serverless invocation cannot. */
const GEMINI_TIMEOUT_MS = 30_000;

function resolveModel(configured: unknown): string {
    if (typeof configured === 'string' && SUPPORTED_MODELS.has(configured)) return configured;
    if (configured) {
        log('warn', 'ai.unknown_model', { configured, fallback: DEFAULT_MODEL });
    }
    return DEFAULT_MODEL;
}

export interface AiResponse {
    message_type: 'text' | 'quick_reply' | 'carousel';
    text: string;
    quick_replies?: Array<{ title: string; payload: string }>;
    carousel_elements?: Array<{
        title: string;
        subtitle?: string;
        image_url?: string;
        buttons?: Array<{
            type: 'web_url' | 'postback';
            title: string;
            url?: string;
            payload?: string;
        }>;
    }>;
}

/**
 * Interface to match Google Gemini's REST API payload structures.
 */
const RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        message_type: {
            type: "STRING",
            enum: ["text", "quick_reply", "carousel"]
        },
        text: {
            type: "STRING",
            description: "Conversational text response or prompt accompanying the buttons/carousel. Must be written in Arabic if appropriate."
        },
        quick_replies: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    title: { type: "STRING", description: "Label of the button. MAX 20 characters." },
                    payload: { type: "STRING", description: "Programmatic payload returned on click, e.g., GO_TO_COURSE_1." }
                },
                required: ["title", "payload"]
            },
            description: "A list of quick action buttons (maximum 13)."
        },
        carousel_elements: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    title: { type: "STRING", description: "Title of the carousel card. MAX 80 characters." },
                    subtitle: { type: "STRING", description: "Subtitle of the carousel card. MAX 80 characters." },
                    image_url: { type: "STRING", description: "Public URL of the image to display." },
                    buttons: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: {
                                type: { type: "STRING", enum: ["web_url", "postback"] },
                                title: { type: "STRING", description: "Button text. MAX 20 characters." },
                                url: { type: "STRING", description: "URL for web_url buttons." },
                                payload: { type: "STRING", description: "Payload for postback buttons." }
                            },
                            required: ["type", "title"]
                        }
                    }
                },
                required: ["title"]
            },
            description: "Swipeable cards. Specify between 2 and 10 cards."
        }
    },
    required: ["message_type", "text"]
};

/**
 * Force whatever Gemini returned into a payload Meta will actually accept.
 *
 * `responseSchema` is a strong constraint and not a guarantee. The failure modes seen in
 * practice, every one of which used to reach `toMetaMessage` unchecked:
 *
 *   - `message_type: "carousel"` with `carousel_elements` absent or empty. `toMetaMessage`
 *     builds `attachment.payload.elements = undefined`, and Meta answers "param message must
 *     be a non-empty object" — a message the operator cannot trace back to the model.
 *   - `message_type: "quick_reply"` with no `quick_replies`.
 *   - `text` returned as a number, or `quick_replies[].title` as one. `enforceMetaConstraints`
 *     then called `.substring` on it and threw a TypeError from inside the success path, which
 *     surfaced as `dm.pipeline_failed` with a message about `substring` and no mention of
 *     Gemini at all.
 *   - A model that ignores the enum and invents a fourth `message_type`.
 *
 * Every case degrades to a plain text reply rather than throwing. The person on the other end
 * gets the words the model wrote, which is what they were waiting for; the structure was
 * always a presentation detail. A throw here would be a silence instead.
 */
export function coerceAiResponse(parsed: unknown): AiResponse {
    const raw = (parsed ?? {}) as Record<string, unknown>;

    // Numbers and booleans are coerced; objects and arrays are not, because `String({})` is
    // `[object Object]` and sending that to a customer is worse than sending nothing.
    const text = typeof raw.text === 'string'
        ? raw.text
        : (typeof raw.text === 'number' || typeof raw.text === 'boolean') ? String(raw.text) : '';

    const quickReplies = Array.isArray(raw.quick_replies)
        ? raw.quick_replies.filter(
            (qr): qr is { title: string; payload: string } =>
                Boolean(qr) && typeof (qr as any).title === 'string' && typeof (qr as any).payload === 'string'
        )
        : [];

    const carousel = Array.isArray(raw.carousel_elements)
        ? raw.carousel_elements.filter(
            (el): el is AiResponse['carousel_elements'] extends (infer E)[] | undefined ? E : never =>
                Boolean(el) && typeof (el as any).title === 'string'
        )
        : [];

    if (raw.message_type === 'quick_reply' && quickReplies.length > 0) {
        return { message_type: 'quick_reply', text, quick_replies: quickReplies };
    }

    // A carousel carries no `text` field — Meta rejects `text` alongside `attachment` — so the
    // text is kept on the object for the disclosure path, which needs somewhere to put the
    // standalone line, and dropped by `toMetaMessage`.
    if (raw.message_type === 'carousel' && carousel.length > 0) {
        return { message_type: 'carousel', text, carousel_elements: carousel };
    }

    if (raw.message_type !== 'text') {
        log('warn', 'ai.response_downgraded', {
            requested_type: typeof raw.message_type === 'string' ? raw.message_type : null,
            quick_replies: quickReplies.length,
            carousel_elements: carousel.length,
            has_text: text.length > 0,
        });
    }

    return { message_type: 'text', text };
}

/**
 * Truncates strings to respect Meta's strict character constraints.
 */
function enforceMetaConstraints(response: AiResponse): AiResponse {
    if (response.text) {
        response.text = response.text.substring(0, 1000);
    }
    if (response.quick_replies) {
        response.quick_replies = response.quick_replies.slice(0, 13).map(qr => ({
            title: qr.title.substring(0, 20),
            payload: qr.payload.substring(0, 1000)
        }));
    }
    if (response.carousel_elements) {
        response.carousel_elements = response.carousel_elements.slice(0, 10).map(elem => {
            const cleanElem = { ...elem };
            cleanElem.title = elem.title.substring(0, 80);
            if (elem.subtitle) {
                cleanElem.subtitle = elem.subtitle.substring(0, 80);
            }
            if (elem.buttons) {
                cleanElem.buttons = elem.buttons.slice(0, 3).map(btn => {
                    const cleanBtn = { ...btn };
                    cleanBtn.title = btn.title.substring(0, 20);
                    if (btn.payload) {
                        cleanBtn.payload = btn.payload.substring(0, 1000);
                    }
                    return cleanBtn;
                });
            }
            return cleanElem;
        });
    }
    return response;
}

/**
 * Queries Gemini API using the conversation history and configuration details.
 *
 * **Returns `null` when the creator's AI agent exists but is switched off.** That is the
 * "do not reply at all" signal and the caller must honour it by sending nothing — there is no
 * fallback persona to fall back to. Every other failure (missing API key, Gemini error, empty
 * or unparseable response) **throws**, so the caller can record a real failure instead of
 * inventing an outbound turn.
 *
 * @param overrides Substitutes the stored prompt/knowledge base for this call only, without
 *                  writing to `ai_agents`. Used by the Settings "test" endpoint.
 */
/** The persona the sandbox runs against when no agent row exists yet. */
const SANDBOX_FALLBACK_AGENT = {
    system_prompt: 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.',
    knowledge_base: '',
    model: DEFAULT_MODEL,
    temperature: DEFAULT_TEMPERATURE as number | null,
};

/** The fields the generator reads off an agent row. */
export interface AgentSettings {
    system_prompt: string;
    knowledge_base: string | null;
    model: string | null;
    temperature: number | null;
}

export type AgentDecision =
    | { speak: false; reason: 'unconfigured' | 'disabled' }
    | { speak: true; agent: AgentSettings };

/**
 * Whether this creator's agent should answer, and with what.
 *
 * Extracted from `generateAiResponse` because it is the whole safety rule and it had no test —
 * and because both halves of it have been wrong in production.
 *
 * The `is_active` filter used to be in the WHERE clause, so a *disabled* agent returned zero
 * rows and was indistinguishable from an *unconfigured* one; the `|| default` below then
 * answered the customer anyway with a generic persona and an empty knowledge base, and the
 * toggle changed who replied rather than whether anyone did. That was fixed for the disabled
 * case by selecting the column instead of filtering on it.
 *
 * The unconfigured case was left substituting, and it is the more dangerous of the two: a
 * tenant created through `POST /api/admin/tenants` had no `ai_agents` row at all, so there was
 * no `is_active` for the off switch to be false on. Their bot answered their real customers in
 * a persona nobody chose, while `dm.sent` logged success, an outbound `messages` row was
 * written and the inbox showed a reply — every layer reporting that it had worked.
 *
 * Saying nothing is the right default for an account nobody has configured, and the caller
 * already honours it: src/webhook/messaging.ts leaves the message unanswered rather than
 * inventing an outbound turn.
 *
 * The sandbox is the one exception, and it has to be: `overrides` means the dashboard's test
 * box, where trying a prompt out *before* configuring an agent is exactly the point.
 */
export function decideAgent(stored: AgentSettings & { is_active?: boolean } | null | undefined, isSandbox: boolean): AgentDecision {
    if (isSandbox) {
        return { speak: true, agent: stored ?? SANDBOX_FALLBACK_AGENT };
    }
    if (!stored) return { speak: false, reason: 'unconfigured' };
    if (stored.is_active === false) return { speak: false, reason: 'disabled' };
    return { speak: true, agent: stored };
}

export async function generateAiResponse(
    conversationId: string,
    userMessage: string,
    creatorId: string,
    overrides?: { system_prompt?: string; knowledge_base?: string }
): Promise<AiResponse | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('Missing GEMINI_API_KEY environment variable.');
    }

    // 1. Fetch AI Agent Settings
    //    Deliberately unfiltered by is_active: the filter used to be in the WHERE clause, so a
    //    disabled agent returned zero rows and was indistinguishable from an unconfigured one.
    //    The `|| default` below then answered the customer anyway, with a generic persona and
    //    an empty knowledge base — the toggle changed who replied, not whether anyone did.
    type AgentRow = Pick<AiAgentRow, 'is_active' | 'system_prompt' | 'knowledge_base' | 'model' | 'temperature'>;
    const stored = await queryOne<AgentRow>(
        `SELECT is_active, system_prompt, knowledge_base, model, temperature
           FROM ai_agents WHERE creator_id = $1`,
        [creatorId]
    );

    // `overrides` means this is the dashboard's test sandbox, not a real customer. Testing a
    // prompt before switching the agent on is the whole point of that box, so the disabled
    // check deliberately does not apply to it — otherwise the toggle you are about to flip
    // silently makes the tool that helps you decide return nothing.
    const isSandbox = overrides !== undefined;

    const decision = decideAgent(stored, isSandbox);
    if (!decision.speak) {
        // `warn` for unconfigured, `debug` for disabled: a tenant that switched their agent
        // off is doing what the toggle is for, while a newly onboarded tenant receiving DMs
        // with no agent at all is something to go and fix.
        log(decision.reason === 'unconfigured' ? 'warn' : 'debug', `ai.${decision.reason}`,
            { creator_id: creatorId });
        return null;
    }
    const agent = decision.agent;

    // 2. Fetch recent conversation history
    const historyRows = await queryRows<HistoryRow>(
        `SELECT direction, text
         FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [conversationId, HISTORY_WINDOW]
    );

    // Order chronological
    const history: HistoryRow[] = historyRows.reverse();

    // 3. Format Contents for Gemini REST API
    const contents: any[] = [];
    for (const msg of history) {
        contents.push({
            role: msg.direction === 'inbound' ? 'user' : 'model',
            parts: [{ text: msg.text }]
        });
    }

    // Append the current message if it is not already logged
    const lastMsg = history[history.length - 1];
    if (!lastMsg || lastMsg.text !== userMessage || lastMsg.direction !== 'inbound') {
        contents.push({
            role: 'user',
            parts: [{ text: userMessage }]
        });
    }

    // 4. Construct System Instruction
    const systemPrompt = overrides?.system_prompt ?? agent.system_prompt;
    const knowledgeBase = overrides?.knowledge_base ?? agent.knowledge_base;
    const systemInstructionText = `${systemPrompt}\n\n=== قاعدة المعرفة المتاحة لديك (Knowledge Base) ===\n${knowledgeBase}\n\n=== تعليمات إضافية مهمة ===\n1. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللغة العربية الفصحى أو بلهجة سهلة ومناسبة.\n2. إذا طلب المستخدم كورسات أو معلومات تواصل، استخدم خيار "quick_reply" أو "carousel" لتقديمها بشكل تفاعلي ومنظم بدلاً من مجرد سرد روابط نصية.\n3. التزم تماماً بحدود الحروف: عناوين الأزرار والـ quick replies لا تتجاوز 20 حرفاً. عناوين الكروت لا تتجاوز 80 حرفاً.`;

    const modelName = resolveModel(agent.model);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    // `|| 0.7` turned a deliberate temperature of 0 — the setting you pick precisely to stop
    // the agent improvising about prices and course contents — back into 0.7.
    const temperature = Number.isFinite(agent.temperature) ? agent.temperature : DEFAULT_TEMPERATURE;


    try {
        const payload = {
            contents,
            systemInstruction: {
                parts: [{ text: systemInstructionText }]
            },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: RESPONSE_SCHEMA,
                temperature
            }
        };

        // The key goes in a header, not `?key=`. Query strings end up in proxy logs, browser
        // referrers and error reporters far more readily than headers do — and an axios error
        // carries `config.url`, so the old form leaked the key into anything that logged one.
        const response = await axios.post(url, payload, {
            headers: { 'x-goog-api-key': apiKey },
            timeout: GEMINI_TIMEOUT_MS
        });
        const rawJsonText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

        // Token counts are the product's dominant marginal cost and the only way to see it
        // is to record them per call. Arabic runs ~2-2.5x more tokens per character than
        // English, and the system prompt plus the whole knowledge base is resent every time,
        // so `prompt_tokens` here is mostly the static prefix — which is precisely the number
        // that tells you whether context caching is worth turning on.
        const usage = response.data?.usageMetadata;
        if (usage) {
            log('info', 'ai.usage', {
                model: modelName,
                prompt_tokens: usage.promptTokenCount,
                output_tokens: usage.candidatesTokenCount,
                total_tokens: usage.totalTokenCount,
                cached_tokens: usage.cachedContentTokenCount ?? 0,
                history_turns: contents.length,
            });
        }

        if (!rawJsonText) {
            // Usually a safety block: candidates come back empty with a finishReason. Worth
            // surfacing, because it is the one failure the operator can actually act on.
            const finishReason = response.data?.candidates?.[0]?.finishReason;
            const blockReason = response.data?.promptFeedback?.blockReason;
            throw new Error(
                `Gemini returned no content (finishReason: ${finishReason || 'none'}, blockReason: ${blockReason || 'none'}).`
            );
        }

        // `JSON.parse` of model output is the one place in this function where the type
        // annotation used to be pure fiction: it asserted `AiResponse` over whatever came
        // back. `coerceAiResponse` makes the claim true.
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawJsonText);
        } catch (parseErr) {
            // `responseMimeType: application/json` makes this rare, not impossible — a reply
            // truncated by MAX_TOKENS is valid text and invalid JSON. Worth its own message,
            // because "Unexpected end of JSON input" points nowhere on its own.
            throw new Error(
                `Gemini returned text that is not valid JSON (${(parseErr as Error)?.message}). ` +
                `First 200 characters: ${String(rawJsonText).slice(0, 200)}`
            );
        }

        const coerced = coerceAiResponse(parsed);

        // An empty reply is a failure, not a message. Sending it produces a Meta rejection
        // ("param message must be a non-empty object") attributed to the send rather than to
        // the model, and writing it to `messages` would feed a blank turn back as history.
        if (!coerced.text.trim() && coerced.message_type === 'text') {
            throw new Error('Gemini returned a structured response with no usable text.');
        }

        return enforceMetaConstraints(coerced);

    } catch (err: any) {
        // This used to swallow rate limits, network faults, safety blocks and JSON syntax
        // errors alike and answer the customer with a fixed promotional message carrying a
        // course link. That was then written to `messages` as a real outbound turn, so an
        // unsolicited ad went out on every hiccup and then fed itself back to Gemini as
        // history. A failure has to reach the caller as a failure.
        //
        // Logging the narrow field rather than the error object keeps request headers — and
        // therefore the API key — out of the log line.
        const metaError = err.response?.data?.error;
        const status = err.response?.status;
        log('error', 'ai.request_failed', {
            model: modelName,
            http_status: status,
            gemini_status: metaError?.status,
            message: metaError?.message ?? err.message,
        });

        throw new Error(
            `Gemini request failed${status ? ` [HTTP ${status}]` : ''}: ${metaError?.message || err.message}`
        );
    }
}
