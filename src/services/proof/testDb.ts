/**
 * Tests only: the proof samples' tables, answered by SQL on top of the wizard's stand-in (`wizard/testDb.ts`, which sits on the profile's).
 * Imported by tests; production code never reads it. It lives in a directory of its own, like `wizard/` and `invites/`, because the stand-ins
 * a production module may not import are the files named `testDb.ts` (`profile/jsonb.test.ts` holds that line).
 *
 * Like the stand-ins it builds on, it reads each statement's PREDICATES out of the SQL it is given, so deleting a condition from a
 * production statement is something a test can see:
 *
 *   - the day's counter refuses a round only when the statement carries `WHERE … count < $2`: take it out and a fourth round is counted;
 *   - a verdict, a load and a list apply `creator_id = …` only when the statement says so: take it out and another tenant's id finds a row;
 *   - a verdict sets `tenant_confirmed_at` only when the statement carries its CASE, and merges `input` only when it says `input || …`;
 *   - the examples read applies the confirmation, the verdict and the `onboarding.filled_by` conditions only when they are in its SQL;
 *   - the first campaign is inserted OFF only when the statement says `false`, and not twice only when it carries `WHERE NOT EXISTS`.
 *
 * A `BEGIN` also snapshots the tables here (the onboarding rows and the campaigns), and a `ROLLBACK` restores them, so "a campaign that
 * cannot be written leaves the setup open" is asserted on the rows.
 */
import { randomUUID } from 'node:crypto';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../aiProviders/generate.js';
import { FAKE_KEYS } from '../aiProviders/testKeys.js';
import { SHOP_EG } from '../profile/fixtures.js';
import type { CreatorProfile } from '../profile/types.js';
import { FIRST_CAMPAIGN_SQL } from '../onboarding/proofCampaign.js';
import { CONFIRMED_COMMENT_SQL, COUNT_ROUND_SQL, INSERT_SQL, LIST_SQL, LOAD_SQL, VERDICT_SQL, type ProofRow } from '../onboarding/proofStore.js';
import { VOICE_EXAMPLES_SQL } from '../profile/voiceExamplesStore.js';
import { addNewcomer, installOnboardingWorld, NEWCOMER, type OnboardingRec, type OnboardingWorld } from '../wizard/testDb.js';
import type { State } from '../profile/testDb.js';

export { NEWCOMER, OWNER, OWNER_USER, NEW_OWNER_USER, ADMIN_USER, OPERATOR_USER, addNewcomer } from '../wizard/testDb.js';

export interface ExampleRec extends Omit<ProofRow, 'tenant_confirmed_at' | 'created_at'> {
    creator_id: string;
    tenant_confirmed_at: Date | null;
    created_at: Date;
}

export interface CampaignRec {
    id: string;
    creator_id: string;
    trigger_keyword: string;
    dm_template: string;
    public_reply_template: string | null;
    post_id: string | null;
    is_active: boolean;
    match_mode: string;
}

