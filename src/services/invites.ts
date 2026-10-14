/**
 * Invites: the link that replaces a typed password (docs/onboarding/02 §5, plan D5).
 *
 * The operator makes a link for a tenant; the person opens it, sets a password and is in. There is no email infrastructure, so
 * the link travels by WhatsApp or Copy, and everything that makes that safe is here:
 *
 *   - **The token is 32 random bytes** (43 characters of base64url), shown to the operator once, in the link's URL *hash*
 *     (`/dashboard#/invite?t=…`): a fragment is never sent to a server, so it is in no access log and no Referer. Only its
 *     sha256 is stored (`invites.token_hash`), so a read of the table, a backup or the audit trail yields nothing that opens a
 *     door. The same shape as `hashWorkerToken`.
 *   - **It is single-use, atomically.** `accept` claims the row with ONE `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL
 *     AND expires_at > NOW() RETURNING …` inside the transaction that creates the user and the membership: two people opening
 *     the same link at once cannot both get in, and a failure after the claim (a duplicate email) rolls the claim back, so a
 *     refused attempt does not burn the link.
 *   - **Every way a token can be unusable looks the same**: unknown, malformed, expired, used, revoked, or the tenant switched
 *     off all answer 410 "This link is no longer valid." (`INVITE_INVALID`). The words never say which, because the only people
 *     who could tell the difference are the ones holding the link, and the page's advice ("ask whoever sent it, or sign in")
 *     fits all of them.
 *   - **Comparisons are constant-time.** The row is found by the hash of what was presented (an unpredictable key: the index
 *     lookup cannot leak the token), and the stored hash is then compared with `timingSafeEqual` before anything is believed.
 *   - **`peek` shows, `accept` acts.** `peek` reads the tenant's name and the role without using the link up (it only counts the
 *     opening, which is what "Opened 2h ago" on the operator's card is); `accept` creates the account or attaches a signed-in
 *     one.
 *   - **An email that already has an account is a 409**, never an overwrite: the password hash of an existing user is not
 *     something a link can replace (only a `reset` link, made for that user, does, and that bumps `users.token_version`, which
 *     ends every session they held).
 *
 * Nothing here writes a token anywhere: not the audit rows (their `detail` carries ids and facts), not the log lines, not the
 * response of any route but the one that makes the link.
 */
import crypto from 'node:crypto';
import { hashPassword } from '../config/crypto.js';
import { pool } from '../config/db.js';
import { createSession, DEFAULT_SESSION_TTL_MS, describeSessionLifetime } from '../middleware/auth.js';
import type { InviteRow, OnboardingStatus } from '../db/rows.js';
import { passwordProblem } from './adminGuards.js';
import { APP_SETTING_KEYS, getSetting } from './appSettings.js';
import { msSince, recordEvent } from './onboardingEvents.js';
import {
    getOnboardingSettings, getSessionDays, isInviteRole, ONBOARDING_LIMITS, renderWhatsappText, type InviteLang, type InviteRole, type OnboardingSettings,
} from './onboardingSettings.js';
import { type Exec, withTransaction } from './studio/common.js';

export const INVITE_TOKEN_BYTES = 32;
/** 32 bytes in base64url, unpadded. */
export const INVITE_TOKEN_LENGTH = 43;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type InvitePurpose = 'join' | 'reset';
export type InviteStatus = 'pending' | 'opened' | 'used' | 'expired' | 'revoked';

/** The path of the page an invite opens, on the dashboard. The token and the language ride in the hash, after it. */
export const INVITE_PAGE_PATH = '/dashboard';

// ─── The refusals ───────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal the route answers as-is. Thrown, so one inside a transaction rolls everything back on its way out. */
export class InviteError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
        this.name = 'InviteError';
    }
}

/** Unknown, malformed, expired, used, revoked, or its tenant switched off: one answer for all of them. */
export const INVITE_INVALID_MESSAGE = 'This link is no longer valid.';
export const invalidInvite = (): InviteError => new InviteError(410, 'INVITE_INVALID', INVITE_INVALID_MESSAGE);

