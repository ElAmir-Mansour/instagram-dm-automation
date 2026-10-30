/**
 * "Where Meta sends your events" on the dashboard: the Settings card, the question before the button, and the notice on Today and the Inbox.
 *
 * The REAL `meta_connect.js`, `admin_common.js`, `overview.js`, `inbox.js` and `settings.js` run in the shared `node:vm` harness, in both languages, against the
 * answers `GET /api/meta/webhooks` and `GET /api/health/tenant` give (the 2026-10-30 state: `instagram` and a field-less `user` at another project's site, nothing else
 * wrong). What is pinned, because each is a way the owner is hurt rather than helped:
 *
 *   - **The card says where each kind goes**: AutoReply, another website (named), switched off, missing events, not subscribed; the events it carries, a warning for what is
 *     missing, and when an event of that kind last reached THIS workspace. What is only a warning is amber, what stops the product is red, and a kind Meta has no subscription
 *     for at all is a row of its own.
 *   - **One button, and it asks first.** It says "Send everything to AutoReply" while there is something to do and is disabled, saying so, when there is not. Pressing it reads
 *     Meta once more and opens a question that lists exactly what will change; nothing is sent until the answer is yes; a refusal that comes before anything is sent stays in the
 *     dialog; a step Meta refused is shown beside its object, with Meta's own words, as text.
 *   - **A notice only for a definite "no".** `ok: false` with something to name raises it (Today's alert, the Inbox's strip); `ok: null` (never answered), `ok: true`, a missing
 *     field and a failed request say nothing. The platform admin is sent to the card; everyone else is told whom to ask and is offered no button.
 *   - **Everything from Meta is text.** A host, an object name, a field and a refusal reach the page escaped, in every state, in both languages.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const FILES = [
    'dashboard/js/pages/admin_common.js', 'dashboard/js/pages/meta_connect.js', 'dashboard/js/pages/overview.js',
    'dashboard/js/pages/inbox.js', 'dashboard/js/pages/settings.js',
];

const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
const QUOTE_BREAK = '"><script>alert(1)</script><x y="';

/** Markup as the words a person reads: tags gone, entities decoded, the bidi isolates that keep Latin text in place dropped. */
const words = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/[⁦⁩]/g, '').replace(/\s+/g, ' ').trim();

const HOURS_AGO = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();

const callback = 'https://msg-response-auto.vercel.app/webhook';
const IG_FIELDS = ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'];

/** `GET /api/meta/webhooks` for the 2026-10-30 state. */
const incident = (over: Json = {}): Json => ({
    checkedAt: new Date(Date.now() - 20_000).toISOString(), ok: false, expected: { url: callback, host: 'msg-response-auto.vercel.app' },
    objects: [
        { object: 'instagram', host: 'staging.as-systems.tech', ours: false, active: true, fields: IG_FIELDS, version: 'v25.0', carriesEvents: true, missingRequired: [] },
        { object: 'whatsapp_business_account', host: 'msg-response-auto.vercel.app', ours: true, active: true, fields: ['messages', 'account_update'], version: 'v26.0', carriesEvents: true, missingRequired: [] },
        { object: 'page', host: 'msg-response-auto.vercel.app', ours: true, active: true, fields: ['feed', 'messages', 'messaging_postbacks'], version: 'v25.0', carriesEvents: true, missingRequired: ['messaging_referrals'] },
        { object: 'user', host: 'staging.as-systems.tech', ours: false, active: true, fields: [], version: null, carriesEvents: false, missingRequired: [] },
    ],
    problems: [{ object: 'instagram', host: 'staging.as-systems.tech', kind: 'elsewhere', fields: IG_FIELDS }],
    plan: [
        { object: 'instagram', kind: 'elsewhere', fromHost: 'staging.as-systems.tech', callbackUrl: callback, fields: IG_FIELDS, addedFields: [], version: 'v25.0' },
        { object: 'page', kind: 'missing_field', fromHost: 'msg-response-auto.vercel.app', callbackUrl: callback, fields: ['feed', 'messages', 'messaging_postbacks', 'messaging_referrals'], addedFields: ['messaging_referrals'], version: 'v25.0' },
        { object: 'user', kind: 'elsewhere', fromHost: 'staging.as-systems.tech', callbackUrl: callback, fields: [], addedFields: [], version: 'v26.0' },
    ],
    lastEvents: { instagram: HOURS_AGO(52), facebook: HOURS_AGO(1), whatsapp: null },
    ...over,
});

const FINE = (): Json => incident({
    ok: true, problems: [], plan: [],
    objects: [
        { object: 'instagram', host: 'msg-response-auto.vercel.app', ours: true, active: true, fields: IG_FIELDS, version: 'v25.0', carriesEvents: true, missingRequired: [] },
        { object: 'page', host: 'msg-response-auto.vercel.app', ours: true, active: true, fields: ['feed', 'messages', 'messaging_postbacks', 'messaging_referrals'], version: 'v25.0', carriesEvents: true, missingRequired: [] },
    ],
});

/** `GET /api/health/tenant`'s `webhooks`: what the hourly check last stored. */
const SUMMARY_BROKEN: Json = { ok: false, checkedAt: '2026-10-30T12:00:00.000Z', problems: [{ object: 'instagram', host: 'staging.as-systems.tech', kind: 'elsewhere', fields: IG_FIELDS }] };

