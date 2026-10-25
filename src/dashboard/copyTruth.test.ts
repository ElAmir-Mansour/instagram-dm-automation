/**
 * Interface copy pinned to what the code does (2026-10-26): four sentences in the dictionaries said something the code does not do.
 *
 * `helpTruth.test.ts` ties the Help Center's sentences to the code, and `help-labels.test.ts` ties its NAMES to the interface. The interface's
 * own strings (`dashboard/js/i18n.*.js`) carry the same risk and had no such test: each of these was true once, or true of one kind of
 * workspace, and nothing tied it to the code afterwards.
 *
 *   1. The Monteur's reel length hint said the longest reel is 15–90 seconds. The server and the page take 15–180 (reels up to three minutes
 *      arrived in 9c86267, and the hint was not touched).
 *   2. The Gemini fallback's two sentences said that with it off "nothing is sent". The customer is sent one line saying a person has the
 *      message, the conversation is stamped (the Inbox's Needs you), and the assistant stays on.
 *   3. The infographic form's hint said Claude writes the page. Claude on the Mac writes it for the owner and the workspaces on
 *      `studio.mac_brain_tenants`; every other workspace's is written through the AI providers layer, by whichever provider the operator routed.
 *   4. `ai.sandboxAgentOff` ("the agent is switched off, so the test did not run") could never be shown: the test box answers while the
 *      assistant is off.
 *
 * The number, the rule or the label is read from the code (or from the dictionary entry the sentence names), never retyped. When a test
 * here fails, the code changed under a sentence: read the sentence again before changing the test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { decideAgent } from '../services/ai.js';
import { defaultStudioSettings, settingsProblems } from '../services/studio/settings.js';

type Json = Record<string, any>;
type Lang = 'ar' | 'en';

const ctx: Json = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const file of ['dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js']) {
    vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
}
const STRINGS = vm.runInContext('I18N.strings', ctx) as Record<Lang, Record<string, string>>;
const LANGS = ['ar', 'en'] as const;

const label = (lang: Lang, key: string): string => {
    const value = STRINGS[lang][key];
    assert.ok(typeof value === 'string', `${lang} has ${key}`);
    return value!;
};

// ─── 1. The Monteur's reel length ────────────────────────────────────────────────────────────────────────────────────

/**
 * The range the server holds `monteur.<key>` to: read from its own refusal, then checked at both edges, so the sentence it speaks and the
 * numbers it enforces cannot differ unseen. The other bound is set out of the way (a longest reel must be more than the shortest).
 */
function monteurRange(key: 'min_seconds' | 'max_seconds'): [number, number] {
    const base = defaultStudioSettings();
    const problemsAt = (value: number): string[] => settingsProblems({
        ...base, monteur: { ...base.monteur, min_seconds: 10, max_seconds: 180, [key]: value },
    }).filter((p) => p.startsWith(`monteur.${key} `));
    const refusal = problemsAt(-1)[0];
    const m = refusal?.match(/from (\d+) to (\d+)$/);
    assert.ok(m, `the validator says what it takes: ${refusal}`);
    const [lo, hi] = [Number(m![1]), Number(m![2])];
    assert.deepEqual(problemsAt(lo), [], `${key}: ${lo} is taken`);
    assert.deepEqual(problemsAt(hi), [], `${key}: ${hi} is taken`);
    assert.equal(problemsAt(lo - 1).length, 1, `${key}: ${lo - 1} is refused`);
    assert.equal(problemsAt(hi + 1).length, 1, `${key}: ${hi + 1} is refused`);
    return [lo, hi];
}

