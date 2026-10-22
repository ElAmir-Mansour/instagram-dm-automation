/**
 * Custom Audiences for the Ads Manager (phase A8; spec 002 research.md R15, research/01-capabilities.md section 5,
 * contracts/meta-graph.md "Audiences", research/02-policy-limits.md section 5.2; table `ads_audiences`, migration v56).
 *
 * Five kinds are built from sources the tenant already has, one from a file the owner uploads:
 *
 *   ig_engagement    people who engaged with the Instagram account       (rule, up to 730 days)
 *   page_engagement  people who engaged with the Facebook Page           (rule, up to 730 days)
 *   messagers        people who messaged the Page and/or the Instagram   (rule per source, OR-ed, up to 730 days)
 *   video_viewers    people who watched chosen videos                    (subtype ENGAGEMENT, legacy array rule, up to 365 days)
 *   lookalike        people like a ready audience, per country and ratio (subtype LOOKALIKE, seed of at least 100 people)
 *   customer_list    hashed contacts the owner uploaded                  (subtype CUSTOM; route and legal lock in routes/adsAudiences.ts)
 *
 * This file is the pure half (validation, rule JSON, how a Meta read becomes a status) and the store (`ads_audiences`).
 * Nothing here calls Meta: every write is queued through the ops queue (the route injects `enqueue`), and Meta's reads arrive from
 * the hourly structure sync (sync.ts), which hands them to `applyAudienceReads`.
 *
 * **Names are neutral.** The Custom Audience Terms forbid names and criteria that imply sensitive data, Meta flags such audiences
 * (`operation_status` 471) and refuses to run ads on them, and the owner's own rule is that the DM bot's segments (price objections,
 * hesitant buyers, hot and cold leads) never become an audience name or a seed. `validateAudienceName` refuses them.
 *
 * **No personal data.** A customer-list row stores only `{ columns, rows_sent, matched_estimate }`; the hashed rows live in the
 * queued `audience_users` ops and are scrubbed when those finish.
 */
import { queryRows } from '../../db/query.js';
import { normaliseAdAccountId, normaliseCountry } from '../metaAds.js';

// ─── Kinds, limits and specs ─────────────────────────────────────────────────────────────────────

export const AUDIENCE_KINDS = ['ig_engagement', 'page_engagement', 'video_viewers', 'messagers', 'lookalike', 'customer_list'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];
/** The kinds created through `POST /api/ads/audiences`; a customer list has its own route. */
export const BUILDABLE_KINDS = ['ig_engagement', 'page_engagement', 'video_viewers', 'messagers', 'lookalike'] as const;
export type BuildableKind = (typeof BUILDABLE_KINDS)[number];

export const AUDIENCE_STATUSES = ['creating', 'ready', 'too_small', 'flagged', 'deleted'] as const;
export type AudienceStatus = (typeof AUDIENCE_STATUSES)[number];

/** How far back a source may look, in days. Meta: 730 for Instagram, Page and messages; 365 for video (research/01 section 5). */
export const RETENTION_MAX_DAYS = { ig_engagement: 730, page_engagement: 730, messagers: 730, video_viewers: 365 } as const;
/** 1% to 20% in 1% steps (Meta `lookalike_spec.ratio`). */
export const LOOKALIKE_RATIOS: readonly number[] = Array.from({ length: 20 }, (_, i) => (i + 1) / 100);
/** A lookalike's seed needs at least this many people (Meta: 100 from one country). */
export const MIN_SEED_SIZE = 100;
/** An audience whose upper size bound is under this cannot be targeted (Meta delivery_status 300). */
export const MIN_TARGET_SIZE = 1000;
export const MAX_VIDEOS = 50;
export const MAX_NAME_LENGTH = 100;

export const IG_EVENTS = ['engaged', 'all', 'visited', 'messaged'] as const;
export const PAGE_EVENTS = ['engaged', 'visited', 'cta', 'saved', 'messaged'] as const;
export const MESSAGER_SOURCES = ['instagram', 'page'] as const;
export const VIDEO_WATCHED = ['3s', 'thruplay', '25', '50', '75', '95'] as const;

export interface IgEngagementSpec { event: (typeof IG_EVENTS)[number]; retentionDays: number }
export interface PageEngagementSpec { event: (typeof PAGE_EVENTS)[number]; retentionDays: number }
export interface MessagersSpec { sources: (typeof MESSAGER_SOURCES)[number][]; retentionDays: number }
export interface VideoViewersSpec { videoIds: string[]; watched: (typeof VIDEO_WATCHED)[number]; retentionDays: number }
export interface LookalikeSpec { seedAudienceId: string; country: string; ratio: number }
/** Read only: all the row ever holds about an uploaded list. */
export interface CustomerListSpec { columns: string[]; rows_sent: number; matched_estimate: number | null }

export interface SpecByKind {
    ig_engagement: IgEngagementSpec;
    page_engagement: PageEngagementSpec;
    messagers: MessagersSpec;
    video_viewers: VideoViewersSpec;
    lookalike: LookalikeSpec;
    customer_list: CustomerListSpec;
}
export type AudienceSpec = SpecByKind[AudienceKind];

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────────