interface World {
    h: ReturnType<typeof loadDashboard>;
    MC: Json; HS: Json; OV: Json; IB: Json; ST: Json; UI: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    calls: Array<{ fn: string; args: any[] }>;
    toasts: Array<{ message: string; type: string }>;
    confirms: Json[];
    repaints: { count: number };
}

function load(lang: 'ar' | 'en' = 'en', opts: { admin?: boolean; api?: Record<string, (...a: any[]) => any> } = {}): World {
    const admin = opts.admin !== false;
    const calls: World['calls'] = [];
    const overrides = opts.api ?? {};
    const api = new Proxy({ token: 't' } as Json, {
        get: (target, prop: string) => (prop in target ? target[prop] : (...args: any[]) => {
            calls.push({ fn: prop, args });
            return overrides[prop] ? overrides[prop]!(...args) : Promise.reject(new Error(`API.${prop} is not stubbed`));
        }),
    });
    const h = loadDashboard({
        lang, files: FILES,
        globals: {
            API: api,
            App: {
                isAdmin: () => admin, canAdminister: () => true, canOperate: () => true, hashParam: () => '', hashParams: () => ({}),
                route: (page: string, params: Record<string, string> = {}) => `#/${page}?${new URLSearchParams(params)}`,
                currentTheme: () => 'auto', loadPageModule: async () => null, setInboxWaiting: () => undefined,
            },
        },
    });
    const toasts: World['toasts'] = [];
    const confirms: Json[] = [];
    const repaints = { count: 0 };
    const UI = h.UI as Json;
    UI.toast = (message: string, type = 'success') => { toasts.push({ message, type }); };
    UI.confirm = (options: Json) => { confirms.push(options); };
    UI.actionBusy = () => () => undefined;
    const MC = h.run<Json>('MetaConnect');
    MC.afterChange = async () => { repaints.count++; };
    return { h, MC, HS: h.run<Json>('HealthStrip'), OV: h.run<Json>('OverviewPage'), IB: h.run<Json>('InboxPage'), ST: h.run<Json>('SettingsPage'), UI, t: h.t, calls, toasts, confirms, repaints };
}

const rowOf = (rows: Json[], object: string): Json => rows.find((r) => r.object === object)!;
const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

// ─── The card's rows ────────────────────────────────────────────────────────────────────

describe('the card: one row per Meta object, saying where it goes', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`reads the 2026-10-30 state: instagram is red and names the other website, page is fine with a warning, WhatsApp is fine, user is a mild warning (${lang})`, () => {
            const { MC, t } = load(lang);
            const rows: Json[] = MC.eventRows(incident());
            assert.deepEqual(rows.map((r) => r.object), ['instagram', 'whatsapp_business_account', 'page', 'user']);

            const ig = rowOf(rows, 'instagram');
            assert.deepEqual([ig.tone, ig.glyph], ['danger', '✕']);
            assert.equal(words(ig.label), words(t('meta.events.state.elsewhere', { host: 'staging.as-systems.tech' })));
            assert.ok(words(ig.label).includes('staging.as-systems.tech'));
            assert.ok(ig.lines.some((l: Json) => words(l.text) === words(t('meta.events.fields', { fields: IG_FIELDS.join(', ') }))), 'the five events it carries');

            const page = rowOf(rows, 'page');
            assert.deepEqual([page.tone, page.glyph, words(page.label)], ['success', '✓', 'AutoReply']);
            const warning = page.lines.find((l: Json) => l.warn);
            assert.equal(words(warning.text), words(t('meta.events.missingFields', { fields: 'messaging_referrals' })), 'a missing optional event is a warning line, not a red row');

            assert.equal(rowOf(rows, 'whatsapp_business_account').tone, 'success');

            const user = rowOf(rows, 'user');
            assert.deepEqual([user.tone, user.glyph], ['warning', '▲'], 'a kind with no events pointing elsewhere is amber, not red');
            assert.ok(user.lines.some((l: Json) => words(l.text) === words(t('meta.events.noFields'))));
        });
    }

    it('names each object the way a person knows it, and any other as Meta spells it, never as a property of a prototype', () => {
        const { MC } = load('en');
        assert.deepEqual(['instagram', 'page', 'whatsapp_business_account'].map((o) => words(MC.eventObjectName(o))), ['Instagram', 'Facebook Page', 'WhatsApp']);
        assert.equal(words(MC.eventObjectName('permissions')), 'permissions');
        assert.equal(MC.knownEventObject('constructor'), false);
        assert.equal(MC.knownEventObject('__proto__'), false);
        assert.equal(words(MC.eventObjectName('constructor')), 'constructor');
    });

    it('says when an event of each kind last reached THIS workspace, and that none has when none has', () => {
        const { MC, UI } = load('en');
        const rows: Json[] = MC.eventRows(incident());
        const last = (o: string) => rowOf(rows, o).lines.map((l: Json) => words(l.text)).find((l: string) => /event/i.test(l) && /workspace/i.test(l));
        assert.equal(last('instagram'), `Last event for this workspace: ${UI.relativeAge(HOURS_AGO(52)).text}`);
        assert.ok(last('page')!.startsWith('Last event for this workspace:'));
        assert.equal(last('whatsapp_business_account'), 'No event has reached this workspace yet.');
        assert.equal(rowOf(rows, 'user').lines.some((l: Json) => /workspace/.test(words(l.text))), false, 'a kind nobody has a name for has no "last event"');
    });

    it('shows a required kind Meta has no subscription for as a row of its own, red', () => {
        const { MC, t } = load('en');
        const rows: Json[] = MC.eventRows(incident({ objects: [incident().objects[2]], problems: [{ object: 'instagram', host: null, kind: 'missing_object', fields: ['comments', 'messages'] }] }));
        const ig = rowOf(rows, 'instagram');
        assert.deepEqual([ig.tone, ig.glyph, words(ig.label)], ['danger', '✕', words(t('meta.events.state.notSubscribed'))]);
        assert.ok(ig.lines.some((l: Json) => l.warn && words(l.text) === words(t('meta.events.notSubscribedHint'))));
    });

    it('says an object that is switched off, and one that lacks a needed event, in red, and one that is off but carries nothing in amber', () => {
        const { MC, t } = load('en');
        const base = FINE();
        const off = MC.eventRows({ ...base, objects: [{ ...base.objects[0], active: false }, base.objects[1]], problems: [{ object: 'instagram', host: 'msg-response-auto.vercel.app', kind: 'inactive', fields: IG_FIELDS }] });
        assert.deepEqual([off[0].tone, words(off[0].label)], ['danger', 'Switched off']);
        const missing = MC.eventRows({ ...base, objects: [{ ...base.objects[0], fields: ['messages'], missingRequired: ['comments'] }, base.objects[1]], problems: [{ object: 'instagram', host: 'msg-response-auto.vercel.app', kind: 'missing_field', fields: ['comments'] }] });
        assert.deepEqual([missing[0].tone, words(missing[0].label)], ['danger', 'Missing events']);
        assert.ok(missing[0].lines.some((l: Json) => l.warn && words(l.text) === words(t('meta.events.missingCritical', { fields: 'comments' }))));
        const quiet = MC.eventRows({ ...base, objects: [base.objects[0], { object: 'user', host: 'msg-response-auto.vercel.app', ours: true, active: false, fields: [], version: null, carriesEvents: false, missingRequired: [] }] });
        assert.deepEqual([quiet[1].tone, words(quiet[1].label)], ['warning', 'Switched off']);
    });
});

