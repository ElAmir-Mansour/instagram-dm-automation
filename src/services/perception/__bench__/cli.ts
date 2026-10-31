/**
 * The command line of `scripts/eval-muse.mts`, as a function with its keys, its files and its network handed in, so a test can run it: options in, a report out, an exit code
 * back. The script itself only reads the key (from `--env <file>` or, with `--settings`, from Settings through a read-only connection), wires the real files and the real
 * console, and calls this.
 *
 *   npm run eval:muse -- --env ../.env                 the benchmark, against the live Meta API, writing docs/hackathon/benchmark.md and benchmark.svg
 *   npm run eval:muse -- --env ../.env --voice --memory --library library.json --open-weights
 *   npm run eval:muse -- --stub --out scratch/bench    a dry run: canned answers, no key, no network; writes where you say and nowhere else
 *
 * Exit: 0 the run met the bar · 1 it ran and did not meet it (the report is written all the same) · 2 usage, or nothing could run · 3 refused: no key, or a model or a flag it
 * does not take.
 *
 * What it will not do, and the tests hold each to the source: run from `npm test` or CI (it is only ever the script that calls it, by hand); write to a database (it opens none:
 * the one the script opens for `--settings` is read-only, for a key, and is closed before this runs); send a message (no Send API is imported); read a tenant, a conversation or
 * a stored profile (a flag that names one is refused, as the DM evaluation refuses it: the prompts are built from the committed fixtures); or print a key.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setAiCaller } from '../../aiProviders/generate.js';
import { setLogSink } from '../../../utils/log.js';
import { isContributorModel } from '../../aiProviders/purposes.js';
import { DEFAULT_JUDGE_MODEL } from '../../dmSales/__evals__/cli.js';
import { promptDigest } from '../../dmSales/__evals__/fixtures.js';
import { JUDGE_EFFORT } from '../../dmSales/__evals__/judge.js';
import { assertNoLiveFlags, EvalRefusal } from '../../dmSales/__evals__/refusal.js';
import type { FetchLike } from '../../llm/types.js';
import { crashedResult, runMetaCase, runTodayCase, type ArmDeps } from './arms.js';
import { Ledger, makeAiCaller, makeEvalCaller, redactKeys } from './caller.js';
import { displayPath, loadCasesFile, loadFile, loadMedia, selectMuseCases, type MediaLoad } from './cases.js';
import { ARM_LABELS, barMet, summarizeArm } from './metrics.js';
import { parseLibrary, runMemoryArm, summarizeMemory, transcriptOnly, type LibraryRow, type MemoryResult, type Recall } from './memory.js';
import { analyse, HOSTED_MODEL, OPEN_MODEL, reelAnalyzer, type AnalysisRun } from './openWeights.js';
import { renderMarkdown, renderTerminal, type BenchmarkRun } from './report.js';
import { FakeClock, stubAiCaller, stubJudge, stubSalesCaller, stubTranscribe } from './stub.js';
import { renderChart } from './svg.js';
import type { ArmCaseResult, ArmId, MuseCase, ParsedCases, SkippedArm } from './types.js';
import { runVoiceCase, type TranscribeVoice } from './voice.js';

export const DEFAULT_MODEL = 'muse-spark-1.3';
export const MD_FILE = 'benchmark.md';
export const SVG_FILE = 'benchmark.svg';

export const USAGE = `Muse benchmark: what the sales agent does with what followers send without a word, set beside what it did before Muse.

  npm run eval:muse -- --env <file> [options]       needs META_MODEL_API_KEY in that file (or in the environment)
  npm run eval:muse -- --settings --env <file>      the key saved in Settings -> AI providers, read through a read-only connection
  npm run eval:muse -- --stub --out <dir>           a dry run: canned answers, no key, no network

  --env <file>          the .env that holds the key (and, for --settings, DATABASE_URL and TOKEN_ENCRYPTION_KEY). No .env is read unless you name it
  --settings            read the key from Settings instead of the file (a read-only database connection, opened only for that)
  --media-dir <dir>     where the media files are (default: ~/Desktop/Meta hackathon tests/media). No media is in the repository
  --cases <list>        which cases, comma-separated (default all): an id is that case alone, anything else is the start of some ids (reel-own, image-price-). --list shows them
  --model <id>          the Muse Spark model for perception and replies (default ${DEFAULT_MODEL}); a -contributor id only for the drawn cases
  --voice               also run the voice notes through the product's transcription (needs src/services/perception/voice.ts: skipped with a note until it lands)
  --memory              also ask the video memory its ten questions of two libraries (needs src/services/perception/recall.ts and --library)
  --library <file>      the reel library as JSON: the reel_analyses rows with status ok, as listOkForRecall returns them
  --open-weights        also analyse one reel on Muse Spark Open (Baseten) and on hosted Muse Spark (needs BASETEN_API_KEY)
  --judge               also score tone and helpfulness with a Claude judge (needs ANTHROPIC_API_KEY; ${DEFAULT_JUDGE_MODEL} unless --judge-model says another)
  --judge-model <id>    the judge's model
  --no-today-text       leave out the cases with typed words from today's arm (they ask a model: today's text path on the same one)
  --out <dir>           where benchmark.md and benchmark.svg are written (default docs/hackathon)
  --no-write            print the report and write nothing
  --stub                dry run: canned answers, nothing sent anywhere; needs --out, and never writes to docs/hackathon
  --list                list the cases and exit
  --help

It calls the live Meta API with your key (about twenty cents a run, a few dollars with the judge on) and writes no database: its model calls are priced from what the responses report.

Exit: 0 the bar was met · 1 it ran and the bar was not met · 2 usage, or nothing could run · 3 refused (no key, a model or flag it does not take).`;

class UsageError extends Error {}

/**
 * One case of one arm: its result, or, when it stopped on an error nobody planned for, a row that says so (and the error said on stderr, with every key taken out). The known ways a call
 * fails are rows already, made by the arms; this is for the rest, so that a case that throws does not take the cases before it, and what they cost, with it.
 */
