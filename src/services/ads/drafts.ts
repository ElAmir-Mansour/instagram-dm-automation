/**
 * Drafts: the builder's two server steps (Meta Ads Manager A4; contracts/dashboard-api.md "The builder").
 *
 *   validateDraft   POST /api/ads/drafts/validate. Creates NOTHING. Checks the spec (spec.ts `validateSpec` + `mapSpec`), the copy (policy.ts,
 *                   on the post's caption as STORED, never as the browser says it), the money rule (money.ts `moneyFor`, the same rule as
 *                   GET /money), Meta's minimum budget, Meta's own `validate_only` on the campaign and on every creative, and whether the
 *                   assistant behind each message destination will answer the people the ad brings.
 *   createDraft     POST /api/ads/drafts. Re-runs every check above except Meta's, refuses POLICY_BLOCKED (and unread warnings), then in
 *                   ONE transaction writes the stored copy (`ads_objects`, origin 'app' or 'boost', status PAUSED) and the chain of create
 *                   ops: campaign → ad set(s) → creative → ad → (next creative → ad …). Each op waits for the one before it (`dependsOn`),
 *                   and names the ids it needs from earlier ops with `{op:<id>}` placeholders that ops.ts fills when it runs. After the
 *                   commit the chain is run inline under `waitUntil`; whatever is left the drain finishes.
 *
 * EVERY object is created PAUSED (spec.ts). Nothing here can start spending: Activate is the Campaigns tab's confirmed status op, which runs
 * the money rule again. A refusal is an `AdsError` (adBoosts.ts), answered by the route as `{ error, code, field?, findings? }`.
 *
 * Never a Graph call inside a transaction: the facts and Meta's checks are read first, the transaction only writes rows.
 */
import { randomUUID } from 'node:crypto';
import { queryOne } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { waitUntil } from '../../utils/waitUntil.js';
import { AdsError } from '../adBoosts.js';
import { loadAssistantState, type AssistantState } from '../inboxAssistant.js';
import { mintAdLink } from '../links.js';
import { getPublicBaseUrl } from '../appSettings.js';
import { loadProfile } from '../profile/store.js';
import { publishedPlatforms } from '../publishedIds.js';
import { getTenant } from '../tenant.js';
import { getConnection } from '../whatsappConnections.js';
import { readWhatsAppSettings } from '../whatsappAgent.js';
import { withTransaction, type Exec } from '../studio/common.js';
import { adsGet, adsPost, AdsGraphError, type GraphParams } from './graph.js';
import { fetchAccountState, fromMinorUnits, resolveFacebookStoryId } from './metaAds.js';
import { moneyFor, parseCandidate, type MoneyAnswer } from './money.js';
import { enqueue, runOpInline, type OpActor, type OpView } from './ops.js';
import { checkPolicy, POLICY_VERSION, type PolicyFinding, type PolicyResult } from './policy.js';
import { readAdsSettings, readHealth } from './settings.js';
import { resolveSpecMedia } from './adMedia.js';
import { generatePreviews, type PreviewPlacement, type PreviewResult } from './creatives.js';
import { adsGraph } from './graphPort.js';
import { reachEstimate } from './targetingSearch.js';
import {
    adParams, adsetParams, mapSpec, SpecError, validateSpec, type CampaignSpec, type MessageDestination, type SpecContext, type SpecPayloads,
    type SpecProblem,
} from './spec.js';

// ─── What a destination's assistant will do with the people an ad brings ───────────────────

/**
 *   on             it answers everyone
 *   off            it is switched off: messages arrive and nobody answers
 *   test           WhatsApp's agent answers only the test senders
 *   sales_test     the DM assistant answers everyone, but sells only to the test senders (sales mode "test")
 *   not_connected  the account behind the destination is not connected, so its messages never reach the assistant
 */
export type BotState = 'on' | 'off' | 'test' | 'sales_test' | 'not_connected';

export interface BotFacts {
    /** The DM assistant (Instagram and Messenger). Null when it could not be read: then "on" is not claimed, "off" is not either. */
    assistant: AssistantState | null;
    igConnected: boolean;
    fbConnected: boolean;
    whatsapp: { connected: boolean; mode: 'off' | 'test' | 'everyone' | null };
}