export type AudienceErrorCode = 'INVALID' | 'LOCKED_LEGAL' | 'NOT_FOUND' | 'ADS_NOT_CONFIGURED' | 'TERMS_NOT_ACCEPTED' | 'SEED_TOO_SMALL' | 'AUDIENCE_NOT_USABLE';

const STATUS_BY_CODE: Record<AudienceErrorCode, number> = {
    INVALID: 400, LOCKED_LEGAL: 403, NOT_FOUND: 404, ADS_NOT_CONFIGURED: 409, TERMS_NOT_ACCEPTED: 409, SEED_TOO_SMALL: 409, AUDIENCE_NOT_USABLE: 409,
};

/**
 * A refusal the dashboard can act on: `{ error, code, field?, reason?, tosUrl? }` on the wire. Messages never contain request
 * content beyond what the owner typed as a name or an id; a customer list's text is never an input to any message.
 */
export class AudienceError extends Error {
    readonly status: number;
    readonly field: string | undefined;
    readonly reason: string | undefined;
    readonly tosUrl: string | undefined;
    constructor(readonly code: AudienceErrorCode, message: string, extra: { field?: string; reason?: string; tosUrl?: string } = {}) {
        super(message);
        this.name = 'AudienceError';
        this.status = STATUS_BY_CODE[code];
        this.field = extra.field;
        this.reason = extra.reason;
        this.tosUrl = extra.tosUrl;
    }
}

const invalid = (field: string, message: string, reason?: string): AudienceError =>
    new AudienceError('INVALID', message, { field, ...(reason ? { reason } : {}) });

// ─── Names ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Words an audience name must never contain, matched case-insensitively against the name after normalising Arabic (diacritics,
 * tatweel, alef and ya variants, ta marbuta) so spelling tricks do not slip through.
 *
 * WHY: (1) Meta's Custom Audience Terms forbid names and criteria implying sensitive data; since 2025-09-02 Meta flags audiences that
 * suggest health or financial status (`operation_status` 471) and refuses to run ads on them (research/02 section 3.6 and 5.2).
 * Religion, ethnicity, sexual orientation and politics are special categories under Meta policy and under both PDPLs. (2) The DM
 * bot's own segments (price objection, hesitant, hot/cold lead) describe how a person behaved in a private conversation: the owner's
 * rule is that they never become an audience name or a seed.
 *
 * `word: true` entries match a whole word only (an Arabic prefix such as ال or و, and a plural s, are allowed): they are short
 * enough to sit inside innocent words ("دين" in "مدينة", "سني" in "سنين", "gay" in "Gaylord").
 */
export const SENSITIVE_NAME_TERMS: ReadonlyArray<{ term: string; word?: boolean }> = [
    // Health
    { term: 'health' }, { term: 'medical' }, { term: 'sick' }, { term: 'disease' }, { term: 'diabetes' }, { term: 'pregnan' }, { term: 'disab' },
    { term: 'mental' }, { term: 'therapy' }, { term: 'مرض' }, { term: 'مريض' }, { term: 'صحة' }, { term: 'حامل' }, { term: 'حوامل' }, { term: 'إعاقة' }, { term: 'نفسي' },
    // Financial status
    { term: 'poor', word: true }, { term: 'broke', word: true }, { term: 'debt' }, { term: 'loan', word: true }, { term: 'credit score' }, { term: "can't afford" },
    { term: 'cannot afford' }, { term: 'low income' }, { term: 'unemployed' }, { term: 'bankrupt' }, { term: 'فقير' }, { term: 'فقراء' }, { term: 'ديون' },
    { term: 'دين', word: true }, { term: 'قرض' }, { term: 'لا يستطيع' }, { term: 'مش قادر' }, { term: 'عاطل' }, { term: 'محتاج' }, { term: 'دخل منخفض' }, { term: 'غالي عليه' },
    // Religion, ethnicity, sexual orientation, politics
    { term: 'religio' }, { term: 'muslim' }, { term: 'christian' }, { term: 'shia' }, { term: 'sunni' }, { term: 'مسلم' }, { term: 'مسيحي' }, { term: 'شيعي' },
    { term: 'سني', word: true }, { term: 'gay', word: true }, { term: 'lesbian' }, { term: 'مثلي' }, { term: 'political' }, { term: 'سياسي' },
    // The DM bot's segments
    { term: 'segment' }, { term: 'objection' }, { term: 'price objection' }, { term: 'hesitant' }, { term: 'cold lead' }, { term: 'hot lead' }, { term: 'اعتراض' },
    { term: 'متردد' }, { term: 'السعر غالي' },
];

