/**
 * Whether Meta Muse may read a tenant's DMs, and how much it may spend doing it: the three per-tenant settings of the perception features
 * (docs/specs/005-muse-sees, local). All three are the owner's, and every one defaults to the product as it was before the feature existed
 * (constitution III: new behaviour ships dark).
 *
 *   muse.switches.<tenant>        `{ "dm_media": bool, "voice": bool, "memory": bool }`. `dm_media`: shared reels, posts, stories, story mentions,
 *                                 photos and videos are read instead of getting one fixed line. `voice`: voice notes are transcribed and answered.
 *                                 `memory`: the reels the owner published are remembered and recalled. Each is on only when it is exactly `true`;
 *                                 absent is all off. (Comment intent and offer cards were cut from the build, so they have no switch.)
 *   muse.allow_senders.<tenant>   A JSON list of sender ids, or `["*"]` for everyone. An empty list, or none stored, is NOBODY: the switches alone
 *                                 open nothing, so a feature can be on for the owner's test accounts while followers still get today's line.
 *   muse.daily_usd.<tenant>       The most the perception features may spend in a UTC day, from 0 to 50 (default 3). `gate.ts` enforces it.
 *
 * **Every read fails toward OFF.** A database that is behind, a read that errors, a value that does not parse: each is the feature off for that
 * tenant, never a guess, and a read error is logged. A DM must not be answered by an experiment because the lookup that decides it broke.
 *
 * Writing them (the owner's card, `POST /api/settings/ai/muse`) is not here: it validates the way `contracts/api.md` says and audits the change.
 */
import { describeError, log } from '../../utils/log.js';
import { getSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import type { MuseCapability } from './types.js';

export interface MuseSwitches {
    dm_media: boolean;
    voice: boolean;
    memory: boolean;
}

export interface MuseSettings {
    switches: MuseSwitches;
    /** Sender ids, or `['*']` for everyone. Empty is nobody. */
    allowSenders: string[];
    /** USD per UTC day. */
    dailyUsd: number;
}

/** What `allowSenders` says for everyone. */
export const MUSE_ALL_SENDERS = '*';
/** The cap when none is saved, and the highest one that can be. */
export const MUSE_DAILY_USD_DEFAULT = 3;
export const MUSE_DAILY_USD_MAX = 50;

/** Everything off, nobody allowed, nothing to spend: what a tenant with no settings, or a settings read that failed, gets. A fresh object each time. */
export const museSettingsOff = (): MuseSettings => ({ switches: { dm_media: false, voice: false, memory: false }, allowSenders: [], dailyUsd: 0 });

/** `muse.switches.<t>` as stored, read strictly: only a JSON object, and only a field that is exactly `true`, is on. Pure. */
export function parseMuseSwitches(raw: string | null): MuseSwitches {
    const off: MuseSwitches = { dm_media: false, voice: false, memory: false };
    if (!raw) return off;
    try {
        const v: unknown = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return off;
        const o = v as Record<string, unknown>;
        return { dm_media: o['dm_media'] === true, voice: o['voice'] === true, memory: o['memory'] === true };
    } catch {
        return off;
    }
}

/**
 * `muse.allow_senders.<t>` as stored: a JSON list, of which only the strings count (an id that is a JSON number has already lost digits). Trimmed,
 * unique, and if `*` is among them the list is `['*']`. Anything that is not a list is nobody. Pure.
 */
export function parseAllowSenders(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const v: unknown = JSON.parse(raw);
        if (!Array.isArray(v)) return [];
        const ids = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
        return ids.includes(MUSE_ALL_SENDERS) ? [MUSE_ALL_SENDERS] : [...new Set(ids)];
    } catch {
        return [];
    }
}

/**
 * `muse.daily_usd.<t>` as stored: none saved is the default; a number is kept between 0 and the maximum; something saved that is not a number is 0, which
 * refuses everything (a typo in the cap must not become a bigger one). Pure.
 */
export function parseDailyUsd(raw: string | null): number {
    if (raw === null) return MUSE_DAILY_USD_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(n, 0), MUSE_DAILY_USD_MAX);
}

/** Does the allow-list let this sender through? `*` is everyone; otherwise an exact match. An empty list, or an empty id, is nobody. Pure. */
export function senderAllowed(allowSenders: readonly string[], senderId: string): boolean {
    if (!senderId) return false;
    return allowSenders.includes(MUSE_ALL_SENDERS) || allowSenders.includes(senderId);
}

/** Is this capability switched on? (The allow-list and the budget are `gate.ts`'s.) Pure. */
export const capabilityOn = (settings: Pick<MuseSettings, 'switches'>, capability: MuseCapability): boolean => settings.switches[capability] === true;

/** The tenant's three settings, in one round of reads. Fails toward off: see the top of the file. */
export async function readMuseSettings(creatorId: string): Promise<MuseSettings> {
    try {
        const [switches, allow, daily] = await Promise.all([
            getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.museSwitches, creatorId)),
            getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.museAllowSenders, creatorId)),
            getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.museDailyUsd, creatorId)),
        ]);
        return { switches: parseMuseSwitches(switches), allowSenders: parseAllowSenders(allow), dailyUsd: parseDailyUsd(daily) };
    } catch (err) {
        log('warn', 'perception.settings_unreadable', { creator_id: creatorId, ...describeError(err) });
        return museSettingsOff();
    }
}
