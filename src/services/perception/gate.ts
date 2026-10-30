/**
 * The gate every Meta Muse perception goes through, before a byte of media is downloaded or a token is spent (docs/specs/005-muse-sees T024).
 *
 *   gatePerception({ creatorId, senderId, kind, capability }) → { ok: true } | { ok: false, reason }
 *
 * The checks, cheapest first, and the first to refuse names the reason:
 *
 *   unsupported_kind     a kind perception does not read (a sticker, a file, a view-once), or a capability that does not fit the kind: `voice` is for a voice
 *                        note and `dm_media` for every other perceivable kind. `memory` (recall) reads no media, so it has no kind to check.
 *   switch_off           the tenant's switch for the capability is off (`muse.switches.<t>`, `switches.ts`). The default for every tenant.
 *   not_allowed_sender   the sender is not on the tenant's allow-list (`muse.allow_senders.<t>`): the switches alone open nothing to followers.
 *   no_key               no Meta route can answer perception: no key saved, or the route points elsewhere (`resolveRoute`, the providers layer).
 *   budget               today's spend on the perception purposes has reached the tenant's daily cap (`muse.daily_usd.<t>`).
 *
 * **Every refusal is the product as it was**: the caller sends today's line, and the gate logs `perception.skipped:<reason>` so that a person who asks
 * "why did it not see my reel?" finds the answer in one line. Nothing here throws: a settings, key or budget read that fails is a refusal (toward off).
 *
 * **The budget** is the day's `ai_usage.usd` for this tenant over the four purposes below, reservations included (the providers layer writes each call
 * at its worst-case cost first and corrects it when the call ends, so what is in flight counts: over-counting is the safe side of a cap). A day is the
 * UTC day, as for every other budget. It is a cap on top of the platform's own budgets, which still apply to each call.
 *
 * **The owner is told once a day** that the cap was reached, by the first refusal of the day: the deployment's Telegram bot and Resend key, Arabic then
 * English, no customer data in it. A cap of 0 is his own way to switch perception off, and tells him nothing. The claim is one atomic statement on
 * `app_settings` (`muse.budget_notice.<t>` holds the UTC day it was last told), so two refusals in the same instant send one message, and a send that
 * fails is not retried until tomorrow: an alert is never worth a second wait inside a DM.
 */
