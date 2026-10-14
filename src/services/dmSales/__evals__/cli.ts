/**
 * The command line of `scripts/eval-dm-sales.mts`, as a function with its outputs and its models handed in, so a test can run it:
 * options in, a report out, an exit code back. The script itself only wires the real model callers (through the AI providers layer) and
 * the real console and files into this.
 *
 *   npx tsx scripts/eval-dm-sales.mts --model claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 --report eval-report.md
 *   npx tsx scripts/eval-dm-sales.mts --stub          the CI dry run: two cases, canned answers, no key, no database
 *
 * Exit: 0 every model met the bar · 1 a model did not · 2 usage, or the run could not start · 3 refused (it was pointed at live data).
 */
import { EFFORTS, type Effort } from '../../llm/types.js';
import { isProviderId } from '../../llm/registry.js';
import { CONVERSATIONS_DIR, loadCases, selectCases } from './cases.js';
import { resolveFixture } from './fixtures.js';
import { renderMarkdown, renderTerminal, summarize } from './report.js';
import { EvalRefusal, assertFixturesOnly, assertNoLiveFlags } from './refusal.js';
import { EVAL_TIMEOUT_MS, runEval } from './runner.js';
import { DRY_RUN_CASES, stubJudgeCaller, stubSalesCaller } from './stub.js';
import type { CaseOutcome, EvalCase, EvalCaller } from './types.js';

export const DEFAULT_PROVIDER = 'anthropic';
export const DEFAULT_EFFORT: Effort = 'low';
/** The judge is Claude, on the strongest model: it reads what the model under test wrote, so it should not be the weaker of the two. */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-5-5';
/** `generate` refuses a model id that is not this (aiProviders/settings.ts `MODEL_ID`); checked here so the mistake is a usage error and not a first failed call. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const MAX_TIMEOUT_MS = 150_000;

export const USAGE = `DM sales evaluation: the golden conversations through the real sales prompt, schema, coerce and guard.

  npx tsx scripts/eval-dm-sales.mts --model <id[,id...]> [options]
  npx tsx scripts/eval-dm-sales.mts --stub

  --model <ids>         the model(s) to evaluate, comma-separated (claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5)
  --provider <id>       the provider of those models (default ${DEFAULT_PROVIDER}); it needs a key in Operations -> AI providers
  --effort <level>      low | medium | high | xhigh | max (default ${DEFAULT_EFFORT}, what a DM is answered at)
  --cases <list>        which conversations: ids, numbers or id starts, comma-separated (default all fifteen)
  --judge-model <id>    the Claude model that scores tone, helpfulness, pressure and recommendation (default ${DEFAULT_JUDGE_MODEL})
  --no-judge            skip the judge: hard checks only (the bar cannot be met without the judge)
  --report <path>       also write a markdown report (conversations, failures, judge notes) to this file
  --timeout-ms <n>      the deadline of one model call (default ${EVAL_TIMEOUT_MS}, as the live DM path)
  --no-cache            do not cache the system prompt (the live path does)
  --stub                dry run: two cases, canned answers, no key and no database; for CI and for trying the harness
  --list                list the conversations and exit
  --help

It runs on the committed fixtures only and sends nothing. Its model calls go through the AI providers layer, are recorded in
ai_usage as purpose "eval" and are charged to no tenant. The owner's conversations are never read.

Exit: 0 every model met the bar · 1 a model did not · 2 usage, or it could not start · 3 refused.`;

class UsageError extends Error {}

export interface CliIo {
    out(text: string): void;
    err(text: string): void;
    writeFile(file: string, text: string): void;
    now(): Date;
}

export interface Callers {
    /** The caller for one model of the run. */
    sales(model: string): EvalCaller;
    /** The judge, or null when the run has none. */
    judge: EvalCaller | null;
    /** Called once at the end, to let go of whatever the callers hold (a database pool). */
    close?: () => Promise<void>;
}

export interface Options {
    models: string[];
    provider: string;
    effort: Effort;
    judgeModel: string | null;
    cases: EvalCase[];
    report: string | null;
    stub: boolean;
    cache: boolean;
    timeoutMs: number;
}

