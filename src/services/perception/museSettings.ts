/**
 * The owner's side of Meta vision (docs/specs/005-muse-sees T037, local): what `GET /api/settings/ai` shows in its `muse` block, and what
 * `POST /api/settings/ai/muse` saves. The three settings themselves (`muse.switches.<t>`, `muse.allow_senders.<t>`, `muse.daily_usd.<t>`) are
 * `switches.ts`'s; this file is the card's read and write of them.
 *
 * **The card's read is strict, the reply path's is not.** `readMuseSettings` (switches.ts) answers "everything off, cap 0" when a read fails, which is
 * right for a customer's message (a DM must not be answered by an experiment because a lookup broke) and wrong for a screen an owner is about to press
 * Save on: that default, shown as if it were his settings and then saved, would overwrite what he really chose. So `readStoredMuse` throws, and
 * `loadMuseView` answers `null` for the whole block, which the card shows as "could not load" with Save disabled.
 *
 * **The view is what the card needs and nothing the owner could not read in the inbox:**
 *
 *   switches, allowSenders, dailyUsd   the three settings as stored (`allowSenders` is `['*']` for everyone, `[]` for nobody)
 *   spentToday                         today's spend on the perception purposes (the same sum the gate's cap counts), or null when it could not be read
 *   keyReady                           whether the providers layer has a route for `perception_dm` (a Meta key, on a route that may answer it), or null
 *                                      when that could not be told: the same question the gate asks, by the same function
 *   route                              `{ provider, model }` of that route when there is one, never a key, a URL or the effort
 *   people                             each id on the list with the handle and name the inbox shows for that thread (null for an id with no thread yet),
 *                                      so the card can show people and not numbers. Scoped to the tenant's own conversations.
 *   limits                             the bounds the card validates against, so the dashboard never keeps a second copy of them
 *
 * **Writing** (`parseMuseInput`, `saveMuseSettings`): the body is checked whole before anything is written, and a typo is a 400 that names it, never a
 * field quietly left unsaved (an unknown key, a switch that does not exist, an id with a letter in it). The switches merge into what is stored (a body that
 * names one leaves the others as they are); the list and the cap replace. The rows are written the list first, the cap second and the switches LAST, so a
 * save that stops half way never leaves a feature on with a list the owner did not mean. The ledger row (`muse.settings_changed`) is the route's, built by
 * `museAuditDetail`: the switch states, who it answers and HOW MANY people are on the list, never one id.
 */
import { queryRows } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { resolveRoute } from '../aiProviders/route.js';
import type { AiPurpose } from '../aiProviders/purposes.js';
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES, type TenantSettingKey } from '../appSettings.js';
import { SENDER_ID } from '../dmSales/mode.js';
import { perceptionRouteReady, spentTodayUsd } from './gate.js';
import {
    MUSE_ALL_SENDERS, MUSE_DAILY_USD_DEFAULT, MUSE_DAILY_USD_MAX, parseAllowSenders, parseDailyUsd, parseMuseSwitches,
    type MuseSettings, type MuseSwitches,
} from './switches.js';

/** The switches the build has, in the order the card shows them. (Comment intent and offer cards were cut, so they are not here and a body naming one is refused.) */
export const MUSE_SWITCH_NAMES = ['dm_media', 'voice', 'memory'] as const satisfies readonly (keyof MuseSwitches)[];

/** The most people the list may hold: it is a beta list of test accounts, then everyone. A cap so that a body cannot make the row large. */
export const MUSE_ALLOW_SENDERS_MAX = 50;

/** The purpose the key check resolves: the one `AI_PURPOSES` routes to Meta only (the gate asks the same). Typed, so a rename does not compile. */
const PERCEPTION_PURPOSE: AiPurpose = 'perception_dm';

/** The longest handle or name the view carries: Instagram's own handle is 30 characters, a profile name 64. */
const PERSON_TEXT_MAX = 100;

