/**
 * Lead ads (Ads Manager phase A10, research R16, spec Story 8, FR-057…FR-059): instant forms on the tenant's Facebook Page, the leads they
 * collect, and everything the law asks of those leads. Built now, LOCKED per tenant until the platform admin records a `lead_ads` legal
 * sign-off (`legalSignoff.ts`, v56): Egypt's PDPL (compliance deadline 2026-11-01: licences, a separate e-marketing licence, consent for
 * transfers abroad) and Saudi's PDPL both cover what a person types into a lead form.
 *
 * ─── What the lock means here ───────────────────────────────────────────────
 *   - no form is created (`createLeadForm` → LOCKED_LEGAL before anything is written or sent);
 *   - the Page is not subscribed to `leadgen` (`syncLeadgenSubscription`, metaLogin.ts `leadgenFieldsFor`), so Meta sends no lead;
 *   - a lead that arrives anyway (a sign-off revoked a moment ago) is not fetched: `fetchAndStoreLead` answers 'locked' with no Graph call;
 *   - the catch-up only visits tenants with a sign-off.
 *   Leads stored while a sign-off existed stay readable by the owner after a revocation and keep their retention date: revoking stops new
 *   collection, it does not hide what the owner is already responsible for.
 *
 * ─── How a lead arrives ─────────────────────────────────────────────────────
 *   1. Meta's Page webhook field `leadgen` carries only ids (`leadgen_id`, `form_id`, `ad_id`, `page_id`): router.ts plans an `ads.lead` job.
 *   2. The job (`fetchAndStoreLead`) reads `GET /{leadgen_id}` with the tenant's PAGE token (a Page object; the ads token is not used) and
 *      stores it. A throttle is not retried: the job ends and the catch-up below picks the lead up.
 *   3. Every 6 hours per tenant (`catchUpLeads`, from the drain) the Page's forms are listed and each one asked for leads created after the
 *      newest one seen (`/{form_id}/leads?filtering=[time_created GREATER_THAN …]`). A missed notification is recovered within 24 h (FR-058).
 *
 * ─── What is stored ─────────────────────────────────────────────────────────
 *   `ads_leads.answers_enc` is the lead's `field_data`, AES-256-GCM with the env-held key (crypto.ts `encryptBytes`). `person_keys` are keyed
 *   hashes of the email and phone (crypto.ts `personKey`) so the data-erasure flow can find a person without decrypting anyone. After the
 *   tenant's retention period (Settings → Ads, default 90 days) the sweep nulls both and the row stays as a count (`purgeExpiredLeads`).
 *   Nothing here logs an answer, an email or a phone number, and nothing here is ever given to an AI. Nothing here contacts a lead either:
 *   the consent answer is stored and shown, and that is all.
 */
import type { PoolClient } from 'pg';
import { decryptBytes, encryptBytes, personKey } from '../../config/crypto.js';
import { pool } from '../../config/db.js';
import { queryCount, queryOne, queryRows } from '../../db/query.js';
import type { LeadJobPayload } from '../../jobs/types.js';
import { describeError, log } from '../../utils/log.js';
import { getSetting, getSiteOrigin, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { leadgenFieldsFor, readMetaApp, subscribePage } from '../metaLogin.js';
import { getCreatorByPageId, getTenant } from '../tenant.js';
import { adsGet, AdsGraphError, adsPost, type GraphParams } from './graph.js';
import { normaliseEmail, normalisePhone } from './hashing.js';
import { activeSignoff, coversCountry, lockView, type LegalSignoff } from './legalSignoff.js';
import { parseStoredSettings } from './settings.js';

// ─── The form, as the owner asks for it ──────────────────────────────────────────────────────────

export const LEAD_LOCALES = ['AR_AR', 'EN_US'] as const;
export type LeadLocale = (typeof LEAD_LOCALES)[number];

/**
 * The question types a form may carry. Meta's prefill types that are plain contact details, plus CUSTOM. Everything else is refused:
 * Meta's restricted types (government ids, dates of birth, marital status, ...) need Meta's permission and are exactly the personal data
 * the legal sign-off did not cover. An allow-list rather than a deny-list, so a type Meta adds tomorrow is refused until someone looks at it.
 */
export const ALLOWED_QUESTION_TYPES = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'CITY', 'COUNTRY', 'JOB_TITLE', 'COMPANY_NAME', 'CUSTOM'] as const;
export type QuestionType = (typeof ALLOWED_QUESTION_TYPES)[number];

/** The optional consent question's key: its answer is `consent_contact`. */
export const CONSENT_KEY = 'contact_consent';

export const MAX_QUESTIONS = 15;
export const MAX_CUSTOM_QUESTIONS = 5;

/**
 * Words that make a CUSTOM question ask for one of Meta's restricted categories (Lead Ads policy: health, religion, sexual orientation,
 * criminal record, union membership, politics, ethnicity, financial status and account numbers, passwords, government ids). A label is
 * lower-cased and its Arabic marks dropped before the test. Best effort by design: the owner still answers to Meta's review, and the
 * server's refusal names the category so a false positive is easy to reword.
 */
