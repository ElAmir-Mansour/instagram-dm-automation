/**
 * Tests only: an in-memory stand-in for the tables the invite flow touches (`invites`, `users`, `memberships`, `creators`,
 * `onboarding`, `app_settings`, `audit_log`), answering by SQL like `monteur/testDb.ts`.
 *
 * What makes it worth more than a script of canned answers: **the single-use claim reads the predicates out of the SQL it is
 * given.** `UPDATE invites SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at >
 * NOW()` is answered by checking only the conditions that sentence actually contains, so deleting `AND used_at IS NULL` from
 * the production statement makes a second accept succeed here, and the test for it fails. A stand-in that matched the whole
 * statement would answer "no rows" to a mutated one and fail every test for the wrong reason, or one that ignored the
 * predicates would pass whatever the code did. The same goes for `revoked_at IS NULL` and `expires_at > NOW()`.
 *
 * A transaction is a snapshot taken at BEGIN and restored at ROLLBACK, so a claim followed by a failure leaves the link
 * unused, as Postgres would.
 */
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface CreatorRec { id: string; name: string | null; is_active: boolean }
export interface UserRec {
    id: string; email: string; password_hash: string; role: string; token_version: number; is_active: boolean; last_login_at: Date | null;
}
export interface MembershipRec { user_id: string; creator_id: string; role: string }
export interface InviteRec {
    id: string; token_hash: string; creator_id: string; email: string | null; membership_role: string; purpose: string; user_id: string | null;
    created_by: string | null; created_at: Date; expires_at: Date; first_opened_at: Date | null; open_count: number;
    used_at: Date | null; used_by: string | null; revoked_at: Date | null;
}
export interface AuditRec {
    actor_user_id: string | null; actor_email: string | null; action: string; target_type: string | null; target_id: string | null;
    detail: Record<string, unknown>;
}

/** One row of `onboarding_events`, as the funnel stores it (P31). */
export interface EventRec { creator_id: string; user_id: string | null; actor: string; event: string; step: string | null; props: Record<string, unknown> }

export interface InviteWorld {
    db: FakeDb;
    creators: Map<string, CreatorRec>;
    users: Map<string, UserRec>;
    memberships: MembershipRec[];
    invites: InviteRec[];
    onboarding: Map<string, { status: string; started_at: Date | null }>;
    settings: Record<string, string>;
    /** The language each tenant's stored profile says it writes in (`creator_profiles.profile.language.primary`); none: no profile. */
    profileLanguage: Map<string, string>;
    audits: AuditRec[];
    /** Every funnel row written (`onboarding_events`): what an opened, accepted or created link recorded. */
    events: EventRec[];
    /** Throws on the next statement that matches, once: the way a dropped connection or a duplicate key would. */
    failNext: { pattern: RegExp; error: Error } | null;
    /**
     * Runs once, just BEFORE the next statement that matches is answered: another request getting in between two of this one's
     * statements. It is how a test loses a race deterministically, instead of hoping two promises interleave.
     */
    before: Array<{ pattern: RegExp; run: () => void }>;
    addCreator(n: number, name: string, extra?: Partial<CreatorRec>): CreatorRec;
    addUser(n: number, email: string, extra?: Partial<UserRec>): UserRec;
    addMember(userId: string, creatorId: string, role?: string): void;
    restore(): void;
}

