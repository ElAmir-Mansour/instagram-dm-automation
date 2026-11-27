/**
 * Claude on the Mac signed out (research USE-1): what counts as a sign-in failure, the stored flag (set by the first one, cleared by the next Claude job that
 * works, which puts the blocked work back exactly once), the Monteur waiting instead of spending tries, the probe, and the once-a-day email.
 * The pool answers from a tiny in-memory `app_settings`; nothing reaches Postgres, Resend, Telegram or the Mac.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { installFakeDb } from '../monteur/testDb.js';
import { ThinkSignedOut, ThinkWaiting, MAX_THINK_TRIES, THINK_FAILED, nextThinkStep, think, type ThinkTry } from '../monteur/think.js';
import { emailHttp } from '../notifyEmail.js';
import { APP_SETTING_KEYS } from '../appSettings.js';
import {
    alertOnce, checkMacAlarms, claudeStatusFor, clearClaudeSignedOut, isClaudeSignedOut, isSignInFailure, macAlertText, markClaudeSignedOut, noteMacJobDone,
    noteMacJobFailed, probeClaudeSignIn, requeueSignInBlocked, REQUEUE_LIMIT, REQUEUE_MAX_AGE_DAYS, SIGNED_OUT_MESSAGE, SIGNED_OUT_PROBE_MINUTES,
    type RequeueDeps,
} from './macHealth.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FLAG = APP_SETTING_KEYS.macClaudeSignedOutAt;
const MIN = 60;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// The sentences the CLI really gives, from the worker's logs.
const SIGNED_OUT_ERRORS = [
    'claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
];

describe('isSignInFailure', () => {
    it('knows every way the Claude CLI says it is signed out', () => {
        for (const message of SIGNED_OUT_ERRORS) assert.equal(isSignInFailure(message), true, message);
    });

    it('does not take a rate limit, a spent allowance, a stale Mac or a draft about OAuth for one', () => {
        for (const message of [
            'You have hit your limit', 'Claude AI usage limit reached|1760000000', 'No answer within 20 minutes: the Mac may be asleep, or its Studio worker stopped.',
            'The page returned 401', 'A post about OAuth and token expiry', 'Claude returned no answer.', '',
        ]) assert.equal(isSignInFailure(message), false, message);
        assert.equal(isSignInFailure(null), false);
        assert.equal(isSignInFailure(undefined), false);
    });

    it('is the one the explainers use: writing.ts re-exports it', async () => {
        const writing = await import('../explainers/writing.js');
        assert.equal(writing.isSignInFailure, isSignInFailure);
    });
});

/** A fake `app_settings` and `studio_jobs`, enough for the flag, the turns and the probe. */
function world() {
    const settings = new Map<string, string>();
    const probes: { creator: string; payload: any }[] = [];
    const db = installFakeDb({ platformTenant: OWNER });
    db.routes.push(
        [/^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\) VALUES \(\$1, \$2, FALSE, NOW\(\), NULL\) ON CONFLICT \(key\) DO NOTHING/, (p) => {
            if (settings.has(p[0])) return { rows: [], rowCount: 0 };
            settings.set(p[0], p[1]);
            return { rows: [], rowCount: 1 };
        }],
        [/^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\) VALUES \(\$1, \$2, FALSE, NOW\(\), NULL\) ON CONFLICT \(key\) DO UPDATE/, (p) => {
            if (settings.get(p[0]) === p[1]) return { rows: [], rowCount: 0 };
            settings.set(p[0], p[1]);
            return { rows: [], rowCount: 1 };
        }],
        [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); return { rows: [], rowCount: 1 }; }],
        [/^DELETE FROM app_settings WHERE key = \$1/, (p) => ({ rows: [], rowCount: settings.delete(p[0]) ? 1 : 0 })],
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1/, (p) => (settings.has(p[0]) ? { rows: [{ value: settings.get(p[0]), is_secret: false }] } : { rows: [] })],
        [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({
            rows: (p[0] as string[]).filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k), is_secret: false })),
        })],
        [/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, 'monteur_think', \$2::jsonb\) ON CONFLICT DO NOTHING/, (p) => {
            probes.push({ creator: p[0], payload: JSON.parse(p[1]) });
            return { rows: [], rowCount: 1 };
        }],
    );
    return { db, settings, probes };
}