/** One line per chosen destination. Pure. An assistant that could not be read is reported as `on` (no warning on a guess). */
export function botStates(destinations: readonly MessageDestination[], f: BotFacts): Array<{ destination: MessageDestination; state: BotState }> {
    return destinations.map((destination) => {
        if (destination === 'whatsapp') {
            if (!f.whatsapp.connected) return { destination, state: 'not_connected' as const };
            const mode = f.whatsapp.mode;
            return { destination, state: mode === 'everyone' ? 'on' as const : mode === 'test' ? 'test' as const : 'off' as const };
        }
        if (destination === 'instagram' ? !f.igConnected : !f.fbConnected) return { destination, state: 'not_connected' as const };
        const a = f.assistant;
        if (!a) return { destination, state: 'on' as const };
        if (!a.configured || !a.is_active) return { destination, state: 'off' as const };
        return { destination, state: a.sales_mode === 'test' ? 'sales_test' as const : 'on' as const };
    });
}

// ─── The texts the policy check reads ──────────────────────────────────────────────────────

/**
 * Field name → text, for every piece of copy Meta will show: an ad built on a post shows the post's CAPTION (the server's copy, read from
 * the database), any other ad its primary text and headline; a message ad also its greeting and ice breakers. With one ad the names are the
 * quick mode's own ('caption', 'greeting', 'iceBreakers.0.title'); with several they carry the ad (`ads.1.message.greeting`). Pure.
 */
export function policyFieldsOf(spec: CampaignSpec, captions: Record<string, string>): Record<string, string> {
    const fields: Record<string, string> = {};
    const one = spec.ads.length === 1;
    spec.ads.forEach((ad, i) => {
        const at = (name: string, group: 'copy' | 'message') => (one ? name : `ads.${i}.${group}.${name}`);
        if (ad.creative.source === 'post') {
            const caption = captions[ad.creative.postId];
            if (caption) fields[one ? 'caption' : `ads.${i}.copy.caption`] = caption;
        } else {
            if (ad.copy.primaryText) fields[at('primaryText', 'copy')] = ad.copy.primaryText;
            if (ad.copy.headline) fields[at('headline', 'copy')] = ad.copy.headline;
        }
        if (spec.goal === 'messages' && ad.message) {
            if (ad.message.greeting) fields[at('greeting', 'message')] = ad.message.greeting;
            ad.message.iceBreakers.forEach((b, j) => {
                if (b.title) fields[at(`iceBreakers.${j}.title`, 'message')] = b.title;
                if (b.response) fields[at(`iceBreakers.${j}.response`, 'message')] = b.response;
            });
        }
    });
    return fields;
}

/** The candidate the money rule weighs: the whole budget, every ad set's when the ad set holds it. Pure. */
export function candidateOf(spec: CampaignSpec): string | null {
    const days = spec.budget.end ? Math.max(1, Math.ceil((Date.parse(spec.budget.end) - Date.parse(spec.budget.start)) / 86_400_000)) : null;
    const total = spec.budget.home === 'adset' ? spec.budget.amount * spec.adsets.length : spec.budget.amount;
    const amount = Math.round(total * 100) / 100;
    if (spec.budget.kind === 'lifetime') return days ? `lifetime:${amount}:${days}` : null;
    return days ? `daily:${amount}:${days}` : `daily:${amount}`;
}

/** What one day of the budget is, for Meta's minimum: the daily amount, or a lifetime total spread over its days. Pure. */
export function perDayOf(spec: CampaignSpec): number {
    if (spec.budget.kind === 'daily') return spec.budget.amount;
    const days = spec.budget.end ? Math.max(1, Math.ceil((Date.parse(spec.budget.end) - Date.parse(spec.budget.start)) / 86_400_000)) : 1;
    return Math.round((spec.budget.amount / days) * 100) / 100;
}

// ─── Facts the server resolves before mapping ──────────────────────────────────────────────