import { queryOne } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { AiError } from '../llm/errors.js';
import { tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { sendTelegramMessage, telegramReady } from '../notify.js';
import { effectiveTo, emailReady, readNotifyChannels, sendEmail } from '../notifyEmail.js';
import type { AiPurpose } from '../aiProviders/purposes.js';
import { resolveRoute } from '../aiProviders/route.js';
import { dayStart } from '../aiProviders/usage.js';
import { capabilityOn, readMuseSettings, senderAllowed, type MuseSettings } from './switches.js';
import { capabilityOfKind, type MuseCapability } from './types.js';

export type GateReason = 'switch_off' | 'not_allowed_sender' | 'budget' | 'unsupported_kind' | 'no_key';

export type GateResult = { ok: true } | { ok: false; reason: GateReason };

export interface GateArgs {
    creatorId: string;
    senderId: string;
    /** The word-less kind of the message (`describeWordless`). Not needed for `memory`, which reads text. */
    kind?: string | null;
    capability: MuseCapability;
}

/**
 * The `ai_usage.purpose` values the daily cap counts: perception of a DM, transcription of a voice note, recall, and the reel indexer. Comment intent and
 * offer cards were cut from the build, so they are not here; a phase that is added adds its purpose to this list, and only here.
 */
export const MUSE_BUDGET_PURPOSES: readonly string[] = Object.freeze(['perception_dm', 'perception_voice', 'recall', 'reel_index']);

/**
 * The routed purpose a perception call asks the providers layer on, and so the one the key check resolves. It names a purpose the Meta provider's change
 * (P0) registers in `AI_PURPOSES` with `meta` as the only provider that may answer it; typed as a string until that change is on this branch.
 */
const PERCEPTION_PURPOSE: string = 'perception_dm';

// ─── What the gate reads (each one replaceable, so a test never reaches a database or a provider) ───────────────────────────

export interface GateDeps {
    now?: () => Date;
    readSettings?: (creatorId: string) => Promise<MuseSettings>;
    /** Today's spend on the budget purposes, in USD. Throws when it cannot be read. */
    spentToday?: (creatorId: string, now: Date) => Promise<number>;
    /** Whether a Meta route can answer perception. Throws when it cannot tell. */
    routeReady?: (creatorId: string) => Promise<boolean>;
    /** Tells the owner the cap was reached, once a day. Never throws. */
    tellOwner?: (notice: BudgetNotice) => Promise<void>;
}

export interface BudgetNotice {
    creatorId: string;
    spentUsd: number;
    capUsd: number;
    now: Date;
}

/** Today's `ai_usage.usd` for the tenant over `MUSE_BUDGET_PURPOSES`: settled calls and reservations alike. */
export async function spentTodayUsd(creatorId: string, now: Date): Promise<number> {
    const row = await queryOne<{ usd: number | string | null }>(
        `SELECT COALESCE(SUM(usd), 0)::float8 AS usd
           FROM ai_usage
          WHERE creator_id = $1 AND purpose = ANY($2::text[]) AND at >= $3`,
        [creatorId, [...MUSE_BUDGET_PURPOSES], dayStart(now)]
    );
    const usd = Number(row?.usd ?? 0);
    if (!Number.isFinite(usd)) throw new Error('ai_usage returned a spend that is not a number.');
    return usd;
}

/** Whether the providers layer has a route that can answer perception. Only "no provider" is a no: any other failure is thrown, and the gate refuses on it. */
export async function perceptionRouteReady(creatorId: string): Promise<boolean> {
    try {
        await resolveRoute(PERCEPTION_PURPOSE as AiPurpose, creatorId);
        return true;
    } catch (err) {
        if (err instanceof AiError && err.kind === 'no_provider') return false;
        throw err;
    }
}

// ─── The notice ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The owner's notice in both languages, Arabic first (the other alerts' admin copy). No tenant name, no customer, no id: amounts and what to do. Pure. */
export function buildBudgetNotice(spentUsd: number, capUsd: number): { subject: string; text: string } {
    const ar = [
        'AutoReply · توقفت رؤية ميتا لبقية اليوم: بلغ ما أُنفق عليها الحد اليومي',
        `أُنفق ${usd(spentUsd)} من حد ${usd(capUsd)}. الرسائل التي بلا كلمات تُجاب بالسطر الثابت حتى منتصف الليل بتوقيت UTC، ثم يعود العمل من تلقاء نفسه.`,
        'المطلوب: ارفع الحد اليومي من إعدادات رؤية ميتا إن أردت أن تستمر اليوم.',
    ].join('\n');
    const en = [
        'AutoReply · Meta vision is paused for the rest of the day: its daily cap was reached',
        `Spent ${usd(spentUsd)} of a ${usd(capUsd)} cap. Messages with no words get the fixed line until 00:00 UTC, then it resumes by itself.`,
        'What to do: raise the daily cap in the Meta vision settings if you want it to keep going today.',
    ].join('\n');
    return { subject: 'AutoReply · Meta vision paused: daily cap reached', text: `${ar}\n\n${en}` };
}

/** The UTC day, `YYYY-MM-DD`: what the notice's marker holds. */
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Take today's notice for the tenant: true for the ONE call that wrote today's date over the stored one, false for every other that day. A single
 * statement, so the database decides between two refusals that arrive together (`ON CONFLICT … WHERE` finds no row to change the second time).
 */
export async function claimBudgetNotice(creatorId: string, now: Date): Promise<boolean> {
    const row = await queryOne<{ key: string }>(
        `INSERT INTO app_settings (key, value, is_secret, updated_at)
         VALUES ($1, $2, FALSE, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value
         RETURNING key`,
        [tenantSettingKey(TENANT_SETTING_PREFIXES.museBudgetNotice, creatorId), dayOf(now)]
    );
    return row !== null;
}

type ChannelOutcome = 'sent' | 'failed' | 'off';

/**
 * The owner's own channels (`notify.*`: the deployment's Telegram bot and Resend key), each one's outcome. Both are asked at once, so the first refusal of
 * the day waits for the slower of two 5 s timeouts at most, not their sum. `sendTelegramMessage` and `sendEmail` never throw.
 */
async function sendNotice(notice: { subject: string; text: string }): Promise<{ telegram: ChannelOutcome; email: ChannelOutcome }> {
    const channels = await readNotifyChannels();
    const tg = channels.telegram;
    const to = effectiveTo(channels.email);
    const [telegram, email] = await Promise.all([
        telegramReady(tg) ? sendTelegramMessage({ token: tg.token, chatId: tg.chatId }, notice.text) : null,
        emailReady(channels.email) && to ? sendEmail({ apiKey: channels.email.apiKey, to, from: channels.email.from }, notice) : null,
    ]);
    return { telegram: telegram === null ? 'off' : telegram.ok ? 'sent' : 'failed', email: email === null ? 'off' : email.ok ? 'sent' : 'failed' };
}

/**
 * Tell the owner the cap was reached, if nobody has today. NEVER throws: the customer's message is being answered with today's line either way.
 * The log line says which channels were tried, so an owner who was not told can see why (no channel on, or both refused).
 */
export async function tellOwnerBudgetReached(notice: BudgetNotice): Promise<void> {
    const logBase = { creator_id: notice.creatorId };
    try {
        if (!(await claimBudgetNotice(notice.creatorId, notice.now))) return;
        const sent = await sendNotice(buildBudgetNotice(notice.spentUsd, notice.capUsd));
        log(sent.telegram === 'sent' || sent.email === 'sent' ? 'info' : 'warn', 'perception.budget_notice', { ...logBase, telegram: sent.telegram, email: sent.email });
    } catch (err) {
        log('warn', 'perception.budget_notice_failed', { ...logBase, ...describeError(err) });
    }
}

// ─── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function gatePerception(args: GateArgs, deps: GateDeps = {}): Promise<GateResult> {
    const { creatorId, senderId, capability } = args;
    const kind = args.kind ?? null;
    const now = (deps.now ?? (() => new Date()))();
    const logBase = { creator_id: creatorId, capability, kind };

    const refuse = (reason: GateReason, level: 'info' | 'warn' = 'info'): GateResult => {
        log(level, `perception.skipped:${reason}`, logBase);
        return { ok: false, reason };
    };

    // 1. The kind, from nothing but the arguments.
    if (capability !== 'memory' && capabilityOfKind(kind) !== capability) return refuse('unsupported_kind');

    // 2. The tenant's switch, and who it is open to. `readMuseSettings` fails toward off, so a read that broke is a refusal here.
    const settings = await (deps.readSettings ?? readMuseSettings)(creatorId);
    if (!capabilityOn(settings, capability)) return refuse('switch_off');
    if (!senderAllowed(settings.allowSenders, senderId)) return refuse('not_allowed_sender');

    // 3. A Meta route that can answer. A check that cannot be made is a no, not a guess.
    let routeReady = false;
    try {
        routeReady = await (deps.routeReady ?? perceptionRouteReady)(creatorId);
    } catch (err) {
        log('warn', 'perception.route_unreadable', { creator_id: creatorId, ...describeError(err) });
    }
    if (!routeReady) return refuse('no_key', 'warn');

    // 4. Today's spend against the cap. A spend that cannot be read is refused as spent, and the owner is not told the cap was reached: it was not shown to be.
    let spentUsd: number;
    try {
        spentUsd = await (deps.spentToday ?? spentTodayUsd)(creatorId, now);
    } catch (err) {
        log('warn', 'perception.budget_unreadable', { creator_id: creatorId, ...describeError(err) });
        return refuse('budget', 'warn');
    }
    if (spentUsd >= settings.dailyUsd) {
        log('warn', 'perception.budget_reached', { creator_id: creatorId, spent_usd: spentUsd, cap_usd: settings.dailyUsd });
        // A cap of 0 is the owner's own way to keep perception off by money: there is nothing to tell him about a day that was never allowed to spend.
        if (settings.dailyUsd > 0) await (deps.tellOwner ?? tellOwnerBudgetReached)({ creatorId, spentUsd, capUsd: settings.dailyUsd, now });
        return refuse('budget', 'warn');
    }

    return { ok: true };
}
