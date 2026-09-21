#!/usr/bin/env node
/**
 * Live pipeline watcher: tail the production database and print each stage as it happens.
 *
 * Start this, then post one comment (or send one DM) from another account. Every stage the
 * refactored pipeline goes through appears as a line, in order, with the elapsed time — so
 * the event either lands, or the output shows exactly which stage it stopped at.
 *
 *   node scripts/watch.mjs                       follow from now
 *   node scripts/watch.mjs --replay 30           first print the last 30 minutes, then follow
 *   node scripts/watch.mjs --timeout 600         exit after 10 minutes (exit 1 if nothing happened)
 *   node scripts/watch.mjs --interval 1000       poll faster (default 2000ms)
 *   node scripts/watch.mjs --env ../../../.env   explicit .env
 *
 * READ-ONLY. The database session is `default_transaction_read_only`, verified on connect
 * (scripts/lib/live.mjs), so this cannot write a row, cannot send a DM and cannot publish
 * anything — it only reads what the app wrote. Message text is truncated in the output and
 * no token, secret or connection string is ever printed.
 *
 * WHAT IT CANNOT SEE, and why that matters for reading the output:
 *
 *   · A delivery Meta never sent, and a delivery rejected for a bad HMAC signature. Both
 *     happen before any row exists. Their signature here is the absence of a `jobs` row —
 *     which this script calls out explicitly rather than leaving as silence.
 *   · A successful public reply. The app records the failure (`interactions.error_log`) but
 *     not the success, so a sent public reply shows up only in the Vercel log line
 *     `comment.public_reply_sent`. The watcher says so at the point it would have appeared.
 *
 * Stage map (comment path):
 *   ① jobs row            webhook arrived, signature passed, work made durable
 *   ② interactions row    a campaign matched and this delivery claimed the comment
 *   ③ rate_limit_counters the hourly send quota was consumed
 *   ④ dm_send_log         the per-recipient 24h cap was recorded
 *   ⑤ interactions.status SENT (or FAILED with the reason)
 *   ⑥ jobs.status         done — the queue finished with it
 */
import {
    color, connectReadOnly, fmtAge, loadEnv, parseArgs, safeQuery,
} from './lib/live.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
    console.log(`
AutoReply Pro live pipeline watcher — read-only. Prints each stage as it happens.

  node scripts/watch.mjs [options]

  --env <path>       .env to read DATABASE_URL from (default: nearest .env walking up)
  --replay <min>     print the last N minutes of activity before following
  --timeout <sec>    stop after N seconds (exit 1 if nothing was observed)
  --interval <ms>    poll interval (default 2000)
  --help

Start it, then post one comment from another account. See VERIFYING.md.`);
    process.exit(0);
}

loadEnv(typeof args.env === 'string' ? args.env : null);

const INTERVAL_MS = Number(args.interval ?? 2000);
const REPLAY_MIN = Number(args.replay ?? 0);
const TIMEOUT_S = args.timeout ? Number(args.timeout) : 0;
/** How long to wait before pointing out that no job row has appeared at all. */
const NO_JOB_HINT_S = 90;
const HEARTBEAT_S = 30;

const startedAt = Date.now();
let eventCount = 0;
let lastLineAt = startedAt;
let hintShown = false;

// ─── Output ─────────────────────────────────────────────────────────────────────────────

const clock = () => new Date().toISOString().slice(11, 23);

/** One timeline line: wall clock, elapsed since start, gap since the previous line, body. */
function emit(stage, body, tag = null, level = 'info') {
    const now = Date.now();
    const gap = now - lastLineAt;
    lastLineAt = now;
    eventCount++;

    const paint = level === 'bad' ? color.red : level === 'warn' ? color.yellow : level === 'good' ? color.green : color.cyan;
    const gapStr = eventCount === 1 ? '' : color.dim(`+${fmtAge(gap)}`);
    console.log(
        `${color.dim(clock())} ${color.dim((`+${fmtAge(now - startedAt)}`).padEnd(8))} ${paint(stage.padEnd(22))} ${body} ${tag ? color.dim(tag) : ''} ${gapStr}`.trimEnd()
    );
}

