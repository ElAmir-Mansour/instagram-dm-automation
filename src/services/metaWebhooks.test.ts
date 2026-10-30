/**
 * Where Meta sends each kind of event, and sending it back (`metaWebhooks.ts`).
 *
 * The incident this exists for (2026-10-30): another project that uses this Meta app pointed `instagram` and a field-less `user` at its own site, and for 45 hours no
 * Instagram DM or comment arrived while the dashboard said "Connected". The fixture below is that state, exactly as Meta listed it (no secret is in it). What is pinned,
 * because each is a way the owner is hurt rather than helped:
 *
 *   - **The judgement.** The fixture is broken; an all-ours, complete list is not. A field-less object pointing elsewhere and a Page without `messaging_referrals` are warnings,
 *     never alarms. A required object that is missing, switched off, or short of `comments`/`messages` (`feed`/`messages`) is broken.
 *   - **The plan changes only what is wrong.** `instagram` back to us with its five fields at v25.0, `user` back to us with no `fields` parameter, `page` gaining
 *     `messaging_referrals` at v25.0, WhatsApp left alone; nothing already ours, active and complete is sent.
 *   - **The write is the one that worked by hand.** The exact URL (the version in it), the exact form body, the access and verify tokens in the BODY and never in a URL,
 *     the verify token the handshake accepts, no retry, a re-read at the end, a Meta refusal as that step's result, an audit row with hosts and fields and no token.
 *   - **A Page is left alone unless it needs it**: a complete one is not subscribed again, one that lacks the app or a field is, and `leadgen` counts only for a tenant
 *     whose lead-ads sign-off stands.
 *   - **The check is cheap and quiet.** At most one read an hour, nothing asked of Meta when the deployment cannot be checked, the last answer kept through a Meta outage,
 *     and one alert a day per problem, which a day on which nothing could be sent does not use up.
 *
 * Nothing here reaches Meta, Postgres, Resend or Telegram (`metaWebhooksHarness.ts`), and every test that spells out an instant pins the clock.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { APP_SETTING_KEYS } from './appSettings.js';
import { AUDIT_ACTIONS, redactDetail } from './audit.js';
import { encryptSecret } from '../config/crypto.js';
import { API_VERSION } from './instagram.js';
import { graphError } from './metaLoginHarness.js';
import { MetaLoginError } from './metaLogin.js';
import {
    alertKey, buildWebhookAlert, checkMetaWebhooks, CHECK_INTERVAL_MS, describeSubscriptions, expectedCallback, findProblems, isBroken, parseStatus, parseSubscriptions,
    planRepair, readAppSubscriptions, readLastEvents, readStatus, readWebhookSummary, repairSubscriptions, REPAIR_TIMEOUT_MS, summarizeStatus, viewOf,
    type DescribedObject,
} from './metaWebhooks.js';
import {
    FakeChannels, FakeMeta, FakeWebhookDb, healthySubscriptions, incidentSubscriptions, OTHER_SITE, OUR_BASE, OUR_CALLBACK, timeoutError, type FakeSubscription,
} from './metaWebhooksHarness.js';
import { verifyTokenCandidates } from './webhookVerifyToken.js';
import { setLogSink } from '../utils/log.js';

const OUR_HOST = 'msg-response-auto.vercel.app';
const APP_ID = '111222333444555';
const APP_SECRET = 'the-app-secret-0123456789-never-in-a-log';
const APP_TOKEN = `${APP_ID}|${APP_SECRET}`;
const ENV_VERIFY = 'env-verify-token-0123456789';
const DB_VERIFY = 'db-verify-token-0123456789';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PAGE_TOKEN_A = 'EAAPageTokenOfTenantA0123456789abcdefghijklmnop';
const PAGE_TOKEN_B = 'EAAPageTokenOfTenantB0123456789abcdefghijklmnop';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The clock, pinned at an instant (and moved by pinning it again). */
const pin = (ms: number): void => {
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: ms });
};

/** Meta's answer for a list, as the service reads it. */
const describedFrom = (subs: FakeSubscription[], host = OUR_HOST): DescribedObject[] => describeSubscriptions(parseSubscriptions({ data: subs }), host);
const incident = (): DescribedObject[] => describedFrom(incidentSubscriptions());
const byObject = (list: readonly DescribedObject[], object: string): DescribedObject => list.find((o) => o.object === object)!;

// ─── The judgement ──────────────────────────────────────────────────────────────────────