export async function guardedCase(
    arm: ArmId, c: MuseCase, run: () => Promise<ArmCaseResult | null>,
    o: { ledger: Ledger; say(text: string): void; redact(text: string): string; clock?: () => number },
): Promise<ArmCaseResult | null> {
    const clock = o.clock ?? (() => performance.now());
    const started = clock();
    try {
        return await run();
    } catch (e) {
        const reason = o.redact(e instanceof Error ? e.message : String(e));
        o.say(`${c.id} (${arm}) stopped on an error: ${reason}`);
        return crashedResult(arm, c, reason, { ledger: o.ledger }, clock() - started);
    }
}

export interface CliIo {
    out(text: string): void;
    err(text: string): void;
    writeFile(file: string, text: string): void;
    readFile(file: string): Promise<Buffer>;
    now(): Date;
}

/** The keys the script found, and where the first came from. Null is none. */
export interface CliKeys {
    meta: string | null;
    anthropic: string | null;
    baseten: string | null;
    from: string;
}

/** A module another PR adds, once it is in: loaded by the script, which says whether it is there. */
export type Loaded<T> = { present: true; value: T } | { present: false; why: string };

export interface CliDeps {
    io: CliIo;
    keys: CliKeys;
    /** `scripts/eval-muse/cases.json`. */
    casesFile: string;
    defaultMediaDir: string;
    /** The folder the document and the chart go to unless `--out` says another. */
    defaultOut: string;
    fetchImpl?: FetchLike;
    /** The voice module, wired to the benchmark's key. Absent: the arm is skipped with the note it gives. */
    loadVoice?: (keys: CliKeys) => Promise<Loaded<TranscribeVoice>>;
    /** The product's recall, wired (`adaptRecall`). It is given the ledger so that what the call cost can be read from it. */
    loadRecall?: (ledger: Ledger) => Promise<Loaded<Recall>>;
    /** The text of the library file. */
    readText?: (file: string) => Promise<string>;
}

const BOOLEAN_FLAGS = new Set(['settings', 'voice', 'memory', 'open-weights', 'judge', 'no-today-text', 'no-write', 'stub', 'list', 'help', 'h']);
const VALUE_FLAGS = new Set(['env', 'media-dir', 'cases', 'model', 'library', 'judge-model', 'out']);

export interface Options {
    cases: string | undefined;
    mediaDir: string | null;
    model: string;
    out: string | null;
    library: string | null;
    judgeModel: string | null;
    voice: boolean;
    memory: boolean;
    openWeights: boolean;
    todayText: boolean;
    noWrite: boolean;
    stub: boolean;
    settings: boolean;
}

