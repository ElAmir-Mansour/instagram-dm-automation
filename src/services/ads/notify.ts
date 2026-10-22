/**
 * Ads alerts (research R8, R9), modelled on whatsappNotify.ts: a typed union of what happened, one rendering in Arabic and English, and a
 * sender that NEVER throws (the state that caused the alert is already stored, and a failed alert must not fail the guard or the health
 * check that found it).
 *
 *   - Once per (tenant, kind, object, day): the `ads_alerts` row is inserted first, and a second alert that day finds it and is not sent.
 *     The day is the ad account's own.
 *   - To the TENANT's own recipients (`ads.alerts.<tenant>`: a Telegram chat id, an email address, a language), through the deployment's
 *     Telegram bot and Resend key: only the recipient is per tenant. A kind the tenant switched off is not sent to the tenant, except the
 *     ones that cannot be (`REQUIRED_ALERT_KINDS`: spending may be running with nobody watching).
 *   - A copy in both languages to the platform admin's own channels (the `notify.*` settings), unless `ads.copy_admin` is 'false'. A
 *     channel the tenant shares with the admin gets one message, not two.
 *   - Each channel's outcome is written on the row: `sent`, `failed` or `off`.
 *
 * What an alert says is about the ad account (its name or id, amounts, Meta's status and reason), never about a customer, and anything
 * Meta wrote passes through `excerpt` (links and bidi controls removed). Never a token.
 */
import { describeError, log } from '../../utils/log.js';
import { queryOne } from '../../db/query.js';
import { APP_SETTING_KEYS, getSetting } from '../appSettings.js';
import { excerpt, sendTelegramMessage, telegramReady } from '../notify.js';
import { effectiveTo, emailReady, readNotifyChannels, sendEmail } from '../notifyEmail.js';
import { readAlerts, type AdsAlertKind } from './settings.js';

export type AdsAlert =
    | { kind: 'cap_paused'; spent: number; cap: number; nextDay: number; paused: number; currency: string }
    | { kind: 'payment'; reason: 'no_payment_method' | 'unsettled' | 'grace_period'; status: number | null }
    | { kind: 'account_disabled'; status: number | null; label: string; disableReason: string | null }
    | { kind: 'token_dead'; code: number | null }
    | { kind: 'token_expiring'; expiresAt: string; daysLeft: number }
    | { kind: 'guard_blind'; since: string | null; reason: string }
    | { kind: 'version_mismatch'; pinned: string; served: string }
    | { kind: 'ad_rejected' | 'ad_issues'; adId: string; adName: string | null; reason: string | null }
    // A3: ads → DM attribution (`ads/attribution.ts`).
    | { kind: 'business_ai'; conversationId: string }
    | { kind: 'window_error'; platform: 'instagram' | 'messenger'; conversationId: string }
    // A7: the daily review made proposals (`ads/proposals/service.ts`). Nothing changed: they wait for the owner.
    | { kind: 'proposal_ready'; count: number; titles: string[] };

export interface AdsAlertTarget {
    creatorId: string;
    adAccountId: string | null;
    /** Meta's name for the ad account, when known. */
    accountName: string | null;
    /** The account's UTC offset, for the day the alert belongs to. */
    offsetHours: number;
}

export type ChannelOutcome = 'sent' | 'failed' | 'off';

export interface AdsAlertChannels {
    telegram: ChannelOutcome;
    email: ChannelOutcome;
    admin_copy: ChannelOutcome;
}

export interface AdsAlertResult {
    outcome: 'sent' | 'duplicate' | 'error';
    channels: AdsAlertChannels;
}

// ─── The words ──────────────────────────────────────────────────────────────────────────────

type Lang = 'ar' | 'en';

const money = (n: number, currency: string) => `${n} ${currency}`;

