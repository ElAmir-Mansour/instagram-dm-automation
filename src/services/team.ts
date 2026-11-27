/**
 * Team (U3, CO-2): who is in a workspace, and the three changes the workspace's owner may make to that: list the people, give one a
 * different role, take one out. Invites and reset links are `services/invites.ts`; the routes are `routes/team.ts`.
 *
 * Two rules matter more than the rest, and both are decided HERE, in one transaction, so no route has to remember them:
 *
 *   - **The last owner stays.** A workspace always has one owner who is a person of its own. Demoting or removing the last one is a
 *     409 `LAST_OWNER`. "Owner" is counted the way `resolveTenant` reads a stored role (`normalizeTenantRole`: a legacy or unknown
 *     value is an owner), and a platform admin is not counted: an admin reaches every workspace without a membership, so a workspace
 *     whose only "owner" is the account manager has nobody of its own. The count and the write happen under
 *     `SELECT … FROM memberships WHERE creator_id = $1 FOR UPDATE`, so two owners removing each other at once cannot both pass.
 *   - **A platform admin is read-only here** ("Account manager", 409 `MEMBER_IS_ADMIN`): the person who runs the platform is not
 *     the workspace owner's to demote or remove, and a Team screen must not be a way to lock them out.
 *
 * A removal is immediate with no `token_version` bump: `resolveTenant` re-reads the membership on every request, so the person's
 * next request to this workspace is a 404, and their other workspaces (if any) are untouched. (Contract Appendix A, row 10.)
 */
import { pool } from '../config/db.js';
import type { Exec } from './studio/common.js';
import { withTransaction } from './studio/common.js';
import { isTenantRole, normalizeTenantRole, type TenantRole } from './tenant.js';

export interface TeamMember {
    userId: string;
    email: string;
    role: TenantRole;
    isActive: boolean;
    lastLoginAt: string | null;
    /** The person looking at the list. */
    you: boolean;
    /** `users.role === 'platform_admin'`: shown as "Account manager", read-only. */
    accountManager: boolean;
}

/** The refusals, with the status and code the route answers. Anything else is a bug and a 500. */
export class TeamError extends Error {
    constructor(readonly status: 400 | 404 | 409, readonly code: 'LAST_OWNER' | 'MEMBER_IS_ADMIN' | 'MEMBER_NOT_FOUND' | 'ROLE_INVALID', message: string) {
        super(message);
        this.name = 'TeamError';
    }
}

const REFUSALS = {
    notFound: () => new TeamError(404, 'MEMBER_NOT_FOUND', 'That person is not a member of this workspace.'),
    admin: () => new TeamError(409, 'MEMBER_IS_ADMIN', 'That is the platform\'s account manager: their access is not changed from here.'),
    role: () => new TeamError(400, 'ROLE_INVALID', 'role must be owner, operator or viewer.'),
    lastOwner: () => new TeamError(409, 'LAST_OWNER', 'A workspace needs at least one owner. Make someone else an owner first.'),
} as const;

interface MemberRow {
    user_id: string;
    email: string;
    user_role: string;
    membership_role: string;
    is_active: boolean;
    last_login_at: Date | string | null;
}

const iso = (value: Date | string | null): string | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The people of a workspace, owners first, then by address. `viewerId` marks the row that is the person asking. */
export async function listMembers(creatorId: string, viewerId: string | null, exec: Exec = pool as unknown as Exec): Promise<TeamMember[]> {
    const found = await exec.query<MemberRow>(
        `SELECT u.id AS user_id, u.email, u.role AS user_role, m.role AS membership_role, u.is_active, u.last_login_at
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.creator_id = $1
          ORDER BY u.email`,
        [creatorId]
    );
    const rank: Record<TenantRole, number> = { owner: 0, operator: 1, viewer: 2 };
    return found.rows
        .map((row): TeamMember => ({
            userId: row.user_id,
            email: row.email,
            role: normalizeTenantRole(row.membership_role),
            isActive: row.is_active !== false,
            lastLoginAt: iso(row.last_login_at),
            you: viewerId !== null && row.user_id === viewerId,
            accountManager: row.user_role === 'platform_admin',
        }))
        .sort((a, b) => rank[a.role] - rank[b.role] || a.email.localeCompare(b.email));
}

/**
 * Lock the workspace's memberships, and say who is in them. Everything that decides "is this the last owner" reads this answer, inside
 * the same transaction as its write.
 */
async function lockMembers(tx: Exec, creatorId: string): Promise<Array<{ userId: string; role: TenantRole; admin: boolean }>> {
    const rows = await tx.query<{ user_id: string; role: string; user_role: string }>(
        `SELECT m.user_id, m.role, u.role AS user_role
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.creator_id = $1
          FOR UPDATE OF m`,
        [creatorId]
    );
    return rows.rows.map((r) => ({ userId: r.user_id, role: normalizeTenantRole(r.role), admin: r.user_role === 'platform_admin' }));
}

/** Would the workspace still have an owner of its own if `userId` stopped being one? */
function keepsAnOwner(members: Array<{ userId: string; role: TenantRole; admin: boolean }>, userId: string): boolean {
    return members.some((m) => m.userId !== userId && m.role === 'owner' && !m.admin);
}

export interface RoleChange { userId: string; from: TenantRole; to: TenantRole }

/** Give a member another role. Refuses an unknown role, a stranger, an account manager and the last owner's demotion. */
export async function changeRole(creatorId: string, userId: string, role: unknown): Promise<RoleChange> {
    if (!isTenantRole(role)) throw REFUSALS.role();
    return withTransaction(async (tx) => {
        const members = await lockMembers(tx, creatorId);
        const target = members.find((m) => m.userId === userId);
        if (!target) throw REFUSALS.notFound();
        if (target.admin) throw REFUSALS.admin();
        if (target.role === 'owner' && role !== 'owner' && !keepsAnOwner(members, userId)) throw REFUSALS.lastOwner();
        if (target.role !== role) {
            await tx.query('UPDATE memberships SET role = $3 WHERE user_id = $1 AND creator_id = $2', [userId, creatorId, role]);
        }
        return { userId, from: target.role, to: role };
    });
}

export interface Removal { userId: string; role: TenantRole }

/** Take a member out of the workspace. Refuses a stranger, an account manager and the last owner. The person's account stays. */
export async function removeMember(creatorId: string, userId: string): Promise<Removal> {
    return withTransaction(async (tx) => {
        const members = await lockMembers(tx, creatorId);
        const target = members.find((m) => m.userId === userId);
        if (!target) throw REFUSALS.notFound();
        if (target.admin) throw REFUSALS.admin();
        if (target.role === 'owner' && !keepsAnOwner(members, userId)) throw REFUSALS.lastOwner();
        await tx.query('DELETE FROM memberships WHERE user_id = $1 AND creator_id = $2', [userId, creatorId]);
        return { userId, role: target.role };
    });
}

/** The ids a reset link may be made for: members of THIS workspace who are not the account manager. */
export async function assertResettable(creatorId: string, userId: string, exec: Exec = pool as unknown as Exec): Promise<void> {
    const found = await exec.query<{ user_role: string }>(
        `SELECT u.role AS user_role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.creator_id = $1 AND m.user_id = $2`,
        [creatorId, userId]
    );
    const row = found.rows[0];
    if (!row) throw REFUSALS.notFound();
    if (row.user_role === 'platform_admin') throw REFUSALS.admin();
}