export interface CliDeps {
    io: CliIo;
    /** Builds the callers for a run: the real ones, in the script. A dry run never calls it. */
    makeCallers(options: Options): Promise<Callers>;
    /** The cases to choose from. Default: `conversations/`, checked against the fixtures' offers. */
    cases?: () => EvalCase[];
}

const BOOLEAN_FLAGS = new Set(['stub', 'dry-run', 'no-judge', 'no-cache', 'list', 'help', 'h']);
const VALUE_FLAGS = new Set(['model', 'provider', 'effort', 'cases', 'judge-model', 'report', 'timeout-ms']);

interface Parsed {
    flags: Map<string, string | true>;
}

function parse(argv: readonly string[]): Parsed {
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith('--') && arg !== '-h') throw new UsageError(`unexpected argument "${arg}"`);
        const body = arg === '-h' ? 'h' : arg.slice(2);
        const eq = body.indexOf('=');
        const name = eq === -1 ? body : body.slice(0, eq);
        flags.set(name, eq === -1 ? true : body.slice(eq + 1));
        // A flag that is not a known switch takes the word after it as its value, known or not: `--tenant abc` has to be read as a flag
        // with a value to be refused as one, and not stumbled over as a stray word.
        if (eq === -1 && !BOOLEAN_FLAGS.has(name)) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags.set(name, next);
                i += 1;
            } else if (VALUE_FLAGS.has(name)) {
                throw new UsageError(`--${name} needs a value`);
            }
        }
    }
    return { flags };
}

/** Every flag name given, for the refusal and the unknown-flag check. */
const names = (p: Parsed): string[] => [...p.flags.keys()];

function valueOf(p: Parsed, name: string): string | undefined {
    const v = p.flags.get(name);
    if (v === undefined) return undefined;
    if (v === true || v.trim() === '') throw new UsageError(`--${name} needs a value`);
    return v.trim();
}

