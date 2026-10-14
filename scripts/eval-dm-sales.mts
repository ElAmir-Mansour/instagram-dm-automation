/**
 * The DM sales evaluation (docs/DM_SALES_PLAN.md §11, E1): the fifteen golden conversations through the real sales prompt, schema,
 * coerce and guard, against a model you name, scored by hard checks in code and a Claude judge. Run it before every prompt or kit
 * change, and to choose the model of the `dm` route.
 *
 *   npx tsx scripts/eval-dm-sales.mts --model claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 --report eval-report.md
 *   npx tsx scripts/eval-dm-sales.mts --model claude-sonnet-5-5 --cases 1,5,15 --no-judge
 *   npx tsx scripts/eval-dm-sales.mts --stub          dry run: two cases, canned answers, no key, no database
 *   npx tsx scripts/eval-dm-sales.mts --help
 *
 * What it touches, and what it cannot:
 *
 *   - **Prompts come from the committed fixtures** (`src/services/dmSales/__evals__/fixtures.ts`), never from a tenant: it reads no
 *     profile, no conversation, no message, and it has no flag that would. A flag that names a tenant, a conversation or a stored profile
 *     is refused (exit 3). It sends nothing to Meta.
 *   - **Model calls go through the AI providers layer** (`generate`, purpose `dm`, the route named on the command line), so the operator's
 *     key, budgets and price table apply. Each call is recorded in `ai_usage` as purpose `eval` and charged to no tenant (`creatorId: null`).
 *     That is the only thing it writes, and it needs `DATABASE_URL` (and `TOKEN_ENCRYPTION_KEY`, to decrypt the saved key) for it: a `.env`
 *     above this checkout is read, as the other live scripts read theirs, or export them.
 *   - **`--stub` needs neither**, and does not read the `.env`: canned answers, nothing billed, nothing written.
 *
 * Exit: 0 every model met the bar · 1 a model did not · 2 usage, or it could not start · 3 refused.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM, no declaration file
import { loadEnv } from './lib/live.mjs';

// The environment first: `config/db.ts` builds the application's pool from DATABASE_URL the moment it is imported, so everything that
// can reach it is imported after this (the same order `prompt-parity.mts` keeps). A run that asks no model reads no .env at all.
const OFFLINE = ['--stub', '--dry-run', '--list', '--help', '-h'];
if (!process.argv.slice(2).some((a) => OFFLINE.includes(a))) loadEnv(null);

const { runCli } = await import('../src/services/dmSales/__evals__/cli.js');
const { JUDGE_EFFORT } = await import('../src/services/dmSales/__evals__/judge.js');
type Callers = import('../src/services/dmSales/__evals__/cli.js').Callers;
type Options = import('../src/services/dmSales/__evals__/cli.js').Options;
type EvalCaller = import('../src/services/dmSales/__evals__/types.js').EvalCaller;
type ProviderId = import('../src/services/llm/registry.js').ProviderId;
type Effort = import('../src/services/llm/types.js').Effort;

/** The real callers: `generate` for purpose `dm`, with the route named for each call, recorded as `eval` and charged to nobody. */
async function makeCallers(options: Options): Promise<Callers> {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set: the AI providers layer reads the saved key and records spend there. Put a .env above this checkout, or export it. (--stub needs neither.)');
    }
    const { setLogSink } = await import('../src/utils/log.js');
    const { generate } = await import('../src/services/aiProviders/generate.js');
    const { EVAL } = await import('../src/services/aiProviders/purposes.js');
    const { pool } = await import('../src/config/db.js');
    // The layer logs one line per call (no key, prompt or answer in it). Warnings and errors stay on stderr; the rest would bury the report.
    setLogSink((level, line) => {
        if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`);
    });

    const caller = (route: { provider: ProviderId; model: string; effort: Effort }): EvalCaller => async (request) => {
        const started = performance.now();
        const result = await generate({
            purpose: 'dm',
            usageAs: EVAL,
            creatorId: null,
            route,
            system: request.system,
            user: request.user,
            schema: request.schema,
            maxTokens: request.maxTokens,
            timeoutMs: request.timeoutMs,
            ...(request.cacheSystem ? { cacheSystem: true } : {}),
        });
        return { json: result.json, model: result.model, usage: result.usage, usd: result.usd, priced: result.priced, latencyMs: performance.now() - started };
    };

    return {
        sales: (model) => caller({ provider: options.provider as ProviderId, model, effort: options.effort }),
        judge: options.judgeModel ? caller({ provider: 'anthropic', model: options.judgeModel, effort: JUDGE_EFFORT }) : null,
        close: () => pool.end(),
    };
}

const code = await runCli(process.argv.slice(2), {
    makeCallers,
    io: {
        out: (text) => process.stdout.write(`${text}\n`),
        err: (text) => process.stderr.write(`${text}\n`),
        writeFile: (file, text) => {
            const target = path.resolve(file);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, text, 'utf8');
        },
        now: () => new Date(),
    },
});
process.exitCode = code;
