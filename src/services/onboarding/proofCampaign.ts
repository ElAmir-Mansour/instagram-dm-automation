/**
 * The first comment campaign (docs/onboarding/03 §5, plan P25): what `POST /api/onboarding/complete` creates, once, switched OFF.
 *
 * A new tenant finishes the wizard with one campaign already written for their main offer: the keyword, the private message and the
 * public replies the comment card showed them, in the wording they approved (or edited). It is created `is_active = false`, because
 * nothing may message real people until the tenant switches it on, and the tenant sees it in Campaigns like any other.
 *
 * Where its words come from, in order:
 *
 *   1. The comment card's sample, when the TENANT confirmed it (an approval or an edit with `tenant_confirmed_at`): their wording.
 *   2. Otherwise the register's own campaign wording (`kit.importFallback`, which production starts an imported row from), with the
 *      offer's name and link in it. No model, no key: a tenant who skipped W5, or had no AI key, still gets a campaign to review.
 *
 * and it is made only if there is something real to base it on: an offer, a keyword, and a message that can be sent (an offer ordered by
 * "DM me" has no link, so only an approved sample can say how to order). Otherwise there is no campaign and `complete` says why.
 *
 * Pure here (`planFirstCampaign`) so every case is a table in a test; the INSERT is one statement (`FIRST_CAMPAIGN_SQL`) that creates
 * nothing when the tenant already has a campaign on that keyword, and `completeOnboarding` runs it in the same transaction as the
 * status change that only one caller can win, so a double tap, a retry or two tabs cannot make a second one.
 */
import type { Exec } from '../studio/common.js';
import { contextFor } from '../profile/context.js';
import { kitFor } from '../profile/kits.js';
import type { CreatorProfile, MatchMode, Offer } from '../profile/types.js';
import { DM_MAX_BYTES, KEYWORD_MAX_CHARS, matchModeFor, utf8Bytes } from './proofRules.js';
import type { ProofRow } from './proofStore.js';

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A confirmed comment sample, as the campaign reads it. */
export interface ConfirmedComment {
    keyword: string;
    dm: string;
    publicReplies: string[];
}

export interface FirstCampaign {
    trigger_keyword: string;
    dm_template: string;
    /** The replies separated by " | ", which is what the webhook splits on. */
    public_reply_template: string;
    match_mode: MatchMode;
    /** `proof`: the tenant's confirmed sample. `kit`: the register's own wording. */
    source: 'proof' | 'kit';
}

export type FirstCampaignPlan =
    | { ok: true; seed: FirstCampaign }
    | { ok: false; reason: 'no_offer' | 'no_keyword' | 'no_message' };

/** The offer a first campaign is for: the one marked primary, else the first. */
export const primaryOffer = (profile: Pick<CreatorProfile, 'offers'>): Offer | null =>
    profile.offers.find((o) => o.primary) ?? profile.offers[0] ?? null;

/** A keyword as a campaign holds it: the first of a comma list, one short word. '' when it is not one. */
export function cleanKeyword(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const first = raw.split(/[,،]/)[0]!.replace(/\s+/g, ' ').trim();
    return first !== '' && Array.from(first).length <= KEYWORD_MAX_CHARS && !/[\s|{}<>]/.test(first) ? first : '';
}

/**
 * The comment card's row as a campaign reads it, or null when it is not a usable one: not confirmed by the tenant, not approved or edited,
 * or its stored parts are not what `readCommentAnswer` made them. The row is JSONB, so every part is checked.
 */
export function confirmedComment(row: ProofRow | null): ConfirmedComment | null {
    if (!row || row.kind !== 'comment_dm') return null;
    if (row.verdict !== 'approved' && row.verdict !== 'edited') return null;
    if (row.tenant_confirmed_at === null || row.tenant_confirmed_at === undefined) return null;
    const input = isObj(row.input) ? row.input : {};
    const keyword = cleanKeyword(input.keyword);
    const dm = (row.verdict === 'edited' ? row.final_text : row.model_output)?.trim() ?? '';
    const replies = Array.isArray(input.public_replies)
        ? input.public_replies.filter((r): r is string => typeof r === 'string' && r.trim() !== '' && !r.includes('|')).map((r) => r.trim())
        : [];
    if (keyword === '' || dm === '' || utf8Bytes(dm) > DM_MAX_BYTES || replies.length === 0) return null;
    return { keyword, dm, publicReplies: replies };
}

/** A name that goes into a template: no braces, so an offer called `{username}` cannot become a placeholder. */
const templateSafe = (s: string): string => s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

/**
 * The campaign the tenant's profile (and confirmed sample, if any) makes. `profile` is the confirmed profile: its offers, its register
 * (through the comment surface's language) and its own captions, which decide whether the keyword needs whole-word matching.
 */
export function planFirstCampaign(profile: CreatorProfile, sample: ConfirmedComment | null): FirstCampaignPlan {
    const offer = primaryOffer(profile);
    if (!offer) return { ok: false, reason: 'no_offer' };
    const samples = profile.voice.samples;

    if (sample) {
        return {
            ok: true,
            seed: {
                trigger_keyword: sample.keyword, dm_template: sample.dm, public_reply_template: sample.publicReplies.join(' | '),
                match_mode: matchModeFor(sample.keyword, samples), source: 'proof',
            },
        };
    }

    const keyword = cleanKeyword(offer.keyword);
    if (keyword === '') return { ok: false, reason: 'no_keyword' };
    // The register's own message carries the offer's link; an offer with none has nothing to send without somebody writing how to order.
    const url = offer.order_via === 'url' ? offer.url.trim() : '';
    if (url === '') return { ok: false, reason: 'no_message' };
    const lines = kitFor(contextFor(profile, 'comment_reply', null).language).importFallback;
    return {
        ok: true,
        seed: {
            trigger_keyword: keyword,
            dm_template: lines.dm.replace(/\{name\}/g, templateSafe(offer.name)).replace(/\{url\}/g, url),
            public_reply_template: lines.replies,
            match_mode: matchModeFor(keyword, samples),
            source: 'kit',
        },
    };
}

/**
 * One INSERT: the campaign, OFF, on every post, unless this tenant already has a campaign on that keyword. The casts are there because
 * `$1` is used twice and an untyped parameter in a SELECT list is `text`, which a uuid column refuses.
 */
export const FIRST_CAMPAIGN_SQL = `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active, match_mode)
     SELECT $1::uuid, $2::text, $3::text, $4::text, NULL, false, $5::text
      WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE creator_id = $1::uuid AND lower(trigger_keyword) = lower($2::text))
     RETURNING id`;

export interface FirstCampaignOutcome {
    created: boolean;
    id?: string;
    /** Why there is none: the plan's reason, or `exists` (the tenant already has a campaign on that keyword). */
    reason?: 'no_offer' | 'no_keyword' | 'no_message' | 'exists';
    source?: FirstCampaign['source'];
}

export async function insertFirstCampaign(exec: Exec, creatorId: string, seed: FirstCampaign): Promise<FirstCampaignOutcome> {
    const { rows } = await exec.query<{ id: string }>(FIRST_CAMPAIGN_SQL, [
        creatorId, seed.trigger_keyword, seed.dm_template, seed.public_reply_template, seed.match_mode,
    ]);
    const id = rows[0]?.id;
    return id ? { created: true, id, source: seed.source } : { created: false, reason: 'exists' };
}