interface DraftFacts {
    adAccountId: string;
    token: string;
    currency: string;
    minDailyBudget: number | null;
    pageId: string | null;
    igUserId: string | null;
    whatsappPhone: string | null;
    posts: SpecContext['posts'];
    /** A5 uploads: the hash or video id Meta gave each one, and the video covers. */
    media: NonNullable<SpecContext['media']>;
    /** Why an upload cannot be used yet (not handed to Meta, a video still processing): a problem in Review, a refusal at create. */
    mediaRefusal: AdsError | null;
    captions: Record<string, string>;
    bots: BotFacts;
    limits: { adAccountId: string; monthlyCap: number; maxDailyBudget: number } | null;
}

const refused = (status: number, code: string, message: string, field?: string): AdsError =>
    new AdsError(status, code as ConstructorParameters<typeof AdsError>[1], message, field);

async function readFacts(creatorId: string, spec: CampaignSpec): Promise<DraftFacts> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!token || !settings.adAccountId) throw refused(409, 'ADS_NOT_CONFIGURED', 'Connect the ad account and the token in Settings first.');
    const health = await readHealth(creatorId);
    // The stored account first (A1's daily check); a live read only when there is none yet (1 point).
    const account = health.account ?? await fetchAccountState(settings.adAccountId, token);
    const tenant = await getTenant(creatorId, ['id', 'instagram_page_id', 'facebook_page_id']);

    const posts: SpecContext['posts'] = {};
    const captions: Record<string, string> = {};
    for (const ad of spec.ads) {
        if (ad.creative.source !== 'post' || posts[ad.creative.postId]) continue;
        const id = ad.creative.postId;
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw refused(404, 'POST_NOT_FOUND', 'No such post.', 'ads.0.creative.postId');
        const row = await queryOne<{ status: string; published_post_id: string | null; caption: string | null }>(
            'SELECT status, published_post_id, caption FROM scheduled_posts WHERE id = $1 AND creator_id = $2', [id, creatorId],
        );
        if (!row) throw refused(404, 'POST_NOT_FOUND', 'No such post.', 'ads.0.creative.postId');
        const ids = publishedPlatforms(row.published_post_id);
        const stored = ad.creative.platform === 'instagram' ? ids.ig : ids.fb;
        if (row.status !== 'PUBLISHED' || !stored) {
            throw refused(409, 'POST_NOT_PUBLISHED', `This post has no published ${ad.creative.platform === 'instagram' ? 'Instagram' : 'Facebook'} copy.`, 'platform');
        }
        const mediaId = ad.creative.platform === 'instagram' || !tenant?.facebook_page_id ? stored : await resolveFacebookStoryId(tenant.facebook_page_id, stored, token);
        posts[id] = { platform: ad.creative.platform, mediaId };
        captions[id] = row.caption ?? '';
    }

    let media: DraftFacts['media'] = {};
    let mediaRefusal: AdsError | null = null;
    try {
        media = await resolveSpecMedia({ tenantId: creatorId, adAccountId: settings.adAccountId, token }, spec);
    } catch (err) {
        if (!(err instanceof AdsError)) throw err;
        mediaRefusal = err;
    }

    const [assistant, wa, waSettings] = await Promise.all([
        loadAssistantState(creatorId),
        getConnection(creatorId).catch(() => null),
        readWhatsAppSettings(creatorId).catch(() => null),
    ]);
    const waConnected = !!wa && wa.status === 'active';
    const digits = waConnected ? String(wa.profile.display_phone_number ?? '').replace(/\D/g, '') : '';

    return {
        adAccountId: settings.adAccountId, token, currency: account.currency, minDailyBudget: account.minDailyBudget ?? null,
        pageId: tenant?.facebook_page_id ?? null, igUserId: tenant?.instagram_page_id ?? null,
        whatsappPhone: digits.length >= 8 ? digits : null,
        posts, media, mediaRefusal, captions,
        bots: { assistant, igConnected: !!tenant?.instagram_page_id, fbConnected: !!tenant?.facebook_page_id, whatsapp: { connected: waConnected, mode: waSettings?.mode ?? null } },
        limits: settings.monthlyCap && settings.maxDailyBudget ? { adAccountId: settings.adAccountId, monthlyCap: settings.monthlyCap, maxDailyBudget: settings.maxDailyBudget } : null,
    };
}