describe('Interface copy — the Monteur reel length hint', () => {
    it('is the range the server enforces, and the page offers the same one', () => {
        const shortest = monteurRange('min_seconds');
        const longest = monteurRange('max_seconds');
        // A scan that read nothing would pass: the longest reel really is up to three minutes.
        assert.deepEqual([...shortest, ...longest], [10, 60, 15, 180]);

        // The page's own bounds (the number inputs' min and max) are copies of the server's, kept in monteur.js.
        const page = readFileSync('dashboard/js/pages/monteur.js', 'utf8');
        const bounds = (key: string): number[] => {
            const m = page.match(new RegExp(`${key}: Object\\.freeze\\(\\[(\\d+), (\\d+)\\]\\)`));
            assert.ok(m, `${key} is in monteur.js LIMITS`);
            return [Number(m![1]), Number(m![2])];
        };
        assert.deepEqual(bounds('min_seconds'), shortest, 'the Shortest field takes what the server takes');
        assert.deepEqual(bounds('max_seconds'), longest, 'and so does the Longest field');

        for (const lang of LANGS) {
            const hint = label(lang, 'monteur.settings.lengthHint');
            const range = ([lo, hi]: number[]): string => (lang === 'en' ? `${lo}–${hi}` : `من ${lo} إلى ${hi}`);
            assert.ok(hint.includes(range(shortest)), `${lang}: the shortest, ${range(shortest)}: ${hint}`);
            assert.ok(hint.includes(range(longest)), `${lang}: the longest, ${range(longest)}: ${hint}`);
        }
    });
});

// ─── 2. The Gemini fallback being off ────────────────────────────────────────────────────────────────────────────────

