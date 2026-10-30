/**
 * Where Meta sends each kind of event, and sending it back (the 2026-10-30 incident).
 *
 * A Meta app delivers each webhook object type (`instagram`, `page`, `whatsapp_business_account`, …) to ONE callback URL, for the whole app. On 2026-10-30 another
 * project that uses this same Meta app pointed `instagram` (and a field-less `user`) at its own site. For 45 hours no Instagram DM or comment reached AutoReply while the
 * dashboard said "Connected": the Page token was valid, `health.ts` deliberately never reads callback URLs, `lastWebhookAt` mixes platforms (Facebook events kept it
 * fresh), and Settings → "Test webhook" only asks this deployment whether it would answer Meta's handshake. Nothing here could see it. This module can:
 *
 *   read      `GET /{app}/subscriptions` with the app token (`readAppSubscriptions`), described against the address this deployment gives Meta
 *             (`describeSubscriptions`): per object, whose address, active or not, which fields, and which required fields are missing.
 *   judge     `findProblems` / `isBroken` (pure). Broken is what stops the product: an object that carries events goes elsewhere or is switched off, `instagram` or
 *             `page` has no subscription at all, or lacks `comments`/`messages` (`feed`/`messages`). A field-less object pointing elsewhere (`user`), and a Page missing
 *             `messaging_referrals`, are warnings: shown, never alarming.
 *   remember  the last answer is an app setting (`meta.webhooks.status`): `GET /api/health/tenant` serves a summary of it, so no page load asks Meta.
 *             `checkMetaWebhooks` reads at most once an hour (the drain and the daily cron call it) and tells the owner, once a day per problem, when it is broken.
 *   repair    `planRepair` (pure) and `repairSubscriptions`: one `POST /{app}/subscriptions` per object that is elsewhere, off or short of a required field, which
 *             sets it back to this deployment with the union of its current and its required fields at the version it already had; then the Pages.
 *
 * ─── What the repair promises ────────────────────────────────────────────────
 *   - **It changes only what is wrong.** An object that is ours, active and complete is never sent. A subscription's fields are replaced by a POST, so the list sent is the
 *     union of the current ones and the required ones: nothing the Meta app subscribed to (`mentions`, `story_insights`, `leadgen`) is dropped.
 *   - **Meta calls us during the POST** (`GET /webhook` with the verify token), so the token sent is the first candidate `GET /webhook` accepts
 *     (`webhookVerifyToken.ts`), the call may take a while (30 s), and it is never retried: re-pointing is idempotent, and a timeout is answered by reading it back.
 *   - **Secrets stay out.** The app token travels as a Bearer header on the read and in the POST's BODY, never in a URL; every error that leaves is scrubbed; the audit row
 *     (`meta.webhooks_repair`) holds hosts, fields and outcomes only.
 *   - **A Page is left alone unless it needs it.** After the app-level steps each active connected tenant's Page is read (`GET /{page}/subscribed_apps`); only a Page that
 *     does not list this app, or lacks a field it needs (`WEBHOOK_FIELDS`, plus `leadgen` while the tenant's lead-ads sign-off stands), is subscribed again through
 *     `subscribePage`, the path a connection uses. A field Meta added to a Page that is complete (`mention`) is not touched.
 */
import { queryOne, queryRows } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { APP_SETTING_KEYS, getPublicBaseUrl, getSetting, setSetting } from './appSettings.js';
import { AUDIT_ACTIONS, writeAudit, type AuditActor } from './audit.js';
import { metaHttp } from './http.js';
import { API_VERSION, GRAPH_BASE } from './instagram.js';
import { graphError, leadgenFieldsFor, MetaLoginError, readMetaApp, scrubSecrets, subscribePage, WEBHOOK_FIELDS, type MetaApp } from './metaLogin.js';
import { sendTelegramMessage, telegramReady } from './notify.js';
import { effectiveTo, emailReady, readNotifyChannels, sendEmail } from './notifyEmail.js';
import { getTenant } from './tenant.js';
import { verifyTokenCandidates } from './webhookVerifyToken.js';

// ─── What Meta is read for ──────────────────────────────────────────────────────────────

/** The path this deployment serves Meta's deliveries on (`app.post('/webhook')`, `src/index.ts`). */
export const WEBHOOK_PATH = '/webhook';

const GRAPH_ROOT = 'https://graph.facebook.com';
const VERSION_PATTERN = /^v\d+\.\d+$/;

/** At most one read of Meta an hour, from the drain and the daily cron: a Meta app's subscriptions change when a person edits them, not by the minute. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Meta calls this deployment while it applies a subscription, so the write is given longer than a read (`metaHttp`'s default is 10 s). */
export const REPAIR_TIMEOUT_MS = 30_000;

/**
 * The fields each object needs. A `POST /{app}/subscriptions` is made for an object that lacks any of them, and the union with what it has is what is sent. `page` is the
 * list a connected Page is subscribed with as well (`WEBHOOK_FIELDS`, which `messaging_referrals` is part of: a person with a Messenger thread who taps a click-to-message
 * ad is announced only by it).
 */
export const REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    instagram: ['comments', 'messages'],
    page: [...WEBHOOK_FIELDS],
});

