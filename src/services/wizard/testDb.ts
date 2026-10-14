/**
 * Tests only: the onboarding wizard's tables, answered by SQL on top of the profile stand-in (`profile/testDb.ts`), which the
 * wizard also reads and which the version conflict is tested against. Imported by tests; production code never reads it.
 *
 * Like `invites/testDb.ts`, the two writes that matter read their predicates OUT OF THE SQL they are given, so deleting a
 * condition from the production statement is something a test can see:
 *
 *   - the step write applies only to a row that is not `completed` when its SQL says `status <> 'completed'`, and only
 *     promotes `invited` when it carries that CASE: take the guard out and an autosave after Finish rewrites a finished tenant;
 *   - the completion applies only when `status <> 'completed'`: take that out and a second Finish rewrites `completed_at`.
 *
 * What it records: every funnel row (`events`) and every statement (`db.statements`), so "autosave never touches the profile"
 * is asserted on the SQL that ran, not on a belief about it.
 */
import { installProfileDb, OWNER, seededState, type ProfileDb, type State } from '../profile/testDb.js';

export { OWNER } from '../profile/testDb.js';
export const NEWCOMER = '44444444-4444-4444-8444-444444444444';
export const OWNER_USER = '33333333-3333-4333-8333-333333333333';
export const NEW_OWNER_USER = '55555555-5555-4555-8555-555555555555';
export const OPERATOR_USER = '66666666-6666-4666-8666-666666666666';
export const ADMIN_USER = '77777777-7777-4777-8777-777777777777';

export interface OnboardingRec {
    status: string;
    current_step: string | null;
    steps: Record<string, unknown>;
    filled_by: string | null;
    started_at: Date | null;
    completed_at: Date | null;
}

export interface EventRec {
    creator_id: string;
    user_id: string | null;
    actor: string;
    event: string;
    step: string | null;
    props: Record<string, unknown>;
}

export interface CreatorRec {
    id: string;
    name: string | null;
    instagram_username: string | null;
    website_url: string | null;
    is_active: boolean;
}

export interface MembershipRec { user_id: string; creator_id: string; role: string }

export interface OnboardingWorld {
    db: ProfileDb;
    state: State;
    onboarding: Map<string, OnboardingRec>;
    events: EventRec[];
    creators: Map<string, CreatorRec>;
    memberships: MembershipRec[];
    /** A database that has no onboarding table (v34 not applied): every statement that names it throws. */
    noOnboardingTable: boolean;
    /** Runs once, just before the next statement that matches: another request getting in between two of ours. */
    before: Array<{ pattern: RegExp; run: () => void }>;
    restore(): void;
}

const invited = (): OnboardingRec => ({ status: 'invited', current_step: null, steps: {}, filled_by: null, started_at: null, completed_at: null });