describe('the card: the block', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`has the address, the rows, the button that says what it will do, and Check again (${lang})`, () => {
            const { MC, t, UI } = load(lang);
            const data = incident();
            const markup = String(MC.eventsBlock(data, null));
            const text = words(markup);
            assert.ok(text.includes(t('meta.events.intro')));
            assert.ok(markup.includes(callback), 'AutoReply\'s address, to copy');
            assert.ok(markup.includes('href="#/help/connect-meta#events-destination"'), 'the help link');
            assert.ok(text.includes(words(t('webhooks.banner.title'))), 'a red line says it before the rows');
            const fix = /<button([^>]*id="meta-events-fix"[^>]*)>([\s\S]*?)<\/button>/.exec(markup)!;
            assert.ok(fix, 'the button');
            assert.match(fix[1]!, /data-action="metaconnect:askRepair"/);
            assert.equal(/\sdisabled/.test(fix[1]!), false, 'there is something to do, so it can be pressed');
            assert.equal(words(fix[2]), t('meta.events.fix'), 'it says what it will do');
            assert.match(markup, /data-action="metaconnect:recheck"/);
            assert.ok(text.includes(t('meta.events.checked', { when: UI.relativeAge(data.checkedAt).text })), 'when Meta was read');
            assert.equal(/meta\.events\.|webhooks\./.test(text), false, 'no raw key');
        });

        it(`disables the button, and says so, when there is nothing to do (${lang})`, () => {
            const { MC, t } = load(lang);
            const markup = String(MC.eventsBlock(FINE(), null));
            const fix = /<button([^>]*id="meta-events-fix"[^>]*)>([\s\S]*?)<\/button>/.exec(markup)!;
            assert.match(fix[1]!, /\sdisabled/);
            assert.equal(words(fix[2]), t('meta.events.allGood'), 'the disabled button says why');
            assert.equal(words(markup).includes(t('meta.events.fix')), false);
            assert.equal(words(markup).includes(words(t('webhooks.banner.title'))), false, 'no red line when nothing is wrong');
        });

        it(`is an error with Retry when Meta could not be read, in words for the code, and nothing at all with no answer (${lang})`, () => {
            const { MC, t } = load(lang);
            for (const code of ['NOT_CONFIGURED', 'NO_BASE_URL', 'NO_VERIFY_TOKEN', 'GRAPH_FAILED']) {
                const markup = String(MC.eventsBlock(null, Object.assign(new Error('server english'), { status: 409, body: { code } })));
                assert.ok(words(markup).includes(t(`meta.events.error.${code.toLowerCase()}`)), code);
                assert.match(markup, /role="alert"/);
                assert.match(markup, /id="meta-events-recheck"/);
                assert.equal(words(markup).includes('server english') && code !== 'GRAPH_FAILED', false, 'the server\'s English is not printed where a sentence exists');
            }
            assert.ok(words(MC.eventsBlock(null, Object.assign(new Error('boom'), { status: 500 }))).includes('boom'), 'an error with no code says what the server said');
            assert.equal(String(MC.eventsBlock(null, null)), '');
        });
    }

    it('escapes everything that came from Meta, in every part of the card', () => {
        const { MC } = load('en');
        const hostile = incident({
            expected: { url: `https://x.test/${QUOTE_BREAK}`, host: 'x.test' },
            objects: [
                { object: PAYLOAD, host: PAYLOAD, ours: false, active: true, fields: [PAYLOAD, QUOTE_BREAK], version: null, carriesEvents: true, missingRequired: [PAYLOAD] },
                { object: QUOTE_BREAK, host: QUOTE_BREAK, ours: false, active: true, fields: [], version: null, carriesEvents: false, missingRequired: [] },
            ],
            problems: [{ object: PAYLOAD, host: PAYLOAD, kind: 'elsewhere', fields: [PAYLOAD] }],
        });
        MC._eventsResult = { steps: [{ object: PAYLOAD, ok: false, error: PAYLOAD }], pages: { failed: 1, resubscribed: 0 }, confirmed: false };
        const markup = String(MC.eventsBlock(hostile, null));
        assert.equal(markup.includes('<img'), false);
        assert.equal(markup.includes('<script'), false);
        assert.equal(/\sonerror=/.test(markup.replace(/&lt;[^>]*&gt;/g, '')), false);
        assert.ok(markup.includes('&lt;img'), 'it is there, as text');
    });

    it('shows what the last repair left to say: Meta\'s refusal beside its object, whether it could be read back, and the Pages', () => {
        const { MC, t } = load('en');
        MC._eventsResult = { steps: [{ object: 'instagram', ok: false, error: 'Callback verification failed' }, { object: 'page', ok: true }], pages: { failed: 2, resubscribed: 1 }, confirmed: false };
        const text = words(MC.eventsResultMarkup(MC._eventsResult));
        assert.ok(text.includes(t('meta.events.donePartial')));
        assert.ok(text.includes('Instagram: Callback verification failed'));
        assert.ok(text.includes(t('meta.events.unconfirmed')));
        assert.ok(text.includes(t('meta.events.pagesFailed', { count: 2 })) && text.includes(t('meta.events.pagesResubscribed', { count: 1 })));
        assert.equal(words(MC.eventsResultMarkup({ steps: [{ object: 'instagram', ok: true }], pages: { failed: 0, resubscribed: 0 }, confirmed: true })), '', 'a clean repair leaves nothing to say here');
        assert.equal(MC.eventsResultMarkup(null), '');
    });
});