/** Of those, the fields whose absence stops the product (no comments or DMs reach it); the rest only warn. */
export const CRITICAL_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    instagram: ['comments', 'messages'],
    page: ['feed', 'messages'],
});

/** The objects AutoReply cannot work without a subscription for: Instagram comments and DMs, and a Facebook Page's. WhatsApp is checked when it is there. */
export const REQUIRED_OBJECTS: readonly string[] = ['instagram', 'page'];

const requiredFieldsOf = (object: string): readonly string[] => (Object.hasOwn(REQUIRED_FIELDS, object) ? REQUIRED_FIELDS[object] ?? [] : []);
const criticalFieldsOf = (object: string): readonly string[] => (Object.hasOwn(CRITICAL_FIELDS, object) ? CRITICAL_FIELDS[object] ?? [] : []);
const isRequiredObject = (object: string): boolean => REQUIRED_OBJECTS.includes(object);

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';

// ─── Reading ────────────────────────────────────────────────────────────────────────────

export interface AppSubscriptionField { name: string; version: string | null }

/** One entry of `GET /{app}/subscriptions`, as Meta lists it. */
export interface AppSubscription {
    object: string;
    callbackUrl: string | null;
    /** Only an explicit `active: false` is off: an answer that says nothing about it is not read as a switched-off subscription. */
    active: boolean;
    fields: AppSubscriptionField[];
}

/** Meta's answer as a list. Anything that is not `{ data: [...] }` is not an answer: it must not be read as "no subscriptions". */
export function parseSubscriptions(body: unknown): AppSubscription[] {
    const list = isObj(body) && Array.isArray(body['data']) ? (body['data'] as unknown[]) : null;
    if (!list) throw new MetaLoginError('graph_failed', 'meta.read_app_subscriptions: Meta answered with something that is not a list of subscriptions.');
    const out: AppSubscription[] = [];
    for (const item of list) {
        if (!isObj(item) || !isText(item['object']) || !item['object']) continue;
        const fields: AppSubscriptionField[] = [];
        for (const f of Array.isArray(item['fields']) ? (item['fields'] as unknown[]) : []) {
            if (!isObj(f) || !isText(f['name']) || !f['name']) continue;
            fields.push({ name: f['name'], version: isText(f['version']) && VERSION_PATTERN.test(f['version']) ? f['version'] : null });
        }
        out.push({
            object: item['object'],
            callbackUrl: isText(item['callback_url']) && item['callback_url'] ? item['callback_url'] : null,
            active: item['active'] !== false,
            fields,
        });
    }
    return out;
}

const appTokenOf = (app: MetaApp): string => `${app.appId}|${app.appSecret}`;

function requireApp(): MetaApp {
    const app = readMetaApp();
    if (!app) throw new MetaLoginError('not_configured', 'META_APP_ID and META_APP_SECRET must both be set.');
    return app;
}

/**
 * The address this deployment gives Meta: the public base URL (a Settings value, or `PUBLIC_BASE_URL`) and `/webhook`. Not the Host header of whoever is asking: the
 * address Meta must call is a fact about the deployment, and a preview deployment answering a Settings page must not call itself the right one.
 */
export async function expectedCallback(): Promise<{ url: string; host: string }> {
    const base = await getPublicBaseUrl(null);
    if (!base) throw new MetaLoginError('no_base_url', 'The public site address (app.public_base_url) is not set, so the address Meta should send events to is not known.');
    const url = `${base}${WEBHOOK_PATH}`;
    return { url, host: new URL(url).host.toLowerCase() };
}

/**
 * `GET /{app-id}/subscriptions` with the app access token (`{app-id}|{app-secret}`) in an `Authorization: Bearer` header, never in the URL. Throws `MetaLoginError`:
 * `not_configured` without the app's id and secret, `graph_failed` for anything Meta did not answer (the message is scrubbed of the token and the secret).
 */
export async function readAppSubscriptions(app: MetaApp | null = readMetaApp()): Promise<AppSubscription[]> {
    if (!app) throw new MetaLoginError('not_configured', 'META_APP_ID and META_APP_SECRET must both be set.');
    const token = appTokenOf(app);
    try {
        const response = await metaHttp.get(`${GRAPH_BASE}/${app.appId}/subscriptions`, { headers: { Authorization: `Bearer ${token}` } });
        return parseSubscriptions(response.data);
    } catch (err) {
        if (err instanceof MetaLoginError) throw err;
        throw graphError('graph_failed', 'meta.read_app_subscriptions', err, [app.appSecret, token]);
    }
}

// ─── Judging (pure) ─────────────────────────────────────────────────────────────────────

export interface DescribedObject {
    object: string;
    /** The host the callback URL names, or null when there is none or it is not a URL. */
    host: string | null;
    /** The callback is this deployment's host. */
    ours: boolean;
    active: boolean;
    fields: string[];
    /** The one version every field is subscribed at, or null when they differ or there are none. */
    version: string | null;
    carriesEvents: boolean;
    /** Required fields (`REQUIRED_FIELDS`) the object is not subscribed to. */
    missingRequired: string[];
}

export function hostOf(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).host.toLowerCase() || null;
    } catch {
        return null;
    }
}