function headline(a: AdsAlert, lang: Lang): string {
    const ar = lang === 'ar';
    switch (a.kind) {
        case 'cap_paused': return ar ? 'أُوقفت كل الحملات النشطة مؤقتًا: بلغ الإنفاق حدّك الشهري' : 'Every active campaign was paused: spending reached your monthly cap';
        case 'payment': return ar ? 'مشكلة في الدفع في حساب الإعلانات' : 'A payment problem on the ad account';
        case 'account_disabled': return ar ? 'حساب الإعلانات معطَّل أو مغلق' : 'The ad account is disabled or closed';
        case 'token_dead': return ar ? 'توقف رمز الإعلانات عن العمل' : 'The ads token stopped working';
        case 'token_expiring': return ar ? 'رمز الإعلانات على وشك الانتهاء' : 'The ads token expires soon';
        case 'guard_blind': return ar ? 'الإنفاق غير مراقَب: تعذّر فحص الحد الشهري منذ ساعتين' : 'Spending is not being watched: the monthly cap could not be checked for 2 hours';
        case 'version_mismatch': return ar ? 'ميتا تجيب بإصدار مختلف من واجهة الإعلانات' : 'Meta is answering on a different Marketing API version';
        case 'ad_rejected': return ar ? 'رفضت ميتا إعلانًا' : 'Meta rejected an ad';
        case 'ad_issues': return ar ? 'إعلان فيه مشكلات عند ميتا' : 'An ad has issues at Meta';
        case 'business_ai': return ar ? 'ذكاء ميتا للأعمال يتولى محادثة، فلا يستطيع المساعد الرد' : 'Meta Business AI holds a conversation, so the assistant cannot reply';
        case 'window_error': return ar ? 'رفضت ميتا ردًّا خارج نافذة المراسلة، فأُطفئت النافذة الأطول' : 'Meta refused a reply outside the messaging window; the longer window was switched off';
        case 'proposal_ready': return ar ? 'اقترح Claude تغييرات على إعلاناتك' : 'Claude proposed changes to your ads';
    }
}

