/**
 * Tests only: an in-memory stand-in for the tables the video memory touches (`reel_analyses`, the `creators` columns the indexer reads, and the `scheduled_posts` rows
 * that link a reel to its YouTube copy), installed over `pool.query` in FRONT of whatever is there (the AI layer's own stand-in, `aiProviders/testDb.ts`, for `app_settings`
 * and `ai_usage`). Not a test file itself, so `npm test` does not run it.
 *
 * It answers the exact statements of `reelLibrary.ts` and throws on any other statement that names one of its tables, so a changed query fails a test instead of passing
 * against a stand-in that does not know it. The meaning of each was checked against a real PostgreSQL 17 holding migration v60's table (2026-10-30): the partial unique
 * index as the conflict target, a failure that never replaces an `ok` row (`DO UPDATE … WHERE status <> 'ok'` returns no row), `NUMERIC(12,6)` read back as text, and the
 * `jsonb_to_recordset` insert.
 */
import { pool } from '../../config/db.js';

export interface FakeReel {
    id: string;
    creator_id: string;
    ig_media_id: string | null;
    permalink: string | null;
    youtube_url: string | null;
    posted_at: Date | null;
    status: string;
    result: Record<string, unknown>;
    model: string | null;
    ms: number | null;
    /** As pg returns NUMERIC: text, to six places. */
    usd: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface FakeCreator {
    id: string;
    instagram_page_id: string | null;
    page_access_token: string | null;
    is_active: boolean;
}

export interface FakeScheduled {
    creator_id: string;
    platform: string;
    status: string;
    published_post_id: string | null;
    group_id: string | null;
    scheduled_time: Date;
}

export interface ReelDb {
    reels: FakeReel[];
    creators: Map<string, FakeCreator>;
    scheduled: FakeScheduled[];
    /** Every statement that named one of these tables, whitespace collapsed, with its parameters. */
    statements: { sql: string; params: unknown[] }[];
    /** What `created_at` and `updated_at` are for rows written from here on. */
    now: Date;
    /** Fails the next `times` statements that match, with `error`. */
    failOn(pattern: RegExp, error?: Error, times?: number): void;
}

const TABLES = /\b(reel_analyses|scheduled_posts|creators)\b/;
const iso = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(String(v)));
const usdText = (v: unknown): string | null => (v === null || v === undefined ? null : Number(v).toFixed(6));

