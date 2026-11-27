/**
 * The go-live checklist and the activation numbers (U3, SA-12 + WA-9; docs/specs/007-company-shell §7).
 *
 * A company workspace is made by an operator and handed to its owner with an empty Today. This is the short list that says what is left
 * before it works for real, with one button each, and the moment it does: the owner's test comment arrived.
 *
 * **Never the owner's own workspace.** `show` is false for the platform owner's workspace, for a workspace with no `onboarding` row (made
 * before the wizard existed: legacy), for anyone who is not the workspace's owner, once the owner hid the card, and three days after it
 * went live. Then ONLY `{ show: false }` is sent: nothing else about the workspace leaves.
 *
 * **Done is read from the database, not from a click.** Each item has one fact it is done by (`FACTS` below), so the card cannot say "done"
 * to a thing that is not: Meta connected is the token, the test comment is the webhook's own queue row, the assistant test is the event
 * the first successful `POST /settings/ai/test` wrote. Items of a module that is off are not shown at all (`modules`).
 *
 * **Live** is every REQUIRED item shown being done. The first read that finds it so (or finds the test comment arrived) writes `liveAt` and
 * `seen.test_comment` into `golive.<tenant>` once, because the webhook's jobs are pruned and the proof must outlast them.
 *
 * **The activation block** is derived, never stored (`onboarding_events` for the events, `interactions` and `messages` for the first
 * outcomes): how long from accepting the invite to the first DM, whether the assistant was tested, how many staff replied.
 */
import { queryOne } from '../db/query.js';
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES, type TenantSettingKey } from './appSettings.js';
import { readCommentCheck } from './metaCommentCheck.js';
import { readDocModules } from './modules.js';
import { readTeamNotify } from './notifyPeople.js';
import { recordEvent } from './onboardingEvents.js';
import { getPlatformOwnerId } from './tenant.js';
import { log, describeError } from '../utils/log.js';

// ─── Storage ─────────────────────────────────────────────────────────────────────────────────────────────

export const goLiveKey = (tenantId: string): TenantSettingKey => tenantSettingKey(TENANT_SETTING_PREFIXES.goLive, tenantId);

export interface GoLiveDoc {
    v: 1;
    dismissedAt: string | null;
    liveAt: string | null;
    seen: { test_comment?: string };
}

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** The stored doc, or an empty one: an unreadable row is "nothing happened yet", never an exception. */
export function parseGoLiveDoc(raw: string | null | undefined): GoLiveDoc {
    const empty: GoLiveDoc = { v: 1, dismissedAt: null, liveAt: null, seen: {} };
    if (!raw) return empty;
    try {
        const doc = JSON.parse(raw) as { dismissedAt?: unknown; liveAt?: unknown; seen?: { test_comment?: unknown } };
        if (!doc || typeof doc !== 'object') return empty;
        const seenAt = isoOrNull(doc.seen?.test_comment);
        return { v: 1, dismissedAt: isoOrNull(doc.dismissedAt), liveAt: isoOrNull(doc.liveAt), seen: seenAt ? { test_comment: seenAt } : {} };
    } catch {
        return empty;
    }
}

export async function readGoLiveDoc(tenantId: string): Promise<GoLiveDoc> {
    return parseGoLiveDoc(await getSetting(goLiveKey(tenantId)));
}

export async function writeGoLiveDoc(tenantId: string, doc: GoLiveDoc, updatedBy: string | null): Promise<void> {
    await setSetting(goLiveKey(tenantId), JSON.stringify(doc), updatedBy);
}

// ─── Modules ─────────────────────────────────────────────────────────────────────────────────────────────

/** The module ids this checklist asks about. */
export type GoLiveModule = 'inbox' | 'keyword_replies' | 'dm_assistant' | 'scheduler' | 'whatsapp' | 'youtube';

const has = (modules: ReadonlySet<string> | null, id: GoLiveModule | null): boolean => id === null || modules === null || modules.has(id);

// ─── The items ───────────────────────────────────────────────────────────────────────────────────────────

export const GOLIVE_ITEM_IDS = ['profile', 'meta', 'test_comment', 'first_reply_on', 'assistant_tested', 'team', 'alerts_chosen'] as const;
export type GoLiveItemId = (typeof GOLIVE_ITEM_IDS)[number];
export const GOLIVE_OPTIONAL_IDS = ['whatsapp', 'youtube'] as const;
export type GoLiveOptionalId = (typeof GOLIVE_OPTIONAL_IDS)[number];