/** The options a command line asks for, or the `UsageError` / `EvalRefusal` it earns. `cases` is where the conversations are chosen from. */
function resolveOptions(p: Parsed, all: readonly EvalCase[]): Options {
    // Refusal first: a command line that names a tenant is refused as that, not as an unknown flag.
    assertNoLiveFlags(names(p));
    const unknown = names(p).filter((n) => !BOOLEAN_FLAGS.has(n) && !VALUE_FLAGS.has(n));
    if (unknown.length > 0) throw new UsageError(`unknown option ${unknown.map((n) => `--${n}`).join(', ')}`);
    for (const flag of BOOLEAN_FLAGS) {
        const v = p.flags.get(flag);
        if (v !== undefined && v !== true) throw new UsageError(`--${flag} takes no value`);
    }

    const stub = p.flags.has('stub') || p.flags.has('dry-run');
    if (stub) {
        for (const flag of ['model', 'provider', 'effort', 'judge-model', 'no-judge', 'timeout-ms']) {
            if (p.flags.has(flag)) throw new UsageError(`--stub asks no model: it cannot be combined with --${flag}`);
        }
    }

    const provider = valueOf(p, 'provider') ?? DEFAULT_PROVIDER;
    if (!isProviderId(provider)) throw new UsageError(`--provider "${provider.slice(0, 30)}" is not a provider`);

    const effort = valueOf(p, 'effort') ?? DEFAULT_EFFORT;
    if (!(EFFORTS as readonly string[]).includes(effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);

    let models: string[];
    const rawModels = valueOf(p, 'model');
    if (stub) models = ['stub-model'];
    else {
        if (rawModels === undefined) throw new UsageError('--model is required (for example --model claude-sonnet-5-5), or use --stub');
        models = [...new Set(rawModels.split(',').map((m) => m.trim()).filter(Boolean))];
        if (models.length === 0) throw new UsageError('--model names no model');
        for (const m of models) if (!MODEL_ID.test(m)) throw new UsageError(`"${m.slice(0, 40)}" is not a model id`);
    }

    let judgeModel: string | null = stub ? 'stub-judge' : (valueOf(p, 'judge-model') ?? DEFAULT_JUDGE_MODEL);
    if (p.flags.has('no-judge')) {
        if (p.flags.has('judge-model')) throw new UsageError('--no-judge and --judge-model contradict each other');
        judgeModel = null;
    }
    if (judgeModel !== null && !stub && !MODEL_ID.test(judgeModel)) throw new UsageError(`"${judgeModel.slice(0, 40)}" is not a model id`);

    const rawTimeout = valueOf(p, 'timeout-ms');
    const timeoutMs = rawTimeout === undefined ? EVAL_TIMEOUT_MS : Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new UsageError(`--timeout-ms must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);

    const casesSpec = valueOf(p, 'cases');
    if (stub && casesSpec !== undefined) throw new UsageError('--stub runs its own two cases and cannot be combined with --cases');
    let cases: EvalCase[];
    try {
        cases = stub ? selectCases(all, DRY_RUN_CASES.join(',')) : selectCases(all, casesSpec);
    } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    if (cases.length === 0) throw new UsageError('no conversations to run');
    assertFixturesOnly(cases);

    return { models, provider, effort: effort as Effort, judgeModel, cases, report: valueOf(p, 'report') ?? null, stub, cache: !p.flags.has('no-cache'), timeoutMs };
}

const defaultCases = (): EvalCase[] => loadCases(CONVERSATIONS_DIR, (fixture) => new Set(resolveFixture(fixture).ctx.offers.map((o) => o.id)));

const failedWord = (c: CaseOutcome): string => (c.pass ? 'PASS' : 'FAIL');

/** Runs the command line. Returns the exit code; prints through `deps.io` and never calls `process.exit`. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
    const { io } = deps;
    let parsed: Parsed;
    try {
        parsed = parse(argv);
    } catch (err) {
        io.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
        return 2;
    }
    if (parsed.flags.has('help') || parsed.flags.has('h')) {
        io.out(USAGE);
        return 0;
    }

    let options: Options;
    let all: EvalCase[];
    try {
        assertNoLiveFlags(names(parsed));
        all = (deps.cases ?? defaultCases)();
        if (parsed.flags.has('list')) {
            for (const c of all) io.out(`${c.id.padEnd(26)} ${c.writes.padEnd(9)} ${c.fixture.padEnd(16)} ${String(c.turns.length)} turn${c.turns.length === 1 ? ' ' : 's'}  ${c.title}`);
            return 0;
        }
        options = resolveOptions(parsed, all);
    } catch (err) {
        if (err instanceof EvalRefusal) {
            io.err(`refused: ${err.message}`);
            return 3;
        }
        if (err instanceof UsageError) {
            io.err(`${err.message}\n\n${USAGE}`);
            return 2;
        }
        io.err(`could not start: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    }

    let callers: Callers;
    try {
        callers = options.stub
            ? { sales: () => stubSalesCaller(), judge: stubJudgeCaller() }
            : await deps.makeCallers(options);
    } catch (err) {
        if (err instanceof EvalRefusal) {
            io.err(`refused: ${err.message}`);
            return 3;
        }
        io.err(`could not start: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    }

    try {
        const runs = [];
        for (const model of options.models) {
            io.err(`-- ${model}: ${options.cases.length} conversations${options.judgeModel ? `, judged by ${options.judgeModel}` : ', not judged'}`);
            runs.push(await runEval({
                cases: options.cases, model, provider: options.stub ? 'stub' : options.provider, effort: options.stub ? 'n/a' : options.effort, judgeModel: options.judgeModel,
                settings: { caller: callers.sales(model), judge: options.judgeModel ? callers.judge : null, timeoutMs: options.timeoutMs, cacheSystem: options.cache },
                onCase: (c) => io.err(`   ${c.id.padEnd(26)} ${failedWord(c)}`),
            }));
        }
        io.out(renderTerminal(runs));
        if (options.report) {
            io.writeFile(options.report, renderMarkdown(runs, { at: io.now(), command: `npx tsx scripts/eval-dm-sales.mts ${argv.join(' ')}`.trim(), stub: options.stub, cacheSystem: options.cache }));
            io.err(`report written to ${options.report}`);
        }
        return runs.every((r) => summarize(r).barMet) ? 0 : 1;
    } catch (err) {
        io.err(`the run failed: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    } finally {
        await callers.close?.().catch(() => undefined);
    }
}
