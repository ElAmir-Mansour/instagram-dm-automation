/**
 * The command line (`cli.ts`), run as a function with a console, a file system and its models handed in: what each option does, what is a
 * usage error (exit 2) and what is a refusal (exit 3), that the dry run asks no one, and that the exit code says whether the bar was met.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_EFFORT, DEFAULT_JUDGE_MODEL, DEFAULT_PROVIDER, runCli, USAGE, type Callers, type CliDeps, type Options } from './cli.js';
import { EVAL_TIMEOUT_MS } from './runner.js';
import { STUB_ANSWERS, stubJudgeCaller, stubSalesCaller } from './stub.js';
import { allCases, answer } from './testHelpers.js';
import { EvalRefusal } from './refusal.js';
import type { EvalCaller } from './types.js';

interface Harness {
    out: string[];
    err: string[];
    files: Map<string, string>;
    made: Options[];
    closed: number;
    deps: CliDeps;
}

/** A console and file system that remember, and a `makeCallers` that records its options and answers with `callers` (or refuses to be asked). */
function harness(callers?: (options: Options) => Callers): Harness {
    const h: Harness = {
        out: [], err: [], files: new Map(), made: [], closed: 0,
        deps: {
            cases: () => allCases(),
            io: {
                out: (t) => h.out.push(t), err: (t) => h.err.push(t), writeFile: (f, t) => { h.files.set(f, t); }, now: () => new Date('2026-10-14T12:00:00Z'),
            },
            makeCallers: async (options) => {
                h.made.push(options);
                if (!callers) throw new Error('a model must not be asked');
                const made = callers(options);
                return { ...made, close: async () => { h.closed += 1; } };
            },
        },
    };
    return h;
}

/** Answers for every case a good model would get right, for the two the stub knows. */
const goodCallers = (): Callers => ({ sales: () => stubSalesCaller(), judge: stubJudgeCaller() });

const run = (argv: string[], h: Harness): Promise<number> => runCli(argv, h.deps);
const text = (lines: string[]): string => lines.join('\n');

describe('help and list', () => {
    it('--help and -h print the usage and exit 0 without asking anyone', async () => {
        for (const flag of ['--help', '-h']) {
            const h = harness();
            assert.equal(await run([flag], h), 0);
            assert.equal(text(h.out), USAGE);
            assert.equal(h.made.length, 0);
        }
    });

    it('--list prints the fifteen conversations, with their variety, fixture and turns', async () => {
        const h = harness();
        assert.equal(await run(['--list'], h), 0);
        assert.equal(h.out.length, 15);
        assert.match(h.out[0]!, /^01-price-gulf +gulf +owner-ar +1 turn +Price question/);
        assert.match(h.out[14]!, /^15-multi-turn-gulf +gulf +owner-ar +3 turns +Qualify/);
        assert.equal(h.made.length, 0);
    });

    it('the usage names every option the command line has', () => {
        for (const flag of ['--model', '--provider', '--effort', '--cases', '--judge-model', '--no-judge', '--report', '--timeout-ms', '--no-cache', '--stub', '--list', '--help']) {
            assert.ok(USAGE.includes(flag), flag);
        }
        assert.match(USAGE, /sends nothing/);
        assert.match(USAGE, /purpose "eval"/);
        assert.match(USAGE, /charged to no tenant/);
    });
});