const RESTRICTED_WORDS: ReadonlyArray<readonly [category: string, words: readonly string[]]> = [
    // Arabic stems are chosen not to sit inside everyday words: «دين» is inside «مدينة», «طبي» inside «تطبيق», «صحي» inside «صحيح»,
    // «حمل» inside «حملة», «دخل» inside «مدخل», «جنسي» inside «الجنسية» (nationality, which is allowed) and «الإقامة» in «مكان الإقامة».
    ['health', ['health', 'medical', 'disease', 'illness', 'diagnos', 'pregnan', 'disabilit', 'الصحة', 'صحية', 'صحتك', 'مرض', 'طبية', 'الطبي', 'حامل', 'إعاقة', 'اعاقة']],
    ['religion', ['religio', 'faith', 'church', 'mosque', 'ديان', 'الدين', 'مذهب', 'طائفة']],
    ['sexual_orientation', ['sexual', 'orientation', 'gay', 'lesbian', 'التوجه الجنسي', 'الميول الجنسية', 'ميولك']],
    ['criminal_record', ['criminal', 'arrest', 'convict', 'جنائي', 'سوابق', 'اعتقال']],
    ['union_membership', ['trade union', 'labor union', 'labour union', 'نقابة']],
    ['politics', ['politic', 'vote', 'voting', 'party member', 'سياسي', 'حزب', 'انتخاب']],
    ['ethnicity', ['ethnic', 'racial', ' race', 'عرق', 'قبيلة', 'إثني', 'اثني']],
    ['financial', ['bank', 'card number', 'credit card', 'account number', 'iban', 'salary', 'income', 'debt', 'loan', 'حساب بنكي', 'رقم الحساب', 'رقم البطاقة', 'بطاقة ائتمان', 'بنك', 'راتب', 'دخلك', 'الدخل الشهري', 'ديون', 'قرض', 'آيبان', 'ايبان']],
    ['password', ['password', 'passcode', 'pin code', 'كلمة المرور', 'كلمة السر', 'رمز سري']],
    ['government_id', ['national id', 'passport', 'social security', 'id number', 'الرقم القومي', 'رقم الهوية', 'الهوية الوطنية', 'جواز السفر', 'رقم الإقامة', 'بطاقة شخصية']],
];

const ARABIC_MARKS = /[ً-ٰٟـ]/g;

/** The restricted category a label asks for, or null. */
export function restrictedCategory(label: string): string | null {
    const text = label.toLowerCase().replace(ARABIC_MARKS, '');
    for (const [category, words] of RESTRICTED_WORDS) if (words.some(w => text.includes(w))) return category;
    return null;
}

export interface QuestionInput { type: string; key?: string; label?: string; options?: string[] }
export interface ThankYouInput { title: string; body: string; buttonText: string; url: string }
export interface FormInput {
    name: string;
    locale?: string;
    questions: QuestionInput[];
    thankYou: ThankYouInput;
    consentQuestion?: boolean;
    privacyUrl?: string;
    idempotencyKey?: string;
}

export interface NormalisedQuestion { type: QuestionType; key?: string; label?: string; options?: string[] }
export interface NormalisedForm {
    name: string;
    locale: LeadLocale;
    questions: NormalisedQuestion[];
    thankYou: ThankYouInput;
    consentQuestion: boolean;
    privacyUrl: string;
    idempotencyKey: string | null;
}

export type FormRefusal = {
    ok: false;
    code: 'INVALID' | 'RESTRICTED_QUESTION' | 'LOCKED_LEGAL' | 'NOT_CONNECTED' | 'META_ERROR';
    field?: string;
    error: string;
};

const CONSENT_LABEL: Record<LeadLocale, { label: string; yes: string; no: string }> = {
    AR_AR: { label: 'هل توافق على أن نتواصل معك عبر الرسائل أو واتساب؟', yes: 'نعم', no: 'لا' },
    EN_US: { label: 'May we contact you by message or WhatsApp?', yes: 'Yes', no: 'No' },
};

function isHttpsUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2000) return false;
    try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : null);

/** A CUSTOM question's key from its label when none was given: ascii letters and digits, else `q<n>`. */
function keyFor(label: string, index: number): string {
    const k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return k || `q${index + 1}`;
}

/**
 * Check and normalise the owner's form (pure). `defaultPrivacyUrl` is the site's own `/privacy`, which a form always carries: Meta's Lead
 * Ads terms require a privacy link on every form even though the API marks the field optional (research 01 §6).
 */