// ─── The view ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MusePerson {
    id: string;
    /** The handle on the thread, without the "@". */
    username: string | null;
    /** The name on the sender's profile. */
    name: string | null;
}

export interface MuseRoute {
    provider: string;
    model: string;
}

export interface MuseView {
    switches: MuseSwitches;
    allowSenders: string[];
    dailyUsd: number;
    spentToday: number | null;
    keyReady: boolean | null;
    route: MuseRoute | null;
    people: MusePerson[];
    limits: { dailyUsdMax: number; dailyUsdDefault: number; allowSendersMax: number };
}

export interface MuseViewDeps {
    now?: () => Date;
    /** Today's spend on the budget purposes. Throws when it cannot be read. */
    spentToday?: (creatorId: string, now: Date) => Promise<number>;
    /** Whether a Meta route can answer perception. Throws when it cannot tell. */
    routeReady?: (creatorId: string) => Promise<boolean>;
    /** The route that would answer. Throws when there is none. */
    routeOf?: (creatorId: string) => Promise<{ provider: string; model: string }>;
    /** The handle and name of each id on the list. Throws when it cannot be read. */
    people?: (creatorId: string, ids: readonly string[]) => Promise<MusePerson[]>;
    /** The three settings, strictly. Throws when it cannot read them. */
    read?: (creatorId: string) => Promise<MuseSettings>;
}

/** The three settings as stored, or what each means when none is saved (everything off, nobody, the default cap). THROWS when the database cannot be read. */
export async function readStoredMuse(creatorId: string): Promise<MuseSettings> {
    const [switches, allow, daily] = await Promise.all([
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.museSwitches, creatorId)),
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.museAllowSenders, creatorId)),
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.museDailyUsd, creatorId)),
    ]);
    return { switches: parseMuseSwitches(switches), allowSenders: parseAllowSenders(allow), dailyUsd: parseDailyUsd(daily) };
}

const clean = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, PERSON_TEXT_MAX) : null);

/**
 * Each id on the list with the handle and name of that tenant's own thread. An id with no thread is still returned, with no names: the owner may have
 * typed it, and the card then shows it as the inbox shows a sender nobody has looked up. `*` (everyone) has no people. In the list's order.
 */
export async function museAllowedPeople(creatorId: string, ids: readonly string[]): Promise<MusePerson[]> {
    if (ids.length === 0 || ids.includes(MUSE_ALL_SENDERS)) return [];
    const rows = await queryRows<{ instagram_user_id: string; username: string | null; profile_name: string | null }>(
        `SELECT instagram_user_id, username, profile_name
           FROM conversations
          WHERE creator_id = $1 AND instagram_user_id = ANY($2::text[])`,
        [creatorId, [...ids]]
    );
    const byId = new Map(rows.map((row) => [String(row.instagram_user_id), row]));
    return ids.map((id) => {
        const row = byId.get(id);
        return { id, username: clean(row?.username)?.replace(/^@/, '') || null, name: clean(row?.profile_name) };
    });
}

/**
 * The view for settings already in hand. Each part that needs a lookup is its own, and a lookup that fails is `null` or empty and logged: the card says
 * "could not check" for that part and still shows the rest. Never throws.
 */