function note(text) {
    console.log(`${' '.repeat(34)}${color.dim('↳ ' + text)}`);
}

const short = (id) => (id ? String(id).slice(0, 8) : '—');
const clip = (s, n = 70) => (s ? String(s).replace(/\s+/g, ' ').slice(0, n) + (String(s).length > n ? '…' : '') : '');
/** Comment/message ids are long; the tail is the part that differs between events. */
const tailTag = (label, id) => (id ? `[${label} …${String(id).slice(-8)}]` : '');

// ─── Watched state ──────────────────────────────────────────────────────────────────────
//
// Rows do not all carry an "updated_at", so change detection is done here: a small map of
// id → the fields that matter, diffed each poll. The sets stay small because every query is
// bounded by the watermark.

const jobState = new Map();
const interactionState = new Map();
const messageSeen = new Set();
const conversationState = new Map();
const rateState = new Map();
const dmLogSeen = new Set();
const postState = new Map();
/** comment.process jobs whose completion still needs the "did anything match?" verdict. */
const pendingVerdict = new Map();

let watermark = new Date(startedAt - REPLAY_MIN * 60_000);
let priming = true;

// ─── Polling ────────────────────────────────────────────────────────────────────────────

async function poll(db) {
    const since = watermark.toISOString();

    // ── ① jobs: the arrival of a delivery, and the queue's progress through it ──
    const jobs = await safeQuery(db, `
        SELECT id, kind, status, attempts, max_attempts, created_at, claimed_at, updated_at,
               dedupe_key, left(coalesce(last_error, ''), 220) AS err,
               payload->'change'->'value'->>'text'                       AS comment_text,
               payload->'change'->'value'->'from'->>'username'           AS comment_user,
               coalesce(payload->'change'->'value'->>'id',
                        payload->'change'->'value'->>'comment_id')       AS comment_id,
               payload->'event'->'message'->>'text'                     AS dm_text,
               payload->'event'->'sender'->>'id'                        AS dm_sender_id
          FROM jobs
         WHERE created_at > $1 OR updated_at > $1
         ORDER BY created_at`, [since]);
    if (jobs.error) { note(`jobs query failed: ${jobs.error}`); }

    for (const j of jobs.rows) {
        const key = `${j.status}|${j.attempts}`;
        const prev = jobState.get(j.id);
        jobState.set(j.id, key);
        if (priming || prev === key) continue;

        const isComment = j.kind === 'comment.process';
        const tag = isComment ? tailTag('cmt', j.comment_id) : tailTag('dm', j.dedupe_key);

        if (prev === undefined) {
            // The single most important line in this script: a job row exists, therefore Meta
            // delivered, therefore the HMAC signature passed and the body parsed.
            emit('① webhook arrived', `job ${short(j.id)} ${color.bold(j.kind)} enqueued`, tag, 'good');
            if (isComment) {
                note(`from @${j.comment_user ?? '?'}: "${clip(j.comment_text)}"`);
                if (j.comment_id) pendingVerdict.set(j.id, j.comment_id);
            } else if (j.dm_text) {
                note(`inbound DM from …${String(j.dm_sender_id ?? '').slice(-6)}: "${clip(j.dm_text)}"`);
            }
            note('signature verified and the work is durable — anything after this point is recoverable');
            continue;
        }

        if (j.status === 'running') {
            emit('   job claimed', `job ${short(j.id)} attempt ${j.attempts}/${j.max_attempts}`, tag);
        } else if (j.status === 'done') {
            emit('⑥ job drained', `job ${short(j.id)} done`, tag, 'good');
            if (pendingVerdict.has(j.id)) verdictQueue.push([db, j.id, pendingVerdict.get(j.id)]);
        } else if (j.status === 'failed') {
            const exhausted = j.attempts >= j.max_attempts;
            emit(exhausted ? '✖ job FAILED' : '↻ job retrying', `job ${short(j.id)} attempt ${j.attempts}/${j.max_attempts}`, tag, exhausted ? 'bad' : 'warn');
            if (j.err) note(j.err);
            if (!exhausted) note('backoff is ~30s, ~2m, ~8m with jitter — the next drain picks it up');
        } else if (j.status === 'pending' && prev.startsWith('running')) {
            emit('↻ job requeued', `job ${short(j.id)} back to pending`, tag, 'warn');
        }
    }

    // ── ② / ⑤ interactions: the campaign match, then the send outcome ──
    const inter = await safeQuery(db, `
        SELECT i.id, i.comment_id, i.sender_username, i.post_id, i.status, i.platform, i.timestamp,
               left(coalesce(i.error_log, ''), 240) AS err, c.trigger_keyword, c.id AS campaign_id
          FROM interactions i
          LEFT JOIN campaigns c ON c.id = i.campaign_id
         WHERE i.timestamp > $1
         ORDER BY i.timestamp`, [since]);

    for (const i of inter.rows) {
        const key = `${i.status}|${i.err}`;
        const prev = interactionState.get(i.id);
        interactionState.set(i.id, key);
        if (priming || prev === key) continue;
        const tag = tailTag('cmt', i.comment_id);

        if (prev === undefined) {
            emit('② campaign matched', `interaction ${short(i.id)} claimed for @${i.sender_username} (${i.platform})`, tag, 'good');
            note(`campaign ${short(i.campaign_id)} keyword "${clip(i.trigger_keyword, 48)}" · post ${i.post_id}`);
            note('the row exists, so the comment matched and this delivery — not a redelivery — owns it');
            // A row created with a terminal status in the same poll would otherwise print only
            // the claim line, so fall through and report the status too.
            if (i.status === 'PENDING') continue;
        }

        if (i.status === 'SENT') {
            emit('⑤ DM sent', `interaction ${short(i.id)} → @${i.sender_username}`, tag, 'good');
            note('public reply is attempted right after this, and only its FAILURE is recorded here —');
            note('a success shows up as `comment.public_reply_sent` in the Vercel logs, or as the reply on the post');
        } else if (i.status === 'FAILED') {
            emit('✖ send FAILED', `interaction ${short(i.id)} → @${i.sender_username}`, tag, 'bad');
            note(i.err || 'no error recorded');
        } else if (i.err) {
            // Status stayed SENT but an error was appended: the DM went, the public reply did not.
            emit('⚠ public reply failed', `interaction ${short(i.id)}`, tag, 'warn');
            note(i.err);
        }
    }

    // ── ③ rate limits ──
    const rate = await safeQuery(db, `
        SELECT creator_id, bucket, window_start, count FROM rate_limit_counters
         WHERE window_start >= date_trunc('hour', now()) - interval '1 hour'`);
    for (const r of rate.rows) {
        const k = `${r.creator_id}|${r.bucket}|${r.window_start}`;
        const prev = rateState.get(k);
        rateState.set(k, r.count);
        if (priming || prev === r.count) continue;
        emit('③ rate limit checked', `${r.bucket} counter ${prev ?? 0} → ${r.count} this hour (ceiling 180)`, null,
            Number(r.count) >= 180 ? 'bad' : 'info');
        if (Number(r.count) >= 180) note('quota exhausted — further sends this hour are dropped and marked FAILED');
    }

    // ── ④ per-recipient 24h cap ──
    const dmLog = await safeQuery(db, 'SELECT recipient_id, sent_at FROM dm_send_log WHERE sent_at > $1', [since]);
    for (const d of dmLog.rows) {
        const k = `${d.recipient_id}|${d.sent_at}`;
        if (dmLogSeen.has(k)) continue;
        dmLogSeen.add(k);
        if (priming) continue;
        emit('④ recipient cap set', `recipient …${String(d.recipient_id).slice(-6)} recorded — no second automated DM for 24h`);
    }

    // ── DM path ──
    const convos = await safeQuery(db, `
        SELECT id, instagram_user_id, is_bot_active, ai_disclosed_at, last_message_at, created_at
          FROM conversations WHERE last_message_at > $1 OR created_at > $1`, [since]);
    for (const c of convos.rows) {
        const key = `${c.is_bot_active}|${c.ai_disclosed_at}`;
        const prev = conversationState.get(c.id);
        conversationState.set(c.id, key);
        if (priming) continue;
        if (prev === undefined) {
            emit('① DM conversation', `conversation ${short(c.id)} with …${String(c.instagram_user_id).slice(-6)}`, null, 'good');
            if (!c.is_bot_active) note('the bot is PAUSED for this thread — inbound messages will be stored and not answered');
        } else if (prev !== key && c.ai_disclosed_at) {
            emit('   AI disclosed', `conversation ${short(c.id)} — automated-service disclosure recorded`, null, 'good');
        }
    }

    const msgs = await safeQuery(db, `
        SELECT id, conversation_id, direction, message_type, left(coalesce(text, ''), 200) AS text,
               created_at, meta_message_id
          FROM messages WHERE created_at > $1 ORDER BY created_at`, [since]);
    for (const m of msgs.rows) {
        if (messageSeen.has(m.id)) continue;
        messageSeen.add(m.id);
        if (priming) continue;
        if (m.direction === 'inbound') {
            emit('② DM claimed', `message ${short(m.id)} inbound (${m.message_type})`, tailTag('mid', m.meta_message_id), 'good');
            note(`"${clip(m.text)}" — meta_message_id is UNIQUE, so a redelivery stops here`);
        } else {
            emit('⑤ AI reply sent', `message ${short(m.id)} outbound`, null, 'good');
            note(`"${clip(m.text)}"`);
        }
    }

    // ── Publishing ──
    const posts = await safeQuery(db, `
        SELECT id, status, attempts, claimed_at, published_post_id, scheduled_time, platform, post_type,
               left(coalesce(error_log, ''), 220) AS err
          FROM scheduled_posts`);
    for (const p of posts.rows) {
        const key = `${p.status}|${p.attempts}|${p.published_post_id ?? ''}`;
        const prev = postState.get(p.id);
        postState.set(p.id, key);
        if (priming || prev === undefined || prev === key) continue;
        if (p.status === 'PUBLISHING') emit('publish claimed', `post ${short(p.id)} (${p.platform}/${p.post_type}) attempt ${p.attempts}`);
        else if (p.status === 'PUBLISHED') emit('publish done', `post ${short(p.id)} → ${p.published_post_id}`, null, 'good');
        else if (p.status === 'FAILED') { emit('✖ publish FAILED', `post ${short(p.id)}`, null, 'bad'); note(p.err); }
        else if (p.status === 'PENDING') emit('publish requeued', `post ${short(p.id)} claim released`, null, 'warn');
    }

    // Advance the watermark, leaving a small overlap so a row committed with a slightly
    // earlier timestamp than the query's clock is not skipped.
    watermark = new Date(Date.now() - 10_000);
    priming = false;
}