function parseFlags(argv: readonly string[]): Map<string, string | true> {
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith('--') && arg !== '-h') throw new UsageError(`unexpected argument "${arg.slice(0, 40)}"`);
        const body = arg === '-h' ? 'h' : arg.slice(2);
        const eq = body.indexOf('=');
        const name = eq === -1 ? body : body.slice(0, eq);
        flags.set(name, eq === -1 ? true : body.slice(eq + 1));
        // A flag that is not a known switch takes the word after it as its value, known or not: `--tenant abc` is read as a flag with a value, so it is refused as one.
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
    return flags;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

function resolveOptions(flags: Map<string, string | true>): Options {
    // A flag that would point it at live data is refused as that, before it is read as unknown.
    assertNoLiveFlags([...flags.keys()]);
    const unknown = [...flags.keys()].filter((n) => !BOOLEAN_FLAGS.has(n) && !VALUE_FLAGS.has(n));
    if (unknown.length > 0) throw new UsageError(`unknown option ${unknown.map((n) => `--${n}`).join(', ')}`);
    for (const f of BOOLEAN_FLAGS) {
        const v = flags.get(f);
        if (v !== undefined && v !== true) throw new UsageError(`--${f} takes no value`);
    }
    const value = (name: string): string | null => {
        const v = flags.get(name);
        if (v === undefined) return null;
        if (v === true || v.trim() === '') throw new UsageError(`--${name} needs a value`);
        return v.trim();
    };
    const model = value('model') ?? DEFAULT_MODEL;
    if (!MODEL_ID.test(model)) throw new UsageError(`"${model.slice(0, 40)}" is not a model id`);
    const judge = flags.has('judge');
    const judgeModel = value('judge-model');
    if (judgeModel !== null && !judge) throw new UsageError('--judge-model needs --judge');
    if (judgeModel !== null && !MODEL_ID.test(judgeModel)) throw new UsageError(`"${judgeModel.slice(0, 40)}" is not a model id`);
    const stub = flags.has('stub');
    if (stub && flags.has('out') === false) throw new UsageError('--stub needs --out <dir>: a dry run never writes to docs/hackathon');
    return {
        cases: value('cases') ?? undefined, mediaDir: value('media-dir'), model, out: value('out'), library: value('library'), judgeModel: judge ? (judgeModel ?? DEFAULT_JUDGE_MODEL) : null,
        voice: flags.has('voice'), memory: flags.has('memory'), openWeights: flags.has('open-weights'), todayText: !flags.has('no-today-text'), noWrite: flags.has('no-write'), stub,
        settings: flags.has('settings'),
    };
}

/** A command as it is printed in a public document: a home folder is `~`, so no user name is in it. */
export function printable(argv: readonly string[]): string {
    return `npm run eval:muse -- ${argv.map((a) => displayPath(a)).join(' ')}`.trim();
}

const digestOf = (cases: readonly MuseCase[]): string => createHash('sha256').update(JSON.stringify(cases)).digest('hex').slice(0, 12);

/** Contributor mode lets Meta train on what is sent: only a case drawn by this script (no real person's, no real document) may go to it. */
function assertModelAllowed(model: string, cases: readonly MuseCase[]): void {
    if (!isContributorModel(model)) return;
    const real = cases.filter((c) => c.source.kind !== 'synthetic');
    if (real.length > 0) {
        throw new EvalRefusal(`--model ${model} is a Contributor-mode model: Meta may train on what is sent to it, so only the drawn cases may go there (and ${real.length} selected case${real.length === 1 ? ' is' : 's are'} not drawn: ${real.slice(0, 3).map((c) => c.id).join(', ')}${real.length > 3 ? ', …' : ''}). Pick the cases with --cases, or a Standard model.`);
    }
}

