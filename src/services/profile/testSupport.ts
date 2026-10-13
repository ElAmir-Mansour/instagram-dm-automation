/**
 * What the profile tests share: the scrambler the lens laws need, a path walker, the way Postgres
 * stores a JSON object, the shipped campaigns screen, and a fully filled profile whose every value is
 * different from every other, so a field that lands in the wrong place cannot hide behind an equal
 * neighbour. Imported by tests only; production code never reads it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { CreatorProfile } from './types.js';

// These began here and moved to `jsonb.ts`, because the backfill's decisions depend on them; every test still imports them from here.
export { getAt, hasAt, jsonbReorder, scramble, setAt, throughJsonb } from './jsonb.js';

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every leaf path of an object: lists, `null` and scalars are leaves, plain objects are walked. */
export function leafPaths(value: unknown, prefix = ''): string[] {
    if (!isObj(value)) return prefix ? [prefix] : [];
    return Object.entries(value).flatMap(([key, v]) => leafPaths(v, prefix ? `${prefix}.${key}` : key));
}

/**
 * The REAL shipped campaigns screen, run in a bare context (the way golden.test.ts runs it): it only declares
 * CampaignsPage and registers its actions. `inside` reads a value out of it as plain JSON.
 */
export function loadCampaignsPage(): vm.Context {
    const file = new URL('../../../dashboard/js/pages/campaigns.js', import.meta.url);
    const ctx = vm.createContext({
        UI: { registerActions: () => {}, showModal: () => {}, formatNumber: (n: unknown) => String(n), button: () => '' },
        html: Object.assign(() => '', { raw: (s: unknown) => s }),
        t: (key: string) => key,
    });
    vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: 'dashboard/js/pages/campaigns.js' });
    return ctx;
}

export const inside = (ctx: vm.Context, expression: string): any => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, ctx));

/** Freezes `value` all the way down, so a function that mutates its input throws instead of passing. */
export function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
}

export const UPLOAD_A = 'https://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111';
export const UPLOAD_B = 'https://app.example.com/api/uploads/22222222-2222-4222-8222-222222222222.jpg';

/**
 * A second tenant, filled in everywhere: Arabic in the Egyptian register with an English carousel, a
 * non-primary offer listed first, a presenter, a campaign, hours, a handoff. No two fields hold the
 * same value, and none is the default.
 */
export function richProfile(): CreatorProfile {
    return {
        schema: 1,
        identity: {
            display_name: { ar: 'سامي للياقة', en: 'Sami Fitness' },
            brand_name: 'Sami Fit Studio',
            kind: 'coach',
            role: 'fitness coach',
            niche: 'Home workouts for busy parents',
            country: 'EG',
            timezone: 'Africa/Cairo',
        },
        language: {
            primary: 'ar',
            register: 'egyptian',
            digits: 'latin',
            surfaces: { carousel: { language: 'en' }, infographic: { language: 'ar', register: 'msa' }, dm: { register: 'levantine' } },
        },
        offers: [
            { id: 'side', kind: 'coaching', name: 'One-to-one call', order_via: 'dm', url: '', price: '$20', facts: ['30 minutes'], bullets: ['✅ A plan for you'], keyword: 'call', primary: false },
            {
                id: 'main', kind: 'program', name: 'Twelve-week program', order_via: 'url', url: 'https://samifit.example/program?ref=ig', price: '$99',
                facts: ['12 weeks', 'Video lessons', 'Weekly check-in'], bullets: ['✅ A plan every week', '✅ Replies within a day'], keyword: 'plan', primary: true,
                campaign: { name_match: 'twelve-week', match: 'word', keywords: ['plan', 'program'], dm_template: 'Hi {username}, the program is here: {url}', public_replies: ['Sent to your DMs!', 'Check your messages'] },
            },
        ],
        audience: {
            description: 'Parents with under an hour a day', level: 'beginner', pains: ['No time', 'No gym'], goals: ['Lose weight', 'Sleep better'],
            countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai',
        },
        voice: {
            guide: 'Warm, direct, never preachy.', tone: ['warm', 'direct'], samples: ['Ten minutes is enough. Start now.'], use_words: ['simple'],
            avoid_words: ['hack'], emoji: 'rich', address: 'plural',
        },
        presenter: { name: 'Sami', pronouns: 'she', on_camera: 'mixed' },
        content: {
            domain: 'general', pillars: ['Workouts', 'Food'], never_mention: ['steroids', 'crash diets'], rules: ['no_women_imagery'],
            custom_rules: ['No before-and-after body photos'],
        },
        brand: { primary: '#112233', accent: '#AABBCC', font_display: 'Tajawal', logo_url: UPLOAD_A, portrait_url: UPLOAD_B, theme: 'light' },
        socials: { handle: '@sami.fit', site: 'samifit.example', platforms: ['instagram', 'youtube'], links: { instagram: 'https://instagram.com/sami.fit' } },
        dm: {
            faq: [{ q: 'How much is it?', a: '$99, once.' }],
            handoff: { when: 'The person asks for a refund', message: 'A person will reply to you soon.' },
            hours: { days: [0, 1, 2, 3, 4], from: '09:00', to: '17:00' },
        },
        goals: { followers: 5000, views: 250_000 },
    };
}

// ─── The second-tenant checks (docs/onboarding/05 §3) ────────────────────────────────────────

