/**
 * Shared plumbing for the live-system scripts (`diagnose.mjs`, `watch.mjs`).
 *
 * Three things live here because getting any of them wrong once is worse than the
 * duplication:
 *
 *   1. Read-only database access. Both scripts are diagnostics — they must never be able to
 *      write to production, and "I only wrote SELECTs" is a promise, not a guarantee.
 *      `connectReadOnly` sets `default_transaction_read_only = on` and reads it back before
 *      returning, so the database itself refuses an INSERT/UPDATE/DELETE/DDL from these
 *      scripts even if one were introduced by accident. Verified against production: DDL and
 *      UPDATE both come back `cannot execute ... in a read-only transaction`.
 *   2. Secret handling. Nothing here ever returns a secret for printing — `fingerprint()`
 *      gives a stable 8-hex digest plus a length, which is enough to answer "is the value in
 *      this .env the same one production has" without putting the value anywhere.
 *   3. Env loading. A worktree has no `.env` of its own, so rather than requiring
 *      `node --env-file=...`, these scripts walk up from the script's own directory looking
 *      for one. `--env <path>` overrides.
 */
import pg from 'pg';
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Environment ────────────────────────────────────────────────────────────────────────

/**
 * Populate `process.env` from a `.env` file, without overwriting anything already set.
 *
 * Returns the path used, or null if none was found — the caller decides whether that is
 * fatal (it is not, if the variables are already in the environment, e.g. in CI).
 *
 * The walk-up matters for git worktrees: `.claude/worktrees/agent-xxx` is three levels below
 * the checkout that actually holds the `.env`, and `--env-file` in the npm script would
 * resolve to the worktree's non-existent copy.
 */
export function loadEnv(explicitPath = null) {
    const candidates = [];
    if (explicitPath) candidates.push(path.resolve(explicitPath));
    else {
        let dir = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // scripts/ -> repo
        for (let i = 0; i < 6; i++) {
            candidates.push(path.join(dir, '.env'));
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }

    for (const file of candidates) {
        if (!existsSync(file)) continue;
        for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
            let value = line.slice(eq + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) value = value.slice(1, -1);
            if (!(key in process.env)) process.env[key] = value;
        }
        return file;
    }
    return null;
}

/** Minimal `--flag value` / `--flag=value` parser. Bare words land in `_`. */
export function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) { out._.push(a); continue; }
        const [key, inline] = a.slice(2).split('=');
        if (inline !== undefined) { out[key] = inline; continue; }
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) { out[key] = next; i++; }
        else out[key] = true;
    }
    return out;
}

// ─── Secrets ────────────────────────────────────────────────────────────────────────────

/**
 * A comparable, non-reversible stand-in for a secret: `ab12cd34/64`.
 *
 * Two environments printing the same fingerprint hold the same value; a different one is a
 * mismatch. Neither tells a reader what the value is, which is the point — this output gets
 * pasted into issues and chat windows.
 */
export function fingerprint(value) {
    if (!value) return 'unset';
    return `${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}/${value.length}`;
}

/** `host/database` from a connection string. Drops user, password, and query parameters. */
export function describeDbTarget(connectionString) {
    try {
        const u = new URL(connectionString);
        return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
    } catch {
        return '<unparseable DATABASE_URL>';
    }
}

const ENC_PREFIX = 'enc:v1:';

/** True when a stored secret carries the at-rest encryption envelope from src/config/crypto.ts. */
export function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * Mirror of `decryptSecret` in src/config/crypto.ts — same AES-256-GCM envelope, same
 * pass-through for legacy plaintext. Duplicated rather than imported because that module is
 * TypeScript and these scripts are plain ESM run without a loader.
 *
 * The decrypted token is used to call Meta's `/debug_token` and is never printed.
 */
export function decryptSecret(stored) {
    if (!stored) return '';
    if (!isEncrypted(stored)) return stored;

    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (!raw) throw new Error('token is encrypted but TOKEN_ENCRYPTION_KEY is not set');
    const key = Buffer.from(raw, 'hex');
    if (key.length !== 32) throw new Error(`TOKEN_ENCRYPTION_KEY must be 64 hex chars; got ${key.length} bytes`);

    const [, , ivB64, tagB64, ctB64] = stored.split(':');
    if (!ivB64 || !tagB64 || !ctB64) throw new Error('stored token is malformed (expected enc:v1:<iv>:<tag>:<ct>)');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

// ─── Database ───────────────────────────────────────────────────────────────────────────

/**
 * A single connection that cannot write, verified before it is handed back.
 *
 * A `Client` rather than a `Pool` on purpose. With a pool, `SET SESSION` has to be fired from
 * the `connect` event and is therefore unawaited — the first query can be in flight before
 * the guard lands, and a new connection created later re-runs it out of band. One client sets
 * the flag, reads it back with `SHOW transaction_read_only`, and refuses to continue unless
 * the server says `on`. So "these scripts cannot write to production" is something the
 * database asserts, not something the author remembered.
 *
 * Diagnostics are sequential and low-volume, so there is nothing to gain from a pool.
 */
export async function connectReadOnly(label = 'autoreply-diagnostics') {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set. Pass --env <path-to-.env> or export it.');
    }
    const client = new pg.Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
        // Shows up in pg_stat_activity, so an operator looking at connections can tell a
        // diagnostic session from the app's own.
        application_name: label,
    });
    await client.connect();
    await client.query('SET SESSION default_transaction_read_only = on');

    const check = await client.query('SHOW transaction_read_only');
    if (check.rows[0]?.transaction_read_only !== 'on') {
        await client.end().catch(() => {});
        throw new Error('could not put the session in read-only mode — refusing to run against a writable connection');
    }
    return client;
}

/** Run a query, returning rows, or `{ error }` instead of throwing — one bad check must not end the run. */
export async function safeQuery(db, sql, params = []) {
    try {
        const res = await db.query(sql, params);
        return { rows: res.rows };
    } catch (err) {
        return { rows: [], error: err.message };
    }
}

// ─── Formatting ─────────────────────────────────────────────────────────────────────────

/** `3d 4h`, `18m`, `42s` — coarse on purpose: age is the signal, not precision. */
export function fmtAge(ms) {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return 'never';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

export function fmtTime(d) {
    if (!d) return 'never';
    return new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** ANSI colour, disabled when not a TTY or when NO_COLOR is set, so piped output stays clean. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `[${code}m${s}[0m` : s);
export const color = {
    red: wrap('31;1'), yellow: wrap('33;1'), green: wrap('32'),
    dim: wrap('2'), bold: wrap('1'), cyan: wrap('36'),
};
