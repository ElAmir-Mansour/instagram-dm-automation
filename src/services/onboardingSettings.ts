/**
 * The operator's onboarding settings (`onboarding.*` in `app_settings`), edited on Settings → Onboarding.
 *
 * Operator inputs are dashboard settings, never constants: how long an invite lasts, which role it gives, how long a "keep me
 * signed in" session runs, who the invite page says sent it, and the WhatsApp message. Each has a default here, so a deployment
 * that never opens the card behaves as the plan says (7 days, owner, 30 days), and an invalid saved value falls back to that
 * default instead of failing a create (`readInt`, `readRole`): a typo in a setting must never lock the operator out of inviting.
 *
 * Pure where it can be (`readInt`, `validateOnboardingPatch`, `renderWhatsappText`), so the rules are testable without a
 * database; the two functions that touch `app_settings` read and write one key each, like every other setting.
 */
import { APP_SETTING_KEYS, getOnboardingDefaultRules, getSetting, getYouTubeApiKey, last4, parseOnboardingRules, setSetting, type AppSettingKey } from './appSettings.js';
import { queryRows } from '../db/query.js';
import { pickDiscoveryCreatorId } from './onboarding/discoveryProbe.js';
import { CONTENT_RULE_PRESETS, type ContentRulePreset } from './profile/types.js';
import { getPlatformOwnerId } from './tenant.js';

export const INVITE_ROLES = ['owner', 'operator', 'viewer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export function isInviteRole(value: unknown): value is InviteRole {
    return typeof value === 'string' && (INVITE_ROLES as readonly string[]).includes(value);
}

/** What each setting is when nothing is saved, and the range an integer setting may take. */
export const ONBOARDING_LIMITS = {
    inviteTtlDays: { min: 1, max: 90, fallback: 7 },
    resetTtlHours: { min: 1, max: 168, fallback: 24 },
    sessionDays: { min: 1, max: 90, fallback: 30 },
} as const;

export const DEFAULT_INVITE_ROLE: InviteRole = 'owner';
export const MAX_INVITER_NAME = 80;
export const MAX_WHATSAPP_TEXT = 600;

export interface OnboardingSettings {
    inviteTtlDays: number;
    resetTtlHours: number;
    defaultRole: InviteRole;
    sessionDays: number;
    /** Who an invite page says sent it; null says nothing. */
    inviterName: string | null;
    /** The operator's own WhatsApp template, or null for the card's default text. */
    whatsappText: string | null;
    defaultRules: ContentRulePreset[];
}

/**
 * An integer setting as stored: whole digits inside its range, else the default. A saved `0`, `-3`, `7.5`, `7 days` or `1e9`
 * is "not a usable value", the same way an unreadable `onboarding.default_rules` is.
 */
export function readInt(raw: string | null, range: { min: number; max: number; fallback: number }): number {
    if (raw === null || !/^\d{1,4}$/.test(raw.trim())) return range.fallback;
    const n = Number(raw.trim());
    return n >= range.min && n <= range.max ? n : range.fallback;
}

