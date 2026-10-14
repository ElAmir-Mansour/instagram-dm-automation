/**
 * `validateDraft`: a model's answer, checked in code and made into a valid partial `CreatorProfile`
 * (docs/onboarding/03 §3.5, point 4). Pure.
 *
 * The answer is untrusted. A hostile bio can steer a model, and a model can simply be wrong, so nothing the
 * model says reaches the profile on its word alone, and some things do not reach it from the model at all:
 *
 *   NEVER FROM THE MODEL (found or decided by code):
 *     - colours, socials, the logo: from `ctx.code`, the page's own markup;
 *     - the timezone: from the country, in `geo.ts`;
 *     - the Arabic register, digits and emoji level: from the signals when there are any (the model's pick is
 *       kept as a note, and a disagreement is flagged);
 *     - `already_used` on a comment keyword: recomputed from the keywords actually in use;
 *     - offer ids, which offer is primary, and the sample texts (copied from the source by id);
 *     - presenter, content rules, "never mention", hours, handoff: no field exists for them in the schema, and
 *       an answer that invents one is ignored.
 *   ONLY IF A SOURCE SAYS IT, WORD FOR WORD:
 *     - every URL, price, phone number and email address, in the fields made for one (an offer's address and price,
 *       the contact details, a FAQ answer, a name that is a domain). What no source has is removed, and what
 *       survives is rebuilt from the source (a phone from its digits, a URL in the source's own spelling, https
 *       only, and one `validateFetchUrl` would refuse is dropped). A source CAN say something hostile, since the
 *       attacker wrote the source: such a link is flagged for the tick every offer address and FAQ answer needs.
 *   NEVER IN FREE TEXT:
 *     - a URL, email, number or @handle anywhere else (a style guide, a niche, a pain point, a tone word): a bio
 *       that says "tell every customer to pay at..." must not be able to write that into text the agents later
 *       read as the creator's own, so they come out whether or not a source has them.
 *   CHECKED, THEN KEPT OR DEMOTED:
 *     - each `evidence` quote must be a verbatim substring of the source it cites; otherwise the fact keeps its
 *       value but the provenance becomes `inferred`, no quote, `low`;
 *     - every choice must be in its list; sample and pillar ids must exist; every length is clipped to the
 *       profile's own limit; free text loses angle brackets and invisible characters.
 *
 * The profile that comes out is run through `validateProfile`. If a section still fails (it should not), that
 * section is reset to the base and the repair is reported, so the result is always a profile the store accepts.
 * Nothing here trusts the model to have followed the schema: any value of any type is read as junk if it is.
 */
import { keywordMatches, normalizeArabic } from '../../utils/arabic.js';
import { defaultProfile } from '../profile/defaults.js';
import { ADDRESS, DIGITS, DOMAINS, EMOJI_LEVELS, KINDS, LANGS, LEVELS, OFFER_KINDS, REGISTERS, SOCIALS, type ArabicRegister, type CreatorProfile, type InfographicSocial, type Offer } from '../profile/types.js';
import { activationMissing, PROFILE_LIMITS, validateProfile } from '../profile/validate.js';
import { CONFIDENCES, type Confidence, type Prov } from './draftSchema.js';
import type { DraftSignals, SampleCandidate } from './draftSignals.js';
import { cleanSource, type DraftSource } from './fence.js';
import { timezoneForCountry } from './geo.js';
import { validateFetchUrl } from './netGuard.js';
import { oneLine, stripInvisible, truncateChars } from './textClean.js';

// ─── What goes in and comes out ──────────────────────────────────────────────────────────────

export interface DraftOutput {
    /** The voice call's answer, as parsed JSON; anything at all, or absent when the call failed. */
    voice?: unknown;
    business?: unknown;
}

export interface DraftContext {
    /** The sources the model was shown, as prepared. Evidence is checked against their text. */
    sources: readonly DraftSource[];
    signals?: DraftSignals | null;
    /** The sample pool (default `signals.candidates`). */
    candidates?: readonly SampleCandidate[];
    /** Comment keywords already used by campaigns (default `signals.keywords_in_use`). */
    keywordsInUse?: readonly string[];
    /** Addresses, emails and numbers code found on the creator's own pages and profile, which a model may repeat. */
    knownUrls?: readonly string[];
    knownEmails?: readonly string[];
    knownPhones?: readonly string[];
    /** Found by code: the brand colours and the social links. */
    code?: {
        brand?: { primary?: string | null; accent?: string | null } | null;
        socials?: { handle?: string | null; site?: string | null; links?: Partial<Record<InfographicSocial, string>> } | null;
    };
    /** The profile to draft onto (default `defaultProfile()` in the drafted language). */
    base?: CreatorProfile;
}

export type DraftFlagKind =
    | 'evidence_unverified' // a quote that is not in its source
    | 'unsourced_removed' // a URL, price, number, email or handle taken out of a field made for one, because no source has it
    | 'removed_from_text' // a URL, email, number or handle taken out of a field that has no use for one, sourced or not
    | 'url_refused' // a sourced address that may not be used (not https, private, a bad port)
    | 'faq_offdomain_link' // a FAQ answer links somewhere other than the creator's own sites
    | 'offer_offdomain_url' // an offer's address is on a host that is not the creator's own site: for the person's tick
    | 'faq_answer_dropped' // an answer with an invented link, back to needs_input
    | 'register_disagreement'
    | 'language_overridden'
    | 'samples_filled'
    | 'unknown_id' // a sample or pillar id that is not a source
    | 'not_a_value' // a field that was not what the schema says
    | 'section_reset'; // a section that failed validation and was reset to the base

