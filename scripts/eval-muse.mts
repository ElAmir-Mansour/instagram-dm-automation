/**
 * The Muse benchmark (docs/specs/005-muse-sees FR-019, T061): what the sales agent does with what followers send without a word (photos, videos, shared reels, story mentions and,
 * once its module is in, voice notes), set beside what it did before Muse, with every failure shown. It writes docs/hackathon/benchmark.md and benchmark.svg. A script you run by
 * hand against the LIVE Meta API with your own key: NOT part of `npm test` or CI (a test must never spend money or need a key), and nothing imports it.
 *
 *   npm run eval:muse -- --env ../.env                              the key is META_MODEL_API_KEY in that file
 *   npm run eval:muse -- --settings --env ../.env                   the key saved in Settings -> AI providers (DATABASE_URL and TOKEN_ENCRYPTION_KEY from the file)
 *   npm run eval:muse -- --env ../.env --voice --memory --library library.json --open-weights --judge
 *   npm run eval:muse -- --stub --out scratch/bench                 a dry run: canned answers, no key, no network
 *   npm run eval:muse -- --help
 *
 * What it touches, and what it cannot:
 *
 *   - **The key** comes from `--env <file>` (`META_MODEL_API_KEY`, and with `--judge` / `--open-weights` `ANTHROPIC_API_KEY` / `BASETEN_API_KEY`), or from the environment, or with
 *     `--settings` from Settings through a READ-ONLY connection (`scripts/lib/live.mjs`: each statement in its own `BEGIN READ ONLY`, as `scripts/meta-probe.mjs` reads it). No `.env` is
 *     ever read unless you name it. The key is held to build an `Authorization` header and printed nowhere.
 *   - **It writes no database.** The read-only connection exists only to read a key and is closed before anything runs, `DATABASE_URL` is then removed from the environment, and the
 *     application's own pool (which the product modules it reuses create when they load) is closed at once, so a query from anywhere in the run fails and does not reach a database.
 *   - **It sends no message and reads no tenant.** The prompts are the committed fixtures'; the media is read from `--media-dir` (no file is in the repository); a flag that names a
 *     tenant, a conversation or a stored profile is refused, as the DM sales evaluation refuses it.
 *   - **Its model calls** go straight to the provider (`generateJson`), priced from what the responses report. Nothing is recorded in `ai_usage`.
 *
 * Exit: 0 the bar was met · 1 it ran and did not meet it · 2 usage, or nothing could run · 3 refused (no key, or a model or a flag it does not take).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore: plain ESM, no declaration file
import { connectReadOnly, decryptSecret, loadEnv, parseArgs } from './lib/live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args: Record<string, string | boolean | string[]> = parseArgs(argv);

/** What needs no key and no network: the help, the list of cases and the dry run. */
const OFFLINE = Boolean(args.help || args.h || args.list || args.stub);

interface Keys {
    meta: string | null;
    anthropic: string | null;
    baseten: string | null;
    from: string;
}

const fromEnv = (name: string): string | null => ((process.env[name] ?? '').trim() || null);

/** The keys: the file you named, or the environment, or (with `--settings`) Settings through a read-only connection that is closed again before anything else happens. */
async function readKeys(): Promise<Keys> {
    // Only an env file named on the command line is read: a worktree finds its checkout's .env by walking up, and a benchmark that calls a live API must not pick a key up by accident.
    if (typeof args.env === 'string') loadEnv(args.env);
    const keys: Keys = { meta: fromEnv('META_MODEL_API_KEY'), anthropic: fromEnv('ANTHROPIC_API_KEY'), baseten: fromEnv('BASETEN_API_KEY'), from: fromEnv('META_MODEL_API_KEY') ? 'META_MODEL_API_KEY' : 'none' };
    if (args.settings) {
        const db = await connectReadOnly('autoreply-muse-benchmark');
        try {
            const saved = async (key: string): Promise<string | null> => {
                const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [key]);
                return rows[0]?.value ? (decryptSecret(rows[0].value).trim() || null) : null;
            };
            keys.meta = await saved('ai.providers.meta.api_key');
            keys.from = keys.meta ? 'Settings (ai.providers.meta.api_key)' : 'none';
            if (args.judge) keys.anthropic = (await saved('ai.providers.anthropic.api_key')) ?? keys.anthropic;
            if (args['open-weights']) keys.baseten = (await saved('ai.providers.baseten.api_key')) ?? keys.baseten;
        } finally {
            await db.end().catch(() => undefined);
        }
    }
    return keys;
}