/**
 * The verdict a comment webhook needs and the database cannot express directly.
 *
 * A delivery that matches no campaign writes no row at all — per CLAUDE.md, the single
 * hardest failure here to tell apart from "nothing arrived". Now that every delivery leaves a
 * `jobs` row, the pair (job done, no interaction for that comment id) is exactly that case,
 * and it can be stated instead of inferred.
 */
const verdictQueue = [];
async function flushVerdicts() {
    while (verdictQueue.length) {
        const [db, jobId, commentId] = verdictQueue.shift();
        pendingVerdict.delete(jobId);
        const r = await safeQuery(db, 'SELECT id, status FROM interactions WHERE comment_id = $1', [commentId]);
        if (!r.rows.length) {
            emit('⊘ no campaign match', `job ${short(jobId)} finished without writing an interaction`, tailTag('cmt', commentId), 'warn');
            note('The pipeline ran correctly and decided there was nothing to do: no active campaign keyword is a');
            note('substring of that comment. Nothing was sent and no row was written — this is what "silence" looks like.');
            note('To get a match, comment a keyword from an active campaign (see the campaign list in diagnose.mjs).');
        }
    }
}

// ─── Main loop ──────────────────────────────────────────────────────────────────────────

function printHeader(baseline) {
    console.log(color.bold('\nAutoReply Pro — live pipeline watcher') + color.dim('  (read-only)'));
    console.log(color.dim(`polling every ${INTERVAL_MS}ms · started ${new Date(startedAt).toISOString()}`));
    console.log(color.dim(`baseline: ${baseline.jobs} jobs, ${baseline.interactions} interactions, ${baseline.messages} messages`
        + ` · last comment ${fmtAge(baseline.lastInteractionAge)} ago · last inbound DM ${fmtAge(baseline.lastDmAge)} ago`));
    if (REPLAY_MIN) console.log(color.dim(`replaying the last ${REPLAY_MIN} minute(s) first`));
    console.log(color.dim('post a comment with an active campaign keyword, or send a DM. Ctrl-C to stop.\n'));
}