describe('Interface copy — what happens when the fallback to Gemini is off', () => {
    it('is what the code does: the engine hands over, the customer is sent one line, the thread is stamped, and the assistant stays on', () => {
        // Behaviour is proved against the stubbed pool in dmEngine.test.ts and failureHandoff.test.ts; this pins the facts the two sentences stand on.
        const engine = readFileSync('src/services/dmEngine.ts', 'utf8');
        assert.match(engine, /if \(!geminiFallback\) \{\s*log\('error', 'dm\.engine_failed',[^;]*fallback: 'off' \}\);\s*return \{ kind: 'handoff', engine, failure \};/, 'a failed providers engine with the fallback off is a handoff, not silence');
        assert.match(engine, /return \{ kind: 'handoff', engine, failure, fallbackFailure \};/, 'and so is Gemini failing as well');
        assert.match(readFileSync('src/webhook/messaging.ts', 'utf8'), /if \(dmReply\.kind === 'handoff'\) \{\s*await handOver\(\);\s*await markHandled\(claim\.id\);/, 'the pipeline hands over');

        const failure = readFileSync('src/services/dmSales/failureHandoff.ts', 'utf8');
        assert.match(failure, /lineSent = await sendLine\(input, ctx, logBase\);/, 'the customer is sent the line');
        const stamp = failure.slice(failure.indexOf('async function stamp'), failure.indexOf('async function recordLine'));
        assert.match(stamp, /SET stage = 'handoff', handoff_at = NOW\(\), handoff_reason = \$3/, 'the thread is stamped');
        assert.doesNotMatch(stamp, /is_bot_active/, 'and the assistant is left on');
        // The stamp is what the Inbox calls Needs you.
        assert.match(readFileSync('dashboard/js/attention.js', 'utf8'), /if \(!thread \|\| thread\.stage !== 'handoff'\) return false;/, 'the Inbox reads stage = handoff');
        assert.match(readFileSync('dashboard/js/pages/inbox.js', 'utf8'), /needsYou\(thread\) \{\s*return Attention\.isHandoff\(thread\) && !Attention\.isHandled\(thread\);/, 'as Needs you');
    });

    for (const lang of LANGS) {
        it(`says so in both sentences, in the screen's own words, and no longer says nothing is sent (${lang})`, () => {
            const needsYou = label(lang, 'inbox.needsYou');
            const inbox = label(lang, 'nav.inbox');
            const nothing = lang === 'en' ? /nothing is sent|no reply is sent|left for you/i : /لا يُرسل شيء|لن يُرسل أي ردّ|تبقى الرسالة لك/;
            const line = lang === 'en' ? /\bline\b/ : /سطر/;
            for (const key of ['ai.fallbackDesc', 'ai.engineNoRouteOff']) {
                const text = label(lang, key);
                assert.ok(line.test(text), `${key}: the person is sent a line: ${text}`);
                assert.ok(text.includes(needsYou), `${key}: names ${needsYou}: ${text}`);
                assert.ok(text.includes(inbox), `${key}: and where it shows, ${inbox}: ${text}`);
                assert.equal(nothing.test(text), false, `${key}: no longer says nothing is sent: ${text}`);
            }
            // The card also says what the switch is for, and that a second failure ends the same way.
            const desc = label(lang, 'ai.fallbackDesc');
            assert.ok(desc.includes('Gemini'), 'it still says what is tried first');
            assert.ok(lang === 'en' ? /if Gemini fails too/.test(desc) : /إن فشل Gemini أيضاً/.test(desc), `${lang}: and that Gemini failing too ends the same way`);
        });
    }
});

// ─── 3. Who writes an infographic ────────────────────────────────────────────────────────────────────────────────────

describe('Interface copy — who writes the infographic the form asks for', () => {
    it('is what the code does: Claude on the Mac for the owner and the Mac-brain workspaces, the AI providers layer for every other', () => {
        const source = readFileSync('src/services/studio/infographics.ts', 'utf8');
        assert.match(source, /if \(!\(await isMacBrainAllowed\(creatorId\)\)\) return createOnServer\(creatorId, \{ topic: topic!, notes, body: b \}\);/, 'a workspace the Mac is not allowed for is written on the server');
        assert.match(readFileSync('src/services/studio/infographicWriter.ts', 'utf8'), /purpose: 'tenant_infographic', creatorId: a\.creatorId,/, 'through the layer, which provider the operator routed');
        assert.match(readFileSync('src/services/macBrain.ts', 'utf8'), /if \(owner !== null && id === owner\) return true;\s*return \(await getMacBrainTenants\(\)\)\.tenants\.includes\(id\);/, 'and the Mac is for the owner and the listed workspaces only');
    });

    for (const lang of LANGS) {
        it(`the Create form's hint names the writer in a way that is true of both (${lang})`, () => {
            const hint = label(lang, 'infographics.new.hint');
            assert.equal(/Claude/i.test(hint), false, `it does not name Claude, who writes only some workspaces' pages: ${hint}`);
            assert.ok(lang === 'en' ? /\bThe AI writes the page and its caption together\b/.test(hint) : hint.includes('الذكاء الاصطناعي'), `${lang}: it says the AI: ${hint}`);
            // What it promises besides the writer is unchanged: page and caption together, so the caption describes the GIF.
            assert.ok(lang === 'en' ? hint.includes('the caption always describes the GIF') : /مطابقاً للـ GIF/.test(hint), `${lang}: ${hint}`);
        });
    }
});

// ─── 4. The test box with the assistant off ──────────────────────────────────────────────────────────────────────────

describe('Interface copy — the test box and a switched-off assistant', () => {
    it('is what the code does: the box answers while the assistant is off, before anything is saved too, so it has no "the agent is off" case', () => {
        assert.equal(decideAgent({ is_active: false } as never, true).speak, true, 'a switched-off agent still answers the test box');
        assert.equal(decideAgent(null, true).speak, true, 'and so does no agent at all');
        // What makes a call "the test box" is that `overrides` is given, and the route always gives it.
        const route = readFileSync('src/routes/api.ts', 'utf8');
        const start = route.indexOf("router.post('/settings/ai/test'");
        const handler = route.slice(start, route.indexOf('// ─── Webhook Verify Token', start));
        assert.ok(handler.length > 1000, 'the handler was found');
        assert.match(handler, /const reply = await generateDmReply\(mockConvId, user_message, creatorId, \{/, 'it always passes the test box\'s own fields');
    });

    it('has no message for it: `ai.sandboxAgentOff` is gone from both dictionaries and nothing asks for it', () => {
        for (const lang of LANGS) {
            assert.equal(Object.hasOwn(STRINGS[lang], 'ai.sandboxAgentOff'), false, `${lang}: a sentence nothing can show is a sentence that can go stale`);
        }
        assert.equal(/sandboxAgentOff/.test(readFileSync('dashboard/js/pages/ai_settings.js', 'utf8')), false, 'the page does not map a status to it');
    });
});
