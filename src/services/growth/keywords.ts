/**
 * `POST /api/growth/keywords/suggest` (GROWTH.md §3): `{ topic }` → search terms and hashtags for
 * the tenant's audience and language, from the Studio's Gemini chain.
 *
 * These are suggestions, and every one says so (`kind: 'suggestion'`): neither Instagram nor
 * Facebook exposes search volume through its API, so nothing here is volume data and the model is
 * told not to pretend it is. Terms the tenant already has are left out.
 */
import { callGemini, type CallModel, type GeminiSchema } from '../studio/generate.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { describeError, log } from '../../utils/log.js';
import { clip, GrowthError } from './common.js';
import { tenantLanguage } from './coach.js';
import { getGrowthSettings, normalizeHashtag } from './settings.js';

export const SUGGEST_TIMEOUT_MS = 45_000;
const MAX_KEYWORDS = 12;
const MAX_HASHTAGS = 15;
export const SUGGESTION_NOTE = 'AI suggestions from your topic and audience — not search-volume data.';

export const KEYWORDS_SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        keywords: {
            type: 'ARRAY', maxItems: MAX_KEYWORDS, description: 'search terms, best first',
            items: {
                type: 'OBJECT',
                properties: {
                    term: { type: 'STRING', description: 'what someone types into Instagram search, 1–4 words' },
                    why: { type: 'STRING', description: 'one line: who searches it and why it fits' },
                },
                required: ['term', 'why'],
                propertyOrdering: ['term', 'why'],
            },
        },
        hashtags: { type: 'ARRAY', maxItems: MAX_HASHTAGS, items: { type: 'STRING' }, description: 'with #, no spaces' },
    },
    required: ['keywords', 'hashtags'],
    propertyOrdering: ['keywords', 'hashtags'],
};

export interface KeywordSuggestions {
    keywords: { term: string; why: string; kind: 'suggestion' }[];
    hashtags: string[];
    note: string;
    language: 'ar' | 'en';
}

export function keywordsSystemPrompt(language: 'ar' | 'en'): string {
    const name = language === 'ar' ? 'Arabic' : 'English';
    return `You suggest Instagram search keywords and hashtags for a creator. Return strict JSON matching the response schema and nothing else.
- Terms are what the audience actually types into Instagram search, in the audience's language and dialect, 1–4 words each: the way people phrase a need, not marketing copy.
- Mix broad terms with specific long-tail ones. No brand names the creator doesn't own.
- You have no search-volume data and must not claim any: no numbers, no "most searched".
- Hashtags: specific ones a relevant viewer follows, not generic ones like #love or #instagood.
- Write the "why" lines in ${name}.`;
}

export function keywordsUserPrompt(input: {
    topic: string; language: 'ar' | 'en'; countries: readonly string[]; languages: readonly string[]; existing: readonly string[];
}): string {
    return [
        `Topic: ${input.topic}`,
        `Audience countries: ${input.countries.length ? input.countries.join(', ') : 'not set'}`,
        `Audience languages: ${input.languages.length ? input.languages.join(', ') : input.language}`,
        `Keywords the creator already has (don't repeat them): ${input.existing.length ? input.existing.join(', ') : '(none)'}`,
        `Suggest up to ${MAX_KEYWORDS} keywords and ${MAX_HASHTAGS} hashtags.`,
    ].join('\n');
}

const keyOf = (term: string): string => normalizeArabic(term.toLowerCase().replace(/\s+/g, ' ').trim());

/** The model's JSON, cleaned: deduplicated, without the tenant's own terms, hashtags normalised. */
export function coerceSuggestions(raw: unknown, existing: readonly string[]): Pick<KeywordSuggestions, 'keywords' | 'hashtags'> {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const seen = new Set(existing.map(keyOf));
    const keywords: KeywordSuggestions['keywords'] = [];
    for (const item of Array.isArray(r.keywords) ? r.keywords : []) {
        if (!item || typeof item !== 'object') continue;
        const term = clip((item as Record<string, unknown>).term, 60).replace(/^#/, '');
        if (!term || seen.has(keyOf(term))) continue;
        seen.add(keyOf(term));
        keywords.push({ term, why: clip((item as Record<string, unknown>).why, 200), kind: 'suggestion' });
        if (keywords.length >= MAX_KEYWORDS) break;
    }
    const tags = new Set<string>();
    const hashtags: string[] = [];
    for (const raw of Array.isArray(r.hashtags) ? r.hashtags : []) {
        const tag = typeof raw === 'string' ? normalizeHashtag(raw.replace(/\s+/g, '_')) : null;
        if (!tag || tags.has(tag.toLowerCase())) continue;
        tags.add(tag.toLowerCase());
        hashtags.push(tag);
        if (hashtags.length >= MAX_HASHTAGS) break;
    }
    if (!keywords.length && !hashtags.length) throw new GrowthError(502, 'No usable suggestions came back. Try a more specific topic.');
    return { keywords, hashtags };
}

export async function suggestKeywords(creatorId: string, body: unknown, opts: { callModel?: CallModel } = {}): Promise<KeywordSuggestions> {
    const rawTopic = body && typeof body === 'object' ? (body as Record<string, unknown>).topic : undefined;
    const topic = clip(rawTopic, 200);
    if (topic.length < 2) throw new GrowthError(400, 'Send a topic, e.g. { "topic": "prompt engineering for beginners" }.');

    const [settings, language] = await Promise.all([getGrowthSettings(creatorId), tenantLanguage(creatorId)]);
    let raw: unknown;
    try {
        raw = await (opts.callModel ?? callGemini)({
            purpose: 'growth-keywords',
            system: keywordsSystemPrompt(language),
            turns: [{
                role: 'user',
                text: keywordsUserPrompt({
                    topic, language, countries: settings.audience.countries ?? [], languages: settings.audience.languages ?? [],
                    existing: settings.keywords,
                }),
            }],
            schema: KEYWORDS_SCHEMA,
            temperature: 0.7,
            thinkingBudget: 512,
            timeoutMs: SUGGEST_TIMEOUT_MS,
        });
    } catch (err) {
        log('warn', 'growth.keywords_failed', { creator_id: creatorId, ...describeError(err) });
        throw new GrowthError(502, `No suggestions right now: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400));
    }
    return { ...coerceSuggestions(raw, settings.keywords), note: SUGGESTION_NOTE, language };
}