export function validateForm(input: unknown, defaultPrivacyUrl: string): { ok: true; form: NormalisedForm } | FormRefusal {
    const bad = (field: string, error: string, code: FormRefusal['code'] = 'INVALID'): FormRefusal => ({ ok: false, code, field, error });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return bad('body', 'Send the form as an object.');
    const b = input as Record<string, unknown>;

    const name = str(b['name'], 100);
    if (!name) return bad('name', 'Give the form a name of 1 to 100 characters.');

    const locale = b['locale'] === undefined || b['locale'] === null || b['locale'] === '' ? 'AR_AR' : b['locale'];
    if (!(LEAD_LOCALES as readonly unknown[]).includes(locale)) return bad('locale', 'The form is in Arabic (AR_AR) or English (EN_US).');

    if (!Array.isArray(b['questions']) || b['questions'].length === 0) return bad('questions', 'Add at least one question.');
    const questions: NormalisedQuestion[] = [];
    const keys = new Set<string>();
    let custom = 0;
    for (const [i, raw] of (b['questions'] as unknown[]).entries()) {
        const at = `questions[${i}]`;
        if (typeof raw !== 'object' || raw === null) return bad(at, 'Each question is an object with a type.');
        const q = raw as Record<string, unknown>;
        const type = typeof q['type'] === 'string' ? q['type'].trim().toUpperCase() : '';
        if (!(ALLOWED_QUESTION_TYPES as readonly string[]).includes(type)) {
            return bad(`${at}.type`, `The question type ${type || '(none)'} is not allowed: Meta restricts it, and it is personal data the legal sign-off does not cover.`, 'RESTRICTED_QUESTION');
        }
        if (type === 'CUSTOM') {
            custom++;
            if (custom > MAX_CUSTOM_QUESTIONS) return bad(at, `At most ${MAX_CUSTOM_QUESTIONS} questions of your own.`);
            const label = str(q['label'], 80);
            if (!label) return bad(`${at}.label`, 'A question of your own needs a label of 1 to 80 characters.');
            const category = restrictedCategory(label);
            if (category) return bad(`${at}.label`, `This question asks for restricted information (${category.replace(/_/g, ' ')}). Meta does not allow it in lead forms.`, 'RESTRICTED_QUESTION');
            const key = q['key'] === undefined || q['key'] === '' ? keyFor(label, i) : q['key'];
            if (typeof key !== 'string' || !/^[a-z0-9_]{1,40}$/.test(key) || key === CONSENT_KEY) return bad(`${at}.key`, 'A key is 1 to 40 lowercase letters, digits or _.');
            if (keys.has(key)) return bad(`${at}.key`, 'Two questions have the same key.');
            keys.add(key);
            let options: string[] | undefined;
            if (q['options'] !== undefined) {
                if (!Array.isArray(q['options']) || q['options'].length < 2 || q['options'].length > 10) return bad(`${at}.options`, 'A multiple-choice question has 2 to 10 options.');
                options = [];
                for (const o of q['options']) {
                    const v = str(o, 80);
                    if (!v) return bad(`${at}.options`, 'Each option is 1 to 80 characters.');
                    if (restrictedCategory(v)) return bad(`${at}.options`, 'An option asks for restricted information.', 'RESTRICTED_QUESTION');
                    options.push(v);
                }
            }
            questions.push({ type: 'CUSTOM', key, label, ...(options ? { options } : {}) });
        } else {
            if (questions.some(x => x.type === type)) return bad(at, `The ${type} question is already on the form.`);
            questions.push({ type: type as QuestionType });
        }
    }
    const consentQuestion = b['consentQuestion'] === true;
    if (questions.length + (consentQuestion ? 1 : 0) > MAX_QUESTIONS) return bad('questions', `At most ${MAX_QUESTIONS} questions.`);

    const privacyUrl = b['privacyUrl'] === undefined || b['privacyUrl'] === null || b['privacyUrl'] === '' ? defaultPrivacyUrl : b['privacyUrl'];
    if (!isHttpsUrl(privacyUrl)) return bad('privacyUrl', 'The privacy policy link must be an https address.');

    const ty = b['thankYou'];
    if (typeof ty !== 'object' || ty === null) return bad('thankYou', 'Add the thank-you screen: a title, a sentence, a button and its link.');
    const t = ty as Record<string, unknown>;
    const title = str(t['title'], 60);
    if (!title) return bad('thankYou.title', 'The thank-you title is 1 to 60 characters.');
    const body = str(t['body'], 160);
    if (!body) return bad('thankYou.body', 'The thank-you sentence is 1 to 160 characters.');
    const buttonText = str(t['buttonText'], 30);
    if (!buttonText) return bad('thankYou.buttonText', 'The button text is 1 to 30 characters.');
    if (!isHttpsUrl(t['url'])) return bad('thankYou.url', 'The button opens an https address.');

    const idem = b['idempotencyKey'];
    if (idem !== undefined && idem !== null && (typeof idem !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(idem))) return bad('idempotencyKey', 'The idempotency key is 8 to 80 letters, digits or dashes.');

    return {
        ok: true,
        form: {
            name, locale: locale as LeadLocale, questions, consentQuestion, privacyUrl: privacyUrl as string,
            thankYou: { title, body, buttonText, url: t['url'] as string },
            idempotencyKey: typeof idem === 'string' ? idem : null,
        },
    };
}

/** The questions as Meta takes them, the consent question last when asked for. */
export function metaQuestions(form: NormalisedForm): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = form.questions.map(q => (q.type === 'CUSTOM'
        ? { type: 'CUSTOM', key: q.key, label: q.label, ...(q.options ? { options: q.options.map((value, i) => ({ value, key: `${q.key}_${i + 1}` })) } : {}) }
        : { type: q.type }));
    if (form.consentQuestion) {
        const c = CONSENT_LABEL[form.locale];
        out.push({ type: 'CUSTOM', key: CONSENT_KEY, label: c.label, options: [{ value: c.yes, key: 'yes' }, { value: c.no, key: 'no' }] });
    }
    return out;
}

/** `POST /{page_id}/leadgen_forms` (pure). Research 01 §6: name, questions, privacy_policy, locale, thank_you_page, follow_up_action_url. */
export function buildFormParams(form: NormalisedForm): GraphParams {
    return {
        name: form.name,
        locale: form.locale,
        questions: metaQuestions(form),
        privacy_policy: { url: form.privacyUrl, link_text: form.locale === 'AR_AR' ? 'سياسة الخصوصية' : 'Privacy policy' },
        thank_you_page: {
            title: form.thankYou.title, body: form.thankYou.body,
            button_type: 'VIEW_WEBSITE', button_text: form.thankYou.buttonText, website_url: form.thankYou.url,
        },
        follow_up_action_url: form.thankYou.url,
    };
}

// ─── Graph ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The calls this module makes, all with the tenant's PAGE token: forms and leads are Page objects. Through `ads/graph.ts`, so they are on the
 * pinned version and classified (a throttle is an `AdsGraphError` with klass 'throttle', never retried), but not paced against an ad account
 * (no `adAccountId`): Meta's lead-retrieval limit is per Page (200 × 24 × leads of the last 90 days a day), far above what this reads.
 */
export interface LeadsGraph {
    get(path: string, params: Record<string, string>, token: string, label: string, creatorId: string): Promise<any>;
    create(path: string, params: GraphParams, token: string, label: string, creatorId: string): Promise<any>;
}

const appGraph: LeadsGraph = {
    get: async (path, params, token, label, creatorId) => (await adsGet(path, params, token, { label, creatorId })).data,
    create: async (path, params, token, label, creatorId) => (await adsPost(path, params, token, { label, creatorId, creates: true })).data,
};

let graph: LeadsGraph = appGraph;

/** Tests only: answer the Graph calls with a stub; `null` puts the app's client back. */
export function setLeadsGraphForTests(stub: LeadsGraph | null): void {
    graph = stub ?? appGraph;
}

const isThrottle = (err: unknown): boolean => err instanceof AdsGraphError && err.klass === 'throttle';

/** Meta answered with an error of its own (a refusal), as opposed to no answer at all (a timeout, a dropped connection). */
function metaAnswered(err: unknown): boolean {
    const e = err as { status?: unknown; response?: { status?: unknown } };
    return typeof e?.status === 'number' || typeof e?.response?.status === 'number';
}

/** Meta's own sentence, never the token (the client's messages carry the label and Meta's text only). */
function metaMessage(err: unknown): string {
    return err instanceof Error ? err.message.slice(0, 300) : 'Meta refused the request.';
}