function detail(a: AdsAlert, lang: Lang): string[] {
    const ar = lang === 'ar';
    switch (a.kind) {
        case 'cap_paused':
            return [
                ar ? `أُنفق هذا الشهر: ${money(a.spent, a.currency)} من حدّ ${money(a.cap, a.currency)}، ويوم آخر قد يضيف ${money(a.nextDay, a.currency)}.` : `Spent this month: ${money(a.spent, a.currency)} of a ${money(a.cap, a.currency)} cap; one more day could add ${money(a.nextDay, a.currency)}.`,
                ar ? `أوقفنا ${a.paused} حملة مؤقتًا، ومنها ما أُنشئ في مدير إعلانات ميتا.` : `${a.paused} campaign(s) paused, including any made in Meta Ads Manager.`,
                ar ? 'المطلوب: ارفع الحد في الإعدادات إن أردت، ثم استأنف الحملات من شاشة الإعلانات.' : 'What to do: raise the cap in Settings if you want to, then resume campaigns from the Ads screen.',
            ];
        case 'payment':
            return [
                a.reason === 'no_payment_method'
                    ? (ar ? 'لا توجد وسيلة دفع في الحساب، فلن يُعرض أي إعلان.' : 'There is no payment method on the account, so nothing can run.')
                    : a.reason === 'unsettled'
                        ? (ar ? 'على الحساب مبلغ مستحق لم يُسدَّد.' : 'The account has an unpaid balance.')
                        : (ar ? 'الحساب في مهلة سداد.' : 'The account is in a payment grace period.'),
                ar ? 'المطلوب: أصلح الدفع في صفحة الفوترة في ميتا (لا يستطيع التطبيق إضافة وسيلة دفع).' : 'What to do: fix it on Meta\'s billing page (the app cannot add a payment method).',
            ];
        case 'account_disabled':
            return [
                ar ? `حالة الحساب عند ميتا: ${a.label}${a.status !== null ? ` (${a.status})` : ''}.` : `Meta's account status: ${a.label}${a.status !== null ? ` (${a.status})` : ''}.`,
                ...(a.disableReason ? [ar ? `السبب: ${excerpt(a.disableReason, 120)}` : `Reason: ${excerpt(a.disableReason, 120)}`] : []),
                ar ? 'المطلوب: راجع «جودة الحساب» في ميتا.' : 'What to do: check Account Quality in Meta.',
            ];
        case 'token_dead':
            return [
                ar ? `رفضت ميتا الرمز${a.code !== null ? ` (الرمز ${a.code})` : ''}. لا يستطيع التطبيق فحص الإنفاق ولا إيقافه.` : `Meta refused the token${a.code !== null ? ` (code ${a.code})` : ''}. The app can neither check nor pause spending.`,
                ar ? 'المطلوب: أنشئ رمز مستخدم نظام جديدًا والصقه في الإعدادات ← الاتصالات ← إعلانات ميتا.' : 'What to do: generate a new system-user token and paste it in Settings → Connections → Meta ads.',
            ];
        case 'token_expiring':
            return [
                ar ? `ينتهي في ${a.expiresAt.slice(0, 10)} (بعد ${a.daysLeft} يومًا).` : `It expires on ${a.expiresAt.slice(0, 10)} (in ${a.daysLeft} days).`,
                ar ? 'المطلوب: أعد الاتصال بفيسبوك، أو الصق رمز مستخدم نظام لا ينتهي.' : 'What to do: reconnect Facebook, or paste a system-user token that never expires.',
            ];
        case 'guard_blind':
            return [
                ar ? `آخر فحص ناجح: ${a.since ? a.since.slice(0, 16).replace('T', ' ') : 'لم يحدث بعد'}. السبب: ${excerpt(a.reason, 120)}.` : `Last successful check: ${a.since ? a.since.slice(0, 16).replace('T', ' ') : 'never'}. Why: ${excerpt(a.reason, 120)}.`,
                ar ? 'الحملات النشطة تستمر في الإنفاق دون أن يوقفها حدّك. المطلوب: افتح شاشة الإعلانات.' : 'Active campaigns keep spending without your cap stopping them. What to do: open the Ads screen.',
            ];
        case 'version_mismatch':
            return [
                ar ? `الإصدار المثبَّت ${a.pinned}، وأجابت ميتا بـ ${a.served}.` : `Pinned ${a.pinned}; Meta answered on ${a.served}.`,
                ar ? 'المطلوب: يراجع مشرف المنصة إعداد إصدار واجهة الإعلانات.' : 'What to do: the platform admin checks the ads API version setting.',
            ];
        case 'ad_rejected':
        case 'ad_issues':
            return [
                ar ? `الإعلان: ${excerpt(a.adName ?? a.adId, 80)}` : `Ad: ${excerpt(a.adName ?? a.adId, 80)}`,
                ...(a.reason ? [ar ? `السبب: ${excerpt(a.reason, 200)}` : `Reason: ${excerpt(a.reason, 200)}`] : []),
            ];
        case 'business_ai':
            return [
                ar ? 'رفضت ميتا رسائل المساعد في محادثة على إنستغرام (الخطأ 100 / 2534037): ذكاء ميتا للأعمال يتولاها.' : 'Meta refused the assistant\'s messages in an Instagram conversation (error 100 / 2534037): Meta Business AI holds it.',
                ar ? 'المطلوب: في Meta Business Suite ← ذكاء الأعمال، فعّل «تولَّ المحادثات من ذكاء الأعمال» أو أطفئ ذكاء الأعمال. المحادثة معلَّمة في صندوق الوارد.' : 'What to do: in Meta Business Suite → Business AI, turn on "Take control of conversations with your Business AI", or turn Business AI off. The conversation is marked in the Inbox.',
            ];
        case 'window_error':
            return [
                ar ? `رفضت ميتا ردًّا في محادثة بدأت من إعلان على ${a.platform === 'instagram' ? 'إنستغرام' : 'ماسنجر'} لأنه خارج نافذة المراسلة.` : `Meta refused a reply in an ad-started ${a.platform === 'instagram' ? 'Instagram' : 'Messenger'} conversation for being outside the messaging window.`,
                ar ? 'أُطفئ مفتاح «نافذة الرد الأطول» لهذه المنصة تلقائيًا، فعاد المساعد إلى نافذة الأربع والعشرين ساعة. لا تُعِد تشغيله قبل اختبار اليوم الثاني.' : 'The "longer reply window" switch for this platform was turned off by itself; the assistant is back on the 24-hour window. Do not turn it on again before the day-2 test passes.',
            ];
        case 'proposal_ready':
            return [
                ...a.titles.slice(0, 3).map((t) => `• ${excerpt(t, 120)}`),
                ar ? `${a.count} مقترح بانتظار موافقتك. لا يتغيّر شيء ولا يُنفَق شيء قبل أن توافق، وتنتهي صلاحيتها بعد 7 أيام.` : `${a.count} proposal(s) wait for your approval. Nothing changes or spends until you approve; they expire after 7 days.`,
                ar ? 'المطلوب: افتح الإعلانات ← المقترحات.' : 'What to do: open Ads → Proposals.',
            ];
    }
}