/** Each object against the host this deployment gives Meta. The host, not the whole URL: it is what `diagnose.mjs` has always compared, and what tells "another site" from "us". */
export function describeSubscriptions(subs: readonly AppSubscription[], expectedHost: string): DescribedObject[] {
    const want = expectedHost.toLowerCase();
    return subs.map((sub) => {
        const host = hostOf(sub.callbackUrl);
        const fields = [...new Set(sub.fields.map((f) => f.name))];
        const versions = new Set(sub.fields.map((f) => f.version));
        return {
            object: sub.object,
            host,
            ours: host !== null && host === want,
            active: sub.active,
            fields,
            version: versions.size === 1 ? ([...versions][0] ?? null) : null,
            carriesEvents: fields.length > 0,
            missingRequired: requiredFieldsOf(sub.object).filter((f) => !fields.includes(f)),
        };
    });
}

export type ProblemKind = 'elsewhere' | 'inactive' | 'missing_object' | 'missing_field';

/**
 * One thing that stops events reaching AutoReply. `fields` is what is affected: the events an object carries (`elsewhere`, `inactive`), or what it lacks
 * (`missing_field`, `missing_object`). An object has one problem at a time, the worst: elsewhere, then switched off, then short of a field.
 */
export interface WebhookProblem {
    object: string;
    host: string | null;
    kind: ProblemKind;
    fields: string[];
}

export function findProblems(described: readonly DescribedObject[]): WebhookProblem[] {
    const problems: WebhookProblem[] = [];
    for (const d of described) {
        // An object that carries nothing and is not one of ours to need (`user`) is a warning on the card, not a problem. A required one is a problem either way.
        const matters = d.carriesEvents || isRequiredObject(d.object);
        if (!d.ours && matters) {
            problems.push({ object: d.object, host: d.host, kind: 'elsewhere', fields: d.fields });
        } else if (!d.active && matters) {
            problems.push({ object: d.object, host: d.host, kind: 'inactive', fields: d.fields });
        } else {
            const lacking = criticalFieldsOf(d.object).filter((f) => !d.fields.includes(f));
            if (lacking.length > 0) problems.push({ object: d.object, host: d.host, kind: 'missing_field', fields: lacking });
        }
    }
    for (const object of REQUIRED_OBJECTS) {
        if (!described.some((d) => d.object === object)) problems.push({ object, host: null, kind: 'missing_object', fields: [...requiredFieldsOf(object)] });
    }
    return problems;
}

/** Events that matter are not reaching AutoReply. */
export function isBroken(described: readonly DescribedObject[]): boolean {
    return findProblems(described).length > 0;
}

/** One `POST /{app}/subscriptions`. `fields` is the whole list to send (empty: a field-less object, and the `fields` parameter is left out). */
export interface RepairStep {
    object: string;
    kind: ProblemKind;
    /** Where the object points now: shown, so the person sees what is being taken back. */
    fromHost: string | null;
    callbackUrl: string;
    fields: string[];
    /** The required fields the object lacked, which the step adds. */
    addedFields: string[];
    /** The Graph version the POST is made at, which is the version the fields are subscribed at: the object's own, so a payload format never changes under it. */
    version: string;
}

/**
 * What the button would do. One step per object that is elsewhere, off or short of a required field, in the order Meta listed them, then one for each required object
 * Meta has none for (made at the app's own version). An object that is ours, active and complete has no step, so an empty plan means there is nothing to send.
 */
export function planRepair(described: readonly DescribedObject[], expectedUrl: string, appVersion: string): RepairStep[] {
    const steps: RepairStep[] = [];
    for (const d of described) {
        if (d.ours && d.active && d.missingRequired.length === 0) continue;
        steps.push({
            object: d.object,
            kind: !d.ours ? 'elsewhere' : !d.active ? 'inactive' : 'missing_field',
            fromHost: d.host,
            callbackUrl: expectedUrl,
            fields: [...new Set([...d.fields, ...d.missingRequired])],
            addedFields: [...d.missingRequired],
            version: d.version ?? appVersion,
        });
    }
    for (const object of REQUIRED_OBJECTS) {
        if (described.some((d) => d.object === object)) continue;
        const fields = [...requiredFieldsOf(object)];
        steps.push({ object, kind: 'missing_object', fromHost: null, callbackUrl: expectedUrl, fields, addedFields: fields, version: appVersion });
    }
    return steps;
}

// ─── What is remembered ─────────────────────────────────────────────────────────────────

/**
 * The last answer, as stored (`meta.webhooks.status`). `checkedAt` is when Meta last ANSWERED (null: never), `attemptedAt` when a check last RAN: the hourly throttle counts
 * from the latter, so a Meta outage is not asked about every minute of it. A check that got no answer keeps the last answer's `ok` and `objects` and says why in `error`:
 * not knowing is not a reason to stop warning about what was last seen, and not a reason to start.
 */
export interface WebhookStatus {
    checkedAt: string | null;
    attemptedAt: string;
    /** `false`: something that matters is not reaching AutoReply. `true`: nothing is wrong. `null`: Meta has never been read. */
    ok: boolean | null;
    expectedUrl: string | null;
    expectedHost: string | null;
    objects: DescribedObject[];
    error: { code: string; message: string } | null;
}

