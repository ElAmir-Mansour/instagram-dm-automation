/**
 * What the owner is told when something happens to a WhatsApp number (docs/specs/001-whatsapp-agent tasks T023/T024, review H6).
 *
 * Meta tells us in two ways: webhooks (`account_update`, `phone_number_quality_update` …) and the daily health read. Either way the
 * state is first written to the connection (`whatsappAccount.ts` decides that), and only the change that really happened reaches this file,
 * once. Nothing here decides WHETHER to tell: it renders an alert and sends it.
 *
 * The channel is the operator's Telegram bot (`notify.ts`): the only per-owner channel the product has, global rather than per tenant. The
 * text names WhatsApp and the number (and the verified name), never a customer: an alert here is about the account, so it carries nothing
 * from a conversation. Everything Meta wrote that is shown (an alert's description, a rejection reason) goes through `excerpt`, which
 * removes links and bidi controls and cuts it, the same rule that protects the handoff alert.
 *
 * Both languages in one message, Arabic first: the owner reads Arabic, and Meta's own words and codes (`RED`, `TIER_250`, `ADULT`) are
 * English, so the message states them as Meta did instead of translating a code into a guess.
 *
 * `notifyWhatsAppOwner` NEVER throws. The state change is already stored, and a failed alert must not fail the job that stored it (a retry
 * would find the change already applied and say nothing, so a throw would not even buy a second try).
 */
import { describeError, log } from '../utils/log.js';
import { excerpt, readTelegramSettings, sendTelegramMessage, telegramReady } from './notify.js';

/** What happened. One kind per distinct change the owner may need to act on. */
export type WhatsAppAlert =
    | { kind: 'quality'; from: string | null; to: string }
    | { kind: 'limit'; from: string | null; to: string }
    | { kind: 'number_status'; from: string | null; to: string }
    | { kind: 'name'; decision: string; name: string | null; reason: string | null }
    | { kind: 'capability'; from: number | null; to: number; phoneNumbers: number | null }
    | { kind: 'restriction'; types: string[]; expiresAt: string | null; stopsSending: boolean }
    | { kind: 'violation'; type: string }
    | { kind: 'ban'; state: string; date: string | null }
    | { kind: 'disconnected'; event: string; reason: string | null; initiatedBy: string | null }
    | { kind: 'reconnected' }
    | { kind: 'account_alert'; severity: string; type: string; description: string | null }
    | { kind: 'connection_invalid'; code: number | null; reason: string | null }
    | { kind: 'connection_restored' }
    | { kind: 'free_tier'; used: number; limit: number; allowBillable: boolean };

/** Which number, in the words the owner knows it by. */
export interface WhatsAppAlertTarget {
    /** `profile.display_phone_number`, or null. */
    number: string | null;
    /** Meta's verified name (`platform_connections.display_name`), or null. */
    name: string | null;
    /** The `phone_number_id`: the fallback when Meta never told us the number itself. */
    phoneNumberId: string;
}

/** `sent`; `off` = alerts are not switched on or half the address is missing; `failed` = Telegram said no; `error` = something on our side threw. */
export type WhatsAppNoticeOutcome = 'sent' | 'off' | 'failed' | 'error';

interface Words {
    ar: string;
    en: string;
}

const both = (ar: string, en: string): Words => ({ ar, en });

/** The sentence a rating change reads as, by what it moved to. */
function qualityWords(from: string | null, to: string): { headline: Words; action: Words } {
    const was = from ? `${from} → ${to}` : to;
    if (to === 'GREEN') {
        return {
            headline: both(`جودة الرقم عادت جيدة (${was})`, `Quality is good again (${was})`),
            action: both('لا يلزم أي إجراء.', 'Nothing to do.'),
        };
    }
    return {
        headline: both(`جودة الرقم تراجعت (${was})`, `Quality dropped (${was})`),
        action: both(
            'راجع ردود المساعد الأخيرة واحذف ما قد يزعج العملاء. الجودة المنخفضة تخفض حد المراسلة وقد تقيّد الرقم.',
            'Review the assistant\'s recent replies and remove what could annoy customers. Low quality lowers the messaging limit and can restrict the number.'
        ),
    };
}

