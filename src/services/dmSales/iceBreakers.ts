/**
 * Ice breakers and the persistent menu (docs/DM_SALES_PLAN.md S13): the buttons an Instagram conversation opens with, as DATA the owner
 * edits, and the exact requests that put them on Instagram. Pure: no database, no network. What stores them is `iceBreakerStore.ts`, what
 * sends them is `instagram.ts`, and the one thing that sends anything is the owner pressing "Publish to Instagram".
 *
 * Meta's pages, read on 2026-10-14 (the numbers below are theirs unless a comment says they are ours):
 *   - Ice breakers   https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/ice-breakers.md
 *       "set a maximum of 4 questions"; the `default` locale is REQUIRED; not on desktop; a tap is a `messaging_postbacks` webhook whose
 *       `postback` holds `title` (the question) and `payload`. The page states no length for a question or a payload.
 *   - Persistent menu https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/persistent-menu.md
 *       buttons of type `postback` (needs `payload`) or `web_url` (needs `url`); "limit menu items to 5" is its best practice, not a hard
 *       limit; `composer_input_disabled` is not available. A tap is a `postback` webhook too. Instagram app v226 or above, iOS or Android.
 *   - The endpoint   https://developers.facebook.com/documentation/business-messaging/messenger-platform/reference/messenger-profile-api.md
 *       one POST sets any number of properties ("only properties set in the request body will be overwritten"), one DELETE with a
 *       `fields` array removes the named ones, one GET with a comma-separated `fields` reads them. A Page access token with
 *       `pages_messaging`. "10 API calls per 10 minute interval ... per Page".
 *   - The webhook    https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks.md
 *
 * **What is ours and not Meta's.** A question is capped at `ICE_BREAKER_QUESTION_MAX` and a menu title at `MENU_TITLE_MAX`: Meta's Instagram
 * pages state neither, so these are conservative caps (the long-standing Messenger limits, from memory and unverified for Instagram) chosen so
 * a button is never cut short on a phone. If Meta refuses a longer one, its own message reaches the owner. The count of four IS Meta's.
 *
 * **A button's payload is one of a short list of codes** (`TAP_CODES`), picked from a list in the editor, and each code stands for an
 * intent of the sales turn (`TAP_INTENT`). That is what "map payloads to intents" is: the code carries what the button asks, so the sales
 * turn knows it without guessing, a menu published months ago still means what it meant, and nothing has to be read from the database to
 * understand a tap. The title is still the person's message, so with `sales_mode` off the old path answers the question as it always
 * answered a typed one.
 */
import { createHash } from 'node:crypto';
import type { KitKey } from '../profile/kits.js';
import type { Intent } from './types.js';

// ─── Limits ──────────────────────────────────────────────────────────────────────────────────

/** Meta: "a maximum of 4 questions". */
export const ICE_BREAKER_MAX = 4;
/** OURS (see the top of the file): the longest question we publish, in characters. */
export const ICE_BREAKER_QUESTION_MAX = 80;
/** Meta's best practice for the persistent menu: "limit menu items to 5". */
export const MENU_ITEMS_MAX = 5;
/** OURS: the longest menu title we publish, in characters. */
export const MENU_TITLE_MAX = 30;
/** The longest link a menu item may carry. */
export const MENU_URL_MAX = 2000;
/** The locale both properties are published under. Meta requires `default`; one set of buttons serves everybody. */
export const PROFILE_LOCALE = 'default';

// ─── What a tap means ────────────────────────────────────────────────────────────────────────

/** The payload codes a button may carry, in the order the editor lists them. */
export const TAP_CODES = ['TAP_INFO', 'TAP_LEVEL', 'TAP_PRICE', 'TAP_LINK', 'TAP_SUPPORT', 'TAP_HUMAN', 'TAP_OTHER'] as const;
export type TapCode = (typeof TAP_CODES)[number];

/** The intent of the sales turn each code stands for (`INTENTS` in `types.ts`). */
export const TAP_INTENT: Readonly<Record<TapCode, Intent>> = Object.freeze({
    TAP_INFO: 'info',
    TAP_LEVEL: 'level_fit',
    TAP_PRICE: 'price',
    TAP_LINK: 'ready_to_buy',
    TAP_SUPPORT: 'support',
    TAP_HUMAN: 'wants_human',
    TAP_OTHER: 'other',
});