describe('describeSubscriptions: each object against the host this deployment gives Meta', () => {
    it('reads the 2026-10-30 state: instagram and user elsewhere, page and WhatsApp ours', () => {
        const d = incident();
        assert.deepEqual(d.map((o) => [o.object, o.host, o.ours, o.active, o.carriesEvents]), [
            ['instagram', 'staging.as-systems.tech', false, true, true],
            ['whatsapp_business_account', OUR_HOST, true, true, true],
            ['page', OUR_HOST, true, true, true],
            ['user', 'staging.as-systems.tech', false, true, false],
        ]);
        assert.deepEqual(byObject(d, 'instagram').fields, ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights']);
        assert.equal(byObject(d, 'instagram').version, 'v25.0');
        assert.equal(byObject(d, 'whatsapp_business_account').version, 'v26.0');
        assert.equal(byObject(d, 'user').version, null, 'no fields, so no version to keep');
    });

    it('lists what a required object lacks, and nothing for an object nothing requires', () => {
        const d = incident();
        assert.deepEqual(byObject(d, 'instagram').missingRequired, []);
        assert.deepEqual(byObject(d, 'page').missingRequired, ['messaging_referrals']);
        assert.deepEqual(byObject(d, 'whatsapp_business_account').missingRequired, []);
        assert.deepEqual(byObject(d, 'user').missingRequired, []);
    });

    it('has no single version for fields subscribed at different ones, and compares the host in any case', () => {
        const mixed: FakeSubscription = { object: 'page', callback_url: 'https://MSG-Response-Auto.vercel.app/webhook', active: true, fields: [{ name: 'feed', version: 'v25.0' }, { name: 'messages', version: 'v26.0' }] };
        const [d] = describedFrom([mixed]);
        assert.equal(d!.version, null);
        assert.equal(d!.ours, true, 'a host is not case-sensitive');
    });

    it('reads a callback that is not a URL, or is absent, as no host and not ours', () => {
        const [a, b] = describeSubscriptions(parseSubscriptions({ data: [{ object: 'a', callback_url: 'not a url', active: true, fields: [] }, { object: 'b', active: true, fields: [] }] }), OUR_HOST);
        assert.deepEqual([a!.host, a!.ours, b!.host, b!.ours], [null, false, null, false]);
    });
});

describe('parseSubscriptions: Meta\'s answer, or no answer', () => {
    it('is no answer, and never "no subscriptions", for anything that is not { data: [...] }', () => {
        for (const body of [undefined, null, '<html>502</html>', 5, [], {}, { data: 'x' }, { error: { message: 'x' } }]) {
            assert.throws(() => parseSubscriptions(body), (err: unknown) => err instanceof MetaLoginError && err.reason === 'graph_failed', JSON.stringify(body));
        }
        assert.deepEqual(parseSubscriptions({ data: [] }), [], 'an empty list is an answer');
    });

    it('is switched off only when Meta says active: false, and keeps only versions that are versions', () => {
        const list = parseSubscriptions({ data: [
            { object: 'a', callback_url: 'https://x.test/w', active: false, fields: [{ name: 'f', version: 'v25.0' }] },
            { object: 'b', callback_url: 'https://x.test/w', fields: [{ name: 'f', version: 'latest' }, { name: '' }, 'junk', { version: 'v1.0' }] },
            { callback_url: 'https://x.test/w' },
        ] });
        assert.deepEqual(list.map((s) => [s.object, s.active, s.fields]), [['a', false, [{ name: 'f', version: 'v25.0' }]], ['b', true, [{ name: 'f', version: null }]]]);
    });
});

describe('isBroken and findProblems: what stops the product, and what only warns', () => {
    it('is broken for the 2026-10-30 state, because of instagram and only instagram', () => {
        assert.equal(isBroken(incident()), true);
        assert.deepEqual(findProblems(incident()), [{
            object: 'instagram', host: 'staging.as-systems.tech', kind: 'elsewhere', fields: ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'],
        }]);
    });

    it('is not broken when everything is ours, active and complete', () => {
        assert.equal(isBroken(describedFrom(healthySubscriptions())), false);
        assert.deepEqual(findProblems(describedFrom(healthySubscriptions())), []);
    });

    it('treats a field-less object pointing elsewhere as a warning: `user` alone is not an outage', () => {
        const d = describedFrom([...healthySubscriptions(), { object: 'user', callback_url: OTHER_SITE, active: true, fields: [] }]);
        assert.equal(isBroken(d), false);
    });

    it('treats a Page without messaging_referrals, or with an extra field Meta added, as a warning', () => {
        const noReferrals = healthySubscriptions();
        noReferrals[1]!.fields = noReferrals[1]!.fields.filter((f) => f.name !== 'messaging_referrals');
        assert.equal(isBroken(describedFrom(noReferrals)), false);
        const extra = healthySubscriptions();
        extra[1]!.fields.push({ name: 'mention', version: 'v25.0' });
        assert.equal(isBroken(describedFrom(extra)), false);
    });

    it('is broken when an object that carries events is elsewhere or switched off, WhatsApp included', () => {
        const wa: FakeSubscription = { object: 'whatsapp_business_account', callback_url: OTHER_SITE, active: true, fields: [{ name: 'messages', version: 'v26.0' }] };
        assert.deepEqual(findProblems(describedFrom([...healthySubscriptions(), wa])).map((p) => [p.object, p.kind]), [['whatsapp_business_account', 'elsewhere']]);
        const off = healthySubscriptions();
        off[0]!.active = false;
        assert.deepEqual(findProblems(describedFrom(off)).map((p) => [p.object, p.kind, p.host]), [['instagram', 'inactive', OUR_HOST]]);
    });

    it('is broken when a required object is missing, whichever it is', () => {
        const [instagram, page] = healthySubscriptions();
        assert.deepEqual(findProblems(describedFrom([page!])), [{ object: 'instagram', host: null, kind: 'missing_object', fields: ['comments', 'messages'] }]);
        assert.deepEqual(findProblems(describedFrom([instagram!])).map((p) => [p.object, p.kind]), [['page', 'missing_object']]);
        assert.equal(findProblems([]).length, 2, 'with no subscription at all, both are missing');
    });

    it('is broken when instagram lacks comments or messages, or page lacks feed or messages', () => {
        const noComments = healthySubscriptions();
        noComments[0]!.fields = noComments[0]!.fields.filter((f) => f.name !== 'comments');
        assert.deepEqual(findProblems(describedFrom(noComments)), [{ object: 'instagram', host: OUR_HOST, kind: 'missing_field', fields: ['comments'] }]);
        const noFeed = healthySubscriptions();
        noFeed[1]!.fields = noFeed[1]!.fields.filter((f) => f.name !== 'feed' && f.name !== 'messages');
        assert.deepEqual(findProblems(describedFrom(noFeed)), [{ object: 'page', host: OUR_HOST, kind: 'missing_field', fields: ['feed', 'messages'] }]);
    });

    it('says a required object that points elsewhere with no fields is elsewhere, and still broken', () => {
        const d = describedFrom([{ object: 'instagram', callback_url: OTHER_SITE, active: true, fields: [] }, healthySubscriptions()[1]!]);
        assert.deepEqual(findProblems(d).map((p) => [p.object, p.kind]), [['instagram', 'elsewhere']]);
    });

    it('does not let an object name from Meta reach a prototype: an object called __proto__ or constructor is just an object', () => {
        const d = describedFrom([...healthySubscriptions(), { object: '__proto__', callback_url: OTHER_SITE, active: true, fields: [{ name: 'x', version: 'v25.0' }] }, { object: 'constructor', callback_url: OUR_CALLBACK, active: true, fields: [] }]);
        assert.deepEqual(findProblems(d).map((p) => p.object), ['__proto__']);
        assert.deepEqual(d.find((o) => o.object === 'constructor')!.missingRequired, []);
    });
});

describe('planRepair: one step per object that is wrong, and nothing else', () => {
    it('re-points instagram with its five fields at v25.0, user with no fields, adds messaging_referrals to page at v25.0, and leaves WhatsApp alone', () => {
        const plan = planRepair(incident(), OUR_CALLBACK, 'v26.0');
        assert.deepEqual(plan.map((s) => s.object), ['instagram', 'page', 'user']);
        const [instagram, page, user] = plan;
        assert.deepEqual(instagram, {
            object: 'instagram', kind: 'elsewhere', fromHost: 'staging.as-systems.tech', callbackUrl: OUR_CALLBACK,
            fields: ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'], addedFields: [], version: 'v25.0',
        });
        assert.deepEqual(page, {
            object: 'page', kind: 'missing_field', fromHost: OUR_HOST, callbackUrl: OUR_CALLBACK,
            fields: ['feed', 'messages', 'messaging_postbacks', 'messaging_referrals'], addedFields: ['messaging_referrals'], version: 'v25.0',
        });
        assert.deepEqual(user, { object: 'user', kind: 'elsewhere', fromHost: 'staging.as-systems.tech', callbackUrl: OUR_CALLBACK, fields: [], addedFields: [], version: 'v26.0' });
    });

    it('is empty for an all-ours, active and complete list', () => {
        assert.deepEqual(planRepair(describedFrom(healthySubscriptions()), OUR_CALLBACK, 'v26.0'), []);
        assert.deepEqual(planRepair(describedFrom([...healthySubscriptions(), incidentSubscriptions()[1]!]), OUR_CALLBACK, 'v26.0'), [], 'WhatsApp ours: untouched');
    });

    it('sends the union of the fields an object has and the ones it needs, so nothing the Meta app subscribed to is dropped', () => {
        const d = describedFrom([{ object: 'instagram', callback_url: OTHER_SITE, active: true, fields: [{ name: 'story_insights', version: 'v25.0' }, { name: 'comments', version: 'v25.0' }] }, healthySubscriptions()[1]!]);
        const [step] = planRepair(d, OUR_CALLBACK, 'v26.0');
        assert.deepEqual(step!.fields, ['story_insights', 'comments', 'messages']);
        assert.deepEqual(step!.addedFields, ['messages']);
    });

    it('switches a subscription back on that is ours but off, and names why each step is there', () => {
        const off = healthySubscriptions();
        off[0]!.active = false;
        assert.deepEqual(planRepair(describedFrom(off), OUR_CALLBACK, 'v26.0').map((s) => [s.object, s.kind]), [['instagram', 'inactive']]);
    });

    it('subscribes a required object Meta has none for, at the app\'s own version with exactly its required fields', () => {
        const plan = planRepair(describedFrom([healthySubscriptions()[1]!]), OUR_CALLBACK, 'v26.0');
        assert.deepEqual(plan, [{ object: 'instagram', kind: 'missing_object', fromHost: null, callbackUrl: OUR_CALLBACK, fields: ['comments', 'messages'], addedFields: ['comments', 'messages'], version: 'v26.0' }]);
    });

    it('uses the app\'s version when an object\'s fields are subscribed at different ones', () => {
        const mixed: FakeSubscription = { object: 'page', callback_url: OTHER_SITE, active: true, fields: [{ name: 'feed', version: 'v25.0' }, { name: 'messages', version: 'v24.0' }] };
        const plan = planRepair(describedFrom([healthySubscriptions()[0]!, mixed]), OUR_CALLBACK, 'v26.0');
        assert.equal(plan[0]!.version, 'v26.0');
    });
});

describe('status and summary', () => {
    const answered = (objects: DescribedObject[], ok: boolean | null = true) => ({
        checkedAt: '2026-10-30T12:00:00.000Z', attemptedAt: '2026-10-30T12:00:00.000Z', ok, expectedUrl: OUR_CALLBACK, expectedHost: OUR_HOST, objects, error: null,
    });

    it('round-trips through its stored form, and reads anything else as nothing stored', () => {
        const status = answered(incident(), false);
        assert.deepEqual(parseStatus(JSON.stringify(status)), status);
        for (const raw of [null, '', 'not json', '[]', '{}', '{"attemptedAt":"yesterday"}', '"x"']) assert.equal(parseStatus(raw), null, String(raw));
    });

    it('drops an object that is not the shape of one, and keeps the rest', () => {
        const parsed = parseStatus(JSON.stringify({ ...answered(incident(), false), objects: [{ object: 'x' }, ...incident(), 5] }));
        assert.equal(parsed!.objects.length, 4);
    });

    it('summarises the problems of an answered status, the same for every tenant', () => {
        assert.deepEqual(summarizeStatus(answered(incident(), false)), {
            ok: false, checkedAt: '2026-10-30T12:00:00.000Z',
            problems: [{ object: 'instagram', host: 'staging.as-systems.tech', kind: 'elsewhere', fields: ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'] }],
        });
        assert.deepEqual(summarizeStatus(answered(describedFrom(healthySubscriptions()))), { ok: true, checkedAt: '2026-10-30T12:00:00.000Z', problems: [] });
    });

    it('has nothing to say about Meta before Meta has answered: neither "all well" nor "broken"', () => {
        assert.equal(summarizeStatus(null), null);
        assert.deepEqual(summarizeStatus({ ...answered([], null), checkedAt: null }), { ok: null, checkedAt: null, problems: [] });
    });

    it('builds the card\'s view: the problems and the plan the button would apply, and no plan before Meta answered', () => {
        const view = viewOf(answered(incident(), false));
        assert.equal(view.ok, false);
        assert.deepEqual(view.problems.map((p) => p.object), ['instagram']);
        assert.deepEqual(view.plan.map((s) => s.object), ['instagram', 'page', 'user']);
        assert.deepEqual(view.expected, { url: OUR_CALLBACK, host: OUR_HOST });
        assert.deepEqual(viewOf({ ...answered([], null), checkedAt: null }).plan, []);
    });
});

describe('the alert text', () => {
    const problems = findProblems(incident());
    const link = `${OUR_BASE}/dashboard#/settings?s=platform&card=meta-events`;

    it('says it in Arabic and then in English: which event type goes where, and where to fix it with one click', () => {
        const { subject, text } = buildWebhookAlert(problems, link);
        assert.equal(subject, 'AutoReply · Meta is not sending your events to AutoReply');
        assert.ok(text.startsWith('AutoReply · ميتا لا ترسل أحداثك إلى AutoReply'), 'Arabic first');
        assert.ok(text.indexOf('إنستجرام') < text.indexOf('Instagram'));
        assert.ok(text.includes('• Instagram: events go to staging.as-systems.tech, not to AutoReply.'));
        assert.ok(text.includes('• إنستجرام: تذهب الأحداث إلى staging.as-systems.tech لا إلى AutoReply.'));
        assert.equal(text.split(link).length - 1, 2, 'the link, once in each language');
        assert.ok(text.includes('"Send everything to AutoReply"') && text.includes('«أرسل كل شيء إلى AutoReply»'));
    });

    it('names an object it has no name for as Meta spells it, cut to what a name can hold: no link, no line break', () => {
        const odd = buildWebhookAlert([{ object: 'perm\nissions<script>', host: 'evil.test', kind: 'inactive', fields: [] }], link).text;
        assert.ok(odd.includes('• permissionsscript: the subscription is switched off in Meta.'));
        assert.ok(!odd.includes('<script>'));
    });

    it('is one alert per problem a day: object, kind and host make the key', () => {
        assert.equal(alertKey(problems[0]!), 'instagram:elsewhere:staging.as-systems.tech');
        assert.equal(alertKey({ object: 'page', host: null, kind: 'missing_object', fields: [] }), 'page:missing_object:');
    });
});

// ─── The world the rest of the tests run in ─────────────────────────────────────────────

let db: FakeWebhookDb;
let meta: FakeMeta;
let channels: FakeChannels;
let logs: Array<{ level: string; event: string; line: string }>;
let restoreSink: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'PUBLIC_BASE_URL']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
    process.env.META_APP_ID = APP_ID;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = ENV_VERIFY;
    delete process.env.PUBLIC_BASE_URL;
    db = new FakeWebhookDb().install();
    meta = new FakeMeta().install();
    channels = new FakeChannels().install();
    db.set(APP_SETTING_KEYS.publicBaseUrl, OUR_BASE);
    meta.appId = APP_ID;
    meta.subscriptions = incidentSubscriptions();
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, line, event: (JSON.parse(line) as { event?: string }).event ?? '' }); });
    restoreSink = () => setLogSink(previous);
    pin(NOW);
});