function isDescribed(value: unknown): value is DescribedObject {
    return isObj(value)
        && isText(value['object']) && typeof value['ours'] === 'boolean' && typeof value['active'] === 'boolean' && typeof value['carriesEvents'] === 'boolean'
        && (value['host'] === null || isText(value['host'])) && (value['version'] === null || isText(value['version']))
        && Array.isArray(value['fields']) && value['fields'].every(isText) && Array.isArray(value['missingRequired']) && value['missingRequired'].every(isText);
}

const isoOrNull = (value: unknown): string | null => (isText(value) && !Number.isNaN(Date.parse(value)) ? value : null);

/** A stored status, read defensively: a value edited by hand, or written by another version, is not trusted to be this shape. */
export function parseStatus(raw: string | null): WebhookStatus | null {
    if (!raw) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isObj(value)) return null;
    const attemptedAt = isoOrNull(value['attemptedAt']);
    if (!attemptedAt) return null;
    const error = isObj(value['error']) && isText(value['error']['code'])
        ? { code: value['error']['code'], message: isText(value['error']['message']) ? value['error']['message'] : '' }
        : null;
    return {
        checkedAt: isoOrNull(value['checkedAt']),
        attemptedAt,
        ok: typeof value['ok'] === 'boolean' ? value['ok'] : null,
        expectedUrl: isText(value['expectedUrl']) ? value['expectedUrl'] : null,
        expectedHost: isText(value['expectedHost']) ? value['expectedHost'] : null,
        objects: Array.isArray(value['objects']) ? value['objects'].filter(isDescribed) : [],
        error,
    };
}

export async function readStatus(): Promise<WebhookStatus | null> {
    return parseStatus(await getSetting(APP_SETTING_KEYS.metaWebhooksStatus));
}

async function writeStatus(status: WebhookStatus): Promise<void> {
    await setSetting(APP_SETTING_KEYS.metaWebhooksStatus, JSON.stringify(status), null);
}

function answeredStatus(described: DescribedObject[], expected: { url: string; host: string }, now: number): WebhookStatus {
    const at = new Date(now).toISOString();
    return { checkedAt: at, attemptedAt: at, ok: !isBroken(described), expectedUrl: expected.url, expectedHost: expected.host, objects: described, error: null };
}

function unansweredStatus(previous: WebhookStatus | null, failure: MetaLoginError, now: number): WebhookStatus {
    return {
        checkedAt: previous?.checkedAt ?? null,
        attemptedAt: new Date(now).toISOString(),
        ok: previous?.ok ?? null,
        expectedUrl: previous?.expectedUrl ?? null,
        expectedHost: previous?.expectedHost ?? null,
        objects: previous?.objects ?? [],
        error: { code: failure.reason, message: failure.message.slice(0, 300) },
    };
}

/** What `GET /api/health/tenant` serves of it, the same for every tenant: whether anything is wrong, when Meta last said so, and what. */
export interface WebhookSummary {
    ok: boolean | null;
    checkedAt: string | null;
    problems: WebhookProblem[];
}

/** From the stored status. Null: nothing was ever stored. A status Meta never answered has no problems to list: there is nothing it said. */
export function summarizeStatus(status: WebhookStatus | null): WebhookSummary | null {
    if (!status) return null;
    if (status.checkedAt === null) return { ok: null, checkedAt: null, problems: [] };
    const problems = findProblems(status.objects);
    return { ok: problems.length === 0, checkedAt: status.checkedAt, problems };
}

export async function readWebhookSummary(): Promise<WebhookSummary | null> {
    return summarizeStatus(await readStatus());
}

// ─── The hourly check ───────────────────────────────────────────────────────────────────

export interface CheckResult {
    /** What is stored now: this check's answer, or the previous one when the check was held back or got none. Null when nothing is stored and the store could not be read. */
    status: WebhookStatus | null;
    /** The hourly throttle held the check back: nothing was asked of Meta. */
    skipped: boolean;
    /** This attempt could not read Meta, or had nothing to read it with (`not_configured`, `no_base_url`). */
    failure: MetaLoginError | null;
    /** The owner was told about a problem on this run. */
    alerted: boolean;
}

/**
 * Read where Meta sends each event, judge it, store it, and tell the owner when it is broken. Held back to one read an hour by the stored time unless `force` (the Settings
 * card, which is a person asking now). NEVER throws: it runs inside the drain and the daily cron, whose queue and publishes must not depend on it, and a failed read, an
 * unconfigured deployment or a database that cannot be written is a result, not an exception. No database transaction is open while Meta is asked.
 */
