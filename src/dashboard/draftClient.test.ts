/**
 * The wizard's client for the profile draft (P24): `dashboard/js/pages/draft_client.js`, the REAL file, run in a `node:vm` context against a
 * stand-in `API.request` and a hand-turned clock, so this tests what ships. The views it reads are made by the server's own `toDraftView` out of the
 * engine's real fixtures, so the client and the server cannot drift apart without this failing.
 *
 * What is pinned:
 *   - polling: every 3 s while the tab is visible and not at all while it is hidden; `advance` is fired once when the poll says `advanceable` and never
 *     piled up while it is in flight; the watch stops when the draft is finished, and gives up (once, loudly) when the session ends or the wizard is over;
 *   - "Start without waiting": the person's own edits are never offered a draft's value; the fill is handed over once, as soon as the draft is ready;
 *   - applying: one PATCH for many fields, each as the draft has it, only what the server listed as drafted, retried once on a version conflict;
 *   - it builds no markup: a draft came from a bio, a web page and a model.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { toDraftView } from '../services/onboarding/draftView.js';
import type { DraftRow } from '../services/onboarding/draftStore.js';
import { emptyUsage, type FetchedBundle, type ResultColumn, type SourcesStatus } from '../services/onboarding/draftTypes.js';
import { okBusiness, okVoice, STORE_CANDIDATES, STORE_SOURCES, storeSignals } from '../services/onboarding/fixtures/draftAnswers.js';
import { validateDraft } from '../services/onboarding/validateDraft.js';

const SOURCE = 'dashboard/js/pages/draft_client.js';

// ─── The server's own views ─────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);
const at = (ms: number): Date => new Date(NOW + ms);
const ok = { state: 'ok', via: 'x', kind: null, retryable: false, message: null, ms: 5, counts: {} } as const;
const STATUS: SourcesStatus = { instagram: { ...ok }, website: { ...ok }, youtube: { ...ok, state: 'skipped', kind: 'no_input' }, typed: { ...ok, state: 'skipped', kind: 'no_input' } };
const bundle = (): FetchedBundle => ({
    version: 1, sources: STORE_SOURCES, candidates: STORE_CANDIDATES, signals: storeSignals(),
    facts: { handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 1, mediaCount: 1, siteHost: null, site: null, brand: null, logos: [], socialLinks: {}, youtube: null, knownUrls: [], knownEmails: [], knownPhones: [], keywordsInUse: [] },
});
const CODE: ResultColumn['code'] = { handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 1, mediaCount: 1, siteHost: null, site: null, brand: null, logos: [], socialLinks: { instagram: 'https://www.instagram.com/noor.perfumes' }, youtube: null };
const ctx = { sources: STORE_SOURCES, signals: storeSignals(), candidates: STORE_CANDIDATES, code: { brand: { primary: '#7B3F61', accent: '#E0A458' }, socials: { handle: 'noor.perfumes', site: 'https://noor-perfumes.example/', links: { instagram: 'https://www.instagram.com/noor.perfumes' } } } };

const row = (over: Partial<DraftRow>): DraftRow => ({
    id: '00000000-0000-4000-8000-000000000001', creator_id: '00000000-0000-4000-8000-000000000100', origin: 'wizard',
    requested_by: null, inputs: { instagram: 'noor.perfumes', website: null, youtube: null, about: null, via: 'discovery' },
    inputs_hash: 'h', prompt_version: 'profile_draft_v1', status: 'queued', attempts: 0, next_attempt_at: null, lease_until: null, lease_owner: null,
    sources: null, sources_status: null, draft: null, partial: false, usage: emptyUsage(), error: null, error_kind: null, created_at: at(-60_000), updated_at: at(-1_000), finished_at: null, ...over,
});
const wire = (r: DraftRow, audience: 'tenant' | 'admin' = 'tenant') => JSON.parse(JSON.stringify(toDraftView(r, { audience, nowMs: NOW })));

const readyDraft = (): ResultColumn => ({ stage: 'final', result: validateDraft({ voice: okVoice(), business: okBusiness() }, ctx), code: CODE, models: {}, promptVersion: 'profile_draft_v1' });
const prefillDraft = (): ResultColumn => ({ stage: 'prefill', result: validateDraft({}, ctx), code: CODE, models: {}, promptVersion: 'profile_draft_v1' });

const READY = () => wire(row({ status: 'ready', sources: bundle(), sources_status: STATUS, draft: readyDraft(), finished_at: at(0), updated_at: at(0) }));
const NEEDS_KEY = () => wire(row({ status: 'failed', sources: bundle(), sources_status: STATUS, draft: prefillDraft(), error_kind: 'no_provider', error: 'No AI provider has a key.', finished_at: at(0), updated_at: at(0) }));
const WORKING = (status: 'queued' | 'fetching' | 'drafting' = 'drafting', over: Partial<DraftRow> = {}) =>
    wire(row({ status, sources: status === 'drafting' ? bundle() : null, lease_owner: 'x', lease_until: at(200_000), ...over }));
const ADVANCEABLE = () => wire(row({ status: 'drafting', sources: bundle() }));

// ─── The harness ────────────────────────────────────────────────────────────────────────────

interface Call { path: string; method: string; body: any }

interface Timer { at: number; fn: () => void; id: number }

function load() {
    const calls: Call[] = [];
    const timers: Timer[] = [];
    let now = 0;
    let nextId = 1;
    let visible = true;
    const handlers: Array<(call: Call) => unknown> = [];
    const API = {
        request: async (path: string, init: { method?: string; body?: string } = {}) => {
            const call: Call = { path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
            calls.push(call);
            for (const handler of handlers) {
                const answer = handler(call);
                if (answer !== undefined) {
                    if (answer instanceof Error) throw answer;
                    return answer;
                }
            }
            throw new Error(`unhandled ${call.method} ${path}`);
        },
    };
    const sandbox: Record<string, unknown> = { API, JSON, Object, Array, Set, Map, Promise, Number, String, Error, encodeURIComponent, console };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });
    const DraftClient = vm.runInContext('DraftClient', sandbox) as any;

    const timerApi = {
        set: (fn: () => void, ms: number) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
        clear: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
    };
    const world = {
        DraftClient, calls, handlers,
        make: (options: Record<string, unknown> = {}) => DraftClient.create({ timers: timerApi, visible: () => visible, ...options }),
        setVisible: (v: boolean) => { visible = v; },
        pending: () => timers.length,
        /** Run every timer due within `ms` of fake time, in order, letting promises settle between them. */
        async advance(ms: number) {
            const end = now + ms;
            for (;;) {
                const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                timers.splice(timers.indexOf(due), 1);
                now = Math.max(now, due.at);
                due.fn();
                await flush();
            }
            now = end;
        },
        reply: (path: RegExp | string, method: string, answer: (call: Call) => unknown) => {
            handlers.push((call) => ((typeof path === 'string' ? call.path === path : path.test(call.path)) && call.method === method ? answer(call) : undefined));
        },
    };
    return world;
}