function contextOf(f: DraftFacts, extra: { refShort: string; links?: Record<string, string> }): SpecContext {
    if (!f.pageId) throw new SpecError('UNSUPPORTED', 'destinations', 'Connect the Facebook Page first: every ad runs under the Page.');
    return {
        adAccountId: f.adAccountId, currency: f.currency, pageId: f.pageId, igUserId: f.igUserId, whatsappPhone: f.whatsappPhone,
        opTag: '', refShort: extra.refShort, now: new Date(), posts: f.posts, media: f.media, links: extra.links ?? {},
    };
}

// ─── Meta's minimum budget (cached a day per account) ─────────────────────────────────────

const MINIMUM_TTL_MS = 24 * 3600 * 1000;
const minimums = new Map<string, { at: number; value: number | null }>();

/** Tests only. */
export function forgetMinimums(): void { minimums.clear(); }

/**
 * Meta's minimum DAILY budget for an impressions-billed ad set, in major units: `GET act_<id>/minimum_budgets`, read at most once a day per
 * account (1 point), and the account's own `min_daily_budget` (A1's stored copy) when that read says nothing. LIVE-CHECK: the field names
 * of `minimum_budgets` are read defensively; the account's figure is the floor either way.
 */
export async function minimumDailyBudget(f: Pick<DraftFacts, 'adAccountId' | 'token' | 'currency' | 'minDailyBudget'>, now = Date.now()): Promise<number | null> {
    const cached = minimums.get(f.adAccountId);
    if (cached && now - cached.at < MINIMUM_TTL_MS) return cached.value ?? f.minDailyBudget;
    let value: number | null = null;
    try {
        const res = await adsGet(`act_${f.adAccountId}/minimum_budgets`, {}, f.token, { label: 'ads.minimum_budgets' });
        const rows: any[] = Array.isArray(res.data?.data) ? res.data.data : [];
        const row = rows.find((r) => r && String(r.currency ?? '').toUpperCase() === f.currency.toUpperCase()) ?? rows[0];
        const minor = Number(row?.min_daily_budget_imp ?? row?.min_daily_budget_low_freq ?? row?.min_daily_budget);
        value = Number.isFinite(minor) && minor > 0 ? fromMinorUnits(minor, f.currency) : null;
    } catch (err) {
        if (err instanceof AdsGraphError && err.klass === 'throttle') throw err;
        log('warn', 'ads.minimum_budgets_unreadable', { ad_account_id: f.adAccountId, ...describeError(err) });
    }
    minimums.set(f.adAccountId, { at: now, value });
    return value ?? f.minDailyBudget;
}

// ─── Meta's own check ──────────────────────────────────────────────────────────────────────

export interface MetaCheck {
    ok: boolean;
    error?: string;
    metaCode?: number | null;
    metaSubcode?: number | null;
    object?: string;
    minimumBudget: number | null;
}

/**
 * Meta's own explanation of a refusal, for the Review: the short `message` plus `error_user_title` / `error_user_msg` when Meta sent them
 * (a bare "Invalid parameter" says nothing without them; live check 2026-10-22). Text Meta wrote for the advertiser: never a token.
 */
export function metaRefusalText(err: unknown): { text: string; code: number | null; subcode: number | null } {
    const e = (err && typeof err === 'object' ? (err as { cause?: any }).cause?.response?.data?.error : null) ?? null;
    const base = err instanceof Error ? err.message : 'Meta refused it.';
    const title = typeof e?.error_user_title === 'string' ? e.error_user_title.trim() : '';
    const msg = typeof e?.error_user_msg === 'string' ? e.error_user_msg.trim() : '';
    const extra = [title, msg].filter(Boolean).join(': ');
    return {
        text: (extra ? `${base} — ${extra}` : base).slice(0, 700),
        code: typeof e?.code === 'number' ? e.code : err instanceof AdsGraphError ? err.metaCode ?? null : null,
        subcode: typeof e?.error_subcode === 'number' ? e.error_subcode : null,
    };
}

/**
 * `execution_options=['validate_only']` on the campaign and on every creative: Meta checks them and creates nothing (3 points each). An ad
 * set and an ad cannot be validated alone (they need the ids of their parents), so the creative is where the message-ad mapping is proved:
 * the CTA, the greeting, the opt-outs, a Facebook post with a Messenger button (T094). A throttle is thrown (the route says RATE_LIMITED);
 * any other refusal is Meta's message, shown in Review.
 */