const lowerEq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function installInviteWorld(): InviteWorld {
    const db = installFakeDb();
    const world: InviteWorld = {
        db,
        creators: new Map(),
        users: new Map(),
        memberships: [],
        invites: [],
        onboarding: new Map(),
        settings: {},
        profileLanguage: new Map(),
        audits: [],
        events: [],
        failNext: null,
        before: [],
        addCreator(n, name, extra = {}) {
            const rec = { id: uuid(n), name, is_active: true, ...extra };
            world.creators.set(rec.id, rec);
            return rec;
        },
        addUser(n, email, extra = {}) {
            const rec: UserRec = { id: uuid(n), email, password_hash: 'scrypt:existing:hash', role: 'user', token_version: 1, is_active: true, last_login_at: null, ...extra };
            world.users.set(rec.id, rec);
            return rec;
        },
        addMember(userId, creatorId, role = 'owner') {
            world.memberships.push({ user_id: userId, creator_id: creatorId, role });
        },
        restore: () => db.restore(),
    };

    let snapshot: Pick<InviteWorld, 'users' | 'memberships' | 'invites' | 'onboarding'> | null = null;
    const route = (pattern: RegExp, answer: (params: any[], sql: string) => { rows: any[]; rowCount?: number }): void => {
        db.routes.push([pattern, (params, sql) => {
            const hookAt = world.before.findIndex((hook) => hook.pattern.test(sql));
            if (hookAt >= 0) {
                world.before.splice(hookAt, 1)[0]!.run();
                // Another request COMMITTED what the hook did: this transaction's rollback must not undo it.
                if (snapshot) {
                    snapshot = {
                        users: structuredClone(world.users), memberships: structuredClone(world.memberships),
                        invites: structuredClone(world.invites), onboarding: structuredClone(world.onboarding),
                    };
                }
            }
            if (world.failNext && world.failNext.pattern.test(sql)) {
                const { error } = world.failNext;
                world.failNext = null;
                throw error;
            }
            return answer(params, sql);
        }]);
    };
    const byHash = (hash: string): InviteRec | undefined => world.invites.find((r) => r.token_hash === hash);
    const byId = (id: string): InviteRec | undefined => world.invites.find((r) => r.id === id);
    const publicInvite = (r: InviteRec) => ({
        id: r.id, creator_id: r.creator_id, email: r.email, membership_role: r.membership_role, purpose: r.purpose, user_id: r.user_id,
        created_at: r.created_at, expires_at: r.expires_at, first_opened_at: r.first_opened_at, open_count: r.open_count,
        used_at: r.used_at, revoked_at: r.revoked_at,
    });

    // ── Transactions ──
    route(/^BEGIN$/, () => {
        snapshot = {
            users: structuredClone(world.users), memberships: structuredClone(world.memberships),
            invites: structuredClone(world.invites), onboarding: structuredClone(world.onboarding),
        };
        return { rows: [] };
    });
    route(/^COMMIT$/, () => { snapshot = null; return { rows: [] }; });
    route(/^ROLLBACK$/, () => {
        if (snapshot) {
            world.users = snapshot.users; world.memberships = snapshot.memberships; world.invites = snapshot.invites; world.onboarding = snapshot.onboarding;
            snapshot = null;
        }
        return { rows: [] };
    });

    // ── Settings and the audit trail ──
    route(/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (world.settings[key] === undefined ? { rows: [] } : { rows: [{ value: world.settings[key], is_secret: false }] }));
    route(/^INSERT INTO app_settings /, ([key, value]) => { world.settings[key] = value; return { rows: [], rowCount: 1 }; });
    route(/^DELETE FROM app_settings WHERE key = \$1$/, ([key]) => { const had = key in world.settings; delete world.settings[key]; return { rows: [], rowCount: had ? 1 : 0 }; });
    route(/^SELECT email FROM users WHERE id = \$1$/, ([id]) => ({ rows: world.users.has(id) ? [{ email: world.users.get(id)!.email }] : [] }));
    route(/^INSERT INTO audit_log /, ([actorUserId, actorEmail, action, targetType, targetId, detail]) => {
        world.audits.push({ actor_user_id: actorUserId, actor_email: actorEmail, action, target_type: targetType, target_id: targetId, detail: JSON.parse(detail) });
        return { rows: [{ id: `audit-${world.audits.length}` }] };
    });

    // ── Tenants and users ──
    route(/^SELECT profile #>> '\{language,primary\}' AS lang FROM creator_profiles WHERE creator_id = \$1$/, ([id]) => ({
        rows: world.profileLanguage.has(id) ? [{ lang: world.profileLanguage.get(id) }] : [],
    }));
    route(/^SELECT id, name, is_active FROM creators WHERE id = \$1$/, ([id]) => ({ rows: world.creators.has(id) ? [{ ...world.creators.get(id)! }] : [] }));
    route(/^SELECT id FROM creators WHERE id = \$1$/, ([id]) => ({ rows: world.creators.has(id) ? [{ id }] : [] }));
    route(/^SELECT u\.id, u\.email, u\.role, u\.is_active, EXISTS/, ([userId, creatorId]) => {
        const user = world.users.get(userId);
        if (!user) return { rows: [] };
        const membership = world.memberships.find((m) => m.user_id === userId && m.creator_id === creatorId);
        return { rows: [{ id: user.id, email: user.email, role: user.role, is_active: user.is_active, is_member: Boolean(membership), membership_role: membership?.role ?? null }] };
    });
    route(/^SELECT id, email, role, token_version, is_active FROM users WHERE id = \$1$/, ([id]) => {
        const u = world.users.get(id);
        return { rows: u ? [{ id: u.id, email: u.email, role: u.role, token_version: u.token_version, is_active: u.is_active }] : [] };
    });
    route(/^SELECT token_version, is_active FROM users WHERE id = \$1$/, ([id]) => {
        const u = world.users.get(id);
        return { rows: u ? [{ token_version: u.token_version, is_active: u.is_active }] : [] };
    });
    // The login (`POST /auth/login`): the account by address, its first membership, and the stamp.
    route(/^SELECT id, password_hash, role, token_version, is_active FROM users WHERE lower\(email\) = lower\(\$1\)$/, ([email]) => ({
        rows: [...world.users.values()].filter((u) => lowerEq(u.email, email)).map((u) => ({ ...u })),
    }));
    route(/^SELECT role FROM memberships WHERE user_id = \$1 AND creator_id = \$2 LIMIT 1$/, ([userId, creatorId]) => {
        const m = world.memberships.find((x) => x.user_id === userId && x.creator_id === creatorId);
        return { rows: m ? [{ role: m.role }] : [] };
    });
    route(/^SELECT creator_id FROM memberships WHERE user_id = \$1 ORDER BY created_at, creator_id LIMIT 1$/, ([userId]) => {
        const m = world.memberships.find((x) => x.user_id === userId);
        return { rows: m ? [{ creator_id: m.creator_id }] : [] };
    });
    route(/^UPDATE users SET last_login_at = NOW\(\) WHERE id = \$1$/, ([id]) => {
        const u = world.users.get(id);
        if (u) u.last_login_at = new Date();
        return { rows: [] };
    });
    route(/^SELECT id FROM creators WHERE is_active = true ORDER BY created_at LIMIT 1$/, () => {
        const first = [...world.creators.values()].find((c) => c.is_active);
        return { rows: first ? [{ id: first.id }] : [] };
    });
    route(/^SELECT id FROM users WHERE lower\(email\) = lower\(\$1\)$/, ([email]) => ({ rows: [...world.users.values()].filter((u) => lowerEq(u.email, email)).map((u) => ({ id: u.id })) }));
    route(/^INSERT INTO users \(email, password_hash, role, last_login_at\)/, ([email, hash]) => {
        if ([...world.users.values()].some((u) => lowerEq(u.email, email))) throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
        const id = uuid(1000 + world.users.size);
        const rec: UserRec = { id, email: String(email).toLowerCase(), password_hash: hash, role: 'user', token_version: 1, is_active: true, last_login_at: new Date() };
        world.users.set(id, rec);
        return { rows: [{ id, email: rec.email, token_version: rec.token_version }] };
    });
    route(/^UPDATE users SET password_hash = \$2, token_version = token_version \+ 1/, ([id, hash], sql) => {
        const u = world.users.get(id);
        if (!u) return { rows: [] };
        // The two guards in the statement are read from it, like the invite claim's.
        if (sql.includes('is_active = TRUE') && !u.is_active) return { rows: [] };
        if (sql.includes("role <> 'platform_admin'") && u.role === 'platform_admin') return { rows: [] };
        u.password_hash = hash;
        u.token_version += 1;
        u.last_login_at = new Date();
        return { rows: [{ id: u.id, email: u.email, token_version: u.token_version }] };
    });
    route(/^SELECT 1 FROM memberships WHERE user_id = \$1 AND creator_id = \$2$/, ([userId, creatorId]) => ({
        rows: world.memberships.some((m) => m.user_id === userId && m.creator_id === creatorId) ? [{ '?column?': 1 }] : [],
    }));
    route(/^INSERT INTO memberships \(user_id, creator_id, role\) VALUES \(\$1, \$2, \$3\) ON CONFLICT/, ([userId, creatorId, role]) => {
        if (world.memberships.some((m) => m.user_id === userId && m.creator_id === creatorId)) return { rows: [] };
        world.memberships.push({ user_id: userId, creator_id: creatorId, role });
        return { rows: [{ user_id: userId }] };
    });
    route(/^INSERT INTO memberships \(user_id, creator_id, role\) VALUES \(\$1, \$2, \$3\)$/, ([userId, creatorId, role]) => {
        world.memberships.push({ user_id: userId, creator_id: creatorId, role });
        return { rows: [] };
    });
    route(/^UPDATE onboarding SET status = 'in_progress'/, ([creatorId]) => {
        const row = world.onboarding.get(creatorId);
        if (row && row.status === 'invited') { row.status = 'in_progress'; row.started_at = row.started_at ?? new Date(); }
        return { rows: [] };
    });
    route(/^SELECT status FROM onboarding WHERE creator_id = \$1$/, ([creatorId]) => ({ rows: world.onboarding.has(creatorId) ? [{ status: world.onboarding.get(creatorId)!.status }] : [] }));

    // ── Invites ──
    route(/^INSERT INTO invites \(token_hash,/, ([hash, creatorId, email, role, purpose, userId, createdBy, expiresAt]) => {
        if (world.invites.some((r) => r.token_hash === hash)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        const rec: InviteRec = {
            id: uuid(5000 + world.invites.length), token_hash: hash, creator_id: creatorId, email, membership_role: role, purpose, user_id: userId,
            created_by: createdBy, created_at: new Date(), expires_at: expiresAt, first_opened_at: null, open_count: 0, used_at: null, used_by: null, revoked_at: null,
        };
        world.invites.push(rec);
        return { rows: [publicInvite(rec)] };
    });
    route(/^SELECT i\.id, i\.token_hash, i\.creator_id, i\.email, i\.membership_role, i\.purpose, i\.user_id, i\.expires_at, i\.used_at, i\.revoked_at, i\.open_count, c\.name AS tenant_name/, ([hash]) => {
        const r = byHash(hash);
        if (!r) return { rows: [] };
        const creator = world.creators.get(r.creator_id);
        const user = r.user_id ? world.users.get(r.user_id) : undefined;
        return { rows: [{ ...r, tenant_name: creator?.name ?? null, tenant_active: creator?.is_active ?? false, user_email: user?.email ?? null }] };
    });
    route(/^UPDATE invites SET first_opened_at = COALESCE\(first_opened_at, NOW\(\)\), open_count = open_count \+ 1 WHERE id = \$1 RETURNING open_count, created_at$/, ([id]) => {
        const r = byId(id);
        if (!r) return { rows: [] };
        r.first_opened_at = r.first_opened_at ?? new Date();
        r.open_count += 1;
        return { rows: [{ open_count: r.open_count, created_at: r.created_at }] };
    });
    route(/^INSERT INTO onboarding_events \(creator_id, user_id, actor, event, step, props\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb\)$/, ([creator_id, user_id, actor, event, step, props]) => {
        world.events.push({ creator_id, user_id, actor, event, step, props: JSON.parse(props) });
        return { rows: [] };
    });
    route(/^UPDATE invites SET used_at = NOW\(\) WHERE token_hash = \$1/, ([hash], sql) => {
        const r = byHash(hash);
        if (!r) return { rows: [] };
        // Only the conditions the statement carries are applied: take one out of the SQL and it stops being enforced here.
        if (sql.includes('used_at IS NULL') && r.used_at) return { rows: [] };
        if (sql.includes('revoked_at IS NULL') && r.revoked_at) return { rows: [] };
        if (sql.includes('expires_at > NOW()') && !(r.expires_at.getTime() > Date.now())) return { rows: [] };
        r.used_at = new Date();
        return { rows: [{ id: r.id, created_at: r.created_at }] };
    });
    route(/^UPDATE invites SET used_by = \$2 WHERE id = \$1$/, ([id, userId]) => {
        const r = byId(id);
        if (r) r.used_by = userId;
        return { rows: [] };
    });
    route(/^UPDATE invites SET revoked_at = NOW\(\) WHERE id = \$1/, ([id], sql) => {
        const r = byId(id);
        if (!r) return { rows: [] };
        if (sql.includes('used_at IS NULL') && r.used_at) return { rows: [] };
        if (sql.includes('revoked_at IS NULL') && r.revoked_at) return { rows: [] };
        r.revoked_at = new Date();
        return { rows: [{ id: r.id, creator_id: r.creator_id, purpose: r.purpose }] };
    });
    route(/^SELECT id, creator_id, purpose, used_at FROM invites WHERE id = \$1$/, ([id]) => {
        const r = byId(id);
        return { rows: r ? [{ id: r.id, creator_id: r.creator_id, purpose: r.purpose, used_at: r.used_at }] : [] };
    });
    route(/^SELECT id, creator_id, email, membership_role, purpose, user_id, used_at, revoked_at, expires_at FROM invites WHERE id = \$1 FOR UPDATE$/, ([id]) => {
        const r = byId(id);
        return { rows: r ? [{ ...r }] : [] };
    });
    route(/^UPDATE invites SET revoked_at = COALESCE\(revoked_at, NOW\(\)\) WHERE id = \$1$/, ([id]) => {
        const r = byId(id);
        if (r) r.revoked_at = r.revoked_at ?? new Date();
        return { rows: [] };
    });
    route(/^SELECT i\.id, i\.creator_id, i\.email, i\.membership_role, i\.purpose, i\.user_id, i\.created_at, i\.expires_at, i\.first_opened_at, i\.open_count, i\.used_at, i\.revoked_at, uu\.email AS used_by_email/, ([creatorId]) => ({
        rows: world.invites
            .filter((r) => r.creator_id === creatorId)
            .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id))
            .slice(0, 20)
            .map((r) => ({ ...publicInvite(r), used_by_email: r.used_by ? world.users.get(r.used_by)?.email ?? null : null })),
    }));

    return world;
}
