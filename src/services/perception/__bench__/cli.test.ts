/**
 * The command line (`cli.ts`) with its keys, its files, its clock and its network handed in: that it refuses to run without the key it needs and says nothing was sent; that the flags
 * that would point it at a tenant, a conversation or a stored profile are refused the way the DM evaluation refuses them; that a live run, with the network mocked, talks to Meta
 * (and, for the open weights, Baseten and the judge's Anthropic) with each key only at its own host; that it writes the document and the chart where it is told and nowhere else, never
 * prints a key, keeps going when a call fails or a case stops, and exits 0 only when the bar is met; that a dry run needs no key, no file and no network; and that the arms that wait
 * for another PR are skipped with a note until their module is there, and run that module when it is.
 *
 * Nothing here touches the network, a file or a database: `fetch`, the files and the clock are stand-ins, and the database pool is patched to fail the test that reaches it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { pool } from '../../../config/db.js';
import { setLogSink } from '../../../utils/log.js';
import { setAiCaller } from '../../aiProviders/generate.js';
import type { AiCaller } from '../../aiProviders/generate.js';
import { guardedCase, MD_FILE, runCli, SVG_FILE, USAGE, type CliDeps, type CliIo, type CliKeys, type Loaded } from './cli.js';
import { REEL_INDEX_SYSTEM } from '../reelIndex.js';
import { Ledger, redactKeys } from './caller.js';
import type { LibraryRow, Recall } from './memory.js';
import { FakeClock, stubTranscribe } from './stub.js';
import {
    ANTHROPIC_KEY, anthropicAnswer, BASETEN_KEY, CASES_FILE, caseOf, chatAnswer, committed, hasMedia, META_KEY, scriptedFetch, systemText, xmlProblems, type Recorded, type Scripted,
} from './testSupport.js';
import type { TranscribeVoice } from './voice.js';

setLogSink(() => {});

const MEDIA = '/media';
const DEFAULT_OUT = '/repo/docs/hackathon';
const OUT = '/somewhere/else';
const NOW = new Date('2026-11-01T09:30:00Z');

const PNG = Buffer.from('pretend these are the bytes of a picture');
const MP4 = Buffer.from('pretend these are the bytes of a video');
const M4A = Buffer.from('pretend these are the bytes of a voice note');
const FILES: Record<string, Buffer> = {
    [`${MEDIA}/price-screenshot.png`]: PNG, [`${MEDIA}/garbled-screenshot.png`]: PNG, [`${MEDIA}/test-video.mp4`]: MP4, [`${MEDIA}/real-reel-riyal.mp4`]: MP4, [`${MEDIA}/shared-reel.mp4`]: MP4,
    [`${MEDIA}/voice-1.m4a`]: M4A, [`${MEDIA}/voice-2.m4a`]: M4A, [`${MEDIA}/voice-3.m4a`]: M4A,
};

const SEEN = (over: Record<string, unknown> = {}) => ({
    readable: true, seen: 'A screenshot of a price: 299 Egyptian pounds, with a 50% discount until 5 November.', transcript: '', about_owner: 'unclear', confidence: 0.9, mention_summary: '', ...over,
});
const PERSONAL = SEEN({ seen: 'An identity card of Alex Example, number 1234.', about_owner: 'personal', confidence: 0.97 });
const SALES = (over: Record<string, unknown> = {}) => ({
    intent: 'price', stage: 'link', next_action: 'send_link', offer_id: 'main', handoff_reason: 'none', text: 'هلا فيك! السعر الحالي موضّح في صفحة العرض، وهذا الرابط.', quick_replies: [], ...over,
});
const REEL_ANALYSIS = {
    summary: 'A reel about a meal priced at 45 riyals that was paid for with 1 riyal: the page checks everything but the server trusts the price.', topics: ['backend', 'security'],
    seen_on_screen: ['DevTools console with a fake request', 'server.js before and after'],
    narration: 'وجد أحدهم في موقعه طلبية غريبة وجبة ثمنها خمسة وأربعون ريالا دفع فيها ريال واحد مع أن صفحته تتحقق من كل شيء فالخادم لا يرى صفحتك ولا أين ضغطت كل ما يراه هو الطلب',
    key_moments: [{ second: 0, what: 'the hook' }, { second: 9, what: 'the question' }, { second: 18, what: 'the exploit in DevTools' }, { second: 26, what: 'the fix in server.js' }],
    hook_first_3s: 'A worried man at a laptop and a headline about 45 riyals.', hook_score: 9, caption_ar: 'وجبة بخمسة وأربعين ريالا دفع فيها ريال واحد فقط تفتكر الغلطة كانت من الصفحة ولا من الخادم',
    cover_second: 6, cover_reason: 'Both prices are on screen at once.',
};
const JUDGED = { notes: 'friendly and to the point', tone: 5, helpfulness: 5, no_pressure: 5, right_recommendation: 5 };

/** What Meta answers: the picture of a price is read as a price, and the drawn identity card as a personal document. */
function metaScript(r: Recorded): Scripted {
    if (!hasMedia(r)) return chatAnswer(SALES());
    return chatAnswer(r.rawBody!.includes(PNG.toString('base64')) || r.rawBody!.includes(MP4.toString('base64')) ? SEEN() : PERSONAL);
}

interface Harness {
    deps: CliDeps;
    outs: string[];
    errs: string[];
    written: Map<string, string>;
    reads: string[];
    requests: Recorded[];
    /** Everything the command printed or wrote, as one text: where a key must not be. */
    everything(): string;
    stdout(): string;
    stderr(): string;
}

