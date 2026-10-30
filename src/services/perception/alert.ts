/**
 * The owner is told once a day that Meta will not read what customers send, because its model service refused the key or has no credit left
 * (`contracts/perception.md`, errors table: "401/403 → failed / provider_error; today's line; one owner alert per day").
 *
 * A message that cannot be read is answered with the line it always got, so nothing is lost for the customer, and that is exactly the problem: nobody sees a
 * refused key. The log line is gone in an hour and the dashboard says "on". So the first refusal of the day tells the owner, on the channels he switched on (the
 * deployment's Telegram bot and Resend key, Arabic then English, no customer, no tenant, no id), and the rest of that day tell nobody: the claim is one atomic
 * statement on `app_settings` (`muse.provider_notice.<t>` holds the UTC day it was last told), so two refusals in the same instant send one message. A send that
 * fails is not retried until tomorrow: an alert is never worth a second wait inside a customer's DM. NEVER throws.
 */
import { queryOne } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { sendNotice } from './gate.js';

export type ProviderTrouble = 'auth' | 'quota';

/** The notice in both languages, Arabic first. Amounts and what to do; nothing about any customer. Pure. */
export function buildProviderNotice(kind: ProviderTrouble): { subject: string; text: string } {
    const why = kind === 'auth'
        ? { ar: 'رفض مزوّد النماذج مفتاح ميتا', en: 'the model service refused the Meta key', fixAr: 'تحقق من مفتاح Meta في الإعدادات ← مزوّدو الذكاء الاصطناعي.', fixEn: 'Check the Meta key in Settings → AI providers.' }
        : { ar: 'انتهى رصيد حساب ميتا للنماذج', en: 'the Meta model account has no credit left', fixAr: 'أضف رصيداً أو حدّاً أعلى في حساب ميتا للنماذج.', fixEn: 'Add credit, or a higher limit, in the Meta model account.' };
    const ar = [
        `AutoReply · توقفت رؤية ميتا: ${why.ar}`,
        'الرسائل التي بلا كلمات تُجاب بالسطر الثابت إلى أن يُصلح هذا. لا يضيع منها شيء.',
        `المطلوب: ${why.fixAr}`,
    ].join('\n');
    const en = [
        `AutoReply · Meta vision stopped: ${why.en}`,
        'Messages with no words get the fixed line until this is fixed. Nothing is lost.',
        `What to do: ${why.fixEn}`,
    ].join('\n');
    return { subject: `AutoReply · Meta vision stopped: ${why.en}`, text: `${ar}\n\n${en}` };
}

/** The UTC day, `YYYY-MM-DD`: what the marker holds. */
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** Take today's notice for the tenant: true for the ONE call that wrote today's date over the stored one, false for every other that day. One statement. */
export async function claimProviderNotice(creatorId: string, now: Date): Promise<boolean> {
    const row = await queryOne<{ key: string }>(
        `INSERT INTO app_settings (key, value, is_secret, updated_at)
         VALUES ($1, $2, FALSE, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value
         RETURNING key`,
        [tenantSettingKey(TENANT_SETTING_PREFIXES.museProviderNotice, creatorId), dayOf(now)]
    );
    return row !== null;
}

export interface ProviderNoticeDeps {
    now?: () => Date;
    claim?: typeof claimProviderNotice;
    send?: typeof sendNotice;
}

/** Tell the owner, if nobody has today. Never throws: the customer is being answered with the usual line either way. */
export async function tellOwnerProviderTrouble(creatorId: string, kind: ProviderTrouble, deps: ProviderNoticeDeps = {}): Promise<void> {
    const logBase = { creator_id: creatorId, trouble: kind };
    try {
        const now = (deps.now ?? (() => new Date()))();
        if (!(await (deps.claim ?? claimProviderNotice)(creatorId, now))) return;
        const sent = await (deps.send ?? sendNotice)(buildProviderNotice(kind));
        log(sent.telegram === 'sent' || sent.email === 'sent' ? 'info' : 'warn', 'perception.provider_notice', { ...logBase, telegram: sent.telegram, email: sent.email });
    } catch (err) {
        log('warn', 'perception.provider_notice_failed', { ...logBase, ...describeError(err) });
    }
}