// ─── The button, and the question before it ────────────────────────────────────────────

describe('the button asks first, and lists exactly what will change', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`reads Meta again, then opens a question with one line per step; nothing is sent until the answer is yes (${lang})`, async () => {
            const w = load(lang, { api: { getMetaWebhooks: async () => incident(), repairMetaWebhooks: async () => ({ steps: [], ok: true }) } });
            await w.MC.askRepair({ disabled: false });
            assert.deepEqual(w.calls.map((c) => c.fn), ['getMetaWebhooks'], 'it reads, and sends nothing');
            assert.equal(w.confirms.length, 1);
            const q = w.confirms[0]!;
            assert.equal(q.title, w.t('meta.events.confirmTitle'));
            assert.equal(q.confirmLabel, w.t('meta.events.fix'));
            assert.equal(q.tone, 'primary', 'it is consequential, not destructive');
            assert.equal(q.hint, w.t('meta.events.confirmHint'));
            const body = words(q.body);
            assert.ok(body.startsWith(w.t('meta.events.confirmBody')));
            const step = (kind: string, params: Record<string, string>) => `• ${words(w.t(`meta.events.step.${kind}`, params))}`;
            assert.ok(body.includes(step('elsewhere', { object: w.t('meta.events.object.instagram'), host: 'staging.as-systems.tech' })), 'instagram: from the other website to AutoReply');
            assert.ok(body.includes(step('missing_field', { object: w.t('meta.events.object.page'), fields: 'messaging_referrals' })), 'page: the one event it lacks');
            assert.ok(body.includes(step('elsewhere', { object: 'user', host: 'staging.as-systems.tech' })), 'user: back too, named as Meta spells it');
            assert.equal(body.includes('whatsapp') || body.includes(w.t('meta.events.object.whatsapp')), false, 'WhatsApp was fine, so it is not in the list');
            assert.equal(w.calls.filter((c) => c.fn === 'repairMetaWebhooks').length, 0, 'not a request has been sent');
        });
    }

    it('sends, on yes, one repair with no body of its own, toasts success, and repaints from what Meta says now', async () => {
        const w = load('en', { api: { getMetaWebhooks: async () => incident(), repairMetaWebhooks: async () => ({ success: true, ok: true, confirmed: true, steps: [{ object: 'instagram', ok: true }, { object: 'page', ok: true }, { object: 'user', ok: true }], pages: { checked: 1, resubscribed: 0, failed: 0 } }) } });
        await w.MC.askRepair({ disabled: false });
        await w.confirms[0]!.onConfirm();
        assert.deepEqual(w.calls.map((c) => c.fn), ['getMetaWebhooks', 'repairMetaWebhooks']);
        assert.deepEqual(w.calls[1]!.args, []);
        assert.deepEqual(w.toasts, [{ message: w.t('meta.events.done'), type: 'success' }]);
        assert.equal(w.repaints.count, 1);
    });

    it('says it did not all go through when a step was refused or could not be read back, and keeps what Meta said for the card', async () => {
        const refused = { success: true, ok: false, confirmed: true, steps: [{ object: 'instagram', ok: false, error: 'Callback verification failed' }, { object: 'page', ok: true }], pages: { checked: 0, resubscribed: 0, failed: 0 } };
        const w = load('en', { api: { getMetaWebhooks: async () => incident(), repairMetaWebhooks: async () => refused } });
        await w.MC.askRepair({ disabled: false });
        await w.confirms[0]!.onConfirm();
        assert.deepEqual(w.toasts, [{ message: w.t('meta.events.donePartial'), type: 'error' }]);
        assert.equal(w.repaints.count, 1);
        assert.ok(words(w.MC.eventsResultMarkup(w.MC._eventsResult)).includes('Instagram: Callback verification failed'));
        // Meta said yes to everything and the read-back disagrees: also not "done"
        const w2 = load('en', { api: { getMetaWebhooks: async () => incident(), repairMetaWebhooks: async () => ({ ok: true, confirmed: false, steps: [{ object: 'instagram', ok: true }], pages: {} }) } });
        await w2.MC.askRepair({ disabled: false });
        await w2.confirms[0]!.onConfirm();
        assert.deepEqual(w2.toasts.map((x) => x.type), ['error']);
    });

    it('keeps the question open, with the sentence for the reason, when the server refuses before sending anything', async () => {
        for (const [code, key] of [['NO_VERIFY_TOKEN', 'no_verify_token'], ['NOT_CONFIGURED', 'not_configured'], ['NO_BASE_URL', 'no_base_url'], ['GRAPH_FAILED', 'graph_failed']] as const) {
            const w = load('en', { api: { getMetaWebhooks: async () => incident(), repairMetaWebhooks: async () => { throw Object.assign(new Error('server english'), { status: code === 'GRAPH_FAILED' ? 502 : 409, body: { code } }); } } });
            await w.MC.askRepair({ disabled: false });
            await assert.rejects(w.confirms[0]!.onConfirm(), (err: Error) => words(err.message).startsWith(w.t(`meta.events.error.${key}`)), code);
            assert.equal(w.repaints.count, 0, 'nothing changed, so nothing repaints');
            assert.deepEqual(w.toasts, []);
        }
    });

    it('says there is nothing to do, and repaints, when Meta turns out to be fine by the time it is asked', async () => {
        const w = load('en', { api: { getMetaWebhooks: async () => FINE() } });
        await w.MC.askRepair({ disabled: false });
        assert.equal(w.confirms.length, 0);
        assert.deepEqual(w.toasts, [{ message: w.t('meta.events.allGood'), type: 'success' }]);
        assert.equal(w.repaints.count, 1);
    });

    it('opens no question, and says why, when Meta cannot be read; and ignores a press on a disabled button', async () => {
        const w = load('en', { api: { getMetaWebhooks: async () => { throw Object.assign(new Error('x'), { status: 409, body: { code: 'NOT_CONFIGURED' } }); } } });
        await w.MC.askRepair({ disabled: false });
        assert.equal(w.confirms.length, 0);
        assert.deepEqual(w.toasts, [{ message: w.t('meta.events.error.not_configured'), type: 'error' }]);
        await w.MC.askRepair({ disabled: true });
        await w.MC.askRepair(null);
        assert.equal(w.calls.length, 1);
    });

    it('lists the steps as text: nothing Meta wrote can become markup in the question', async () => {
        const hostile = incident({ plan: [{ object: PAYLOAD, kind: 'elsewhere', fromHost: QUOTE_BREAK, callbackUrl: callback, fields: [PAYLOAD], addedFields: [], version: 'v25.0' }] });
        const w = load('en', { api: { getMetaWebhooks: async () => hostile } });
        await w.MC.askRepair({ disabled: false });
        const body = String(w.confirms[0]!.body);
        assert.equal(body.includes('<img'), false);
        assert.equal(body.includes('<script'), false);
        assert.ok(body.includes('&lt;img'));
    });

    it('forgets the last result on Check again, and repaints (which reads Meta again)', async () => {
        const w = load('en');
        w.MC._eventsResult = { steps: [], pages: null, confirmed: true };
        await w.MC.recheck({ disabled: false });
        assert.equal(w.MC._eventsResult, null);
        assert.equal(w.repaints.count, 1);
    });
});

