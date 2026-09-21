/**
 * The refusals the admin surface needs, and the validation that feeds them.
 *
 * Separated from the routes for the usual reason in this codebase: a decision that must be
 * right is worth being able to exercise without a database or an HTTP server. Two families
 * live here.
 *
 * **Lockout.** `platform_admin` is the only role that can create users, grant memberships or
 * reach the admin surface at all. Demote or deactivate the last active one and there is no
 * way back in through the product — the recovery path is an UPDATE in the Supabase SQL editor,
 * which is exactly the situation this whole feature exists to remove. So the guard counts the
 * *other* active platform admins and refuses when the answer is zero.
 *
 * **Identifier validation.** `instagram_page_id` routes every webhook: `getCreatorByPageId`
 * matches `entry.id` against it, and a typo means deliveries resolve no tenant and are dropped
 * with a log line nobody reads. Until now the field could only be corrected with SQL. Letting
 * it be edited means validating it, and validating it means saying what a Meta page id is.
 */

// ─── Lockout ────────────────────────────────────────────────────────────────────────────

export const PLATFORM_ADMIN = 'platform_admin';
export const USER_ROLE = 'user';

/** The roles a user row may hold. Anything else is a 400, not a silently stored string. */
export const USER_ROLES: readonly string[] = [PLATFORM_ADMIN, USER_ROLE];

export function isUserRole(value: unknown): value is 'platform_admin' | 'user' {
    return typeof value === 'string' && USER_ROLES.includes(value);
}

/**
 * A stable machine-readable code on the refusal.
 *
 * The dashboard needs to tell "you cannot do that, here is why" apart from "something went
 * wrong", and matching on prose is how a UI breaks the next time somebody rewords an error.
 */
export const LOCKOUT_CODE = 'LAST_PLATFORM_ADMIN';

export interface UserLike {
    id: string;
    role: string;
    is_active: boolean;
}

export interface UserPatch {
    role?: unknown;
    is_active?: unknown;
}

export interface LockoutRefusal {
    code: typeof LOCKOUT_CODE;
    error: string;
}

/**
 * Would this patch remove the last way into the admin surface?
 *
 * `otherActiveAdmins` counts active `platform_admin` rows **other than** `target`. Passing the
 * count in rather than querying here is what makes the rule testable, and it keeps the route
 * honest about the race: the count and the UPDATE are two statements, so the route runs both
 * inside one transaction.
 *
 * Returns null when the patch is fine. Note that a target who is not currently an active
 * platform admin can never trip this — demoting an already-inactive admin, or one of three,
 * changes nothing about who can get in.
 */
export function lockoutRefusal(
    target: UserLike,
    patch: UserPatch,
    otherActiveAdmins: number
): LockoutRefusal | null {
    // Only an *active* platform admin is currently holding the door open.
    if (target.role !== PLATFORM_ADMIN || !target.is_active) return null;
    if (otherActiveAdmins > 0) return null;

    const demoting = patch.role !== undefined && patch.role !== PLATFORM_ADMIN;
    const deactivating = patch.is_active === false;
    if (!demoting && !deactivating) return null;

    const what = demoting && deactivating
        ? 'demote and deactivate'
        : demoting ? 'demote' : 'deactivate';

    return {
        code: LOCKOUT_CODE,
        error:
            `Refusing to ${what} the last active platform admin — nothing would be able to reach ` +
            'the admin surface afterwards, and the only way back in would be editing the users ' +
            'table directly. Create or re-activate another platform admin first.',
    };
}

// ─── Identifier validation ──────────────────────────────────────────────────────────────

/**
 * A Meta page id.
 *
 * Digits only. Instagram Business account ids are ~17 digits and Facebook page ids ~15, but
 * both have changed length over the years, so the bound is generous rather than exact — the
 * point is to catch the paste that brought a URL, an @handle or a trailing newline with it,
 * not to predict Meta's id scheme. A lower bound of 3 rejects the two mistakes that actually
 * happen: an empty string and a single stray character.
 */
const PAGE_ID_PATTERN = /^\d{3,32}$/;

export function isPageId(value: unknown): value is string {
    return typeof value === 'string' && PAGE_ID_PATTERN.test(value);
}

export const PAGE_ID_HINT =
    'A page id is the numeric id Meta shows for the account — digits only, 3 to 32 of them. ' +
    'Not a URL and not an @handle.';

/**
 * Normalise one field of a PATCH body into a value, an explicit clear, or an error.
 *
 * `undefined` means "not supplied, leave it alone" and `null` means "clear it", and those are
 * genuinely different intentions that a single `COALESCE($1, column)` cannot express — which
 * is why the existing PATCH could never blank a facebook_page_id.
 */
export type FieldUpdate<T> =
    | { kind: 'absent' }
    | { kind: 'set'; value: T }
    | { kind: 'clear' }
    | { kind: 'error'; error: string };

export function readPageIdField(raw: unknown, field: string, nullable: boolean): FieldUpdate<string> {
    if (raw === undefined) return { kind: 'absent' };

    if (raw === null || raw === '') {
        if (!nullable) {
            return {
                kind: 'error',
                error: `${field} cannot be empty — it is how every webhook for this tenant is routed.`,
            };
        }
        return { kind: 'clear' };
    }

    const trimmed = typeof raw === 'string' ? raw.trim() : raw;
    if (!isPageId(trimmed)) {
        return { kind: 'error', error: `${field} is not a valid Meta page id. ${PAGE_ID_HINT}` };
    }
    return { kind: 'set', value: trimmed as string };
}

/**
 * The verify token, validated exactly as `POST /api/settings/webhook-token` already does.
 *
 * Same rules deliberately: two endpoints that accept the same column with different rules is
 * how a value that one of them rejects gets in through the other.
 */
export function readVerifyTokenField(raw: unknown): FieldUpdate<string> {
    if (raw === undefined) return { kind: 'absent' };
    if (raw === null || raw === '') return { kind: 'clear' };

    if (typeof raw !== 'string') {
        return { kind: 'error', error: 'webhook_verify_token must be a string.' };
    }
    const token = raw.trim();
    if (token.length < 8) {
        return { kind: 'error', error: 'Verify token must be at least 8 characters.' };
    }
    if (/\s/.test(token)) {
        return { kind: 'error', error: 'Verify token cannot contain spaces or line breaks.' };
    }
    return { kind: 'set', value: token };
}

/**
 * A page size from a query string, clamped rather than refused.
 *
 * "Absent" has to be decided before `Number`, not after: `Number('')` and `Number(null)` are
 * both `0`, which is finite, so `?limit=` — what a UI emits when its input is empty — would
 * clamp to 1 and return a single row instead of the default page. There is also nothing an
 * operator can do with a 400 about a page size, so an out-of-range number is clamped.
 */
export function clampLimit(raw: unknown, fallback: number, max: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;

    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** Shortest password this product accepts. Mirrors the value already used for user creation. */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(raw: unknown): string | null {
    if (typeof raw !== 'string') return 'A password is required.';
    if (raw.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return null;
}
