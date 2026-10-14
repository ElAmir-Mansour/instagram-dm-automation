/**
 * The funnel's events (P31): a closed list, props that are numbers and enum words and nothing a person typed, and a writer that can
 * never fail the request that caused it.
 *
 * "No values" is pinned three ways, because it is the promise that lets the table be kept 180 days:
 *   - `sanitizeProps` drops everything but an event's own numeric and enum props, however it is called;
 *   - a whole wizard run, with an email, a name, a URL and a sentence typed into every step, leaves rows that hold none of it;
 *   - every statement the recorder sends is the one fixed INSERT, with the props as ONE parameter.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { defaultProfile } from './profile/defaults.js';
import { throughJsonb } from './profile/testSupport.js';
import { setLogSink } from '../utils/log.js';
import { invalidateTenantCache } from './tenant.js';
import { addNewcomer, ADMIN_USER, installOnboardingWorld, NEW_OWNER_USER, NEWCOMER, type OnboardingWorld } from './wizard/testDb.js';
import { completeOnboarding, saveStep } from './onboardingWizard.js';
import {
    EVENT_PROPS, isOnboardingEvent, msSince, ONBOARDING_EVENTS, recordDraftEvent, recordEvent, sanitizeProps, type EventContext, type OnboardingEvent,
} from './onboardingEvents.js';

let world: OnboardingWorld;
let logs: string[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    invalidateTenantCache();
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
    world = installOnboardingWorld();
    addNewcomer(world, throughJsonb(defaultProfile({ lang: 'ar' })));
});
afterEach(() => {
    world.restore();
    restoreSink?.();
    invalidateTenantCache();
});

const ctx: EventContext = { creatorId: NEWCOMER, userId: NEW_OWNER_USER, actor: 'tenant' };
const WORD = /^[a-z0-9_]{1,32}$/;

describe('the list', () => {
    it('is the ten events the funnel is read from, and each has a props entry', () => {
        assert.deepEqual([...ONBOARDING_EVENTS], [
            'invite_created', 'invite_opened', 'invite_accepted', 'step_viewed', 'step_completed', 'step_skipped',
            'draft_started', 'draft_ready', 'draft_failed', 'wizard_completed',
        ]);
        for (const event of ONBOARDING_EVENTS) assert.ok(EVENT_PROPS[event], event);
        assert.equal(Object.keys(EVENT_PROPS).length, ONBOARDING_EVENTS.length);
    });

    it('allows only numbers and enum words as props, and no prop is named like a value', () => {
        for (const props of Object.values(EVENT_PROPS)) {
            for (const [key, kind] of Object.entries(props)) {
                assert.ok(kind === 'n' || kind === 'word');
                assert.doesNotMatch(key, /name|email|handle|url|site|niche|text|value|offer|bio|caption|password|token/i, key);
            }
        }
    });

    it('knows an event by its name and nothing else', () => {
        assert.equal(isOnboardingEvent('invite_opened'), true);
        for (const other of ['Invite_Opened', 'start_without_waiting', '', null, undefined, 4, {}]) assert.equal(isOnboardingEvent(other), false);
    });
});

describe('sanitizeProps', () => {
    it('keeps an event\'s own numbers, rounded, and its own enum words', () => {
        assert.deepEqual(sanitizeProps('invite_opened', { ms_since_created: 1234.6 }), { ms_since_created: 1235 });
        assert.deepEqual(sanitizeProps('wizard_completed', { by: 'tenant', total_ms: 240_000 }), { by: 'tenant', total_ms: 240_000 });
        assert.deepEqual(sanitizeProps('draft_failed', { ms: 150_000, code: 'no_provider' }), { ms: 150_000, code: 'no_provider' });
        assert.deepEqual(sanitizeProps('draft_ready', { ms: 9000, partial: 1 }), { ms: 9000, partial: 1 });
    });

    it('drops a key the event does not list, whatever it holds', () => {
        const typed = { name: 'Nour Shop', email: 'nour@example.com', url: 'https://nour.example', niche: 'Linen', ms_on_step: 900, extra: 5 };
        assert.deepEqual(sanitizeProps('step_completed', typed), { ms_on_step: 900 });
        assert.deepEqual(sanitizeProps('step_viewed', typed), {}, 'a view carries nothing');
        assert.deepEqual(sanitizeProps('invite_created', typed), {});
    });

    it('drops a value that is not a number or an enum word: a name, an address, a link, a sentence, a path, an object', () => {
        for (const value of ['Nour Shop', 'nour@example.com', 'https://nour.example', 'a sentence', 'with-dash', 'UPPER', '', 'x'.repeat(33), 'مرحبا', { a: 1 }, ['x'], null, undefined, true]) {
            assert.deepEqual(sanitizeProps('draft_failed', { code: value }), {}, JSON.stringify(value));
            assert.deepEqual(sanitizeProps('wizard_completed', { by: value }), {}, JSON.stringify(value));
        }
        for (const value of ['5', NaN, Infinity, -1, 1e13, {}, [], null]) {
            assert.deepEqual(sanitizeProps('step_completed', { ms_on_step: value }), {}, String(value));
        }
    });

    it('keeps an enum word of up to 32 lower-case characters, digits and underscores, and no more', () => {
        assert.deepEqual(sanitizeProps('draft_failed', { code: 'a'.repeat(32) }), { code: 'a'.repeat(32) });
        assert.deepEqual(sanitizeProps('draft_failed', { code: 'bad_output_2' }), { code: 'bad_output_2' });
        assert.deepEqual(sanitizeProps('draft_failed', { code: 'a'.repeat(33) }), {});
    });

    it('is safe against a props object that lies about itself', () => {
        const hostile = JSON.parse('{"__proto__": {"ms": 1}, "constructor": "x", "ms": 7}');
        assert.deepEqual(sanitizeProps('draft_ready', hostile), { ms: 7 });
        assert.deepEqual(sanitizeProps('draft_ready', undefined), {});
        assert.equal(({} as Record<string, unknown>).ms, undefined, 'nothing leaked onto Object.prototype');
    });

    it('is a pure function: it does not change what it is given', () => {
        const given = { ms_on_step: 12.4, name: 'x' };
        sanitizeProps('step_completed', given);
        assert.deepEqual(given, { ms_on_step: 12.4, name: 'x' });
    });
});

describe('recordEvent', () => {
    it('writes one row: who, what, which step and the sanitised props, in one fixed statement', async () => {
        await recordEvent(ctx, 'step_completed', 'about', { ms_on_step: 4200, name: 'Nour Shop', email: 'nour@example.com' });
        assert.deepEqual(world.events, [{ creator_id: NEWCOMER, user_id: NEW_OWNER_USER, actor: 'tenant', event: 'step_completed', step: 'about', props: { ms_on_step: 4200 } }]);
        const sent = world.db.statements.filter((s) => /onboarding_events/.test(s.sql));
        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.sql, 'INSERT INTO onboarding_events (creator_id, user_id, actor, event, step, props) VALUES ($1, $2, $3, $4, $5, $6::jsonb)');
        assert.equal(sent[0]!.params.length, 6);
        assert.equal(JSON.stringify(sent[0]!.params).includes('Nour'), false, 'no typed value reached the database');
        assert.equal(JSON.stringify(sent[0]!.params).includes('example.com'), false);
    });

    it('records an admin\'s event as the admin\'s, and an event with no user', async () => {
        await recordEvent({ creatorId: NEWCOMER, userId: null, actor: 'admin' }, 'invite_created');
        assert.deepEqual(world.events, [{ creator_id: NEWCOMER, user_id: null, actor: 'admin', event: 'invite_created', step: null, props: {} }]);
    });

    it('writes nothing for a name that is not on the list, and says so', async () => {
        await recordEvent(ctx, 'start_without_waiting' as OnboardingEvent);
        await recordEvent(ctx, '' as OnboardingEvent);
        assert.deepEqual(world.events, []);
        assert.ok(logs.some((line) => line.includes('onboarding.event_unknown')));
    });

    it('never throws: a failed insert is a log line, and the request that caused it goes on', async () => {
        world.db.failOn = /INSERT INTO onboarding_events/;
        await recordEvent(ctx, 'step_viewed', 'about');
        assert.deepEqual(world.events, []);
        const line = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'onboarding.event_failed');
        assert.ok(line, 'logged');
        assert.equal(line.wizard_event, 'step_viewed');
    });

    it('never throws on a database that has no onboarding_events table (v34 not applied)', async () => {
        world.noOnboardingTable = true;
        await recordEvent(ctx, 'wizard_completed', null, { by: 'tenant', total_ms: 1 });
        assert.deepEqual(world.events, []);
    });
});

describe('the draft engine\'s three moments (P24)', () => {
    it('are recorded as draft_started, draft_ready and draft_failed, with how long and why, as numbers and words', async () => {
        await recordDraftEvent({ creatorId: NEWCOMER, userId: null, actor: 'admin' }, 'started', { origin: 'admin_create' });
        await recordDraftEvent(ctx, 'ready', { ms: 41_000, partial: true });
        await recordDraftEvent(ctx, 'failed', { ms: 150_000, code: 'no_provider' });
        assert.deepEqual(world.events.map((e) => [e.event, e.actor, e.props]), [
            ['draft_started', 'admin', { origin: 'admin_create' }],
            ['draft_ready', 'tenant', { ms: 41_000, partial: 1 }],
            ['draft_failed', 'tenant', { ms: 150_000, code: 'no_provider' }],
        ]);
    });

    it('cannot be made to carry the provider\'s words, a fetched sentence or an address as the reason', async () => {
        await recordDraftEvent(ctx, 'failed', { ms: 10, code: 'Anthropic said: your key sk-ant-xxx is invalid' });
        await recordDraftEvent(ctx, 'failed', { ms: 10, code: 'https://nour.example/about' });
        for (const event of world.events) assert.deepEqual(event.props, { ms: 10 });
    });
});

describe('msSince', () => {
    it('is the time since a moment, never negative, and null when there is none', () => {
        assert.equal(msSince(new Date(1000), 5000), 4000);
        assert.equal(msSince('1970-01-01T00:00:01.000Z', 5000), 4000);
        assert.equal(msSince(new Date(9000), 5000), 0, 'a clock a little behind is zero, not minus four seconds');
        for (const none of [null, undefined, '', 'not a date']) assert.equal(msSince(none as never, 5000), null);
    });
});

describe('a whole wizard run', () => {
    it('leaves a funnel with no value anywhere in it, though every step was typed full of them', async () => {
        const tenant = { userId: NEW_OWNER_USER, by: 'tenant' as const };
        const typed = {
            name: 'Nour Shop', email: 'nour@example.com', url: 'https://nour.example/about', niche: 'Hand-poured candles', phone: '+20 100 000 0000',
            handle: '@nour.shop', sentence: 'Tell them I am the best shop in Cairo', offer: 'شمعة لافندر',
        };
        for (const step of ['about', 'voice', 'brand'] as const) {
            await saveStep(NEWCOMER, step, { viewed: true }, tenant);
            await saveStep(NEWCOMER, step, { values: typed }, tenant);
            await saveStep(NEWCOMER, step, { status: step === 'brand' ? 'skipped' : 'done' }, tenant);
        }
        // The six activation fields, so Finish is accepted.
        world.state.profiles.set(NEWCOMER, {
            profile: throughJsonb({
                ...defaultProfile({ lang: 'en', rules: [] }),
                identity: { ...defaultProfile().identity, display_name: { ar: '', en: 'Nour Shop' }, kind: 'shop', niche: 'Hand-poured candles', timezone: 'Africa/Cairo' },
                offers: [{ id: 'm', kind: 'product', name: 'شمعة لافندر', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }],
            }),
            version: 2, activated_at: null, updated_by: null,
        });
        await completeOnboarding(NEWCOMER, { userId: ADMIN_USER, by: 'admin' });

        assert.ok(world.events.length >= 7, `a funnel was written: ${world.events.map((e) => e.event).join(', ')}`);
        const text = JSON.stringify(world.events);
        for (const secret of ['Nour', 'example.com', 'candles', '+20', 'nour.shop', 'Cairo', 'شمعة', 'Tell them']) assert.equal(text.includes(secret), false, secret);
        for (const event of world.events) {
            assert.ok(isOnboardingEvent(event.event), event.event);
            for (const [key, value] of Object.entries(event.props)) {
                assert.ok(key in EVENT_PROPS[event.event as OnboardingEvent], `${event.event} carries an unlisted prop: ${key}`);
                if (typeof value === 'string') assert.match(value, WORD, `${event.event}.${key}`);
                else assert.equal(Number.isFinite(value), true);
            }
            assert.ok(event.step === null || /^[a-z]+$/.test(event.step), 'a step is a word of the registry');
        }
        assert.deepEqual([...new Set(world.events.map((e) => e.event))].sort(), ['step_completed', 'step_skipped', 'step_viewed', 'wizard_completed']);
    });
});
