/**
 * What a Creator Profile must hold to be stored (docs/onboarding/01 §1), and what it must hold to
 * switch an agent on (`activationMissing`).
 *
 * Two kinds of limit live here. Those for a field that moves out of the Studio or Growth settings
 * are never lower than the limit that field has today, so a valid Studio or Growth PUT can never
 * produce an invalid profile; `validate.test.ts` finds today's limit by probing the real validators
 * and holds each one to it. The rest are new, and set generously: a limit that cuts a creator off
 * mid-sentence costs more than a long field does.
 *
 * Pure: no database and no settings module (importing `studio/settings.ts` would open the pool), so
 * the few rules copied from it (`UPLOAD_URL`, `OFFER_URL`, the colour and time patterns) are held equal by tests.
 */
import {
    ADDRESS, CONTENT_RULE_PRESETS, DIGITS, DOMAINS, EMOJI_LEVELS, FONTS, KINDS, LANGS, LEVELS, MATCH_MODES, OFFER_KINDS, ON_CAMERA, ORDER_VIA,
    PRONOUNS, PROFILE_SECTIONS, PROOF_KINDS, REGISTERS, SALES_LEVELS, SOCIALS, SURFACES, THEMES,
    type CreatorProfile, type Offer,
} from './types.js';

/** `{ items, each }`: a list of at most `items` entries, each at most `each` characters. */
export interface ListLimit { readonly items: number; readonly each: number }

export const PROFILE_LIMITS = {
    displayName: 40,
    brandName: 80,
    role: 40,
    niche: 120,
    audienceDescription: 600,
    pains: { items: 10, each: 200 },
    audienceGoals: { items: 10, each: 200 },
    /** The Growth settings' own limits for the two lists they share. */
    countries: 30,
    languages: 10,
    guide: 4000,
    /** `dm.voice_guide`: the voice of a chat reply, written the way `guide` is. */
    dmVoiceGuide: 4000,
    samples: { items: 5, each: 2200 },
    tone: { items: 5, each: 30 },
    words: { items: 30, each: 80 },
    neverMention: { items: 30, each: 80 },
    pillars: { items: 7, each: 60 },
    customRules: { items: 10, each: 200 },
    presenterName: 40,
    offers: 10,
    offerId: 40,
    offerName: 200,
    offerUrl: 1000,
    offerPrice: 60,
    facts: { items: 20, each: 60 },
    bullets: { items: 10, each: 200 },
    offerKeyword: 80,
    campaignName: 80,
    campaignKeywords: { items: 20, each: 80 },
    campaignDm: 4000,
    campaignReplies: { items: 10, each: 300 },
    /**
     * `Offer.sales` (docs/DM_SALES_PLAN.md §5). All new, so none has an older limit to stay above; sized for what a person writes about
     * one offer. Every list is capped in items too, since the bot reads all of it on every message: a limit here is also a prompt budget.
     */
    salesForWhom: 300,
    salesOutcomes: { items: 8, each: 160 },
    salesFaqs: 15,
    salesFaqQuestion: 200,
    salesFaqAnswer: 600,
    salesObjections: 10,
    salesObjection: 160,
    salesObjectionAnswer: 600,
    salesProof: 8,
    salesProofText: 300,
    salesProofSource: 120,
    salesPriceNote: 200,
    handle: 32,
    site: 40,
    link: 500,
    faq: 30,
    faqQuestion: 300,
    faqAnswer: 2000,
    handoffWhen: 300,
    handoffMessage: 1000,
    /** A goal is a whole number of followers or views; a billion is well past any account (`GROWTH_LIMITS.goalMax`). */
    goalMax: 1_000_000_000,
    /** The CHECK on `creator_profiles.profile` (01 §3), measured the way Postgres prints jsonb. */
    profileBytes: 131_072,
} as const;