// ─── The notice ─────────────────────────────────────────────────────────────────────────

describe('HealthStrip.webhookNotice: a notice only for a definite "no"', () => {
    it('says nothing for what is not a verdict: no answer, never answered, fine, a field the server does not send, nothing to name', () => {
        const { HS } = load('en');
        const named = SUMMARY_BROKEN.problems;
        for (const webhooks of [
            undefined, null, {}, { ok: null, checkedAt: null, problems: [] }, { ok: true, checkedAt: 'x', problems: [] }, { ok: false, problems: [] }, { ok: false }, { ok: false, problems: 'x' }, 'broken', 5, [],
            // Something to name is not enough: only the check's own word, a definite `ok: false`, makes it a notice.
            { ok: null, checkedAt: null, problems: named }, { ok: true, checkedAt: 'x', problems: named }, { checkedAt: 'x', problems: named }, { ok: 'false', problems: named },
        ]) {
            assert.equal(HS.webhookNotice(webhooks), null, JSON.stringify(webhooks));
        }
    });

    it('says which kind goes where, and what AutoReply therefore cannot answer, in English', () => {
        const { HS } = load('en');
        const n = plain<{ title: string; lines: string[] }>(HS.webhookNotice(SUMMARY_BROKEN));
        assert.equal(words(n.title), 'Meta isn’t sending your events to AutoReply');
        assert.deepEqual(n.lines.map(words), ['Instagram events are going to another website (staging.as-systems.tech), so AutoReply isn’t answering Instagram.']);
    });

    it('says it in Arabic, with the host kept in place by its isolates', () => {
        const { HS } = load('ar');
        const n = plain<{ title: string; lines: string[] }>(HS.webhookNotice(SUMMARY_BROKEN));
        assert.equal(n.title, 'ميتا لا ترسل أحداثك إلى AutoReply');
        assert.equal(words(n.lines[0]), 'أحداث إنستجرام تذهب إلى موقع آخر (staging.as-systems.tech)، فلا يرد AutoReply على إنستجرام.');
        assert.ok(n.lines[0]!.includes('⁦staging.as-systems.tech⁩'), 'the Latin host is isolated');
    });

    it('has a sentence for every kind of problem, and for an object nobody has a name for', () => {
        const { HS } = load('en');
        const lines = (problems: Json[]) => (plain<{ lines: string[] }>(HS.webhookNotice({ ok: false, problems })).lines).map(words);
        assert.deepEqual(lines([{ object: 'page', host: 'x.test', kind: 'inactive', fields: ['feed'] }]), ['Facebook events are switched off in Meta, so AutoReply isn’t answering Facebook.']);
        assert.deepEqual(lines([{ object: 'instagram', host: null, kind: 'missing_object', fields: ['comments', 'messages'] }]), ['Meta has no Instagram subscription for AutoReply, so AutoReply isn’t answering Instagram.']);
        assert.deepEqual(lines([{ object: 'instagram', host: 'x.test', kind: 'missing_field', fields: ['comments'] }]), ['Meta isn’t sending Instagram comments, so AutoReply isn’t answering those.']);
        assert.deepEqual(lines([{ object: 'whatsapp_business_account', host: 'x.test', kind: 'elsewhere', fields: ['messages'] }]), ['WhatsApp events are going to another website (x.test), so AutoReply isn’t answering WhatsApp.']);
        assert.deepEqual(lines([{ object: 'permissions', host: 'x.test', kind: 'elsewhere', fields: ['x'] }]), ['Events of type “permissions” are going to another website (x.test).']);
        assert.deepEqual(lines([{ object: 'permissions', host: 'x.test', kind: 'inactive', fields: ['x'] }]), ['Events of type “permissions” are switched off in Meta.']);
        assert.deepEqual(lines([{ object: 'instagram', host: 'x.test', kind: 'something-new', fields: [] }]), ['Instagram events are going to another website (x.test), so AutoReply isn’t answering Instagram.'], 'a kind this dashboard does not know reads as the commonest');
        assert.equal(lines([{ object: 'instagram', host: 'a.test', kind: 'elsewhere', fields: [] }, { object: 'page', host: 'b.test', kind: 'elsewhere', fields: [] }]).length, 2, 'one sentence per problem');
    });

    it('puts what Meta wrote in the sentence as text', () => {
        const { HS } = load('en');
        const n = plain<{ lines: string[] }>(HS.webhookNotice({ ok: false, problems: [{ object: PAYLOAD, host: QUOTE_BREAK, kind: 'elsewhere', fields: [PAYLOAD] }] }));
        // a plain string: it is escaped by whoever draws it (`html`), which the screens below check
        assert.ok(n.lines[0]!.includes(PAYLOAD));
        assert.equal(typeof n.lines[0], 'string');
    });
});