const noDeps = (log: string[] = []): RequeueDeps => ({
    async rewriteInfographic(c, id) { log.push(`infographic ${id}`); },
    async advanceProposal(c, id) { log.push(`proposal ${id}`); },
    async retryExplainer(c, id) { log.push(`explainer ${id}`); },
});

describe('the flag mac.claude_signed_out_at', () => {
    let w: ReturnType<typeof world>;
    beforeEach(() => { w = world(); });
    afterEach(() => w.db.restore());

    it('is set by the first sign-in failure of a Claude job, and keeps that first time', async () => {
        assert.equal(await isClaudeSignedOut(), false);
        await noteMacJobFailed('monteur_think', { request: 'source/x/a1/monteur.pick' }, SIGNED_OUT_ERRORS[0]);
        assert.equal(await isClaudeSignedOut(), true);
        const first = w.settings.get(FLAG)!;
        assert.match(first, /^\d{4}-\d\d-\d\dT/);
        await new Promise((r) => setTimeout(r, 5));
        await noteMacJobFailed('ads_think', { proposalId: 'p' }, SIGNED_OUT_ERRORS[2]);
        assert.equal(w.settings.get(FLAG), first, 'a second failure does not move it');
    });

    it('is set by every kind of Claude work: a think, an ad proposal, an explainer script, an infographic that writes', async () => {
        for (const [kind, payload] of [
            ['monteur_think', {}], ['ads_think', {}], ['explainer_write', {}], ['render_infographic', { write: {} }],
        ] as const) {
            w.settings.clear();
            await noteMacJobFailed(kind, payload, SIGNED_OUT_ERRORS[0]);
            assert.equal(await isClaudeSignedOut(), true, kind);
        }
    });

    it('is NOT set by work that is not Claude’s, nor by a failure that is not a sign-in', async () => {
        await noteMacJobFailed('monteur_render', {}, SIGNED_OUT_ERRORS[0]);
        await noteMacJobFailed('render_infographic', { theme: 'dark' }, SIGNED_OUT_ERRORS[0]);
        await noteMacJobFailed('monteur_think', {}, 'You have hit your limit');
        await noteMacJobFailed('monteur_think', {}, 'No answer within 20 minutes');
        await noteMacJobFailed('monteur_think', {}, null);
        assert.equal(await isClaudeSignedOut(), false);
        assert.equal(w.settings.size, 0);
    });

    it('is cleared by the next Claude job that works, whatever its kind, and only that', async () => {
        await markClaudeSignedOut();
        await noteMacJobDone('monteur_render', {}, noDeps());
        await noteMacJobDone('render_infographic', { theme: 'dark' }, noDeps());
        assert.equal(await isClaudeSignedOut(), true, 'a render is not Claude');
        await noteMacJobDone('ads_think', {}, noDeps());
        assert.equal(await isClaudeSignedOut(), false);
    });

    it('is cleared by the probe’s own answer too', async () => {
        await markClaudeSignedOut();
        await noteMacJobDone('monteur_think', { request: 'mac-probe/1', step: 'probe' }, noDeps());
        assert.equal(await isClaudeSignedOut(), false);
    });

    it('is deleted by exactly one of two clears, so the work goes back once', async () => {
        await markClaudeSignedOut();
        const [a, b] = await Promise.all([clearClaudeSignedOut(), clearClaudeSignedOut()]);
        assert.deepEqual([a, b].sort(), [false, true]);
    });

    it('never throws into the job that was being reported: a database error is logged', async () => {
        w.db.routes.unshift([/app_settings/, () => { throw new Error('db down'); }]);
        await noteMacJobFailed('monteur_think', {}, SIGNED_OUT_ERRORS[0]);
        await noteMacJobDone('monteur_think', {}, noDeps());
    });
});

describe('claudeStatusFor: what the dashboard\'s Mac chip reads (CP-S2)', () => {
    let w: ReturnType<typeof world>;
    beforeEach(() => { w = world(); });
    afterEach(() => w.db.restore());

    it('says Claude is signed in (no time) for the owner while the flag is not set', async () => {
        assert.deepEqual(await claudeStatusFor(OWNER), { applies: true, signedOutAt: null });
    });

    it('carries the time of the first sign-in failure while the flag is set, and drops it once Claude works again', async () => {
        await markClaudeSignedOut(new Date('2026-11-28T08:00:00Z'));
        assert.deepEqual(await claudeStatusFor(OWNER), { applies: true, signedOutAt: '2026-11-28T08:00:00.000Z' });
        await noteMacJobDone('monteur_think', {}, noDeps());
        assert.deepEqual(await claudeStatusFor(OWNER), { applies: true, signedOutAt: null });
    });

    it('tells a tenant the Mac does not work for nothing about it: the flag is the platform\'s', async () => {
        await markClaudeSignedOut();
        assert.deepEqual(await claudeStatusFor('22222222-2222-4222-8222-222222222222'), { applies: false, signedOutAt: null });
    });

    it('says nothing about Claude when the read fails, never "signed in"', async () => {
        w.db.routes.unshift([/app_settings/, () => { throw new Error('db down'); }]);
        assert.deepEqual(await claudeStatusFor(OWNER), { applies: false, signedOutAt: null });
    });
});