export const isTapCode = (value: unknown): value is TapCode => typeof value === 'string' && (TAP_CODES as readonly string[]).includes(value);

/**
 * The intent a tapped button stands for, or null for anything that is not one of ours: a quick reply the sales bot itself offered
 * (its payloads are free text the model wrote), a button from a campaign, a payload from an older menu, nothing at all.
 */
export function intentForPayload(payload: unknown): Intent | null {
    return isTapCode(payload) ? TAP_INTENT[payload] : null;
}

// ─── The shape ───────────────────────────────────────────────────────────────────────────────

export interface IceBreakerItem {
    question: string;
    payload: TapCode;
}

export type MenuItem =
    | { type: 'postback'; title: string; payload: TapCode }
    | { type: 'web_url'; title: string; url: string };

/** What the owner edits, and what a publish sends. */
export interface IceBreakerConfig {
    iceBreakers: IceBreakerItem[];
    menu: MenuItem[];
}

export const EMPTY_CONFIG: IceBreakerConfig = Object.freeze({ iceBreakers: [], menu: [] }) as IceBreakerConfig;

/** The record of the last publish: when, by whom, how many of each, and a fingerprint of what was sent. */
export interface PublishedState {
    at: string;
    by: string | null;
    iceBreakers: number;
    menu: number;
    hash: string;
}

/** One refusal: the field it is about (`iceBreakers[2].question`), a stable code, and a sentence for a log or a person without the dashboard. */
export interface Problem {
    field: string;
    code: 'NOT_A_LIST' | 'TOO_MANY' | 'QUESTION_EMPTY' | 'QUESTION_TOO_LONG' | 'QUESTION_DUPLICATE' | 'TITLE_EMPTY' | 'TITLE_TOO_LONG' | 'BAD_CHARACTERS'
        | 'PAYLOAD_UNKNOWN' | 'TYPE_UNKNOWN' | 'URL_INVALID' | 'NOT_AN_OBJECT';
    message: string;
}

/** The characters in a string, counting a character that takes two UTF-16 units (an emoji) once. */
export const charCount = (s: string): number => [...s].length;

/** Whitespace in a button's words is one space: a line break in a question would be a button no phone lays out the same way. */
const tidy = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** A control character is never a letter of a button. */
const hasControl = (s: string): boolean => /\p{Cc}/u.test(s);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A link a menu item may open: https, a host, no credentials, within `MENU_URL_MAX`. Returned as typed (trimmed), never rewritten. */
export function menuUrlOk(value: string): boolean {
    if (value.length === 0 || value.length > MENU_URL_MAX) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.length > 0 && url.username === '' && url.password === '';
    } catch {
        return false;
    }
}

/**
 * What a person or an API sent, as a config, or every reason it is not one. Strict: an unknown payload is an error that names the field
 * (a typo must not publish a button that answers nothing), nothing is dropped silently, and the result is built field by field so no extra
 * key of the input can reach Meta.
 *
 * Both lists may be empty here (an empty editor is a valid draft); whether there is anything to PUBLISH is `planPublish`'s question.
 */