/**
 * Every string that marks a prompt as the owner's: his course, his name and links, his stack, his reels' lines and the
 * no-women rule (the one that is his by default and a tenant's by choice). The list is 05 §3's, entry for entry. A builder
 * that says any of them to another tenant has leaked him. Matched as plain substrings, case as written ("course" and
 * "Course" are two entries, so is "udemy" and "Udemy"): that is how a leak shows, inside a longer word or a sentence. The one
 * exception is «بالعربي», a whole word (`WHOLE_WORD_MARKERS`).
 */
export const OWNER_MARKERS: readonly string[] = Object.freeze([
    'Agentic', 'بالعربي', 'Udemy', 'udemy', 'referralCode', '02A626DDDA3FDAB6AB34', 'ElAmir', 'elamir', 'الأمير', 'منصور', 'MCP', 'Clario',
    'tech educator', 'senior engineer', 'goroutines', 'n8n', 'ChatGPT', 'الذكاء_الاصطناعي', 'Never a woman', 'Asia/Riyadh',
    'course', 'Course', 'كورس', 'Reference carousels', 'الدردشة ماتت', 'Stop asking AI', 'GO_TO_COURSE',
]);

/** The Arabic block, as a character class body: what counts as Arabic script (`dmFallbackReply` tests for the same block). */
const ARABIC_BLOCK = '\u0600-\u06FF';

/**
 * What a word is made of, as a character class body: the letters, tatweel and the vowel marks (U+0621-0652, U+0670-0671), and
 * not the Arabic punctuation of the same block («،» «؛» «؟»), which ends a word as a space does.
 */
const ARABIC_LETTERS = '\u0621-\u0652\u0670\u0671';

/**
 * The markers that are matched as whole words, not as substrings. «بالعربي» is the owner's colloquial brand word («Agentic AI
 * بالعربي»); as a substring it is also the first letters of «بالعربية», the ordinary word for "in Arabic" that the neutral
 * Arabic kit rightly says («بالعربية الفصحى البسيطة»). A whole word is the owner's, with or without a leading «و».
 */
const WHOLE_WORD_MARKERS: ReadonlySet<string> = new Set(['بالعربي']);

function holdsMarker(text: string, marker: string): boolean {
    if (!WHOLE_WORD_MARKERS.has(marker)) return text.includes(marker);
    return new RegExp(`(?<![${ARABIC_LETTERS}])و?${marker}(?![${ARABIC_LETTERS}])`, 'u').test(text);
}

/**
 * Fails if `text` holds any of the owner's markers (`OWNER_MARKERS`, with «بالعربي» as a whole word). `label` names what was
 * being checked, so a failure says which builder.
 *
 * `except` is the canonical lines of the presets the tenant itself ticked, which are said verbatim and are not a leak:
 * the no-women rule is the owner's by default and a tenant's by choice, and its line («Never a woman…», `NO_WOMEN_LINE`) holds
 * one of his markers. Each is taken out of the text before the markers are looked for, so a tenant that ticked the rule may say
 * it and nothing else of his; a tenant that did not passes none, and its text must not hold the line. Whether the line is
 * there at all is the caller's to assert: this only says what is not a leak.
 */
export function assertNoOwnerMarkers(text: string, label = 'text', { except = [] }: { except?: readonly string[] } = {}): void {
    const rest = except.reduce((left, line) => left.split(line).join(''), text);
    const found = OWNER_MARKERS.filter((marker) => holdsMarker(rest, marker));
    assert.deepEqual(found, [], `${label} holds the owner's ${found.length === 1 ? 'marker' : 'markers'}: ${found.join(', ')}\n${rest.slice(0, 300)}`);
}

/** Arabic script: the block the DM and comment paths themselves test for (`dmFallbackReply`). */
export const ARABIC_SCRIPT = new RegExp(`[${ARABIC_BLOCK}]`);

/** An English tenant's text has no Arabic script in it at all. */
export function assertNoArabicScript(text: string, label = 'text'): void {
    const hit = ARABIC_SCRIPT.exec(text);
    assert.equal(hit, null, `${label} has Arabic script (${hit?.[0]} at ${hit?.index}): ${text.slice(0, 300)}`);
}

/**
 * The Gulf words an Egyptian or MSA tenant must never be told (05 §3). «ما قدرنا» is a phrase, the rest are words. **Not for
 * the Levantine register**: its public reply is «ما قدرنا نبعتلك عالخاص», the same two words as the Gulf's, and rightly.
 */
export const GULF_TOKENS: readonly string[] = Object.freeze(['تبي', 'ودك', 'الحين', 'هالحين', 'ويجيك', 'ما قدرنا']);

/**
 * An Egyptian or MSA tenant's text has none of the Gulf tokens (`GULF_TOKENS`) as a word: bare, or with the one-letter
 * prefixes Arabic glues on, «و» «ف» «ب» («والحين», «وتبي», «بالحين»). A longer word that merely contains a token is not a hit
 * («تبيان», «والحينئذ»). It is for the Egyptian and MSA fixtures only (see `GULF_TOKENS`).
 */
export function assertNoGulfInEgyptianOrMsa(text: string, label = 'text'): void {
    const found = GULF_TOKENS.filter((token) => new RegExp(`(?<![${ARABIC_LETTERS}])[وفب]?${token}(?![${ARABIC_LETTERS}])`, 'u').test(text));
    assert.deepEqual(found, [], `${label} says ${found.join(', ')} to an Egyptian or MSA tenant: ${text.slice(0, 300)}`);
}