/** The portrait and the logo are our own uploads: the worker fetches them while rendering (`UPLOAD_URL` in studio/settings.ts). */
export const UPLOAD_URL = /^https:\/\/[^\s/]+\/api\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.jpg)?$/i;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const COUNTRY = /^[A-Z]{2}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const MAX_PROBLEMS = 20;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || !value) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/** `YYYY-MM-DD` that is a day on the calendar: 2026-02-30 is not one, though it looks like one. */
export function isCalendarDate(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const at = new Date(Date.UTC(y, mo - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

let currencyCodes: ReadonlySet<string> | undefined;
/**
 * An ISO 4217 code: three capital letters that the runtime's own currency list (`Intl.supportedValuesOf`, ICU's copy of the
 * standard) knows, so 'SAR' and 'USD' pass and 'SAU' does not. A runtime without that list falls back to the shape alone.
 */
export function isCurrencyCode(value: unknown): value is string {
    if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false;
    if (!currencyCodes) {
        try {
            currencyCodes = new Set(Intl.supportedValuesOf('currency'));
        } catch {
            currencyCodes = new Set();
        }
    }
    return currencyCodes.size === 0 || currencyCodes.has(value);
}

/**
 * An offer's address: exactly the Studio's rule for `product.url` (`^https?://\S+$`, in studio/settings.ts),
 * so a link a Studio PUT accepts today never makes an invalid profile. Any other scheme is refused.
 */
export const OFFER_URL = /^https?:\/\/\S+$/i;

/** An https address with a host, for the links that are new with the profile (the social links), where there is no older rule to stay above. */
export function isHttpsUrl(value: string): boolean {
    if (!/^https:\/\/\S+$/i.test(value)) return false;
    try {
        return new URL(value).hostname !== '';
    } catch {
        return false;
    }
}

/** The text Postgres prints for a jsonb value: `{"a": 1, "b": [1, 2]}`, a space after every `:` and `,`. */
function jsonbText(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
    if (isObj(value)) {
        const members = Object.entries(value).filter(([, v]) => v !== undefined);
        return `{${members.map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`).join(', ')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * The size the database constraint measures, `octet_length(profile::text)`. `JSON.stringify` is
 * smaller than that (jsonb adds spaces), so a profile it called small enough could still be refused
 * by the table; this cannot.
 */
export function profileBytes(profile: unknown): number {
    return Buffer.byteLength(jsonbText(profile), 'utf8');
}

/** Every problem in `raw`, as sentences a person can act on. Empty when it is a profile. */
function problemsOf(raw: unknown): string[] {
    const problems: string[] = [];
    const add = (message: string): void => { problems.push(message); };

    // A value that is not there was already reported as missing by the object that should have held it:
    // every check below skips it, so one absent field is one problem and not three.
    /** A plain object with exactly these keys: a missing one and an unknown one are both problems. */
    const object = (value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Obj | null => {
        if (value === undefined) return null;
        if (!isObj(value)) {
            add(`${path} must be an object`);
            return null;
        }
        for (const key of Object.keys(value)) {
            if (value[key] !== undefined && !required.includes(key) && !optional.includes(key)) add(`${path}.${key} is not a profile field`);
        }
        for (const key of required) if (value[key] === undefined) add(`${path}.${key} is required`);
        return value;
    };
    const text = (value: unknown, path: string, max: number, opts: { required?: boolean; line?: boolean } = {}): void => {
        if (value === undefined) return;
        if (typeof value !== 'string') add(`${path} must be text`);
        else if (opts.required && !value.trim()) add(`${path} is required`);
        else if (value.length > max) add(`${path} is ${value.length} characters; the limit is ${max}`);
        else if (opts.line && LINE_BREAK.test(value)) add(`${path} must be one line`);
    };
    const oneOf = (value: unknown, path: string, options: readonly string[]): void => {
        if (value === undefined) return;
        if (typeof value !== 'string' || !options.includes(value)) add(`${path} must be one of ${options.join(', ')}`);
    };
    const colour = (value: unknown, path: string): void => {
        if (value === undefined) return;
        if (typeof value !== 'string' || !HEX_COLOUR.test(value)) add(`${path} must be a colour like #FFD60A`);
    };
    const whole = (value: unknown, path: string, min: number, max: number): void => {
        if (value === undefined) return;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            add(`${path} must be a whole number from ${min} to ${max}`);
        }
    };
    /** A list of at most `max`; each entry is handed to `each`. Reports and returns null when it is no list. */
    const list = (value: unknown, path: string, max: number, each: (v: unknown, p: string) => void): unknown[] | null => {
        if (value === undefined) return null;
        if (!Array.isArray(value)) {
            add(`${path} must be a list`);
            return null;
        }
        if (value.length > max) add(`${path} holds at most ${max}`);
        value.slice(0, max).forEach((v, i) => each(v, `${path}[${i}]`));
        return value;
    };
    const texts = (value: unknown, path: string, limit: ListLimit, opts: { unique?: boolean; line?: boolean } = {}): void => {
        const items = list(value, path, limit.items, (v, p) => text(v, p, limit.each, { required: true, line: opts.line }));
        if (items && opts.unique && new Set(items).size !== items.length) add(`${path} lists the same entry twice`);
    };
    const enums = (value: unknown, path: string, options: readonly string[]): void => {
        const items = list(value, path, options.length, (v, p) => oneOf(v, p, options));
        if (items && new Set(items).size !== items.length) add(`${path} lists the same entry twice`);
    };
    const https = (value: unknown, path: string, max: number, required: boolean): void => {
        text(value, path, max, { required });
        if (typeof value === 'string' && value && !isHttpsUrl(value)) add(`${path} must be a web address starting with https://`);
    };
    const offerUrl = (value: unknown, path: string, max: number): void => {
        text(value, path, max);
        if (typeof value === 'string' && value && !OFFER_URL.test(value)) add(`${path} must be a web address starting with http:// or https://`);
    };
    const upload = (value: unknown, path: string): void => {
        if (value !== undefined && value !== null && (typeof value !== 'string' || !UPLOAD_URL.test(value))) add(`${path} must be one of your uploads (…/api/uploads/<id>), or null`);
    };

    const profile = object(raw ?? null, 'profile', PROFILE_SECTIONS);
    if (!profile) return problems;
    if (profile.schema !== undefined && profile.schema !== 1) add('profile.schema must be 1');

    // identity
    const identity = object(profile.identity, 'identity', ['display_name', 'brand_name', 'kind', 'role', 'niche', 'country', 'timezone']);
    if (identity) {
        const names = object(identity.display_name, 'identity.display_name', ['ar', 'en']);
        if (names) {
            text(names.ar, 'identity.display_name.ar', PROFILE_LIMITS.displayName);
            text(names.en, 'identity.display_name.en', PROFILE_LIMITS.displayName);
        }
        text(identity.brand_name, 'identity.brand_name', PROFILE_LIMITS.brandName);
        if (identity.kind !== null) oneOf(identity.kind, 'identity.kind', KINDS);
        text(identity.role, 'identity.role', PROFILE_LIMITS.role, { line: true });
        text(identity.niche, 'identity.niche', PROFILE_LIMITS.niche, { line: true });
        if (identity.country !== null && (typeof identity.country !== 'string' || !COUNTRY.test(identity.country))) {
            add('identity.country must be a two-letter country code like SA, or null');
        }
        // Empty until chosen (activation asks for it); a value must be a real zone, so a typo can't reach a schedule.
        if (identity.timezone !== '' && !isTimeZone(identity.timezone)) add('identity.timezone must be a timezone like Europe/London or America/New_York');
    }

    // language
    const language = object(profile.language, 'language', ['primary', 'register', 'digits', 'surfaces']);
    if (language) {
        oneOf(language.primary, 'language.primary', LANGS);
        if (language.register !== null) oneOf(language.register, 'language.register', REGISTERS);
        else if (language.primary === 'ar') add('language.register is required when the language is Arabic');
        oneOf(language.digits, 'language.digits', DIGITS);
        const surfaces = object(language.surfaces, 'language.surfaces', [], SURFACES);
        if (surfaces) {
            for (const surface of SURFACES) {
                const one = surfaces[surface];
                if (one === undefined) continue;
                const o = object(one, `language.surfaces.${surface}`, [], ['language', 'register']);
                if (!o) continue;
                if (o.language !== undefined) oneOf(o.language, `language.surfaces.${surface}.language`, LANGS);
                if (o.register !== undefined) oneOf(o.register, `language.surfaces.${surface}.register`, REGISTERS);
                // A surface that speaks Arabic needs a register, its own or the profile's, as the profile itself does.
                const speaks = o.language ?? language.primary;
                if (speaks === 'ar' && o.register === undefined && language.register === null && language.primary !== 'ar') {
                    add(`language.surfaces.${surface}.register is required: the surface speaks Arabic and the profile has no register`);
                }
            }
        }
    }

    // offers
    const offers = list(profile.offers, 'offers', PROFILE_LIMITS.offers, (v, path) => {
        const o = object(v, path, ['id', 'kind', 'name', 'order_via', 'url', 'price', 'facts', 'bullets', 'keyword', 'primary'], ['campaign', 'sales']);
        if (!o) return;
        text(o.id, `${path}.id`, PROFILE_LIMITS.offerId, { required: true });
        oneOf(o.kind, `${path}.kind`, OFFER_KINDS);
        text(o.name, `${path}.name`, PROFILE_LIMITS.offerName);
        oneOf(o.order_via, `${path}.order_via`, ORDER_VIA);
        offerUrl(o.url, `${path}.url`, PROFILE_LIMITS.offerUrl);
        if (o.order_via === 'url' && o.url === '') add(`${path}.url is required when the offer is ordered by link`);
        text(o.price, `${path}.price`, PROFILE_LIMITS.offerPrice);
        texts(o.facts, `${path}.facts`, PROFILE_LIMITS.facts);
        texts(o.bullets, `${path}.bullets`, PROFILE_LIMITS.bullets);
        text(o.keyword, `${path}.keyword`, PROFILE_LIMITS.offerKeyword);
        if (typeof o.primary !== 'boolean') add(`${path}.primary must be true or false`);
        if (o.campaign !== undefined) {
            const c = object(o.campaign, `${path}.campaign`, ['name_match', 'match', 'keywords', 'dm_template', 'public_replies']);
            if (c) {
                text(c.name_match, `${path}.campaign.name_match`, PROFILE_LIMITS.campaignName);
                oneOf(c.match, `${path}.campaign.match`, MATCH_MODES);
                texts(c.keywords, `${path}.campaign.keywords`, PROFILE_LIMITS.campaignKeywords);
                text(c.dm_template, `${path}.campaign.dm_template`, PROFILE_LIMITS.campaignDm, { required: true });
                texts(c.public_replies, `${path}.campaign.public_replies`, PROFILE_LIMITS.campaignReplies);
            }
        }
        if (o.sales !== undefined) {
            const sp = `${path}.sales`;
            const s = object(o.sales, sp, ['for_whom', 'level', 'outcomes', 'faqs', 'objections', 'proof', 'price_note', 'price_valid_until', 'currency', 'image_url']);
            if (s) {
                text(s.for_whom, `${sp}.for_whom`, PROFILE_LIMITS.salesForWhom);
                oneOf(s.level, `${sp}.level`, SALES_LEVELS);
                texts(s.outcomes, `${sp}.outcomes`, PROFILE_LIMITS.salesOutcomes, { line: true });
                list(s.faqs, `${sp}.faqs`, PROFILE_LIMITS.salesFaqs, (f, p) => {
                    const item = object(f, p, ['q', 'a']);
                    if (!item) return;
                    text(item.q, `${p}.q`, PROFILE_LIMITS.salesFaqQuestion, { required: true, line: true });
                    text(item.a, `${p}.a`, PROFILE_LIMITS.salesFaqAnswer, { required: true });
                });
                list(s.objections, `${sp}.objections`, PROFILE_LIMITS.salesObjections, (f, p) => {
                    const item = object(f, p, ['objection', 'answer']);
                    if (!item) return;
                    text(item.objection, `${p}.objection`, PROFILE_LIMITS.salesObjection, { required: true, line: true });
                    text(item.answer, `${p}.answer`, PROFILE_LIMITS.salesObjectionAnswer, { required: true });
                });
                // Proof is only ever real: it needs its words and where they come from, so nothing in it is anonymous.
                list(s.proof, `${sp}.proof`, PROFILE_LIMITS.salesProof, (f, p) => {
                    const item = object(f, p, ['kind', 'text', 'source']);
                    if (!item) return;
                    oneOf(item.kind, `${p}.kind`, PROOF_KINDS);
                    text(item.text, `${p}.text`, PROFILE_LIMITS.salesProofText, { required: true });
                    text(item.source, `${p}.source`, PROFILE_LIMITS.salesProofSource, { required: true, line: true });
                });
                text(s.price_note, `${sp}.price_note`, PROFILE_LIMITS.salesPriceNote);
                // '' is "no date", which is also "the bot states no price" (see `OfferSales`); a date must be one on the calendar.
                if (s.price_valid_until !== undefined) {
                    if (typeof s.price_valid_until !== 'string') add(`${sp}.price_valid_until must be text`);
                    else if (s.price_valid_until !== '' && !isCalendarDate(s.price_valid_until)) add(`${sp}.price_valid_until must be a date like 2026-12-31, or empty`);
                }
                if (s.currency !== undefined) {
                    if (typeof s.currency !== 'string') add(`${sp}.currency must be text`);
                    else if (s.currency !== '' && !isCurrencyCode(s.currency)) add(`${sp}.currency must be a currency code like USD or SAR, or empty`);
                }
                text(s.image_url, `${sp}.image_url`, PROFILE_LIMITS.offerUrl);
                if (typeof s.image_url === 'string' && s.image_url !== '') upload(s.image_url, `${sp}.image_url`);
            }
        }
    });
    if (offers && offers.length > 0) {
        const primaries = offers.filter((o) => isObj(o) && o.primary === true).length;
        if (primaries !== 1) add(`offers needs exactly one primary offer; it has ${primaries}`);
        const ids = offers.flatMap((o) => (isObj(o) && typeof o.id === 'string' ? [o.id] : []));
        if (new Set(ids).size !== ids.length) add('offers has two offers with the same id');
    }

    // audience
    const audience = object(profile.audience, 'audience', ['description', 'level', 'pains', 'goals', 'countries', 'languages'], ['timezone']);
    if (audience) {
        text(audience.description, 'audience.description', PROFILE_LIMITS.audienceDescription);
        if (audience.level !== null) oneOf(audience.level, 'audience.level', LEVELS);
        texts(audience.pains, 'audience.pains', PROFILE_LIMITS.pains);
        texts(audience.goals, 'audience.goals', PROFILE_LIMITS.audienceGoals);
        const countries = list(audience.countries, 'audience.countries', PROFILE_LIMITS.countries, (v, p) => {
            if (typeof v !== 'string' || !COUNTRY.test(v)) add(`${p} must be a two-letter country code like SA`);
        });
        if (countries && new Set(countries).size !== countries.length) add('audience.countries lists the same entry twice');
        const languages = list(audience.languages, 'audience.languages', PROFILE_LIMITS.languages, (v, p) => {
            if (typeof v !== 'string' || !LANGUAGE.test(v)) add(`${p} must be a language code like ar`);
        });
        if (languages && new Set(languages).size !== languages.length) add('audience.languages lists the same entry twice');
        if (audience.timezone !== undefined && !isTimeZone(audience.timezone)) add('audience.timezone must be a timezone like Europe/London or America/New_York');
    }

    // voice
    const voice = object(profile.voice, 'voice', ['guide', 'tone', 'samples', 'use_words', 'avoid_words', 'emoji', 'address']);
    if (voice) {
        text(voice.guide, 'voice.guide', PROFILE_LIMITS.guide);
        texts(voice.tone, 'voice.tone', PROFILE_LIMITS.tone);
        texts(voice.samples, 'voice.samples', PROFILE_LIMITS.samples);
        texts(voice.use_words, 'voice.use_words', PROFILE_LIMITS.words);
        texts(voice.avoid_words, 'voice.avoid_words', PROFILE_LIMITS.words);
        oneOf(voice.emoji, 'voice.emoji', EMOJI_LEVELS);
        oneOf(voice.address, 'voice.address', ADDRESS);
    }

    // presenter
    if (profile.presenter !== null) {
        const presenter = object(profile.presenter, 'presenter', ['name', 'pronouns', 'on_camera']);
        if (presenter) {
            text(presenter.name, 'presenter.name', PROFILE_LIMITS.presenterName);
            oneOf(presenter.pronouns, 'presenter.pronouns', PRONOUNS);
            oneOf(presenter.on_camera, 'presenter.on_camera', ON_CAMERA);
        }
    }

    // content
    const content = object(profile.content, 'content', ['domain', 'pillars', 'never_mention', 'rules', 'custom_rules']);
    if (content) {
        oneOf(content.domain, 'content.domain', DOMAINS);
        texts(content.pillars, 'content.pillars', PROFILE_LIMITS.pillars);
        texts(content.never_mention, 'content.never_mention', PROFILE_LIMITS.neverMention);
        enums(content.rules, 'content.rules', CONTENT_RULE_PRESETS);
        texts(content.custom_rules, 'content.custom_rules', PROFILE_LIMITS.customRules);
    }

    // brand
    const brand = object(profile.brand, 'brand', ['primary', 'accent', 'font_display', 'logo_url', 'portrait_url', 'theme']);
    if (brand) {
        colour(brand.primary, 'brand.primary');
        colour(brand.accent, 'brand.accent');
        oneOf(brand.font_display, 'brand.font_display', FONTS);
        upload(brand.logo_url, 'brand.logo_url');
        upload(brand.portrait_url, 'brand.portrait_url');
        oneOf(brand.theme, 'brand.theme', THEMES);
    }

    // socials
    const socials = object(profile.socials, 'socials', ['handle', 'site', 'platforms', 'links']);
    if (socials) {
        text(socials.handle, 'socials.handle', PROFILE_LIMITS.handle);
        text(socials.site, 'socials.site', PROFILE_LIMITS.site);
        enums(socials.platforms, 'socials.platforms', SOCIALS);
        const links = object(socials.links, 'socials.links', [], SOCIALS);
        if (links) for (const platform of SOCIALS) if (links[platform] !== undefined) https(links[platform], `socials.links.${platform}`, PROFILE_LIMITS.link, true);
    }

    // dm
    const dm = object(profile.dm, 'dm', ['faq', 'handoff', 'hours'], ['voice_guide']);
    if (dm) {
        text(dm.voice_guide, 'dm.voice_guide', PROFILE_LIMITS.dmVoiceGuide);
        list(dm.faq, 'dm.faq', PROFILE_LIMITS.faq, (v, path) => {
            const item = object(v, path, ['q', 'a']);
            if (!item) return;
            text(item.q, `${path}.q`, PROFILE_LIMITS.faqQuestion, { required: true });
            text(item.a, `${path}.a`, PROFILE_LIMITS.faqAnswer, { required: true });
        });
        if (dm.handoff !== null) {
            const handoff = object(dm.handoff, 'dm.handoff', ['when', 'message']);
            if (handoff) {
                text(handoff.when, 'dm.handoff.when', PROFILE_LIMITS.handoffWhen, { required: true });
                text(handoff.message, 'dm.handoff.message', PROFILE_LIMITS.handoffMessage, { required: true });
            }
        }
        if (dm.hours !== null) {
            const hours = object(dm.hours, 'dm.hours', ['days', 'from', 'to']);
            if (hours) {
                const days = list(hours.days, 'dm.hours.days', 7, (v, p) => whole(v, p, 0, 6));
                if (days && days.length === 0) add('dm.hours.days needs at least one day');
                if (days && new Set(days).size !== days.length) add('dm.hours.days lists the same day twice');
                for (const key of ['from', 'to'] as const) {
                    const time = hours[key];
                    if (typeof time !== 'string' || !LOCAL_TIME.test(time)) add(`dm.hours.${key} must be a time like 09:00`);
                }
            }
        }
    }

    // goals
    const goals = object(profile.goals, 'goals', ['followers', 'views']);
    if (goals) {
        whole(goals.followers, 'goals.followers', 1, PROFILE_LIMITS.goalMax);
        whole(goals.views, 'goals.views', 1, PROFILE_LIMITS.goalMax);
    }

    // The whole record, last: its size means nothing for something that is not a profile yet.
    if (problems.length === 0) {
        const bytes = profileBytes(raw);
        if (bytes > PROFILE_LIMITS.profileBytes) add(`the profile is ${bytes} bytes; the limit is ${PROFILE_LIMITS.profileBytes}`);
    }
    return problems;
}

/**
 * `raw` as a stored profile, or every problem that stops it (at most 20). Strict: every field is
 * present and nothing unknown is; a stored profile is read through `upgradeProfile` first, and a
 * partial update is merged onto the current profile before it gets here. The profile returned is a
 * copy, so changing `raw` afterwards cannot change what was accepted.
 */
export function validateProfile(raw: unknown): { profile: CreatorProfile } | { problems: string[] } {
    const problems = problemsOf(raw);
    if (problems.length) return { problems: problems.slice(0, MAX_PROBLEMS) };
    return { profile: structuredClone(raw) as CreatorProfile };
}

/** The primary offer: the one marked `primary`, else (an invalid profile) the first. */
export function primaryOffer(offers: readonly Offer[]): Offer | null {
    return offers.find((o) => o.primary) ?? offers[0] ?? null;
}

/**
 * What is still missing before a tenant can finish the wizard or switch an agent on (D10, 01 §1):
 *
 * - `identity.display_name`: a name, Arabic or English
 * - `identity.kind`, `identity.niche`, `identity.timezone`
 * - `language.primary`, and `language.register` when it is Arabic
 * - `offers.primary.name`: a primary offer with a name; and `offers.primary.url` when it is ordered
 *   by link and has none ("they DM me to order" needs no link)
 *
 * With `dm: true`, the DM bot's own extra: `dm.handoff`, who takes over when it can't answer. Never
 * checked on a running path and never a reason to refuse a view: it only gates switching on.
 */
export function activationMissing(p: CreatorProfile, opts: { dm?: boolean } = {}): string[] {
    const missing: string[] = [];
    if (!p.identity.display_name.ar.trim() && !p.identity.display_name.en.trim()) missing.push('identity.display_name');
    if (p.identity.kind === null) missing.push('identity.kind');
    if (!p.identity.niche.trim()) missing.push('identity.niche');
    if (!p.identity.timezone.trim()) missing.push('identity.timezone');
    if (!(LANGS as readonly string[]).includes(p.language.primary)) missing.push('language.primary');
    else if (p.language.primary === 'ar' && p.language.register === null) missing.push('language.register');
    const offer = primaryOffer(p.offers);
    if (!offer || !offer.name.trim()) missing.push('offers.primary.name');
    if (offer && offer.order_via === 'url' && !offer.url.trim()) missing.push('offers.primary.url');
    if (opts.dm && p.dm.handoff === null) missing.push('dm.handoff');
    return missing;
}