export async function checkMetaWebhooks(options: { force?: boolean } = {}): Promise<CheckResult> {
    let previous: WebhookStatus | null = null;
    try {
        previous = await readStatus();
        const now = Date.now();
        if (!options.force && previous && now - Date.parse(previous.attemptedAt) < CHECK_INTERVAL_MS) {
            return { status: previous, skipped: true, failure: null, alerted: false };
        }

        let described: DescribedObject[];
        let expected: { url: string; host: string };
        try {
            requireApp();
            expected = await expectedCallback();
            described = describeSubscriptions(await readAppSubscriptions(), expected.host);
        } catch (err) {
            const failure = err instanceof MetaLoginError ? err : new MetaLoginError('graph_failed', 'meta.read_app_subscriptions: the check could not run.');
            const status = unansweredStatus(previous, failure, now);
            await writeStatus(status);
            // A deployment with nothing to check yet is quiet; a Meta that did not answer is worth a warning.
            log(failure.reason === 'graph_failed' ? 'warn' : 'info', 'meta.webhooks_unanswered', { reason: failure.reason, ...(failure.reason === 'graph_failed' ? describeError(failure) : {}) });
            return { status, skipped: false, failure, alerted: false };
        }

        const status = answeredStatus(described, expected, now);
        await writeStatus(status);
        const problems = findProblems(described);
        log(problems.length > 0 ? 'warn' : 'info', 'meta.webhooks_checked', { ok: problems.length === 0, objects: described.length, problems: problems.length });

        let alerted = false;
        if (problems.length > 0) {
            try {
                alerted = await alertIfNew(problems, expected.url, now);
            } catch (err) {
                log('warn', 'meta.webhooks_alert_failed', describeError(err));
            }
        }
        return { status, skipped: false, failure: null, alerted };
    } catch (err) {
        log('error', 'meta.webhooks_check_error', describeError(err));
        return { status: previous, skipped: false, failure: null, alerted: false };
    }
}

// ─── Telling the owner ──────────────────────────────────────────────────────────────────

type Lang = 'ar' | 'en';

const PLATFORM_NAMES: Readonly<Record<string, Readonly<Record<Lang, string>>>> = Object.freeze({
    instagram: { ar: 'إنستجرام', en: 'Instagram' },
    page: { ar: 'فيسبوك', en: 'Facebook' },
    whatsapp_business_account: { ar: 'واتساب', en: 'WhatsApp' },
});

/** What Meta wrote, cut down to what a name or a field is, so it cannot carry a link, a line break or a reordering control into an alert. */
const plain = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 60);

function platformName(object: string, lang: Lang): string {
    return Object.hasOwn(PLATFORM_NAMES, object) ? (PLATFORM_NAMES[object]?.[lang] ?? plain(object)) : plain(object);
}

function problemLine(problem: WebhookProblem, lang: Lang): string {
    const name = platformName(problem.object, lang);
    const host = plain(problem.host ?? '?');
    const fields = problem.fields.map(plain).join(', ');
    const ar = lang === 'ar';
    switch (problem.kind) {
        case 'elsewhere': return ar ? `• ${name}: تذهب الأحداث إلى ${host} لا إلى AutoReply.` : `• ${name}: events go to ${host}, not to AutoReply.`;
        case 'inactive': return ar ? `• ${name}: الاشتراك متوقف في ميتا.` : `• ${name}: the subscription is switched off in Meta.`;
        case 'missing_object': return ar ? `• ${name}: لا اشتراك لـ AutoReply عند ميتا.` : `• ${name}: Meta has no subscription for AutoReply.`;
        case 'missing_field': return ar ? `• ${name}: لا ترسل ميتا ${fields}.` : `• ${name}: Meta is not sending ${fields}.`;
    }
}

/** The dashboard's card, as a link the alert can carry: the Platform tab, the card that sends everything back. */
export function settingsLinkFor(expectedUrl: string): string {
    return `${new URL(expectedUrl).origin}/dashboard#/settings?s=platform&card=meta-events`;
}

/**
 * The alert in both languages, Arabic first (the ads alerts' admin copy): which event type goes where, and where to fix it with one click. No secret is ever in it: hosts
 * and field names, cut to the characters those can hold.
 */
export function buildWebhookAlert(problems: readonly WebhookProblem[], settingsUrl: string): { subject: string; text: string } {
    const headline = { ar: 'ميتا لا ترسل أحداثك إلى AutoReply', en: 'Meta is not sending your events to AutoReply' };
    const todo = {
        ar: `المطلوب: افتح الإعدادات ← المنصة ← «إلى أين ترسل ميتا أحداثك» واضغط «أرسل كل شيء إلى AutoReply»: ${settingsUrl}`,
        en: `What to do: open Settings → Platform → "Where Meta sends your events" and press "Send everything to AutoReply": ${settingsUrl}`,
    };
    const one = (lang: Lang): string => [`AutoReply · ${headline[lang]}`, ...problems.map((p) => problemLine(p, lang)), todo[lang]].join('\n');
    return { subject: `AutoReply · ${headline.en}`, text: `${one('ar')}\n\n${one('en')}` };
}

/** One problem is one alert a day: object, kind and where it points. A different problem, or the same one tomorrow, is another. */
export function alertKey(problem: WebhookProblem): string {
    return `${problem.object}:${problem.kind}:${problem.host ?? ''}`;
}

interface AlertRecord { day: string; keys: string[] }

function parseAlerted(raw: string | null): AlertRecord | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (isObj(value) && isText(value['day']) && Array.isArray(value['keys'])) return { day: value['day'], keys: value['keys'].filter(isText) };
    } catch {
        // an unreadable record is no record: the owner is told again rather than never
    }
    return null;
}

type ChannelOutcome = 'sent' | 'failed' | 'off';