async function metaValidate(f: DraftFacts, p: SpecPayloads): Promise<Omit<MetaCheck, 'minimumBudget'>> {
    const calls: Array<{ edge: string; params: GraphParams; object: string }> = [
        { edge: 'campaigns', params: p.campaign, object: 'campaign' },
        ...p.creatives.map((c, i) => ({ edge: 'adcreatives', params: c, object: `ads.${i}.creative` })),
    ];
    for (const c of calls) {
        try {
            await adsPost(`act_${f.adAccountId}/${c.edge}`, { ...c.params, execution_options: ['validate_only'] }, f.token, { label: `ads.validate.${c.edge}` });
        } catch (err) {
            if (err instanceof AdsGraphError && (err.klass === 'throttle' || err.klass === 'token_dead')) throw err;
            const r = metaRefusalText(err);
            log('warn', 'ads.validate_refused', { ad_account_id: f.adAccountId, object: c.object, edge: c.edge, meta_code: r.code, meta_subcode: r.subcode, error: r.text });
            return { ok: false, error: r.text, metaCode: r.code, metaSubcode: r.subcode, object: c.object };
        }
    }
    return { ok: true };
}

// ─── Validate ─────────────────────────────────────────────────────────────────────────────

export interface DraftValidation {
    /** Meta's reach estimate for the first ad set's targeting, or null when Meta cannot say (A5). */
    estimate: { lower: number; upper: number } | null;
    /** Meta's render of the first ad per placement; `html: null` means the dashboard draws its approximate preview (A5). */
    previews: PreviewResult[];
    policy: PolicyResult;
    money: (MoneyAnswer & { candidate: string | null }) | null;
    meta: MetaCheck | null;
    problems: SpecProblem[];
    warnings: SpecPayloads['warnings'];
    bots: Array<{ destination: MessageDestination; state: BotState }>;
}

const EMPTY_POLICY: PolicyResult = { version: POLICY_VERSION, blocked: false, findings: [] };

export async function validateDraft(creatorId: string, input: unknown): Promise<DraftValidation> {
    const checked = validateSpec(input);
    if (!checked.ok) return { estimate: null, previews: [], policy: EMPTY_POLICY, money: null, meta: null, problems: checked.problems, warnings: [], bots: [] };
    const spec = checked.spec;
    const facts = await readFacts(creatorId, spec);
    const policy = checkPolicy(policyFieldsOf(spec, facts.captions));
    const bots = spec.goal === 'messages' ? botStates(spec.destinations ?? [], facts.bots) : [];

    let payloads: SpecPayloads | null = null;
    const problems: SpecProblem[] = [];
    if (facts.mediaRefusal) problems.push({ field: facts.mediaRefusal.field ?? 'ads.0.creative', code: 'INVALID', message: facts.mediaRefusal.message });
    else try {
        // A tracked offer link is only minted at create; here a placeholder of the same shape stands in so the creative can be checked.
        const links = Object.fromEntries(spec.ads.flatMap((a) => (a.link && 'trackedOfferId' in a.link ? [[a.link.trackedOfferId, 'https://example.com/r/AAAAAAAAAA']] : [])));
        payloads = mapSpec(spec, contextOf(facts, { refShort: 'validate', links }));
    } catch (err) {
        if (!(err instanceof SpecError)) throw err;
        problems.push({ field: err.field, code: err.code, message: err.message });
    }

    const candidate = candidateOf(spec);
    const parsed = candidate ? parseCandidate(candidate) : null;
    const money = { ...(await moneyFor(creatorId, facts.limits, facts.token, parsed)), candidate };
    const minimumBudget = await minimumDailyBudget(facts);
    if (minimumBudget !== null && perDayOf(spec) < minimumBudget) {
        problems.push({ field: 'budget.amount', code: 'INVALID', message: `Meta's minimum is ${minimumBudget} ${facts.currency} a day for this ad account.` });
    }

    // Meta is asked only about a draft that could be created: no point spending points on one that is refused here anyway.
    let meta: MetaCheck = { ok: false, error: undefined, minimumBudget };
    if (payloads && !policy.blocked && problems.length === 0) meta = { ...(await metaValidate(facts, payloads)), minimumBudget };
    else meta = { ok: false, error: 'Not sent to Meta: fix what is listed first.', minimumBudget };

    // A5: what Meta says about reach, and how the first ad looks. Both are hints that never block (and never throw); 1 point each.
    let estimate: DraftValidation['estimate'] = null;
    let previews: PreviewResult[] = [];
    if (payloads) {
        const call = { tenantId: creatorId, adAccountId: facts.adAccountId, token: facts.token };
        const graph = adsGraph(call);
        estimate = await reachEstimate(call, graph, payloads.adsets[0]!['targeting'] as object);
        if (meta.ok) previews = await generatePreviews(call, graph, payloads.creatives[0]!, previewPlacements(spec.adsets[0]!.placements));
    }
    return { estimate, previews, policy, money, meta, problems, warnings: payloads?.warnings ?? [], bots };
}

