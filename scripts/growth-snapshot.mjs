#!/usr/bin/env node
/**
 * The growth numbers in about 20 lines: the weekly brief the build-team agents read
 * (docs/agents/BRIEF.md), and a quick look for a human.
 *
 *   node scripts/growth-snapshot.mjs [--env <path>] [--days 7] [--keys]
 *
 * `--keys` lists the metric keys actually stored, per platform, instead of the snapshot.
 *
 * Read-only by construction: every query runs inside BEGIN READ ONLY … ROLLBACK. It does NOT
 * use connectReadOnly() from lib/live.mjs, which sets default_transaction_read_only at SESSION
 * level. On the transaction pooler (port 6543) a session setting outlives this client and can
 * leave a pooled connection read-only for the app (CLAUDE.md). A transaction's own READ ONLY
 * ends with the transaction.
 *
 * Prints no secrets: only counts, ratios and the first line of captions.
 */
import pg from 'pg';
import { loadEnv, parseArgs } from './lib/live.mjs';

const GOAL_VIEWS = 1_000_000;
const GOAL_FOLLOWERS = 10_000;

const args = parseArgs(process.argv.slice(2));
loadEnv(typeof args.env === 'string' ? args.env : null);
if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Pass --env <path-to-.env>.');
    process.exit(1);
}
const days = Math.max(1, Math.min(90, Number(args.days) || 7));

const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'autoreply-growth-snapshot',
});

/** A post's views, whatever the platform called them. */
const VIEWS = `COALESCE((metrics->>'views')::numeric, (metrics->>'video_views')::numeric, 0)`;
/** Stored as a ratio (0–1) by the Growth sync; shown as a percentage. */
const SKIP = `(metrics->>'skip_rate')::numeric`;
const firstLine = (s) => String(s ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 48) || '(no caption)';
const n = (v) => Number(v ?? 0).toLocaleString('en-US');
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(Number(v) <= 1 ? Number(v) * 100 : Number(v))}%`);

async function keys() {
    for (const table of ['post_insights', 'account_insights_daily']) {
        const { rows } = await db.query(
            `SELECT platform, array_agg(DISTINCT k ORDER BY k) AS keys
               FROM ${table}, jsonb_object_keys(metrics) AS k
              GROUP BY platform ORDER BY platform`);
        for (const r of rows) console.log(`${table} ${r.platform}: ${r.keys.join(', ')}`);
    }
}

async function snapshot() {
    const since = `NOW() - make_interval(days => ${days})`;
    const out = [];
    out.push(`Growth snapshot, last ${days} days (as of ${new Date().toISOString().slice(0, 16)}Z)`);

    // Followers: the latest running total per platform, and how it moved over the window.
    const followers = await db.query(`
        SELECT platform,
               (array_agg((metrics->>'followers')::numeric ORDER BY day DESC)
                   FILTER (WHERE metrics ? 'followers'))[1] AS now,
               (array_agg((metrics->>'followers')::numeric ORDER BY day ASC)
                   FILTER (WHERE metrics ? 'followers' AND day >= (NOW() - make_interval(days => ${days}))::date))[1] AS then,
               SUM(COALESCE((metrics->>'follows')::numeric, 0))
                   FILTER (WHERE day >= (NOW() - make_interval(days => ${days}))::date) AS gained
          FROM account_insights_daily
         GROUP BY platform ORDER BY platform`);
    let followersTotal = 0;
    for (const r of followers.rows) {
        followersTotal += Number(r.now ?? 0);
        const delta = r.now !== null && r.then !== null ? Number(r.now) - Number(r.then) : null;
        out.push(`  ${r.platform}: ${r.now === null ? 'followers unknown' : `${n(r.now)} followers`}`
            + `${delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${n(delta)})`}`
            + `${Number(r.gained) ? `, ${n(r.gained)} new follows` : ''}`);
    }

    // Posts in the window, per platform: count, views, median views, the hook's skip rate.
    const posts = await db.query(`
        SELECT platform, COUNT(*) AS posts, SUM(${VIEWS}) AS views,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ${VIEWS}) AS median_views,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ${SKIP})
                   FILTER (WHERE metrics ? 'skip_rate') AS median_skip
          FROM post_insights
         WHERE published_at >= ${since}
         GROUP BY platform ORDER BY platform`);
    for (const r of posts.rows) {
        out.push(`  ${r.platform}: ${n(r.posts)} posts, ${n(r.views)} views (median ${n(Math.round(r.median_views ?? 0))})`
            + `${r.median_skip === null ? '' : `, median skip in 3 s ${pct(r.median_skip)}`}`);
    }

    // The best and the worst, by views, with the hook that opened them.
    const ranked = await db.query(`
        SELECT platform, media_type, caption, ${VIEWS} AS views, ${SKIP} AS skip
          FROM post_insights
         WHERE published_at >= ${since}
         ORDER BY ${VIEWS} DESC, published_at DESC`);
    const line = (r) => `    ${n(r.views).padStart(6)} ${r.platform.slice(0, 2)} ${String(r.media_type ?? '').toLowerCase().slice(0, 8).padEnd(8)}`
        + ` skip ${pct(r.skip).padStart(4)}  ${firstLine(r.caption)}`;
    if (ranked.rows.length) {
        out.push('  Top 3:');
        ranked.rows.slice(0, 3).forEach((r) => out.push(line(r)));
        if (ranked.rows.length > 3) {
            out.push('  Bottom 3:');
            ranked.rows.slice(-3).reverse().forEach((r) => out.push(line(r)));
        }
    } else {
        out.push('  No posts with insights in this window.');
    }

    // The goal, all time: 1M views or 10k followers, whichever comes first.
    const all = await db.query(`SELECT SUM(${VIEWS}) AS views FROM post_insights`);
    const views = Number(all.rows[0]?.views ?? 0);
    out.push(`Goal: ${n(views)} / ${n(GOAL_VIEWS)} views (${(views / GOAL_VIEWS * 100).toFixed(1)}%),`
        + ` ${n(followersTotal)} / ${n(GOAL_FOLLOWERS)} followers (${(followersTotal / GOAL_FOLLOWERS * 100).toFixed(1)}%)`);
    console.log(out.join('\n'));
}

try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    await (args.keys ? keys() : snapshot());
} catch (err) {
    console.error(`growth-snapshot failed: ${err.message}`);
    process.exitCode = 1;
} finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end().catch(() => {});
}