/** The alert as a headline, a detail line, and what to do, in both languages. Pure. */
function wordsOf(alert: WhatsAppAlert): { headline: Words; detail: Words | null; action: Words } {
    switch (alert.kind) {
        case 'quality': {
            const { headline, action } = qualityWords(alert.from, alert.to);
            return { headline, detail: null, action };
        }
        case 'limit':
            return {
                headline: both(`حد المراسلة تغيّر${alert.from ? ` (${alert.from} → ${alert.to})` : ` (${alert.to})`}`, `Messaging limit changed${alert.from ? ` (${alert.from} to ${alert.to})` : ` (${alert.to})`}`),
                detail: null,
                action: both('لا يلزم إجراء إلا إذا انخفض الحد: قلّل الرسائل التي يبدؤها النشاط وراقب الجودة.', 'Nothing to do unless it went down: send fewer business-started messages and watch quality.'),
            };
        case 'number_status': {
            const bad = alert.to !== 'CONNECTED';
            return {
                headline: both(`حالة الرقم: ${alert.to}${alert.from ? ` (كانت ${alert.from})` : ''}`, `Number status: ${alert.to}${alert.from ? ` (was ${alert.from})` : ''}`),
                detail: null,
                action: bad
                    ? both('افتح مدير واتساب في ميتا وراجع سبب الحالة، وتجنب إرسال رسائل جديدة غير ضرورية حتى تعود.', 'Open WhatsApp Manager in Meta, check why, and avoid unnecessary new messages until it is back to CONNECTED.')
                    : both('لا يلزم أي إجراء.', 'Nothing to do.'),
            };
        }
        case 'name': {
            const name = excerpt(alert.name ?? '', 80);
            const approved = alert.decision === 'APPROVED';
            const reason = alert.reason ? excerpt(alert.reason, 120) : '';
            return {
                headline: approved
                    ? both(`اعتُمد اسم النشاط${name ? `: ${name}` : ''}`, `Business name approved${name ? `: ${name}` : ''}`)
                    : both(`رُفض اسم النشاط${name ? `: ${name}` : ''}`, `Business name ${alert.decision.toLowerCase()}${name ? `: ${name}` : ''}`),
                detail: reason ? both(`السبب: ${reason}`, `Reason: ${reason}`) : null,
                action: approved
                    ? both('لا يلزم أي إجراء.', 'Nothing to do.')
                    : both('عدّل الاسم في مدير واتساب ليطابق اسم نشاطك ثم أعد الطلب.', 'Edit the name in WhatsApp Manager so it matches your business, then submit it again.'),
            };
        }
        case 'capability':
            return {
                headline: both(
                    `الحد اليومي للمحادثات التي يبدؤها النشاط: ${alert.to.toLocaleString('en-US')}${alert.from !== null ? ` (كان ${alert.from.toLocaleString('en-US')})` : ''}`,
                    `Daily business-initiated limit: ${alert.to.toLocaleString('en-US')}${alert.from !== null ? ` (was ${alert.from.toLocaleString('en-US')})` : ''}`
                ),
                detail: alert.phoneNumbers !== null ? both(`أقصى عدد أرقام: ${alert.phoneNumbers}`, `Max phone numbers: ${alert.phoneNumbers}`) : null,
                action: both('لا يلزم أي إجراء. ردود المساعد داخل نافذة الـ 24 ساعة لا تُحسب ضمن هذا الحد.', 'Nothing to do. Replies inside the 24-hour window do not count against this limit.'),
            };
        case 'restriction': {
            const types = alert.types.map((t) => excerpt(t, 60)).join(', ');
            const until = alert.expiresAt ? alert.expiresAt.slice(0, 10) : null;
            return {
                headline: alert.stopsSending
                    ? both('قيّدت ميتا الرقم: توقف الإرسال', 'Meta restricted the number: sending is stopped')
                    : both('قيّدت ميتا الحساب (الردود لا تتأثر)', 'Meta restricted the account (replies are not affected)'),
                detail: both(`القيود: ${types}${until ? `، حتى ${until}` : ''}`, `Restrictions: ${types}${until ? `, until ${until}` : ''}`),
                action: alert.stopsSending
                    ? both('لن يرد المساعد حتى تنتهي المدة. افتح مدير واتساب لقراءة السبب واتبع خطوات الاعتراض إن وُجدت.', 'The assistant will not reply until it ends. Open WhatsApp Manager, read the reason and follow its appeal steps if offered.')
                    : both('راجع سياسة ميتا للرسائل التجارية في مدير واتساب لتفادي تقييد أشد.', 'Review Meta\'s business messaging policy in WhatsApp Manager to avoid a stricter restriction.'),
            };
        }
        case 'violation':
            return {
                headline: both(`رصدت ميتا مخالفة على الحساب: ${excerpt(alert.type, 60)}`, `Meta recorded a policy violation: ${excerpt(alert.type, 60)}`),
                detail: null,
                action: both('افتح مدير واتساب لقراءة التفاصيل. تكرار المخالفة يؤدي إلى تقييد الحساب أو تعطيله.', 'Open WhatsApp Manager for the details. Repeating it leads to a restriction or a disabled account.'),
            };
        case 'ban': {
            const date = alert.date ? excerpt(alert.date, 40) : '';
            if (alert.state === 'REINSTATE') {
                return { headline: both('أعادت ميتا تفعيل الحساب', 'Meta reinstated the account'), detail: date ? both(`التاريخ: ${date}`, `Date: ${date}`) : null, action: both('لا يلزم أي إجراء.', 'Nothing to do.') };
            }
            const scheduled = alert.state === 'SCHEDULE_FOR_DISABLE';
            return {
                headline: scheduled ? both('ميتا ستعطّل الحساب قريباً', 'Meta is going to disable the account') : both('عطّلت ميتا الحساب: توقف الإرسال', 'Meta disabled the account: sending is stopped'),
                detail: date ? both(`التاريخ: ${date}`, `Date: ${date}`) : null,
                action: scheduled
                    ? both('افتح مدير واتساب الآن لمعرفة السبب وتقديم اعتراض قبل التعطيل.', 'Open WhatsApp Manager now to see why and appeal before it is disabled.')
                    : both('لن يرد المساعد. افتح مدير واتساب وقدّم اعتراضاً على القرار.', 'The assistant will not reply. Open WhatsApp Manager and appeal the decision.'),
            };
        }
        case 'disconnected': {
            const reason = alert.reason ? excerpt(alert.reason, 80) : null;
            const by = alert.initiatedBy ? excerpt(alert.initiatedBy, 40) : null;
            return {
                headline: both('انقطع اتصال رقم واتساب بالنظام: توقف الإرسال', 'The WhatsApp number was disconnected: sending is stopped'),
                detail: both(
                    `${excerpt(alert.event, 40)}${reason ? `، السبب: ${reason}` : ''}${by ? `، بواسطة: ${by}` : ''}`,
                    `${excerpt(alert.event, 40)}${reason ? `, reason: ${reason}` : ''}${by ? `, by: ${by}` : ''}`
                ),
                action: both('أعد ربط الرقم من الإعدادات (قسم واتساب). الرسائل الواردة تُحفظ لكن لا يُرسل رد.', 'Reconnect the number in Settings (WhatsApp section). Incoming messages are still stored, but no reply is sent.'),
            };
        }
        case 'reconnected':
            return {
                headline: both('عاد اتصال رقم واتساب بالنظام', 'The WhatsApp number is connected again'),
                detail: null,
                action: both('لا يلزم أي إجراء. سيتحقق الفحص اليومي من الرمز.', 'Nothing to do. The daily check will verify the token.'),
            };
        case 'account_alert': {
            const description = alert.description ? excerpt(alert.description, 220) : null;
            return {
                headline: both(`تنبيه من ميتا (${excerpt(alert.severity, 20)}): ${excerpt(alert.type, 70)}`, `Meta alert (${excerpt(alert.severity, 20)}): ${excerpt(alert.type, 70)}`),
                detail: description ? both(description, description) : null,
                action: both('افتح مدير واتساب لقراءة التنبيه.', 'Open WhatsApp Manager to read the alert.'),
            };
        }
        case 'connection_invalid': {
            const reason = alert.reason ? excerpt(alert.reason, 200) : null;
            return {
                headline: both('رفضت ميتا رمز واتساب أو صلاحيته: توقف الإرسال', 'Meta refused the WhatsApp token or its permission: sending is stopped'),
                detail: reason || alert.code !== null ? both(`${alert.code !== null ? `الرمز ${alert.code}: ` : ''}${reason ?? ''}`, `${alert.code !== null ? `Code ${alert.code}: ` : ''}${reason ?? ''}`) : null,
                action: both('ولّد رمز مستخدم نظام جديد وألصقه في الإعدادات (قسم واتساب). الرسائل الواردة تُحفظ لكن لا يُرسل رد.', 'Generate a new system-user token and paste it in Settings (WhatsApp section). Incoming messages are still stored, but no reply is sent.'),
            };
        }
        case 'connection_restored':
            return {
                headline: both('عاد رقم واتساب للعمل', 'The WhatsApp number works again'),
                detail: null,
                action: both('لا يلزم أي إجراء.', 'Nothing to do.'),
            };
        case 'free_tier': {
            const used = `${alert.used.toLocaleString('en-US')} / ${alert.limit.toLocaleString('en-US')}`;
            const out = alert.used >= alert.limit;
            return {
                headline: out
                    ? both(`انتهت الردود المجانية هذا الشهر (${used})`, `The free replies for this month are used up (${used})`)
                    : both(`اقتربت الردود المجانية من النهاية (${used})`, `The free replies are almost used up (${used})`),
                detail: null,
                action: alert.allowBillable
                    ? both('الردود الإضافية مدفوعة وتُحتسب على بطاقتك في ميتا.', 'Further replies are billable and are charged to your payment method at Meta.')
                    : both('بعد الحد تتوقف الردود حتى الشهر القادم، أو فعّل الردود المدفوعة وأضف وسيلة دفع في ميتا من الإعدادات (قسم واتساب).', 'After the limit replies stop until next month, unless you allow billable replies and add a payment method at Meta in Settings (WhatsApp section).'),
            };
        }
        default: {
            const never: never = alert;
            return { headline: both('حدث تغيير في رقم واتساب', 'Something changed on the WhatsApp number'), detail: null, action: both('افتح الإعدادات (قسم واتساب).', `Open Settings (WhatsApp section). (${(never as { kind?: string })?.kind ?? ''})`) };
        }
    }
}