const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const httpError = (status: number, body: unknown, message = 'refused'): Error & { status: number; body: unknown } => Object.assign(new Error(message), { status, body });
/** Across the vm's realm boundary two equal arrays are not `deepStrictEqual`: compare what they say. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value === undefined ? null : value));

// ─── Pure ───────────────────────────────────────────────────────────────────────────────────

describe('paths', () => {
    const { DraftClient } = load();

    it('reads a dotted path with list indexes, and refuses anything that could reach a prototype or is not a path', () => {
        assert.deepEqual(plain(DraftClient.parsePath('audience.pains[0]')), ['audience', 'pains', 0]);
        assert.deepEqual(plain(DraftClient.parsePath('offers[12].url')), ['offers', 12, 'url']);
        for (const bad of ['', '.a', 'a..b', 'a.', '__proto__.x', 'a.constructor', 'prototype', 'a[b]', 'a[1', 'a b', 'a-b', 7, null, undefined, 'x'.repeat(201), 'a[1000]']) {
            assert.equal(DraftClient.parsePath(bad), null, String(bad));
        }
    });

    it('getAt reads only what the object itself holds', () => {
        const o = { a: { b: [{ c: 5 }] } };
        assert.equal(DraftClient.getAt(o, 'a.b[0].c'), 5);
        assert.equal(DraftClient.getAt(o, 'a.b[3]'), undefined);
        assert.equal(DraftClient.getAt(o, 'a.toString'), undefined, 'not a prototype\'s');
        assert.equal(DraftClient.getAt(o, '__proto__'), undefined);
        assert.equal(DraftClient.getAt(null, 'a'), undefined);
    });

    it('a field is applied at its list: a patch replaces a list whole and cannot change one entry', () => {
        assert.equal(DraftClient.fieldKey('identity.niche'), 'identity.niche');
        assert.equal(DraftClient.fieldKey('audience.pains[0]'), 'audience.pains');
        assert.equal(DraftClient.fieldKey('offers[1].url'), 'offers');
        assert.equal(DraftClient.fieldKey('dm.faq[2].a'), 'dm.faq');
    });

    it('setAt makes the objects on the way, and never enters a list or a prototype', () => {
        const o: Record<string, unknown> = {};
        assert.equal(DraftClient.setAt(o, 'a.b.c', 1), true);
        assert.deepEqual(JSON.parse(JSON.stringify(o)), { a: { b: { c: 1 } } });
        assert.equal(DraftClient.setAt(o, 'a.b[0]', 1), false);
        assert.equal(DraftClient.setAt(o, '__proto__.polluted', 1), false);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });
});

describe('phaseOf: what a screen should say', () => {
    const { DraftClient } = load();
    const phase = (view: unknown) => plain(DraftClient.phaseOf(view));

    it('no draft yet', () => assert.deepEqual(phase(null), { phase: 'none', step: null, canSkipWaiting: false, prefill: false, retryAt: null }));

    it('being made: which step, and that the person may carry on without waiting', () => {
        assert.deepEqual(phase(WORKING('queued')), { phase: 'working', step: 'queued', canSkipWaiting: true, prefill: false, retryAt: null });
        assert.equal(phase(WORKING('fetching')).step, 'fetching');
        assert.equal(phase(WORKING('drafting')).step, 'drafting');
        assert.equal(phase(ADVANCEABLE()).canSkipWaiting, true, 'a draft nobody is working on yet is still on its way');
    });

    it('waiting out a failed try', () => {
        const view = wire(row({ status: 'drafting', sources: bundle(), attempts: 1, next_attempt_at: at(40_000), error_kind: 'timeout', error: 'slow' }));
        const p = phase(view);
        assert.deepEqual([p.phase, p.step, p.canSkipWaiting], ['retrying', 'drafting', true]);
        assert.equal(p.retryAt, view.retryAt);
    });

    it('finished: ready, needs a key (with what code found), failed, replaced', () => {
        assert.equal(phase(READY()).phase, 'ready');
        assert.deepEqual([phase(NEEDS_KEY()).phase, phase(NEEDS_KEY()).prefill, phase(NEEDS_KEY()).canSkipWaiting], ['needs_key', true, false]);
        assert.equal(phase(wire(row({ status: 'failed', error_kind: 'no_source', error: 'x', finished_at: at(0) }))).phase, 'failed');
        assert.equal(phase(wire(row({ status: 'superseded', finished_at: at(0) }))).phase, 'superseded');
    });

    it('a view that is not one is no draft', () => {
        for (const junk of [undefined, 0, 'x', []]) assert.equal(phase(junk).phase, 'none');
    });
});

describe('fieldsOf: what a draft offers', () => {
    const { DraftClient } = load();
    const fields = (view: unknown) => JSON.parse(JSON.stringify(DraftClient.fieldsOf(view))) as Array<{ key: string; paths: string[]; value: unknown; provenance: Array<Record<string, string>>; flags: Array<{ kind: string }>; source: string }>;

    it('one field per list or value, in the draft\'s own words, with where each fact came from', () => {
        const all = fields(READY());
        const keys = all.map((f) => f.key);
        assert.equal(new Set(keys).size, keys.length, 'one entry per key');
        const niche = all.find((f) => f.key === 'identity.niche')!;
        assert.equal(niche.source, 'draft');
        assert.equal(typeof niche.value, 'string');
        assert.ok(niche.provenance[0]!.source && 'evidence' in niche.provenance[0]!);
    });

    it('a drafted entry of a list is offered as its list, once', () => {
        const all = fields(READY());
        assert.ok(all.some((f) => f.key === 'audience.pains' && Array.isArray(f.value) && f.paths.length >= 1));
        assert.ok(all.every((f) => !f.key.includes('[')), 'no key is an entry of a list');
    });

    it('what code found is offered too, with NO provenance: colours and links were not said by a model, and the screen can say where they were found', () => {
        const all = fields(READY());
        const brand = all.find((f) => f.key === 'brand.primary')!;
        assert.deepEqual([brand.value, brand.provenance], ['#7B3F61', []]);
        assert.ok(all.some((f) => f.key === 'socials.links' && f.provenance.length === 0));
    });

    it('with no assistant (a missing key) it offers only that, as a prefill: no identity, no offers, no FAQ', () => {
        const all = fields(NEEDS_KEY());
        assert.ok(all.length > 0 && all.every((f) => f.source === 'prefill'));
        assert.ok(all.some((f) => f.key === 'brand.primary'));
        assert.equal(all.some((f) => /^(identity|offers|dm|audience\.(who|pains|goals)|voice\.(guide|samples))/.test(f.key)), false, 'nothing a model would have written');
    });

    it('a draft that is not finished offers nothing', () => {
        assert.deepEqual(fields(WORKING()), []);
        assert.deepEqual(fields(null), []);
    });

    it('the values are copies: changing one changes nothing in the view', () => {
        const view = READY();
        const a = DraftClient.fieldsOf(view);
        a[0].value = 'changed';
        assert.notEqual(DraftClient.fieldsOf(view)[0].value, 'changed');
    });

    it('the flags the checker raised are attached to the field they are about, for a person to tick', () => {
        const view = READY();
        view.draft.flags.push({ path: 'offers[0].url', kind: 'offer_offdomain_url', detail: 'evil.example' });
        const offers = fields(view).find((f) => f.key === 'offers')!;
        assert.ok(offers.flags.some((f) => f.kind === 'offer_offdomain_url'));
    });

    it('one patch holds every chosen field at its own path', () => {
        const all = DraftClient.fieldsOf(READY());
        const chosen = all.filter((f: { key: string }) => ['identity.niche', 'brand.primary', 'audience.pains'].includes(f.key));
        const patch = JSON.parse(JSON.stringify(DraftClient.patchFor(chosen)));
        assert.deepEqual(Object.keys(patch).sort(), ['audience', 'brand', 'identity']);
        assert.deepEqual(Object.keys(patch.identity), ['niche']);
        assert.equal(patch.brand.primary, '#7B3F61');
        assert.ok(Array.isArray(patch.audience.pains));
    });
});

// ─── The controller ─────────────────────────────────────────────────────────────────────────

describe('start and advance', () => {
    it('the tenant\'s wizard starts a draft with what was typed, and the answer is the view', async () => {
        const w = load();
        w.reply('/onboarding/draft', 'POST', () => ({ draft: WORKING('queued'), reused: false, superseded: 0 }));
        const c = w.make();
        const r = await c.start({ instagram: '@noor', website: 'noor.example' });
        assert.deepEqual(w.calls, [{ path: '/onboarding/draft', method: 'POST', body: { instagram: '@noor', website: 'noor.example' } }]);
        assert.equal(r.reused, false);
        assert.equal(c.view.status, 'queued');
    });

    it('an operator uses the tenant\'s path in the admin API, may force, and a tenant never can', async () => {
        const w = load();
        w.reply(/^\/admin\/tenants\//, 'POST', () => ({ draft: WORKING('queued'), reused: false }));
        w.reply('/onboarding/draft', 'POST', () => ({ draft: WORKING('queued'), reused: false }));
        const admin = w.make({ tenantId: 'a b/c' });
        await admin.start({}, { force: true });
        assert.deepEqual(w.calls[0], { path: '/admin/tenants/a%20b%2Fc/draft', method: 'POST', body: { force: true } });
        const tenant = w.make();
        await tenant.start({}, { force: true });
        assert.deepEqual(w.calls[1]!.body, {}, 'the flag is the operator\'s');
    });

    it('advance is one request at a time: a second call is the first one\'s promise', async () => {
        const w = load();
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        w.handlers.push((call) => (call.path === '/onboarding/draft/advance' ? gate.then(() => ({ draft: READY(), advance: { outcome: 'worked' } })) : undefined));
        const c = w.make();
        const a = c.advance();
        const b = c.advance();
        assert.equal(a, b);
        release();
        const reply = await a;
        assert.equal(reply.advance.outcome, 'worked');
        assert.equal(w.calls.filter((x) => x.path.endsWith('/advance')).length, 1);
        assert.equal(c.view.status, 'ready');
        await c.advance().catch(() => undefined);
        assert.equal(w.calls.filter((x) => x.path.endsWith('/advance')).length, 2, 'once it is over a new one may start');
    });

    it('a start resets what the person edited and what was applied: it is a different draft', async () => {
        const w = load();
        w.reply('/onboarding/draft', 'GET', () => ({ draft: READY() }));
        w.reply('/onboarding/draft', 'POST', () => ({ draft: WORKING('queued') }));
        const c = w.make();
        await c.refresh();
        c.markEdited('identity.niche');
        await c.start({});
        assert.equal(c._edited.size, 0);
    });
});

describe('watch: polling', () => {
    const setup = () => {
        const w = load();
        const views: Array<unknown> = [];
        const server: { view: any } = { view: WORKING('fetching') };
        w.reply('/onboarding/draft', 'GET', () => ({ draft: server.view }));
        w.reply('/onboarding/draft/advance', 'POST', () => new Promise(() => undefined));
        const c = w.make();
        return { w, c, server, views };
    };

    it('polls at once and then every 3 s, and not at all while the tab is hidden', async () => {
        const { w, c } = setup();
        c.watch();
        await w.advance(0);
        assert.equal(w.calls.length, 1);
        await w.advance(3_000);
        assert.equal(w.calls.length, 2);
        w.setVisible(false);
        await w.advance(9_000);
        assert.equal(w.calls.length, 2, 'a hidden tab makes no request');
        w.setVisible(true);
        await w.advance(3_000);
        assert.equal(w.calls.length, 3, 'and goes on when it is shown again');
        assert.equal(w.DraftClient.POLL_MS, 3_000);
    });

    it('fires advance once when the draft becomes advanceable, and never piles one on another while it runs', async () => {
        const { w, c, server } = setup();
        server.view = ADVANCEABLE();
        c.watch();
        await w.advance(0);
        await w.advance(12_000);
        assert.equal(w.calls.filter((x) => x.path.endsWith('/advance')).length, 1, 'one long request, however many polls');
        assert.ok(w.calls.filter((x) => x.method === 'GET').length >= 4, 'the poll kept going meanwhile');
    });

    it('does not fire advance at a draft somebody is working on', async () => {
        const { w, c, server } = setup();
        server.view = WORKING('drafting');
        c.watch();
        await w.advance(10_000);
        assert.equal(w.calls.filter((x) => x.path.endsWith('/advance')).length, 0);
    });

    it('stops when the draft is finished, and when it is replaced', async () => {
        for (const finished of [READY(), NEEDS_KEY(), wire(row({ status: 'superseded', finished_at: at(0) }))]) {
            const { w, c, server } = setup();
            server.view = WORKING('drafting');
            c.watch();
            await w.advance(0);
            server.view = finished;
            await w.advance(3_000);
            const before = w.calls.length;
            await w.advance(30_000);
            assert.equal(w.calls.length, before, finished.status);
            assert.equal(w.pending(), 0);
        }
    });

    it('stops when there is no draft at all', async () => {
        const { w, c, server } = setup();
        server.view = null;
        c.watch();
        await w.advance(0);
        await w.advance(30_000);
        assert.equal(w.calls.length, 1);
    });

    it('tells whoever listens about each change of the view, and not about a poll that found the same', async () => {
        const { w, c, server } = setup();
        const seen: string[] = [];
        c.watch((view: any) => seen.push(view.status));
        await w.advance(0);
        await w.advance(3_000);
        server.view = WORKING('drafting', { updated_at: at(1_000) });
        await w.advance(3_000);
        server.view = READY();
        await w.advance(3_000);
        assert.deepEqual(seen, ['fetching', 'drafting', 'ready']);
    });

    it('a network blip is not the end: the next poll tries again', async () => {
        const { w, c } = setup();
        let n = 0;
        w.handlers.unshift((call) => (call.method === 'GET' && n++ === 1 ? Object.assign(new Error('Network error'), { isNetworkError: true }) : undefined));
        c.watch();
        await w.advance(0);
        await w.advance(9_000);
        assert.ok(w.calls.filter((x) => x.method === 'GET').length >= 4);
    });

    it('gives up, once, when the session ends or the wizard is over, and says why', async () => {
        for (const err of [httpError(401, null), httpError(403, null), httpError(404, null), httpError(409, { code: 'ONBOARDING_COMPLETED' })]) {
            const { w, c } = setup();
            w.handlers.unshift((call) => (call.method === 'GET' ? err : undefined));
            const errors: unknown[] = [];
            c.watch(undefined, (e: unknown) => errors.push(e));
            await w.advance(0);
            await w.advance(30_000);
            assert.equal(errors.length, 1, String(err.status));
            assert.equal(w.calls.length, 1);
        }
    });

    it('an advance that fails for good ends the watch; one that fails for a reason that may pass does not', async () => {
        const { w, c, server } = setup();
        server.view = ADVANCEABLE();
        w.handlers.unshift((call) => (call.path.endsWith('/advance') ? httpError(409, { code: 'ONBOARDING_COMPLETED' }) : undefined));
        const errors: unknown[] = [];
        c.watch(undefined, (e: unknown) => errors.push(e));
        await w.advance(0);
        await w.advance(10_000);
        assert.equal(errors.length, 1);
        assert.equal(w.pending(), 0);
    });

    it('stop() cancels the next poll, and a second watch replaces the first', async () => {
        const { w, c } = setup();
        const a: string[] = [];
        const b: string[] = [];
        c.watch((v: any) => a.push(v.status));
        await w.advance(0);
        c.watch((v: any) => b.push(`${v.status}:${v.updatedAt}`));
        await w.advance(0);
        assert.equal(a.length, 1, 'the first listener was removed');
        assert.ok(b.length >= 1);
        c.stop();
        assert.equal(w.pending(), 0);
        const calls = w.calls.length;
        await w.advance(30_000);
        assert.equal(w.calls.length, calls);
    });
});

describe('"Start without waiting": the live fill', () => {
    it('carries on while it drafts, and hands over the fields the person has not touched, once, when it is ready', async () => {
        const w = load();
        const server: { view: any } = { view: WORKING('drafting') };
        w.reply('/onboarding/draft', 'GET', () => ({ draft: server.view }));
        w.reply('/onboarding/draft/advance', 'POST', () => new Promise(() => undefined));
        const c = w.make();
        const fills: Array<{ keys: string[]; id: string }> = [];
        const filled = (): number => fills.length;
        c.watch();
        await w.advance(0);
        c.startWithoutWaiting((fields: Array<{ key: string }>, view: { id: string }) => fills.push({ keys: fields.map((f) => f.key), id: view.id }));
        assert.equal(c.manual, true);
        assert.equal(filled(), 0, 'nothing to fill while it is still being written');

        // The person types into the niche and the pains while the assistant works.
        c.markEdited('identity.niche');
        c.markEdited('audience.pains[1]');
        server.view = READY();
        await w.advance(3_000);
        assert.equal(filled(), 1);
        assert.equal(fills[0]!.keys.includes('identity.niche'), false, 'what the person wrote is theirs');
        assert.equal(fills[0]!.keys.includes('audience.pains'), false, 'an edit of one entry protects its list');
        assert.ok(fills[0]!.keys.includes('identity.kind') && fills[0]!.keys.includes('brand.primary'));

        await w.advance(10_000);
        assert.equal(filled(), 1, 'once for a draft');
    });

    it('answers at once when the draft is already finished', () => {
        const w = load();
        const c = w.make();
        c._set(READY(), 'test');
        const fills: unknown[] = [];
        c.startWithoutWaiting((fields: unknown[]) => fills.push(fields.length));
        assert.equal(fills.length, 1);
        assert.ok((fills[0] as number) > 5);
    });

    it('a missing AI key still hands over what code found, so the wizard fills the colours and the links by itself', () => {
        const w = load();
        const c = w.make();
        c._set(NEEDS_KEY(), 'test');
        let seen: Array<{ key: string; source: string }> = [];
        c.startWithoutWaiting((fields: typeof seen) => { seen = fields; });
        assert.ok(seen.length > 0 && seen.every((f) => f.source === 'prefill'));
        assert.ok(seen.some((f) => f.key === 'brand.primary'));
    });

    it('a failure with nothing found hands over nothing, and says nothing', () => {
        const w = load();
        const c = w.make();
        c._set(wire(row({ status: 'failed', error_kind: 'no_source', error: 'x', finished_at: at(0) })), 'test');
        let called = false;
        c.startWithoutWaiting(() => { called = true; });
        assert.equal(called, false);
    });

    it('an applied field is not offered again', async () => {
        const w = load();
        w.reply('/profile', 'GET', () => ({ version: 3, profile: {}, stored: true }));
        w.reply('/profile', 'PATCH', () => ({ version: 4, activationMissing: [], changed: ['identity'] }));
        const c = w.make();
        c._set(READY(), 'test');
        const before = c.fieldsToFill().length;
        await c.applyFields(['identity.niche']);
        assert.equal(c.fieldsToFill().length, before - 1);
        assert.equal(c.fieldsToFill().some((f: { key: string }) => f.key === 'identity.niche'), false);
        assert.ok(c.fields().some((f: { key: string }) => f.key === 'identity.niche'), 'it is still part of the draft');
    });
});

describe('applying fields', () => {
    const profileApi = (w: ReturnType<typeof load>, versions: { read: number | null; patchAnswers?: Array<unknown> } ) => {
        const answers = [...(versions.patchAnswers ?? [{ version: (versions.read ?? 0) + 1, activationMissing: ['offers'], changed: ['identity'] }])];
        w.reply('/profile', 'GET', () => ({ profile: {}, version: versions.read, stored: versions.read !== null }));
        w.reply('/profile', 'PATCH', () => { const a = answers.shift(); return a ?? httpError(500, null); });
    };

    it('makes ONE patch of the chosen fields, each as the draft has it, against the version it just read', async () => {
        const w = load();
        profileApi(w, { read: 7 });
        const c = w.make();
        c._set(READY(), 'test');
        const draft = READY().draft.profile;
        const out = await c.applyFields(['identity.niche', 'brand.primary', 'audience.pains[0]']);
        const patches = w.calls.filter((x) => x.method === 'PATCH');
        assert.equal(patches.length, 1, 'one version, one history row');
        assert.equal(patches[0]!.body.version, 7);
        assert.deepEqual(patches[0]!.body.patch, { identity: { niche: draft.identity.niche }, brand: { primary: '#7B3F61' }, audience: { pains: draft.audience.pains } });
        assert.deepEqual(plain(out.applied).sort(), ['audience.pains', 'brand.primary', 'identity.niche']);
        assert.deepEqual(plain([out.version, out.activationMissing]), [8, ['offers']]);
        assert.deepEqual(w.calls.map((x) => `${x.method} ${x.path}`), ['GET /profile', 'PATCH /profile']);
    });

    it('an operator\'s client applies through the admin\'s on-behalf route for that tenant, with the same patch and the same lock', async () => {
        const w = load();
        w.reply('/admin/tenants/t%201/profile', 'GET', () => ({ profile: {}, version: 3, stored: true }));
        w.reply('/admin/tenants/t%201/profile', 'PATCH', () => ({ version: 4, activationMissing: [] }));
        const c = w.make({ tenantId: 't 1' });
        c._set(READY(), 'test');
        await c.applyField('identity.niche');
        assert.deepEqual(w.calls.map((x) => `${x.method} ${x.path}`), ['GET /admin/tenants/t%201/profile', 'PATCH /admin/tenants/t%201/profile']);
        assert.equal(w.calls[1]!.body.version, 3);
        assert.deepEqual(Object.keys(w.calls[1]!.body.patch), ['identity']);
    });

    it('a tenant with no stored profile sends version null, as the server expects', async () => {
        const w = load();
        profileApi(w, { read: null, patchAnswers: [{ version: 1, activationMissing: [], changed: ['identity'] }] });
        const c = w.make();
        c._set(READY(), 'test');
        await c.applyField('identity.niche');
        assert.equal(w.calls.find((x) => x.method === 'PATCH')!.body.version, null);
    });

    it('applies only what the draft offers: an unknown key, a key the server did not list as drafted, or a prototype is ignored, and nothing is sent', async () => {
        const w = load();
        profileApi(w, { read: 1 });
        const c = w.make();
        c._set(READY(), 'test');
        const out = await c.applyFields(['dm.handoff', 'presenter', '__proto__', 'identity.nonexistent', 'content.rules', '']);
        assert.deepEqual(plain(out), { applied: [], version: null, activationMissing: null });
        assert.equal(w.calls.length, 0, 'no request at all');
    });

    it('with no finished draft there is nothing to apply', async () => {
        const w = load();
        const c = w.make();
        c._set(WORKING(), 'test');
        assert.deepEqual(plain((await c.applyFields(['identity.niche'])).applied), []);
        assert.equal(w.calls.length, 0);
    });

    it('a version conflict is retried once, against the version the server names: a patch is by path, so a newer profile is no reason to refuse it', async () => {
        const w = load();
        profileApi(w, { read: 7, patchAnswers: [httpError(409, { code: 'PROFILE_VERSION_CONFLICT', currentVersion: 9 }), { version: 10, activationMissing: [], changed: ['identity'] }] });
        const c = w.make();
        c._set(READY(), 'test');
        const out = await c.applyField('identity.niche');
        const patches = w.calls.filter((x) => x.method === 'PATCH');
        assert.deepEqual(patches.map((p) => p.body.version), [7, 9]);
        assert.deepEqual(patches[0]!.body.patch, patches[1]!.body.patch);
        assert.equal(out.version, 10);
    });

    it('a second conflict is the caller\'s to see, and so is any other refusal, with the server\'s own problems', async () => {
        const w = load();
        profileApi(w, { read: 7, patchAnswers: [httpError(409, { code: 'PROFILE_VERSION_CONFLICT', currentVersion: 8 }), httpError(409, { code: 'PROFILE_VERSION_CONFLICT', currentVersion: 9 })] });
        const c = w.make();
        c._set(READY(), 'test');
        await assert.rejects(c.applyField('identity.niche'), (e: any) => e.status === 409);
        assert.equal(w.calls.filter((x) => x.method === 'PATCH').length, 2);

        const w2 = load();
        profileApi(w2, { read: 1, patchAnswers: [httpError(400, { code: 'PROFILE_INVALID', problems: ['identity.niche is too long'] })] });
        const c2 = w2.make();
        c2._set(READY(), 'test');
        await assert.rejects(c2.applyField('identity.niche'), (e: any) => e.status === 400 && e.body.problems[0] === 'identity.niche is too long');
        assert.deepEqual(c2.fieldsToFill().some((f: { key: string }) => f.key === 'identity.niche'), true, 'a refused field is still there to fix and try again');
    });
});

describe('a draft is data: this module builds no markup', () => {
    it('writes no HTML, evaluates nothing and touches no page', () => {
        const source = readFileSync(SOURCE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|createElement|appendChild|dangerouslySet|html`/);
    });

    it('a value that is markup stays a string all the way to the patch', async () => {
        const w = load();
        w.reply('/profile', 'GET', () => ({ version: 1, profile: {} }));
        w.reply('/profile', 'PATCH', () => ({ version: 2, activationMissing: [] }));
        const view = READY();
        view.draft.profile.identity.niche = '<img src=x onerror="alert(1)">';
        const c = w.make();
        c._set(view, 'test');
        assert.equal(c.fields().find((f: { key: string }) => f.key === 'identity.niche').value, '<img src=x onerror="alert(1)">');
        await c.applyField('identity.niche');
        assert.equal(w.calls.find((x) => x.method === 'PATCH')!.body.patch.identity.niche, '<img src=x onerror="alert(1)">');
    });

    it('is registered as a module that is not a route, so a hash can never land on it', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /draft_client: \{ src: 'draft_client', page: \(\) => DraftClient, routable: false \}/);
    });
});

describe('the Tenants screen starts the draft right after creating a tenant (D6)', () => {
    interface Created { id: string; invite: unknown | null }

    function tenantsPage(created: Created | null, options: { requestThrows?: boolean } = {}) {
        const requests: Array<{ path: string; init: { method?: string; body?: string } }> = [];
        const closed: string[] = [];
        const sandbox: Record<string, unknown> = {
            t: (k: string) => k, html: (s: TemplateStringsArray) => s.join(''), esc: (s: unknown) => String(s),
            UI: {
                formBusy: () => () => undefined, closeModal: () => closed.push('closed'), toast: () => undefined,
                captureFocus: () => null, restoreFocus: () => undefined, registerActions: () => undefined,
            },
            App: { refreshSession: async () => undefined, go: () => undefined, DEFAULT_PAGE: 'overview', loadPageModule: async () => null },
            API: {
                createAdminTenant: async () => created,
                request: (path: string, init: { method?: string; body?: string }) => {
                    requests.push({ path, init });
                    if (options.requestThrows) throw new Error('offline');
                    return new Promise(() => undefined); // the long request: never answers during the test
                },
            },
            FormData: class { constructor(private readonly form: { values: Record<string, string> }) {} get(key: string) { return this.form.values[key] ?? null; } },
            console, Object, Array, String, Promise, encodeURIComponent,
        };
        vm.createContext(sandbox);
        vm.runInContext(readFileSync('dashboard/js/pages/tenants.js', 'utf8'), sandbox, { filename: 'tenants.js' });
        const page = vm.runInContext('TenantsPage', sandbox) as { handleCreate(form: unknown, event: unknown): Promise<void>; render: () => void };
        page.render = () => undefined;
        const submit = (values: Record<string, string>, dataset: Record<string, string> = {}) => page.handleCreate({ values, dataset }, { preventDefault: () => undefined });
        return { submit, requests, closed };
    }

    it('fires advance for the new tenant, un-awaited: the request is on its way and the dialog is already closed', async () => {
        const page = tenantsPage({ id: 'a b', invite: { url: 'x' } });
        await page.submit({ name: 'Noor', instagram_username: '@noor.perfumes', website: 'noor.example', lang: 'ar' });
        assert.deepEqual(plain(page.requests), [{ path: '/admin/tenants/a%20b/draft/advance', init: { method: 'POST', body: '{}' } }]);
        assert.deepEqual(page.closed, ['closed'], 'nothing waited for the draft');
    });

    it('with only a handle, or only a site, there is something to read', async () => {
        const handle = tenantsPage({ id: 't1', invite: {} });
        await handle.submit({ name: 'A', instagram_username: 'a' });
        const site = tenantsPage({ id: 't2', invite: {} });
        await site.submit({ name: 'B', website: 'b.example' });
        assert.equal(handle.requests.length + site.requests.length, 2);
    });

    it('not for a tenant with nothing to read, not for one made with a Meta connection (no invite), and not on the first-run screen', async () => {
        const nothing = tenantsPage({ id: 't1', invite: {} });
        await nothing.submit({ name: 'A' });
        const connected = tenantsPage({ id: 't2', invite: null });
        await connected.submit({ name: 'B', instagram_username: 'b', instagram_page_id: '1784', page_access_token: 'tok' });
        const first = tenantsPage({ id: 't3', invite: {} });
        await first.submit({ name: 'C', instagram_page_id: '1784', page_access_token: 'tok' }, { firstRun: 'true' });
        assert.deepEqual([nothing.requests.length, connected.requests.length, first.requests.length], [0, 0, 0]);
    });

    it('a page whose request cannot even be made still finishes creating the tenant', async () => {
        const page = tenantsPage({ id: 't1', invite: {} }, { requestThrows: true });
        await page.submit({ name: 'A', website: 'a.example' });
        assert.deepEqual(page.closed, ['closed']);
    });
});