/** Lower-case, no Arabic diacritics or tatweel, one alef, one ya, ta marbuta as ha, straight apostrophes, single spaces. */
function foldForMatching(text: string): string {
    return text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[ً-ٰٟـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[‘’ʼ`]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

const ARABIC_PREFIXES = ['وبال', 'وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل', 'ك'];

let foldedTerms: Array<{ term: string; word: boolean }> | null = null;
function terms(): Array<{ term: string; word: boolean }> {
    foldedTerms ??= SENSITIVE_NAME_TERMS.map((t) => ({ term: foldForMatching(t.term), word: t.word === true }));
    return foldedTerms;
}

function matchesWord(tokens: string[], term: string): boolean {
    return tokens.some((token) => {
        if (token === term || token === `${term}s`) return true;
        return ARABIC_PREFIXES.some((prefix) => token.startsWith(prefix) && token.slice(prefix.length) === term);
    });
}

/** True when the name implies sensitive data. */
export function isSensitiveName(name: string): boolean {
    const folded = foldForMatching(name);
    const tokens = folded.split(/[^\p{L}\p{N}']+/u).filter((t) => t !== '');
    return terms().some(({ term, word }) => (word ? matchesWord(tokens, term) : folded.includes(term)));
}

/** The trimmed name, or an INVALID refusal: 1 to 100 characters, and nothing that implies sensitive data. */
export function validateAudienceName(input: unknown): string {
    const name = typeof input === 'string' ? input.trim() : '';
    if (name === '') throw invalid('name', 'Give the audience a name.', 'name_length');
    if (name.length > MAX_NAME_LENGTH) throw invalid('name', `The name is at most ${MAX_NAME_LENGTH} characters.`, 'name_length');
    if (isSensitiveName(name)) {
        throw invalid('name', 'Meta refuses audiences whose name suggests health, money, religion or politics. Use a neutral name.', 'sensitive_name');
    }
    return name;
}

const COUNTRY_NAMES_AR: Record<string, string> = {
    EG: 'مصر', SA: 'السعودية', AE: 'الإمارات', KW: 'الكويت', QA: 'قطر', BH: 'البحرين', OM: 'عُمان', JO: 'الأردن', LB: 'لبنان', MA: 'المغرب', DZ: 'الجزائر',
    TN: 'تونس', LY: 'ليبيا', SD: 'السودان', IQ: 'العراق', SY: 'سوريا', PS: 'فلسطين', YE: 'اليمن', US: 'أمريكا', GB: 'بريطانيا', DE: 'ألمانيا', FR: 'فرنسا', TR: 'تركيا',
};

function daysLabel(days: number): string {
    if (days === 1) return 'يوم واحد';
    if (days === 2) return 'يومان';
    if (days >= 3 && days <= 10) return `${days} أيام`;
    return `${days} يومًا`;
}

const WATCHED_LABEL: Record<(typeof VIDEO_WATCHED)[number], string> = { '3s': '3 ثوانٍ', thruplay: 'ThruPlay', '25': '25%', '50': '50%', '75': '75%', '95': '95%' };

/** A neutral Arabic name for an audience the owner left unnamed. */
export function defaultAudienceName(kind: AudienceKind, spec: AudienceSpec): string {
    switch (kind) {
        case 'ig_engagement': return `تفاعل إنستغرام · ${daysLabel((spec as IgEngagementSpec).retentionDays)}`;
        case 'page_engagement': return `تفاعل الصفحة · ${daysLabel((spec as PageEngagementSpec).retentionDays)}`;
        case 'messagers': return `مراسلو النشاط · ${daysLabel((spec as MessagersSpec).retentionDays)}`;
        case 'video_viewers': {
            const s = spec as VideoViewersSpec;
            return `مشاهدو الفيديو · ${WATCHED_LABEL[s.watched]} · ${daysLabel(s.retentionDays)}`;
        }
        case 'lookalike': {
            const s = spec as LookalikeSpec;
            return `مشابه · ${COUNTRY_NAMES_AR[s.country] ?? s.country} · ${Math.round(s.ratio * 100)}%`;
        }
        case 'customer_list': return 'قائمة عملاء';
    }
}

// ─── Parsing the request ─────────────────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, what: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
        throw invalid(field, `${what} must be one of: ${allowed.join(', ')}.`);
    }
    return value as T;
}

function retention(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
        throw invalid('spec.retentionDays', `Retention is a whole number of days from 1 to ${max}.`, 'retention_range');
    }
    return value;
}

/** `{ kind, name, spec }` of `POST /api/ads/audiences`, validated. A blank name becomes the automatic neutral one. */
export function parseAudienceInput(body: unknown): { kind: BuildableKind; name: string; spec: AudienceSpec } {
    if (!isRecord(body)) throw invalid('body', 'Send an object with kind, name and spec.');
    if (body['kind'] === 'customer_list') {
        throw invalid('kind', 'A customer list is uploaded through its own form.', 'use_customer_list_route');
    }
    const kind = oneOf(body['kind'], BUILDABLE_KINDS, 'kind', 'kind');
    const raw = body['spec'];
    if (!isRecord(raw)) throw invalid('spec', 'Send the audience settings as spec.');

    let spec: AudienceSpec;
    switch (kind) {
        case 'ig_engagement':
            spec = { event: oneOf(raw['event'], IG_EVENTS, 'spec.event', 'event'), retentionDays: retention(raw['retentionDays'], RETENTION_MAX_DAYS.ig_engagement) };
            break;
        case 'page_engagement':
            spec = { event: oneOf(raw['event'], PAGE_EVENTS, 'spec.event', 'event'), retentionDays: retention(raw['retentionDays'], RETENTION_MAX_DAYS.page_engagement) };
            break;
        case 'messagers': {
            if (!Array.isArray(raw['sources']) || raw['sources'].length === 0) throw invalid('spec.sources', 'Choose Instagram, the Page, or both.');
            const sources: MessagersSpec['sources'] = [];
            for (const source of raw['sources']) {
                const value = oneOf(source, MESSAGER_SOURCES, 'spec.sources', 'source');
                if (!sources.includes(value)) sources.push(value);
            }
            spec = { sources, retentionDays: retention(raw['retentionDays'], RETENTION_MAX_DAYS.messagers) };
            break;
        }
        case 'video_viewers': {
            const ids = raw['videoIds'];
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_VIDEOS || !ids.every((id) => typeof id === 'string' && /^[0-9]{1,30}$/.test(id))) {
                throw invalid('spec.videoIds', `Choose from 1 to ${MAX_VIDEOS} videos.`);
            }
            spec = {
                videoIds: [...new Set(ids as string[])],
                watched: oneOf(raw['watched'], VIDEO_WATCHED, 'spec.watched', 'watched'),
                retentionDays: retention(raw['retentionDays'], RETENTION_MAX_DAYS.video_viewers),
            };
            break;
        }
        case 'lookalike': {
            const seed = raw['seedAudienceId'];
            if (typeof seed !== 'string' || !UUID_PATTERN.test(seed)) throw invalid('spec.seedAudienceId', 'Choose the audience to copy.');
            const country = normaliseCountry(raw['country']);
            if (!country) throw invalid('spec.country', 'Choose a country (two-letter code).');
            const ratio = raw['ratio'];
            if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.01 - 1e-9 || ratio > 0.2 + 1e-9 || Math.abs(ratio * 100 - Math.round(ratio * 100)) > 1e-6) {
                throw invalid('spec.ratio', 'The ratio is from 1% to 20%, in 1% steps.', 'ratio_range');
            }
            spec = { seedAudienceId: seed.toLowerCase(), country, ratio: Math.round(ratio * 100) / 100 };
            break;
        }
    }

    const typed = typeof body['name'] === 'string' ? body['name'].trim() : '';
    const name = typed === '' ? defaultAudienceName(kind, spec) : validateAudienceName(typed);
    return { kind, name, spec };
}

// ─── Rules and Graph params ──────────────────────────────────────────────────────────────────────

const IG_EVENT_NAMES: Record<IgEngagementSpec['event'], string> = {
    engaged: 'ig_business_profile_engaged', all: 'ig_business_profile_all', visited: 'ig_business_profile_visit', messaged: 'ig_user_messaged_business',
};
const PAGE_EVENT_NAMES: Record<PageEngagementSpec['event'], string> = {
    engaged: 'page_engaged', visited: 'page_visited', cta: 'page_cta_clicked', saved: 'page_or_post_save', messaged: 'page_messaged',
};
/** Video event names. '3s' and '95' are documented; the other four are live-check (R15: ThruPlay/25-75% API names unconfirmed). */
const VIDEO_EVENT_NAMES: Record<VideoViewersSpec['watched'], string> = {
    '3s': 'video_watched',
    '95': 'video_completed',
    '25': 'video_view_25_percent', // live-check
    '50': 'video_view_50_percent', // live-check
    '75': 'video_view_75_percent', // live-check
    thruplay: 'thruplay_watched', // live-check
};

export interface EngagementRule {
    inclusions: {
        operator: 'or';
        rules: Array<{
            event_sources: Array<{ id: string; type: 'ig_business' | 'page' }>;
            retention_seconds: number;
            filter: { operator: 'and'; filters: Array<{ field: 'event'; operator: 'eq'; value: string }> };
        }>;
    };
}

function engagementRule(sources: Array<{ id: string; type: 'ig_business' | 'page'; event: string }>, retentionDays: number): EngagementRule {
    return {
        inclusions: {
            operator: 'or',
            rules: sources.map((source) => ({
                event_sources: [{ id: source.id, type: source.type }],
                retention_seconds: retentionDays * 86400,
                filter: { operator: 'and', filters: [{ field: 'event', operator: 'eq', value: source.event }] },
            })),
        },
    };
}

export function igEngagementRule(igUserId: string, spec: IgEngagementSpec): EngagementRule {
    return engagementRule([{ id: igUserId, type: 'ig_business', event: IG_EVENT_NAMES[spec.event] }], spec.retentionDays);
}
export function pageEngagementRule(pageId: string, spec: PageEngagementSpec): EngagementRule {
    return engagementRule([{ id: pageId, type: 'page', event: PAGE_EVENT_NAMES[spec.event] }], spec.retentionDays);
}
export function messagersRule(ids: { igUserId: string | null; pageId: string | null }, spec: MessagersSpec): EngagementRule {
    const sources: Array<{ id: string; type: 'ig_business' | 'page'; event: string }> = [];
    for (const source of spec.sources) {
        if (source === 'instagram') {
            if (!ids.igUserId) throw invalid('spec.sources', 'Connect an Instagram account first.', 'no_instagram');
            sources.push({ id: ids.igUserId, type: 'ig_business', event: 'ig_user_messaged_business' });
        } else {
            if (!ids.pageId) throw invalid('spec.sources', 'Connect a Facebook Page first.', 'no_page');
            sources.push({ id: ids.pageId, type: 'page', event: 'page_messaged' });
        }
    }
    return engagementRule(sources, spec.retentionDays);
}
/** The legacy array rule video audiences (subtype ENGAGEMENT) still use. */
export function videoRule(spec: VideoViewersSpec): Array<{ event_name: string; object_id: string }> {
    const event_name = VIDEO_EVENT_NAMES[spec.watched];
    return spec.videoIds.map((id) => ({ event_name, object_id: id }));
}

export type GraphParams = Record<string, string | number | boolean>;

export interface SourceIds { igUserId: string | null; pageId: string | null; seedMetaId?: string | null }

/** The Graph parameters of `POST act_<id>/customaudiences`. The ops queue appends the ` AR·<op id>` tag to `name` itself (A2). */
export function buildCreateParams(kind: AudienceKind, name: string, spec: AudienceSpec, ids: SourceIds): GraphParams {
    switch (kind) {
        case 'ig_engagement': {
            if (!ids.igUserId) throw invalid('kind', 'Connect an Instagram account first.', 'no_instagram');
            return { name, rule: JSON.stringify(igEngagementRule(ids.igUserId, spec as IgEngagementSpec)), prefill: 1 };
        }
        case 'page_engagement': {
            if (!ids.pageId) throw invalid('kind', 'Connect a Facebook Page first.', 'no_page');
            return { name, rule: JSON.stringify(pageEngagementRule(ids.pageId, spec as PageEngagementSpec)), prefill: 1 };
        }
        case 'messagers':
            return { name, rule: JSON.stringify(messagersRule(ids, spec as MessagersSpec)), prefill: 1 };
        case 'video_viewers': {
            const s = spec as VideoViewersSpec;
            return { name, subtype: 'ENGAGEMENT', rule: JSON.stringify(videoRule(s)), retention_days: s.retentionDays, prefill: 1 };
        }
        case 'lookalike': {
            const s = spec as LookalikeSpec;
            if (!ids.seedMetaId) throw invalid('spec.seedAudienceId', 'The audience to copy is not at Meta yet.', 'seed_not_ready');
            return { name, subtype: 'LOOKALIKE', origin_audience_id: ids.seedMetaId, lookalike_spec: JSON.stringify({ ratio: s.ratio, country: s.country }) };
        }
        case 'customer_list':
            return { name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' };
    }
}

/** What the ops queue (phase A2) runs against Graph. `{dep}` in `path` is the Meta id of the op this one depends on. */
export interface AudienceOpExec { method: 'POST' | 'DELETE'; path: string; params?: Record<string, string | number | boolean>; edge?: 'customaudiences' }

export function createExec(adAccountId: string, params: GraphParams): AudienceOpExec {
    const digits = normaliseAdAccountId(adAccountId);
    if (!digits) throw new AudienceError('ADS_NOT_CONFIGURED', 'Set the ad account first.');
    return { method: 'POST', path: `act_${digits}/customaudiences`, params, edge: 'customaudiences' };
}

// ─── What Meta says ──────────────────────────────────────────────────────────────────────────────

/** One row of `GET act_<id>/customaudiences?fields=id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status`. */
export interface MetaAudienceRead {
    id?: unknown;
    name?: unknown;
    subtype?: unknown;
    approximate_count_lower_bound?: unknown;
    approximate_count_upper_bound?: unknown;
    operation_status?: { code?: unknown; description?: unknown } | null;
    delivery_status?: { code?: unknown; description?: unknown } | null;
}

/** Meta answers -1 when it does not know a bound. Numeric strings are accepted: Graph sometimes sends bigints as strings. */
function bound(value: unknown): number | null {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Operation statuses meaning the audience is still being built or filled. */
const BUILDING_OPERATION_CODES = new Set([414, 441]);

export function classifyAudienceRead(raw: unknown): { status: Exclude<AudienceStatus, 'deleted'>; sizeLower: number | null; sizeUpper: number | null } {
    const read = (isRecord(raw) ? raw : {}) as MetaAudienceRead;
    const sizeLower = bound(read.approximate_count_lower_bound);
    const sizeUpper = bound(read.approximate_count_upper_bound);
    const operation = Number(read.operation_status?.code);
    const delivery = Number(read.delivery_status?.code);

    let status: Exclude<AudienceStatus, 'deleted'> = 'ready';
    if (operation === 471) status = 'flagged';
    // A build in progress reports small or empty sizes: not "too small" yet.
    else if (BUILDING_OPERATION_CODES.has(operation)) status = 'creating';
    else if (delivery === 300 || (sizeLower !== null && sizeUpper !== null && sizeUpper < MIN_TARGET_SIZE)) status = 'too_small';
    return { status, sizeLower, sizeUpper };
}

/** Meta's refusal while the Custom Audience Terms are not accepted: error code 200, subcode 1870090. */
export function isTermsError(err: unknown): boolean {
    if (!isRecord(err)) return false;
    const response = isRecord(err['response']) ? err['response'] : null;
    const data = response && isRecord(response['data']) ? response['data'] : null;
    const nested = data && isRecord(data['error']) ? data['error'] : null;
    const code = [err['metaCode'], nested?.['code'], err['code']].find((v) => typeof v === 'number');
    const subcode = [err['metaSubcode'], nested?.['error_subcode'], err['error_subcode'], err['subcode']].find((v) => typeof v === 'number');
    return code === 200 && subcode === 1870090;
}

/** The API cannot accept the terms: the owner does it in Meta's own screen. */
export function termsUrl(adAccountId: string): string {
    const digits = normaliseAdAccountId(adAccountId) ?? String(adAccountId).replace(/^act_/i, '');
    return `https://business.facebook.com/ads/manage/customaudiences/tos/?act=${encodeURIComponent(digits)}`;
}

/** The ad account's `tos_accepted` map to `{ custom, lookalike }`; null for what Meta did not say. */
export function tosFromAccount(tosAccepted: unknown): { custom: boolean | null; lookalike: boolean | null } {
    if (!isRecord(tosAccepted)) return { custom: null, lookalike: null };
    const read = (key: string): boolean | null => {
        const v = tosAccepted[key];
        if (v === undefined || v === null) return null;
        return v === true || v === 1 || v === '1';
    };
    return { custom: read('custom_audience_tos'), lookalike: read('lookalike_audience_tos') };
}

// ─── Rows and views ──────────────────────────────────────────────────────────────────────────────

/** A row of `ads_audiences` as `pg` returns it (BIGINT as string). */
export interface AudienceRow {
    id: string;
    creator_id: string;
    meta_id: string | null;
    kind: AudienceKind;
    name: string;
    spec: Record<string, unknown>;
    status: AudienceStatus;
    size_lower: string | number | null;
    size_upper: string | number | null;
    seed_audience_id: string | null;
    synced_at: Date | string | null;
    created_at: Date | string;
    [column: string]: unknown;
}

export type UnusableReason = Exclude<AudienceStatus, 'ready'>;

export interface AudienceOpSummary { id: string; state: string; kind: string }

export interface AudienceView {
    id: string;
    metaId: string | null;
    kind: AudienceKind;
    name: string;
    status: AudienceStatus;
    sizeLower: number | null;
    sizeUpper: number | null;
    seedAudienceId: string | null;
    spec: Record<string, unknown>;
    syncedAt: string | null;
    createdAt: string;
    usable: boolean;
    unusableReason: UnusableReason | null;
    op: AudienceOpSummary | null;
}

export function usability(row: Pick<AudienceRow, 'status'>): { usable: boolean; unusableReason: UnusableReason | null } {
    return row.status === 'ready' ? { usable: true, unusableReason: null } : { usable: false, unusableReason: row.status };
}

/** A customer-list spec holds only `{ columns, rows_sent, matched_estimate }`: whatever else ended up there never leaves the server. */
export function scrubSpecForView(spec: unknown, kind?: AudienceKind): Record<string, unknown> {
    const source = isRecord(spec) ? spec : {};
    const looksLikeList = 'rows_sent' in source || 'columns' in source || 'matched_estimate' in source;
    if (kind === 'customer_list' || (kind === undefined && looksLikeList)) {
        return {
            columns: Array.isArray(source['columns']) ? source['columns'].filter((c): c is string => typeof c === 'string') : [],
            rows_sent: typeof source['rows_sent'] === 'number' ? source['rows_sent'] : 0,
            matched_estimate: typeof source['matched_estimate'] === 'number' ? source['matched_estimate'] : null,
        };
    }
    return { ...source };
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const asCount = (value: string | number | null): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

export function toAudienceView(row: AudienceRow, op?: { id: string; state: string; kind: string } | null): AudienceView {
    return {
        id: row.id,
        metaId: row.meta_id,
        kind: row.kind,
        name: row.name,
        status: row.status,
        sizeLower: asCount(row.size_lower),
        sizeUpper: asCount(row.size_upper),
        seedAudienceId: row.seed_audience_id,
        spec: scrubSpecForView(row.spec, row.kind),
        syncedAt: row.synced_at === null ? null : iso(row.synced_at),
        createdAt: iso(row.created_at),
        ...usability(row),
        op: op ? { id: op.id, state: op.state, kind: op.kind } : null,
    };
}

// ─── Store ───────────────────────────────────────────────────────────────────────────────────────

const COLUMNS = 'id, creator_id, meta_id, kind, name, spec, status, size_lower, size_upper, seed_audience_id, synced_at, created_at';

export const INSERT_AUDIENCE_SQL = `INSERT INTO ads_audiences (creator_id, kind, name, spec, seed_audience_id) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING ${COLUMNS}`;
export const LIST_AUDIENCES_SQL = `SELECT ${COLUMNS} FROM ads_audiences WHERE creator_id = $1 AND status <> 'deleted' ORDER BY created_at DESC, id`;
export const GET_AUDIENCE_SQL = `SELECT ${COLUMNS} FROM ads_audiences WHERE id = $1 AND creator_id = $2`;
export const GET_AUDIENCES_SQL = `SELECT ${COLUMNS} FROM ads_audiences WHERE creator_id = $1 AND id = ANY($2::uuid[])`;
export const MARK_DELETED_SQL = `UPDATE ads_audiences SET status = 'deleted', synced_at = NOW() WHERE id = $1 AND creator_id = $2 AND status <> 'deleted'`;
export const SET_META_ID_SQL = 'UPDATE ads_audiences SET meta_id = $3 WHERE id = $2 AND creator_id = $1';
export const SYNCABLE_AUDIENCES_SQL = `SELECT ${COLUMNS} FROM ads_audiences WHERE creator_id = $1 AND status <> 'deleted'`;
export const APPLY_READ_SQL = `UPDATE ads_audiences SET meta_id = $3, status = $4, size_lower = $5, size_upper = $6, synced_at = NOW() WHERE id = $2 AND creator_id = $1 AND status <> 'deleted'`;

/** Insert a new audience in status 'creating'. `spec` is stored as given (a customer list's holds counts only). */
export async function insertAudience(
    creatorId: string,
    input: { kind: AudienceKind; name: string; spec: AudienceSpec | Record<string, unknown>; seedAudienceId?: string | null }
): Promise<AudienceRow> {
    const rows = await queryRows<AudienceRow>(INSERT_AUDIENCE_SQL, [creatorId, input.kind, input.name, JSON.stringify(input.spec), input.seedAudienceId ?? null]);
    const row = rows[0];
    if (!row) throw new Error('ads_audiences insert returned no row');
    return row;
}

/** The tenant's audiences, newest first, without the deleted ones. */
export async function listAudiences(creatorId: string): Promise<AudienceRow[]> {
    return queryRows<AudienceRow>(LIST_AUDIENCES_SQL, [creatorId]);
}

export async function getAudience(creatorId: string, id: string): Promise<AudienceRow | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const rows = await queryRows<AudienceRow>(GET_AUDIENCE_SQL, [id, creatorId]);
    return rows[0] ?? null;
}

/** Mark deleted (the row stays for the audit trail). False when there is nothing to mark. */
export async function markAudienceDeleted(creatorId: string, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    const rows = await queryRows<AudienceRow>(`${MARK_DELETED_SQL} RETURNING id`, [id, creatorId]);
    return rows.length > 0;
}

export async function setAudienceMetaId(creatorId: string, id: string, metaId: string): Promise<void> {
    await queryRows(SET_META_ID_SQL, [creatorId, id, metaId]);
}

/**
 * Adopt the Meta id of every audience whose `audience_create` op is done (A2's queue records Meta's answer, or the id its tag search
 * found, in `result.id`). Cheap and idempotent: run before a list is shown and before a sync folds Meta's reads in.
 */
export const ADOPT_META_IDS_SQL = `
UPDATE ads_audiences a
   SET meta_id = o.result->>'id'
  FROM ads_ops o
 WHERE a.creator_id = $1 AND a.meta_id IS NULL AND a.status <> 'deleted'
   AND o.creator_id = a.creator_id AND o.object_key = 'audience:' || a.id::text
   AND o.kind = 'audience_create' AND o.state = 'done' AND o.result->>'id' ~ '^[0-9]+$'`;

export async function adoptCreatedMetaIds(creatorId: string): Promise<void> {
    await queryRows(ADOPT_META_IDS_SQL, [creatorId]);
}

/**
 * Fold Meta's read of the ad account's audiences into the mirror. A read belongs to the row with the same Meta id (adopted from the
 * create op first). Audiences made outside the app match nothing and are ignored. Returns how many rows were updated.
 */
export async function applyAudienceReads(creatorId: string, reads: readonly unknown[]): Promise<number> {
    await adoptCreatedMetaIds(creatorId);
    if (reads.length === 0) return 0;
    const rows = await queryRows<AudienceRow>(SYNCABLE_AUDIENCES_SQL, [creatorId]);
    const byMeta = new Map(rows.filter((r) => r.meta_id !== null).map((r) => [r.meta_id as string, r]));
    let updated = 0;
    for (const raw of reads) {
        if (!isRecord(raw) || (typeof raw['id'] !== 'string' && typeof raw['id'] !== 'number')) continue;
        const metaId = String(raw['id']);
        const target = byMeta.get(metaId);
        if (!target) continue;
        const { status, sizeLower, sizeUpper } = classifyAudienceRead(raw);
        const done = await queryRows(`${APPLY_READ_SQL} RETURNING id`, [creatorId, target.id, metaId, status, sizeLower, sizeUpper]);
        updated += done.length;
    }
    return updated;
}

/** Whether the tenant has any audience the sync should read (saves Meta a call for the many tenants with none). */
export async function hasLiveAudiences(creatorId: string): Promise<boolean> {
    const rows = await queryRows(`SELECT 1 FROM ads_audiences WHERE creator_id = $1 AND status <> 'deleted' LIMIT 1`, [creatorId]);
    return rows.length > 0;
}

/** The fields the sync reads on `act_<id>/customaudiences` (contracts/meta-graph.md "Audiences"). */
export const AUDIENCE_READ_FIELDS = 'id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status';

/**
 * The `custom_audiences` / `excluded_custom_audiences` of an ad set's targeting, from the dashboard's audience ids. An INCLUDED audience
 * must be usable (ready, with a Meta id); an EXCLUDED one needs only a Meta id (excluding a small audience is harmless). Ids of other
 * tenants and ids that are not uuids are NOT_FOUND. Both keys are always present, possibly empty.
 */
export async function targetingAudiences(
    creatorId: string,
    includeIds: readonly string[],
    excludeIds: readonly string[]
): Promise<{ custom_audiences: Array<{ id: string }>; excluded_custom_audiences: Array<{ id: string }> }> {
    const include = [...new Set(includeIds)];
    const exclude = [...new Set(excludeIds)];
    const overlap = include.find((id) => exclude.includes(id));
    if (overlap !== undefined) throw invalid('excludeAudiences', 'The same audience cannot be both included and excluded.', 'both');
    const all = [...include, ...exclude];
    if (all.length === 0) return { custom_audiences: [], excluded_custom_audiences: [] };
    if (!all.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) throw new AudienceError('NOT_FOUND', 'No such audience.');

    const rows = await queryRows<AudienceRow>(GET_AUDIENCES_SQL, [creatorId, all]);
    const byId = new Map(rows.filter((r) => r.creator_id === creatorId).map((r) => [r.id.toLowerCase(), r]));
    const find = (id: string): AudienceRow => {
        const found = byId.get(id.toLowerCase());
        if (!found) throw new AudienceError('NOT_FOUND', 'No such audience.');
        return found;
    };

    const custom_audiences = include.map((id) => {
        const found = find(id);
        const { usable, unusableReason } = usability(found);
        if (!usable || found.meta_id === null) {
            throw new AudienceError('AUDIENCE_NOT_USABLE', 'This audience cannot be used yet.', { field: 'includeAudiences', reason: unusableReason ?? 'creating' });
        }
        return { id: found.meta_id };
    });
    const excluded_custom_audiences = exclude.map((id) => {
        const found = find(id);
        if (found.meta_id === null || found.status === 'deleted') {
            throw new AudienceError('AUDIENCE_NOT_USABLE', 'This audience cannot be excluded yet.', { field: 'excludeAudiences', reason: found.status === 'deleted' ? 'deleted' : 'creating' });
        }
        return { id: found.meta_id };
    });
    return { custom_audiences, excluded_custom_audiences };
}

/**
 * The builder's audience ids, as Meta ids (A5 sends what the picker holds: our `ads_audiences` ids). A uuid is looked up and must be the
 * tenant's and usable (`targetingAudiences`); a numeric id is an audience made in Meta Ads Manager and is passed on as it is. Returns a
 * copy of `adsets` with the ids replaced; AudienceError names the ad set's field.
 */
export async function resolveSpecAudiences<T extends { targeting: { includeAudiences?: string[]; excludeAudiences?: string[] } }>(
    creatorId: string, adsets: readonly T[],
): Promise<T[]> {
    const out: T[] = [];
    for (const [i, adset] of adsets.entries()) {
        const include = adset.targeting.includeAudiences ?? [];
        const exclude = adset.targeting.excludeAudiences ?? [];
        if (include.length === 0 && exclude.length === 0) { out.push(adset); continue; }
        const ours = (ids: string[]) => ids.filter((id) => UUID_PATTERN.test(id));
        const theirs = (ids: string[]) => ids.filter((id) => !UUID_PATTERN.test(id));
        let mapped;
        try {
            mapped = await targetingAudiences(creatorId, ours(include), ours(exclude));
        } catch (err) {
            if (err instanceof AudienceError) {
                throw new AudienceError(err.code, err.message, { field: `adsets.${i}.targeting.${err.field ?? 'includeAudiences'}`, ...(err.reason ? { reason: err.reason } : {}) });
            }
            throw err;
        }
        out.push({
            ...adset,
            targeting: {
                ...adset.targeting,
                includeAudiences: [...mapped.custom_audiences.map((a) => a.id), ...theirs(include)],
                excludeAudiences: [...mapped.excluded_custom_audiences.map((a) => a.id), ...theirs(exclude)],
            },
        });
    }
    return out;
}