export function installReelDb(): ReelDb {
    const inner = pool.query as unknown as (text: string, params?: unknown[]) => Promise<unknown>;
    let nextId = 1;
    const failures: { pattern: RegExp; error: Error; times: number }[] = [];
    const db: ReelDb = {
        reels: [],
        creators: new Map(),
        scheduled: [],
        statements: [],
        now: new Date('2026-11-01T09:00:00.000Z'),
        failOn: (pattern, error = new Error('connection terminated unexpectedly'), times = 1) => { failures.push({ pattern, error, times }); },
    };
    const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
    const uuid = (): string => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
    const find = (creator: string, media: string | null) => db.reels.find((r) => r.creator_id === creator && media !== null && r.ig_media_id === media);
    const newest = (a: FakeReel, b: FakeReel): number =>
        (b.posted_at?.getTime() ?? Number.NEGATIVE_INFINITY) - (a.posted_at?.getTime() ?? Number.NEGATIVE_INFINITY) || b.created_at.getTime() - a.created_at.getTime();

    (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (!TABLES.test(sql)) return inner(text, params);
        db.statements.push({ sql, params });
        const failure = failures.find((f) => f.times > 0 && f.pattern.test(sql));
        if (failure) {
            failure.times -= 1;
            throw failure.error;
        }

        // ── creators ──
        let m = /^SELECT (id(?:, [a-z_]+)*) FROM creators WHERE id = \$1$/.exec(sql);
        if (m) {
            const row = db.creators.get(String(params[0]));
            return row ? ok([{ ...row }]) : ok();
        }
        if (/^SELECT id FROM creators WHERE is_active = TRUE AND page_access_token IS NOT NULL ORDER BY created_at$/.test(sql)) {
            return ok([...db.creators.values()].filter((c) => c.is_active && c.page_access_token).map((c) => ({ id: c.id })));
        }

        // ── scheduled_posts: the YouTube sibling ──
        if (/^SELECT group_id, platform, status, published_post_id FROM scheduled_posts WHERE creator_id = \$1 AND group_id IS NOT NULL AND published_post_id IS NOT NULL AND published_post_id <> '' AND platform IN \('instagram', 'both', 'youtube'\) ORDER BY scheduled_time DESC$/.test(sql)) {
            const rows = db.scheduled
                .filter((s) => s.creator_id === params[0] && s.group_id && s.published_post_id && ['instagram', 'both', 'youtube'].includes(s.platform))
                .sort((a, b) => b.scheduled_time.getTime() - a.scheduled_time.getTime())
                .map(({ group_id, platform, status, published_post_id }) => ({ group_id, platform, status, published_post_id }));
            return ok(rows);
        }

        // ── reel_analyses: writers ──
        if (/^INSERT INTO reel_analyses \(creator_id, ig_media_id, permalink, posted_at, status\) SELECT \$1::uuid, r\.ig_media_id, r\.permalink, r\.posted_at, 'pending' FROM jsonb_to_recordset\(\$2::jsonb\) AS r\(ig_media_id text, permalink text, posted_at timestamptz\) ON CONFLICT \(creator_id, ig_media_id\) WHERE ig_media_id IS NOT NULL DO UPDATE SET status = 'pending', permalink = COALESCE\(EXCLUDED\.permalink, reel_analyses\.permalink\), posted_at = COALESCE\(EXCLUDED\.posted_at, reel_analyses\.posted_at\), updated_at = NOW\(\) WHERE reel_analyses\.status <> 'ok'$/.test(sql)) {
            const creator = String(params[0]);
            let written = 0;
            for (const r of JSON.parse(String(params[1])) as { ig_media_id: string; permalink: string | null; posted_at: string | null }[]) {
                const had = find(creator, r.ig_media_id);
                if (!had) {
                    db.reels.push({
                        id: uuid(), creator_id: creator, ig_media_id: r.ig_media_id, permalink: r.permalink, youtube_url: null, posted_at: iso(r.posted_at), status: 'pending',
                        result: {}, model: null, ms: null, usd: null, created_at: new Date(db.now), updated_at: new Date(db.now),
                    });
                    written++;
                } else if (had.status !== 'ok') {
                    Object.assign(had, { status: 'pending', permalink: r.permalink ?? had.permalink, posted_at: iso(r.posted_at) ?? had.posted_at, updated_at: new Date(db.now) });
                    written++;
                }
            }
            return ok([], written);
        }
        if (/^INSERT INTO reel_analyses \(creator_id, ig_media_id, permalink, youtube_url, posted_at, status, result, model, ms, usd\) VALUES \(\$1::uuid, \$2, \$3, \$4, \$5::timestamptz, 'ok', \$6::jsonb, \$7, \$8, \$9\) ON CONFLICT \(creator_id, ig_media_id\) WHERE ig_media_id IS NOT NULL DO UPDATE SET permalink = COALESCE\(EXCLUDED\.permalink, reel_analyses\.permalink\), youtube_url = COALESCE\(EXCLUDED\.youtube_url, reel_analyses\.youtube_url\), posted_at = COALESCE\(EXCLUDED\.posted_at, reel_analyses\.posted_at\), status = 'ok', result = EXCLUDED\.result, model = EXCLUDED\.model, ms = EXCLUDED\.ms, usd = EXCLUDED\.usd, updated_at = NOW\(\) RETURNING id$/.test(sql)) {
            const [creator, media, permalink, youtube, posted, result, model, ms, usd] = params as [string, string, string | null, string | null, string | null, string, string, number, number];
            const had = find(creator, media);
            const fields = { status: 'ok', result: JSON.parse(result), model, ms: Math.round(ms), usd: usdText(usd), updated_at: new Date(db.now) };
            if (had) {
                Object.assign(had, { ...fields, permalink: permalink ?? had.permalink, youtube_url: youtube ?? had.youtube_url, posted_at: iso(posted) ?? had.posted_at });
                return ok([{ id: had.id }]);
            }
            const row: FakeReel = { id: uuid(), creator_id: creator, ig_media_id: media, permalink, youtube_url: youtube, posted_at: iso(posted), created_at: new Date(db.now), ...fields } as FakeReel;
            db.reels.push(row);
            return ok([{ id: row.id }]);
        }
        if (/^INSERT INTO reel_analyses \(creator_id, ig_media_id, permalink, posted_at, status, result, model, ms, usd\) VALUES \(\$1::uuid, \$2, \$3, \$4::timestamptz, 'failed', \$5::jsonb, \$6, \$7, \$8\) ON CONFLICT \(creator_id, ig_media_id\) WHERE ig_media_id IS NOT NULL DO UPDATE SET status = 'failed', result = EXCLUDED\.result, model = EXCLUDED\.model, ms = EXCLUDED\.ms, usd = EXCLUDED\.usd, permalink = COALESCE\(EXCLUDED\.permalink, reel_analyses\.permalink\), posted_at = COALESCE\(EXCLUDED\.posted_at, reel_analyses\.posted_at\), updated_at = NOW\(\) WHERE reel_analyses\.status <> 'ok' RETURNING id$/.test(sql)) {
            const [creator, media, permalink, posted, result, model, ms, usd] = params as [string, string, string | null, string | null, string, string | null, number | null, number | null];
            const had = find(creator, media);
            const fields = { status: 'failed', result: JSON.parse(result), model, ms: ms === null ? null : Math.round(ms), usd: usdText(usd), updated_at: new Date(db.now) };
            if (had) {
                // The `WHERE status <> 'ok'` of the conflict update: a good analysis is never replaced, and no row comes back.
                if (had.status === 'ok') return ok();
                Object.assign(had, { ...fields, permalink: permalink ?? had.permalink, posted_at: iso(posted) ?? had.posted_at });
                return ok([{ id: had.id }]);
            }
            const row: FakeReel = { id: uuid(), creator_id: creator, ig_media_id: media, permalink, youtube_url: null, posted_at: iso(posted), created_at: new Date(db.now), ...fields } as FakeReel;
            db.reels.push(row);
            return ok([{ id: row.id }]);
        }
        if (/^UPDATE reel_analyses SET youtube_url = \$3, updated_at = NOW\(\) WHERE creator_id = \$1 AND ig_media_id = \$2 AND youtube_url IS DISTINCT FROM \$3$/.test(sql)) {
            const row = find(String(params[0]), String(params[1]));
            if (!row || row.youtube_url === params[2]) return ok([], 0);
            row.youtube_url = String(params[2]);
            row.updated_at = new Date(db.now);
            return ok([], 1);
        }

        // ── reel_analyses: readers ──
        if (/^SELECT id, ig_media_id, permalink, youtube_url, posted_at, status, result->>'summary' AS summary, result->>'hook_score' AS hook_score, result->>'error' AS error, model, usd, updated_at FROM reel_analyses WHERE creator_id = \$1 ORDER BY posted_at DESC NULLS LAST, created_at DESC$/.test(sql)) {
            return ok(db.reels.filter((r) => r.creator_id === params[0]).sort(newest).map((r) => ({
                id: r.id, ig_media_id: r.ig_media_id, permalink: r.permalink, youtube_url: r.youtube_url, posted_at: r.posted_at, status: r.status,
                summary: typeof r.result['summary'] === 'string' ? r.result['summary'] : null,
                hook_score: r.result['hook_score'] === undefined || r.result['hook_score'] === null ? null : String(r.result['hook_score']),
                error: typeof r.result['error'] === 'string' ? r.result['error'] : null,
                model: r.model, usd: r.usd, updated_at: r.updated_at,
            })));
        }
        m = /^SELECT id, creator_id, ig_media_id, permalink, youtube_url, posted_at, status, result, model, ms, usd, created_at, updated_at FROM reel_analyses WHERE creator_id = \$1 AND (id = \$2|ig_media_id = \$2|status = 'ok' ORDER BY posted_at DESC NULLS LAST, created_at DESC)$/.exec(sql);
        if (m) {
            const mine = db.reels.filter((r) => r.creator_id === params[0]);
            if (m[1] === "status = 'ok' ORDER BY posted_at DESC NULLS LAST, created_at DESC") return ok(mine.filter((r) => r.status === 'ok').sort(newest).map((r) => ({ ...r })));
            const hit = m[1] === 'id = $2' ? mine.find((r) => r.id === params[1]) : mine.find((r) => r.ig_media_id === params[1]);
            return hit ? ok([{ ...hit }]) : ok();
        }
        if (/^SELECT ig_media_id, status FROM reel_analyses WHERE creator_id = \$1 AND ig_media_id IS NOT NULL$/.test(sql)) {
            return ok(db.reels.filter((r) => r.creator_id === params[0] && r.ig_media_id !== null).map((r) => ({ ig_media_id: r.ig_media_id, status: r.status })));
        }
        throw new Error(`reelTestDb: unexpected SQL ${sql}`);
    };
    return db;
}