afterEach(() => {
    mock.timers.reset();
    restoreSink?.();
    channels.restore();
    meta.restore();
    db.restore();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const subscriptionPosts = () => meta.called(/^POST .*\/subscriptions$/);
const pagePosts = () => meta.called(/^POST .*\/subscribed_apps$/);
const form = (call: { body: URLSearchParams | undefined }): Record<string, string> => Object.fromEntries(call.body!);
const actor = { userId: null, email: 'admin@example.com' };

/** Everything a secret could hide in after a run, apart from the Meta calls themselves (which carry the token legitimately: that is what the tests above them look at). */
const everywhere = (extra: unknown[] = []): string => JSON.stringify([logs.map((l) => l.line), db.audit, [...db.settings.entries()], extra]);

// ─── Reading ────────────────────────────────────────────────────────────────────────────

describe('readAppSubscriptions', () => {
    it('is GET /{app}/subscriptions with the app token in an Authorization header and nowhere in the URL', async () => {
        const subs = await readAppSubscriptions();
        assert.equal(subs.length, 4);
        const [call] = meta.calls;
        assert.equal(call!.url, `https://graph.facebook.com/${API_VERSION}/${APP_ID}/subscriptions`);
        assert.equal(call!.authorization, `Bearer ${APP_TOKEN}`);
        assert.ok(!call!.url.includes(APP_SECRET) && !call!.url.includes('access_token'));
    });

    it('is not_configured, with no call made, when the app id or its secret is missing', async () => {
        delete process.env.META_APP_SECRET;
        await assert.rejects(readAppSubscriptions(), (err: unknown) => err instanceof MetaLoginError && err.reason === 'not_configured' && err.httpStatus === 409);
        assert.equal(meta.calls.length, 0);
    });

    it('fails as graph_failed with Meta\'s own words and none of the secrets, even when the message echoes them and the axios error carries them', async () => {
        meta.fail(/^GET /, graphError(400, { message: `Invalid OAuth access token ${APP_TOKEN} (secret ${APP_SECRET})`, code: 190 }));
        await assert.rejects(readAppSubscriptions(), (err: unknown) => {
            assert.ok(err instanceof MetaLoginError && err.reason === 'graph_failed' && err.httpStatus === 502);
            assert.ok(err.message.includes('Invalid OAuth access token'));
            assert.ok(!err.message.includes(APP_SECRET) && !err.message.includes(APP_TOKEN));
            assert.ok(!JSON.stringify(err).includes('REQUEST-CONFIG') && !('response' in err) && !('config' in err), 'no axios error, with its request config, escapes');
            return true;
        });
    });

    it('fails as graph_failed for an answer that is not a subscription list', async () => {
        meta.rawSubscriptionsBody = { value: '<html>Bad Gateway</html>' };
        await assert.rejects(readAppSubscriptions(), (err: unknown) => err instanceof MetaLoginError && err.reason === 'graph_failed');
        meta.rawSubscriptionsBody = { value: { data: [] } };
        assert.deepEqual(await readAppSubscriptions(), [], 'an empty list is an answer');
    });
});

describe('expectedCallback', () => {
    it('is the public base URL and /webhook, and says so when there is no public address', async () => {
        assert.deepEqual(await expectedCallback(), { url: OUR_CALLBACK, host: OUR_HOST });
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        await assert.rejects(expectedCallback(), (err: unknown) => err instanceof MetaLoginError && err.reason === 'no_base_url' && err.httpStatus === 409);
    });
});

describe('verifyTokenCandidates: the list GET /webhook accepts, which the repair sends from', () => {
    it('is the environment\'s token first, then the first active creator\'s', async () => {
        db.addCreator(TENANT_A, { is_active: false, webhook_verify_token: 'inactive-creators-token-0123' });
        db.addCreator(TENANT_B, { webhook_verify_token: DB_VERIFY });
        assert.deepEqual(await verifyTokenCandidates(), [ENV_VERIFY, DB_VERIFY]);
    });

    it('is the creator\'s alone with no environment token, and empty with neither', async () => {
        delete process.env.META_VERIFY_TOKEN;
        assert.deepEqual(await verifyTokenCandidates(), []);
        db.addCreator(TENANT_A, { webhook_verify_token: DB_VERIFY });
        assert.deepEqual(await verifyTokenCandidates(), [DB_VERIFY]);
    });

    it('keeps a correct environment token working when the database cannot be read, and logs it', async () => {
        db.failOn = /FROM creators/;
        assert.deepEqual(await verifyTokenCandidates(), [ENV_VERIFY]);
        assert.ok(logs.some((l) => l.event === 'webhook.verify_token_read_failed' && l.level === 'error'));
    });
});

// ─── The repair ─────────────────────────────────────────────────────────────────────────

describe('repairSubscriptions: the write that worked by hand', () => {
    it('sends exactly what the manual fix sent: three POSTs, each at its own version, the tokens in the body and none in a URL', async () => {
        const out = await repairSubscriptions(actor);
        const posts = subscriptionPosts();
        assert.deepEqual(posts.map((p) => p.url), [
            `https://graph.facebook.com/v25.0/${APP_ID}/subscriptions`,
            `https://graph.facebook.com/v25.0/${APP_ID}/subscriptions`,
            `https://graph.facebook.com/${API_VERSION}/${APP_ID}/subscriptions`,
        ]);
        assert.deepEqual(posts.map((p) => form(p)['object']), ['instagram', 'page', 'user']);

        // instagram: all five fields, as Meta had them
        assert.deepEqual([...posts[0]!.body!.keys()], ['object', 'callback_url', 'fields', 'verify_token', 'include_values', 'access_token']);
        assert.deepEqual(form(posts[0]!), {
            object: 'instagram', callback_url: OUR_CALLBACK, fields: 'comments,mentions,messages,messaging_postbacks,story_insights',
            verify_token: ENV_VERIFY, include_values: 'true', access_token: APP_TOKEN,
        });
        // page: the missing messaging_referrals added to what it had
        assert.equal(form(posts[1]!)['fields'], 'feed,messages,messaging_postbacks,messaging_referrals');
        // user: a field-less object gets no `fields` parameter at all
        assert.deepEqual([...posts[2]!.body!.keys()], ['object', 'callback_url', 'verify_token', 'include_values', 'access_token']);

        for (const post of posts) {
            assert.ok(!post.url.includes(APP_SECRET) && !post.url.includes(ENV_VERIFY) && !post.url.includes('access_token'), 'a URL carries no token');
            assert.equal(post.authorization, undefined, 'the write authorises in its body');
            assert.equal(post.timeout, REPAIR_TIMEOUT_MS, 'Meta calls our server during the POST, so the call is given 30 s');
        }
        assert.deepEqual(out.steps, [{ object: 'instagram', ok: true }, { object: 'page', ok: true }, { object: 'user', ok: true }]);
    });

    it('leaves WhatsApp, which was ours, alone, and reads the subscriptions back', async () => {
        const wa = JSON.stringify(meta.subscriptions.find((s) => s.object === 'whatsapp_business_account'));
        const out = await repairSubscriptions(actor);
        assert.ok(!subscriptionPosts().some((p) => form(p)['object'] === 'whatsapp_business_account'));
        assert.equal(JSON.stringify(meta.subscriptions.find((s) => s.object === 'whatsapp_business_account')), wa);
        // GET before, three POSTs, GET after, in that order
        assert.deepEqual(meta.calls.filter((c) => /subscriptions$/.test(c.url)).map((c) => c.method), ['GET', 'POST', 'POST', 'POST', 'GET']);
        assert.equal(out.before.find((o) => o.object === 'instagram')!.ours, false);
        assert.ok(out.after!.every((o) => o.ours), 'what Meta says now: everything is ours');
        assert.equal(isBroken(out.after!), false);
    });

    it('stores what Meta says NOW, so the banners clear at once', async () => {
        await checkMetaWebhooks({ force: true });
        assert.equal((await readWebhookSummary())!.ok, false);
        const out = await repairSubscriptions(actor);
        assert.equal(out.status.ok, true);
        const stored = (await readWebhookSummary())!;
        assert.deepEqual([stored.ok, stored.problems], [true, []]);
        assert.deepEqual(viewOf(out.status).plan, []);
    });

    it('keeps the fields Meta had: an extra subscription on a required object is not dropped', async () => {
        meta.subscriptions = [
            { object: 'instagram', callback_url: OTHER_SITE, active: true, fields: [{ name: 'story_insights', version: 'v25.0' }] },
            ...healthySubscriptions().slice(1),
        ];
        await repairSubscriptions(actor);
        assert.deepEqual(meta.subscriptions.find((s) => s.object === 'instagram')!.fields.map((f) => f.name), ['story_insights', 'comments', 'messages']);
    });

    it('does nothing at app level when nothing is wrong: no subscription POST, and still the read-back and the audit row', async () => {
        meta.subscriptions = healthySubscriptions();
        const out = await repairSubscriptions(actor);
        assert.deepEqual([out.plan, out.steps], [[], []]);
        assert.equal(subscriptionPosts().length, 0);
        assert.equal(db.audit.length, 1);
    });

    it('sends the verify token the handshake accepts: the environment\'s first', async () => {
        db.addCreator(TENANT_A, { webhook_verify_token: DB_VERIFY });
        meta.acceptsVerifyToken = (token) => token === ENV_VERIFY;
        await repairSubscriptions(actor);
        assert.ok(subscriptionPosts().every((p) => form(p)['verify_token'] === ENV_VERIFY));
    });

    it('sends the first active creator\'s token when the environment has none', async () => {
        delete process.env.META_VERIFY_TOKEN;
        db.addCreator(TENANT_A, { webhook_verify_token: DB_VERIFY });
        meta.acceptsVerifyToken = (token) => token === DB_VERIFY;
        const out = await repairSubscriptions(actor);
        assert.ok(subscriptionPosts().every((p) => form(p)['verify_token'] === DB_VERIFY));
        assert.ok(out.steps.every((s) => s.ok));
    });

    it('refuses with no_verify_token, before any call to Meta, when there is no token to send', async () => {
        delete process.env.META_VERIFY_TOKEN;
        await assert.rejects(repairSubscriptions(actor), (err: unknown) => err instanceof MetaLoginError && err.reason === 'no_verify_token' && err.httpStatus === 409);
        assert.equal(meta.calls.length, 0);
        assert.equal(db.audit.length, 0);
    });

    it('refuses with not_configured and with no_base_url, before any call to Meta', async () => {
        delete process.env.META_APP_ID;
        await assert.rejects(repairSubscriptions(actor), (err: unknown) => err instanceof MetaLoginError && err.reason === 'not_configured');
        process.env.META_APP_ID = APP_ID;
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        await assert.rejects(repairSubscriptions(actor), (err: unknown) => err instanceof MetaLoginError && err.reason === 'no_base_url');
        assert.equal(meta.calls.length, 0);
    });

    it('does not retry a call that timed out: one attempt per object, that step says so, the others go on, and the read-back shows the truth', async () => {
        meta.fail(/^POST .*\/subscriptions$/, timeoutError(), 1);
        const out = await repairSubscriptions(actor);
        assert.equal(subscriptionPosts().length, 3, 'one POST per step, never a second for the one that timed out');
        assert.equal(out.steps[0]!.ok, false);
        assert.ok(out.steps[0]!.error!.includes('did not answer in time') && out.steps[0]!.error!.includes('check again'));
        assert.deepEqual(out.steps.slice(1).map((s) => s.ok), [true, true]);
        // instagram was never changed, and the re-read says so
        assert.equal(out.after!.find((o) => o.object === 'instagram')!.ours, false);
        assert.equal(out.status.ok, false);
    });

    it('does not retry a server error either: Meta may already have applied it', async () => {
        meta.fail(/^POST .*\/subscriptions$/, graphError(500, { message: 'An unexpected error has occurred.', code: 2 }), 3);
        await repairSubscriptions(actor);
        assert.equal(subscriptionPosts().length, 3);
    });

    it('reports a Meta refusal on one object as that step\'s result, with Meta\'s words and none of the secrets, and goes on', async () => {
        meta.fail(/^POST .*\/subscriptions$/, graphError(400, { message: `Callback verification failed; token ${ENV_VERIFY} access ${APP_TOKEN}`, code: 2200 }), 1);
        const out = await repairSubscriptions(actor);
        const [first, ...rest] = out.steps;
        assert.equal(first!.ok, false);
        assert.ok(first!.error!.startsWith('Callback verification failed'));
        assert.ok(!first!.error!.includes(ENV_VERIFY) && !first!.error!.includes(APP_SECRET) && !first!.error!.includes(APP_TOKEN));
        assert.deepEqual(rest.map((s) => s.ok), [true, true]);
        assert.ok(!everywhere([out]).includes(ENV_VERIFY) && !everywhere([out]).includes(APP_SECRET));
    });

    it('does not take Meta\'s "success" for the fact: a change Meta said yes to and did not make is still broken afterwards', async () => {
        meta.ignorePosts = true;
        const out = await repairSubscriptions(actor);
        assert.ok(out.steps.every((s) => s.ok));
        assert.equal(out.status.ok, false);
        assert.equal(JSON.parse(db.audit[0]!.detail).still_broken, true);
    });

    it('says the subscriptions could not be read back, and keeps the last answer it had, when the read after the change fails', async () => {
        await checkMetaWebhooks({ force: true });
        // The repair's own read goes through; the read-back after the three steps is the second.
        meta.fail(/^GET .*\/subscriptions$/, graphError(500, { message: 'down', code: 2 }), 1, 1);
        const out = await repairSubscriptions(actor);
        assert.equal(out.after, null);
        assert.equal(out.status.error!.code, 'graph_failed');
        assert.equal(out.status.ok, false, 'what was last seen stands');
        assert.equal(JSON.parse(db.audit[0]!.detail).still_broken, null);
        assert.equal(subscriptionPosts().length, 3, 'the changes were made all the same');
    });

    it('writes one audit row with the host and the fields of every object before and after, the outcome of each step, and no token', async () => {
        db.addCreator(TENANT_A, { webhook_verify_token: DB_VERIFY });
        await repairSubscriptions({ userId: '55555555-5555-4555-8555-555555555555', email: 'admin@example.com' });
        assert.equal(db.audit.length, 1);
        const row = db.audit[0]!;
        assert.equal(row.action, AUDIT_ACTIONS.metaWebhooksRepair);
        assert.equal(row.action, 'meta.webhooks_repair');
        assert.deepEqual([row.target_type, row.target_id, row.actor_user_id, row.actor_email], ['app', null, '55555555-5555-4555-8555-555555555555', 'admin@example.com']);
        const detail = JSON.parse(row.detail);
        assert.equal(detail.expected_host, OUR_HOST);
        assert.deepEqual(detail.objects.find((o: any) => o.object === 'instagram'), {
            object: 'instagram', host_before: 'staging.as-systems.tech', host_after: OUR_HOST,
            fields_before: ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'],
            fields_after: ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'], applied: true,
        });
        assert.deepEqual(detail.objects.find((o: any) => o.object === 'whatsapp_business_account').applied, undefined, 'a step that was not taken has no outcome');
        assert.deepEqual(detail.steps, [{ object: 'instagram', ok: true }, { object: 'page', ok: true }, { object: 'user', ok: true }]);
        assert.equal(detail.still_broken, false);
        // nothing in the row is a credential, and the redaction pass leaves the facts as they are
        for (const secret of [APP_SECRET, APP_TOKEN, ENV_VERIFY, DB_VERIFY]) assert.ok(!row.detail.includes(secret));
        assert.deepEqual(redactDetail(detail), detail);
    });

    it('writes the audit row, and logs nothing secret, whatever happens to the steps', async () => {
        meta.fail(/^POST .*\/subscriptions$/, graphError(400, { message: 'refused', code: 100 }), 3);
        await repairSubscriptions(actor);
        assert.equal(db.audit.length, 1);
        assert.deepEqual(JSON.parse(db.audit[0]!.detail).steps.map((s: any) => s.ok), [false, false, false]);
        for (const secret of [APP_SECRET, APP_TOKEN, ENV_VERIFY]) assert.ok(!everywhere().includes(secret));
        assert.ok(logs.some((l) => l.event === 'meta.webhooks_repaired' && l.level === 'info'));
    });
});

describe('repairSubscriptions: the Pages', () => {
    const WANTED = ['feed', 'messages', 'messaging_postbacks', 'messaging_referrals'];
    const tenant = (id: string, pageId: string, token: string, over: Record<string, unknown> = {}) => db.addCreator(id, { facebook_page_id: pageId, page_access_token: encryptSecret(token), ...over });

    beforeEach(() => { meta.subscriptions = healthySubscriptions(); });

    it('does not subscribe a Page again that already lists this app with every field it needs, and leaves a field Meta added alone', async () => {
        tenant(TENANT_A, '200000000000001', PAGE_TOKEN_A);
        meta.pages.set('200000000000001', [...WANTED, 'mention']);
        const out = await repairSubscriptions(actor);
        assert.equal(pagePosts().length, 0, 'a complete Page is not touched: a subscription is replaced by a POST, so touching it could only lose a field');
        assert.deepEqual(out.pages, { checked: 1, resubscribed: 0, failed: 0 });
        assert.deepEqual(meta.pages.get('200000000000001'), [...WANTED, 'mention']);
    });

    it('subscribes a Page again that does not list this app, with the fields a connection subscribes with', async () => {
        tenant(TENANT_A, '200000000000001', PAGE_TOKEN_A);
        const out = await repairSubscriptions(actor);
        assert.equal(pagePosts().length, 1);
        assert.equal(pagePosts()[0]!.url, `https://graph.facebook.com/${API_VERSION}/200000000000001/subscribed_apps`);
        assert.equal(form(pagePosts()[0]!)['subscribed_fields'], WANTED.join(','));
        assert.equal(pagePosts()[0]!.authorization, `Bearer ${PAGE_TOKEN_A}`, 'the Page\'s own token, in the header');
        assert.ok(!pagePosts()[0]!.url.includes(PAGE_TOKEN_A));
        assert.deepEqual(out.pages, { checked: 1, resubscribed: 1, failed: 0 });
    });

    it('subscribes a Page again that lacks a field it needs', async () => {
        tenant(TENANT_A, '200000000000001', PAGE_TOKEN_A);
        meta.pages.set('200000000000001', ['feed', 'messages']);
        const out = await repairSubscriptions(actor);
        assert.equal(out.pages.resubscribed, 1);
        assert.deepEqual(meta.pages.get('200000000000001'), WANTED);
    });

    it('counts leadgen as needed only for a tenant whose lead-ads sign-off stands', async () => {
        tenant(TENANT_A, '200000000000001', PAGE_TOKEN_A);
        tenant(TENANT_B, '200000000000002', PAGE_TOKEN_B);
        meta.pages.set('200000000000001', WANTED);
        meta.pages.set('200000000000002', WANTED);
        db.leadAds.add(TENANT_B);
        const out = await repairSubscriptions(actor);
        assert.deepEqual(out.pages, { checked: 2, resubscribed: 1, failed: 0 }, 'A is complete without leadgen; B is not');
        assert.deepEqual(meta.pages.get('200000000000001'), WANTED);
        assert.deepEqual(meta.pages.get('200000000000002'), [...WANTED, 'leadgen']);
    });

    it('skips a tenant that is switched off or has no Page or no token, and one tenant\'s failure does not stop the next', async () => {
        db.addCreator('33333333-3333-4333-8333-333333333333', { is_active: false, facebook_page_id: '200000000000009', page_access_token: encryptSecret('EAAx0123456789abcdefghijklmnopqrstuv') });
        db.addCreator('44444444-4444-4444-8444-444444444444', { facebook_page_id: null, page_access_token: encryptSecret('EAAy0123456789abcdefghijklmnopqrstuv') });
        db.addCreator('55555555-5555-4555-8555-555555555555', { facebook_page_id: '200000000000008', page_access_token: null });
        tenant(TENANT_A, '200000000000001', PAGE_TOKEN_A);
        tenant(TENANT_B, '200000000000002', PAGE_TOKEN_B);
        meta.fail(/subscribed_apps$/, graphError(400, { message: `Error validating access token ${PAGE_TOKEN_A}`, code: 190 }), 1);
        const out = await repairSubscriptions(actor);
        assert.deepEqual(out.pages, { checked: 2, resubscribed: 1, failed: 1 });
        assert.deepEqual([...meta.pages.keys()], ['200000000000002'], 'the second tenant was subscribed');
        assert.ok(!everywhere([out]).includes(PAGE_TOKEN_A) && !everywhere([out]).includes('REQUEST-CONFIG'), 'a dead Page token is in no log line');
    });

    it('reads no Page at all when the database cannot list them, and still finishes the app-level work', async () => {
        db.failOn = /FROM creators WHERE is_active = true AND page_access_token IS NOT NULL/;
        const out = await repairSubscriptions(actor);
        assert.deepEqual(out.pages, { checked: 0, resubscribed: 0, failed: 0 });
        assert.ok(logs.some((l) => l.event === 'meta.webhooks_pages_unlisted'));
    });
});

// ─── The hourly check ───────────────────────────────────────────────────────────────────

describe('checkMetaWebhooks: at most once an hour', () => {
    it('reads Meta, stores the answer, and reports what it found', async () => {
        const r = await checkMetaWebhooks();
        assert.equal(r.skipped, false);
        assert.equal(r.failure, null);
        assert.equal(r.status!.ok, false);
        assert.equal(meta.calls.length, 1);
        const stored = (await readStatus())!;
        assert.deepEqual([stored.checkedAt, stored.attemptedAt, stored.expectedHost, stored.error], [new Date(NOW).toISOString(), new Date(NOW).toISOString(), OUR_HOST, null]);
        assert.equal(stored.objects.length, 4);
    });

    it('holds a second check back for an hour (from the clock, not from the call), reads again after it, and `force` reads whatever the time', async () => {
        await checkMetaWebhooks();
        assert.equal(meta.calls.length, 1);

        pin(NOW + CHECK_INTERVAL_MS - MINUTE);
        const held = await checkMetaWebhooks();
        assert.equal(held.skipped, true);
        assert.equal(held.status!.ok, false, 'a held-back check still answers with what is stored');
        assert.equal(meta.calls.length, 1, 'nothing asked of Meta');

        pin(NOW + CHECK_INTERVAL_MS + MINUTE);
        assert.equal((await checkMetaWebhooks()).skipped, false);
        assert.equal(meta.calls.length, 2);

        pin(NOW + CHECK_INTERVAL_MS + 2 * MINUTE);
        assert.equal((await checkMetaWebhooks()).skipped, true);
        assert.equal((await checkMetaWebhooks({ force: true })).skipped, false);
        assert.equal(meta.calls.length, 3);
    });

    it('stores `not_configured` quietly, asks Meta nothing, and is held back for an hour like any other check', async () => {
        delete process.env.META_APP_SECRET;
        const r = await checkMetaWebhooks();
        assert.equal(r.failure!.reason, 'not_configured');
        assert.deepEqual((await readStatus())!.error, { code: 'not_configured', message: 'META_APP_ID and META_APP_SECRET must both be set.' });
        assert.equal(meta.calls.length, 0);
        assert.deepEqual(logs.filter((l) => l.level === 'warn' || l.level === 'error'), [], 'a deployment with nothing to check yet is not a warning');
        assert.equal((await checkMetaWebhooks()).skipped, true);
    });

    it('stores no_base_url the same way', async () => {
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        const r = await checkMetaWebhooks();
        assert.equal(r.failure!.reason, 'no_base_url');
        assert.equal(meta.calls.length, 0);
    });

    it('keeps the last answer through a Meta outage and says why, counting the hour from the attempt', async () => {
        await checkMetaWebhooks();
        pin(NOW + CHECK_INTERVAL_MS + MINUTE);
        meta.fail(/^GET /, graphError(500, { message: 'Service unavailable', code: 2 }), 1);
        const r = await checkMetaWebhooks();
        assert.equal(r.failure!.reason, 'graph_failed');
        const stored = (await readStatus())!;
        assert.equal(stored.ok, false, 'what was last seen stands');
        assert.equal(stored.objects.length, 4);
        assert.equal(stored.checkedAt, new Date(NOW).toISOString(), 'Meta last ANSWERED an hour ago');
        assert.equal(stored.attemptedAt, new Date(NOW + CHECK_INTERVAL_MS + MINUTE).toISOString());
        assert.equal(stored.error!.code, 'graph_failed');
        assert.ok(logs.some((l) => l.event === 'meta.webhooks_unanswered' && l.level === 'warn'));
        // not asked again until an hour after the attempt
        pin(NOW + CHECK_INTERVAL_MS + 2 * MINUTE);
        assert.equal((await checkMetaWebhooks()).skipped, true);
    });

    it('never throws: a database that cannot be written is a result', async () => {
        db.failOn = /app_settings/;
        const r = await checkMetaWebhooks();
        assert.deepEqual([r.status, r.skipped, r.failure, r.alerted], [null, false, null, false]);
        assert.ok(logs.some((l) => l.event === 'meta.webhooks_check_error' && l.level === 'error'));
    });

    it('stores a healthy answer as ok, with no problem to summarise', async () => {
        meta.subscriptions = healthySubscriptions();
        await checkMetaWebhooks();
        assert.deepEqual(await readWebhookSummary(), { ok: true, checkedAt: new Date(NOW).toISOString(), problems: [] });
    });

    it('serves the summary the health route reads: the problems, and null before anything was stored', async () => {
        assert.equal(await readWebhookSummary(), null);
        await checkMetaWebhooks();
        const s = (await readWebhookSummary())!;
        assert.equal(s.ok, false);
        assert.deepEqual(s.problems.map((p) => [p.object, p.kind, p.host]), [['instagram', 'elsewhere', 'staging.as-systems.tech']]);
    });
});

describe('checkMetaWebhooks: telling the owner, once a day per problem', () => {
    beforeEach(() => { db.enableEmail(); db.enableTelegram(); });

    it('tells the owner on both channels, in both languages, naming which event type goes where and the link to the card', async () => {
        const r = await checkMetaWebhooks();
        assert.equal(r.alerted, true);
        assert.equal(channels.emails.length, 1);
        assert.equal(channels.telegrams.length, 1);
        const email = channels.emails[0]!;
        assert.deepEqual(email.body.to, ['owner@example.com']);
        assert.equal(email.body.subject, 'AutoReply · Meta is not sending your events to AutoReply');
        assert.ok(email.body.text.startsWith('AutoReply · ميتا لا ترسل أحداثك إلى AutoReply'));
        assert.ok(email.body.text.includes('• Instagram: events go to staging.as-systems.tech, not to AutoReply.'));
        assert.ok(email.body.text.includes(`${OUR_BASE}/dashboard#/settings?s=platform&card=meta-events`));
        assert.equal(channels.telegrams[0]!.body.text, email.body.text);
        assert.equal(channels.telegrams[0]!.body.chat_id, '4242424242');
        // no secret in the words, the log or the stored record
        for (const secret of [APP_SECRET, APP_TOKEN, ENV_VERIFY]) assert.ok(!email.body.text.includes(secret) && !everywhere().includes(secret));
    });

    it('does not tell again for the same problem on the same day, however often it is checked', async () => {
        await checkMetaWebhooks();
        for (let i = 1; i <= 5; i++) {
            pin(NOW + i * (CHECK_INTERVAL_MS + MINUTE));
            const r = await checkMetaWebhooks();
            assert.equal(r.skipped, false);
            assert.equal(r.alerted, false, `check ${i}`);
        }
        assert.equal(channels.emails.length, 1, 'six hourly checks, one email');
        assert.equal(channels.telegrams.length, 1);
    });

    it('tells again the next UTC day, and again for a problem that is new on the same day', async () => {
        await checkMetaWebhooks();
        pin(Date.UTC(2026, 9, 31, 0, 5, 0));
        assert.equal((await checkMetaWebhooks()).alerted, true, 'a new day');
        assert.equal(channels.emails.length, 2);

        pin(Date.UTC(2026, 9, 31, 1, 10, 0));
        meta.subscriptions = [...incidentSubscriptions().slice(0, 1), ...healthySubscriptions().slice(1)];
        meta.subscriptions[1]!.active = false;
        const r = await checkMetaWebhooks();
        assert.equal(r.alerted, true, 'page switched off is a problem not told about today');
        const text = channels.emails[2]!.body.text as string;
        assert.ok(text.includes('• Facebook: the subscription is switched off in Meta.') && text.includes('• Instagram: events go to staging.as-systems.tech'), 'one message lists every problem that stands');
    });

    it('does not use the day up when nothing could be sent: it is tried again at the next check, and the day is spent only once it went', async () => {
        db.settings.delete(APP_SETTING_KEYS.notifyEmailEnabled);
        db.settings.delete(APP_SETTING_KEYS.notifyTelegramEnabled);
        assert.equal((await checkMetaWebhooks()).alerted, false, 'no channel is on');
        assert.equal(channels.emails.length + channels.telegrams.length, 0);
        assert.equal(db.get(APP_SETTING_KEYS.metaWebhooksAlerted), undefined);

        db.set(APP_SETTING_KEYS.notifyEmailEnabled, 'true');
        channels.failEmail = true;
        pin(NOW + CHECK_INTERVAL_MS + MINUTE);
        assert.equal((await checkMetaWebhooks()).alerted, false, 'the send was refused');
        assert.equal(db.get(APP_SETTING_KEYS.metaWebhooksAlerted), undefined);
        assert.ok(logs.some((l) => l.event === 'meta.webhooks_alert_email_failed'));

        channels.failEmail = false;
        pin(NOW + 2 * (CHECK_INTERVAL_MS + MINUTE));
        assert.equal((await checkMetaWebhooks()).alerted, true);
        assert.deepEqual(JSON.parse(db.get(APP_SETTING_KEYS.metaWebhooksAlerted)!), { day: '2026-10-30', keys: ['instagram:elsewhere:staging.as-systems.tech'] });
    });

    it('counts a day told if either channel got it', async () => {
        channels.failTelegram = true;
        assert.equal((await checkMetaWebhooks()).alerted, true);
        assert.equal(channels.emails.length, 1);
    });

    it('says nothing when nothing is wrong, and nothing about a warning', async () => {
        meta.subscriptions = [...healthySubscriptions(), { object: 'user', callback_url: OTHER_SITE, active: true, fields: [] }];
        meta.subscriptions[1]!.fields = meta.subscriptions[1]!.fields.filter((f) => f.name !== 'messaging_referrals');
        const r = await checkMetaWebhooks();
        assert.equal(r.status!.ok, true);
        assert.equal(r.alerted, false);
        assert.equal(channels.emails.length + channels.telegrams.length, 0);
    });

    it('does not alert from a check that could not read Meta', async () => {
        meta.fail(/^GET /, graphError(500, { message: 'down', code: 2 }), 1);
        assert.equal((await checkMetaWebhooks()).alerted, false);
        assert.equal(channels.emails.length, 0);
    });

    it('never lets an alert that fails fail the check', async () => {
        db.failOn = /WHERE key = ANY/;
        const r = await checkMetaWebhooks();
        assert.equal(r.status!.ok, false);
        assert.equal(r.alerted, false);
        assert.ok(logs.some((l) => l.event === 'meta.webhooks_alert_failed'));
    });
});

// ─── Where the last events went ─────────────────────────────────────────────────────────

describe('readLastEvents: the newest delivery per platform, for one tenant', () => {
    const job = (tenant_key: string | null, at: string, kind = 'comment.process') => db.jobs.push({ kind, tenant_key, created_at: new Date(at) });

    it('keeps the platforms apart: an Instagram account id, a Page id and a WhatsApp number each have their own', async () => {
        db.addCreator(TENANT_A, { instagram_page_id: '17841400000000001', facebook_page_id: '200000000000001' });
        db.whatsapp.set(TENANT_A, { phone_number_id: '109000000000001', waba_id: '300000000000001' });
        job('17841400000000001', '2026-10-30T09:00:00Z');
        job('17841400000000001', '2026-10-30T10:30:00Z', 'dm.process');
        job('200000000000001', '2026-10-30T11:00:00Z');
        job('109000000000001', '2026-10-30T08:00:00Z', 'dm.process');
        job('300000000000001', '2026-10-30T08:30:00Z', 'wa.event');
        assert.deepEqual(await readLastEvents(TENANT_A), { instagram: '2026-10-30T10:30:00.000Z', facebook: '2026-10-30T11:00:00.000Z', whatsapp: '2026-10-30T08:30:00.000Z' });
    });

    it('is null for a platform nothing has arrived on, and never shows another tenant\'s deliveries or a job that is not a delivery', async () => {
        db.addCreator(TENANT_A, { instagram_page_id: '17841400000000001', facebook_page_id: '200000000000001' });
        db.addCreator(TENANT_B, { instagram_page_id: '17841400000000002', facebook_page_id: '200000000000002' });
        job('17841400000000002', '2026-10-30T11:00:00Z');
        job('200000000000002', '2026-10-30T11:00:00Z');
        job('17841400000000001', '2026-10-30T11:30:00Z', 'dm.followup');
        job(null, '2026-10-30T11:45:00Z');
        assert.deepEqual(await readLastEvents(TENANT_A), { instagram: null, facebook: null, whatsapp: null });
    });

    it('answers with nulls and no query for jobs when the tenant has no id at all, and null for a tenant that does not exist', async () => {
        db.addCreator(TENANT_A);
        assert.deepEqual(await readLastEvents(TENANT_A), { instagram: null, facebook: null, whatsapp: null });
        assert.equal(db.statements.some((s) => /FROM jobs/.test(s.sql)), false);
        assert.equal(await readLastEvents(TENANT_B), null);
    });

    it('still answers for Instagram and Facebook when WhatsApp\'s table is not there', async () => {
        db.addCreator(TENANT_A, { instagram_page_id: '17841400000000001' });
        job('17841400000000001', '2026-10-30T10:00:00Z');
        db.failOn = /platform_connections/;
        assert.deepEqual(await readLastEvents(TENANT_A), { instagram: '2026-10-30T10:00:00.000Z', facebook: null, whatsapp: null });
    });
});

describe('constants', () => {
    it('holds a check back for an hour and gives the write thirty seconds', () => {
        assert.equal(CHECK_INTERVAL_MS, HOUR);
        assert.equal(REPAIR_TIMEOUT_MS, 30_000);
    });
});