export function parseConfig(input: unknown): { ok: true; config: IceBreakerConfig } | { ok: false; problems: Problem[] } {
    const problems: Problem[] = [];
    const body = isObject(input) ? input : {};
    const iceBreakers: IceBreakerItem[] = [];
    const menu: MenuItem[] = [];

    const rawIce = body['iceBreakers'] ?? [];
    if (!Array.isArray(rawIce)) {
        problems.push({ field: 'iceBreakers', code: 'NOT_A_LIST', message: 'iceBreakers must be a list.' });
    } else {
        if (rawIce.length > ICE_BREAKER_MAX) {
            problems.push({ field: 'iceBreakers', code: 'TOO_MANY', message: `At most ${ICE_BREAKER_MAX} ice breakers: Meta allows no more.` });
        }
        const seen = new Set<string>();
        rawIce.slice(0, ICE_BREAKER_MAX).forEach((raw, i) => {
            const at = `iceBreakers[${i}]`;
            if (!isObject(raw)) { problems.push({ field: at, code: 'NOT_AN_OBJECT', message: `${at} must be an object.` }); return; }
            const question = tidy(raw['question']);
            let ok = true;
            if (!question) { problems.push({ field: `${at}.question`, code: 'QUESTION_EMPTY', message: 'A question is required.' }); ok = false; }
            else if (hasControl(question)) { problems.push({ field: `${at}.question`, code: 'BAD_CHARACTERS', message: 'A question holds a control character.' }); ok = false; }
            else if (charCount(question) > ICE_BREAKER_QUESTION_MAX) {
                problems.push({ field: `${at}.question`, code: 'QUESTION_TOO_LONG', message: `A question is at most ${ICE_BREAKER_QUESTION_MAX} characters.` });
                ok = false;
            } else if (seen.has(question.toLowerCase())) {
                problems.push({ field: `${at}.question`, code: 'QUESTION_DUPLICATE', message: 'Two ice breakers ask the same question.' });
                ok = false;
            }
            if (!isTapCode(raw['payload'])) { problems.push({ field: `${at}.payload`, code: 'PAYLOAD_UNKNOWN', message: `payload must be one of ${TAP_CODES.join(', ')}.` }); ok = false; }
            if (ok) {
                seen.add(question.toLowerCase());
                iceBreakers.push({ question, payload: raw['payload'] as TapCode });
            }
        });
    }

    const rawMenu = body['menu'] ?? [];
    if (!Array.isArray(rawMenu)) {
        problems.push({ field: 'menu', code: 'NOT_A_LIST', message: 'menu must be a list.' });
    } else {
        if (rawMenu.length > MENU_ITEMS_MAX) {
            problems.push({ field: 'menu', code: 'TOO_MANY', message: `At most ${MENU_ITEMS_MAX} menu items: Meta's best practice, and what fits a phone.` });
        }
        rawMenu.slice(0, MENU_ITEMS_MAX).forEach((raw, i) => {
            const at = `menu[${i}]`;
            if (!isObject(raw)) { problems.push({ field: at, code: 'NOT_AN_OBJECT', message: `${at} must be an object.` }); return; }
            const title = tidy(raw['title']);
            let ok = true;
            if (!title) { problems.push({ field: `${at}.title`, code: 'TITLE_EMPTY', message: 'A menu title is required.' }); ok = false; }
            else if (hasControl(title)) { problems.push({ field: `${at}.title`, code: 'BAD_CHARACTERS', message: 'A title holds a control character.' }); ok = false; }
            else if (charCount(title) > MENU_TITLE_MAX) { problems.push({ field: `${at}.title`, code: 'TITLE_TOO_LONG', message: `A menu title is at most ${MENU_TITLE_MAX} characters.` }); ok = false; }

            const type = raw['type'];
            if (type === 'postback') {
                if (!isTapCode(raw['payload'])) { problems.push({ field: `${at}.payload`, code: 'PAYLOAD_UNKNOWN', message: `payload must be one of ${TAP_CODES.join(', ')}.` }); ok = false; }
                if (ok) menu.push({ type: 'postback', title, payload: raw['payload'] as TapCode });
            } else if (type === 'web_url') {
                const url = typeof raw['url'] === 'string' ? raw['url'].trim() : '';
                if (!menuUrlOk(url)) { problems.push({ field: `${at}.url`, code: 'URL_INVALID', message: 'A menu link must be a full https address.' }); ok = false; }
                if (ok) menu.push({ type: 'web_url', title, url });
            } else {
                problems.push({ field: `${at}.type`, code: 'TYPE_UNKNOWN', message: 'type must be postback or web_url.' });
            }
        });
    }

    return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { iceBreakers, menu } };
}