function harness(o: {
    keys?: Partial<CliKeys>; files?: Record<string, Buffer | string>; script?: (r: Recorded, n: number) => Scripted;
    loadVoice?: CliDeps['loadVoice']; loadRecall?: CliDeps['loadRecall']; readText?: CliDeps['readText'];
} = {}): Harness {
    const outs: string[] = [];
    const errs: string[] = [];
    const written = new Map<string, string>();
    const reads: string[] = [];
    const files = o.files ?? FILES;
    const net = scriptedFetch(o.script ?? ((r) => metaScript(r)));
    const io: CliIo = {
        out: (t) => { outs.push(t); },
        err: (t) => { errs.push(t); },
        writeFile: (f, t) => { written.set(f, t); },
        readFile: async (f) => {
            reads.push(f);
            const v = files[f];
            if (v === undefined) throw new Error(`ENOENT: ${f}`);
            return Buffer.isBuffer(v) ? v : Buffer.from(v);
        },
        now: () => NOW,
    };
    const keys: CliKeys = { meta: META_KEY, anthropic: null, baseten: null, from: 'a test', ...(o.keys ?? {}) };
    const deps: CliDeps = {
        io, keys, casesFile: CASES_FILE, defaultMediaDir: MEDIA, defaultOut: DEFAULT_OUT, fetchImpl: net.fetch,
        ...(o.loadVoice ? { loadVoice: o.loadVoice } : {}), ...(o.loadRecall ? { loadRecall: o.loadRecall } : {}), ...(o.readText ? { readText: o.readText } : {}),
    };
    return {
        deps, outs, errs, written, reads, requests: net.requests,
        everything: () => [...outs, ...errs, ...written.values()].join('\n'), stdout: () => outs.join('\n'), stderr: () => errs.join('\n'),
    };
}

const doc = (h: Harness, dir = OUT): { md: string; svg: string } => ({ md: h.written.get(path.join(dir, MD_FILE)) ?? '', svg: h.written.get(path.join(dir, SVG_FILE)) ?? '' });

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

// ─── It will not run without what it needs ────────────────────────────────────────────────────────────────────────────────

describe('help and the list need nothing', () => {
    it('--help prints the usage and exits 0 with no key, no file read and no request', async () => {
        for (const flag of ['--help', '-h']) {
            const h = harness({ keys: { meta: null } });
            assert.equal(await runCli([flag], h.deps), 0);
            assert.equal(h.stdout(), USAGE);
            assert.match(h.stdout(), /^Muse benchmark: what the sales agent does with what followers send/);
            assert.deepEqual([h.requests.length, h.reads.length, h.written.size], [0, 0, 0]);
        }
    });

    it('--list shows every committed case, one line each, with no key and no request', async () => {
        const h = harness({ keys: { meta: null } });
        assert.equal(await runCli(['--list'], h.deps), 0);
        const lines = h.outs;
        assert.equal(lines.length, committed().cases.length);
        for (const c of committed().cases) assert.ok(lines.some((l) => l.startsWith(c.id)), c.id);
        assert.ok(lines.some((l) => /image-price-words-ar\s+image\s+owner-ar\s+words/.test(l)));
        assert.deepEqual([h.requests.length, h.reads.length, h.written.size], [0, 0, 0]);
    });
});

describe('it refuses to run without the key it needs, and says that nothing was sent', () => {
    it('no Meta key: exit 3, the way to give one, no request, no file read, nothing written', async () => {
        const h = harness({ keys: { meta: null } });
        assert.equal(await runCli(['--cases', 'image-price'], h.deps), 3);
        assert.match(h.stderr(), /refused: there is no Meta key to try\. Pass --env <file> with META_MODEL_API_KEY in it, or --settings/);
        assert.match(h.stderr(), /Nothing was sent anywhere\./);
        assert.deepEqual([h.requests.length, h.reads.length, h.written.size], [0, 0, 0]);
    });

    it('--settings with no key saved says where to save one', async () => {
        const h = harness({ keys: { meta: null } });
        assert.equal(await runCli(['--settings'], h.deps), 3);
        assert.match(h.stderr(), /no key is saved in Settings -> AI providers for Meta \(Muse\)\. Nothing was sent anywhere\./);
        assert.equal(h.requests.length, 0);
    });

    it('--judge needs the Anthropic key and --open-weights the Baseten key: each refused before the first call, naming the key', async () => {
        const judge = harness();
        assert.equal(await runCli(['--judge'], judge.deps), 3);
        assert.match(judge.stderr(), /--judge needs ANTHROPIC_API_KEY/);
        assert.equal(judge.requests.length, 0);

        const open = harness();
        assert.equal(await runCli(['--open-weights'], open.deps), 3);
        assert.match(open.stderr(), /--open-weights needs BASETEN_API_KEY/);
        assert.equal(open.requests.length, 0);
    });

    it('a dry run asks for no key, reads no file and sends nothing', async () => {
        const h = harness({ keys: { meta: null }, script: () => { throw new Error('a dry run must not send a request'); } });
        assert.equal(await runCli(['--stub', '--out', OUT], h.deps), 0);
        assert.deepEqual([h.requests.length, h.reads.length], [0, 0]);
    });
});

// ─── Usage, and what it refuses ───────────────────────────────────────────────────────────────────────────────────────────