export function readRole(raw: string | null): InviteRole {
    return isInviteRole(raw) ? raw : DEFAULT_INVITE_ROLE;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Everything the invite routes need, one indexed row per key, read on every use (a value saved from the dashboard must reach every warm instance). */
export async function getOnboardingSettings(): Promise<OnboardingSettings> {
    const [ttl, resetTtl, role, session, inviter, whatsapp, rules] = await Promise.all([
        getSetting(APP_SETTING_KEYS.onboardingInviteTtlDays),
        getSetting(APP_SETTING_KEYS.onboardingResetTtlHours),
        getSetting(APP_SETTING_KEYS.onboardingDefaultRole),
        getSetting(APP_SETTING_KEYS.onboardingSessionDays),
        getSetting(APP_SETTING_KEYS.onboardingInviterName),
        getSetting(APP_SETTING_KEYS.onboardingWhatsappText),
        getOnboardingDefaultRules(),
    ]);
    return {
        inviteTtlDays: readInt(ttl, ONBOARDING_LIMITS.inviteTtlDays),
        resetTtlHours: readInt(resetTtl, ONBOARDING_LIMITS.resetTtlHours),
        defaultRole: readRole(role),
        sessionDays: readInt(session, ONBOARDING_LIMITS.sessionDays),
        inviterName: inviter && inviter.trim() ? inviter.trim() : null,
        whatsappText: whatsapp && whatsapp.includes('{link}') ? whatsapp : null,
        defaultRules: rules,
    };
}

/** Just the session length: the login reads only this one, and only for a "keep me signed in". */
export async function getSessionDays(): Promise<number> {
    return readInt(await getSetting(APP_SETTING_KEYS.onboardingSessionDays), ONBOARDING_LIMITS.sessionDays);
}

// ─── The message ────────────────────────────────────────────────────────────────────────────────────────────────

export type InviteLang = 'ar' | 'en';

export function isInviteLang(value: unknown): value is InviteLang {
    return value === 'ar' || value === 'en';
}

/** The text the invite card prefills when the operator saved none, in the language the link was made for. */
export const DEFAULT_WHATSAPP_TEXT: Record<InviteLang, string> = {
    ar: 'أهلًا! جهّزنا لك مساحة «{name}» على أوتوريبلاي برو. افتح هذا الرابط لتعيين كلمة المرور والبدء (يعمل مرة واحدة): {link}',
    en: 'Hi! Your "{name}" workspace on AutoReply Pro is ready. Open this link to set your password and get started (it works once): {link}',
};

/** Reset links read differently: the person already has an account. */
export const DEFAULT_RESET_WHATSAPP_TEXT: Record<InviteLang, string> = {
    ar: 'أهلًا! هذا رابط لتعيين كلمة مرور جديدة لحسابك في «{name}» على أوتوريبلاي برو (يعمل مرة واحدة): {link}',
    en: 'Hi! Here is a link to set a new password for your "{name}" account on AutoReply Pro (it works once): {link}',
};

/**
 * The message for one link. Placeholders are filled in a SINGLE pass, so a tenant called `{link}` cannot have the link written
 * into its own name, and an unknown `{word}` is left as typed. A reset link ignores the operator's join template (it says
 * "your workspace is ready", which is the wrong sentence for somebody who has one already).
 */
export function renderWhatsappText(
    template: string | null,
    vars: { name: string; link: string; inviter: string | null },
    lang: InviteLang,
    purpose: 'join' | 'reset' = 'join'
): string {
    const source = purpose === 'reset'
        ? DEFAULT_RESET_WHATSAPP_TEXT[lang]
        : template && template.includes('{link}') ? template : DEFAULT_WHATSAPP_TEXT[lang];
    return source.replace(/\{(name|inviter|link)\}/g, (_match, key: 'name' | 'inviter' | 'link') => (key === 'inviter' ? vars.inviter ?? '' : vars[key]));
}

// ─── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SettingWrite {
    /** The field's name in the request and the audit row. */
    field: string;
    key: AppSettingKey;
    /** The stored text, or null to delete the row (the default takes over again). */
    value: string | null;
}

export type SettingsPatch = { ok: true; writes: SettingWrite[] } | { ok: false; error: string; field: string };

/**
 * A request body read into writes. Every field is optional: absent leaves it alone, `null` or an empty string clears it back to
 * its default. Everything is checked before anything is written, so a refused value never leaves the others half saved.
 *
 * Field names are the request's camelCase (`inviteTtlDays`, …); `field` on a refusal is what the dashboard marks.
 */
