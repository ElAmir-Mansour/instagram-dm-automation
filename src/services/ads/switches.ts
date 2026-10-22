/**
 * The two per-tenant switches of ads → DM attribution (Meta Ads Manager phase A3). Both are OFF by default (constitution III: new bot behaviour
 * ships dark), both are the owner's, set on the Settings screen's Meta ads card (`POST /api/ads/settings/switches`).
 *
 *   ads.bot_context.<t>      'on' or absent. On: the sales turn's facts block says which ad the person came from (`attribution.ts` `adFactsFor`).
 *                            Off: the prompt is byte for byte what it was before the switch existed (`prompt.test.ts` pins it).
 *   ads.extended_window.<t>  `{"instagram":bool,"messenger":bool}`. On for a platform: a conversation that began from that platform's
 *                            click-to-message ad may be written to for up to 7 days (minus an hour) from the ad click, Meta's window since
 *                            2026-09-28, instead of 23 hours from the person's last message (`attribution.ts` `windowFor`). Turned on only after
 *                            the live day-2 check; a send Meta refuses for being outside the window turns that platform off again by itself.
 *
 * Every read fails toward OFF: a database that is behind or a value that does not parse is the switch off, never a guess.
 */
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { describeError, log } from '../../utils/log.js';

export type AdPlatform = 'instagram' | 'messenger';

export interface AdsSwitches {
    botContext: boolean;
    extendedWindow: Record<AdPlatform, boolean>;
}

export const ADS_SWITCHES_OFF: Readonly<AdsSwitches> = Object.freeze({ botContext: false, extendedWindow: Object.freeze({ instagram: false, messenger: false }) });

/** `ads.extended_window.<t>` as stored, read strictly: anything but a JSON object with boolean fields is both platforms off. Pure. */
export function parseExtendedWindow(raw: string | null): Record<AdPlatform, boolean> {
    if (!raw) return { instagram: false, messenger: false };
    try {
        const v = JSON.parse(raw);
        return { instagram: v?.instagram === true, messenger: v?.messenger === true };
    } catch {
        return { instagram: false, messenger: false };
    }
}

export async function readBotContext(creatorId: string): Promise<boolean> {
    try {
        return (await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsBotContext, creatorId))) === 'on';
    } catch (err) {
        log('warn', 'ads.switch_unreadable', { switch: 'bot_context', creator_id: creatorId, ...describeError(err) });
        return false;
    }
}

export async function readExtendedWindow(creatorId: string): Promise<Record<AdPlatform, boolean>> {
    try {
        return parseExtendedWindow(await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsExtendedWindow, creatorId)));
    } catch (err) {
        log('warn', 'ads.switch_unreadable', { switch: 'extended_window', creator_id: creatorId, ...describeError(err) });
        return { instagram: false, messenger: false };
    }
}

export async function readAdsSwitches(creatorId: string): Promise<AdsSwitches> {
    const [botContext, extendedWindow] = await Promise.all([readBotContext(creatorId), readExtendedWindow(creatorId)]);
    return { botContext, extendedWindow };
}

/** The owner's change. Fields left out are kept. An all-off extended window is stored as nothing (absent is off). */
export async function writeAdsSwitches(
    creatorId: string,
    change: { botContext?: boolean; extendedWindow?: Partial<Record<AdPlatform, boolean>> },
    updatedBy: string | null
): Promise<AdsSwitches> {
    if (typeof change.botContext === 'boolean') {
        await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsBotContext, creatorId), change.botContext ? 'on' : null, updatedBy);
    }
    if (change.extendedWindow) {
        const current = await readExtendedWindow(creatorId);
        const next = { ...current };
        for (const p of ['instagram', 'messenger'] as const) {
            if (typeof change.extendedWindow[p] === 'boolean') next[p] = change.extendedWindow[p]!;
        }
        await setSetting(
            tenantSettingKey(TENANT_SETTING_PREFIXES.adsExtendedWindow, creatorId),
            next.instagram || next.messenger ? JSON.stringify(next) : null,
            updatedBy
        );
    }
    return readAdsSwitches(creatorId);
}

/** Validate a `POST /api/ads/settings/switches` body. Pure. */
export function parseSwitchesInput(body: unknown):
    | { ok: true; value: { botContext?: boolean; extendedWindow?: Partial<Record<AdPlatform, boolean>> } }
    | { ok: false; field: string } {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const out: { botContext?: boolean; extendedWindow?: Partial<Record<AdPlatform, boolean>> } = {};
    if (b.botContext !== undefined) {
        if (typeof b.botContext !== 'boolean') return { ok: false, field: 'botContext' };
        out.botContext = b.botContext;
    }
    if (b.extendedWindow !== undefined) {
        const w = b.extendedWindow as Record<string, unknown> | null;
        if (!w || typeof w !== 'object' || Array.isArray(w)) return { ok: false, field: 'extendedWindow' };
        const ew: Partial<Record<AdPlatform, boolean>> = {};
        for (const p of ['instagram', 'messenger'] as const) {
            if (w[p] === undefined) continue;
            if (typeof w[p] !== 'boolean') return { ok: false, field: `extendedWindow.${p}` };
            ew[p] = w[p] as boolean;
        }
        out.extendedWindow = ew;
    }
    if (out.botContext === undefined && out.extendedWindow === undefined) return { ok: false, field: 'botContext' };
    return { ok: true, value: out };
}