// ─── Tokens ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function generateInviteToken(): string {
    return crypto.randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

export function hashInviteToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function isWellFormedToken(value: unknown): value is string {
    return typeof value === 'string' && TOKEN_FORMAT.test(value);
}

/** Constant-time equality for two hex digests. Lengths are public (always 64), so a mismatch there says nothing. */
export function hashesEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The link the operator hands over. The token is in the fragment, not the query string: see the file header. */
export function buildInviteUrl(base: string, token: string, lang: InviteLang): string {
    return `${base}${INVITE_PAGE_PATH}#/invite?t=${encodeURIComponent(token)}&lang=${lang}`;
}

// ─── Status ─────────────────────────────────────────────────────────────────────────────────────────────────────

type StatusFields = Pick<InviteRow, 'used_at' | 'revoked_at' | 'expires_at' | 'open_count'>;

const asDate = (value: Date | string | null): Date | null => (value === null ? null : value instanceof Date ? value : new Date(value));

/** Used wins over revoked wins over expired: what the operator most needs to know is whether somebody got in. */
export function inviteStatus(row: StatusFields, now: Date = new Date()): InviteStatus {
    if (row.used_at) return 'used';
    if (row.revoked_at) return 'revoked';
    const expires = asDate(row.expires_at);
    if (expires && expires.getTime() <= now.getTime()) return 'expired';
    return row.open_count > 0 ? 'opened' : 'pending';
}

/** Whether a link can still be used: not used, not revoked, not past its expiry. */
export function isUsable(row: StatusFields, now: Date = new Date()): boolean {
    const status = inviteStatus(row, now);
    return status === 'pending' || status === 'opened';
}

// ─── What the operator sees ─────────────────────────────────────────────────────────────────────────────────────

/** An invite as listed: never its token, never its hash, never a link (the token is not stored, so a link cannot be remade). */
export interface AdminInvite {
    id: string;
    creator_id: string;
    email: string | null;
    role: InviteRole;
    purpose: InvitePurpose;
    user_id: string | null;
    status: InviteStatus;
    created_at: string;
    expires_at: string;
    first_opened_at: string | null;
    open_count: number;
    used_at: string | null;
    used_by_email: string | null;
    revoked_at: string | null;
}

const iso = (value: Date | string | null): string | null => {
    const date = asDate(value);
    return date ? date.toISOString() : null;
};

type ListedRow = Omit<InviteRow, 'token_hash' | 'created_by' | 'used_by'> & { used_by_email?: string | null };

export function describeInvite(row: ListedRow, now: Date = new Date()): AdminInvite {
    return {
        id: row.id,
        creator_id: row.creator_id,
        email: row.email,
        role: row.membership_role,
        purpose: row.purpose,
        user_id: row.user_id,
        status: inviteStatus(row, now),
        created_at: iso(row.created_at)!,
        expires_at: iso(row.expires_at)!,
        first_opened_at: iso(row.first_opened_at),
        open_count: row.open_count ?? 0,
        used_at: iso(row.used_at),
        used_by_email: row.used_by_email ?? null,
        revoked_at: iso(row.revoked_at),
    };
}

/** The newest invites of one tenant, for its Members card. */
export const LIST_LIMIT = 20;

export async function listInvites(creatorId: string, exec: Exec = pool as unknown as Exec): Promise<AdminInvite[]> {
    const result = await exec.query<ListedRow>(
        `SELECT i.id, i.creator_id, i.email, i.membership_role, i.purpose, i.user_id, i.created_at, i.expires_at,
                i.first_opened_at, i.open_count, i.used_at, i.revoked_at, uu.email AS used_by_email
           FROM invites i
           LEFT JOIN users uu ON uu.id = i.used_by
          WHERE i.creator_id = $1
          ORDER BY i.created_at DESC, i.id DESC
          LIMIT ${LIST_LIMIT}`,
        [creatorId]
    );
    const now = new Date();
    return result.rows.map((row) => describeInvite(row, now));
}