/** Every fact the items are done by, read from the database in one statement (`readFacts`) and the checks beside it. */
export interface GoLiveFacts {
    onboardingCompleted: boolean;
    onboardingCompletedAt: string | null;
    metaConnected: boolean;
    handle: string | null;
    testCommentReceived: boolean;
    testCommentAt: string | null;
    campaignOn: boolean;
    assistantTestedAt: string | null;
    members: number;
    invitedAfterFirstMember: boolean;
    alertsChosen: boolean;
    whatsapp: boolean;
    youtube: boolean;
}

interface ItemDef {
    id: GoLiveItemId;
    module: GoLiveModule | null;
    href: string | null;
}

/**
 * The required items, in the order the card draws them. `href` is where the button goes: a dashboard hash. `profile` has none for the
 * owner: the wizard is the platform admin's to open on the workspace's behalf (the card draws a button only when the session can use it).
 */
export const GOLIVE_ITEMS: readonly ItemDef[] = [
    { id: 'profile', module: null, href: '#/welcome' },
    { id: 'meta', module: null, href: '#/settings?s=channels&card=meta' },
    { id: 'test_comment', module: 'keyword_replies', href: '#/help/go-live#test-comment' },
    { id: 'first_reply_on', module: 'keyword_replies', href: '#/campaigns' },
    { id: 'assistant_tested', module: 'dm_assistant', href: '#/ai_settings' },
    { id: 'team', module: null, href: '#/settings?s=team' },
    { id: 'alerts_chosen', module: 'inbox', href: '#/settings?s=notifications' },
];

const OPTIONAL: ReadonlyArray<{ id: GoLiveOptionalId; module: GoLiveModule; href: string }> = [
    { id: 'whatsapp', module: 'whatsapp', href: '#/settings?s=channels&card=whatsapp' },
    { id: 'youtube', module: 'youtube', href: '#/settings?s=channels&card=youtube' },
];

export interface GoLiveItem {
    id: GoLiveItemId;
    done: boolean;
    doneAt: string | null;
    detail: { handle?: string } | null;
    href: string | null;
}

export interface GoLiveOptional {
    id: GoLiveOptionalId;
    done: boolean;
    href: string;
}

function doneOf(id: GoLiveItemId, f: GoLiveFacts, seen: GoLiveDoc['seen']): { done: boolean; doneAt: string | null } {
    switch (id) {
        case 'profile': return { done: f.onboardingCompleted, doneAt: f.onboardingCompletedAt };
        case 'meta': return { done: f.metaConnected, doneAt: null };
        case 'test_comment': return { done: f.testCommentReceived || Boolean(seen.test_comment), doneAt: seen.test_comment ?? f.testCommentAt };
        case 'first_reply_on': return { done: f.campaignOn, doneAt: null };
        case 'assistant_tested': return { done: f.assistantTestedAt !== null, doneAt: f.assistantTestedAt };
        case 'team': return { done: f.members >= 2 || f.invitedAfterFirstMember, doneAt: null };
        case 'alerts_chosen': return { done: f.alertsChosen, doneAt: null };
    }
}

/** The items of the modules that are on, with whether each is done. Pure. */
export function evaluateItems(facts: GoLiveFacts, doc: GoLiveDoc, modules: ReadonlySet<string> | null): { items: GoLiveItem[]; optional: GoLiveOptional[] } {
    const items = GOLIVE_ITEMS.filter((d) => has(modules, d.module)).map((d): GoLiveItem => {
        const { done, doneAt } = doneOf(d.id, facts, doc.seen);
        return { id: d.id, done, doneAt: done ? doneAt : null, detail: d.id === 'meta' && done && facts.handle ? { handle: facts.handle } : null, href: d.href };
    });
    const optional = OPTIONAL.filter((d) => has(modules, d.module)).map((d): GoLiveOptional => ({ id: d.id, done: d.id === 'whatsapp' ? facts.whatsapp : facts.youtube, href: d.href }));
    return { items, optional };
}

/** Live = every required item shown is done (and there is at least one). Pure. */
export function isLive(items: readonly GoLiveItem[]): boolean {
    return items.length > 0 && items.every((i) => i.done);
}

/** How long the "You're live" line stays after going live. */
export const LIVE_LINE_MS = 3 * 24 * 60 * 60 * 1000;