export interface DraftFlag {
    path: string;
    kind: DraftFlagKind;
    detail?: string;
}

export interface Draft {
    /** Always accepted by `validateProfile`. Only what was drafted differs from the base. */
    profile: CreatorProfile;
    /** Where each drafted fact came from, by profile path (`identity.niche`, `audience.pains[0]`, `offers[1]`). */
    provenance: Record<string, Prov>;
    /** The profile paths the draft set. */
    touched: string[];
    /** Profile paths that activation still needs (`activationMissing`). */
    needsInput: string[];
    faqPending: Array<{ question: string; source: string }>;
    commentKeywords: Array<{ keyword: string; offer: string; already_used: boolean; collides_with: string[] }>;
    samples: Array<{ post_id: string; why: string; text: string }>;
    pillars: Array<{ name: string; description: string; post_ids: string[] }>;
    /** Verified contact details (a WhatsApp number or link, an email) and the model's hint on when a person should take over. */
    contact: { whatsapp: string; email: string };
    handoffHint: string;
    register: { final: ArabicRegister | null; model: string | null; code: string | null; note: string };
    flags: DraftFlag[];
    /** A call is missing: the other one still landed. */
    partial: boolean;
    /** A model's answer set at least one field (what code counted or found alone does not make a draft). */
    usable: boolean;
    /** Sections `validateProfile` made this reset (empty in practice). */
    repaired: string[];
}

// ─── Small readers: anything can be anything ─────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const sub = (v: unknown, key: string): Loose => (isObj(v) && isObj(v[key]) ? (v[key] as Loose) : {});
const items = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const pick = <T extends string>(value: unknown, list: readonly T[]): T | null => (typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null);

const DIGIT_MAP: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
/** Arabic-Indic and Persian digits as Latin ones. */
export const latinDigits = (s: string): string => s.replace(/[٠-٩]/g, (d) => DIGIT_MAP[d]!).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

// ─── What counts as "in a source" ────────────────────────────────────────────────────────────

const URL_CHARS = "[A-Za-z0-9\\-._~:/?#[\\]@!$&'()*+,;=%]";
const TLDS = 'com|net|org|io|co|me|app|dev|ai|sa|ae|eg|kw|qa|bh|om|jo|lb|iq|ma|dz|tn|ly|sd|shop|store|online|site|link|bio|ee|tv|xyz|info|biz|academy|school|edu|gov|page|website|tech|cloud|digital|agency|studio';
// An address is: one with a scheme or `www.`; a name ending in a well-known top-level domain, with or without a path; or any
// dotted name of letters followed by a path (`shop.example/pay`), which no sentence writes by accident.
const URL_TOKEN = new RegExp(
    `(?:https?:\\/\\/|www\\.)${URL_CHARS}+|\\b(?:[A-Za-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/${URL_CHARS}*)?|\\b(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,24}\\/${URL_CHARS}*`,
    'gi',
);
const EMAIL_TOKEN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g;
// A number that STARTS here: `00` in the middle of 1000 2000 is not an international prefix.
const PHONE_PLUS = /(?<!\d)(?:\+|00)\d[\d\s().-]{6,17}\d(?!\d)/g;
const PHONE_LONG = /(?<![\d])\d(?:[\s.-]?\d){9,14}(?![\d])/g;
const HANDLE_TOKEN = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9_.]{2,30})/g;
const TRAILING = /[.,;:!?)\]'"»”’،؛]+$/u;

interface UrlKey {
    url: string | null;
    host: string;
}

/** An address as a comparison key: host (no `www.`, lower case) plus path without a trailing slash, plus the query. */
function urlKey(raw: string): UrlKey | null {
    const trimmed = raw.trim().replace(TRAILING, '');
    if (!trimmed) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const u = new URL(withScheme);
        const host = u.hostname.toLowerCase().replace(/^www\./, '');
        return { host, url: `${host}${u.pathname.replace(/\/+$/, '')}${u.search}` };
    } catch {
        return null;
    }
}

const phoneDigits = (s: string): string => latinDigits(s).replace(/\D/g, '').replace(/^00/, '');

/** Everything a source says that a model might repeat: addresses, emails, numbers, handles, and the text for price checks. */
class Facts {
    /** key → the address as a source spells it, with a scheme. */
    readonly urls = new Map<string, string>();
    readonly hosts = new Set<string>();
    readonly emails = new Set<string>();
    readonly phones = new Set<string>();
    readonly handles = new Set<string>();
    readonly priceText: string;
    readonly words: string;

