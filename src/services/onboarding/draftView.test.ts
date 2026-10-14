/**
 * A draft row as the API shows it (P24). Two audiences read one shape: the wizard polls it every few seconds and must never be handed
 * what a stranger's web page said or what a provider said about a key; the operator sees the rest. And the readers of the JSON columns
 * answer null for anything that is not what this engine wrote, because a poll must not throw.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DraftRow } from './draftStore.js';
import { emptyUsage, type FetchedBundle, type ResultColumn, type SourcesStatus } from './draftTypes.js';
import { readAnswers, readBundle, readColumn, readSourcesStatus, readUsage, stepRowOf, TENANT_ERROR_TEXT, toDraftView } from './draftView.js';
import { validateDraft } from './validateDraft.js';
import { STORE_CANDIDATES, STORE_SOURCES, storeSignals } from './fixtures/draftAnswers.js';

const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);
const at = (ms: number): Date => new Date(NOW + ms);

const ok = { state: 'ok', via: 'x', kind: null, retryable: false, message: null, ms: 5, counts: {} } as const;
const STATUS: SourcesStatus = { instagram: { ...ok }, website: { ...ok }, youtube: { ...ok, state: 'skipped', kind: 'no_input' }, typed: { ...ok, state: 'skipped', kind: 'no_input' } };

const bundle = (): FetchedBundle => ({
    version: 1, sources: STORE_SOURCES, candidates: STORE_CANDIDATES, signals: storeSignals(),
    facts: {
        handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 10, mediaCount: 5, siteHost: 'noor-perfumes.example', site: null, brand: null, logos: [], socialLinks: {}, youtube: null,
        knownUrls: ['https://secret-known.example/'], knownEmails: ['known@example.com'], knownPhones: ['966501234567'], keywordsInUse: ['kw'],
    },
});

const result = (stage: 'final' | 'prefill'): ResultColumn => ({
    stage, result: validateDraft({}, { sources: STORE_SOURCES, signals: storeSignals() }), code: { handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 10, mediaCount: 5, siteHost: null, site: null, brand: null, logos: [], socialLinks: {}, youtube: null },
    models: { voice: { provider: 'anthropic', model: 'claude-opus-5-5' } }, promptVersion: 'profile_draft_v1',
});

const row = (over: Partial<DraftRow> = {}): DraftRow => ({
    id: '00000000-0000-4000-8000-000000000001', creator_id: '00000000-0000-4000-8000-000000000100', origin: 'wizard',
    requested_by: null, inputs: { instagram: 'noor.perfumes', website: 'https://noor-perfumes.example/', youtube: null, about: 'private about text', via: 'discovery' },
    inputs_hash: 'h', prompt_version: 'profile_draft_v1', status: 'queued', attempts: 0, next_attempt_at: null, lease_until: null, lease_owner: null,
    sources: null, sources_status: null, draft: null, partial: false, usage: null, error: null, error_kind: null,
    created_at: at(-60_000), updated_at: at(-30_000), finished_at: null, ...over,
});

const view = (r: DraftRow, audience: 'tenant' | 'admin' = 'tenant') => toDraftView(r, { audience, nowMs: NOW });

describe('toDraftView: where the draft is', () => {
    it('a queued draft is advanceable, not being worked on, and carries no draft', () => {
        const v = view(row());
        assert.deepEqual([v.status, v.advanceable, v.working, v.retryAt, v.draft, v.prefill, v.needsAiKey], ['queued', true, false, null, null, null, false]);
    });

    it('a draft somebody holds is "working" and not advanceable; its lease running out makes it advanceable again (the wizard fires advance then)', () => {
        const held = view(row({ status: 'drafting', sources: bundle(), lease_owner: 'a', lease_until: at(100_000) }));
        assert.deepEqual([held.working, held.advanceable], [true, false]);
        const lapsed = view(row({ status: 'drafting', sources: bundle(), lease_owner: 'a', lease_until: at(-1) }));
        assert.deepEqual([lapsed.working, lapsed.advanceable], [false, true]);
    });

    it('a retry that is not due says when, and is not advanceable until then', () => {
        const waiting = view(row({ status: 'fetching', attempts: 1, next_attempt_at: at(45_000), error: 'x', error_kind: 'no_source' }));
        assert.equal(waiting.retryAt, at(45_000).toISOString());
        assert.equal(waiting.advanceable, false);
        const due = view(row({ status: 'fetching', attempts: 1, next_attempt_at: at(-1) }));
        assert.deepEqual([due.retryAt, due.advanceable], [null, true]);
    });

    it('a finished draft is nothing to advance', () => {
        for (const status of ['ready', 'failed', 'superseded'] as const) assert.equal(view(row({ status, finished_at: at(0) })).advanceable, false, status);
    });

    it('one older than 30 minutes is advanceable, because advancing it ends it', () => {
        assert.equal(view(row({ created_at: at(-31 * 60_000) })).advanceable, true);
    });
});

describe('toDraftView: what a ready draft shows', () => {
    const ready = row({ status: 'ready', sources: bundle(), sources_status: STATUS, draft: result('final'), finished_at: at(-1_000), usage: { ...emptyUsage(), totals: { usd: 0.31, usage_in: 10, usage_out: 5 } } });

    it('carries the checked draft with what code found, and never the text that was read', () => {
        const v = view(ready);
        assert.ok(v.draft && v.draft.profile && v.draft.provenance && v.draft.flags && v.draft.code);
        assert.deepEqual(v.draft!.models, { voice: { provider: 'anthropic', model: 'claude-opus-5-5' } });
        assert.deepEqual(v.sources.map((s) => s.id), STORE_SOURCES.map((s) => s.id));
        assert.deepEqual(Object.keys(v.sources[0]!).sort(), ['id', 'kind']);
        const text = JSON.stringify(v);
        assert.equal(text.includes('متجر نور للعطور 🌹'), false, 'a source\'s text is never in the view');
        assert.equal(text.includes('secret-known.example'), false, 'nor are the lists only validateDraft reads');
        assert.equal(text.includes('private about text'), false, 'nor the text the tenant pasted');
        assert.equal(v.inputs.hasAbout, true);
    });

    it('an unfinished draft shows no draft even if its column holds one', () => {
        assert.equal(view(row({ status: 'drafting', sources: bundle(), draft: result('final') })).draft, null);
    });

    it('a tenant sees how each source went but not what the platform said about its own account: the message is the operator\'s', () => {
        const noisy: SourcesStatus = { ...STATUS, instagram: { ...STATUS.instagram, state: 'failed', kind: 'no_access', retryable: false, message: 'The platform\'s Instagram token was rejected (code 190).' } };
        const r = row({ status: 'ready', sources: bundle(), sources_status: noisy, draft: result('final'), finished_at: at(0) });
        const tenant = view(r);
        assert.deepEqual([tenant.sourcesStatus!.instagram.state, tenant.sourcesStatus!.instagram.kind, tenant.sourcesStatus!.instagram.retryable], ['failed', 'no_access', false]);
        assert.equal(tenant.sourcesStatus!.instagram.message, null);
        assert.equal(JSON.stringify(tenant).includes('token was rejected'), false);
        assert.equal(view(r, 'admin').sourcesStatus!.instagram.message, 'The platform\'s Instagram token was rejected (code 190).');
    });

    it('the usage and cost are the operator\'s, not the tenant\'s', () => {
        assert.equal('usage' in view(ready, 'tenant'), false);
        assert.equal(view(ready, 'admin').usage?.totals.usd, 0.31);
    });
});

describe('toDraftView: a failure', () => {
    const failed = (kind: string, message: string) => row({ status: 'failed', error_kind: kind, error: message, finished_at: at(-1), sources: bundle(), draft: result('prefill'), sources_status: STATUS });

    it('a tenant gets the kind and a fixed sentence, never the provider\'s own words', () => {
        const v = view(failed('auth', 'invalid x-api-key: sk-ant-REDACTED-but-the-key-was-here'));
        assert.deepEqual(v.error, { kind: 'auth', message: TENANT_ERROR_TEXT.auth });
        assert.equal(JSON.stringify(v).includes('x-api-key'), false);
        assert.equal(view(failed('some_new_kind', 'x')).error?.message, 'The draft could not be made. You can fill this in yourself.');
    });

    it('an operator gets what the provider said', () => {
        assert.equal(view(failed('auth', 'invalid x-api-key'), 'admin').error?.message, 'invalid x-api-key');
    });

    it('no provider says "needs an AI key", and keeps what code found as a prefill, not as a draft', () => {
        const v = view(failed('no_provider', 'No AI provider has a key.'));
        assert.equal(v.needsAiKey, true);
        assert.equal(v.draft, null);
        assert.ok(v.prefill && v.prefill.code.handle === 'noor.perfumes');
        assert.match(v.error!.message, /needs an AI key/);
        assert.equal(view(failed('timeout', 't')).needsAiKey, false);
    });

    it('every kind a draft can end with has a sentence for the tenant', () => {
        for (const kind of ['no_provider', 'auth', 'quota', 'budget', 'rate', 'server', 'timeout', 'refusal', 'max_tokens', 'bad_output', 'bad_request', 'no_source', 'expired', 'abandoned', 'internal']) {
            assert.ok(TENANT_ERROR_TEXT[kind] && TENANT_ERROR_TEXT[kind]!.length > 20, kind);
        }
    });

    it('while it is being retried, the last try\'s error is shown, so the wizard can say what it is waiting out', () => {
        const v = view(row({ status: 'drafting', sources: bundle(), attempts: 1, next_attempt_at: at(30_000), error_kind: 'timeout', error: 'slow' }));
        assert.equal(v.error?.kind, 'timeout');
        assert.equal(v.status, 'drafting');
    });
});

describe('the readers of the JSON columns never throw', () => {
    const junk: unknown[] = [null, undefined, 0, 'x', [], [1], {}, { version: 2 }, { stage: 'answers' }, { stage: 'final', result: null }, { stage: 'nope' }];

    it('answer null for anything this engine did not write', () => {
        for (const value of junk) {
            assert.equal(readBundle(value), null, JSON.stringify(value));
            assert.equal(readColumn(value), null, JSON.stringify(value));
            assert.equal(readSourcesStatus(value), null, JSON.stringify(value));
            assert.equal(readUsage(value), null, JSON.stringify(value));
        }
    });

    it('readAnswers always has both calls, empty when there is nothing', () => {
        for (const value of junk) assert.deepEqual(readAnswers(value), { voice: { errors: [], gaveUp: false }, business: { errors: [], gaveUp: false } });
        const stored = readAnswers({ stage: 'answers', calls: { voice: { answer: { a: 1 }, errors: [], gaveUp: false, provider: 'p', model: 'm' }, business: { errors: [{ kind: 'timeout', retryable: true, message: 'x' }], gaveUp: false } } });
        assert.deepEqual(stored.voice, { answer: { a: 1 }, errors: [], gaveUp: false, provider: 'p', model: 'm' });
        assert.equal(stored.business.answer, undefined);
        assert.equal(stored.business.errors.length, 1);
    });

    it('a view of a row whose JSON is junk is still a view', () => {
        const v = view(row({ status: 'drafting', sources: { version: 99 }, sources_status: 'x', draft: [1], usage: 5 }));
        assert.deepEqual([v.sources, v.sourcesStatus, v.draft, v.prefill], [[], null, null, null]);
    });

    it('stepRowOf says whether the sources are stored', () => {
        assert.equal(stepRowOf(row()).hasSources, false);
        assert.equal(stepRowOf(row({ sources: bundle() })).hasSources, true);
    });
});