/** The owner's own channels (`notify.*`: the deployment's Telegram bot and Resend key). Each one's outcome; never throws a send's error. */
async function tellOwner(problems: readonly WebhookProblem[], settingsUrl: string): Promise<{ telegram: ChannelOutcome; email: ChannelOutcome }> {
    const out: { telegram: ChannelOutcome; email: ChannelOutcome } = { telegram: 'off', email: 'off' };
    const channels = await readNotifyChannels();
    const { subject, text } = buildWebhookAlert(problems, settingsUrl);

    const tg = channels.telegram;
    if (telegramReady(tg)) {
        const r = await sendTelegramMessage({ token: tg.token, chatId: tg.chatId }, text);
        out.telegram = r.ok ? 'sent' : 'failed';
        if (!r.ok) log('warn', 'meta.webhooks_alert_telegram_failed', { reason: r.reason, status: r.status });
    }
    const to = effectiveTo(channels.email);
    if (emailReady(channels.email) && to) {
        const r = await sendEmail({ apiKey: channels.email.apiKey, to, from: channels.email.from }, { subject, text });
        out.email = r.ok ? 'sent' : 'failed';
        if (!r.ok) log('warn', 'meta.webhooks_alert_email_failed', { reason: r.reason, status: r.status });
    }
    return out;
}

/**
 * Tell the owner about the problems that are new today. A problem already told about today is not told again, so a screen of problems left alone is one message a day, not
 * one an hour; a day is the UTC day. A day on which nothing could be sent (no channel on, or every send refused) is not marked told: the next hourly check tries again.
 * Read-then-write, not a claim: two checks in the same instant can both send, which costs the owner one extra message and nothing else.
 */
async function alertIfNew(problems: readonly WebhookProblem[], expectedUrl: string, now: number): Promise<boolean> {
    const day = new Date(now).toISOString().slice(0, 10);
    const stored = parseAlerted(await getSetting(APP_SETTING_KEYS.metaWebhooksAlerted));
    const known = stored && stored.day === day ? stored.keys : [];
    if (problems.every((p) => known.includes(alertKey(p)))) return false;

    const sent = await tellOwner(problems, settingsLinkFor(expectedUrl));
    log('warn', 'meta.webhooks_alert', { problems: problems.length, telegram: sent.telegram, email: sent.email });
    if (sent.telegram !== 'sent' && sent.email !== 'sent') return false;

    const record: AlertRecord = { day, keys: [...new Set([...known, ...problems.map(alertKey)])] };
    await setSetting(APP_SETTING_KEYS.metaWebhooksAlerted, JSON.stringify(record), null);
    return true;
}

// ─── The repair ─────────────────────────────────────────────────────────────────────────

export interface RepairStepResult { object: string; ok: boolean; error?: string }

export interface PageRepairSummary {
    /** Active tenants with a Page and a token, whose subscription was read. */
    checked: number;
    /** Subscribed again because this app was not on the Page, or a field was missing. */
    resubscribed: number;
    /** A Page that could not be read or subscribed (a dead token, Meta refusing). */
    failed: number;
}

export interface RepairOutcome {
    /** The subscriptions as Meta listed them before anything was sent. */
    before: DescribedObject[];
    /** As Meta lists them after: null when they could not be read back. */
    after: DescribedObject[] | null;
    /** The steps that were sent, in order. Empty when nothing at app level was wrong. */
    plan: RepairStep[];
    steps: RepairStepResult[];
    pages: PageRepairSummary;
    status: WebhookStatus;
}