describe('Today: the alert', () => {
    const ok = (value: unknown) => ({ status: 'fulfilled', value });
    const alerts = (w: World, health: unknown) => plain<Json[]>(w.OV.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), ok({ data: [] }), ok([]), ok(null), health));
    const webhookAlert = (list: Json[]) => list.find((a) => a.icon === 'plug-zap');

    for (const lang of ['en', 'ar'] as const) {
        it(`raises a danger alert for a stored "no", and sends the platform admin to the card that fixes it (${lang})`, () => {
            const w = load(lang, { admin: true });
            const a = webhookAlert(alerts(w, ok({ webhooks: SUMMARY_BROKEN })))!;
            assert.ok(a, 'an alert');
            assert.equal(a.level, 'danger');
            assert.equal(a.title, w.t('webhooks.banner.title'));
            assert.equal(words(a.body), words(plain<{ lines: string[] }>(w.HS.webhookNotice(SUMMARY_BROKEN)).lines.join(' ')));
            assert.deepEqual([a.action, a.target, a.query], [w.t('webhooks.banner.fix'), 'settings', 's=platform&card=meta-events']);
        });

        it(`tells everyone else whom to ask, and offers them no button (${lang})`, () => {
            const w = load(lang, { admin: false });
            const a = webhookAlert(alerts(w, ok({ webhooks: SUMMARY_BROKEN })))!;
            assert.ok(words(a.body).endsWith(words(w.t('webhooks.banner.askOwner'))));
            assert.deepEqual([a.action, a.target], ['', '']);
            const markup = String(w.OV.renderBriefing([a], new Date()));
            assert.ok(words(markup).includes(words(a.title)));
            assert.equal(markup.includes('data-target='), false, 'no link that would lead nowhere');
            // and for the admin the link is there, with its query
            const admin = load(lang, { admin: true });
            const adminAlert = webhookAlert(alerts(admin, ok({ webhooks: SUMMARY_BROKEN })))!;
            assert.match(String(admin.OV.renderBriefing([adminAlert], new Date())), /data-target="settings" data-query="s=platform&amp;card=meta-events"/);
        });
    }

    it('raises nothing for an answer that is not a verdict, or a request that failed', () => {
        const w = load('en');
        for (const health of [
            ok({ webhooks: null }), ok({ webhooks: { ok: null, checkedAt: null, problems: [] } }), ok({ webhooks: { ok: true, checkedAt: 'x', problems: [] } }),
            ok({}), ok(null), ok(undefined), { status: 'rejected', reason: new Error('x') }, undefined,
        ]) {
            assert.equal(webhookAlert(alerts(w, health)), undefined, JSON.stringify(health));
        }
    });

    it('leaves every other alert as it was, and is sorted with the dangers', () => {
        const w = load('en');
        const list = plain<Json[]>(w.OV.sortAlerts(w.OV.buildAlerts({ activeCampaigns: 0 }, ok({ data: [] }), { status: 'fulfilled', value: { status: 'invalid' } }, ok([]), ok({ data: [] }), ok([]), ok(null), ok({ webhooks: SUMMARY_BROKEN }))));
        assert.deepEqual(list.map((a) => a.level), ['danger', 'danger', 'info']);
        assert.equal(list[0]!.icon, 'key-round', 'the dead token stays first: the checks run in the order they always did');
        assert.equal(list[1]!.icon, 'plug-zap');
    });
});