// ─── Creating ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewInvite {
    creatorId: string;
    purpose: InvitePurpose;
    role: InviteRole;
    email: string | null;
    userId: string | null;
    createdBy: string | null;
    /** How long it lasts, in ms from now. */
    ttlMs: number;
}

export interface CreatedInvite {
    invite: AdminInvite;
    /** The raw token. Exists here and in the response that carries the link, and nowhere else. */
    token: string;
}

/** Insert one invite and return its token once. Only the hash is stored. */
export async function insertInvite(input: NewInvite, exec: Exec): Promise<CreatedInvite> {
    const token = generateInviteToken();
    const expiresAt = new Date(Date.now() + input.ttlMs);
    const result = await exec.query<ListedRow>(
        `INSERT INTO invites (token_hash, creator_id, email, membership_role, purpose, user_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, creator_id, email, membership_role, purpose, user_id, created_at, expires_at, first_opened_at, open_count, used_at, revoked_at`,
        [hashInviteToken(token), input.creatorId, input.email, input.role, input.purpose, input.userId, input.createdBy, expiresAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('The invite could not be stored.');
    return { invite: describeInvite(row), token };
}

export interface CreateInviteRequest {
    creatorId: string;
    purpose?: InvitePurpose;
    role?: InviteRole | null;
    email?: string | null;
    /** The account a `reset` link is for. */
    userId?: string | null;
    ttlDays?: number | null;
    ttlHours?: number | null;
    createdBy: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_LENGTH = 255;

/** An email as typed: trimmed, lower-cased, one address. Null when it is not one. */
export function normaliseEmail(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const email = raw.trim().toLowerCase();
    return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * Make an invite for a tenant, applying the operator's settings: the default role and how long it lasts.
 *
 * `join` is for a new person (the `email` is optional: when the operator knows it, the link is only good for that address);
 * `reset` is for somebody who already has an account in this tenant and lost the password (`userId` required, and never an
 * admin's). Refusals are `InviteError`s with the status the admin route answers.
 */
export async function createInvite(request: CreateInviteRequest, settings?: OnboardingSettings, exec: Exec = pool as unknown as Exec): Promise<CreatedInvite & { tenantName: string | null }> {
    const purpose: InvitePurpose = request.purpose ?? 'join';
    const config = settings ?? await getOnboardingSettings();

    const tenant = await exec.query<{ id: string; name: string | null; is_active: boolean }>(
        'SELECT id, name, is_active FROM creators WHERE id = $1', [request.creatorId]
    );
    const creator = tenant.rows[0];
    if (!creator) throw new InviteError(404, 'TENANT_NOT_FOUND', 'Tenant not found.');
    if (creator.is_active === false) throw new InviteError(409, 'TENANT_INACTIVE', 'This tenant is switched off. Switch it on before inviting anyone.');

    let email: string | null = null;
    let userId: string | null = null;
    let role: InviteRole = request.role && isInviteRole(request.role) ? request.role : config.defaultRole;

    if (purpose === 'reset') {
        if (!request.userId) throw new InviteError(400, 'USER_REQUIRED', 'A reset link needs user_id: the account whose password it replaces.');
        const found = await exec.query<{ id: string; email: string; role: string; is_active: boolean; is_member: boolean; membership_role: string | null }>(
            `SELECT u.id, u.email, u.role, u.is_active,
                    EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.creator_id = $2) AS is_member,
                    (SELECT m.role FROM memberships m WHERE m.user_id = u.id AND m.creator_id = $2) AS membership_role
               FROM users u WHERE u.id = $1`,
            [request.userId, request.creatorId]
        );
        const user = found.rows[0];
        if (!user) throw new InviteError(404, 'USER_NOT_FOUND', 'User not found.');
        // An admin's password is not reset by a link that anybody holding it could use; the admin sets it from Users.
        if (user.role === 'platform_admin') throw new InviteError(409, 'USER_IS_ADMIN', 'A platform admin\'s password is set from Users, not with a link.');
        if (!user.is_member) throw new InviteError(409, 'NOT_A_MEMBER', 'That user is not a member of this tenant.');
        if (user.is_active === false) throw new InviteError(409, 'USER_DISABLED', 'That account is disabled.');
        email = user.email.toLowerCase();
        userId = user.id;
        role = isInviteRole(user.membership_role) ? user.membership_role : role;
    } else if (request.email !== undefined && request.email !== null && request.email !== '') {
        email = normaliseEmail(request.email);
        if (!email) throw new InviteError(400, 'BAD_EMAIL', 'email is not a valid address.');
    }

    const ttlMs = purpose === 'reset'
        ? (request.ttlHours ?? config.resetTtlHours) * HOUR_MS
        : (request.ttlDays ?? config.inviteTtlDays) * DAY_MS;

    const created = await insertInvite({
        creatorId: request.creatorId, purpose, role, email, userId, createdBy: request.createdBy, ttlMs,
    }, exec);
    return { ...created, tenantName: creator.name };
}

/** The `ttl_days` / `ttl_hours` a request may carry: a whole number in range, or an error sentence. */
export function readTtl(raw: unknown, unit: 'days' | 'hours'): { ok: true; value: number | null } | { ok: false; error: string } {
    if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
    const max = unit === 'days' ? 90 : 168;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false, error: `ttl_${unit} must be a whole number, 1 to ${max}.` };
    return { ok: true, value: n };
}

// ─── Revoking and regenerating ──────────────────────────────────────────────────────────────────────────────────

export interface RevokeOutcome {
    id: string;
    creatorId: string;
    purpose: InvitePurpose;
    /** False when it was already revoked: revoking twice is not an error. */
    changed: boolean;
}

/** Revoke a link: it stops working at once. A used one cannot be (409): somebody already got in. Idempotent for one already revoked. */
export async function revokeInvite(id: string, exec: Exec = pool as unknown as Exec): Promise<RevokeOutcome> {
    const revoked = await exec.query<{ id: string; creator_id: string; purpose: InvitePurpose }>(
        `UPDATE invites SET revoked_at = NOW()
          WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
      RETURNING id, creator_id, purpose`,
        [id]
    );
    const row = revoked.rows[0];
    if (row) return { id: row.id, creatorId: row.creator_id, purpose: row.purpose, changed: true };

    const existing = await exec.query<{ id: string; creator_id: string; purpose: InvitePurpose; used_at: Date | null }>(
        'SELECT id, creator_id, purpose, used_at FROM invites WHERE id = $1', [id]
    );
    const found = existing.rows[0];
    if (!found) throw new InviteError(404, 'INVITE_NOT_FOUND', 'Invite not found.');
    if (found.used_at) throw new InviteError(409, 'INVITE_USED', 'This invite was already used: the person is in. Remove their membership from Users instead.');
    return { id: found.id, creatorId: found.creator_id, purpose: found.purpose, changed: false };
}

/**
 * Replace a link with a new one for the same person and tenant: the old one is revoked in the same transaction, so there is
 * never a moment with two live links, and never one with none if the new one cannot be made.
 */
export async function regenerateInvite(
    id: string, createdBy: string | null, settings?: OnboardingSettings
): Promise<CreatedInvite & { previousId: string; tenantName: string | null }> {
    const config = settings ?? await getOnboardingSettings();
    return withTransaction(async (tx) => {
        const found = await tx.query<Pick<InviteRow, 'id' | 'creator_id' | 'email' | 'membership_role' | 'purpose' | 'user_id' | 'used_at' | 'revoked_at' | 'expires_at'>>(
            `SELECT id, creator_id, email, membership_role, purpose, user_id, used_at, revoked_at, expires_at
               FROM invites WHERE id = $1 FOR UPDATE`,
            [id]
        );
        const old = found.rows[0];
        if (!old) throw new InviteError(404, 'INVITE_NOT_FOUND', 'Invite not found.');
        if (old.used_at) throw new InviteError(409, 'INVITE_USED', 'This invite was already used: the person is in, so there is nothing to regenerate.');

        await tx.query('UPDATE invites SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1', [id]);
        const created = await createInvite({
            creatorId: old.creator_id, purpose: old.purpose, role: old.membership_role, email: old.email, userId: old.user_id, createdBy,
        }, config, tx);
        return { ...created, previousId: id };
    });
}

/**
 * The language a tenant's invite page and message default to: the one its stored profile says it writes in, Arabic when it has
 * none (a tenant made before v33) or the table cannot be read. Never an error: the card has a language picker for the operator
 * who knows better, and a link in the wrong language is a smaller problem than no link.
 */
export async function tenantLanguage(creatorId: string, exec: Exec = pool as unknown as Exec): Promise<InviteLang> {
    try {
        const found = await exec.query<{ lang: string | null }>(
            `SELECT profile #>> '{language,primary}' AS lang FROM creator_profiles WHERE creator_id = $1`, [creatorId]
        );
        return found.rows[0]?.lang === 'en' ? 'en' : 'ar';
    } catch {
        return 'ar';
    }
}

/** The message and link for the card, once a link exists. */
export function shareFor(
    settings: OnboardingSettings, tenantName: string | null, url: string, lang: InviteLang, purpose: InvitePurpose
): { whatsapp_text: string } {
    return {
        whatsapp_text: renderWhatsappText(settings.whatsappText, { name: tenantName ?? '', link: url, inviter: settings.inviterName }, lang, purpose),
    };
}

// ─── Opening a link ─────────────────────────────────────────────────────────────────────────────────────────────

interface LoadedInvite {
    id: string;
    creatorId: string;
    email: string | null;
    role: InviteRole;
    purpose: InvitePurpose;
    userId: string | null;
    expiresAt: Date;
    tenantName: string | null;
    /** The account a reset link is for: its current email. */
    userEmail: string | null;
}

/**
 * The invite a token names, if it can still be used. Null for every reason it cannot, which the caller reports as one thing.
 *
 * A malformed token is refused without a query. A found row is checked again, in constant time, against the hash of what was
 * presented, and its tenant must still be switched on: a link into a tenant the operator has since disabled is not a door.
 */
export async function loadUsableInvite(token: unknown, exec: Exec = pool as unknown as Exec): Promise<LoadedInvite | null> {
    if (!isWellFormedToken(token)) return null;
    const hash = hashInviteToken(token);
    const result = await exec.query<Pick<InviteRow, 'id' | 'token_hash' | 'creator_id' | 'email' | 'membership_role' | 'purpose' | 'user_id' | 'expires_at' | 'used_at' | 'revoked_at' | 'open_count'> & { tenant_name: string | null; tenant_active: boolean; user_email: string | null }>(
        `SELECT i.id, i.token_hash, i.creator_id, i.email, i.membership_role, i.purpose, i.user_id, i.expires_at, i.used_at, i.revoked_at,
                i.open_count, c.name AS tenant_name, c.is_active AS tenant_active, u.email AS user_email
           FROM invites i
           JOIN creators c ON c.id = i.creator_id
           LEFT JOIN users u ON u.id = i.user_id
          WHERE i.token_hash = $1`,
        [hash]
    );
    const row = result.rows[0];
    if (!row || !hashesEqual(String(row.token_hash).trim(), hash)) return null;
    if (!isUsable(row) || row.tenant_active === false) return null;
    return {
        id: row.id,
        creatorId: row.creator_id,
        email: row.email,
        role: isInviteRole(row.membership_role) ? row.membership_role : 'owner',
        purpose: row.purpose,
        userId: row.user_id,
        expiresAt: asDate(row.expires_at)!,
        tenantName: row.tenant_name,
        userEmail: row.user_email,
    };
}

export interface PeekedInvite {
    tenantName: string | null;
    inviter: string | null;
    /** The address the link is for, when the operator knew it (always, for a reset). */
    email: string | null;
    expiresAt: string;
    purpose: InvitePurpose;
    role: InviteRole;
    /** How long "keep me signed in" lasts, so the page's checkbox can say the number. */
    sessionDays: number;
}

/** What a person sees before choosing a password. Counts the opening; never uses the link up. */
export async function peekInvite(token: unknown, exec: Exec = pool as unknown as Exec): Promise<PeekedInvite | null> {
    const invite = await loadUsableInvite(token, exec);
    if (!invite) return null;

    // "Opened 2h ago" is the operator's only sign the link reached anyone. A failure to count must not fail the page.
    const counted = await exec.query<{ open_count: number; created_at: Date | string | null }>(
        'UPDATE invites SET first_opened_at = COALESCE(first_opened_at, NOW()), open_count = open_count + 1 WHERE id = $1 RETURNING open_count, created_at',
        [invite.id]
    ).catch(() => undefined);
    // The funnel's `invite_opened` is the FIRST opening of a join link (open_count is 1 only once, even for two simultaneous
    // opens). A reset link is somebody changing a password, not somebody getting in. Best-effort, and what it records is a number.
    const opening = counted?.rows[0];
    if (invite.purpose === 'join' && opening && Number(opening.open_count) === 1) {
        await recordEvent({ creatorId: invite.creatorId, userId: null, actor: 'tenant' }, 'invite_opened', null, { ms_since_created: msSince(opening.created_at) ?? undefined });
    }

    let inviter: string | null = null;
    let sessionDays: number = ONBOARDING_LIMITS.sessionDays.fallback;
    try {
        [inviter, sessionDays] = await Promise.all([
            getSetting(APP_SETTING_KEYS.onboardingInviterName).then((name) => name?.trim() || null),
            getSessionDays(),
        ]);
    } catch {
        // Settings are decoration here: a link still opens when they cannot be read.
    }
    return {
        tenantName: invite.tenantName,
        inviter,
        email: invite.purpose === 'reset' ? invite.userEmail : invite.email,
        expiresAt: invite.expiresAt.toISOString(),
        purpose: invite.purpose,
        role: invite.role,
        sessionDays,
    };
}

// ─── Accepting ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Who is asking, when the request carried a live session. A platform admin is never used to accept a link. */
export type Viewer =
    | { kind: 'user'; userId: string; email: string; tokenVersion: number; exp?: number }
    | { kind: 'admin' };

export interface AcceptRequest {
    token: unknown;
    email?: unknown;
    password?: unknown;
    keepSignedIn?: unknown;
    viewer?: Viewer | null;
}

export interface Accepted {
    /** A session for the new (or attached) user, acting as the invite's tenant. */
    session: string;
    expiresIn: string;
    inviteId: string;
    userId: string;
    email: string;
    tenantId: string;
    tenantName: string | null;
    purpose: InvitePurpose;
    role: InviteRole;
    /** A new account was made. */
    created: boolean;
    /** An existing, signed-in account was added to the tenant. */
    attached: boolean;
    /** Attached, but it was already a member: nothing changed. */
    alreadyMember: boolean;
    /** A reset: every other session this user held ended. */
    sessionsInvalidated: boolean;
    keptSignedIn: boolean;
    onboarding: { status: OnboardingStatus };
}

const PG_UNIQUE_VIOLATION = '23505';

/** The statement that makes a link single-use. Everything after it in the transaction runs only for the one request that won. */
async function claim(tx: Exec, token: string): Promise<{ id: string; created_at: Date | string | null }> {
    const claimed = await tx.query<{ id: string; created_at: Date | string | null }>(
        `UPDATE invites SET used_at = NOW()
          WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      RETURNING id, created_at`,
        [hashInviteToken(token)]
    );
    const row = claimed.rows[0];
    if (!row) throw invalidInvite();
    return row;
}

/** Where the tenant is in the wizard. No row reads as completed (D14). */
async function onboardingStatus(tx: Exec, creatorId: string): Promise<OnboardingStatus> {
    const current = await tx.query<{ status: OnboardingStatus }>('SELECT status FROM onboarding WHERE creator_id = $1', [creatorId]);
    return current.rows[0]?.status ?? 'completed';
}

/** A tenant that was `invited` is now being used; later members never move a tenant backwards. */
async function openOnboarding(tx: Exec, creatorId: string): Promise<OnboardingStatus> {
    await tx.query(
        `UPDATE onboarding SET status = 'in_progress', started_at = COALESCE(started_at, NOW())
          WHERE creator_id = $1 AND status = 'invited'`,
        [creatorId]
    );
    return onboardingStatus(tx, creatorId);
}

/**
 * Use a link. The whole of it is one transaction, so an account never exists without its membership, and a link is never
 * spent on an attempt that failed.
 *
 *   - **reset**: replace the password of the account the link was made for and bump `token_version` (every other session ends);
 *   - **join, signed in**: add the signed-in account to the tenant (a platform admin is refused first, so an operator testing
 *     his own link does not use it up; a link made for another address is refused);
 *   - **join, anonymous**: create the account. An email that already has one is a 409 and nothing is consumed.
 */
export async function acceptInvite(request: AcceptRequest): Promise<Accepted> {
    const token = request.token;
    const invite = await loadUsableInvite(token);
    if (!invite || !isWellFormedToken(token)) throw invalidInvite();

    const keepSignedIn = request.keepSignedIn === true;
    /** A session for a person who just chose a password: 24 hours, or the operator's "keep me signed in" length when asked for. */
    const freshSession = async (userId: string, tokenVersion: number): Promise<{ session: string; expiresIn: string }> => {
        const ttlMs = keepSignedIn ? (await getSessionDays()) * DAY_MS : undefined;
        return {
            session: createSession({ userId, role: 'user', tenantId: invite.creatorId, tokenVersion }, { ttlMs }),
            expiresIn: describeSessionLifetime(ttlMs),
        };
    };

    if (invite.purpose === 'reset') {
        const problem = passwordProblem(request.password);
        if (problem) throw new InviteError(400, 'WEAK_PASSWORD', problem);
        if (!invite.userId) throw invalidInvite();
        const passwordHash = await hashPassword(request.password as string);
        const done = await withTransaction(async (tx) => {
            await claim(tx, token);
            // The account must still be a member of the tenant, switched on, and not an admin.
            const member = await tx.query('SELECT 1 FROM memberships WHERE user_id = $1 AND creator_id = $2', [invite.userId, invite.creatorId]);
            if (member.rows.length === 0) throw invalidInvite();
            const updated = await tx.query<{ id: string; email: string; token_version: number }>(
                `UPDATE users SET password_hash = $2, token_version = token_version + 1, last_login_at = NOW()
                  WHERE id = $1 AND is_active = TRUE AND role <> 'platform_admin'
              RETURNING id, email, token_version`,
                [invite.userId, passwordHash]
            );
            const user = updated.rows[0];
            if (!user) throw invalidInvite();
            await tx.query('UPDATE invites SET used_by = $2 WHERE id = $1', [invite.id, user.id]);
            return { ...user, status: await onboardingStatus(tx, invite.creatorId) };
        });
        return {
            ...(await freshSession(done.id, done.token_version)),
            inviteId: invite.id, userId: done.id, email: done.email, tenantId: invite.creatorId, tenantName: invite.tenantName,
            purpose: 'reset', role: invite.role, created: false, attached: false, alreadyMember: true, sessionsInvalidated: true,
            keptSignedIn: keepSignedIn, onboarding: { status: done.status },
        };
    }

    const viewer = request.viewer ?? null;

    if (viewer?.kind === 'admin') {
        throw new InviteError(403, 'ADMIN_SESSION', 'You are signed in as the platform admin. Open this link in a private window, or sign out first: using it here would spend it.');
    }

    if (viewer?.kind === 'user') {
        if (invite.email && invite.email.toLowerCase() !== viewer.email.toLowerCase()) {
            throw new InviteError(403, 'EMAIL_MISMATCH', 'This invitation is for a different email address than the account you are signed in with.');
        }
        let attachedCreatedAt: Date | string | null = null;
        const attached = await withTransaction(async (tx) => {
            attachedCreatedAt = (await claim(tx, token)).created_at;
            const added = await tx.query<{ user_id: string }>(
                `INSERT INTO memberships (user_id, creator_id, role) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, creator_id) DO NOTHING RETURNING user_id`,
                [viewer.userId, invite.creatorId, invite.role]
            );
            await tx.query('UPDATE invites SET used_by = $2 WHERE id = $1', [invite.id, viewer.userId]);
            const status = await openOnboarding(tx, invite.creatorId);
            return { alreadyMember: added.rows.length === 0, status };
        });
        await recordEvent({ creatorId: invite.creatorId, userId: viewer.userId, actor: 'tenant' }, 'invite_accepted', null, { ms_since_created: msSince(attachedCreatedAt) ?? undefined });
        // The same sign-in, pointed at the new tenant: its expiry is carried, never restarted.
        const minted = {
            session: createSession({ userId: viewer.userId, role: 'user', tenantId: invite.creatorId, tokenVersion: viewer.tokenVersion, ...(viewer.exp !== undefined ? { exp: viewer.exp } : {}) }),
            expiresIn: describeSessionLifetime(viewer.exp !== undefined ? viewer.exp - Date.now() : undefined),
        };
        return {
            ...minted,
            inviteId: invite.id, userId: viewer.userId, email: viewer.email, tenantId: invite.creatorId, tenantName: invite.tenantName,
            purpose: 'join', role: invite.role, created: false, attached: true, alreadyMember: attached.alreadyMember, sessionsInvalidated: false,
            keptSignedIn: viewer.exp !== undefined && viewer.exp - Date.now() > DEFAULT_SESSION_TTL_MS, onboarding: { status: attached.status },
        };
    }

    // Anonymous: a new account. The link's own address wins over whatever the form sent: it was made for that person.
    const email = invite.email ? invite.email.toLowerCase() : normaliseEmail(request.email);
    if (!email) throw new InviteError(400, 'BAD_EMAIL', 'Enter a valid email address.');
    const problem = passwordProblem(request.password);
    if (problem) throw new InviteError(400, 'WEAK_PASSWORD', problem);

    const taken = async (exec: Exec): Promise<boolean> => (await exec.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email])).rows.length > 0;
    const existsError = (): InviteError => new InviteError(409, 'EMAIL_EXISTS', `An account with this email already exists. Sign in to add ${invite.tenantName ?? 'this account'}.`, { tenantName: invite.tenantName });
    // Checked before the password is hashed or anything is claimed: a person who already has an account loses nothing.
    if (await taken(pool as unknown as Exec)) throw existsError();

    const passwordHash = await hashPassword(request.password as string);
    let created: { id: string; email: string; token_version: number; status: OnboardingStatus };
    let createdAt: Date | string | null = null;
    try {
        created = await withTransaction(async (tx) => {
            createdAt = (await claim(tx, token)).created_at;
            const inserted = await tx.query<{ id: string; email: string; token_version: number }>(
                `INSERT INTO users (email, password_hash, role, last_login_at) VALUES (lower($1), $2, 'user', NOW())
                 RETURNING id, email, token_version`,
                [email, passwordHash]
            );
            const user = inserted.rows[0];
            if (!user) throw new Error('The account could not be created.');
            await tx.query('UPDATE invites SET used_by = $2 WHERE id = $1', [invite.id, user.id]);
            await tx.query('INSERT INTO memberships (user_id, creator_id, role) VALUES ($1, $2, $3)', [user.id, invite.creatorId, invite.role]);
            return { ...user, status: await openOnboarding(tx, invite.creatorId) };
        });
    } catch (err) {
        // Two people took the same address at once: the loser's transaction is already rolled back, link and all.
        if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) throw existsError();
        throw err;
    }
    await recordEvent({ creatorId: invite.creatorId, userId: created.id, actor: 'tenant' }, 'invite_accepted', null, { ms_since_created: msSince(createdAt) ?? undefined });
    return {
        ...(await freshSession(created.id, created.token_version)),
        inviteId: invite.id, userId: created.id, email: created.email, tenantId: invite.creatorId, tenantName: invite.tenantName,
        purpose: 'join', role: invite.role, created: true, attached: false, alreadyMember: false, sessionsInvalidated: false,
        keptSignedIn: keepSignedIn, onboarding: { status: created.status },
    };
}