/** Runs the command line. Returns the exit code; prints through `deps.io` and never calls `process.exit`. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
    const { io, keys } = deps;
    // Nothing printed may hold a key: every line passes through this.
    const out = (text: string): void => io.out(redactKeys(text, keys.meta, keys.anthropic, keys.baseten));
    const err = (text: string): void => io.err(redactKeys(text, keys.meta, keys.anthropic, keys.baseten));

    let flags: Map<string, string | true>;
    try {
        flags = parseFlags(argv);
    } catch (e) {
        err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
        return 2;
    }
    if (flags.has('help') || flags.has('h')) {
        out(USAGE);
        return 0;
    }

    let options: Options;
    let parsed: ParsedCases;
    let selected: MuseCase[];
    try {
        options = resolveOptions(flags);
        if (options.stub && options.out !== null && path.resolve(options.out) === path.resolve(deps.defaultOut)) {
            throw new UsageError(`--stub never writes to ${displayPath(deps.defaultOut)}: that is where a real run's document goes, and a dry run's canned answers would replace it. Pick another --out.`);
        }
        parsed = loadCasesFile(deps.casesFile);
        if (flags.has('list')) {
            for (const c of parsed.cases) out(`${c.id.padEnd(28)} ${c.kind.padEnd(14)} ${c.fixture.padEnd(16)} ${c.typed ? 'words' : 'no words'}   ${c.title}`);
            return 0;
        }
        selected = selectMuseCases(parsed.cases, options.cases);
        assertModelAllowed(options.model, selected);
    } catch (e) {
        if (e instanceof EvalRefusal) {
            err(`refused: ${e.message}`);
            return 3;
        }
        err(`${e instanceof UsageError ? `${e.message}\n\n${USAGE}` : `could not start: ${e instanceof Error ? e.message : String(e)}`}`);
        return 2;
    }

    // No key, no run: nothing below this line can reach the network without one, and a dry run asks for none.
    if (!options.stub) {
        if (!keys.meta) {
            err(options.settings
                ? 'refused: no key is saved in Settings -> AI providers for Meta (Muse). Nothing was sent anywhere.'
                : 'refused: there is no Meta key to try. Pass --env <file> with META_MODEL_API_KEY in it, or --settings to read the one saved in Settings -> AI providers. Nothing was sent anywhere.');
            return 3;
        }
        if (options.judgeModel !== null && !keys.anthropic) {
            err('refused: --judge needs ANTHROPIC_API_KEY (in the --env file, or in Settings with --settings). Nothing was sent anywhere.');
            return 3;
        }
        if (options.openWeights && !keys.baseten) {
            err('refused: --open-weights needs BASETEN_API_KEY (in the --env file). Nothing was sent anywhere.');
            return 3;
        }
    }
    if (options.library !== null && !options.memory) {
        err(`--library is for --memory\n\n${USAGE}`);
        return 2;
    }
    // Everything that can be found wrong for free is found before the first call that costs: a library that is missing or is not a list of rows must not be discovered after the cases ran.
    let library: LibraryRow[] | null = null;
    if (options.memory && !options.stub) {
        if (options.library === null) {
            err(`--memory needs --library <file>: the reel_analyses rows with status ok, as JSON\n\n${USAGE}`);
            return 2;
        }
        try {
            const text = deps.readText ? await deps.readText(options.library) : (await io.readFile(options.library)).toString('utf8');
            library = parseLibrary(JSON.parse(text));
        } catch (e) {
            err(`--library ${displayPath(options.library)} cannot be used: ${e instanceof Error ? e.message : String(e)}`);
            return 2;
        }
    }

    const outDir = path.resolve(options.out ?? deps.defaultOut);
    const mediaDir = options.mediaDir ?? deps.defaultMediaDir;
    const ledger = new Ledger();
    const clock = options.stub ? new FakeClock() : null;

    // The stand-ins for the providers layer: perception asks it for `perception_dm`, and the sales turn's draft and the judge are callers of their own.
    const salesCaller = options.stub ? stubSalesCaller(ledger, parsed.cases) : makeEvalCaller({ provider: 'meta', model: options.model, effort: 'low', role: 'reply', apiKey: keys.meta!, ledger, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    const judgeCaller = options.judgeModel === null ? null : options.stub ? stubJudge()
        : makeEvalCaller({ provider: 'anthropic', model: options.judgeModel, effort: JUDGE_EFFORT, role: 'judge', apiKey: keys.anthropic!, ledger, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    const aiCaller = options.stub ? stubAiCaller(ledger, clock!) : makeAiCaller(options.model, { apiKey: keys.meta!, ledger, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    const previousCaller = setAiCaller(aiCaller);
    // The product modules this reuses log a JSON line a step. A warning or an error is worth seeing (never with a key in it: the sink redacts), the rest would bury the report.
    const previousSink = setLogSink((level, line) => {
        if (level === 'warn' || level === 'error') err(line);
    });

    try {
        const arm: ArmDeps = { sales: salesCaller, judge: judgeCaller, ledger, todayText: options.todayText, ...(clock ? { clock: clock.now } : {}) };
        const results: ArmCaseResult[] = [];
        const skippedCases: { caseId: string; why: string }[] = [];
        const skippedArms: SkippedArm[] = [];

        // ─── The voice arm: found before anything is run, so a case is skipped once, with the one reason ───
        let transcribe: TranscribeVoice | null = null;
        const voiceCases = selected.filter((c) => c.kind === 'voice');
        if (options.voice && voiceCases.length > 0) {
            const loaded = options.stub ? ({ present: true, value: stubTranscribe(parsed.cases, clock!) } as const) : deps.loadVoice ? await deps.loadVoice(keys) : ({ present: false, why: 'no loader for it' } as const);
            if (loaded.present) transcribe = loaded.value;
            else skippedArms.push({ arm: 'voice', label: ARM_LABELS.voice, why: `${loaded.why}. The voice notes are left out of every arm.` });
        } else if (voiceCases.length > 0) {
            skippedArms.push({ arm: 'voice', label: ARM_LABELS.voice, why: 'not asked for: add --voice to run the voice notes through the product\'s own transcription' });
        }

        // ─── The cases ───
        // The known ways a call fails are rows already (the arms say so); an error nobody planned for is a row too (`guardedCase`).
        const attempt = async (armId: ArmId, c: MuseCase, run: () => Promise<ArmCaseResult | null>): Promise<void> => {
            const r = await guardedCase(armId, c, run, { ledger, say: err, redact: (t) => redactKeys(t, keys.meta, keys.anthropic, keys.baseten) });
            if (r) results.push(r);
        };

        // A dry run sends the bytes nowhere, so it needs no file: the same arms run wherever the repository is, with no media folder.
        const media = { readFile: options.stub ? async () => Buffer.from('dry run: placeholder bytes') : (f: string) => io.readFile(f) };
        for (const c of selected) {
            const isVoice = c.kind === 'voice';
            if (isVoice && transcribe === null) continue;
            const load: MediaLoad | null = await loadMedia(c, mediaDir, media);
            if (load && !load.ok) {
                skippedCases.push({ caseId: c.id, why: load.why });
                err(`skipped ${c.id}: ${load.why}`);
                continue;
            }
            const loaded = load ? load.media : null;
            err(`-- ${c.id}`);
            if (isVoice) {
                await attempt('voice', c, () => runVoiceCase(c, loaded!, transcribe!, arm));
                await attempt('today_voice', c, () => runTodayCase(c, arm, 'today_voice'));
            } else {
                await attempt('meta', c, () => runMetaCase(c, loaded, arm));
                await attempt('today', c, () => runTodayCase(c, arm));
            }
        }
        if (results.length === 0) {
            err(`nothing ran: ${skippedCases.length > 0 ? `${skippedCases.length} case${skippedCases.length === 1 ? '' : 's'} had no file in ${displayPath(mediaDir)} (pass --media-dir)` : 'no case was selected'}.`);
            return 2;
        }

        // ─── The memory arm ───
        let memory: BenchmarkRun['memory'] = null;
        if (options.memory) {
            if (options.stub) {
                skippedArms.push({ arm: 'memory', label: 'Memory', why: 'a dry run has no library to ask' });
            } else {
                const loaded = deps.loadRecall ? await deps.loadRecall(ledger) : ({ present: false, why: 'no loader for it' } as const);
                if (!loaded.present) {
                    skippedArms.push({ arm: 'memory', label: 'Memory', why: loaded.why });
                } else {
                    const rows = library!;
                    const recall: Recall = loaded.value;
                    const visual = await runMemoryArm('memory_visual', parsed.memory, rows, rows, recall);
                    const plain = await runMemoryArm('memory_transcript', parsed.memory, transcriptOnly(rows), rows, recall);
                    const all: MemoryResult[] = [...visual, ...plain];
                    memory = { library: rows.length, results: all, summaries: [summarizeMemory('memory_visual', all), summarizeMemory('memory_transcript', all)] };
                }
            }
        }

        // ─── Open weights against hosted ───
        let openWeights: AnalysisRun[] | null = null;
        if (options.openWeights) {
            const spec = parsed.openWeights;
            if (!spec) {
                skippedArms.push({ arm: 'open_weights', label: 'Open weights', why: 'the cases file names no reel for it' });
            } else if (options.stub) {
                skippedArms.push({ arm: 'open_weights', label: 'Open weights', why: 'a dry run does not call either model' });
            } else {
                const load = await loadFile(spec.file, mediaDir, media);
                if (!load.ok) {
                    skippedArms.push({ arm: 'open_weights', label: 'Open weights', why: load.why });
                } else {
                    err('-- open weights');
                    const hosted = await analyse('Muse Spark, hosted by Meta', options.model === DEFAULT_MODEL ? HOSTED_MODEL : options.model, reelAnalyzer({ provider: 'meta', model: options.model === DEFAULT_MODEL ? HOSTED_MODEL : options.model, apiKey: keys.meta!, ledger, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }), load.media, spec, keys.meta!);
                    const open = await analyse('Muse Spark Open, served by Baseten', OPEN_MODEL, reelAnalyzer({ provider: 'baseten', model: OPEN_MODEL, apiKey: keys.baseten!, ledger, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }), load.media, spec, keys.baseten!);
                    openWeights = [hosted, open];
                }
            }
        }

        // ─── The numbers ───
        const speech = transcribe ? 'muse-voice-transcribe-1.0' : null;
        const modelsOf: Record<ArmId, string> = {
            meta: options.model, today: 'none for a message with no words', voice: speech ? `${speech}, then ${options.model}` : options.model, today_voice: 'none',
            memory_visual: options.model, memory_transcript: options.model,
        };
        const armsRun = [...new Set(results.map((r) => r.arm))];
        const summaries = armsRun.map((a) => summarizeArm(a, modelsOf[a], results));
        const ran = selected.filter((c) => !skippedCases.some((s) => s.caseId === c.id) && !(c.kind === 'voice' && transcribe === null));
        // What a module or a file said about why an arm did not run goes into the document and the chart: with a key taken out BEFORE the chart cuts it to length, or a cut through the
        // middle of a key would leave a piece of it that no longer matches.
        const clean = (text: string): string => redactKeys(text, keys.meta, keys.anthropic, keys.baseten);
        const notes = { arms: skippedArms.map((s) => ({ ...s, why: clean(s.why) })), cases: skippedCases.map((s) => ({ ...s, why: clean(s.why) })) };
        const run: BenchmarkRun = {
            at: io.now(), command: printable(argv), stub: options.stub,
            models: { perception: options.model, reply: options.model, judge: options.judgeModel, speech, open: openWeights ? OPEN_MODEL : null },
            casesDigest: digestOf(ran), promptDigest: promptDigest([...new Set(ran.map((c) => c.fixture))]), mediaDir: displayPath(mediaDir),
            cases: ran, skippedCases: notes.cases, results, summaries, skippedArms: notes.arms, memory, openWeights, judgeUsd: judgeCaller ? ledger.judgeUsd() : null, unpriced: ledger.unpriced(),
        };

        const md = renderMarkdown(run);
        const svg = renderChart({
            title: 'What the agent does with what it is sent',
            subtitle: `${ran.length} cases · ${options.model} · ${io.now().toISOString().slice(0, 10)}${options.stub ? ' · dry run' : ''}`,
            arms: summaries, memory: memory?.summaries ?? [], skipped: notes.arms.filter((s) => s.arm === 'voice' || s.arm === 'memory'), stub: options.stub,
        });
        out(renderTerminal(run));
        if (!options.noWrite) {
            // A public file: a key is taken out of it too, though nothing the benchmark sends a model holds one.
            io.writeFile(path.join(outDir, MD_FILE), clean(md));
            io.writeFile(path.join(outDir, SVG_FILE), clean(svg));
            err(`written: ${displayPath(path.join(outDir, MD_FILE))} and ${SVG_FILE}`);
        }
        return options.stub || barMet(summaries) ? 0 : 1;
    } catch (e) {
        err(`the run failed: ${e instanceof Error ? e.message : String(e)}`);
        return 2;
    } finally {
        setAiCaller(previousCaller);
        setLogSink(previousSink);
    }
}