describe('putting the blocked work back', () => {
    let w: ReturnType<typeof world>;
    const rows: { infographics: any[]; proposals: any[]; explainers: any[] } = { infographics: [], proposals: [], explainers: [] };
    beforeEach(() => {
        w = world();
        rows.infographics = []; rows.proposals = []; rows.explainers = [];
        w.db.routes.push(
            [/^SELECT id, creator_id FROM infographics/, () => ({ rows: rows.infographics })],
            [/^SELECT DISTINCT ON \(j\.payload->>'proposalId'\)/, () => ({ rows: rows.proposals })],
            [/^SELECT id, creator_id, error FROM explainers/, () => ({ rows: rows.explainers })],
        );
    });
    afterEach(() => w.db.restore());

    it('does it when the flag clears, once: the second clearing finds the flag gone and puts nothing back', async () => {
        rows.infographics = [{ id: 'g1', creator_id: OWNER }];
        rows.proposals = [{ creator_id: OWNER, proposal_id: 'p1', error: SIGNED_OUT_ERRORS[0] }];
        rows.explainers = [{ id: 'e1', creator_id: OWNER, error: SIGNED_OUT_ERRORS[3] }];
        await markClaudeSignedOut();
        const log: string[] = [];
        await noteMacJobDone('monteur_think', {}, noDeps(log));
        assert.deepEqual(log, ['infographic g1', 'proposal p1', 'explainer e1']);
        await noteMacJobDone('monteur_think', {}, noDeps(log));
        await noteMacJobDone('explainer_write', {}, noDeps(log));
        assert.equal(log.length, 3, 'nothing is put back twice');
    });

    it('selects only what the sign-in stopped, recently, and in a bounded number', async () => {
        await requeueSignInBlocked(noDeps());
        const [infographics] = w.db.ran(/FROM infographics/);
        assert.match(infographics!.sql, /status = 'failed' AND error = \$1 AND updated_at > NOW\(\) - make_interval\(days => \$2\)/);
        assert.deepEqual(infographics!.params, [SIGNED_OUT_MESSAGE, REQUEUE_MAX_AGE_DAYS, REQUEUE_LIMIT]);
        const [proposals] = w.db.ran(/ads_proposals/);
        assert.match(proposals!.sql, /p\.state = 'drafting'/);
        assert.match(proposals!.sql, /j\.status = 'failed'/);
        const [explainers] = w.db.ran(/FROM explainers/);
        assert.match(explainers!.sql, /status = 'failed' AND failed_step = 'write'/);
    });

    it('leaves a failure that was not a sign-in alone, and stops at the limit', async () => {
        rows.proposals = [
            { creator_id: OWNER, proposal_id: 'p-other', error: 'Claude returned no answer.' },
            ...Array.from({ length: REQUEUE_LIMIT + 5 }, (_, i) => ({ creator_id: OWNER, proposal_id: `p${i}`, error: SIGNED_OUT_ERRORS[0] })),
        ];
        const log: string[] = [];
        const out = await requeueSignInBlocked(noDeps(log));
        assert.equal(out.proposals, REQUEUE_LIMIT);
        assert.equal(log.includes('proposal p-other'), false);
    });

    it('one item that cannot be put back is logged and does not stop the others', async () => {
        rows.infographics = [{ id: 'g1', creator_id: OWNER }, { id: 'g2', creator_id: OWNER }];
        const done: string[] = [];
        const out = await requeueSignInBlocked({
            ...noDeps(),
            async rewriteInfographic(_c, id) { if (id === 'g1') throw new Error('busy'); done.push(id); },
        });
        assert.deepEqual(done, ['g2']);
        assert.equal(out.infographics, 1);
    });
});