/**
 * The two placements previewed (Meta charges a point each): the feed and the vertical frame the owner chose, or, with automatic
 * placements, Instagram's feed and Reels (the account's main surface; quickstart §A5 asks for at least Feed and Reels).
 */
export function previewPlacements(placements: CampaignSpec['adsets'][number]['placements']): PreviewPlacement[] {
    if (placements === 'automatic') return ['instagram_feed', 'instagram_reels'];
    const ig = placements.instagram ?? [];
    const fb = placements.facebook ?? [];
    const feed: PreviewPlacement | null = ig.includes('stream') ? 'instagram_feed' : fb.includes('feed') ? 'feed' : null;
    const vertical: PreviewPlacement | null = ig.includes('reels') ? 'instagram_reels' : fb.includes('facebook_reels') ? 'facebook_reels'
        : ig.includes('story') ? 'instagram_story' : null;
    const out = [feed, vertical].filter((p): p is PreviewPlacement => p !== null);
    return out.length > 0 ? out : ['instagram_feed'];
}

// ─── Create ───────────────────────────────────────────────────────────────────────────────

/** A refusal that carries the policy findings, so the dialog can draw them again. */
export class DraftRefused extends AdsError {
    constructor(status: number, code: string, message: string, readonly findings: PolicyFinding[]) {
        super(status, code as ConstructorParameters<typeof AdsError>[1], message);
        this.name = 'DraftRefused';
    }
}

export interface CreatedDraft { campaignId: string; ops: OpView[] }

const MONEY_CODES: Record<string, { status: number; message: string }> = {
    OVER_MONTHLY_CAP: { status: 409, message: 'This budget is more than what is left of your monthly cap.' },
    OVER_DAILY_MAX: { status: 409, message: 'The daily budget is over your max daily budget.' },
    NOT_CONFIGURED: { status: 409, message: 'Set a max daily budget and a monthly cap in Settings first.' },
};

/** The `ads_objects` row of one object to be created. */
async function insertObject(tx: Exec, row: {
    creatorId: string; adAccountId: string; level: 'campaign' | 'adset' | 'ad' | 'creative'; parentId: string | null; name: string; origin: 'app' | 'boost';
    objective?: string | null; destinationType?: string | null; optimizationGoal?: string | null; budgetKind?: 'daily' | 'lifetime' | 'none'; budgetAmount?: number | null;
    currency: string; start?: string | null; end?: string | null; appMeta: Record<string, unknown>;
}): Promise<string> {
    const res = await tx.query<{ id: string }>(
        `INSERT INTO ads_objects (creator_id, ad_account_id, level, parent_id, name, origin, status, objective, destination_type, optimization_goal,
                                  budget_kind, budget_amount, currency, start_time, end_time, app_meta)
         VALUES ($1, $2, $3, $4, $5, $6, 'PAUSED', $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb) RETURNING id`,
        [row.creatorId, row.adAccountId, row.level, row.parentId, row.name, row.origin, row.objective ?? null, row.destinationType ?? null,
            row.optimizationGoal ?? null, row.budgetKind ?? 'none', row.budgetAmount ?? null, row.currency, row.start ?? null, row.end ?? null, JSON.stringify(row.appMeta)],
    );
    return res.rows[0]!.id;
}

/** The offer's own address, for a tracked link: the tenant's profile is where offers live. */
async function offerUrl(creatorId: string, offerId: string): Promise<string> {
    const { profile } = await loadProfile(creatorId);
    const offer = profile.offers.find((o) => o.id === offerId);
    if (!offer || !offer.url) throw refused(400, 'INVALID', 'That offer has no address to link to.', 'ads.0.link.trackedOfferId');
    return offer.url;
}