describe('the Inbox: the strip', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`shows the notice above the list, with a button to the card for the platform admin (${lang})`, () => {
            const w = load(lang, { admin: true });
            const host = w.h.el('webhook-strip', { innerHTML: '' });
            host.classes.add('hidden');
            w.IB.paintWebhookStrip(SUMMARY_BROKEN);
            assert.equal(host.classes.has('hidden'), false);
            const markup = host.innerHTML;
            assert.match(markup, /role="alert"/);
            assert.ok(words(markup).includes(words(w.t('webhooks.banner.title'))));
            assert.ok(words(markup).includes(words(plain<{ lines: string[] }>(w.HS.webhookNotice(SUMMARY_BROKEN)).lines[0]!)));
            assert.match(markup, /id="webhook-strip-fix"[^>]*data-action="app:navigate"[^>]*data-target="settings"[^>]*data-query="s=platform&amp;card=meta-events"/);
            assert.equal(words(markup).includes(words(w.t('webhooks.banner.askOwner'))), false);
        });

        it(`tells anyone else whom to ask, and gives them no button (${lang})`, () => {
            const w = load(lang, { admin: false });
            const host = w.h.el('webhook-strip', { innerHTML: '' });
            w.IB.paintWebhookStrip(SUMMARY_BROKEN);
            assert.ok(words(host.innerHTML).includes(words(w.t('webhooks.banner.askOwner'))));
            assert.equal(host.innerHTML.includes('webhook-strip-fix'), false);
            assert.equal(host.innerHTML.includes('<button'), false);
        });
    }

    it('hides the strip again, and empties it, when the answer stops being a "no"', () => {
        const w = load('en');
        const host = w.h.el('webhook-strip', { innerHTML: '' });
        w.IB.paintWebhookStrip(SUMMARY_BROKEN);
        assert.notEqual(host.innerHTML, '');
        w.IB.paintWebhookStrip({ ok: true, checkedAt: 'x', problems: [] });
        assert.equal(host.innerHTML, '');
        assert.equal(host.classes.has('hidden'), true);
    });

    it('reads the stored answer once when the screen opens, and paints it', async () => {
        const w = load('en', { api: { getTenantHealth: async () => ({ tenantId: 't', webhooks: SUMMARY_BROKEN }) } });
        const host = w.h.el('webhook-strip', { innerHTML: '' });
        await w.IB.loadWebhookStrip();
        assert.deepEqual(w.calls.map((c) => c.fn), ['getTenantHealth']);
        assert.ok(words(host.innerHTML).includes('Instagram events are going to another website'));
    });

    it('says nothing when the request fails or the answer is not a "no": the strip is an extra', async () => {
        for (const answer of [() => Promise.reject(new Error('offline')), async () => ({}), async () => ({ webhooks: null }), async () => ({ webhooks: { ok: null, problems: [] } })]) {
            const w = load('en', { api: { getTenantHealth: answer } });
            const host = w.h.el('webhook-strip', { innerHTML: '' });
            host.classes.add('hidden');
            await w.IB.loadWebhookStrip();
            assert.equal(host.innerHTML, '');
            assert.equal(host.classes.has('hidden'), true);
        }
    });

    it('paints nothing for an answer that arrives after the screen was left or the tenant changed', async () => {
        let release: (v: unknown) => void = () => undefined;
        const slow = new Promise((resolve) => { release = resolve; });
        const w = load('en', { api: { getTenantHealth: () => slow } });
        const host = w.h.el('webhook-strip', { innerHTML: '' });
        const pending = w.IB.loadWebhookStrip();
        w.IB._epoch++;
        release({ webhooks: SUMMARY_BROKEN });
        await pending;
        assert.equal(host.innerHTML, '');
    });

    it('puts a place for the strip in the layout, hidden, above the search', () => {
        const w = load('en');
        const layout = String(w.IB.layout());
        assert.match(layout, /<div id="webhook-strip" class="hidden"><\/div>/);
        assert.ok(layout.indexOf('id="webhook-strip"') < layout.indexOf('id="inbox-search"'));
    });
});

// ─── Settings ───────────────────────────────────────────────────────────────────────────