/** A short fingerprint of a config, so the screen can say "edited since you published" without storing what was sent twice. */
export function fingerprint(config: IceBreakerConfig): string {
    const canonical = JSON.stringify({
        i: config.iceBreakers.map((b) => [b.question, b.payload]),
        m: config.menu.map((m) => (m.type === 'postback' ? ['p', m.title, m.payload] : ['u', m.title, m.url])),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ─── The requests ────────────────────────────────────────────────────────────────────────────

/** The two properties of the Messenger Profile this feature owns. A DELETE names them by these. */
export type ProfileField = 'ice_breakers' | 'persistent_menu';

/** The body of the one POST that publishes: the properties the config has, and `platform` as Meta's own ice-breaker example sends it. */
export interface ProfileBody {
    platform: 'instagram';
    ice_breakers?: Array<{ call_to_actions: Array<{ question: string; payload: string }>; locale: string }>;
    persistent_menu?: Array<{ locale: string; call_to_actions: Array<{ type: 'postback'; title: string; payload: string } | { type: 'web_url'; title: string; url: string }> }>;
}

/** What a publish does to Instagram: set these properties (a body, or null for none) and remove those fields. */
export interface PublishPlan {
    set: ProfileBody | null;
    remove: ProfileField[];
}

/**
 * Make Instagram match the editor. A property the config has is SET; one it does not have is REMOVED, but only when this app published it
 * (`published` counts say so): an owner who emptied the menu and published expects no menu, and Meta's POST would otherwise leave the old
 * one standing ("only properties set in the request body will be overwritten"). Never removes what this app did not put there.
 * Nothing to set and nothing to remove is `null`: the route answers 400, because pressing Publish on an empty editor is a mistake, not a command.
 */
export function planPublish(config: IceBreakerConfig, published: Pick<PublishedState, 'iceBreakers' | 'menu'> | null): PublishPlan | null {
    const body: ProfileBody = { platform: 'instagram' };
    const remove: ProfileField[] = [];

    if (config.iceBreakers.length > 0) {
        body.ice_breakers = [{
            call_to_actions: config.iceBreakers.map((b) => ({ question: b.question, payload: b.payload })),
            locale: PROFILE_LOCALE,
        }];
    } else if (published && published.iceBreakers > 0) {
        remove.push('ice_breakers');
    }

    if (config.menu.length > 0) {
        body.persistent_menu = [{
            locale: PROFILE_LOCALE,
            call_to_actions: config.menu.map((m) => (m.type === 'postback'
                ? { type: 'postback' as const, title: m.title, payload: m.payload }
                : { type: 'web_url' as const, title: m.title, url: m.url })),
        }];
    } else if (published && published.menu > 0) {
        remove.push('persistent_menu');
    }

    const sets = body.ice_breakers !== undefined || body.persistent_menu !== undefined;
    if (!sets && remove.length === 0) return null;
    return { set: sets ? body : null, remove };
}

/** What "Remove from Instagram" deletes: both properties, always. Deleting what is not there is not an error to Meta. */
export const REMOVE_FIELDS: readonly ProfileField[] = Object.freeze(['ice_breakers', 'persistent_menu']);

/** The `fields` a read-back asks for, comma separated as Meta's reference documents. */
export const READ_FIELDS = 'ice_breakers,persistent_menu';

// ─── What Meta has ───────────────────────────────────────────────────────────────────────────

/** What Instagram holds, as the screen shows it: per locale, the questions and the menu items. */
export interface LiveProfile {
    iceBreakers: Array<{ locale: string; items: Array<{ question: string; payload: string }> }>;
    menu: Array<{ locale: string; items: Array<{ type: string; title: string; payload?: string; url?: string }> }>;
}

const text = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Meta's answer to a read, as `LiveProfile`. Meta's own pages show three shapes for it (the Instagram ice-breaker page lists the locale
 * objects straight in `data`; the persistent-menu page wraps them in `{ persistent_menu: [...] }`; the Messenger reference's multi-field
 * example puts every property in one object), and an old-format ice breaker is a bare `{ question, payload }`. All are read, nothing is
 * assumed: an answer none of them fits is an empty profile, never an error and never a guess, and every string is cut to a sane length
 * because it goes on a screen.
 */
export function readLiveProfile(response: unknown): LiveProfile {
    const live: LiveProfile = { iceBreakers: [], menu: [] };
    const data = isObject(response) && Array.isArray(response['data']) ? response['data'] : [];

    const takeIce = (locales: unknown): void => {
        if (!Array.isArray(locales)) return;
        for (const entry of locales) {
            if (!isObject(entry)) continue;
            if (Array.isArray(entry['call_to_actions'])) {
                const items = entry['call_to_actions'].filter(isObject).map((c) => ({ question: text(c['question']), payload: text(c['payload']) }));
                live.iceBreakers.push({ locale: text(entry['locale'], 20) || PROFILE_LOCALE, items });
            } else if (typeof entry['question'] === 'string') {
                // The old format: the questions themselves, with no locale around them.
                let bucket = live.iceBreakers.find((b) => b.locale === PROFILE_LOCALE);
                if (!bucket) { bucket = { locale: PROFILE_LOCALE, items: [] }; live.iceBreakers.push(bucket); }
                bucket.items.push({ question: text(entry['question']), payload: text(entry['payload']) });
            }
        }
    };
    const takeMenu = (locales: unknown): void => {
        if (!Array.isArray(locales)) return;
        for (const entry of locales) {
            if (!isObject(entry) || !Array.isArray(entry['call_to_actions'])) continue;
            const items = entry['call_to_actions'].filter(isObject).map((c) => ({
                type: text(c['type'], 20) || 'postback',
                title: text(c['title']),
                ...(typeof c['payload'] === 'string' ? { payload: text(c['payload']) } : {}),
                ...(typeof c['url'] === 'string' ? { url: text(c['url'], MENU_URL_MAX) } : {}),
            }));
            live.menu.push({ locale: text(entry['locale'], 20) || PROFILE_LOCALE, items });
        }
    };

    for (const element of data) {
        if (!isObject(element)) continue;
        if ('ice_breakers' in element) takeIce(element['ice_breakers']);
        if ('persistent_menu' in element) takeMenu(element['persistent_menu']);
        if (Array.isArray(element['call_to_actions'])) {
            // The locale objects straight in `data`: a question marks an ice breaker, a `type` a menu item.
            const first = element['call_to_actions'].find(isObject);
            if (first && 'question' in first) takeIce([element]);
            else if (first && 'type' in first) takeMenu([element]);
        }
    }
    return live;
}

// ─── Suggestions ─────────────────────────────────────────────────────────────────────────────

/** A button the screen offers the owner to start from. Shown as an editable draft; nothing is saved or published until he presses. */
export interface Suggestion {
    question: string;
    payload: TapCode;
}

interface SuggestionWords {
    /** What is in the offer, with its name. */
    about: (name: string) => string;
    /** The same, when the account has no offer on its profile to name. */
    aboutAny: string;
    level: string;
    price: string;
    link: string;
}

/**
 * The words, per kit (the register the tenant's profile speaks, or English). The Gulf set is the owner's own phrasing; the other registers are
 * drafts of the same four questions that a native speaker should read, as with the kits themselves (`profile/kits.test.ts`). They name no product
 * and no person of the owner's: an offer is named from the profile, so a tenant that sells a perfume is never asked about somebody else's.
 */
const WORDS: Readonly<Record<KitKey, SuggestionWords>> = {
    gulf: { about: (n) => `وش يتضمن ${n}؟`, aboutAny: 'وش اللي تقدمونه؟', level: 'يناسب المبتدئين؟', price: 'وش السعر؟', link: 'أبي الرابط' },
    msa: { about: (n) => `ما الذي يتضمنه ${n}؟`, aboutAny: 'ماذا تقدمون؟', level: 'هل يناسب المبتدئين؟', price: 'كم السعر؟', link: 'أريد الرابط' },
    egyptian: { about: (n) => `إيه اللي في ${n}؟`, aboutAny: 'بتقدموا إيه؟', level: 'مناسب للمبتدئين؟', price: 'بكام؟', link: 'عايز اللينك' },
    levantine: { about: (n) => `شو بيتضمن ${n}؟`, aboutAny: 'شو بتقدموا؟', level: 'بيناسب المبتدئين؟', price: 'قديش السعر؟', link: 'بدي الرابط' },
    en: { about: (n) => `What does ${n} include?`, aboutAny: 'What do you offer?', level: 'Is it good for beginners?', price: 'How much is it?', link: 'Send me the link' },
};

/** Every kit has words: a register added to the profile cannot be left without suggestions (a test walks `KIT_KEYS`). */
export const SUGGESTION_KITS: readonly KitKey[] = Object.freeze(Object.keys(WORDS) as KitKey[]);

/**
 * The four starting questions for a tenant, in the order they are offered: what is in the offer (named, when the profile has one and the
 * name fits a button), who it is for, what it costs, and the link. The first three are the questions the plan's sales turn answers from the
 * profile; the last is answered with the tracked link.
 */
export function suggestIceBreakers(kit: KitKey, offerName: string | null): Suggestion[] {
    const w = WORDS[kit];
    const name = tidy(offerName);
    const named = name ? w.about(name) : '';
    const about = named && charCount(named) <= ICE_BREAKER_QUESTION_MAX ? named : w.aboutAny;
    return [
        { question: about, payload: 'TAP_INFO' },
        { question: w.level, payload: 'TAP_LEVEL' },
        { question: w.price, payload: 'TAP_PRICE' },
        { question: w.link, payload: 'TAP_LINK' },
    ];
}