describe('--stub, the dry run', () => {
    it('runs its two conversations through the real pipeline, asks no model, needs no key, and exits 0', async () => {
        const h = harness();
        assert.equal(await run(['--stub'], h), 0);
        assert.equal(h.made.length, 0, 'it never builds a real caller');
        const out = text(h.out);
        assert.match(out, /^== stub-model \(stub, effort n\/a\), judge stub-judge ==/);
        assert.match(out, /01-price-gulf +gulf +owner-ar +1 +model +PASS/);
        assert.match(out, /05-link-now-gulf +gulf +owner-ar +1 +model +PASS/);
        assert.match(out, /^bar {7}MET$/m);
        assert.match(text(h.err), /-- stub-model: 2 conversations, judged by stub-judge/);
    });

    it('writes the markdown report when asked, and the report says it is a dry run', async () => {
        const h = harness();
        assert.equal(await run(['--stub', '--report', 'out/dry.md'], h), 0);
        const report = h.files.get('out/dry.md')!;
        assert.match(report, /^# DM sales evaluation\n\n> \*\*Dry run\.\*\*/);
        assert.match(report, /- Run: 2026-10-14T12:00:00\.000Z/);
        assert.match(report, /- Command: `npx tsx scripts\/eval-dm-sales\.mts --stub --report out\/dry\.md`/);
        assert.match(text(h.err), /report written to out\/dry\.md/);
    });

    it('also answers to --dry-run', async () => {
        const h = harness();
        assert.equal(await run(['--dry-run'], h), 0);
        assert.match(text(h.out), /stub-model/);
    });

    it('is a usage error with anything that would ask a model or choose other cases', async () => {
        for (const extra of [['--model', 'm'], ['--provider', 'anthropic'], ['--effort', 'low'], ['--judge-model', 'j'], ['--no-judge'], ['--timeout-ms', '5000'], ['--cases', '1']]) {
            const h = harness();
            assert.equal(await run(['--stub', ...extra], h), 2, extra.join(' '));
            assert.match(text(h.err), /--stub/);
            assert.equal(h.out.length, 0);
        }
    });
});

describe('a real run: what the options become', () => {
    it('defaults to the provider, the effort, the judge, all fifteen cases, the cache and the live deadline', async () => {
        const h = harness(goodCallers);
        const code = await run(['--model', 'claude-sonnet-5-5', '--cases', '1,5'], h);
        assert.equal(code, 0);
        const o = h.made[0]!;
        assert.deepEqual([o.models, o.provider, o.effort, o.judgeModel, o.report, o.stub, o.cache, o.timeoutMs], [['claude-sonnet-5-5'], DEFAULT_PROVIDER, DEFAULT_EFFORT, DEFAULT_JUDGE_MODEL, null, false, true, EVAL_TIMEOUT_MS]);
        assert.deepEqual([DEFAULT_PROVIDER, DEFAULT_EFFORT, DEFAULT_JUDGE_MODEL], ['anthropic', 'low', 'claude-opus-5-5']);
        assert.deepEqual(o.cases.map((c) => c.id), ['01-price-gulf', '05-link-now-gulf']);
        const all = harness(goodCallers);
        await run(['--model', 'm', '--cases', 'all'], all);
        assert.equal(all.made[0]!.cases.length, 15);
    });

    it('takes every option, in either form (--name value or --name=value)', async () => {
        const h = harness(goodCallers);
        const code = await run(['--model=claude-haiku-5-5,claude-sonnet-5-5,claude-haiku-5-5', '--provider', 'anthropic', '--effort=medium', '--cases', '5', '--judge-model', 'claude-opus-5-5', '--no-cache', '--timeout-ms', '5000', '--report', 'r.md'], h);
        assert.equal(code, 0);
        const o = h.made[0]!;
        assert.deepEqual([o.models, o.effort, o.judgeModel, o.cache, o.timeoutMs, o.report], [['claude-haiku-5-5', 'claude-sonnet-5-5'], 'medium', 'claude-opus-5-5', false, 5000, 'r.md']);
        assert.ok(h.files.has('r.md'));
    });

    it('runs each model in turn with its own caller, prints a comparison and one block each, and puts progress on stderr and the report on stdout', async () => {
        const asked: string[] = [];
        const h = harness((options) => ({
            sales: (model) => { asked.push(model); return stubSalesCaller(); },
            judge: options.judgeModel ? stubJudgeCaller() : null,
        }));
        assert.equal(await run(['--model', 'a-1,b-2', '--cases', '1'], h), 0);
        assert.deepEqual(asked, ['a-1', 'b-2']);
        const out = text(h.out);
        assert.match(out.split('\n\n')[0]!, /^model +passed/);
        assert.match(out, /^== a-1 \(anthropic, effort low\), judge claude-opus-5-5 ==/m);
        assert.match(out, /^== b-2 \(anthropic, effort low\), judge claude-opus-5-5 ==/m);
        assert.ok(!out.includes('-- a-1'), 'progress is not in the report');
        assert.match(text(h.err), /-- a-1: 1 conversations, judged by claude-opus-5-5\n {3}01-price-gulf +PASS\n-- b-2/);
    });

    it('lets go of what the callers hold, once, when the run ends', async () => {
        const h = harness(goodCallers);
        await run(['--model', 'm', '--cases', '1'], h);
        assert.equal(h.closed, 1);
    });
});

describe('the exit code says whether the bar was met', () => {
    const badSales: EvalCaller = stubSalesCaller({ '01-price-gulf': [answer({ text: 'السعر 99 دولار. تبي أرسل لك الرابط؟' })] });

    it('is 1 when a model fails a hard check, and the report says which', async () => {
        const h = harness(() => ({ sales: () => badSales, judge: stubJudgeCaller() }));
        assert.equal(await run(['--model', 'm', '--cases', '1', '--report', 'r.md'], h), 1);
        assert.match(text(h.out), /NOT MET: 1 hard-check failure/);
        assert.match(text(h.out), /01-price-gulf turn 1 - no_invented_numbers: «99 دولار» is not in the data/);
        assert.match(h.files.get('r.md')!, /\*\*no_invented_numbers\*\*/);
        assert.match(text(h.err), /01-price-gulf +FAIL/);
    });

    it('is 1 when any one of several models fails', async () => {
        const h = harness((options) => ({ sales: (model) => (model === 'bad' ? badSales : stubSalesCaller()), judge: options.judgeModel ? stubJudgeCaller() : null }));
        assert.equal(await run(['--model', 'good,bad', '--cases', '1'], h), 1);
        assert.match(text(h.out), /good .* MET/);
        assert.match(text(h.out), /bad .* NOT MET/);
    });

    it('is 1 with --no-judge, since the soft checks went unscored, and the judge is never built or asked', async () => {
        let judged = 0;
        const h = harness((options) => ({ sales: () => stubSalesCaller(), judge: options.judgeModel ? stubJudgeCaller(() => { judged += 1; }) : null }));
        assert.equal(await run(['--model', 'm', '--cases', '1', '--no-judge'], h), 1);
        assert.equal(h.made[0]!.judgeModel, null);
        assert.equal(judged, 0);
        assert.match(text(h.out), /, no judge ==/);
        assert.match(text(h.out), /NOT MET: soft checks not scored/);
    });

    it('is 2 when the run itself cannot finish, such as a report that cannot be written', async () => {
        const h = harness(goodCallers);
        h.deps.io.writeFile = () => { throw new Error('disk full'); };
        assert.equal(await run(['--model', 'm', '--cases', '1', '--report', 'r.md'], h), 2);
        assert.match(text(h.err), /the run failed: disk full/);
        assert.equal(h.closed, 1, 'still let go of what it held');
    });
});

describe('usage errors (exit 2): nothing is asked of a model', () => {
    const cases: [string, string[], RegExp][] = [
        ['no model', [], /--model is required/],
        ['a bare word', ['--model', 'm', 'extra'], /unexpected argument "extra"/],
        ['a flag with no value', ['--model'], /--model needs a value/],
        ['a flag followed by a flag', ['--model', '--stub'], /--model needs a value/],
        ['an empty value', ['--model='], /--model needs a value/],
        ['an unknown option', ['--model', 'm', '--bogus'], /unknown option --bogus/],
        ['a model id that is not one', ['--model', 'bad id'], /"bad id" is not a model id/],
        ['a model id from a path', ['--model', '../../x'], /is not a model id/],
        ['a provider that is not one', ['--model', 'm', '--provider', 'nope'], /--provider "nope" is not a provider/],
        ['an effort that is not one', ['--model', 'm', '--effort', 'extreme'], /--effort must be one of low, medium, high, xhigh, max/],
        ['a timeout of zero', ['--model', 'm', '--timeout-ms', '0'], /--timeout-ms must be a whole number from 1 to 150000/],
        ['a timeout over the layer\'s ceiling', ['--model', 'm', '--timeout-ms', '150001'], /--timeout-ms must be a whole number/],
        ['a timeout that is not a number', ['--model', 'm', '--timeout-ms', 'soon'], /--timeout-ms must be a whole number/],
        ['a case that matches nothing', ['--model', 'm', '--cases', '99'], /no case matches "99"/],
        ['a judge model that is not one', ['--model', 'm', '--judge-model', 'x y'], /"x y" is not a model id/],
        ['--no-judge with a judge model', ['--model', 'm', '--no-judge', '--judge-model', 'j'], /contradict/],
        ['a flag that takes no value, given one', ['--model', 'm', '--no-cache=yes'], /--no-cache takes no value/],
        ['only commas for models', ['--model', ',,'], /--model names no model/],
    ];
    for (const [what, argv, message] of cases) {
        it(what, async () => {
            const h = harness();
            assert.equal(await runCli(argv, h.deps), 2);
            assert.match(text(h.err), message);
            assert.match(text(h.err), /DM sales evaluation/, 'the usage follows the message');
            assert.equal(h.made.length, 0);
            assert.equal(h.out.length, 0);
        });
    }

    it('the run could not start: a caller that cannot be built is 2, and says why', async () => {
        const h = harness();
        h.deps.makeCallers = async () => { throw new Error('DATABASE_URL is not set'); };
        assert.equal(await run(['--model', 'm'], h), 2);
        assert.match(text(h.err), /could not start: DATABASE_URL is not set/);
    });
});

describe('refusals (exit 3): pointed at live data, it does nothing', () => {
    for (const flag of ['--tenant', '--creator', '--creator-id', '--conversation', '--conversations', '--inbox', '--live', '--db', '--profile', '--send', '--token']) {
        it(`${flag} is refused before any model is built or asked, with or without a value`, async () => {
            for (const argv of [['--model', 'm', flag, 'x'], ['--model', 'm', flag], ['--stub', flag]]) {
                const h = harness(goodCallers);
                assert.equal(await run(argv, h), 3, argv.join(' '));
                assert.match(text(h.err), new RegExp(`^refused: ${flag}: this would point the evaluation at`));
                assert.match(text(h.err), /fixtures in src\/services\/dmSales\/__evals__\/fixtures\.ts only, and it sends nothing/);
                assert.equal(h.made.length, 0);
                assert.equal(h.out.length, 0);
            }
        });
    }

    it('a case that names a tenant is refused when the cases are chosen, not run', async () => {
        const h = harness(goodCallers);
        h.deps.cases = () => [{ ...allCases()[0]!, fixture: '11111111-1111-4111-8111-111111111111' as never }];
        assert.equal(await run(['--model', 'm'], h), 3);
        assert.match(text(h.err), /refused: case 01-price-gulf: ".*" is a tenant id/);
        assert.equal(h.made.length, 0);
    });

    it('a refusal while the callers are being built is a refusal', async () => {
        const h = harness();
        h.deps.makeCallers = async () => { throw new EvalRefusal('nope'); };
        assert.equal(await run(['--model', 'm'], h), 3);
        assert.match(text(h.err), /^refused: nope/);
    });
});

describe('the cases the CLI chooses from are the real ones by default', () => {
    it('loads the conversations folder and checks every offer id against its fixture', async () => {
        const h = harness(goodCallers);
        delete h.deps.cases;
        assert.equal(await run(['--list'], h), 0);
        assert.equal(h.out.length, 15);
        assert.deepEqual(STUB_ANSWERS['01-price-gulf']!.length, 1);
    });
});