describe('the Monteur waits while Claude is signed out', () => {
    const tryRow = (over: Partial<ThinkTry>): ThinkTry => ({ id: 'j', status: 'failed', result: null, error: null, try: 1, quiet_s: 0, since_s: 0, ...over });
    const signedOut = (n: number, since = 0) => Array.from({ length: n }, (_, i) => tryRow({ id: `s${n - i}`, try: n - i, since_s: since, error: SIGNED_OUT_ERRORS[0] }));

    it('a sign-in failure is neither a backoff nor a try: waiting while the flag is set, however long ago', () => {
        assert.deepEqual(nextThinkStep(signedOut(1, 0), true), { kind: 'signed_out' });
        assert.deepEqual(nextThinkStep(signedOut(1, 99_999), true), { kind: 'signed_out' });
    });

    it('asks again AT ONCE (no 10-minute backoff) when the flag is gone', () => {
        assert.deepEqual(nextThinkStep(signedOut(1, 0), false), { kind: 'ask', try: 2 });
        assert.deepEqual(nextThinkStep(signedOut(3, 5), false), { kind: 'ask', try: 4 });
    });

    it('never stops the item, however many sign-in failures there were: they are not counted toward four', () => {
        assert.equal(MAX_THINK_TRIES, 4);
        assert.equal(nextThinkStep(signedOut(9, 99_999), true).kind, 'signed_out');
        assert.equal(nextThinkStep(signedOut(9, 99_999), false).kind, 'ask');
    });

    it('still counts and backs off for every other failure, and sign-in failures among them do not use up its four', () => {
        const mixed = [
            tryRow({ id: 'a', try: 5, since_s: 5 * MIN, error: 'plan limit' }),
            tryRow({ id: 'b', try: 4, error: SIGNED_OUT_ERRORS[0] }),
            tryRow({ id: 'c', try: 3, error: SIGNED_OUT_ERRORS[0] }),
            tryRow({ id: 'd', try: 2, error: 'plan limit' }),
        ];
        const next = nextThinkStep(mixed);
        assert.equal(next.kind, 'wait', 'two real failures: the second backoff is 30 minutes, 5 have passed');
        const four = [1, 2, 3, 4].map((n) => tryRow({ id: `f${n}`, try: n, since_s: 999 * MIN, error: 'plan limit' }));
        assert.deepEqual(nextThinkStep(four), { kind: 'exhausted', error: `${THINK_FAILED}plan limit` });
    });

    describe('think()', () => {
        let w: ReturnType<typeof world>;
        let tries: ThinkTry[];
        const route = { creatorId: OWNER, request: 'source/s1/a1/monteur.pick', step: 'pick' as const };
        const req = { purpose: 'monteur.pick', system: 's', turns: [{ role: 'user' as const, text: 'x' }], schema: { type: 'OBJECT' as const, properties: {} } };
        const queued = () => w.db.ran(/^INSERT INTO studio_jobs \(creator_id, kind, payload\) VALUES \(\$1, 'monteur_think', \$2::jsonb\) ON CONFLICT DO NOTHING RETURNING id/);
        beforeEach(() => {
            w = world();
            tries = [];
            w.db.routes.unshift([/^SELECT id, status, result, error, \(payload->>'try'\)::int AS try/, () => ({ rows: tries.map((t) => ({ ...t })) })]);
            w.db.routes.unshift([/RETURNING id$/, () => ({ rows: [{ id: 'new' }] })]);
        });
        afterEach(() => w.db.restore());

        it('with the flag set it waits, says plainly that Claude is signed out, and queues nothing: 1 try, not 4', async () => {
            await markClaudeSignedOut();
            tries = [tryRow({ id: 't1', try: 1, error: SIGNED_OUT_ERRORS[0], since_s: 3 * 3600 })];
            await assert.rejects(think(route, req, { model: '', tokens_in: 0, tokens_out: 0, thinking: 0, calls: 0 }),
                (e: unknown) => e instanceof ThinkSignedOut && e instanceof ThinkWaiting && e.message.includes(SIGNED_OUT_MESSAGE));
            assert.equal(queued().length, 0);
        });

        it('once the flag is gone it asks for try 2 at once', async () => {
            tries = [tryRow({ id: 't1', try: 1, error: SIGNED_OUT_ERRORS[0], since_s: 3 })];
            await assert.rejects(think(route, req, { model: '', tokens_in: 0, tokens_out: 0, thinking: 0, calls: 0 }), (e: unknown) => e instanceof ThinkWaiting && !(e instanceof ThinkSignedOut));
            assert.equal(queued().length, 1);
            assert.equal(JSON.parse(queued()[0]!.params[1]).try, 2);
        });

        it('reads the flag only when the latest try failed with a sign-in error', async () => {
            tries = [tryRow({ id: 't1', try: 1, status: 'claimed', quiet_s: 5 })];
            await assert.rejects(think(route, req, { model: '', tokens_in: 0, tokens_out: 0, thinking: 0, calls: 0 }), ThinkWaiting);
            assert.equal(w.db.ran(new RegExp(`WHERE key = \\$1`)).filter((s) => s.params[0] === FLAG).length, 0);
        });
    });
});