/** Run the chain one op after another, under `waitUntil`: the drain finishes whatever this does not reach. Never throws. */
function runChainInline(creatorId: string, opIds: string[]): void {
    waitUntil((async () => {
        for (const id of opIds) {
            try { await runOpInline(id, { creatorId }); } catch (err) { log('warn', 'ads.draft_inline_failed', { op_id: id, ...describeError(err) }); return; }
        }
    })());
}

export async function createDraft(
    creatorId: string, input: unknown, opts: { confirmPolicyWarnings: boolean; actor: OpActor; origin?: 'app' | 'boost' },
): Promise<CreatedDraft> {
    const checked = validateSpec(input);
    if (!checked.ok) { const p = checked.problems[0]!; throw refused(400, p.code === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'INVALID', p.message, p.field); }
    const spec = checked.spec;
    const facts = await readFacts(creatorId, spec);
    if (facts.mediaRefusal) throw facts.mediaRefusal;

    // The copy, on the server, before anything is written (T091): a block is refused whatever the browser said.
    const policy = checkPolicy(policyFieldsOf(spec, facts.captions));
    if (policy.blocked) throw new DraftRefused(422, 'POLICY_BLOCKED', 'Meta would reject this text. Change the highlighted words first.', policy.findings);
    if (policy.findings.length && !opts.confirmPolicyWarnings) {
        throw new DraftRefused(409, 'POLICY_WARNINGS', 'Read the warnings about the text, then confirm them.', policy.findings);
    }

    // The money rule: a PAUSED draft spends nothing, but one that could never be switched on is refused now rather than at Activate.
    const candidate = candidateOf(spec);
    const money = await moneyFor(creatorId, facts.limits, facts.token, candidate ? parseCandidate(candidate) : null);
    if (money.reason && MONEY_CODES[money.reason]) {
        const m = MONEY_CODES[money.reason]!;
        throw refused(m.status, money.reason === 'NOT_CONFIGURED' ? 'ADS_NOT_CONFIGURED' : money.reason, m.message, 'amount');
    }
    const minimum = await minimumDailyBudget(facts);
    if (minimum !== null && perDayOf(spec) < minimum) throw refused(400, 'BELOW_META_MINIMUM', `Meta's minimum is ${minimum} ${facts.currency} a day for this ad account.`, 'amount');

    // A first mapping proves the spec maps (no WhatsApp number, no Instagram account …) before any row is written.
    try { mapSpec(spec, contextOf(facts, { refShort: 'check', links: placeholderLinks(spec) })); } catch (err) {
        if (err instanceof SpecError) throw refused(400, err.code, err.message, err.field);
        throw err;
    }

    const origin = opts.origin ?? 'app';
    const draftKey = randomUUID();
    const base = await getPublicBaseUrl(null);
    const result = await withTransaction(async (tx) => {
        const goal = spec.goal;
        // The stored copy first: each op's object key is its row, so the queue writes the Meta id onto it when the create lands.
        const campaignId = await insertObject(tx, {
            creatorId, adAccountId: facts.adAccountId, level: 'campaign', parentId: null, name: spec.name, origin, currency: facts.currency,
            budgetKind: spec.budget.home === 'campaign' ? spec.budget.kind : 'none', budgetAmount: spec.budget.home === 'campaign' ? spec.budget.amount : null,
            start: spec.budget.start, end: spec.budget.end ?? null,
            appMeta: { draftKey, policyVersion: POLICY_VERSION, goal, ...(spec.destinations ? { destinations: spec.destinations } : {}) },
        });
        const refShort = campaignId.replace(/-/g, '').slice(0, 12);
        const adsetIds: string[] = [];
        for (const a of spec.adsets) {
            adsetIds.push(await insertObject(tx, {
                creatorId, adAccountId: facts.adAccountId, level: 'adset', parentId: campaignId, name: a.name, origin, currency: facts.currency,
                budgetKind: spec.budget.home === 'adset' ? spec.budget.kind : 'none', budgetAmount: spec.budget.home === 'adset' ? spec.budget.amount : null,
                start: spec.budget.start, end: spec.budget.end ?? null, appMeta: { draftKey },
            }));
        }
        const adIds: string[] = [];
        const creativeIds: string[] = [];
        for (const ad of spec.ads) {
            const meta: Record<string, unknown> = { draftKey, refShort };
            if (ad.creative.source === 'post') { meta['postId'] = ad.creative.postId; meta['platform'] = ad.creative.platform; }
            if (ad.offerId) meta['offerId'] = ad.offerId;
            if (ad.message) { meta['greeting'] = ad.message.greeting; meta['iceBreakers'] = ad.message.iceBreakers; }
            if (ad.link && 'trackedOfferId' in ad.link) meta['offerId'] = ad.link.trackedOfferId;
            const adId = await insertObject(tx, {
                creatorId, adAccountId: facts.adAccountId, level: 'ad', parentId: adsetIds[ad.adsetIndex]!, name: ad.name, origin, currency: facts.currency, appMeta: meta,
            });
            adIds.push(adId);
            creativeIds.push(await insertObject(tx, {
                creatorId, adAccountId: facts.adAccountId, level: 'creative', parentId: adId, name: ad.name, origin, currency: facts.currency, appMeta: { draftKey },
            }));
        }

        // Tracked links: one per (ad, offer), made now so the creative names `<public base>/r/<code>` (research R25).
        const links: Record<string, string> = {};
        for (const [i, ad] of spec.ads.entries()) {
            if (!ad.link || !('trackedOfferId' in ad.link)) continue;
            if (!base) throw refused(409, 'INVALID', 'Set the public address of the app first: tracked links need it.', `ads.${i}.link`);
            // In the draft's transaction: the ad's row exists only there until the commit, and the link's foreign key names it.
            const code = await mintAdLink({ creatorId, offerId: ad.link.trackedOfferId, adsObjectId: adIds[i]!, targetUrl: await offerUrl(creatorId, ad.link.trackedOfferId) }, tx);
            links[ad.link.trackedOfferId] = `${base}/r/${code}`;
        }

        const payloads = mapSpec(spec, contextOf(facts, { refShort, links }));
        const act = `act_${facts.adAccountId}`;
        const ops: OpView[] = [];
        const step = async (objectKey: string, edge: 'campaigns' | 'adsets' | 'adcreatives' | 'ads', level: 'campaign' | 'adset' | 'creative' | 'ad', params: GraphParams, n: number) => {
            const view = await enqueue({
                creatorId, adAccountId: act, objectKey, kind: 'create', idempotencyKey: `draft:${draftKey}:${n}`, dependsOn: ops.length ? ops[ops.length - 1]!.id : null,
                payload: { exec: { method: 'POST', path: `${act}/${edge}`, edge, level, params } }, actor: opts.actor,
            }, tx);
            ops.push(view);
            return view.id;
        };
        let n = 0;
        const campaignOp = await step(campaignId, 'campaigns', 'campaign', payloads.campaign, n++);
        const adsetOps: string[] = [];
        for (let i = 0; i < spec.adsets.length; i++) adsetOps.push(await step(adsetIds[i]!, 'adsets', 'adset', adsetParams(payloads, i, `{op:${campaignOp}}`), n++));
        for (let i = 0; i < spec.ads.length; i++) {
            const creativeOp = await step(creativeIds[i]!, 'adcreatives', 'creative', payloads.creatives[i]!, n++);
            await step(adIds[i]!, 'ads', 'ad', adParams(payloads, i, `{op:${adsetOps[spec.ads[i]!.adsetIndex]!}}`, `{op:${creativeOp}}`), n++);
        }
        return { campaignId, ops };
    });

    runChainInline(creatorId, result.ops.map((o) => o.id));
    log('info', 'ads.draft_created', { creator_id: creatorId, campaign_object: result.campaignId, ops: result.ops.length, goal: spec.goal, origin });
    return result;
}

function placeholderLinks(spec: CampaignSpec): Record<string, string> {
    return Object.fromEntries(spec.ads.flatMap((a) => (a.link && 'trackedOfferId' in a.link ? [[a.link.trackedOfferId, 'https://example.com/r/AAAAAAAAAA']] : [])));
}