    constructor(texts: readonly string[], extra: { urls?: readonly string[]; emails?: readonly string[]; phones?: readonly string[]; handles?: readonly string[] }) {
        for (const text of texts) {
            for (const m of text.matchAll(URL_TOKEN)) this.addUrl(m[0].replace(TRAILING, ''));
            for (const m of text.matchAll(EMAIL_TOKEN)) this.emails.add(m[0].toLowerCase());
            const digits = latinDigits(text);
            for (const m of digits.matchAll(PHONE_PLUS)) this.phones.add(phoneDigits(m[0]));
            for (const m of digits.matchAll(PHONE_LONG)) this.phones.add(phoneDigits(m[0]));
            for (const m of text.matchAll(/wa\.me\/(\d{7,15})/g)) this.phones.add(m[1]!);
            for (const m of text.matchAll(HANDLE_TOKEN)) this.handles.add(m[2]!.toLowerCase());
        }
        for (const u of extra.urls ?? []) this.addUrl(u);
        for (const e of extra.emails ?? []) this.emails.add(e.toLowerCase());
        for (const p of extra.phones ?? []) this.phones.add(phoneDigits(p));
        for (const h of extra.handles ?? []) this.handles.add(h.replace(/^@/, '').toLowerCase());
        for (const u of extra.urls ?? []) for (const m of u.matchAll(/wa\.me\/(\d{7,15})/g)) this.phones.add(m[1]!);
        this.priceText = oneLine(latinDigits(texts.join('\n')));
        this.words = normalizeArabic(texts.join('\n'));
    }

