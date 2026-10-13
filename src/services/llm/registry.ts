/**
 * Every AI provider a tenant's work can run on (docs/onboarding/06-ai-providers.md §2).
 *
 * Four wire families cover all of them. A provider is a family, a base URL, whether it needs a
 * key and a few suggested models; the model field always takes any id the provider accepts, so
 * adding another Chat Completions provider later is one entry here and nothing else.
 *
 * Gemini is deliberately the same provider the DM bot and the Studio already use. Its key is the
 * existing `gemini.api_key` setting (P20c), not a second one.
 *
 * Nothing here reads settings, the environment or the network: it is the constant half of the
 * picture. `defaultModel` is a seed. P20c lets the operator overwrite it per provider
 * (`ai.providers.<id>.defaultModel`), because model ids change faster than this file ships.
 */

/** The wire formats. `chat_completions` is what OpenRouter and every OpenAI-compatible endpoint speak. */
export type ProviderFamily = 'anthropic' | 'openai_responses' | 'gemini' | 'chat_completions';

/**
 * In `resolveRoute`'s fallback order (P20c): with no saved route, the first of these that has a
 * key is used, at its default model.
 */
export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'custom'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDef {
    id: ProviderId;
    /** For the settings card: "Anthropic (Claude)". */
    label: string;
    family: ProviderFamily;
    /**
     * Where the API lives; each adapter appends its own path. Empty for `custom`, whose base URL
     * is the operator's to supply.
     */
    baseUrl: string;
    /** Only `custom`: the operator types the base URL. */
    editableBaseUrl: boolean;
    /** False only for `custom`: a public OpenAI-compatible endpoint may be open. */
    keyRequired: boolean;
    /** The seed for "which model, when nobody chose one". An editable default, see the file comment. */
    defaultModel: string;
    /** What the settings card offers as a click; any other id can be typed. */
    suggestedModels: readonly string[];
}

export const PROVIDERS: readonly ProviderDef[] = [
    {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        family: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        editableBaseUrl: false,
        keyRequired: true,
        defaultModel: 'claude-opus-5-5',
        suggestedModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    },
    {
        id: 'openai',
        label: 'OpenAI',
        family: 'openai_responses',
        baseUrl: 'https://api.openai.com/v1',
        editableBaseUrl: false,
        keyRequired: true,
        defaultModel: 'gpt-6-astra',
        suggestedModels: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'],
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        family: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        editableBaseUrl: false,
        keyRequired: true,
        defaultModel: 'gemini-3.8-flash',
        // No Flash-Lite: ai.ts records 3.5 and 3.1 Flash-Lite looping inside structured replies,
        // which is exactly what this library asks of a model.
        suggestedModels: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        family: 'chat_completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        editableBaseUrl: false,
        keyRequired: true,
        // Its own router: always exists, so a fresh key works before anyone has picked a model.
        defaultModel: 'openrouter/auto',
        suggestedModels: ['openrouter/auto'],
    },
    {
        id: 'custom',
        label: 'Custom (OpenAI-compatible)',
        family: 'chat_completions',
        baseUrl: '',
        editableBaseUrl: true,
        keyRequired: false,
        // Nothing to guess: which models exist is the endpoint's business.
        defaultModel: '',
        suggestedModels: [],
    },
];

export function providerById(id: string | null | undefined): ProviderDef | undefined {
    return PROVIDERS.find((p) => p.id === id);
}

export function isProviderId(value: unknown): value is ProviderId {
    return typeof value === 'string' && PROVIDERS.some((p) => p.id === value);
}

/**
 * Whether an operator's base URL may receive an API key. Only `custom` has one, and it is the one
 * place a request can be pointed at an address someone typed, so it has to be a public https
 * origin: no plain http (the key would cross the network readable), no credentials or query in
 * the URL, and no address that only exists on a private network: IP literals, `localhost`,
 * `.local`, `.internal`, or a single-label name. The URL parser has already turned decimal and
 * hex spellings of an IP (`2130706433`) into dotted form by the time it is checked.
 *
 * This looks only at what was typed. A public name that *resolves* to a private address is a DNS
 * question, and P21's guard answers it where the connection is made.
 */
export function checkBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
    let u: URL;
    try {
        u = new URL(raw.trim());
    } catch {
        return { ok: false, reason: 'is not a valid URL' };
    }
    if (u.protocol !== 'https:') return { ok: false, reason: 'must start with https://' };
    if (u.username || u.password) return { ok: false, reason: 'must not contain a username or password' };
    if (u.search || u.hash) return { ok: false, reason: 'must not contain a query or a fragment' };
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
    const isPrivateName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.');
    if (isIp || isPrivateName) return { ok: false, reason: 'must be a public address, not an IP, localhost or a private network name' };
    return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') };
}

/** How an error names a provider: "Anthropic", "OpenAI"; a custom endpoint is "The custom endpoint". */
export function providerName(id: string): string {
    if (id === 'custom') return 'The custom endpoint';
    const def = providerById(id);
    return def ? def.label.replace(/ \(.*\)$/, '') : 'The provider';
}