/** One language's message. */
export function buildAdsAlertText(a: AdsAlert, target: AdsAlertTarget, lang: Lang): string {
    const account = target.accountName ? `${excerpt(target.accountName, 60)} (${target.adAccountId ?? '?'})` : (target.adAccountId ?? '?');
    return [
        `AutoReply · ${headline(a, lang)}`,
        lang === 'ar' ? `حساب الإعلانات: ${account}` : `Ad account: ${account}`,
        ...detail(a, lang),
    ].join('\n');
}

function bothLanguages(a: AdsAlert, target: AdsAlertTarget): string {
    return `${buildAdsAlertText(a, target, 'ar')}\n\n${buildAdsAlertText(a, target, 'en')}`;
}

/** The ad account's calendar day for `now`, as YYYY-MM-DD. */
export function localDay(now: Date, offsetHours: number): string {
    return new Date(now.getTime() + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

// ─── Sending ────────────────────────────────────────────────────────────────────────────────

async function copyAdmin(): Promise<boolean> {
    return (await getSetting(APP_SETTING_KEYS.adsCopyAdmin)) !== 'false';
}

const OFF: AdsAlertChannels = { telegram: 'off', email: 'off', admin_copy: 'off' };

/**
 * Tell the tenant (and the admin). NEVER throws. `objectKey` names what the alert is about (the ad account by default; an ad's id for
 * `ad_rejected`), which is what makes a second alert about another object the same day an alert of its own.
 */
export async function notifyAds(alert: AdsAlert, target: AdsAlertTarget, opts: { now?: Date; objectKey?: string } = {}): Promise<AdsAlertResult> {
    const now = opts.now ?? new Date();
    const objectKey = opts.objectKey ?? target.adAccountId ?? 'account';
    const logBase = { creator_id: target.creatorId, kind: alert.kind, object_key: objectKey };
    try {
        const row = await queryOne<{ id: string }>(
            `INSERT INTO ads_alerts (creator_id, kind, object_key, day, detail) VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (creator_id, kind, object_key, day) DO NOTHING RETURNING id`,
            [target.creatorId, alert.kind, objectKey, localDay(now, target.offsetHours), JSON.stringify(alert)]
        );
        if (!row) {
            log('info', 'ads.alert_duplicate', logBase);
            return { outcome: 'duplicate', channels: { ...OFF } };
        }

        const [recipients, channels, adminCopy] = await Promise.all([readAlerts(target.creatorId), readNotifyChannels(), copyAdmin()]);
        const out: AdsAlertChannels = { ...OFF };
        const wanted = recipients.kinds[alert.kind as AdsAlertKind] !== false;
        const text = buildAdsAlertText(alert, target, recipients.lang);
        const subject = `AutoReply · ${headline(alert, recipients.lang)}`;

        if (wanted && recipients.telegramChatId && channels.telegram.token) {
            const r = await sendTelegramMessage({ token: channels.telegram.token, chatId: recipients.telegramChatId }, text);
            out.telegram = r.ok ? 'sent' : 'failed';
            if (!r.ok) log('warn', 'ads.alert_telegram_failed', { ...logBase, reason: r.reason, status: r.status, description: r.description });
        }
        if (wanted && recipients.email && channels.email.apiKey) {
            const r = await sendEmail({ apiKey: channels.email.apiKey, to: recipients.email, from: channels.email.from }, { subject, text });
            out.email = r.ok ? 'sent' : 'failed';
            if (!r.ok) log('warn', 'ads.alert_email_failed', { ...logBase, reason: r.reason, status: r.status });
        }

        if (adminCopy) {
            const results: ChannelOutcome[] = [];
            const both = bothLanguages(alert, target);
            const tg = channels.telegram;
            if (telegramReady(tg) && !(out.telegram !== 'off' && tg.chatId === recipients.telegramChatId)) {
                const r = await sendTelegramMessage({ token: tg.token, chatId: tg.chatId }, both);
                results.push(r.ok ? 'sent' : 'failed');
            }
            const adminTo = effectiveTo(channels.email);
            if (emailReady(channels.email) && adminTo && !(out.email !== 'off' && adminTo === recipients.email)) {
                const r = await sendEmail({ apiKey: channels.email.apiKey, to: adminTo, from: channels.email.from }, { subject: `AutoReply · ${headline(alert, 'en')}`, text: both });
                results.push(r.ok ? 'sent' : 'failed');
            }
            out.admin_copy = results.includes('sent') ? 'sent' : results.includes('failed') ? 'failed' : 'off';
        }

        await queryOne('UPDATE ads_alerts SET channels = $2::jsonb WHERE id = $1 AND creator_id = $3', [row.id, JSON.stringify(out), target.creatorId]);
        log(Object.values(out).includes('sent') ? 'info' : 'warn', 'ads.alert_sent', { ...logBase, ...out });
        return { outcome: 'sent', channels: out };
    } catch (err) {
        log('warn', 'ads.alert_error', { ...logBase, ...describeError(err) });
        return { outcome: 'error', channels: { ...OFF } };
    }
}

/** The card's "Send test": one message to the tenant's saved recipients, in its language. No dedupe row. NEVER throws. */
export async function sendAdsTest(creatorId: string): Promise<{ telegram: ChannelOutcome; email: ChannelOutcome }> {
    const out: { telegram: ChannelOutcome; email: ChannelOutcome } = { telegram: 'off', email: 'off' };
    try {
        const [recipients, channels] = await Promise.all([readAlerts(creatorId), readNotifyChannels()]);
        const text = recipients.lang === 'ar'
            ? 'AutoReply · رسالة تجريبية: هنا تصلك تنبيهات الإعلانات (إيقاف عند الحد، الدفع، الرمز).'
            : 'AutoReply · Test message: this is where your ads alerts arrive (cap pauses, payment, token).';
        if (recipients.telegramChatId && channels.telegram.token) {
            out.telegram = (await sendTelegramMessage({ token: channels.telegram.token, chatId: recipients.telegramChatId }, text)).ok ? 'sent' : 'failed';
        }
        if (recipients.email && channels.email.apiKey) {
            out.email = (await sendEmail({ apiKey: channels.email.apiKey, to: recipients.email, from: channels.email.from }, { subject: 'AutoReply · ads alerts test', text })).ok ? 'sent' : 'failed';
        }
    } catch (err) {
        log('warn', 'ads.alert_test_error', { creator_id: creatorId, ...describeError(err) });
    }
    return out;
}