export function validateOnboardingPatch(body: Record<string, unknown>): SettingsPatch {
    const writes: SettingWrite[] = [];
    const empty = (value: unknown): boolean => value === null || (typeof value === 'string' && value.trim() === '');

    const integers = [
        { field: 'inviteTtlDays', key: APP_SETTING_KEYS.onboardingInviteTtlDays, range: ONBOARDING_LIMITS.inviteTtlDays, unit: 'days' },
        { field: 'resetTtlHours', key: APP_SETTING_KEYS.onboardingResetTtlHours, range: ONBOARDING_LIMITS.resetTtlHours, unit: 'hours' },
        { field: 'sessionDays', key: APP_SETTING_KEYS.onboardingSessionDays, range: ONBOARDING_LIMITS.sessionDays, unit: 'days' },
    ] as const;
    for (const { field, key, range, unit } of integers) {
        const value = body[field];
        if (value === undefined) continue;
        if (empty(value)) { writes.push({ field, key, value: null }); continue; }
        const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
        const n = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
        if (!Number.isInteger(n) || n < range.min || n > range.max) {
            return { ok: false, field, error: `${field} must be a whole number of ${unit}, ${range.min} to ${range.max}.` };
        }
        writes.push({ field, key, value: String(n) });
    }

    if (body.defaultRole !== undefined) {
        if (empty(body.defaultRole)) writes.push({ field: 'defaultRole', key: APP_SETTING_KEYS.onboardingDefaultRole, value: null });
        else if (isInviteRole(body.defaultRole)) writes.push({ field: 'defaultRole', key: APP_SETTING_KEYS.onboardingDefaultRole, value: body.defaultRole });
        else return { ok: false, field: 'defaultRole', error: `defaultRole must be one of ${INVITE_ROLES.join(', ')}.` };
    }

    if (body.inviterName !== undefined) {
        if (empty(body.inviterName)) writes.push({ field: 'inviterName', key: APP_SETTING_KEYS.onboardingInviterName, value: null });
        else if (typeof body.inviterName !== 'string') return { ok: false, field: 'inviterName', error: 'inviterName must be text.' };
        else {
            const name = body.inviterName.trim();
            if (name.length > MAX_INVITER_NAME || CONTROL_CHARACTERS.test(name)) {
                return { ok: false, field: 'inviterName', error: `inviterName must be one line of at most ${MAX_INVITER_NAME} characters.` };
            }
            // The invite page is public: an email there would hand it to anybody holding a link.
            if (/@/.test(name)) return { ok: false, field: 'inviterName', error: 'inviterName is shown on a public page: use a name, never an email address.' };
            writes.push({ field: 'inviterName', key: APP_SETTING_KEYS.onboardingInviterName, value: name });
        }
    }

    if (body.whatsappText !== undefined) {
        if (empty(body.whatsappText)) writes.push({ field: 'whatsappText', key: APP_SETTING_KEYS.onboardingWhatsappText, value: null });
        else if (typeof body.whatsappText !== 'string') return { ok: false, field: 'whatsappText', error: 'whatsappText must be text.' };
        else {
            const text = body.whatsappText.trim();
            if (text.length > MAX_WHATSAPP_TEXT) return { ok: false, field: 'whatsappText', error: `whatsappText is at most ${MAX_WHATSAPP_TEXT} characters.` };
            if (!text.includes('{link}')) return { ok: false, field: 'whatsappText', error: 'whatsappText must contain {link}, where the invite link goes.' };
            writes.push({ field: 'whatsappText', key: APP_SETTING_KEYS.onboardingWhatsappText, value: text });
        }
    }

    if (body.defaultRules !== undefined) {
        if (body.defaultRules === null) writes.push({ field: 'defaultRules', key: APP_SETTING_KEYS.onboardingDefaultRules, value: null });
        else if (!Array.isArray(body.defaultRules)) return { ok: false, field: 'defaultRules', error: 'defaultRules must be a list of rules, or null for the default.' };
        else {
            const parsed = parseOnboardingRules(JSON.stringify(body.defaultRules));
            if (!parsed) return { ok: false, field: 'defaultRules', error: `defaultRules may only hold: ${CONTENT_RULE_PRESETS.join(', ')}.` };
            // `[]` is a deliberate "no rules", stored as such; only `null` returns to the default.
            writes.push({ field: 'defaultRules', key: APP_SETTING_KEYS.onboardingDefaultRules, value: JSON.stringify(parsed) });
        }
    }

    // What reads a new tenant's public accounts (the draft engine, docs/onboarding/03 §1).
    if (body.youtubeApiKey !== undefined) {
        // A secret: sending text saves it, `null` or an empty string removes the saved one (the environment's, if any, answers again).
        if (empty(body.youtubeApiKey)) writes.push({ field: 'youtubeApiKey', key: APP_SETTING_KEYS.youtubeApiKey, value: null });
        else if (typeof body.youtubeApiKey !== 'string' || !YOUTUBE_API_KEY_SHAPE.test(body.youtubeApiKey.trim())) {
            return { ok: false, field: 'youtubeApiKey', error: 'youtubeApiKey does not look like a Google API key: 20 to 256 letters, digits, dashes and underscores, as Google Cloud shows it.' };
        } else writes.push({ field: 'youtubeApiKey', key: APP_SETTING_KEYS.youtubeApiKey, value: body.youtubeApiKey.trim() });
    }

    if (body.discoveryCreatorId !== undefined) {
        // A tenant id; empty goes back to the owner's tenant. That the tenant EXISTS is the route's check: this file reads no tenants.
        if (empty(body.discoveryCreatorId)) writes.push({ field: 'discoveryCreatorId', key: APP_SETTING_KEYS.onboardingDiscoveryCreatorId, value: null });
        else if (typeof body.discoveryCreatorId !== 'string' || !UUID_SHAPE.test(body.discoveryCreatorId.trim())) {
            return { ok: false, field: 'discoveryCreatorId', error: 'discoveryCreatorId must be the id of a tenant.' };
        } else writes.push({ field: 'discoveryCreatorId', key: APP_SETTING_KEYS.onboardingDiscoveryCreatorId, value: body.discoveryCreatorId.trim().toLowerCase() });
    }

    return { ok: true, writes };
}