describe('the probe', () => {
    let w: ReturnType<typeof world>;
    let recent: boolean;
    const NOW = new Date('2026-11-27T09:00:00Z');
    beforeEach(() => {
        w = world();
        recent = false;
        w.db.routes.unshift([/^SELECT id FROM studio_jobs WHERE creator_id = \$1 AND kind = 'monteur_think' AND payload->>'step' = 'probe'/, () => ({ rows: recent ? [{ id: 'open' }] : [] })]);
    });
    afterEach(() => w.db.restore());

    it('does nothing while Claude is not known to be signed out', async () => {
        assert.equal(await probeClaudeSignIn(NOW), 'not_signed_out');
        assert.equal(w.probes.length, 0);
    });

    it('queues one tiny think for the owner, naming step probe, with a request id for the half hour', async () => {
        await markClaudeSignedOut();
        assert.equal(await probeClaudeSignIn(NOW), 'queued');
        assert.equal(w.probes.length, 1);
        const { creator, payload } = w.probes[0]!;
        assert.equal(creator, OWNER);
        assert.equal(payload.step, 'probe');
        assert.equal(payload.try, 1);
        assert.equal(payload.request, `mac-probe/${Math.floor(NOW.getTime() / (SIGNED_OUT_PROBE_MINUTES * 60_000))}`);
        assert.ok(!('retired' in payload));
    });

    it('waits while one is open or was queued in the last half hour: at most one, however many drains run', async () => {
        await markClaudeSignedOut();
        recent = true;
        assert.equal(await probeClaudeSignIn(NOW), 'recent');
        assert.equal(w.probes.length, 0);
        const [asked] = w.db.ran(/step' = 'probe'/);
        assert.deepEqual(asked!.params, [OWNER, NOW, SIGNED_OUT_PROBE_MINUTES]);
    });
});

describe('the email: one a day per problem', () => {
    let w: ReturnType<typeof world>;
    let sent: { subject: string; text: string; to: string }[];
    let original: typeof emailHttp.post;
    const DAY1 = new Date('2026-11-27T05:00:00Z');
    const LATER_DAY1 = new Date('2026-11-27T23:59:00Z');
    const DAY2 = new Date('2026-11-28T00:01:00Z');
    beforeEach(() => {
        w = world();
        sent = [];
        w.settings.set(APP_SETTING_KEYS.notifyEmailApiKey, 're_test');
        w.settings.set(APP_SETTING_KEYS.notifyEmailTo, 'owner@example.com');
        w.settings.set(APP_SETTING_KEYS.notifyEmailEnabled, 'true');
        original = emailHttp.post;
        (emailHttp as unknown as { post: unknown }).post = async (_path: string, body: any) => { sent.push({ subject: body.subject, text: body.text, to: body.to[0] }); return { status: 200, data: {} }; };
    });
    afterEach(() => { (emailHttp as unknown as { post: unknown }).post = original; w.db.restore(); });

    it('says it once on the day, however many drains find the same problem, and again the next day', async () => {
        assert.equal(await alertOnce('signed_out', DAY1, 'https://x/help'), true);
        assert.equal(await alertOnce('signed_out', DAY1, 'https://x/help'), false);
        assert.equal(await alertOnce('signed_out', LATER_DAY1, 'https://x/help'), false);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.to, 'owner@example.com');
        assert.equal(await alertOnce('signed_out', DAY2, 'https://x/help'), true);
        assert.equal(sent.length, 2);
    });

    it('two drains at the same instant send one: the day is taken by a single statement', async () => {
        const [a, b] = await Promise.all([alertOnce('signed_out', DAY1, 'h'), alertOnce('signed_out', DAY1, 'h')]);
        assert.deepEqual([a, b].sort(), [false, true]);
        assert.equal(sent.length, 1);
    });

    it('the claim is one statement that writes only when the row holds another day', async () => {
        await alertOnce('signed_out', DAY1, 'h');
        const claim = w.db.ran(/ON CONFLICT \(key\) DO UPDATE/)[0]!;
        assert.match(claim.sql, /WHERE app_settings\.value IS DISTINCT FROM EXCLUDED\.value/);
        assert.deepEqual(claim.params, [APP_SETTING_KEYS.macAlertedSignedOut, '2026-11-27']);
    });

    it('each problem has its own day: signed out and offline are two emails', async () => {
        await alertOnce('signed_out', DAY1, 'h');
        await alertOnce('worker_offline', DAY1, 'h');
        assert.equal(sent.length, 2);
        assert.notEqual(sent[0]!.subject, sent[1]!.subject);
    });

    it('a day on which nothing could be sent is not used up: email off, then on, the next drain says it', async () => {
        w.settings.set(APP_SETTING_KEYS.notifyEmailEnabled, 'false');
        assert.equal(await alertOnce('signed_out', DAY1, 'h'), false);
        assert.equal(w.settings.has(APP_SETTING_KEYS.macAlertedSignedOut), false);
        w.settings.set(APP_SETTING_KEYS.notifyEmailEnabled, 'true');
        assert.equal(await alertOnce('signed_out', DAY1, 'h'), true);
        assert.equal(w.settings.get(APP_SETTING_KEYS.macAlertedSignedOut), '2026-11-27');
    });

    it('is in Arabic and English, names the fix, carries no job text, and links the help', () => {
        const signedOut = macAlertText('signed_out', 'https://app.example/dashboard#/help/worker');
        assert.match(signedOut.text, /claude \/login/);
        assert.match(signedOut.text, /[؀-ۿ]/);
        assert.match(signedOut.text, /will not switch to another model/);
        assert.match(signedOut.text, /https:\/\/app\.example\/dashboard#\/help\/worker$/);
        assert.match(macAlertText('worker_offline', 'h').text, /restart the worker/i);
    });

    describe('checkMacAlarms', () => {
        it('is quiet when all is well: no flag, no offline worker, no email, no probe', async () => {
            const out = await checkMacAlarms({ now: DAY1, offline: async () => false });
            assert.deepEqual(out, { probe: 'not_signed_out', alerted: [] });
            assert.equal(sent.length, 0);
            assert.equal(w.probes.length, 0);
        });

        it('signed out: probes and emails, then on the next drain emails nothing more that day', async () => {
            await markClaudeSignedOut();
            const first = await checkMacAlarms({ now: DAY1, baseUrl: 'https://app.example/', offline: async () => false });
            assert.equal(first.probe, 'queued');
            assert.deepEqual(first.alerted, ['signed_out']);
            assert.match(sent[0]!.text, /https:\/\/app\.example\/dashboard#\/help\/worker/);
            const second = await checkMacAlarms({ now: LATER_DAY1, offline: async () => false });
            assert.deepEqual(second.alerted, []);
            assert.equal(sent.length, 1);
        });

        it('the worker offline with work waiting: one email a day, and none once it is back', async () => {
            let offline = true;
            assert.deepEqual((await checkMacAlarms({ now: DAY1, offline: async () => offline })).alerted, ['worker_offline']);
            assert.deepEqual((await checkMacAlarms({ now: LATER_DAY1, offline: async () => offline })).alerted, []);
            offline = false;
            assert.deepEqual((await checkMacAlarms({ now: DAY2, offline: async () => offline })).alerted, []);
            assert.equal(sent.length, 1);
        });

        it('never throws: a failing check is logged', async () => {
            const out = await checkMacAlarms({ now: DAY1, offline: async () => { throw new Error('db down'); } });
            assert.deepEqual(out.alerted, []);
        });
    });
});

describe('the clock', () => {
    it('the email day is the UTC day, pinned: 23:59 and 00:01 are two days', async () => {
        mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-27T23:59:30Z') });
        try {
            const { utcDay } = await import('./macHealth.js');
            assert.equal(utcDay(new Date()), '2026-11-27');
            mock.timers.setTime(new Date('2026-11-28T00:00:30Z').getTime());
            assert.equal(utcDay(new Date()), '2026-11-28');
        } finally {
            mock.timers.reset();
        }
    });
});