export async function buildMuseView(creatorId: string, stored: MuseSettings, deps: MuseViewDeps = {}): Promise<MuseView> {
    const now = (deps.now ?? (() => new Date()))();
    const logBase = { creator_id: creatorId };

    const spent = async (): Promise<number | null> => {
        try {
            const usd = await (deps.spentToday ?? spentTodayUsd)(creatorId, now);
            return Number.isFinite(usd) ? Math.round(usd * 10000) / 10000 : null;
        } catch (err) {
            log('warn', 'muse.spend_unreadable', { ...logBase, ...describeError(err) });
            return null;
        }
    };

    const route = async (): Promise<{ keyReady: boolean | null; route: MuseRoute | null }> => {
        try {
            if (!(await (deps.routeReady ?? perceptionRouteReady)(creatorId))) return { keyReady: false, route: null };
        } catch (err) {
            log('warn', 'muse.route_unreadable', { ...logBase, ...describeError(err) });
            return { keyReady: null, route: null };
        }
        try {
            const resolved = await (deps.routeOf ?? ((id: string) => resolveRoute(PERCEPTION_PURPOSE, id)))(creatorId);
            return { keyReady: true, route: { provider: String(resolved.provider), model: String(resolved.model) } };
        } catch {
            // A key is there (that was just answered); which model is only a line of text, and not worth a log of its own.
            return { keyReady: true, route: null };
        }
    };

    const people = async (): Promise<MusePerson[]> => {
        try {
            return await (deps.people ?? museAllowedPeople)(creatorId, stored.allowSenders);
        } catch (err) {
            log('warn', 'muse.people_unreadable', { ...logBase, ...describeError(err) });
            return stored.allowSenders.filter((id) => id !== MUSE_ALL_SENDERS).map((id) => ({ id, username: null, name: null }));
        }
    };

    const [spentToday, state, who] = await Promise.all([spent(), route(), people()]);
    return {
        switches: { ...stored.switches },
        allowSenders: [...stored.allowSenders],
        dailyUsd: stored.dailyUsd,
        spentToday,
        keyReady: state.keyReady,
        route: state.route,
        people: who,
        limits: { dailyUsdMax: MUSE_DAILY_USD_MAX, dailyUsdDefault: MUSE_DAILY_USD_DEFAULT, allowSendersMax: MUSE_ALLOW_SENDERS_MAX },
    };
}

/** The `muse` block of `GET /api/settings/ai`: the view, or `null` when the settings could not be read (and then the card must not offer Save). Never throws. */
export async function loadMuseView(creatorId: string, deps: MuseViewDeps = {}): Promise<MuseView | null> {
    let stored: MuseSettings;
    try {
        stored = await (deps.read ?? readStoredMuse)(creatorId);
    } catch (err) {
        log('warn', 'muse.settings_unreadable', { creator_id: creatorId, ...describeError(err) });
        return null;
    }
    return buildMuseView(creatorId, stored, deps);
}

// ─── What a save may say ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface MuseInput {
    /** Only the switches the body names: they merge into what is stored. */
    switches?: Partial<MuseSwitches>;
    /** `['*']` for everyone, `[]` for nobody, else sender ids. Replaces the list. */
    allowSenders?: string[];
    /** USD per UTC day, 0 to 50 in whole cents. */
    dailyUsd?: number;
}

export interface MuseProblem {
    error: string;
    /** The body field it is about, as the owner's screen names it (`switches.voice`, `allow_senders`, `daily_usd`), or null. */
    field: string | null;
}

export type MuseParsed = { ok: true; input: MuseInput } | { ok: false; problem: MuseProblem };