function summary() {
    console.log('');
    console.log(color.bold(`watched ${fmtAge(Date.now() - startedAt)}, ${eventCount} stage event(s)`));
    if (!eventCount) {
        console.log(color.yellow('Nothing happened at all.'));
        console.log(color.dim('  · No `jobs` row means the delivery never reached the handler: either Meta did not send it'));
        console.log(color.dim('    (callback URL / field subscription — run scripts/diagnose.mjs) or the HMAC signature was'));
        console.log(color.dim('    rejected before anything touched the database (Vercel logs: webhook.signature_rejected).'));
        console.log(color.dim('  · If you did not post anything, this is simply a quiet account.'));
    }
    console.log('');
}

async function main() {
    const db = await connectReadOnly('autoreply-watch');
    try {
        const base = await safeQuery(db, `
            SELECT (SELECT count(*) FROM jobs)         AS jobs,
                   (SELECT count(*) FROM interactions) AS interactions,
                   (SELECT count(*) FROM messages)     AS messages,
                   (SELECT max(timestamp)  FROM interactions) AS last_interaction,
                   (SELECT max(created_at) FROM messages WHERE direction = 'inbound') AS last_dm`);
        const b = base.rows[0] ?? {};
        printHeader({
            jobs: b.jobs ?? '?', interactions: b.interactions ?? '?', messages: b.messages ?? '?',
            lastInteractionAge: b.last_interaction ? Date.now() - new Date(b.last_interaction).getTime() : null,
            lastDmAge: b.last_dm ? Date.now() - new Date(b.last_dm).getTime() : null,
        });

        // With --replay, the first pass prints instead of priming, so recent history is shown.
        if (REPLAY_MIN > 0) priming = false;

        let stop = false;
        process.on('SIGINT', () => { stop = true; });

        while (!stop) {
            await poll(db);
            await flushVerdicts();

            const idleS = (Date.now() - lastLineAt) / 1000;
            const elapsedS = (Date.now() - startedAt) / 1000;

            if (!eventCount && !hintShown && elapsedS > NO_JOB_HINT_S) {
                hintShown = true;
                console.log(color.yellow(`\n  ${Math.round(elapsedS)}s and no \`jobs\` row has appeared.`));
                note('If you have already posted: the delivery is not reaching the handler. In order —');
                note('1) is the keyword a SUBSTRING of what you wrote? (a non-match still writes a jobs row, so this is not it)');
                note('2) scripts/diagnose.mjs — is the callback URL for this object type this deployment?');
                note('3) Vercel logs for `webhook.signature_rejected` — INSTAGRAM_APP_SECRET is a separate app secret');
                note('4) Meta App Dashboard → Webhooks → is the `comments` field subscribed?\n');
            } else if (idleS > HEARTBEAT_S) {
                process.stdout.write(`\r${color.dim(`… watching, ${fmtAge(Date.now() - startedAt)} elapsed, ${eventCount} event(s)   `)}`);
            }

            if (TIMEOUT_S && elapsedS > TIMEOUT_S) break;
            await new Promise((r) => setTimeout(r, INTERVAL_MS));
        }
    } finally {
        await db.end().catch(() => {});
    }

    summary();
    // Non-zero when nothing was observed, so `--timeout` makes this usable as a scripted
    // verification step rather than only as something to watch.
    process.exit(eventCount ? 0 : 1);
}

main().catch((err) => {
    console.error(`\nWatcher failed: ${err.message}`);
    process.exit(3);
});