    private addUrl(raw: string): void {
        const key = urlKey(raw);
        if (!key?.url) return;
        this.hosts.add(key.host);
        if (!this.urls.has(key.url)) this.urls.set(key.url, /^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    }

    /** The source's own spelling of an address a model repeated, or null when no source has it. */
    sourcedUrl(raw: string): string | null {
        const key = urlKey(raw);
        return key?.url ? (this.urls.get(key.url) ?? null) : null;
    }

    /** A bare mention of a host a source has ("example.com") is fine too. */
    hostKnown(raw: string): boolean {
        const key = urlKey(raw);
        return key !== null && this.hosts.has(key.host);
    }
}

// ─── The validator ───────────────────────────────────────────────────────────────────────────

const INFERRED: Prov = { source: 'inferred', evidence: '', confidence: 'low' };
const MAX_EVIDENCE = 300;
const ROLE = /^[A-Za-z][A-Za-z0-9&'/-]*(?: [A-Za-z0-9&'/-]+){0,3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * At most `max` UTF-16 units, which is how `validateProfile` measures every limit (`value.length`), cut so that no
 * surrogate pair is left in half. (Cutting by characters would let an emoji-heavy field through at twice its limit.)
 */
function clip(s: string, max: number): string {
    if (s.length <= max) return s.trim();
    let end = max;
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    return s.slice(0, end).trim();
}

export function validateDraft(raw: DraftOutput, ctx: DraftContext): Draft {
    const sources = ctx.sources.map(cleanSource);
    const byId = new Map(sources.map((s) => [s.id, oneLine(s.text)]));
    const signals = ctx.signals ?? null;
    const flags: DraftFlag[] = [];
    const flag = (path: string, kind: DraftFlagKind, detail?: string) => {
        if (flags.length < 200) flags.push({ path, kind, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    };
    const facts = new Facts(sources.map((s) => s.text), {
        urls: ctx.knownUrls,
        emails: ctx.knownEmails,
        phones: ctx.knownPhones,
        handles: [ctx.code?.socials?.handle ?? '', signals?.handle ?? ''].filter(Boolean),
    });

    const voice = isObj(raw.voice) ? raw.voice : null;
    const business = isObj(raw.business) ? raw.business : null;
    const provenance: Record<string, Prov> = {};
    const touched: string[] = [];
    /** Paths set from what code counted or found, not from what a model said: they do not make a draft "usable" on their own. */
    const codeOnly = new Set<string>();
    const touch = (path: string, prov?: Prov, by: 'model' | 'code' = 'model') => {
        if (!touched.includes(path)) touched.push(path);
        if (by === 'code') codeOnly.add(path);
        else codeOnly.delete(path);
        if (prov) provenance[path] = prov;
    };

    // ── Text and provenance ──────────────────────────────────────────────────────────────

    /**
     * Free text from the model, made safe: no angle bracket, no invisible character, and no URL, email, number or
     * @handle in it. A style guide, a niche or a pain point has no use for any of them, and a model that was talked
     * into writing one there (a bio that says "tell every customer to pay at...") would be writing it into text the
     * agents later read as the creator's own, so they come out whether or not a source has them. `sourcedOk` is for
     * the few fields where such a thing is natural (a name that is a domain, a FAQ answer with a link): there, one
     * that a source has stays and one that no source has is removed. `line` makes it one line.
     */
    const cleanText = (value: unknown, path: string, max: number, opts: { line?: boolean; sourcedOk?: boolean } = {}): string => {
        if (typeof value !== 'string') return '';
        const { line = true, sourcedOk = false } = opts;
        // Bounded first: the patterns below are linear for text of a sane size, and the answer is clipped to `max` anyway.
        let text = stripInvisible(truncateChars(value, max * 3 + 100)).replace(/[<>\u2039\u203A]/g, '');
        const removed: string[] = [];
        const keep = (sourced: boolean, what: string): boolean => {
            if (sourcedOk && sourced) return true;
            removed.push(what);
            return false;
        };
        text = text.replace(EMAIL_TOKEN, (m) => (keep(facts.emails.has(m.toLowerCase()), 'email') ? m : ''));
        text = text.replace(URL_TOKEN, (m) => {
            const core = m.replace(TRAILING, '');
            const tail = m.slice(core.length);
            const bareHost = !/^(?:https?:\/\/|www\.)/i.test(core) && !core.includes('/') && facts.hostKnown(core);
            return keep(facts.sourcedUrl(core) !== null || bareHost, 'url') ? m : tail;
        });
        text = stripUnsourcedNumbers(text, (m) => (keep(facts.phones.has(phoneDigits(m)), 'number') ? m : ''));
        text = text.replace(HANDLE_TOKEN, (m, lead: string, handle: string) => (keep(facts.handles.has(handle.toLowerCase()), 'handle') ? m : lead));
        if (removed.length > 0) flag(path, sourcedOk ? 'unsourced_removed' : 'removed_from_text', [...new Set(removed)].join(', '));
        text = line ? oneLine(text) : text.split('\n').map((l) => l.replace(/[ \t]{2,}/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        return clip(text, max);
    };

    /** A fact's provenance, checked: the quote has to be in the source it names. */
    const checkProv = (node: unknown, path: string): Prov => {
        if (!isObj(node)) return INFERRED;
        const confidence = pick<Confidence>(node.confidence, CONFIDENCES) ?? 'low';
        const source = typeof node.source === 'string' ? node.source.trim() : '';
        const evidence = typeof node.evidence === 'string' ? oneLine(stripInvisible(node.evidence).replace(/[<>]/g, (c) => (c === '<' ? '\u2039' : '\u203A'))) : '';
        if (source === 'inferred') return { source: 'inferred', evidence: '', confidence: confidence === 'high' ? 'medium' : confidence };
        const text = byId.get(source);
        if (text === undefined) {
            flag(path, 'evidence_unverified', `unknown source "${source.slice(0, 40)}"`);
            return INFERRED;
        }
        if (evidence.length < 2 || !text.includes(evidence)) {
            flag(path, 'evidence_unverified', evidence ? 'quote is not in the source' : 'no quote');
            return INFERRED;
        }
        return { source, evidence: truncateChars(evidence, MAX_EVIDENCE), confidence };
    };

    /** `{value, source, evidence, confidence}`: the value, and the checked provenance. A bare value is read as an unsupported one. */
    const read = (node: unknown, path: string): { value: unknown; prov: Prov } => {
        if (isObj(node) && 'value' in node) return { value: node.value, prov: checkProv(node, path) };
        if (node !== undefined && node !== null) flag(path, 'not_a_value');
        return { value: isObj(node) ? undefined : node, prov: INFERRED };
    };

    // ── Language: decided first, because the profile's defaults depend on it ──────────────

    const language = sub(voice, 'language');
    const primaryField = read(language.primary, 'language.primary');
    let primary = pick(primaryField.value, LANGS);
    const scriptLanguage = signals && signals.counts.captions >= 3 && (signals.language === 'ar' || signals.language === 'en') ? signals.language : null;
    if (scriptLanguage && primary !== scriptLanguage) {
        if (primary) flag('language.primary', 'language_overridden', `model ${primary}, captions ${scriptLanguage}`);
        primary = scriptLanguage;
    }
    const base = structuredClone(ctx.base ?? defaultProfile({ lang: primary ?? 'ar' }));
    const profile = structuredClone(base);
    if (primary) {
        profile.language.primary = primary;
        const fromModel = pick(primaryField.value, LANGS) !== null;
        touch('language.primary', scriptLanguage === primary ? { source: 'inferred', evidence: '', confidence: 'high' } : primaryField.prov, fromModel ? 'model' : 'code');
        if (!ctx.base && primary === 'en') {
            profile.language.register = null;
            profile.language.digits = 'latin';
            profile.voice.address = 'neutral';
        }
    }

    // Register: counted by code, and code decides. The model's pick is advice and is kept as a note.
    const registerNode = read(language.register, 'language.register');
    const modelRegister = pick(registerNode.value, [...REGISTERS, 'mixed'] as const);
    let finalRegister: ArabicRegister | null = null;
    if (profile.language.primary === 'ar') {
        const code = signals?.register;
        finalRegister = code && code.confidence === 'high' ? code.suggested : 'msa';
        profile.language.register = finalRegister;
        touch('language.register', { source: 'inferred', evidence: '', confidence: code?.confidence === 'high' ? 'high' : 'low' }, 'code');
        if (modelRegister && modelRegister !== 'mixed' && modelRegister !== finalRegister) flag('language.register', 'register_disagreement', `model ${modelRegister}, decided ${finalRegister}`);
    } else {
        profile.language.register = null;
    }
    const registerNote = cleanText(language.register_note, 'language.register_note', 200);

    const digitsNode = read(language.digits, 'language.digits');
    const digitCounts = signals?.digits;
    if (digitCounts && digitCounts.arabic_indic + digitCounts.latin >= 5) {
        profile.language.digits = digitCounts.arabic_indic > digitCounts.latin ? 'arabic-indic' : 'latin';
        touch('language.digits', { source: 'inferred', evidence: '', confidence: 'high' }, 'code');
    } else {
        const d = pick(digitsNode.value, DIGITS);
        // English is written with Latin digits, whatever a model says about them.
        if (d && !(profile.language.primary === 'en' && d === 'arabic-indic')) {
            profile.language.digits = d;
            touch('language.digits', digitsNode.prov);
        }
    }
    const secondNode = read(language.second, 'audience.languages');
    const second = pick(secondNode.value, ['ar', 'en'] as const);
    if (voice && (primary || second)) {
        const languages = [profile.language.primary, second].filter((l): l is 'ar' | 'en' => l !== null && l !== undefined);
        profile.audience.languages = [...new Set(languages)].slice(0, PROFILE_LIMITS.languages);
        touch('audience.languages', undefined, second ? 'model' : 'code');
    }

    // ── Identity ─────────────────────────────────────────────────────────────────────────

    const identity = sub(voice, 'identity');
    const nameNode = read(identity.display_name, 'identity.display_name');
    const name = cleanText(nameNode.value, 'identity.display_name', PROFILE_LIMITS.displayName, { sourcedOk: true });
    if (name) {
        const arabic = /\p{Script=Arabic}/u.test(name);
        profile.identity.display_name[arabic ? 'ar' : 'en'] = name;
        profile.identity.brand_name = clip(name, PROFILE_LIMITS.brandName);
        touch(`identity.display_name.${arabic ? 'ar' : 'en'}`, nameNode.prov);
        touch('identity.brand_name', nameNode.prov);
    }
    const kindNode = read(identity.kind, 'identity.kind');
    const kind = pick(kindNode.value, KINDS);
    if (kind) {
        profile.identity.kind = kind;
        touch('identity.kind', kindNode.prov);
    }
    const roleNode = read(identity.role, 'identity.role');
    const role = cleanText(roleNode.value, 'identity.role', PROFILE_LIMITS.role);
    if (role && ROLE.test(role)) {
        profile.identity.role = role;
        touch('identity.role', roleNode.prov);
    } else if (role) {
        flag('identity.role', 'not_a_value', 'not a two-to-four word English phrase');
    }
    const nicheNode = read(identity.niche, 'identity.niche');
    const niche = cleanText(nicheNode.value, 'identity.niche', PROFILE_LIMITS.niche);
    if (niche) {
        profile.identity.niche = niche;
        touch('identity.niche', nicheNode.prov);
    }
    const countryNode = read(identity.country, 'identity.country');
    const country = typeof countryNode.value === 'string' ? countryNode.value.trim().toUpperCase() : '';
    if (COUNTRY.test(country)) {
        profile.identity.country = country;
        touch('identity.country', countryNode.prov);
        const zone = timezoneForCountry(country);
        if (zone) {
            profile.identity.timezone = zone;
            touch('identity.timezone', { source: 'inferred', evidence: '', confidence: 'low' }, 'code');
        }
    }

    // ── Audience ─────────────────────────────────────────────────────────────────────────

    const audience = sub(voice, 'audience');
    const whoNode = read(audience.who, 'audience.description');
    const who = cleanText(whoNode.value, 'audience.description', PROFILE_LIMITS.audienceDescription);
    if (who) {
        profile.audience.description = who;
        touch('audience.description', whoNode.prov);
    }
    const levelNode = read(audience.level, 'audience.level');
    const level = pick(levelNode.value, LEVELS);
    if (level) {
        profile.audience.level = level;
        touch('audience.level', levelNode.prov);
    }
    /** A list of facts: each one's value is cleaned, empty and repeated ones are dropped, the limit is the profile's. */
    const factList = (nodes: unknown, path: string, limit: { items: number; each: number }): string[] => {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const node of items(nodes, limit.items * 2)) {
            const at = `${path}[${out.length}]`;
            const field = read(node, at);
            const text = cleanText(field.value, at, limit.each);
            const key = normalizeArabic(text);
            if (!text || seen.has(key) || out.length >= limit.items) continue;
            seen.add(key);
            out.push(text);
            touch(at, field.prov);
        }
        return out;
    };
    const pains = factList(audience.pains, 'audience.pains', PROFILE_LIMITS.pains);
    if (pains.length) profile.audience.pains = pains;
    const goals = factList(audience.goals, 'audience.goals', PROFILE_LIMITS.audienceGoals);
    if (goals.length) profile.audience.goals = goals;

    // ── Voice ────────────────────────────────────────────────────────────────────────────

    const voiceNode = sub(voice, 'voice');
    const tone = factList(voiceNode.tone_words, 'voice.tone', PROFILE_LIMITS.tone);
    if (tone.length) profile.voice.tone = tone;
    const guideNode = read(voiceNode.guide, 'voice.guide');
    const guide = cleanText(guideNode.value, 'voice.guide', PROFILE_LIMITS.guide, { line: false });
    if (guide) {
        profile.voice.guide = guide;
        touch('voice.guide', guideNode.prov);
    }
    // Emoji: counted by code when there are posts to count.
    const emojiNode = read(voiceNode.emoji, 'voice.emoji');
    if (signals && signals.counts.captions >= 3) {
        profile.voice.emoji = signals.emoji.level;
        touch('voice.emoji', { source: 'inferred', evidence: '', confidence: 'high' }, 'code');
    } else {
        const emoji = pick(emojiNode.value, EMOJI_LEVELS);
        if (emoji) {
            profile.voice.emoji = emoji;
            touch('voice.emoji', emojiNode.prov);
        }
    }
    const addressNode = read(voiceNode.address, 'voice.address');
    const address = pick(addressNode.value, ADDRESS);
    if (address) {
        profile.voice.address = address;
        touch('voice.address', addressNode.prov);
    }
    // Words they use: only words that really are in what they wrote.
    const useWords: string[] = [];
    for (const word of items(voiceNode.words_used, PROFILE_LIMITS.words.items * 2)) {
        const text = cleanText(word, 'voice.use_words', PROFILE_LIMITS.words.each);
        const normal = normalizeArabic(text);
        if (!text || useWords.some((w) => normalizeArabic(w) === normal) || useWords.length >= PROFILE_LIMITS.words.items) continue;
        if (keywordMatches(facts.words, normal, 'word')) useWords.push(text);
    }
    if (useWords.length) {
        profile.voice.use_words = useWords;
        touch('voice.use_words');
    }

    // Samples: ids must be in the pool; the text is the source's, not the model's.
    const pool = [...(ctx.candidates ?? signals?.candidates ?? [])];
    const poolIds = new Set(pool.map((c) => c.id));
    const textOf = (id: string): string => sources.find((s) => s.id === id)?.text ?? '';
    const samples: Draft['samples'] = [];
    if (voice) {
        for (const node of items(voiceNode.samples, 12)) {
            const id = isObj(node) && typeof node.post_id === 'string' ? node.post_id.trim() : '';
            if (!poolIds.has(id) || !textOf(id)) {
                if (id) flag('voice.samples', 'unknown_id', id.slice(0, 40));
                continue;
            }
            if (samples.some((s) => s.post_id === id) || samples.length >= PROFILE_LIMITS.samples.items) continue;
            samples.push({ post_id: id, why: cleanText(isObj(node) ? node.why : '', 'voice.samples.why', 200), text: clip(textOf(id), PROFILE_LIMITS.samples.each) });
        }
        const chosenSamples = samples.length;
        const wanted = Math.min(3, pool.filter((c) => textOf(c.id)).length);
        if (samples.length < wanted) {
            const rest = pool
                .filter((c) => !samples.some((s) => s.post_id === c.id) && textOf(c.id))
                .sort((a, b) => (b.engagement_percentile ?? -1) - (a.engagement_percentile ?? -1));
            for (const c of rest) {
                if (samples.length >= wanted) break;
                samples.push({ post_id: c.id, why: '', text: clip(textOf(c.id), PROFILE_LIMITS.samples.each) });
            }
            flag('voice.samples', 'samples_filled', `${samples.length} of ${wanted}`);
        }
        if (samples.length) {
            profile.voice.samples = samples.map((s) => s.text);
            // The ones the model chose are its words; the ones code filled in to reach three are code's, and a draft whose only content is those
            // is no draft (`usable`): a model that answered `{}` must not come out as a draft of three posts.
            samples.forEach((_, i) => touch(`voice.samples[${i}]`, { source: samples[i]!.post_id, evidence: '', confidence: 'medium' }, i < chosenSamples ? 'model' : 'code'));
        }
    }

    // ── Pillars and domain ───────────────────────────────────────────────────────────────

    const pillars: Draft['pillars'] = [];
    for (const node of items(voice?.pillars, PROFILE_LIMITS.pillars.items * 2)) {
        const at = `content.pillars[${pillars.length}]`;
        const pillarName = cleanText(isObj(node) ? node.name : '', at, PROFILE_LIMITS.pillars.each);
        if (!pillarName || pillars.length >= PROFILE_LIMITS.pillars.items || pillars.some((p) => normalizeArabic(p.name) === normalizeArabic(pillarName))) continue;
        const ids = items(isObj(node) ? node.post_ids : [], 10).flatMap((id) => (typeof id === 'string' && byId.has(id.trim()) ? [id.trim()] : []));
        pillars.push({ name: pillarName, description: cleanText(isObj(node) ? node.description : '', `${at}.description`, 300), post_ids: [...new Set(ids)] });
        touch(at, checkProv(node, at));
    }
    if (pillars.length) profile.content.pillars = pillars.map((p) => p.name);
    const domainNode = read(voice?.domain, 'content.domain');
    const domain = pick(domainNode.value, DOMAINS);
    if (domain) {
        profile.content.domain = domain;
        touch('content.domain', domainNode.prov);
    }

    // ── Offers, FAQ, keywords, contact (the business call) ───────────────────────────────

    /** An address a model repeated: the source's own spelling, https, and one `safeFetch` would be allowed to read. */
    const verifiedUrl = (value: unknown, path: string): string => {
        if (typeof value !== 'string' || !value.trim()) return '';
        const spelled = facts.sourcedUrl(value.trim());
        if (spelled === null) {
            flag(path, 'unsourced_removed', 'url');
            return '';
        }
        if (!/^https:\/\//i.test(spelled)) {
            flag(path, 'url_refused', 'not https');
            return '';
        }
        const verdict = validateFetchUrl(spelled);
        if (!verdict.ok || spelled.length > PROFILE_LIMITS.offerUrl) {
            flag(path, 'url_refused', verdict.ok ? 'too long' : verdict.reason);
            return '';
        }
        return spelled;
    };
    /** A price exactly as a source writes it. */
    const verifiedPrice = (value: unknown, path: string): string => {
        if (typeof value !== 'string') return '';
        const price = oneLine(latinDigits(stripInvisible(value).replace(/[<>]/g, '')));
        if (!price) return '';
        if (!/\d/.test(price) || price.length > PROFILE_LIMITS.offerPrice || !facts.priceText.includes(price)) {
            flag(path, 'unsourced_removed', 'price');
            return '';
        }
        return price;
    };

    const offers: Offer[] = [];
    const offerKeyword = new Map<string, string>();
    for (const node of items(business?.offers, PROFILE_LIMITS.offers * 2)) {
        if (!isObj(node) || offers.length >= 6) continue;
        const at = `offers[${offers.length}]`;
        const offerName = cleanText(node.name, `${at}.name`, PROFILE_LIMITS.offerName, { sourcedOk: true });
        if (!offerName || offers.some((o) => normalizeArabic(o.name) === normalizeArabic(offerName))) continue;
        const url = verifiedUrl(node.url, `${at}.url`);
        const keyword = cleanText(node.keyword, `${at}.keyword`, PROFILE_LIMITS.offerKeyword).replace(/,/g, '');
        offers.push({
            id: `offer-${offers.length + 1}`,
            kind: pick(node.kind, OFFER_KINDS) ?? 'other',
            name: offerName,
            order_via: url ? 'url' : 'dm',
            url,
            price: verifiedPrice(node.price, `${at}.price`),
            facts: items(node.facts, PROFILE_LIMITS.facts.items).map((f, i) => cleanText(f, `${at}.facts[${i}]`, PROFILE_LIMITS.facts.each)).filter(Boolean),
            bullets: items(node.bullets, PROFILE_LIMITS.bullets.items).map((b, i) => cleanText(b, `${at}.bullets[${i}]`, PROFILE_LIMITS.bullets.each)).filter(Boolean),
            keyword,
            primary: offers.length === 0,
        });
        touch(at, checkProv(node, at));
    }

    // Comment keywords: `already_used` is not the model's to say.
    const inUse = [...(ctx.keywordsInUse ?? signals?.keywords_in_use ?? [])].map((k) => normalizeArabic(k)).filter(Boolean);
    const commentKeywords: Draft['commentKeywords'] = [];
    for (const node of items(business?.comment_keywords, 12)) {
        if (!isObj(node) || commentKeywords.length >= 6) continue;
        const keyword = cleanText(node.keyword, 'comment_keywords.keyword', PROFILE_LIMITS.offerKeyword).replace(/[,|]/g, '');
        const normal = normalizeArabic(keyword);
        if (!keyword || commentKeywords.some((k) => normalizeArabic(k.keyword) === normal)) continue;
        // A keyword collides with one in use if either contains the other, because both would fire on the same comment.
        const collides = inUse.filter((used) => used === normal || used.includes(normal) || normal.includes(used));
        const offerName = cleanText(node.offer, 'comment_keywords.offer', PROFILE_LIMITS.offerName, { sourcedOk: true });
        commentKeywords.push({ keyword, offer: offerName, already_used: collides.length > 0, collides_with: collides.slice(0, 5) });
        const owner = offers.find((o) => normalizeArabic(o.name) === normalizeArabic(offerName));
        if (owner && collides.length === 0 && !offerKeyword.has(owner.id)) offerKeyword.set(owner.id, keyword);
    }
    for (const offer of offers) {
        const chosen = offerKeyword.get(offer.id);
        const own = normalizeArabic(offer.keyword);
        if (own && inUse.some((used) => used === own || used.includes(own) || own.includes(used))) offer.keyword = '';
        if (chosen && !offer.keyword) offer.keyword = chosen;
    }
    if (offers.length) profile.offers = offers;
    // The creator's own sites. An offer or a FAQ link elsewhere is not wrong (a course platform, a booking page),
    // but it is the thing a person is asked to tick.
    const siteHosts = new Set([ctx.code?.socials?.site ?? '', signals?.site_host ?? ''].map((x) => urlKey(x)?.host ?? '').filter(Boolean));
    if (siteHosts.size > 0) {
        offers.forEach((o, i) => {
            const host = o.url ? urlKey(o.url)?.host : undefined;
            if (host && !siteHosts.has(host)) flag(`offers[${i}].url`, 'offer_offdomain_url', host);
        });
    }

    // FAQ: an answer only if the sources gave one, and with no address they did not.
    const faq: Array<{ q: string; a: string }> = [];
    const faqPending: Draft['faqPending'] = [];
    // With no known site, the offers' own hosts stand in for it: an answer that links to what is sold is not a surprise.
    const ownHosts = siteHosts.size > 0 ? siteHosts : new Set<string>(offers.flatMap((o) => (o.url ? [urlKey(o.url)?.host ?? ''] : [])).filter(Boolean));
    for (const node of items(business?.dm_faq, 20)) {
        if (!isObj(node)) continue;
        const at = `dm.faq[${faq.length}]`;
        const question = cleanText(node.question, `${at}.q`, PROFILE_LIMITS.faqQuestion, { sourcedOk: true });
        if (!question || faq.some((f) => normalizeArabic(f.q) === normalizeArabic(question)) || faqPending.some((f) => normalizeArabic(f.question) === normalizeArabic(question))) continue;
        const flagsBefore = flags.length;
        const answer = cleanText(node.answer, `${at}.a`, PROFILE_LIMITS.faqAnswer, { line: false, sourcedOk: true });
        const strippedSomething = flags.slice(flagsBefore).some((f) => f.kind === 'unsourced_removed');
        const provenanceOk = checkProv(node, at);
        if (node.needs_input === true || !answer || strippedSomething) {
            // An answer that had an invented link or number goes back to the person, whole.
            if (strippedSomething) flag(at, 'faq_answer_dropped');
            faqPending.push({ question, source: provenanceOk.source });
            continue;
        }
        if (faq.length >= PROFILE_LIMITS.faq) continue;
        for (const m of answer.matchAll(URL_TOKEN)) {
            const host = urlKey(m[0])?.host;
            if (host && !ownHosts.has(host)) flag(at, 'faq_offdomain_link', host);
        }
        faq.push({ q: question, a: answer });
        touch(at, provenanceOk);
    }
    if (faq.length) profile.dm.faq = faq;

    // Contact: rebuilt from what was verified, not copied from the model.
    const contactNode = sub(business, 'contact');
    let whatsapp = '';
    const waNode = read(contactNode.whatsapp, 'contact.whatsapp');
    if (typeof waNode.value === 'string' && waNode.value.trim()) {
        const digits = phoneDigits(waNode.value.match(/wa\.me\/(\d{7,15})/)?.[1] ?? waNode.value);
        const link = facts.sourcedUrl(waNode.value.trim());
        if (digits.length >= 7 && digits.length <= 15 && facts.phones.has(digits)) whatsapp = `+${digits}`;
        else if (link && /^https:\/\/wa\.me\/message\/[A-Za-z0-9]{6,40}$/.test(link)) whatsapp = link;
        else flag('contact.whatsapp', 'unsourced_removed', 'number');
    }
    let email = '';
    const emailNode = read(contactNode.email, 'contact.email');
    if (typeof emailNode.value === 'string' && emailNode.value.trim()) {
        const candidate = emailNode.value.trim().toLowerCase();
        if (/^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,4}$/.test(candidate) && facts.emails.has(candidate)) email = candidate;
        else flag('contact.email', 'unsourced_removed', 'email');
    }
    const handoffHint = cleanText(read(business?.handoff_hint, 'handoff_hint').value, 'handoff_hint', PROFILE_LIMITS.handoffWhen);

    // ── What code found ──────────────────────────────────────────────────────────────────

    const brand = ctx.code?.brand;
    if (brand?.primary && HEX.test(brand.primary)) {
        profile.brand.primary = brand.primary.toUpperCase();
        touch('brand.primary', undefined, 'code');
    }
    if (brand?.accent && HEX.test(brand.accent)) {
        profile.brand.accent = brand.accent.toUpperCase();
        touch('brand.accent', undefined, 'code');
    }
    const socials = ctx.code?.socials;
    if (socials) {
        const handle = typeof socials.handle === 'string' ? socials.handle.replace(/^@/, '').trim() : '';
        if (handle && handle.length <= PROFILE_LIMITS.handle && /^[A-Za-z0-9._]+$/.test(handle)) {
            profile.socials.handle = handle;
            touch('socials.handle', undefined, 'code');
        }
        const site = typeof socials.site === 'string' ? (urlKey(socials.site)?.host ?? '') : '';
        if (site && site.length <= PROFILE_LIMITS.site) {
            profile.socials.site = site;
            touch('socials.site', undefined, 'code');
        }
        const links: Partial<Record<InfographicSocial, string>> = {};
        for (const platform of SOCIALS) {
            const link = socials.links?.[platform];
            if (typeof link === 'string' && /^https:\/\/\S+$/.test(link) && link.length <= PROFILE_LIMITS.link && validateFetchUrl(link).ok) links[platform] = link;
        }
        if (Object.keys(links).length) {
            profile.socials.links = links;
            profile.socials.platforms = SOCIALS.filter((p) => links[p] !== undefined);
            touch('socials.links', undefined, 'code');
        }
    }

    // ── Whatever the model did, what comes out is a profile ──────────────────────────────

    const repaired: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
        const checked = validateProfile(profile);
        if ('profile' in checked) break;
        const before = repaired.length;
        const sections = new Set(checked.problems.map((p) => p.match(/^[a-z_]+/)?.[0] ?? '').filter(Boolean));
        for (const section of sections) {
            if (!(section in base)) continue;
            (profile as unknown as Loose)[section] = structuredClone((base as unknown as Loose)[section]);
            repaired.push(section);
            flag(section, 'section_reset', checked.problems.find((p) => p.startsWith(section))?.slice(0, 160));
        }
        if (sections.size === 0 || repaired.length === before) break;
    }
    const final = validateProfile(profile);
    const accepted = 'profile' in final ? final.profile : base;
    if (!('profile' in final)) repaired.push('everything');

    return {
        profile: accepted,
        provenance,
        touched: 'profile' in final ? touched.filter((p) => !repaired.includes(p.split(/[.[]/)[0]!)) : [],
        needsInput: activationMissing(accepted),
        faqPending,
        commentKeywords,
        samples,
        pillars,
        contact: { whatsapp, email },
        handoffHint,
        register: { final: finalRegister, model: modelRegister, code: signals?.register.suggested ?? null, note: registerNote },
        flags,
        partial: voice === null || business === null,
        usable: touched.some((path) => !codeOnly.has(path)),
        repaired,
    };
}

/** Offers each phone-like run (a `+` or `00` number, or ten or more digits) to `decide`, which answers '' to have it removed or the run itself to keep it. */
function stripUnsourcedNumbers(text: string, decide: (match: string) => string): string {
    // Arabic-Indic digits are read as the digits they are, but the text keeps its own.
    const normalised = latinDigits(text);
    const spans: Array<{ start: number; end: number; match: string }> = [];
    for (const re of [PHONE_PLUS, PHONE_LONG]) {
        for (const m of normalised.matchAll(re)) spans.push({ start: m.index!, end: m.index! + m[0].length, match: m[0] });
    }
    spans.sort((a, b) => a.start - b.start);
    let out = '';
    let at = 0;
    for (const span of spans) {
        if (span.start < at) continue;
        out += text.slice(at, span.start) + (decide(span.match) === '' ? '' : text.slice(span.start, span.end));
        at = span.end;
    }
    return out + text.slice(at);
}