/** Meta's reason, from the error of a refused or lost call: its own message (scrubbed of every secret this call knew), or what a connection that gave no answer says. */
function stepFailure(err: unknown, secrets: readonly string[]): string {
    const e = err as { code?: unknown; response?: unknown; message?: unknown } | null;
    if (!e?.response && (e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT')) {
        return 'Meta did not answer in time. The change may still have gone through: check again.';
    }
    const metaMessage = (err as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message;
    const detail = isText(metaMessage) ? metaMessage : String(e?.message ?? 'no answer');
    return scrubSecrets(detail, secrets).replace(/\s+/g, ' ').trim().slice(0, 300) || 'Meta refused the change.';
}

/**
 * One step: `POST https://graph.facebook.com/{version}/{app-id}/subscriptions`, form-encoded, the access token and the verify token in the BODY (never the URL). The version
 * is the step's, because it sets the version the fields are subscribed at. Not retried, not wrapped in `withRetry`. A refusal or a lost call is that step's result, not a throw.
 */
async function applyStep(app: MetaApp, step: RepairStep, verifyToken: string, secrets: readonly string[]): Promise<RepairStepResult> {
    const body = new URLSearchParams({ object: step.object, callback_url: step.callbackUrl });
    if (step.fields.length > 0) body.set('fields', step.fields.join(','));
    body.set('verify_token', verifyToken);
    body.set('include_values', 'true');
    body.set('access_token', appTokenOf(app));
    try {
        const response = await metaHttp.post(`${GRAPH_ROOT}/${step.version}/${app.appId}/subscriptions`, body, { timeout: REPAIR_TIMEOUT_MS });
        if ((response?.data as { success?: unknown } | undefined)?.success === true) return { object: step.object, ok: true };
        return { object: step.object, ok: false, error: 'Meta did not confirm the change.' };
    } catch (err) {
        return { object: step.object, ok: false, error: stepFailure(err, secrets) };
    }
}

/** The fields this app is subscribed to on the Page, or null when the Page does not list this app at all. */
async function readPageFields(pageId: string, pageToken: string, appId: string): Promise<string[] | null> {
    try {
        const response = await metaHttp.get(`${GRAPH_BASE}/${pageId}/subscribed_apps`, { headers: { Authorization: `Bearer ${pageToken}` } });
        const apps: unknown[] = Array.isArray(response.data?.data) ? response.data.data : [];
        const ours = apps.find((a) => isObj(a) && String(a['id']) === appId);
        if (!isObj(ours)) return null;
        return Array.isArray(ours['subscribed_fields']) ? ours['subscribed_fields'].filter(isText) : [];
    } catch (err) {
        throw graphError('graph_failed', 'meta.read_page_subscription', err, [pageToken]);
    }
}

/**
 * Each active connected tenant's Page, read and, only when it needs it, subscribed again with the existing path (`subscribePage`, the one a connection and the lead-ads
 * sync use). A Page that already lists this app with every field it needs is not touched: a subscription is replaced by a POST, so touching a complete one could only lose
 * a field. One tenant's failure is counted and never stops the others.
 */
async function repairPages(appId: string): Promise<PageRepairSummary> {
    const summary: PageRepairSummary = { checked: 0, resubscribed: 0, failed: 0 };
    let ids: string[];
    try {
        ids = (await queryRows<{ id: string }>(
            `SELECT id FROM creators WHERE is_active = true AND page_access_token IS NOT NULL AND facebook_page_id IS NOT NULL ORDER BY created_at, id`
        )).map((r) => r.id);
    } catch (err) {
        log('warn', 'meta.webhooks_pages_unlisted', describeError(err));
        return summary;
    }
    for (const id of ids) {
        try {
            const tenant = await getTenant(id, ['id', 'facebook_page_id', 'page_access_token']);
            if (!tenant?.facebook_page_id || !tenant.page_access_token) continue;
            summary.checked++;
            const extra = await leadgenFieldsFor(id);
            const wanted = [...new Set([...WEBHOOK_FIELDS, ...extra])];
            const have = await readPageFields(tenant.facebook_page_id, tenant.page_access_token, appId);
            if (have && wanted.every((f) => have.includes(f))) continue;
            const result = await subscribePage(tenant.facebook_page_id, tenant.page_access_token, appId, extra);
            if (result.confirmed) summary.resubscribed++;
            else summary.failed++;
        } catch (err) {
            summary.failed++;
            log('warn', 'meta.webhooks_page_failed', { creator_id: id, ...describeError(err) });
        }
    }
    return summary;
}

/** Per object, where it pointed and what it carried before and after: what the audit row keeps. */
function changesOf(before: readonly DescribedObject[], after: readonly DescribedObject[] | null, steps: readonly RepairStepResult[]): Array<Record<string, unknown>> {
    const names = [...new Set([...before.map((o) => o.object), ...(after ?? []).map((o) => o.object)])];
    return names.map((object) => {
        const was = before.find((o) => o.object === object);
        const now = after?.find((o) => o.object === object);
        const step = steps.find((s) => s.object === object);
        return {
            object,
            host_before: was?.host ?? null,
            host_after: now?.host ?? null,
            fields_before: was?.fields ?? [],
            fields_after: now?.fields ?? null,
            ...(step ? { applied: step.ok } : {}),
        };
    });
}

/**
 * Send everything back to this deployment: the Meta app's subscriptions first, then the Pages. Throws `MetaLoginError` BEFORE anything is sent: `not_configured`,
 * `no_base_url`, `no_verify_token` (409 each), `graph_failed` (the first read, 502). After that nothing throws: a step Meta refuses is that step's result.
 *
 * It reads again at the end, and what it stores and returns is what Meta says NOW, not what the POSTs claimed. Writes one audit row whatever the outcome.
 */
export async function repairSubscriptions(actor: AuditActor): Promise<RepairOutcome> {
    const app = requireApp();
    const expected = await expectedCallback();
    const verifyToken = (await verifyTokenCandidates())[0];
    if (!verifyToken) {
        throw new MetaLoginError('no_verify_token', 'No webhook verify token is saved. Save one in Settings → Advanced (or set META_VERIFY_TOKEN), then try again: Meta checks it while it changes a subscription.');
    }
    const secrets = [app.appSecret, appTokenOf(app), verifyToken];

    const before = describeSubscriptions(await readAppSubscriptions(app), expected.host);
    const plan = planRepair(before, expected.url, API_VERSION);
    const steps: RepairStepResult[] = [];
    for (const step of plan) steps.push(await applyStep(app, step, verifyToken, secrets));

    let after: DescribedObject[] | null = null;
    try {
        after = describeSubscriptions(await readAppSubscriptions(app), expected.host);
    } catch (err) {
        log('warn', 'meta.webhooks_reread_failed', describeError(err));
    }

    const pages = await repairPages(app.appId);

    const now = Date.now();
    let previous: WebhookStatus | null = null;
    try {
        previous = await readStatus();
    } catch (err) {
        log('warn', 'meta.webhooks_status_unread', describeError(err));
    }
    const status = after
        ? answeredStatus(after, expected, now)
        : unansweredStatus(previous, new MetaLoginError('graph_failed', 'meta.read_app_subscriptions: the subscriptions could not be read back after the change.'), now);
    try {
        await writeStatus(status);
    } catch (err) {
        log('warn', 'meta.webhooks_status_unwritten', describeError(err));
    }

    await writeAudit(actor, {
        action: AUDIT_ACTIONS.metaWebhooksRepair,
        targetType: 'app',
        targetId: null,
        // Hosts, field names and outcomes: the audit log is never cleared, and nothing here is a credential.
        detail: {
            expected_host: expected.host,
            objects: changesOf(before, after, steps),
            steps: steps.map((s) => ({ object: s.object, ok: s.ok, ...(s.error ? { error: s.error } : {}) })),
            pages,
            still_broken: after ? isBroken(after) : null,
        },
    });
    log('info', 'meta.webhooks_repaired', {
        steps: steps.length, steps_failed: steps.filter((s) => !s.ok).length,
        pages_checked: pages.checked, pages_resubscribed: pages.resubscribed, pages_failed: pages.failed,
        still_broken: after ? isBroken(after) : null,
    });
    return { before, after, plan, steps, pages, status };
}

// ─── What the card shows ────────────────────────────────────────────────────────────────

export interface WebhooksView {
    checkedAt: string | null;
    ok: boolean | null;
    expected: { url: string | null; host: string | null };
    objects: DescribedObject[];
    problems: WebhookProblem[];
    /** What "Send everything to AutoReply" would do now. Empty: it is already all here (at app level). */
    plan: RepairStep[];
}

export function viewOf(status: WebhookStatus): WebhooksView {
    const answered = status.checkedAt !== null;
    return {
        checkedAt: status.checkedAt,
        ok: status.ok,
        expected: { url: status.expectedUrl, host: status.expectedHost },
        objects: status.objects,
        problems: answered ? findProblems(status.objects) : [],
        plan: answered && status.expectedUrl ? planRepair(status.objects, status.expectedUrl, API_VERSION) : [],
    };
}

/** When an event of each kind last reached THIS workspace (a `jobs` row is written before Meta is answered, whether or not a campaign matched). */
export interface LastEvents { instagram: string | null; facebook: string | null; whatsapp: string | null }

/**
 * The newest delivery per platform for one tenant, from `jobs`: the webhook writes `creator_id` NULL on every row and puts the id the delivery was addressed to in
 * `tenant_key` (the Instagram account's id, the Page's, or the WhatsApp number's and account's). That is what separates a platform that is quiet from a platform whose events go
 * somewhere else, which `lastWebhookAt` (the newest of all of them) cannot. Null when the tenant does not exist.
 */
export async function readLastEvents(creatorId: string): Promise<LastEvents | null> {
    const creator = await queryOne<{ instagram_page_id: string | null; facebook_page_id: string | null }>(
        'SELECT instagram_page_id, facebook_page_id FROM creators WHERE id = $1',
        [creatorId]
    );
    if (!creator) return null;

    let whatsappKeys: string[] = [];
    try {
        const row = await queryOne<{ phone_number_id: string | null; waba_id: string | null }>(
            `SELECT external_account_id AS phone_number_id, profile->>'waba_id' AS waba_id
               FROM platform_connections WHERE creator_id = $1 AND platform = 'whatsapp' AND status <> 'revoked'`,
            [creatorId]
        );
        whatsappKeys = [row?.phone_number_id, row?.waba_id].filter((k): k is string => Boolean(k));
    } catch (err) {
        // A database without WhatsApp's table has no WhatsApp events to show: the other two still answer.
        log('warn', 'meta.webhooks_whatsapp_ids_unread', describeError(err));
    }

    const instagramKeys = creator.instagram_page_id ? [creator.instagram_page_id] : [];
    const facebookKeys = creator.facebook_page_id ? [creator.facebook_page_id] : [];
    const keys = [...instagramKeys, ...facebookKeys, ...whatsappKeys];
    if (keys.length === 0) return { instagram: null, facebook: null, whatsapp: null };

    const rows = await queryRows<{ tenant_key: string; latest: Date | string | null }>(
        `SELECT tenant_key, MAX(created_at) AS latest
           FROM jobs
          WHERE tenant_key = ANY($1::text[]) AND kind IN ('comment.process', 'dm.process', 'wa.event', 'ads.lead')
          GROUP BY tenant_key`,
        [keys]
    );
    const newest = (ids: readonly string[]): string | null => {
        let best: number | null = null;
        for (const row of rows) {
            if (!ids.includes(row.tenant_key) || !row.latest) continue;
            const at = new Date(row.latest).getTime();
            if (!Number.isNaN(at) && (best === null || at > best)) best = at;
        }
        return best === null ? null : new Date(best).toISOString();
    };
    return { instagram: newest(instagramKeys), facebook: newest(facebookKeys), whatsapp: newest(whatsappKeys) };
}