// ─── The tenant's Page ──────────────────────────────────────────────────────────────────────────

interface PageAccess { pageId: string; token: string }

/** The Facebook Page and its token. Lead forms live on the Facebook Page, even for an Instagram placement. */
async function pageAccess(creatorId: string): Promise<PageAccess | null> {
    const t = await getTenant(creatorId, ['id', 'facebook_page_id', 'page_access_token']);
    if (!t?.facebook_page_id || !t.page_access_token) return null;
    return { pageId: t.facebook_page_id, token: t.page_access_token };
}

/** Days a lead's answers are kept: the owner's Settings → Ads value, 1 to 365, 90 when unset or unreadable. */
export async function retentionDays(creatorId: string): Promise<number> {
    try {
        return parseStoredSettings(await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, creatorId))).leadRetentionDays;
    } catch (err) {
        log('warn', 'ads.leads_retention_unread', { creator_id: creatorId, ...describeError(err) });
        return 90;
    }
}

// ─── Forms ──────────────────────────────────────────────────────────────────────────────────────

export interface LeadFormView {
    id: string;
    metaId: string | null;
    name: string;
    locale: string;
    status: 'pending' | 'active' | 'archived' | 'failed';
    origin: 'app' | 'meta';
    consentQuestion: boolean;
    questions: NormalisedQuestion[];
    leadCount: number;
    lastLeadAt: string | null;
    createdAt: string;
    error: string | null;
}

interface FormRow {
    id: string; meta_id: string | null; page_id: string; name: string; locale: string; status: LeadFormView['status']; origin: LeadFormView['origin'];
    consent_question: boolean; questions: NormalisedQuestion[] | null; lead_count?: number | string | null; last_lead_seen_at: Date | string | null;
    created_at: Date | string; error: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());

const FORM_COLUMNS = 'f.id, f.meta_id, f.page_id, f.name, f.locale, f.status, f.origin, f.consent_question, f.questions, f.last_lead_seen_at, f.created_at, f.error';

function toFormView(r: FormRow): LeadFormView {
    return {
        id: r.id, metaId: r.meta_id, name: r.name, locale: r.locale, status: r.status, origin: r.origin, consentQuestion: r.consent_question,
        questions: Array.isArray(r.questions) ? r.questions : [], leadCount: Number(r.lead_count ?? 0), lastLeadAt: iso(r.last_lead_seen_at),
        createdAt: iso(r.created_at)!, error: r.error,
    };
}

export async function listLeadForms(creatorId: string): Promise<LeadFormView[]> {
    const rows = await queryRows<FormRow>(
        `SELECT ${FORM_COLUMNS}, (SELECT COUNT(*) FROM ads_leads l WHERE l.form_id = f.id)::int AS lead_count
           FROM ads_lead_forms f WHERE f.creator_id = $1 ORDER BY f.created_at DESC LIMIT 200`,
        [creatorId]
    );
    return rows.map(toFormView);
}

async function formByIdempotencyKey(creatorId: string, key: string): Promise<LeadFormView | null> {
    const row = await queryOne<FormRow>(`SELECT ${FORM_COLUMNS} FROM ads_lead_forms f WHERE f.creator_id = $1 AND f.idempotency_key = $2`, [creatorId, key]);
    return row ? toFormView(row) : null;
}

/**
 * Create a form on the tenant's Page. The row is written first ('pending'), then ONE POST: a create is never resent after it went out (the
 * client's `creates` rule), because a second POST is a second form. Meta's id makes it 'active'; Meta's refusal makes it 'failed' with
 * Meta's sentence; no answer at all leaves it 'pending', and the catch-up finds it on the Page by name. Not inside a transaction: nothing
 * here holds a database lock across the network call.
 */