/** The body's keys. The contract's are snake_case (`allow_senders`, `daily_usd`); the camelCase twins are the names `GET` answers with. */
const BODY_KEYS: ReadonlySet<string> = new Set(['switches', 'allow_senders', 'allowSenders', 'daily_usd', 'dailyUsd']);

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A value of the body, cut and printed on one line, to name it in an error. */
const quoted = (value: string): string => `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
const refuse = (error: string, field: string | null): MuseParsed => ({ ok: false, problem: { error, field } });

/**
 * A save's body, checked whole. Pure.
 *
 *   `switches`      `{ dm_media?, voice?, memory? }`, each exactly `true` or `false`; at least one. Unknown names are refused.
 *   `allow_senders` `["*"]` (everyone), `[]` (nobody) or sender ids: strings of 5 to 32 digits. A JSON number is refused (it has lost digits on the way: an
 *                   Instagram id is larger than a double holds), and so is `*` beside an id (everyone includes them, so it is a mistake, not a choice).
 *   `daily_usd`     a number from 0 to 50 with at most two decimals. 0 is allowed: it is the owner's way to keep it off by money.
 *
 * An unknown top-level key is refused by name, so `allow_sender` is a 400 and not a field that is silently not saved, and so is a tenant id in the body: the
 * session's tenant is the only one written.
 */
export function parseMuseInput(body: unknown): MuseParsed {
    if (!isPlainObject(body)) return refuse('Send the settings as a JSON object.', null);
    for (const key of Object.keys(body)) {
        if (!BODY_KEYS.has(key)) return refuse(`${quoted(key)} is not a Meta vision setting: send switches, allow_senders or daily_usd.`, key.slice(0, 40));
    }
    const input: MuseInput = {};

    if ('switches' in body) {
        const raw = body['switches'];
        if (!isPlainObject(raw)) return refuse('switches must be an object of true or false values.', 'switches');
        const named = Object.entries(raw);
        if (named.length === 0) return refuse('Name at least one switch: dm_media, voice or memory.', 'switches');
        const switches: Partial<MuseSwitches> = {};
        for (const [name, value] of named) {
            if (!(MUSE_SWITCH_NAMES as readonly string[]).includes(name)) {
                return refuse(`${quoted(name)} is not a Meta vision switch: choose ${MUSE_SWITCH_NAMES.join(', ')}.`, `switches.${name.slice(0, 40)}`);
            }
            if (typeof value !== 'boolean') return refuse(`${name} must be true or false.`, `switches.${name}`);
            switches[name as keyof MuseSwitches] = value;
        }
        input.switches = switches;
    }

    const allowKeys = ['allow_senders', 'allowSenders'].filter((key) => key in body);
    if (allowKeys.length > 1) return refuse('Send allow_senders once: allowSenders is the same setting.', 'allow_senders');
    if (allowKeys.length === 1) {
        const raw = body[allowKeys[0]!];
        if (!Array.isArray(raw)) return refuse('allow_senders must be a list: ["*"] for everyone, sender ids (numbers only), or [] for nobody.', 'allow_senders');
        const ids: string[] = [];
        let everyone = false;
        for (const item of raw) {
            if (typeof item !== 'string') return refuse('Every sender id must be a string of digits: a number loses digits on its way here.', 'allow_senders');
            const id = item.trim();
            if (!id) continue;
            if (id === MUSE_ALL_SENDERS) { everyone = true; continue; }
            if (!SENDER_ID.test(id)) return refuse(`${quoted(id)} is not a sender id: they are numbers only (5 to 32 digits).`, 'allow_senders');
            if (!ids.includes(id)) ids.push(id);
        }
        if (everyone && ids.length > 0) return refuse('Use ["*"] alone for everyone, or a list of sender ids: not both.', 'allow_senders');
        if (ids.length > MUSE_ALLOW_SENDERS_MAX) return refuse(`At most ${MUSE_ALLOW_SENDERS_MAX} people.`, 'allow_senders');
        input.allowSenders = everyone ? [MUSE_ALL_SENDERS] : ids;
    }

    const dailyKeys = ['daily_usd', 'dailyUsd'].filter((key) => key in body);
    if (dailyKeys.length > 1) return refuse('Send daily_usd once: dailyUsd is the same setting.', 'daily_usd');
    if (dailyKeys.length === 1) {
        const raw = body[dailyKeys[0]!];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return refuse(`daily_usd must be a number from 0 to ${MUSE_DAILY_USD_MAX}.`, 'daily_usd');
        if (raw < 0 || raw > MUSE_DAILY_USD_MAX) return refuse(`daily_usd must be from 0 to ${MUSE_DAILY_USD_MAX}.`, 'daily_usd');
        if (Math.abs(raw * 100 - Math.round(raw * 100)) > 1e-6) return refuse('daily_usd has at most two decimals.', 'daily_usd');
        input.dailyUsd = Math.round(raw * 100) / 100;
    }

    if (input.switches === undefined && input.allowSenders === undefined && input.dailyUsd === undefined) return refuse('Nothing to save.', null);
    return { ok: true, input };
}

// ─── Saving ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MuseSaveResult {
    before: MuseSettings;
    /** What is stored now: the merge of `before` and the input. */
    after: MuseSettings;
    /** What changed, by the names the body uses: `switches.voice`, `allow_senders`, `daily_usd`. Empty: nothing was written. */
    changed: string[];
}

export interface MuseSaveDeps {
    read?: (creatorId: string) => Promise<MuseSettings>;
    write?: (key: TenantSettingKey, value: string, updatedBy: string | null) => Promise<void>;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

/** Who it answers, as a word: what the audit row and the card both say. Pure. */
export function allowMode(allowSenders: readonly string[]): 'nobody' | 'list' | 'everyone' {
    if (allowSenders.includes(MUSE_ALL_SENDERS)) return 'everyone';
    return allowSenders.length === 0 ? 'nobody' : 'list';
}

/**
 * Merge a checked body into what is stored and write what changed: the list, then the cap, then the switches (see the top). A save that changes nothing
 * writes nothing. THROWS on a database that cannot be read or written, and the caller answers 500 without detail.
 */
export async function saveMuseSettings(creatorId: string, input: MuseInput, updatedBy: string | null, deps: MuseSaveDeps = {}): Promise<MuseSaveResult> {
    const before = await (deps.read ?? readStoredMuse)(creatorId);
    const switches: MuseSwitches = { ...before.switches };
    const changed: string[] = [];
    for (const name of MUSE_SWITCH_NAMES) {
        const next = input.switches?.[name];
        if (next !== undefined && next !== before.switches[name]) { switches[name] = next; changed.push(`switches.${name}`); }
    }
    const allowSenders = input.allowSenders ?? before.allowSenders;
    if (input.allowSenders !== undefined && !sameList(input.allowSenders, before.allowSenders)) changed.push('allow_senders');
    const dailyUsd = input.dailyUsd ?? before.dailyUsd;
    if (input.dailyUsd !== undefined && input.dailyUsd !== before.dailyUsd) changed.push('daily_usd');
    const after: MuseSettings = { switches, allowSenders: [...allowSenders], dailyUsd };
    if (changed.length === 0) return { before, after, changed };

    const write = deps.write ?? ((key, value, by) => setSetting(key, value, by));
    if (changed.includes('allow_senders')) await write(tenantSettingKey(TENANT_SETTING_PREFIXES.museAllowSenders, creatorId), JSON.stringify(after.allowSenders), updatedBy);
    if (changed.includes('daily_usd')) await write(tenantSettingKey(TENANT_SETTING_PREFIXES.museDailyUsd, creatorId), String(after.dailyUsd), updatedBy);
    if (changed.some((name) => name.startsWith('switches.'))) {
        await write(
            tenantSettingKey(TENANT_SETTING_PREFIXES.museSwitches, creatorId),
            JSON.stringify({ dm_media: switches.dm_media, voice: switches.voice, memory: switches.memory }),
            updatedBy
        );
    }
    return { before, after, changed };
}

/**
 * The ledger row's `detail` for a save (`muse.settings_changed`): what changed, the switches as they are now, who it answers, how many people are on the
 * list, and the cap. **Never a sender id**, and no name: the owner can see who is on his list on the card, and the ledger only needs to say that it moved.
 * Pure.
 */
export function museAuditDetail(after: MuseSettings, changed: readonly string[]): Record<string, unknown> {
    const mode = allowMode(after.allowSenders);
    return {
        changed: [...changed],
        switches: { dm_media: after.switches.dm_media, voice: after.switches.voice, memory: after.switches.memory },
        allow: mode,
        allow_count: mode === 'list' ? after.allowSenders.length : 0,
        daily_usd: after.dailyUsd,
    };
}