export interface ProofWorld extends OnboardingWorld {
    /** `voice_examples`. */
    examples: ExampleRec[];
    /** `app_rate_limit_counters` for today, by bucket. */
    counters: Map<string, number>;
    campaigns: CampaignRec[];
    /** The clock rows are stamped with: it moves forward by a second for every row written. */
    now(): Date;
}

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const exact = (sql: string): RegExp => new RegExp(`^${flat(sql).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/** What `pg` hands back for a row: jsonb parsed, a copy so a caller cannot change the table. */
const out = (r: ExampleRec): Record<string, unknown> => structuredClone({ ...r });

export function installProofWorld(options: { state?: State } = {}): ProofWorld {
    const world = installOnboardingWorld(options) as ProofWorld;
    world.examples = [];
    world.counters = new Map();
    world.campaigns = [];
    let tick = 0;
    world.now = () => new Date(Date.UTC(2026, 9, 14, 9, 0, 0) + (++tick) * 1000);

    const route = (pattern: RegExp, answer: (params: any[], sql: string) => { rows: any[]; rowCount?: number }): void => {
        world.db.routes.push([pattern, answer]);
    };

    // Transactions also snapshot and restore what this file owns, and the wizard's onboarding rows.
    let snapshot: { onboarding: Map<string, OnboardingRec>; examples: ExampleRec[]; campaigns: CampaignRec[]; counters: Map<string, number> } | null = null;
    const wrap = (source: string, before: () => void): void => {
        const at = world.db.routes.findIndex(([p]) => p.source === source);
        if (at < 0) throw new Error(`the profile stand-in has no ${source} route to wrap`);
        const [pattern, inner] = world.db.routes[at]!;
        world.db.routes[at] = [pattern, (params, sql) => { before(); return inner(params, sql); }];
    };
    wrap('^BEGIN$', () => {
        snapshot = { onboarding: structuredClone(world.onboarding), examples: structuredClone(world.examples), campaigns: structuredClone(world.campaigns), counters: new Map(world.counters) };
    });
    wrap('^COMMIT$', () => { snapshot = null; });
    wrap('^ROLLBACK$', () => {
        if (!snapshot) return;
        world.onboarding.clear();
        for (const [k, v] of snapshot.onboarding) world.onboarding.set(k, v);
        world.examples.splice(0, world.examples.length, ...snapshot.examples);
        world.campaigns.splice(0, world.campaigns.length, ...snapshot.campaigns);
        world.counters.clear();
        for (const [k, v] of snapshot.counters) world.counters.set(k, v);
        snapshot = null;
    });

    // ─── The day's counter ──────────────────────────────────────────────────────────────────
    route(exact(COUNT_ROUND_SQL), ([bucket, limit], sql) => {
        const have = world.counters.get(bucket);
        if (have === undefined) { world.counters.set(bucket, 1); return { rows: [{ count: 1 }] }; }
        // Only the condition the statement carries is applied.
        if (sql.includes('WHERE app_rate_limit_counters.count < $2') && have >= limit) return { rows: [] };
        world.counters.set(bucket, have + 1);
        return { rows: [{ count: have + 1 }] };
    });

    // ─── The cards ──────────────────────────────────────────────────────────────────────────
    const scoped = (sql: string, mine: string, theirs: unknown, row: ExampleRec): boolean => !sql.includes(mine) || row.creator_id === theirs;

    route(exact(LIST_SQL), ([creatorId], sql) => ({
        rows: world.examples
            .filter((r) => scoped(sql, 'creator_id = $1', creatorId, r) && ['caption', 'comment_dm'].includes(r.kind))
            .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
            .map(out),
    }));
    route(exact(LOAD_SQL), ([id, creatorId], sql) => ({
        rows: world.examples.filter((r) => r.id === id && scoped(sql, 'creator_id = $2', creatorId, r)).map(out),
    }));
    route(exact(INSERT_SQL), ([id, creatorId, profileVersion, kind, input, modelOutput, model]) => {
        const row: ExampleRec = {
            id, creator_id: creatorId, profile_version: profileVersion, kind, input: JSON.parse(input), model_output: modelOutput, final_text: null,
            verdict: null, verdict_by: null, tenant_confirmed_at: null, model, created_at: world.now(),
        };
        world.examples.push(row);
        return { rows: [out(row)] };
    });
    route(exact(VERDICT_SQL), ([id, creatorId, verdict, finalText, by, input], sql) => {
        const row = world.examples.find((r) => r.id === id && scoped(sql, 'creator_id = $2', creatorId, r));
        if (!row) return { rows: [] };
        row.verdict = verdict;
        row.final_text = finalText;
        row.verdict_by = by;
        if (sql.includes("tenant_confirmed_at = CASE WHEN $5::text = 'tenant' THEN NOW() ELSE NULL END")) row.tenant_confirmed_at = by === 'tenant' ? world.now() : null;
        row.input = sql.includes('input = input || $6::jsonb') ? { ...row.input, ...JSON.parse(input) } : JSON.parse(input);
        return { rows: [out(row)] };
    });
    route(exact(CONFIRMED_COMMENT_SQL), ([creatorId], sql) => ({
        rows: world.examples
            .filter((r) => r.creator_id === creatorId && r.kind === 'comment_dm'
                && (!sql.includes("verdict IN ('approved', 'edited')") || r.verdict === 'approved' || r.verdict === 'edited')
                && (!sql.includes('tenant_confirmed_at IS NOT NULL') || r.tenant_confirmed_at !== null))
            .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
            .slice(0, 1).map(out),
    }));

    // ─── What a prompt reads ────────────────────────────────────────────────────────────────
    route(exact(VOICE_EXAMPLES_SQL), ([creatorId, kind, limit], sql) => {
        const onboarding = world.onboarding.get(creatorId);
        return {
            rows: world.examples
                .filter((r) => r.creator_id === creatorId && r.kind === kind
                    && (!sql.includes("verdict IN ('approved', 'edited')") || r.verdict === 'approved' || r.verdict === 'edited')
                    && (!sql.includes('tenant_confirmed_at IS NOT NULL') || r.tenant_confirmed_at !== null)
                    && (!sql.includes('onboarding.filled_by IS NOT NULL') || (onboarding?.filled_by ?? null) !== null))
                .sort((a, b) => Number(b.verdict === 'edited') - Number(a.verdict === 'edited') || b.created_at.getTime() - a.created_at.getTime())
                .slice(0, limit)
                .map((r) => ({ model_output: r.model_output, final_text: r.final_text, verdict: r.verdict, tenant_confirmed_at: r.tenant_confirmed_at, created_at: r.created_at })),
        };
    });

    // ─── The first campaign ─────────────────────────────────────────────────────────────────
    route(exact(FIRST_CAMPAIGN_SQL), ([creatorId, keyword, dm, replies, mode], sql) => {
        if (sql.includes('WHERE NOT EXISTS') && world.campaigns.some((c) => c.creator_id === creatorId && c.trigger_keyword.toLowerCase() === String(keyword).toLowerCase())) return { rows: [] };
        const active = /NULL, (true|false), \$5::text/.exec(sql)?.[1] === 'true';
        const row: CampaignRec = { id: randomUUID(), creator_id: creatorId, trigger_keyword: keyword, dm_template: dm, public_reply_template: replies, post_id: null, is_active: active, match_mode: mode };
        world.campaigns.push(row);
        return { rows: [{ id: row.id }] };
    });

    return world;
}

/** A newcomer who has done W1 and W2 and so has a profile that can be activated, with the voice samples and offer the proof reads. */
export { NEWCOMER as PROOF_TENANT };
export function addProofTenant(world: ProofWorld, profile: unknown, patch: Partial<OnboardingRec> = {}): void {
    addNewcomer(world, profile, { status: 'in_progress', filled_by: 'tenant', started_at: new Date(1), ...patch });
}

// ─── What the proof tests share ─────────────────────────────────────────────────────────────

/** The Egyptian-Arabic shop (`profile/fixtures.ts`) with a voice guide and two captions of its own: what W1 to W3 would have confirmed. */
export function proofProfile(over: Partial<CreatorProfile> = {}): CreatorProfile {
    return {
        ...SHOP_EG,
        voice: { ...SHOP_EG.voice, guide: 'دافئ ومباشر', tone: ['ودّي', 'مباشر'], samples: ['شمعة لافندر جديدة وصلت ✨ ريحتها هادية', 'علبة الهدية جاهزة للعيد 🎁'] },
        ...over,
    };
}

const KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY'] as const;

/**
 * No provider has a key (every key the layer reads from the environment is taken away; the database has none), or one does. Returns what
 * puts the environment back, so a test (or a developer's shell with a real key in it) never decides what another test sees.
 */
export function providerKeys(present: boolean): () => void {
    const saved = Object.fromEntries(KEY_ENV.map((name) => [name, process.env[name]]));
    for (const name of KEY_ENV) delete process.env[name];
    if (present) process.env.ANTHROPIC_API_KEY = FAKE_KEYS.anthropic;
    return () => { for (const name of KEY_ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } };
}

export const CAPTION_ANSWER = { caption: 'شمعة جديدة تغيّر جو بيتك 🕯️\n\n✅ ريحة هادية\n✅ تولّع ساعات طويلة\n\nاسحب 👈\n\n#شموع #لافندر' };
export const COMMENT_ANSWER = {
    dm: 'أهلًا {username} 👋\nدا رابط «شمعة لافندر»:\n🔗 {url}',
    public_replies: ['وصلك الرابط على الخاص يا {username} 📩', 'شوف رسايلك يا {username} 🚀'],
};

export interface AiStub {
    calls: AiGenerateArgs[];
    /** What a call is answered with: JSON, or an error to throw. Defaults to a good caption and a good set of comment replies. */
    answer: (args: AiGenerateArgs) => unknown;
    restore(): void;
}

/** Whether a call is the caption card's or the comment card's, by the schema it was given. */
export const isCaptionCall = (args: AiGenerateArgs): boolean => 'caption' in ((args.schema as { properties?: Record<string, unknown> }).properties ?? {});

/** A stand-in for `generate` (`setAiCaller`): no route, no budget, no row, and every call recorded as the caller made it. */
export function installAiStub(): AiStub {
    const stub: AiStub = {
        calls: [],
        answer: (args) => (isCaptionCall(args) ? CAPTION_ANSWER : COMMENT_ANSWER),
        restore: () => undefined,
    };
    const previous = setAiCaller(async (args) => {
        stub.calls.push(args);
        const json = stub.answer(args);
        if (json instanceof Error) throw json;
        return {
            json, usage: { in: 100, out: 50 }, billed: [], model: 'test-model', provider: 'anthropic', stopReason: 'end_turn', elapsed_ms: 5,
            usd: 0.01, priced: true, costSource: 'table', effort: 'medium', route: 'default', usageId: 'usage-1',
        } as AiGenerateResult;
    });
    stub.restore = () => { setAiCaller(previous); };
    return stub;
}