/** Google API keys are `AIza` and 35 characters today; any 20 to 256 of the URL-safe alphabet is accepted, so a key shape Google changes still saves. */
const YOUTUBE_API_KEY_SHAPE = /^[A-Za-z0-9_-]{20,256}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveOnboardingSettings(writes: readonly SettingWrite[], updatedBy: string | null): Promise<void> {
    for (const write of writes) await setSetting(write.key, write.value, updatedBy);
}

/** What the Settings card needs: the values in force, which of them are saved (the rest are defaults), and the limits and default texts. */
export async function describeOnboardingSettings(): Promise<{
    settings: OnboardingSettings;
    saved: Record<string, boolean>;
    limits: typeof ONBOARDING_LIMITS;
    whatsappDefaults: Record<InviteLang, string>;
    draftSources: DraftSourceSettings;
}> {
    const [settings, ...raw] = await Promise.all([
        getOnboardingSettings(),
        getSetting(APP_SETTING_KEYS.onboardingInviteTtlDays),
        getSetting(APP_SETTING_KEYS.onboardingResetTtlHours),
        getSetting(APP_SETTING_KEYS.onboardingDefaultRole),
        getSetting(APP_SETTING_KEYS.onboardingSessionDays),
        getSetting(APP_SETTING_KEYS.onboardingInviterName),
        getSetting(APP_SETTING_KEYS.onboardingWhatsappText),
        getSetting(APP_SETTING_KEYS.onboardingDefaultRules),
    ]);
    const [ttl, resetTtl, role, session, inviter, whatsapp, rules] = raw;
    return {
        settings,
        saved: {
            inviteTtlDays: ttl !== null, resetTtlHours: resetTtl !== null, defaultRole: role !== null, sessionDays: session !== null,
            inviterName: inviter !== null, whatsappText: whatsapp !== null, defaultRules: rules !== null,
        },
        limits: ONBOARDING_LIMITS,
        whatsappDefaults: DEFAULT_WHATSAPP_TEXT,
        draftSources: await describeDraftSources(),
    };
}

// ─── What reads a new tenant's accounts ─────────────────────────────────────────────────────────────────────────

/**
 * The two inputs the draft engine needs from the operator (docs/onboarding/03 §1), as Settings shows them: the YouTube Data API key,
 * which is a secret and is only ever described as `{set, source, last4}`, never returned; and the tenant whose connected Instagram
 * account reads OTHER people's public profiles (Business Discovery), with the tenants to choose from.
 */
export interface DraftSourceSettings {
    youtubeApiKey: { set: boolean; source: 'database' | 'env' | null; last4: string | null };
    discovery: {
        /** The tenant in force: the saved one, else the owner's. Null when there is neither. */
        creatorId: string | null;
        /** `setting`: saved here; `owner`: nothing (usable) saved, so the owner's tenant; `none`: no tenant at all. */
        source: 'setting' | 'owner' | 'none';
        name: string | null;
        /** The tenant has an Instagram account and token: without them Business Discovery cannot run. */
        connected: boolean;
    };
    tenants: Array<{ id: string; name: string | null; connected: boolean }>;
}

export async function describeDraftSources(): Promise<DraftSourceSettings> {
    const [youtube, savedId, owner, rows] = await Promise.all([
        getYouTubeApiKey(),
        getSetting(APP_SETTING_KEYS.onboardingDiscoveryCreatorId),
        getPlatformOwnerId(),
        queryRows<{ id: string; name: string | null; connected: boolean }>(
            `SELECT id, name, (instagram_page_id IS NOT NULL AND page_access_token IS NOT NULL) AS connected FROM creators WHERE is_active = true ORDER BY created_at, id LIMIT 500`,
        ),
    ]);
    const creatorId = pickDiscoveryCreatorId(savedId, owner);
    const saved = creatorId !== null && typeof savedId === 'string' && savedId.trim().toLowerCase() === creatorId;
    const chosen = creatorId ? rows.find((r) => r.id === creatorId) : undefined;
    return {
        youtubeApiKey: { set: youtube !== null, source: youtube ? youtube.source : null, last4: youtube ? last4(youtube.key) : null },
        discovery: { creatorId, source: creatorId === null ? 'none' : saved ? 'setting' : 'owner', name: chosen?.name ?? null, connected: chosen?.connected === true },
        tenants: rows.map((r) => ({ id: r.id, name: r.name ?? null, connected: r.connected === true })),
    };
}