let keys: Keys = { meta: null, anthropic: null, baseten: null, from: 'none' };
if (!OFFLINE) {
    try {
        keys = await readKeys();
    } catch (err) {
        process.stderr.write(`Could not read the key from Settings: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(3);
    }
}
// The database is not needed again, and nothing after this may reach it.
delete process.env.DATABASE_URL;

// The product modules the benchmark reuses are imported only now, after the environment is settled, as `scripts/eval-dm-sales.mts` does.
const { runCli } = await import('../src/services/perception/__bench__/cli.js');
const { loadOptional } = await import('../src/services/perception/__bench__/optional.js');
const { adaptVoice } = await import('../src/services/perception/__bench__/voice.js');
const { adaptRecall } = await import('../src/services/perception/__bench__/memory.js');
const { pool } = await import('../src/config/db.js');
type CliDeps = import('../src/services/perception/__bench__/cli.js').CliDeps;
// Closed before anything runs: a query from anywhere in the run is then refused by the pool, and no statement reaches a database.
await pool.end();

/** The voice module (P3), wired to the benchmark's key, or why it is not there. The first of the file names it may have. */
const loadVoice: NonNullable<CliDeps['loadVoice']> = async (k) => {
    for (const rel of ['src/services/perception/voice', 'src/services/perception/transcribeVoice']) {
        const voice = await loadOptional<{ transcribeVoice?: unknown }>(ROOT, rel, 'P3, the voice notes');
        if (!voice.present) continue;
        const asr = await loadOptional<{ callMetaAsr?: unknown; asrUsd?: unknown }>(ROOT, 'src/services/llm/metaAsr', 'P3, the speech client');
        if (!asr.present) return { present: false, why: asr.why };
        if (typeof voice.module.transcribeVoice !== 'function' || typeof asr.module.callMetaAsr !== 'function' || typeof asr.module.asrUsd !== 'function') {
            return { present: false, why: `${rel}.ts is in, but it does not export transcribeVoice() and metaAsr.ts callMetaAsr() and asrUsd() as the benchmark expects: adapt loadVoice in scripts/eval-muse.mts` };
        }
        const names = await loadOptional<{ voiceKeywords?: unknown }>(ROOT, 'src/services/perception/keywords', 'P3, the names to listen for');
        return {
            present: true,
            value: adaptVoice(voice.module as never, asr.module as never, { apiKey: k.meta!, ...(names.present && typeof names.module.voiceKeywords === 'function' ? { keywords: names.module as never } : {}) }),
        };
    }
    return { present: false, why: 'src/services/perception/voice.ts (P3: transcribeVoice) is not in this checkout yet' };
};

/** The product's recall (P4b), wired, or why it is not there. */
const loadRecall: NonNullable<CliDeps['loadRecall']> = async (ledger) => {
    const recall = await loadOptional<{ recallForTurn?: unknown }>(ROOT, 'src/services/perception/recall', 'P4b, the video memory\'s recall');
    if (!recall.present) return { present: false, why: recall.why };
    if (typeof recall.module.recallForTurn !== 'function') return { present: false, why: 'src/services/perception/recall.ts is in, but it does not export recallForTurn() as the benchmark expects: adapt loadRecall in scripts/eval-muse.mts' };
    return { present: true, value: adaptRecall(recall.module as never, { ledgerUsd: () => ledger.usdOf('recall') }) };
};

const code = await runCli(argv, {
    keys,
    casesFile: path.join(ROOT, 'scripts', 'eval-muse', 'cases.json'),
    defaultMediaDir: path.join(os.homedir(), 'Desktop', 'Meta hackathon tests', 'media'),
    defaultOut: path.join(ROOT, 'docs', 'hackathon'),
    loadVoice,
    loadRecall,
    readText: (file) => readFile(path.resolve(file), 'utf8'),
    io: {
        out: (text) => process.stdout.write(`${text}\n`),
        err: (text) => process.stderr.write(`${text}\n`),
        writeFile: (file, text) => {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, text, 'utf8');
        },
        readFile: (file) => readFile(path.resolve(file)),
        now: () => new Date(),
    },
});
process.exitCode = code;
