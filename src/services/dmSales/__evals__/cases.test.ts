/**
 * The golden conversations as data (`conversations/*.json`, `cases.ts`): fifteen of them, covering what the plan lists, in the four
 * varieties, each on a fixture that exists, naming only offers that fixture has, with patterns that compile. And the loader's strictness:
 * a typo in a case is an error that names the file, never a case that quietly checks nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CONVERSATIONS_DIR, loadCases, parseCase, selectCases } from './cases.js';
import { FIXTURE_NAMES, VARIETIES } from './types.js';
import { allCases, caseById } from './testHelpers.js';
import { prefilter } from '../prefilter.js';

describe('the fifteen golden conversations', () => {
    it('are fifteen, with ids that are their file names and numbered 01 to 15', () => {
        const cases = allCases();
        assert.equal(cases.length, 15);
        assert.deepEqual(cases.map((c) => c.id.slice(0, 2)), Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0')));
        assert.equal(new Set(cases.map((c) => c.id)).size, 15);
    });

    it('cover every situation the plan names', () => {
        const wanted: Record<string, string> = {
            'price question': '01-price-gulf', 'is it for beginners': '02-beginner-egyptian', 'too expensive': '03-too-expensive-gulf',
            'free on YouTube': '04-free-youtube-msa', 'link straight away': '05-link-now-gulf', 'off-topic': '06-off-topic-gulf', abuse: '07-abuse-egyptian',
            stop: '08-stop-gulf', refund: '09-refund-egyptian', 'payment problem': '10-payment-problem-msa', 'prompt injection': '11-injection-english',
            'not covered': '12-not-covered-egyptian', collaboration: '13-collaboration-msa', 'English speaker': '14-english-speaker', 'multi-turn': '15-multi-turn-gulf',
        };
        for (const [what, id] of Object.entries(wanted)) assert.ok(allCases().some((c) => c.id === id), what);
    });

    it('are written in Gulf, Egyptian, MSA and English, each at least twice', () => {
        const count = (v: string) => allCases().filter((c) => c.writes === v).length;
        for (const v of VARIETIES) assert.ok(count(v) >= 2, `${v}: ${count(v)}`);
        assert.deepEqual(VARIETIES.map(count), [6, 4, 3, 2]);
    });

    it('each use a fixture that exists, and the owner\'s three fixtures and the English one are all used', () => {
        assert.deepEqual([...new Set(allCases().map((c) => c.fixture))].sort(), [...FIXTURE_NAMES].sort());
    });

    it('have a multi-turn case with three turns, and the two-turn ones are the opt-out and pause cases', () => {
        assert.equal(caseById('15-multi-turn-gulf').turns.length, 3);
        assert.deepEqual(allCases().filter((c) => c.turns.length === 2).map((c) => c.id), ['07-abuse-egyptian', '08-stop-gulf', '09-refund-egyptian']);
    });

    it('say, for every model-decided turn, what the reply must be: an action, and at least one soft criterion unless it is a handoff', () => {
        for (const c of allCases()) {
            for (const [i, t] of c.turns.entries()) {
                const route = t.expect.route ?? 'model';
                if (route !== 'model') continue;
                const where = `${c.id} turn ${i + 1}`;
                assert.ok(t.expect.next_action, `${where}: no next_action`);
                if (!t.expect.next_action!.includes('handoff')) assert.ok((t.expect.soft?.length ?? 0) > 0, `${where}: a reply nobody scores`);
                if (t.expect.next_action!.includes('handoff')) assert.equal(t.expect.next_action!.length, 1, `${where}: a handoff case expects only a handoff`);
            }
        }
    });

    it('send the words every model-decided case expects in the person\'s own language and variety', () => {
        for (const c of allCases()) {
            for (const [i, t] of c.turns.entries()) {
                const model = (t.expect.route ?? 'model') === 'model' && !t.expect.next_action!.includes('handoff');
                if (!model) continue;
                assert.equal(t.expect.reply_language?.variety, c.writes, `${c.id} turn ${i + 1}`);
            }
        }
    });

    it('send the cases the keyword pre-filter decides to it, and the others to the model: every turn\'s expected route is what prefilter() says', () => {
        for (const c of allCases()) {
            let paused: boolean = false;
            for (const [i, t] of c.turns.entries()) {
                const want = t.expect.route ?? 'model';
                const said = prefilter(t.user);
                const actual: string = paused ? 'silent' : said.action === 'pass' ? 'model' : 'prefilter';
                assert.equal(want, actual, `${c.id} turn ${i + 1}: ${t.user}`);
                if (!paused && said.action !== 'pass') {
                    const signal = said.action === 'opt_out' ? 'opt_out' : said.reason;
                    assert.equal(t.expect.prefilter, signal, `${c.id} turn ${i + 1}`);
                    // A pause: an opt-out, a refund, a complaint; an insult only the second time.
                    paused = signal !== 'abuse' || i > 0;
                }
            }
        }
    });

    it('run the price question on the fixture with no live price, and keep "free" out with a pattern, which the guard cannot', () => {
        const price = caseById('01-price-gulf');
        assert.equal(price.fixture, 'owner-ar');
        assert.ok(price.turns[0]!.expect.must_not!.some((p) => /مجان/.test(p)));
        assert.equal(caseById('03-too-expensive-gulf').fixture, 'owner-ar-priced');
    });
});

describe('loadCases refuses a case that would check nothing', () => {
    const good = (over: Record<string, unknown> = {}) => ({ id: '01-good', title: 'good', fixture: 'owner-ar', writes: 'gulf', turns: [{ user: 'hi', expect: { next_action: ['reply'] } }], ...over });
    const problems = (body: unknown, file = '01-good.json'): string => {
        const parsed = parseCase(body, file, (f) => (f === 'owner-ar' ? new Set(['main', 'course-java']) : null));
        return 'problems' in parsed ? parsed.problems.join('\n') : '';
    };

    it('accepts a well-formed case', () => {
        const parsed = parseCase(good(), '01-good.json');
        assert.ok('case' in parsed);
    });

    it('rejects an action, an intent, a stage, a reason or a variety that is not one', () => {
        assert.match(problems(good({ turns: [{ user: 'x', expect: { next_action: ['reply', 'sell'] } }] })), /next_action: "sell" not allowed/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { intent: ['angry'] } }] })), /intent: "angry" not allowed/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { stage: ['won'] } }] })), /stage: "won" not allowed/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { handoff_reason: ['bored'] } }] })), /handoff_reason: "bored" not allowed/);
        assert.match(problems(good({ writes: 'klingon' })), /writes: must be one of/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { reply_language: { variety: 'klingon' } } }] })), /reply_language: needs/);
    });

    it('rejects a misspelt expectation, which would silently check nothing', () => {
        assert.match(problems(good({ turns: [{ user: 'x', expect: { next_actions: ['reply'] } }] })), /next_actions: is not an expectation/);
        assert.match(problems(good({ colour: 'red' })), /colour: is not a field of a case/);
    });

    it('rejects a pattern that does not compile, an empty list and an empty message', () => {
        assert.match(problems(good({ turns: [{ user: 'x', expect: { must: ['('] } }] })), /must: \/\(\/ does not compile/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { must_not: [] } }] })), /must_not: must be a non-empty list/);
        assert.match(problems(good({ turns: [{ user: '  ', expect: {} }] })), /user: must be text/);
        assert.match(problems(good({ turns: [] })), /turns: must be a non-empty list/);
    });

    it('rejects a fixture that is a tenant id or is not one, by naming it and refusing', () => {
        assert.match(problems(good({ fixture: '11111111-1111-4111-8111-111111111111' })), /is a tenant id/);
        assert.match(problems(good({ fixture: 'production' })), /is not a fixture/);
    });

    it('rejects an offer id the fixture does not have, and a pre-filter signal on a turn the model decides', () => {
        assert.match(problems(good({ turns: [{ user: 'x', expect: { offer_id: ['main', 'none', 'ghost'] } }] })), /ghost is not an offer of the fixture/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { prefilter: 'refund' } }] })), /only a turn with route "prefilter"/);
        assert.match(problems(good({ turns: [{ user: 'x', expect: { allow_claim_words: ['number'] } }] })), /allow_claim_words: "number" not allowed/);
    });

    it('rejects lean on a variety that has no dialect to lean on', () => {
        assert.match(problems(good({ turns: [{ user: 'x', expect: { reply_language: { variety: 'msa', lean: true } } }] })), /lean applies to gulf and egyptian only/);
    });

    it('rejects an id that does not match its file, and a history that Anthropic would refuse', () => {
        assert.match(problems(good(), '02-other.json'), /id: must match the file name/);
        assert.match(problems(good({ id: 'Bad Id' })), /id: must look like/);
        assert.match(problems(good({ history: [{ role: 'model', text: 'hi' }] })), /must start with a user turn/);
        assert.match(problems(good({ history: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }] })), /must alternate/);
        assert.match(problems(good({ history: [{ role: 'user', text: 'a' }] })), /must end with a model turn/);
        assert.ok(!problems(good({ history: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }] })));
    });

    it('reports every problem of a file at once, and every bad file in a folder', () => {
        const bad = mkdtempSync(path.join(tmpdir(), 'dm-eval-bad-'));
        try {
            writeFileSync(path.join(bad, '01-a.json'), JSON.stringify(good({ id: '01-a', writes: 'x', fixture: 'nope' })));
            writeFileSync(path.join(bad, '02-b.json'), '{ not json');
            assert.throws(() => loadCases(bad), (err: Error) => /01-a\.json/.test(err.message) && /02-b\.json: not valid JSON/.test(err.message) && /writes/.test(err.message) && /not a fixture/.test(err.message));
        } finally {
            rmSync(bad, { recursive: true, force: true });
        }
    });

    it('loads the real folder without a problem', () => {
        assert.equal(loadCases(CONVERSATIONS_DIR).length, 15);
    });
});

describe('selectCases', () => {
    const all = allCases();
    const ids = (spec: string | undefined) => selectCases(all, spec).map((c) => c.id);

    it('is everything for nothing, "all" or an empty list', () => {
        for (const spec of [undefined, '', '  ', 'all', 'ALL']) assert.equal(ids(spec).length, 15, String(spec));
    });

    it('takes an id, a number, or the start of an id, comma-separated, in the order of the cases', () => {
        assert.deepEqual(ids('05-link-now-gulf'), ['05-link-now-gulf']);
        assert.deepEqual(ids('5'), ['05-link-now-gulf']);
        assert.deepEqual(ids('05'), ['05-link-now-gulf']);
        assert.deepEqual(ids('15, 1'), ['01-price-gulf', '15-multi-turn-gulf']);
        assert.deepEqual(ids('link'), ['05-link-now-gulf']);
        assert.deepEqual(ids('01-price'), ['01-price-gulf']);
        assert.deepEqual(ids('1,01,price'), ['01-price-gulf']);
    });

    it('refuses a name that matches nothing, since an empty run would pass', () => {
        assert.throws(() => ids('99'), /no case matches "99"/);
        assert.throws(() => ids('1,nonsense'), /no case matches "nonsense"/);
    });
});