/** How the number is named: «+20 100 …» and the verified name when Meta gave one, else the `phone_number_id`. */
export function describeNumber(target: WhatsAppAlertTarget): string {
    const number = target.number ? excerpt(target.number, 30) : `ID ${target.phoneNumberId}`;
    const name = target.name ? excerpt(target.name, 60) : '';
    return name ? `${number} (${name})` : number;
}

/** The alert as one plain-text message, Arabic then English. Pure. */
export function buildWhatsAppAlertText(alert: WhatsAppAlert, target: WhatsAppAlertTarget): string {
    const w = wordsOf(alert);
    const who = describeNumber(target);
    const block = (lang: 'ar' | 'en'): string[] => {
        const lines = [
            lang === 'ar' ? `واتساب: ${w.headline.ar}` : `WhatsApp: ${w.headline.en}`,
            lang === 'ar' ? `الرقم: ${who}` : `Number: ${who}`,
        ];
        if (w.detail) lines.push(w.detail[lang]);
        lines.push(lang === 'ar' ? `المطلوب: ${w.action.ar}` : `What to do: ${w.action.en}`);
        return lines;
    };
    return [...block('ar'), '', ...block('en')].join('\n');
}

/**
 * Tell the owner. NEVER throws (see the top of the file). `off` when alerts are not switched on: the change is stored either way and shows on
 * the Settings card.
 */
export async function notifyWhatsAppOwner(alert: WhatsAppAlert, target: WhatsAppAlertTarget): Promise<WhatsAppNoticeOutcome> {
    const logBase = { kind: alert.kind, phone_number_id: target.phoneNumberId };
    try {
        const settings = await readTelegramSettings();
        if (!telegramReady(settings)) {
            log('info', 'wa.alert_not_sent', { ...logBase, why: 'alerts_off' });
            return 'off';
        }
        const result = await sendTelegramMessage({ token: settings.token, chatId: settings.chatId }, buildWhatsAppAlertText(alert, target));
        if (!result.ok) {
            log('warn', 'wa.alert_failed', { ...logBase, outcome: result.reason, status: result.status, description: result.description });
            return 'failed';
        }
        log('info', 'wa.alert_sent', logBase);
        return 'sent';
    } catch (err) {
        log('warn', 'wa.alert_error', { ...logBase, ...describeError(err) });
        return 'error';
    }
}