/** Should the card be drawn at all? Pure. */
export function shouldShow(args: { owner: boolean; legacy: boolean; isWorkspaceOwner: boolean; doc: GoLiveDoc; now: number }): boolean {
    if (args.owner || args.legacy || !args.isWorkspaceOwner) return false;
    if (args.doc.dismissedAt) return false;
    if (args.doc.liveAt && args.now - Date.parse(args.doc.liveAt) > LIVE_LINE_MS) return false;
    return true;
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────────────

interface FactsRow {
    onboarding_status: string | null;
    onboarding_completed_at: Date | string | null;
    meta_ok: boolean;
    instagram_username: string | null;
    campaign_on: boolean;
    assistant_tested_at: Date | string | null;
    members: number | string;
    invited_after: boolean;
    whatsapp: boolean;
    youtube: boolean;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/** One statement for everything the items read from tables. */
async function readFactsRow(tenantId: string): Promise<FactsRow | null> {
    return queryOne<FactsRow>(
        `SELECT (SELECT status FROM onboarding WHERE creator_id = $1) AS onboarding_status,
                (SELECT completed_at FROM onboarding WHERE creator_id = $1) AS onboarding_completed_at,
                (c.page_access_token IS NOT NULL AND COALESCE(c.token_status, '') <> 'invalid') AS meta_ok,
                c.instagram_username,
                EXISTS (SELECT 1 FROM campaigns WHERE creator_id = $1 AND is_active AND archived_at IS NULL) AS campaign_on,
                (SELECT MIN(at) FROM onboarding_events WHERE creator_id = $1 AND event = 'assistant_tested') AS assistant_tested_at,
                (SELECT COUNT(*)::int FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.creator_id = $1 AND u.role <> 'platform_admin') AS members,
                EXISTS (SELECT 1 FROM invites i
                         WHERE i.creator_id = $1 AND i.purpose = 'join'
                           AND i.created_at > COALESCE((SELECT MIN(m2.created_at) FROM memberships m2 JOIN users u2 ON u2.id = m2.user_id
                                                         WHERE m2.creator_id = $1 AND u2.role <> 'platform_admin'), 'infinity'::timestamptz)) AS invited_after,
                EXISTS (SELECT 1 FROM platform_connections WHERE creator_id = $1 AND platform = 'whatsapp' AND status <> 'revoked') AS whatsapp,
                EXISTS (SELECT 1 FROM platform_connections WHERE creator_id = $1 AND platform = 'youtube' AND status <> 'revoked') AS youtube
           FROM creators c
          WHERE c.id = $1`,
        [tenantId]
    );
}

export interface Activation {
    inviteAcceptedAt: string | null;
    firstCommentDmAt: string | null;
    firstAssistantReplyAt: string | null;
    minutesToFirstDm: number | null;
    assistantTestedAt: string | null;
    staffFirstReplies: number;
}

/** Derived, never stored: `onboarding_events` for the events, `interactions` and `messages` for the first outcomes. */
async function readActivation(tenantId: string, assistantTestedAt: string | null): Promise<Activation> {
    const row = await queryOne<{ invite_accepted_at: Date | string | null; first_dm: Date | string | null; first_ai: Date | string | null; staff: number | string }>(
        `SELECT (SELECT MIN(at) FROM onboarding_events WHERE creator_id = $1 AND event = 'invite_accepted') AS invite_accepted_at,
                (SELECT MIN(i.timestamp) FROM interactions i WHERE i.creator_id = $1 AND i.status = 'SENT') AS first_dm,
                (SELECT MIN(created_at) FROM messages WHERE creator_id = $1 AND direction = 'outbound' AND sender = 'ai') AS first_ai,
                (SELECT COUNT(DISTINCT user_id)::int FROM onboarding_events WHERE creator_id = $1 AND event = 'staff_first_reply') AS staff`,
        [tenantId]
    );
    const accepted = iso(row?.invite_accepted_at);
    const firstDm = iso(row?.first_dm);
    return {
        inviteAcceptedAt: accepted,
        firstCommentDmAt: firstDm,
        firstAssistantReplyAt: iso(row?.first_ai),
        minutesToFirstDm: accepted && firstDm ? Math.max(0, Math.round((Date.parse(firstDm) - Date.parse(accepted)) / 60_000)) : null,
        assistantTestedAt,
        staffFirstReplies: Number(row?.staff ?? 0),
    };
}

export type GoLiveAnswer =
    | { show: false }
    | {
        show: true; done: number; total: number; live: boolean; liveAt: string | null; dismissedAt: string | null;
        items: GoLiveItem[]; optional: GoLiveOptional[]; activation: Activation;
    };

export interface GoLiveWho {
    tenantId: string;
    /** The session acts as an owner of this workspace (a platform admin acting as it counts). */
    isWorkspaceOwner: boolean;
    userId: string | null;
}

/**
 * `GET /api/golive`. Cheap refusals first, so the owner's own workspace and every non-owner role cost one or no statement. The write of
 * `liveAt` / `seen.test_comment` is set-once, and a failure to write it is logged and never fails the read.
 */
export async function readGoLive(who: GoLiveWho, now: number = Date.now()): Promise<GoLiveAnswer> {
    if (!who.isWorkspaceOwner) return { show: false };
    if (who.tenantId === (await getPlatformOwnerId())) return { show: false };

    const doc = await readGoLiveDoc(who.tenantId);
    // Cheapest refusal that needs no facts: hidden, or live for over three days.
    if (!shouldShow({ owner: false, legacy: false, isWorkspaceOwner: true, doc, now })) return { show: false };

    const row = await readFactsRow(who.tenantId);
    // No onboarding row: a workspace made before the wizard existed. It has nothing to go live from.
    if (!row || row.onboarding_status === null) return { show: false };

    // A workspace with no document (legacy), or one that cannot be read, has every document module on: `readDocModules` says so.
    const modules: ReadonlySet<string> = new Set<string>(await readDocModules(who.tenantId));
    const showsComment = has(modules, 'keyword_replies');
    const [check, team] = await Promise.all([
        showsComment && !doc.seen.test_comment ? readCommentCheck(who.tenantId, now) : Promise.resolve(null),
        has(modules, 'inbox') ? readTeamNotify(who.tenantId) : Promise.resolve(null),
    ]);
    const routingExists = team?.routing != null;
    const linked = team?.members.some((m) => m.notify.telegram !== null) ?? false;

    const facts: GoLiveFacts = {
        onboardingCompleted: row.onboarding_status === 'completed',
        onboardingCompletedAt: iso(row.onboarding_completed_at),
        metaConnected: row.meta_ok === true,
        handle: row.instagram_username ? row.instagram_username.replace(/^@/, '').slice(0, 60) : null,
        testCommentReceived: check?.received === true,
        testCommentAt: check?.latestAt ?? null,
        campaignOn: row.campaign_on === true,
        assistantTestedAt: iso(row.assistant_tested_at),
        members: Number(row.members ?? 0),
        invitedAfterFirstMember: row.invited_after === true,
        alertsChosen: routingExists || linked,
        whatsapp: row.whatsapp === true,
        youtube: row.youtube === true,
    };
    const { items, optional } = evaluateItems(facts, doc, modules);
    const live = isLive(items);

    // Set-once: the test comment's proof outlives the pruned job, and `liveAt` is when it first all held.
    const commentNowDone = showsComment && facts.testCommentReceived && !doc.seen.test_comment;
    const goingLive = live && !doc.liveAt;
    let next = doc;
    if (commentNowDone || goingLive) {
        const at = new Date(now).toISOString();
        next = { ...doc, seen: commentNowDone ? { ...doc.seen, test_comment: facts.testCommentAt ?? at } : doc.seen, liveAt: goingLive ? at : doc.liveAt };
        try {
            await writeGoLiveDoc(who.tenantId, next, who.userId);
            if (goingLive) await recordEvent({ creatorId: who.tenantId, userId: who.userId, actor: 'tenant' }, 'golive_live');
        } catch (err) {
            log('warn', 'golive.write_failed', describeError(err));
            next = doc;
        }
    }

    return {
        show: true,
        done: items.filter((i) => i.done).length,
        total: items.length,
        live,
        liveAt: next.liveAt,
        dismissedAt: next.dismissedAt,
        items,
        optional,
        activation: await readActivation(who.tenantId, facts.assistantTestedAt),
    };
}

/** Hide (owner) or show again (`dismissedAt: null`). Everything else in the doc is kept. */
export async function setDismissed(tenantId: string, dismissed: boolean, userId: string | null, now: number = Date.now()): Promise<string | null> {
    const doc = await readGoLiveDoc(tenantId);
    const dismissedAt = dismissed ? new Date(now).toISOString() : null;
    await writeGoLiveDoc(tenantId, { ...doc, dismissedAt }, userId);
    return dismissedAt;
}