export function installOnboardingWorld(options: { state?: State } = {}): OnboardingWorld {
    const state = options.state ?? seededState();
    const db = installProfileDb(state);
    const world: OnboardingWorld = {
        db,
        state,
        onboarding: new Map(),
        events: [],
        creators: new Map(),
        memberships: [],
        noOnboardingTable: false,
        before: [],
        restore: () => db.restore(),
    };
    // The owner's tenant: completed, as v34 inserted it.
    world.creators.set(OWNER, { id: OWNER, name: 'Owner Studio', instagram_username: null, website_url: null, is_active: true });
    world.onboarding.set(OWNER, { status: 'completed', current_step: null, steps: {}, filled_by: null, started_at: new Date(0), completed_at: new Date(0) });

    const route = (pattern: RegExp, answer: (params: any[], sql: string) => { rows: any[]; rowCount?: number }): void => {
        db.routes.push([pattern, (params, sql) => {
            const hookAt = world.before.findIndex((hook) => hook.pattern.test(sql));
            if (hookAt >= 0) world.before.splice(hookAt, 1)[0]!.run();
            if (world.noOnboardingTable && /\bonboarding(_events)?\b/.test(sql)) {
                throw Object.assign(new Error('relation "onboarding" does not exist'), { code: '42P01' });
            }
            return answer(params, sql);
        }]);
    };
    /** What `pg` hands back for a row: jsonb parsed, a copy so a caller cannot change the table. */
    const out = (r: OnboardingRec): OnboardingRec => structuredClone(r);

    route(/^SELECT status, current_step, steps, filled_by, started_at, completed_at FROM onboarding WHERE creator_id = \$1$/, ([id]) => {
        const row = world.onboarding.get(id);
        return { rows: row ? [out(row)] : [] };
    });

    // `/auth/me` and the wizard's first read.
    route(/^SELECT name, instagram_username, website_url FROM creators WHERE id = \$1$/, ([id]) => {
        const c = world.creators.get(id);
        return { rows: c ? [{ name: c.name, instagram_username: c.instagram_username, website_url: c.website_url }] : [] };
    });
    route(/^SELECT id, name, instagram_page_id, facebook_page_id, token_status FROM creators WHERE is_active = true ORDER BY name NULLS LAST, created_at$/, () => ({
        rows: [...world.creators.values()].filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name, instagram_page_id: null, facebook_page_id: null, token_status: null })),
    }));
    route(/^SELECT c\.id, c\.name, c\.instagram_page_id, c\.facebook_page_id, c\.token_status, m\.role FROM creators c JOIN memberships m ON m\.creator_id = c\.id WHERE m\.user_id = \$1 AND c\.is_active = true ORDER BY c\.name NULLS LAST, c\.created_at$/, ([userId]) => ({
        rows: world.memberships.filter((m) => m.user_id === userId).flatMap((m) => {
            const c = world.creators.get(m.creator_id);
            return c && c.is_active ? [{ id: c.id, name: c.name, instagram_page_id: null, facebook_page_id: null, token_status: null, role: m.role }] : [];
        }),
    }));
    route(/^SELECT role FROM memberships WHERE user_id = \$1 AND creator_id = \$2 LIMIT 1$/, ([userId, creatorId]) => {
        const m = world.memberships.find((x) => x.user_id === userId && x.creator_id === creatorId);
        return { rows: m ? [{ role: m.role }] : [] };
    });

    // The step write: one UPDATE of one step's entry.
    route(/^UPDATE onboarding SET status = CASE WHEN status = 'invited' THEN 'in_progress' ELSE status END, started_at = COALESCE\(started_at, NOW\(\)\), filled_by = /, ([id, step, by, currentStep, entry], sql) => {
        const row = world.onboarding.get(id);
        if (!row) return { rows: [] };
        // Only the conditions the statement carries are applied.
        if (sql.includes("status <> 'completed'") && row.status === 'completed') return { rows: [] };
        if (sql.includes("WHEN status = 'invited' THEN 'in_progress'") && row.status === 'invited') row.status = 'in_progress';
        row.started_at = row.started_at ?? new Date();
        row.filled_by = by === 'admin' ? 'admin' : row.filled_by ?? by;
        if (currentStep !== null) row.current_step = currentStep;
        row.steps = { ...row.steps, [step]: JSON.parse(entry) };
        return { rows: [out(row)] };
    });

    // Finish.
    route(/^UPDATE onboarding SET status = 'completed', completed_at = NOW\(\), current_step = 'done', started_at = COALESCE\(started_at, NOW\(\)\), filled_by = /, ([id, by], sql) => {
        const row = world.onboarding.get(id);
        if (!row) return { rows: [] };
        if (sql.includes("status <> 'completed'") && row.status === 'completed') return { rows: [] };
        row.status = 'completed';
        row.completed_at = new Date();
        row.current_step = 'done';
        row.started_at = row.started_at ?? new Date();
        row.filled_by = by === 'admin' ? 'admin' : row.filled_by ?? by;
        return { rows: [{ started_at: row.started_at, completed_at: row.completed_at, filled_by: row.filled_by }] };
    });

    route(/^INSERT INTO onboarding_events \(creator_id, user_id, actor, event, step, props\) VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb\)$/, ([creator_id, user_id, actor, event, step, props]) => {
        world.events.push({ creator_id, user_id, actor, event, step, props: JSON.parse(props) });
        return { rows: [] };
    });

    return world;
}

/** A tenant that has been created and not started: the row P16 inserts, and its stored default profile. */
export function addNewcomer(world: OnboardingWorld, profile: unknown, patch: Partial<OnboardingRec> = {}): void {
    world.creators.set(NEWCOMER, { id: NEWCOMER, name: 'Nour Shop', instagram_username: 'nourshop', website_url: 'https://nour.example', is_active: true });
    world.onboarding.set(NEWCOMER, { ...invited(), ...patch });
    world.state.profiles.set(NEWCOMER, { profile, version: 1, activated_at: null, updated_by: null });
    world.memberships.push({ user_id: NEW_OWNER_USER, creator_id: NEWCOMER, role: 'owner' });
}