export async function createLeadForm(creatorId: string, input: unknown): Promise<{ ok: true; form: LeadFormView } | FormRefusal> {
    if (!(await activeSignoff(creatorId, 'lead_ads'))) {
        return { ok: false, code: 'LOCKED_LEGAL', error: 'Lead ads are locked for this workspace until the platform admin records a legal sign-off.' };
    }
    const checked = validateForm(input, `${await getSiteOrigin()}/privacy`);
    if (!checked.ok) return checked;
    const form = checked.form;

    if (form.idempotencyKey) {
        const existing = await formByIdempotencyKey(creatorId, form.idempotencyKey);
        if (existing) return { ok: true, form: existing };
    }
    const page = await pageAccess(creatorId);
    if (!page) return { ok: false, code: 'NOT_CONNECTED', error: 'Connect the Facebook Page first: lead forms live on the Page.' };

    const inserted = await queryOne<{ id: string }>(
        `INSERT INTO ads_lead_forms (creator_id, page_id, name, origin, locale, questions, privacy_url, thank_you, consent_question, status, idempotency_key)
         VALUES ($1, $2, $3, 'app', $4, $5::jsonb, $6, $7::jsonb, $8, 'pending', $9)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [creatorId, page.pageId, form.name, form.locale, JSON.stringify(form.questions), form.privacyUrl, JSON.stringify(form.thankYou), form.consentQuestion, form.idempotencyKey]
    );
    if (!inserted) {
        // The same dialog submitted twice at once: the other request owns the POST.
        const existing = form.idempotencyKey ? await formByIdempotencyKey(creatorId, form.idempotencyKey) : null;
        if (existing) return { ok: true, form: existing };
        throw new Error('ads_lead_forms insert returned no row');
    }

    try {
        const answer = await graph.create(`${page.pageId}/leadgen_forms`, buildFormParams(form), page.token, 'ads.lead_form_create', creatorId);
        const metaId = answer?.id === undefined || answer?.id === null ? null : String(answer.id);
        if (!metaId) throw new Error('Meta answered without a form id.');
        await queryCount(`UPDATE ads_lead_forms SET meta_id = $2, status = 'active', error = NULL, updated_at = NOW() WHERE id = $1`, [inserted.id, metaId]);
    } catch (err) {
        if (metaAnswered(err) || isThrottle(err)) {
            const message = isThrottle(err) ? 'Meta is limiting requests right now; nothing was created. Try again in a few minutes.' : metaMessage(err);
            await queryCount(`UPDATE ads_lead_forms SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`, [inserted.id, message]);
            log('warn', 'ads.lead_form_failed', { creator_id: creatorId, form_id: inserted.id, ...describeError(err) });
            return { ok: false, code: 'META_ERROR', error: message };
        }
        // No answer: Meta may or may not have the form. Left 'pending' for the catch-up to find by name; never POSTed again.
        await queryCount(`UPDATE ads_lead_forms SET error = $2, updated_at = NOW() WHERE id = $1`, [inserted.id, 'Meta did not answer; checking the Page for this form.']);
        log('warn', 'ads.lead_form_unconfirmed', { creator_id: creatorId, form_id: inserted.id, ...describeError(err) });
    }
    const row = await queryOne<FormRow>(`SELECT ${FORM_COLUMNS}, 0 AS lead_count FROM ads_lead_forms f WHERE f.id = $1`, [inserted.id]);
    return { ok: true, form: toFormView(row!) };
}

// ─── Leads ──────────────────────────────────────────────────────────────────────────────────────

export interface LeadAnswer { name: string; values: string[] }

/** Meta's lead, as read by id or from a form's `leads` edge. */
export interface MetaLead { id: string; created_time?: string; ad_id?: string; form_id?: string; field_data?: Array<{ name?: unknown; values?: unknown }> }

const LEAD_FIELDS = 'id,created_time,ad_id,form_id,field_data';

/** `field_data` cut down to `{ name, values: string[] }`: the only shape that is encrypted and stored. */
export function normaliseFieldData(raw: MetaLead['field_data']): LeadAnswer[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(f => typeof f?.name === 'string')
        .map(f => ({ name: (f.name as string).slice(0, 100), values: Array.isArray(f.values) ? f.values.map(v => String(v).slice(0, 1000)) : [] }));
}

/** The keyed hashes of the email and phone a lead gave (crypto.ts personKey), for erasure. */
export function personKeysOf(answers: readonly LeadAnswer[]): string[] {
    const keys = new Set<string>();
    for (const a of answers) {
        const name = a.name.toLowerCase();
        for (const v of a.values) {
            if (name.includes('email')) { const e = normaliseEmail(v); if (e) keys.add(personKey(e)); }
            if (name.includes('phone')) { const p = normalisePhone(v); if (p) keys.add(personKey(p)); }
        }
    }
    return [...keys];
}

/** The consent question was answered yes. Meta reports the option's text or its key, depending on the form, so both are accepted. */
export function consentOf(answers: readonly LeadAnswer[]): boolean {
    const a = answers.find(x => x.name === CONSENT_KEY);
    return Boolean(a?.values.some(v => ['yes', 'نعم'].includes(v.trim().toLowerCase())));
}

export type StoreOutcome = 'stored' | 'duplicate' | 'locked' | 'no_tenant' | 'throttled' | 'failed';

/** Store one lead (idempotent on Meta's lead id) and move the form's "newest seen". */
export async function storeLead(creatorId: string, lead: MetaLead, via: 'webhook' | 'catchup', days?: number): Promise<'stored' | 'duplicate'> {
    const answers = normaliseFieldData(lead.field_data);
    const created = lead.created_time ? new Date(lead.created_time) : new Date();
    const createdAt = Number.isNaN(created.getTime()) ? new Date() : created;
    const keepDays = days ?? (await retentionDays(creatorId));
    const retainUntil = new Date(createdAt.getTime() + keepDays * 86_400_000);
    const formMetaId = lead.form_id ? String(lead.form_id) : null;

    const row = await queryOne<{ id: string }>(
        `INSERT INTO ads_leads (creator_id, meta_lead_id, form_id, form_meta_id, ad_meta_id, created_time, answers_enc, person_keys, consent_contact, retain_until, received_via)
         VALUES ($1, $2, (SELECT id FROM ads_lead_forms WHERE creator_id = $1 AND meta_id = $3), $3, $4, $5, $6, $7::text[], $8, $9, $10)
         ON CONFLICT (meta_lead_id) DO NOTHING RETURNING id`,
        [creatorId, String(lead.id), formMetaId, lead.ad_id ? String(lead.ad_id) : null, createdAt, encryptBytes(JSON.stringify(answers)),
            personKeysOf(answers), consentOf(answers), retainUntil, via]
    );
    if (formMetaId) {
        await queryCount(
            `UPDATE ads_lead_forms SET last_lead_seen_at = GREATEST(COALESCE(last_lead_seen_at, $3), $3), updated_at = NOW()
              WHERE creator_id = $1 AND meta_id = $2`,
            [creatorId, formMetaId, createdAt]
        );
    }
    return row ? 'stored' : 'duplicate';
}

/**
 * The `ads.lead` job: one `leadgen` notification. Never throws for a throttle (the catch-up recovers the lead; retrying a throttle is what
 * gets an app limited harder), for a locked tenant or for a Page we do not know. A transient failure (no answer) throws, so the job retries.
 */
export async function fetchAndStoreLead(job: LeadJobPayload, via: 'webhook' | 'catchup'): Promise<StoreOutcome> {
    const tenant = await getCreatorByPageId(job.pageId ?? undefined);
    if (!tenant) {
        log('info', 'ads.lead_no_tenant', { page_id: job.pageId });
        return 'no_tenant';
    }
    if (!(await activeSignoff(tenant.id, 'lead_ads'))) {
        log('warn', 'ads.lead_locked', { creator_id: tenant.id, form_id: job.formId });
        return 'locked';
    }
    let lead: MetaLead;
    try {
        lead = await graph.get(job.leadgenId, { fields: LEAD_FIELDS }, tenant.page_access_token, 'ads.lead_read', tenant.id);
    } catch (err) {
        if (isThrottle(err)) return 'throttled';
        if (metaAnswered(err)) {
            // A refusal (permission missing: leads_retrieval, the Leads Access Manager; the lead deleted): retrying would get the same answer.
            log('warn', 'ads.lead_read_refused', { creator_id: tenant.id, form_id: job.formId, ...describeError(err) });
            return 'failed';
        }
        throw err;
    }
    if (!lead?.id) return 'failed';
    const out = await storeLead(tenant.id, { ...lead, ad_id: lead.ad_id ?? job.adId ?? undefined, form_id: lead.form_id ?? job.formId ?? undefined }, via);
    log('info', 'ads.lead_received', { creator_id: tenant.id, form_id: lead.form_id ?? job.formId, outcome: out, via });
    return out;
}

export interface LeadView {
    id: string;
    createdTime: string;
    formId: string | null;
    formName: string | null;
    adId: string | null;
    /** Decrypted; null once purged (or if it cannot be decrypted, which is logged). */
    answers: LeadAnswer[] | null;
    consentContact: boolean;
    handedTo: 'none' | 'dm' | 'whatsapp';
    purged: boolean;
    retainUntil: string;
}

interface LeadRow {
    id: string; created_time: Date | string; form_id: string | null; form_name: string | null; ad_meta_id: string | null; answers_enc: Buffer | null;
    consent_contact: boolean; handed_to: LeadView['handedTo']; purged_at: Date | string | null; retain_until: Date | string;
}

export interface LeadQuery { formId?: string | null; from?: string | null; to?: string | null; limit?: number }

/** Owner only (the route checks). Decrypts in memory for the answer; nothing decrypted is written anywhere. */
export async function listLeads(creatorId: string, q: LeadQuery = {}): Promise<LeadView[]> {
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 500), 1), 5000);
    const rows = await queryRows<LeadRow>(
        `SELECT l.id, l.created_time, l.form_id, f.name AS form_name, l.ad_meta_id, l.answers_enc, l.consent_contact, l.handed_to, l.purged_at, l.retain_until
           FROM ads_leads l LEFT JOIN ads_lead_forms f ON f.id = l.form_id
          WHERE l.creator_id = $1
            AND ($2::uuid IS NULL OR l.form_id = $2::uuid)
            AND ($3::timestamptz IS NULL OR l.created_time >= $3::timestamptz)
            AND ($4::timestamptz IS NULL OR l.created_time < $4::timestamptz)
          ORDER BY l.created_time DESC LIMIT $5`,
        [creatorId, q.formId ?? null, q.from ?? null, q.to ?? null, limit]
    );
    return rows.map(r => {
        let answers: LeadAnswer[] | null = null;
        if (r.answers_enc && !r.purged_at) {
            try { answers = JSON.parse(decryptBytes(Buffer.from(r.answers_enc))) as LeadAnswer[]; } catch (err) {
                log('error', 'ads.lead_decrypt_failed', { creator_id: creatorId, lead_id: r.id, ...describeError(err) });
            }
        }
        return {
            id: r.id, createdTime: iso(r.created_time)!, formId: r.form_id, formName: r.form_name, adId: r.ad_meta_id, answers,
            consentContact: r.consent_contact, handedTo: r.handed_to, purged: r.purged_at !== null, retainUntil: iso(r.retain_until)!,
        };
    });
}

/** A cell a spreadsheet would run as a formula starts with = + - @ or a tab/CR: it gets a leading ' (CSV injection). */
function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The leads as CSV (pure): a UTF-8 byte-order mark so Excel opens Arabic correctly, then created_time, form, ad_id, consent_contact, and one
 * column per answer name in first-seen order. A purged lead has empty answer cells. Every cell is quoted.
 */
export function leadsCsv(leads: readonly LeadView[]): string {
    const names: string[] = [];
    for (const l of leads) for (const a of l.answers ?? []) if (!names.includes(a.name)) names.push(a.name);
    const header = ['created_time', 'form', 'ad_id', 'consent_contact', ...names];
    const lines = [header.map(csvCell).join(',')];
    for (const l of leads) {
        const byName = new Map((l.answers ?? []).map(a => [a.name, a.values.join(' | ')]));
        lines.push([l.createdTime, l.formName ?? '', l.adId ?? '', l.consentContact ? 'yes' : 'no', ...names.map(n => byName.get(n) ?? '')].map(csvCell).join(','));
    }
    return `﻿${lines.join('\r\n')}\r\n`;
}

// ─── The lead ad itself (the builder's Leads goal) ─────────────────────────────────────────────

export interface LeadSpecRefusal { status: 400 | 403; code: 'LOCKED_LEGAL' | 'INVALID'; field: string; message: string }

/**
 * The server's lock on a `goal: 'leads'` campaign (drafts.ts, before anything is written or validated at Meta): a non-revoked `lead_ads`
 * sign-off, every target country inside it (`coversCountry`: a sign-off for EG does not cover SA), and a form of THIS tenant that Meta has
 * (`status = 'active'` with a Meta id). Any other goal passes untouched. The browser checks the same things; this is what counts.
 */
export async function checkLeadSpec(creatorId: string, spec: { goal: string; leadFormId?: string; adsets: Array<{ targeting: { countries: string[] } }> }): Promise<LeadSpecRefusal | null> {
    if (spec.goal !== 'leads') return null;
    const lock = lockView(await activeSignoff(creatorId, 'lead_ads'));
    if (lock.locked) return { status: 403, code: 'LOCKED_LEGAL', field: 'goal', message: 'Lead ads are locked for this workspace until the platform admin records a legal sign-off.' };
    for (const [i, adset] of spec.adsets.entries()) {
        const outside = adset.targeting.countries.filter(c => !coversCountry(lock, c));
        if (outside.length > 0) {
            return { status: 403, code: 'LOCKED_LEGAL', field: `adsets.${i}.targeting.countries`, message: `The legal sign-off covers ${lock.countries.join(', ')} only, not ${outside.join(', ')}.` };
        }
    }
    const form = await queryOne<{ id: string }>(
        `SELECT id FROM ads_lead_forms WHERE creator_id = $1 AND meta_id = $2 AND status = 'active'`, [creatorId, spec.leadFormId ?? '']);
    if (!form) return { status: 400, code: 'INVALID', field: 'leadFormId', message: 'That lead form is not one of your active forms.' };
    return null;
}

// ─── Retention ──────────────────────────────────────────────────────────────────────────────────

/**
 * Delete the personal data of every lead past its retention (FR-059): the answers and the erasure keys go, the row stays as a count (date,
 * form, ad). Per tenant, so a period the owner LOWERED later applies to leads that arrived before (`created_time` older than today's
 * setting), not only to `retain_until` written at arrival. Idempotent: purged rows are not touched again.
 */
export async function purgeExpiredLeads(now = new Date()): Promise<number> {
    const tenants = await queryRows<{ creator_id: string }>('SELECT DISTINCT creator_id FROM ads_leads WHERE purged_at IS NULL', []);
    let purged = 0;
    for (const { creator_id } of tenants) {
        const days = await retentionDays(creator_id);
        purged += await queryCount(
            `UPDATE ads_leads SET answers_enc = NULL, person_keys = '{}', purged_at = $2
              WHERE creator_id = $1 AND purged_at IS NULL AND (retain_until <= $2 OR created_time <= $3)`,
            [creator_id, now, new Date(now.getTime() - days * 86_400_000)]
        );
    }
    if (purged > 0) log('info', 'ads.leads_purged', { count: purged });
    return purged;
}

// ─── The subscription ───────────────────────────────────────────────────────────────────────────

/**
 * Make the Page's subscription match the lock: WEBHOOK_FIELDS plus `leadgen` while a `lead_ads` sign-off exists, without it otherwise. A
 * `subscribed_apps` POST REPLACES the field list, so revoking is the same call without `leadgen`. Called after the admin records or revokes a
 * lead_ads sign-off (routes/admin.ts) and by the catch-up. `subscribed: null` when the tenant has no Page connected.
 */
export async function syncLeadgenSubscription(creatorId: string): Promise<{ subscribed: boolean | null }> {
    const page = await pageAccess(creatorId);
    if (!page) return { subscribed: null };
    const result = await subscribePage(page.pageId, page.token, readMetaApp()?.appId ?? null, await leadgenFieldsFor(creatorId));
    if (!result.confirmed) log('warn', 'ads.leadgen_subscription_unconfirmed', { creator_id: creatorId, warning: result.warning });
    return { subscribed: result.confirmed };
}

/** `['leadgen']` while unlocked, `[]` otherwise (metaLogin.ts `leadgenFieldsFor`, re-exported for the ads module's callers). */
export const leadSubscriptionFields = leadgenFieldsFor;

// ─── The catch-up ───────────────────────────────────────────────────────────────────────────────

export const CATCH_UP_INTERVAL_MS = 6 * 3_600_000;
/** How far back a form's first catch-up reads: Meta keeps leads about 90 days. */
const FIRST_LOOK_BACK_MS = 90 * 86_400_000;
/** The filter starts this much before the newest lead seen: Meta's `time_created` and the lead's `created_time` can differ by seconds. */
const OVERLAP_S = 600;
const MAX_PAGES = 10;

export interface CatchUpResult { tenants: number; forms: number; stored: number; throttled: number; failed: number }

class Throttled extends Error {}

interface PageForm { id: string; name?: string; locale?: string; status?: string }

/** Bring the Page's forms into `ads_lead_forms`: Meta's status, app forms left 'pending' by a timeout, forms made in Ads Manager. */
async function reconcileForms(creatorId: string, page: PageAccess): Promise<void> {
    let data: PageForm[];
    try {
        data = (await graph.get(`${page.pageId}/leadgen_forms`, { fields: 'id,name,locale,status', limit: '100' }, page.token, 'ads.lead_forms_list', creatorId))?.data ?? [];
    } catch (err) {
        if (isThrottle(err)) throw new Throttled();
        throw err;
    }
    for (const f of data) {
        if (!f?.id) continue;
        const status = String(f.status ?? 'ACTIVE').toUpperCase() === 'ARCHIVED' ? 'archived' : 'active';
        const known = await queryCount(`UPDATE ads_lead_forms SET status = $3, updated_at = NOW() WHERE creator_id = $1 AND meta_id = $2`, [creatorId, String(f.id), status]);
        if (known > 0) continue;
        const adopted = await queryCount(
            `UPDATE ads_lead_forms SET meta_id = $3, status = $4, error = NULL, updated_at = NOW()
              WHERE id = (SELECT id FROM ads_lead_forms WHERE creator_id = $1 AND origin = 'app' AND status = 'pending' AND meta_id IS NULL AND name = $2
                          ORDER BY created_at DESC LIMIT 1)`,
            [creatorId, String(f.name ?? ''), String(f.id), status]
        );
        if (adopted > 0) continue;
        await queryCount(
            `INSERT INTO ads_lead_forms (creator_id, meta_id, page_id, name, origin, locale, status) VALUES ($1, $2, $3, $4, 'meta', $5, $6)
             ON CONFLICT (meta_id) WHERE meta_id IS NOT NULL DO NOTHING`,
            [creatorId, String(f.id), page.pageId, String(f.name ?? f.id).slice(0, 100), String(f.locale ?? 'AR_AR'), status]
        );
    }
    // A lead that arrived before its form was known gets its form now.
    await queryCount(
        `UPDATE ads_leads l SET form_id = f.id FROM ads_lead_forms f
          WHERE l.creator_id = $1 AND l.form_id IS NULL AND f.creator_id = $1 AND f.meta_id = l.form_meta_id`,
        [creatorId]
    );
}

/** Every lead of one form created after the newest seen (`filtering` on `time_created`), up to 10 pages of 100. */
async function catchUpForm(creatorId: string, page: PageAccess, form: { id: string; meta_id: string; last_lead_seen_at: Date | string | null },
    since: Date, days: number, out: CatchUpResult, deadline: number): Promise<void> {
    const from = form.last_lead_seen_at ? new Date(form.last_lead_seen_at) : since;
    const filtering = JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(from.getTime() / 1000) - OVERLAP_S }]);
    let after: string | null = null;
    for (let i = 0; i < MAX_PAGES && Date.now() < deadline; i++) {
        const params: Record<string, string> = { fields: LEAD_FIELDS, filtering, limit: '100', ...(after ? { after } : {}) };
        let res: any;
        try {
            res = await graph.get(`${form.meta_id}/leads`, params, page.token, 'ads.leads_catch_up', creatorId);
        } catch (err) {
            if (isThrottle(err)) throw new Throttled();
            throw err;
        }
        for (const lead of (res?.data ?? []) as MetaLead[]) {
            if (!lead?.id) continue;
            if ((await storeLead(creatorId, { ...lead, form_id: lead.form_id ?? form.meta_id }, 'catchup', days)) === 'stored') out.stored++;
        }
        after = res?.paging?.next ? (res?.paging?.cursors?.after ?? null) : null;
        if (!after) break;
    }
    await queryCount('UPDATE ads_lead_forms SET caught_up_at = NOW() WHERE id = $1', [form.id]);
}

/**
 * The 6-hourly backfill (FR-058): for every tenant with a `lead_ads` sign-off and a connected Page, at most every 6 hours. A throttle ends
 * that tenant's run (the next one resumes from the newest lead seen); any other failure is logged and counted. Never throws.
 */
export async function catchUpLeads(now = new Date(), deadline = Number.POSITIVE_INFINITY): Promise<CatchUpResult> {
    const out: CatchUpResult = { tenants: 0, forms: 0, stored: 0, throttled: 0, failed: 0 };
    let tenants: Array<{ creator_id: string }>;
    try {
        tenants = await queryRows<{ creator_id: string }>(
            `SELECT DISTINCT s.creator_id FROM ads_legal_signoffs s JOIN creators c ON c.id = s.creator_id
              WHERE s.scope = 'lead_ads' AND s.revoked_at IS NULL AND c.facebook_page_id IS NOT NULL AND c.page_access_token IS NOT NULL`,
            []
        );
    } catch (err) {
        log('error', 'ads.leads_catch_up_failed', describeError(err));
        return out;
    }
    for (const { creator_id: creatorId } of tenants) {
        if (Date.now() >= deadline) break;
        try {
            const key = tenantSettingKey(TENANT_SETTING_PREFIXES.adsLeadsCaughtUp, creatorId);
            const last = Date.parse((await getSetting(key)) ?? '');
            if (!Number.isNaN(last) && now.getTime() - last < CATCH_UP_INTERVAL_MS) continue;
            await setSetting(key, now.toISOString(), null);

            const signoff: LegalSignoff | null = await activeSignoff(creatorId, 'lead_ads');
            const page = signoff ? await pageAccess(creatorId) : null;
            if (!signoff || !page) continue;
            out.tenants++;
            await syncLeadgenSubscription(creatorId).catch(err => log('warn', 'ads.leadgen_subscription_failed', { creator_id: creatorId, ...describeError(err) }));
            await reconcileForms(creatorId, page);

            const since = new Date(Math.max(Date.parse(signoff.recordedAt), now.getTime() - FIRST_LOOK_BACK_MS));
            const days = await retentionDays(creatorId);
            const forms = await queryRows<{ id: string; meta_id: string; last_lead_seen_at: Date | string | null }>(
                `SELECT id, meta_id, last_lead_seen_at FROM ads_lead_forms WHERE creator_id = $1 AND status = 'active' AND meta_id IS NOT NULL ORDER BY created_at`,
                [creatorId]
            );
            for (const form of forms) {
                if (Date.now() >= deadline) break;
                out.forms++;
                await catchUpForm(creatorId, page, form, since, days, out, deadline);
            }
        } catch (err) {
            if (err instanceof Throttled) { out.throttled++; continue; }
            out.failed++;
            log('warn', 'ads.leads_catch_up_tenant_failed', { creator_id: creatorId, ...describeError(err) });
        }
    }
    return out;
}

/** What the drain calls (routes/api.ts): the retention sweep first (it needs no Meta), then the catch-up. Never throws. */
export async function sweepLeads(now = new Date(), deadline = Number.POSITIVE_INFINITY): Promise<{ purged: number; catchUp: CatchUpResult | null }> {
    let purged = 0;
    try { purged = await purgeExpiredLeads(now); } catch (err) { log('error', 'ads.leads_purge_failed', describeError(err)); }
    let catchUp: CatchUpResult | null = null;
    try { catchUp = await catchUpLeads(now, deadline); } catch (err) { log('error', 'ads.leads_catch_up_failed', describeError(err)); }
    return { purged, catchUp };
}

// ─── Erasure (src/services/erasure.ts) ──────────────────────────────────────────────────────────

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

/**
 * The erasure keys an erasure handle stands for: an email, or a phone number (as given, and completed with Egypt's and Saudi Arabia's dial
 * codes when written nationally with a leading 0, the two markets this serves). An Instagram handle is neither, and matches no lead.
 */
export function leadPersonKeysForHandle(handle: string): string[] {
    const keys = new Set<string>();
    const email = normaliseEmail(handle);
    if (email) keys.add(personKey(email));
    else {
        for (const country of [null, 'EG', 'SA']) {
            const phone = normalisePhone(handle, country);
            if (phone) keys.add(personKey(phone));
        }
    }
    return [...keys];
}

export async function countLeadsForErasure(personKeys: readonly string[], exec: Queryable = pool): Promise<number> {
    if (personKeys.length === 0) return 0;
    const r = await exec.query('SELECT COUNT(*)::int AS n FROM ads_leads WHERE person_keys && $1::text[]', [personKeys]);
    return r.rows[0]?.n ?? 0;
}

/** Delete the person's leads, the whole row: erasure is not retention, so no count-only record is kept. Inside the erasure's transaction. */
export async function eraseLeads(exec: Queryable | PoolClient, personKeys: readonly string[]): Promise<number> {
    if (personKeys.length === 0) return 0;
    const r = await exec.query('DELETE FROM ads_leads WHERE person_keys && $1::text[]', [personKeys]);
    return r.rowCount ?? 0;
}