describe('Settings: the card, and what points to it', () => {
    it('is a platform admin\'s card in the Platform tab, beside the Meta app card and before it', () => {
        const { ST } = load('en');
        const cards = plain<Json[]>(ST.CARDS);
        const ids = cards.map((c) => c.id);
        const card = cards.find((c) => c.id === 'meta-events')!;
        assert.deepEqual([card.group, card.who, card.platform, card.dom], ['platform', 'admin', true, 'settings-meta-events']);
        assert.equal(ids.indexOf('meta-events') + 1, ids.indexOf('meta-app'));
        assert.equal(new Set(cards.map((c) => c.dom)).size, cards.length, 'no two cards share an address');
    });

    it('draws the card from what load() read, and an error with Retry when it could not be read', () => {
        const { ST, t } = load('en');
        const card = words(ST.renderCard('meta-events', { metaEvents: incident(), metaEventsError: null }));
        assert.ok(card.startsWith(t('meta.events.title')));
        assert.ok(card.includes('Another website: staging.as-systems.tech'));
        const failed = String(ST.renderCard('meta-events', { metaEvents: null, metaEventsError: Object.assign(new Error('x'), { body: { code: 'NO_BASE_URL' } }) }));
        assert.ok(words(failed).includes(t('meta.events.error.no_base_url')));
        assert.match(failed, /data-action="metaconnect:recheck"/);
        assert.equal(String(ST.renderCard('meta-events', { metaEvents: null, metaEventsError: null })).trim(), '', 'no card for a viewer it was never asked for');
    });

    it('asks Meta for it only for a platform admin', async () => {
        for (const admin of [true, false]) {
            const w = load('en', { admin, api: { getMetaWebhooks: async () => incident() } });
            const ctx = await w.ST.load();
            assert.equal(w.calls.some((c) => c.fn === 'getMetaWebhooks'), admin, String(admin));
            assert.deepEqual([ctx.metaEvents !== null, ctx.metaEventsError], [admin, null]);
        }
    });

    it('keeps a failed read as that card\'s error, never the page\'s', async () => {
        const w = load('en', { api: { getMetaWebhooks: async () => { throw Object.assign(new Error('no'), { status: 409, body: { code: 'NOT_CONFIGURED' } }); } } });
        const ctx = await w.ST.load();
        assert.equal(ctx.metaEvents, null);
        assert.equal(ctx.metaEventsError.body.code, 'NOT_CONFIGURED');
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`renders the card on the Platform tab of the whole page, and nowhere for a viewer who is not a platform admin (${lang})`, async () => {
            const stubs: Record<string, (...a: any[]) => any> = { getMetaWebhooks: async () => incident(), getTokenStatus: async () => ({ status: 'valid', scopes: [] }) };
            const admin = load(lang, { admin: true, api: stubs });
            const container = admin.h.el('page-container');
            await admin.ST.render();
            await settle();
            assert.match(container.innerHTML, /data-settings-card="meta-events"/);
            assert.ok(words(container.innerHTML).includes(admin.t('meta.events.title')));
            assert.ok(words(container.innerHTML).includes(admin.t('meta.events.state.elsewhere', { host: 'staging.as-systems.tech' })));

            const member = load(lang, { admin: false, api: stubs });
            const container2 = member.h.el('page-container');
            await member.ST.render();
            await settle();
            assert.equal(/data-settings-card="meta-events"/.test(container2.innerHTML), false);
        });
    }

    for (const lang of ['en', 'ar'] as const) {
        it(`says on the Test webhook card that it checks AutoReply's side only, and points to the card (${lang})`, () => {
            const { ST, t } = load(lang);
            const markup = String(ST.webhookSection({
                canAdmin: true, webhookError: null,
                webhookToken: { configuredInDatabase: true, preview: 'ab•••yz', length: 12, webhookUrl: 'https://example.test/webhook' },
            }));
            assert.ok(words(markup).includes(words(t('settings.webhookTestHint'))));
            assert.ok(lang === 'en' ? /AutoReply’s side only/.test(words(t('settings.webhookTestHint'))) : /جهة AutoReply فقط/.test(t('settings.webhookTestHint')), 'the hint says whose side it checks');
            assert.match(markup, /data-action="settings:openCard"[^>]*data-card="meta-events"/);
            assert.ok(words(markup).includes(words(t('settings.webhookTestSeeEvents'))));
        });
    }
});

// ─── Both languages say the same thing ──────────────────────────────────────────────────

describe('the words', () => {
    /** The only two that are the same in both: the product's name, and "{object}: {message}" (a name, then what Meta said). */
    const SAME_IN_BOTH = new Set(['meta.events.state.ours', 'meta.events.stepFailed']);

    it('are in both languages, with the same placeholders, and the Arabic is not the English', () => {
        const en = load('en').h.I18N.strings.en as Record<string, string>;
        const ar = load('ar').h.I18N.strings.ar as Record<string, string>;
        const keys = Object.keys(en).filter((k) => k.startsWith('meta.events.') || k.startsWith('webhooks.') || k === 'settings.webhookTestSeeEvents' || k === 'help.link.metaEvents');
        assert.ok(keys.length > 40, `${keys.length} keys`);
        for (const key of keys) {
            assert.ok(ar[key], `${key} has no Arabic`);
            const holes = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
            assert.equal(holes(ar[key]!), holes(en[key]!), key);
            if (!SAME_IN_BOTH.has(key)) assert.notEqual(ar[key], en[key], `${key} reads the same in both languages`);
        }
    });

    it('says the button and the card with the words the Help Center and the alerts quote', () => {
        const en = load('en').t;
        const ar = load('ar').t;
        assert.equal(en('meta.events.fix'), 'Send everything to AutoReply');
        assert.equal(en('meta.events.allGood'), 'Everything already goes to AutoReply');
        assert.equal(en('meta.events.title'), 'Where Meta sends your events');
        assert.equal(ar('meta.events.fix'), 'أرسل كل شيء إلى AutoReply');
        assert.equal(ar('meta.events.title'), 'إلى أين ترسل ميتا أحداثك');
    });
});