describe('usage errors exit 2 with the usage; refusals exit 3 with the reason', () => {
    const usage = async (argv: string[], message: RegExp, over: Parameters<typeof harness>[0] = {}, withUsage = true): Promise<Harness> => {
        const h = harness(over);
        assert.equal(await runCli(argv, h.deps), 2, argv.join(' '));
        assert.match(h.stderr(), message);
        if (withUsage) assert.match(h.stderr(), /Muse benchmark: what the sales agent does/, 'the usage follows the message');
        assert.deepEqual([h.requests.length, h.written.size], [0, 0], 'nothing was sent and nothing was written');
        return h;
    };

    it('an option it does not have, a bare word, a flag with a value it does not take, a value that is missing', async () => {
        await usage(['--nope'], /unknown option --nope/);
        await usage(['stray'], /unexpected argument "stray"/);
        await usage(['--stub=1', '--out', OUT], /--stub takes no value/);
        await usage(['--out'], /--out needs a value/);
        await usage(['--cases='], /--cases needs a value/);
    });

    it('a model id that is not one, and a judge model with no judge', async () => {
        await usage(['--model', 'not a model'], /"not a model" is not a model id/);
        await usage(['--judge-model', 'claude-opus-5-5'], /--judge-model needs --judge/);
        await usage(['--judge', '--judge-model', 'bad id!'], /is not a model id/, { keys: { anthropic: ANTHROPIC_KEY } });
    });

    it('a dry run needs --out and will not write where the real document goes', async () => {
        await usage(['--stub'], /--stub needs --out <dir>: a dry run never writes to docs\/hackathon/);
        await usage(['--stub', '--out', DEFAULT_OUT], /--stub never writes to \/repo\/docs\/hackathon/);
        await usage(['--stub', '--out', `${DEFAULT_OUT}/`], /--stub never writes to/);
    });

    it('--library belongs to --memory, and --memory needs a library it can read, before anything is asked of a model', async () => {
        await usage(['--library', 'lib.json'], /--library is for --memory/);
        await usage(['--memory'], /--memory needs --library <file>/);
        // A library that cannot be read is the file's fault, not the command's: the message says which file and why, with no usage after it.
        await usage(['--memory', '--library', '/lib.json'], /--library \/lib\.json cannot be used: ENOENT/, {}, false);
        await usage(['--memory', '--library', '/lib.json'], /--library \/lib\.json cannot be used: Unexpected token/, { readText: async () => 'not json' }, false);
        await usage(['--memory', '--library', '/lib.json'], /--library \/lib\.json cannot be used: the library file must be a list of reel_analyses rows/, { readText: async () => '"x"' }, false);
    });

    it('no case matches', async () => {
        const h = harness();
        assert.equal(await runCli(['--cases', 'nothing-like-it'], h.deps), 2);
        assert.match(h.stderr(), /could not start: no case matches "nothing-like-it" \(use --list to see them\)/);
        assert.equal(h.requests.length, 0);
    });

    it('a flag that would point it at a tenant, a conversation or a stored profile is refused, as the DM evaluation refuses it', async () => {
        for (const argv of [['--tenant', 'abc'], ['--tenant-id=1'], ['--creator', 'x'], ['--conversation', 'y'], ['--profile', 'z'], ['--inbox'], ['--db'], ['--send'], ['--token', 't'], ['--live']]) {
            const h = harness();
            assert.equal(await runCli(argv, h.deps), 3, argv.join(' '));
            assert.match(h.stderr(), /^refused: --[\w-]+: this would point the evaluation at /);
            assert.match(h.stderr(), /sends nothing\./);
            assert.deepEqual([h.requests.length, h.reads.length, h.written.size], [0, 0, 0]);
        }
    });

    it('a Contributor-mode model is refused for every case that is a real picture, because Meta may train on what it is sent', async () => {
        const h = harness();
        assert.equal(await runCli(['--model', 'muse-spark-1.3-contributor'], h.deps), 3);
        assert.match(h.stderr(), /--model muse-spark-1\.3-contributor is a Contributor-mode model: Meta may train on what is sent to it, so only the drawn cases may go there \(and \d+ selected cases are not drawn: /);
        assert.equal(h.requests.length, 0);
    });

    it('and it takes one for the drawn cases alone, where nothing real is in what is sent', async () => {
        const h = harness();
        const code = await runCli(['--model', 'muse-spark-1.3-contributor', '--cases', 'image-id-card,story-mention', '--out', OUT], h.deps);
        assert.notEqual(code, 3);
        assert.ok(h.requests.length > 0);
        assert.ok(h.requests.every((r) => r.host === 'api.meta.ai' && r.body?.model === 'muse-spark-1.3-contributor'));
    });
});

// ─── A live run, with the network mocked ──────────────────────────────────────────────────────────────────────────────────

describe('a live run: what it asks, of whom, with what', () => {
    it('talks to Meta and to nobody else, with the key in the header and in no body', async () => {
        const h = harness();
        await runCli(['--cases', 'image-price,image-id-card', '--out', OUT], h.deps);
        assert.ok(h.requests.length >= 3);
        for (const r of h.requests) {
            assert.equal(r.host, 'api.meta.ai');
            assert.equal(r.authorization, `Bearer ${META_KEY}`);
            assert.equal(r.rawBody!.includes(META_KEY), false);
        }
    });

    it('reads each file from the media folder named, once, and the drawn cards from nowhere', async () => {
        const h = harness();
        await runCli(['--cases', 'image-price,image-id-card,reel-other', '--out', OUT], h.deps);
        assert.deepEqual(h.reads, [`${MEDIA}/price-screenshot.png`], 'the drawn card is made, the other creator\'s reel is its caption: only the picture is a file');
        const own = harness();
        await runCli(['--cases', 'image-price', '--media-dir', '/elsewhere', '--out', OUT], own.deps);
        assert.deepEqual(own.reads, ['/elsewhere/price-screenshot.png']);
    });

    it('a run that meets the bar exits 0, and writes the document and the chart, only those, under --out', async () => {
        const h = harness();
        assert.equal(await runCli(['--cases', 'image-price,image-id-card', '--out', OUT], h.deps), 0);
        assert.deepEqual([...h.written.keys()].sort(), [path.join(OUT, MD_FILE), path.join(OUT, SVG_FILE)].sort());
        const { md, svg } = doc(h);
        assert.match(md, /^# Benchmark: what the agent does with what it is sent/);
        assert.match(md, /- \*\*Date:\*\* 2026-11-01 \(UTC\)/);
        assert.match(md, /- \*\*Command:\*\* `npm run eval:muse -- --cases image-price,image-id-card --out \/somewhere\/else`/);
        assert.match(md, /- \*\*Cases:\*\* 2 \(2 media, 0 voice\) from `scripts\/eval-muse\/cases\.json`/);
        assert.match(md, /Every check passed on every case that ran\./);
        assert.deepEqual(xmlProblems(svg), []);
        assert.match(svg, /^<svg /);
        assert.match(h.stdout(), /^arm\s+cases\s+understood\s+action/);
        assert.match(h.stdout(), /meta\s+2\s+100%\s+100%\s+0\/0/);
        assert.match(h.stdout(), /today\s+2\s+0%\s+0%\s+0\/0/);
        assert.match(h.stderr(), /written: \/somewhere\/else\/benchmark\.md and benchmark\.svg/);
    });

    it('goes to docs/hackathon when --out is not given, and writes nothing with --no-write', async () => {
        const h = harness();
        assert.equal(await runCli(['--cases', 'image-price'], h.deps), 0);
        assert.deepEqual([...h.written.keys()].sort(), [path.join(DEFAULT_OUT, MD_FILE), path.join(DEFAULT_OUT, SVG_FILE)].sort());

        const quiet = harness();
        assert.equal(await runCli(['--cases', 'image-price', '--no-write'], quiet.deps), 0);
        assert.equal(quiet.written.size, 0);
        assert.match(quiet.stdout(), /meta\s+1\s+100%/);
    });

    it('a run that misses the bar exits 1, and writes the report all the same, with the failure and its case id in it', async () => {
        // The garbled picture is read as a price by this Meta, which is the wrong thing to do with a picture nobody can read.
        const h = harness();
        assert.equal(await runCli(['--cases', 'image-garbled', '--out', OUT], h.deps), 1);
        const { md } = doc(h);
        assert.match(md, /Not all are met on this run\./);
        assert.match(md, /- `image-garbled` \*\*understood\*\*: /);
        assert.match(md, /- `image-garbled` \*\*action\*\*: /);
        assert.match(h.stdout(), /meta: \d failures?\n\s+image-garbled - /);
    });

    it('keeps the numbers honest when a call fails: the case is a row that says so, the next case still runs, and the run is a miss', async () => {
        const h = harness({ script: (r) => (!hasMedia(r) ? { status: 500, json: { error: { message: 'upstream exploded' } } } : metaScript(r)) });
        assert.equal(await runCli(['--cases', 'image-price,image-id-card', '--out', OUT], h.deps), 1);
        const { md } = doc(h);
        assert.match(md, /- `image-price` \*\*action\*\*: the model did not answer \(server\)/);
        assert.match(md, /\| `image-id-card` \| photo \(drawn by the script\) \| nothing typed \| hand off \| hand off \(as expected\) \|/);
    });

    it('a voice note the transcriber could not decode is a row that says so, and the notes before and after it are kept', async () => {
        const boom: TranscribeVoice = async (input) => {
            if (input.caseId === 'voice-beginner') throw new TypeError('the decoder fell over');
            return stubTranscribe(committed().cases, new FakeClock())(input);
        };
        const h = harness({ loadVoice: async () => ({ present: true, value: boom }) });
        assert.equal(await runCli(['--cases', 'voice-', '--voice', '--out', OUT], h.deps), 1);
        const { md } = doc(h);
        assert.match(md, /- `voice-beginner` \*\*understood\*\*: it ended failed \(the decoder fell over\)/);
        assert.match(md, /\| `voice-price-certificate` \| voice note /, 'the note before it is in the table');
        assert.match(md, /\| `voice-payment` \| voice note /, 'and the note after it');
    });

    it('an error nobody planned for is a row too, with what it said and what the case had cost, and a case that ran is passed through', async () => {
        const ledger = new Ledger();
        const said: string[] = [];
        const c = caseOf('image-price');
        const o = { ledger, say: (t: string) => { said.push(t); }, redact: (t: string) => redactKeys(t, META_KEY), clock: (() => { let now = 1000; return () => (now += 250); })() };

        ledger.current = c.id;
        ledger.add({ role: 'perception', provider: 'meta', model: 'muse-spark-1.3', usd: 0.004, priced: true, tokensIn: 3000, tokensOut: 200, cacheRead: 0, ms: 900, ok: true });
        ledger.current = null;
        const crashed = await guardedCase('meta', c, async () => { throw new TypeError(`cannot read properties of undefined while holding ${META_KEY}`); }, o);
        assert.ok(crashed);
        assert.equal(crashed.status, 'ran');
        assert.equal(crashed.action, 'error');
        assert.equal(crashed.actionOk, false);
        assert.equal(crashed.understood, false);
        assert.deepEqual(crashed.failures.map((f) => [f.caseId, f.arm, f.what]), [['image-price', 'meta', 'crashed']]);
        assert.match(crashed.failures[0]!.reason, /^cannot read properties of undefined while holding /);
        assert.equal(JSON.stringify(crashed).includes(META_KEY), false, 'the key is out of the row');
        assert.equal(said.join('\n').includes(META_KEY), false, 'and out of what is said');
        assert.match(said[0]!, /^image-price \(meta\) stopped on an error: cannot read properties/);
        assert.deepEqual([crashed.usd, crashed.tokensIn, crashed.tokensOut, crashed.calls], [0.004, 3000, 200, 1], 'what the case spent before it stopped is counted');
        assert.equal(crashed.ms, 250);
        assert.equal(crashed.reply, '');

        const fine = { ...crashed, action: 'recommend' as const, actionOk: true, failures: [] };
        assert.equal(await guardedCase('meta', c, async () => fine, o), fine);
        assert.equal(await guardedCase('today', c, async () => null, o), null, 'an arm with nothing to say for a case says nothing');
        assert.equal(said.length, 1);
    });

    it('never prints or writes a key, even when Meta\'s own error repeats it', async () => {
        const h = harness({ script: () => ({ status: 401, text: JSON.stringify({ error: { message: `Invalid API key ${META_KEY}` } }) }) });
        const code = await runCli(['--cases', 'image-price', '--out', OUT], h.deps);
        assert.notEqual(code, 3);
        assert.equal(h.everything().includes(META_KEY), false);
        assert.equal(h.everything().includes(META_KEY.slice(0, 24)), false);
        assert.ok(h.requests.length >= 1);
    });

    it('takes a key out of the document and the chart too, even if what Muse read off a picture held one (nothing the benchmark sends does)', async () => {
        const leaky = (r: Recorded): Scripted => (hasMedia(r)
            ? chatAnswer(SEEN({ seen: `A screenshot of a price: 299 Egyptian pounds, with a terminal open that says ${META_KEY} and ${ANTHROPIC_KEY}` }))
            : chatAnswer(SALES()));
        const h = harness({ keys: { anthropic: ANTHROPIC_KEY }, script: leaky });
        const code = await runCli(['--cases', 'image-price', '--out', OUT], h.deps);
        assert.ok(code === 0 || code === 1);
        const { md } = doc(h);
        assert.match(md, /What it saw:\*\* A screenshot of a price: 299 Egyptian pounds, with a terminal open that says \[key\] and \[key\]/, 'what it read is shown, with the keys taken out');
        assert.equal(h.everything().includes(META_KEY), false);
        assert.equal(h.everything().includes(ANTHROPIC_KEY), false);
        assert.equal(h.everything().includes(META_KEY.slice(0, 20)), false);
    });

    it('takes a key out of the note about an arm that did not run, in the document and in the chart that shows it', async () => {
        const h = harness({ loadVoice: async () => ({ present: false, why: `the transcriber would not start with ${META_KEY}` }) });
        assert.equal(await runCli(['--cases', 'image-price,voice-payment', '--voice', '--out', OUT], h.deps), 0);
        const { md, svg } = doc(h);
        assert.match(md, /the transcriber would not start with \[key\]/);
        assert.match(svg, /Meta voice \(transcribe, then answer\): not run\. The transcriber would not start with \[key\]/);
        assert.equal(svg.includes(META_KEY.slice(0, 20)), false);
        assert.equal(h.everything().includes(META_KEY), false);
    });

    it('takes a key out of what it says even when the error that carries it came from outside the cases (a module that failed to load)', async () => {
        const h = harness({ loadVoice: async () => { throw new Error(`could not start the transcriber with ${META_KEY}`); } });
        assert.equal(await runCli(['--cases', 'voice-payment', '--voice', '--out', OUT], h.deps), 2);
        assert.match(h.stderr(), /^the run failed: could not start the transcriber with /m);
        assert.equal(h.everything().includes(META_KEY), false);
        assert.equal(h.written.size, 0, 'a run that failed before it measured anything writes nothing');
    });

    it('skips a case whose file is not in the media folder, by name, and runs the rest', async () => {
        const { [`${MEDIA}/price-screenshot.png`]: _gone, ...rest } = FILES;
        const h = harness({ files: { ...rest, [`${MEDIA}/garbled-screenshot.png`]: PNG } });
        const code = await runCli(['--cases', 'image-price,image-id-card', '--out', OUT], h.deps);
        assert.equal(code, 0);
        assert.match(h.stderr(), /skipped image-price: price-screenshot\.png is not in the media folder \(\/media\)/);
        const { md } = doc(h);
        assert.match(md, /## Not run\n\n- `image-price`: price-screenshot\.png is not in the media folder \(\/media\)/);
        assert.match(md, /- \*\*Cases:\*\* 1 \(1 media, 0 voice\)/);
        assert.doesNotMatch(md, /\| `image-price` \| photo/, 'a case that did not run is not in the table of what ran');
    });

    it('exits 2 and writes nothing when no case could run at all', async () => {
        const h = harness({ files: {} });
        assert.equal(await runCli(['--cases', 'image-price', '--out', OUT], h.deps), 2);
        assert.match(h.stderr(), /nothing ran: 1 case had no file in \/media \(pass --media-dir\)\./);
        assert.deepEqual([h.written.size, h.requests.length], [0, 0]);
    });

    it('a media file the product would refuse is not benchmarked as though it were read', async () => {
        const h = harness({ files: { ...FILES, [`${MEDIA}/price-screenshot.png`]: Buffer.alloc(0) } });
        assert.equal(await runCli(['--cases', 'image-price', '--out', OUT], h.deps), 2);
        assert.match(h.stderr(), /skipped image-price: price-screenshot\.png is empty/);
    });

    it('puts the judge on the Anthropic host with the Anthropic key and the replies on Meta with Meta\'s, and prices the judge apart', async () => {
        const h = harness({ keys: { anthropic: ANTHROPIC_KEY }, script: (r) => (r.host === 'api.anthropic.com' ? anthropicAnswer(JUDGED) : metaScript(r)) });
        assert.equal(await runCli(['--cases', 'image-price', '--judge', '--out', OUT], h.deps), 0);
        const hosts = new Set(h.requests.map((r) => r.host));
        assert.deepEqual([...hosts].sort(), ['api.anthropic.com', 'api.meta.ai']);
        for (const r of h.requests) {
            if (r.host === 'api.anthropic.com') assert.deepEqual([r.apiKeyHeader, r.authorization], [ANTHROPIC_KEY, null]);
            else assert.deepEqual([r.authorization, r.apiKeyHeader], [`Bearer ${META_KEY}`, null]);
            assert.equal(r.rawBody!.includes(ANTHROPIC_KEY) || r.rawBody!.includes(META_KEY), false);
        }
        const { md } = doc(h);
        assert.match(md, /judge `claude-opus-5-5`/);
        assert.match(md, /The judge cost \$/);
        assert.equal(h.everything().includes(ANTHROPIC_KEY), false);
    });

    it('runs every committed case through the arms without a crash or a skip: the cases file and the arms agree', async () => {
        const h = harness({ loadVoice: async () => ({ present: true, value: stubTranscribe(committed().cases, new FakeClock()) }) });
        const code = await runCli(['--voice', '--out', OUT], h.deps);
        assert.ok(code === 0 || code === 1, `exit ${code}: ${h.stderr().slice(-400)}`);
        const { md, svg } = doc(h);
        assert.doesNotMatch(md, /\*\*crashed\*\*/);
        assert.doesNotMatch(md, /## Not run/);
        assert.doesNotMatch(h.stderr(), /stopped on an error|skipped /);
        assert.deepEqual(xmlProblems(svg), []);
        for (const c of committed().cases) assert.match(md, new RegExp(`\\| \`${c.id}\` \\|`), c.id);
        assert.ok(h.requests.every((r) => r.host === 'api.meta.ai'));
    });
});

// ─── The open weights ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the open-weights arm', () => {
    // The reel indexer's own request (its system text) gets the analysis, at either host; a case gets what a case gets.
    const analysis = (r: Recorded): boolean => r.host === 'inference.baseten.co' || systemText(r) === REEL_INDEX_SYSTEM;
    const script = (r: Recorded): Scripted => (analysis(r) ? chatAnswer(REEL_ANALYSIS, { prompt: 5863, completion: 3371 }) : metaScript(r));

    it('asks hosted Muse Spark at Meta with Meta\'s key and Muse Spark Open at Baseten with Baseten\'s, each key only at its own host, and shows both', async () => {
        const h = harness({ keys: { baseten: BASETEN_KEY }, script });
        const code = await runCli(['--cases', 'reel-own-riyal', '--open-weights', '--no-write'], { ...h.deps });
        assert.ok(code === 0 || code === 1);
        const baseten = h.requests.filter((r) => r.host === 'inference.baseten.co');
        const meta = h.requests.filter((r) => r.host === 'api.meta.ai');
        assert.equal(baseten.length, 1, 'one analysis, of the account\'s own reel and nothing else');
        assert.ok(meta.length >= 2, 'the reel case itself, and the hosted analysis of the same reel');
        assert.equal(h.requests.filter(analysis).length, 2, 'the same request goes to both models');
        assert.equal(baseten[0]!.authorization, `Bearer ${BASETEN_KEY}`);
        assert.equal(baseten[0]!.body.model, 'meta-models/muse-spark-open-1026');
        assert.ok(meta.every((r) => r.authorization === `Bearer ${META_KEY}`));
        assert.equal(baseten.some((r) => r.rawBody!.includes(META_KEY)), false);
        assert.equal(meta.some((r) => r.rawBody!.includes(BASETEN_KEY)), false);
        assert.equal(new Set(h.requests.map((r) => r.host)).size, 2);
    });

    it('puts the comparison in the document, and the open model\'s model id in the models line', async () => {
        const h = harness({ keys: { baseten: BASETEN_KEY }, script });
        await runCli(['--cases', 'image-price', '--open-weights', '--out', OUT], h.deps);
        const { md } = doc(h);
        assert.match(md, /### Open weights against hosted, on one reel/);
        assert.match(md, /Muse Spark Open, served by Baseten/);
        assert.match(md, /open weights `meta-models\/muse-spark-open-1026`/);
        assert.equal(h.everything().includes(BASETEN_KEY), false);
    });

    it('a failed call is a row that says so, and the other model\'s answer is still shown', async () => {
        const h = harness({ keys: { baseten: BASETEN_KEY }, script: (r) => (r.host === 'inference.baseten.co' ? { status: 503, json: { error: { message: 'cold' } } } : script(r)) });
        await runCli(['--cases', 'image-price', '--open-weights', '--out', OUT], h.deps);
        assert.match(doc(h).md, /\| Answered \| yes \| no: /);
    });

    it('says the reel is missing when its file is not in the media folder, and still runs the cases', async () => {
        const { [`${MEDIA}/real-reel-riyal.mp4`]: _gone, ...rest } = FILES;
        const h = harness({ keys: { baseten: BASETEN_KEY }, files: rest, script });
        assert.equal(await runCli(['--cases', 'image-price', '--open-weights', '--out', OUT], h.deps), 0);
        assert.match(doc(h).md, /- \*\*Open weights:\*\* real-reel-riyal\.mp4 is not in the media folder/);
        assert.equal(h.requests.some((r) => r.host === 'inference.baseten.co'), false);
    });
});

// ─── A dry run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a dry run', () => {
    it('answers from canned text, reads no file and sends nothing, writes the two files under --out, and says in both that it is not a measurement', async () => {
        const h = harness({ keys: { meta: null }, files: {}, script: () => { throw new Error('a dry run must not send a request'); } });
        assert.equal(await runCli(['--stub', '--out', OUT], h.deps), 0);
        assert.deepEqual([h.requests.length, h.reads.length], [0, 0]);
        assert.deepEqual([...h.written.keys()].sort(), [path.join(OUT, MD_FILE), path.join(OUT, SVG_FILE)].sort());
        const { md, svg } = doc(h);
        assert.match(md, /> \*\*Dry run\.\*\* The answers are canned, nothing was sent to Meta and nothing was billed\. These numbers are not a measurement of anything\./);
        assert.match(svg, /dry run/i);
        assert.deepEqual(xmlProblems(svg), []);
        assert.match(h.stdout(), /^DRY RUN: canned answers/);
        assert.equal([...h.written.keys()].some((f) => f.startsWith(DEFAULT_OUT)), false, 'never the folder the real document lives in');
    });

    it('runs the voice notes through a canned transcript with --voice, and says there is no library, and no model, for the others', async () => {
        const h = harness({ keys: { meta: null }, files: {} });
        assert.equal(await runCli(['--stub', '--voice', '--memory', '--open-weights', '--out', OUT], h.deps), 0);
        const { md } = doc(h);
        assert.match(md, /\| Meta voice \(transcribe, then answer\) \|/);
        assert.match(md, /- \*\*Memory:\*\* a dry run has no library to ask/);
        assert.match(md, /- \*\*Open weights:\*\* a dry run does not call either model/);
    });
});

// ─── The arms that wait for another PR ────────────────────────────────────────────────────────────────────────────────────

describe('the voice arm', () => {
    it('is left out with the module\'s own note while the module has not landed, and the other cases run', async () => {
        const h = harness({ loadVoice: async () => ({ present: false, why: 'src/services/perception/voice.ts is not in this checkout yet (P3, the voice notes)' }) });
        assert.equal(await runCli(['--cases', 'image-price,voice-payment', '--voice', '--out', OUT], h.deps), 0);
        const { md } = doc(h);
        assert.match(md, /- \*\*Meta voice \(transcribe, then answer\):\*\* voice\.ts is not in this checkout yet\. The voice notes are left out of every arm\./);
        assert.doesNotMatch(md, /\| `voice-payment` \|/);
        assert.match(h.stdout(), /not run: Meta voice \(transcribe, then answer\): src\/services\/perception\/voice\.ts is not in this checkout yet \(P3, the voice notes\)/);
        assert.equal(h.reads.includes(`${MEDIA}/voice-3.m4a`), false, 'a voice file is not read for an arm that cannot run');
    });

    it('is not run, and says so, unless --voice asks for it', async () => {
        const h = harness();
        assert.equal(await runCli(['--cases', 'image-price,voice-payment', '--out', OUT], h.deps), 0);
        assert.match(doc(h).md, /- \*\*Meta voice \(transcribe, then answer\):\*\* not asked for: add --voice to run the voice notes through the product's own transcription/);
    });

    it('runs the product\'s module when it is there, against the three voice notes, with the voice arm and its today arm in the document', async () => {
        const heard: string[] = [];
        const inner = stubTranscribe(committed().cases, new FakeClock());
        const transcribe: TranscribeVoice = async (input) => { heard.push(input.caseId); return inner(input); };
        const h = harness({ loadVoice: async (keys) => { assert.equal(keys.meta, META_KEY); return { present: true, value: transcribe }; } });
        const code = await runCli(['--cases', 'voice-', '--voice', '--out', OUT], h.deps);
        assert.ok(code === 0 || code === 1);
        assert.equal(heard.length, 3);
        const { md } = doc(h);
        assert.match(md, /\| Meta voice \(transcribe, then answer\) \| 3 \|/);
        assert.match(md, /\| Today, voice notes \| 3 \|/);
        assert.match(md, /- \*\*Models:\*\* perception and replies `muse-spark-1\.3` at low effort; speech `muse-voice-transcribe-1\.0`/);
    });
});

describe('the memory arm', () => {
    const LIBRARY_ROWS = [{
        id: 'r1', ig_media_id: 'ig-r1', permalink: 'https://www.instagram.com/reel/r1/', result: { summary: 'A meal priced at 45 riyals paid with 1 riyal.', topics: ['backend'], seen_on_screen: ['a man in a green sweater'], narration: 'the server never sees your page', key_moments: [{ second: 12, what: 'the exploit' }] },
    }];

    it('is left out with the module\'s own note while recall has not landed, after the library file was read', async () => {
        const h = harness({ loadRecall: async () => ({ present: false, why: 'src/services/perception/recall.ts is not in this checkout yet (P4b, video memory)' }), readText: async () => JSON.stringify(LIBRARY_ROWS) });
        assert.equal(await runCli(['--cases', 'image-price', '--memory', '--library', '/lib.json', '--out', OUT], h.deps), 0);
        assert.match(doc(h).md, /- \*\*Memory:\*\* recall\.ts is not in this checkout yet\n/);
    });

    it('asks the product\'s recall each question of the library with what was seen, and of the one with only what is said, and shows both', async () => {
        const asked: { question: string; reels: number; visible: boolean }[] = [];
        const recall: Recall = async (question, library: readonly LibraryRow[]) => {
            asked.push({ question, reels: library.length, visible: JSON.stringify(library[0]!.result).includes('green sweater') });
            return { kind: 'match', id: library[0]!.id, second: 12, link: library[0]!.permalink, ms: 30, usd: 0.001 };
        };
        const h = harness({ loadRecall: async () => ({ present: true, value: recall }), readText: async () => JSON.stringify(LIBRARY_ROWS) });
        const code = await runCli(['--cases', 'image-price', '--memory', '--library', '/lib.json', '--out', OUT], h.deps);
        assert.ok(code === 0 || code === 1);
        assert.ok(asked.length >= 2);
        assert.ok(asked.some((a) => a.visible) && asked.some((a) => !a.visible), 'both libraries are asked: one that holds what was seen, one that holds only what is said');
        assert.ok(asked.every((a) => a.reels === 1));
        const { md } = doc(h);
        assert.match(md, /### Memory: does the right reel come back\?/);
        assert.match(md, /\| Memory: visual library \|/);
        assert.match(md, /\| Memory: transcript-only library \|/);
    });
});

// ─── Nothing else is touched ──────────────────────────────────────────────────────────────────────────────────────────────

describe('what it leaves alone', () => {
    it('never reaches a database, in a run that uses every arm', async () => {
        const reached: string[] = [];
        const q = mock.method(pool, 'query', (async () => { reached.push('query'); throw new Error('the benchmark reached the database'); }) as never);
        const c = mock.method(pool, 'connect', (async () => { reached.push('connect'); throw new Error('the benchmark reached the database'); }) as never);
        restore = () => { q.mock.restore(); c.mock.restore(); };
        const h = harness({
            keys: { baseten: BASETEN_KEY, anthropic: ANTHROPIC_KEY },
            files: FILES,
            script: (r) => (r.host === 'api.anthropic.com' ? anthropicAnswer(JUDGED) : r.host === 'inference.baseten.co' ? chatAnswer(REEL_ANALYSIS) : metaScript(r)),
            loadVoice: async () => ({ present: true, value: stubTranscribe(committed().cases, new FakeClock()) }),
            loadRecall: async () => ({ present: true, value: async () => ({ kind: 'none', ms: 1, usd: 0 }) }),
            readText: async () => JSON.stringify(LIBRARY_ROWS_FOR_DB_TEST),
        });
        const code = await runCli(['--voice', '--memory', '--library', '/lib.json', '--open-weights', '--judge', '--out', OUT], h.deps);
        assert.ok(code === 0 || code === 1, h.stderr().slice(-300));
        assert.deepEqual(reached, []);
    });

    it('puts back the model caller and the log sink it replaced, whether the run was finished or refused', async () => {
        const marker: AiCaller = (async () => { throw new Error('not for this test'); }) as never;
        const before = setAiCaller(marker);
        try {
            const h = harness();
            await runCli(['--cases', 'image-price', '--no-write'], h.deps);
            assert.equal(setAiCaller(marker), marker, 'the caller that was there is the one that is back');

            const refused = harness({ keys: { meta: null } });
            await runCli(['--cases', 'image-price'], refused.deps);
            assert.equal(setAiCaller(marker), marker);
        } finally {
            setAiCaller(before);
        }
    });

    it('prints a warning from the product\'s own code, and nothing of its routine log, so the report is not buried', async () => {
        const lines: string[] = [];
        const h = harness();
        const keep = setLogSink((level, line) => { lines.push(`${level}:${line}`); });
        try {
            await runCli(['--cases', 'image-price', '--no-write'], h.deps);
        } finally {
            setLogSink(keep);
        }
        assert.deepEqual(lines, [], 'while it runs, the product\'s log goes to the benchmark\'s own sink, and the sink it found is put back');
        assert.doesNotMatch(h.stdout(), /^\{"level"/m);
    });
});

const LIBRARY_ROWS_FOR_DB_TEST = [{
    id: 'r1', ig_media_id: 'ig-r1', permalink: 'https://www.instagram.com/reel/r1/', result: { summary: 'A meal priced at 45 riyals paid with 1 riyal.', topics: ['backend'], seen_on_screen: ['a man in a green sweater'], narration: 'the server never sees your page', key_moments: [] },
}];

// A `Loaded` is what the script gives the command for a module another PR adds; the type is part of what this file holds the command to.
const _typeCheck: Loaded<number> = { present: true, value: 1 };
void _typeCheck;
