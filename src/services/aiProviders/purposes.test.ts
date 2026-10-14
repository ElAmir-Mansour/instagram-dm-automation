/**
 * The closed list of purposes (`purposes.ts`): what a route can be saved for, and the two labels `ai_usage` can carry that are not routes.
 * The routing, the Mac guard and the card are tested where they live (route.test.ts, adminAi.test.ts, dashboard/ai-providers.test.ts);
 * this is the list itself, so that adding a purpose fails here, in one place, until it has everything a purpose needs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EFFORTS } from '../llm/types.js';
import { AI_PURPOSES, EVAL, isAiPurpose, KEY_TEST, KEY_TEST_EFFORT, MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT, type UsagePurpose } from './purposes.js';
import { ProviderKeys } from './settings.js';
import { describeAi } from './view.js';

describe('AI_PURPOSES', () => {
    it('is the five existing purposes in their order, then `dm`', () => {
        assert.deepEqual([...AI_PURPOSES], ['onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm']);
    });

    it('has a default effort for every purpose, a real level each, and no other keys', () => {
        assert.deepEqual(Object.keys(PURPOSE_DEFAULT_EFFORT).sort(), [...AI_PURPOSES].sort());
        for (const purpose of AI_PURPOSES) assert.ok((EFFORTS as readonly string[]).includes(PURPOSE_DEFAULT_EFFORT[purpose]), purpose);
    });
});

describe('the `dm` purpose', () => {
    it('is a purpose a route can be saved for', () => {
        assert.equal(isAiPurpose('dm'), true);
    });

    it('thinks as little as a route lets it: a DM is answered while the person waits', () => {
        assert.equal(PURPOSE_DEFAULT_EFFORT.dm, 'low');
    });

    it('is not Mac-brain work: the Mac is a job queue and cannot answer in seconds, and tenant work must not go through his plan', () => {
        assert.equal(MAC_BRAIN_PURPOSES.has('dm'), false);
    });

    it('is described to the card with its default effort, unguarded, and nothing saved', () => {
        const budgets = { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null };
        const view = describeAi({ providers: {}, routing: {}, prices: {}, budgets }, new ProviderKeys(new Map(), new Set()));
        const dm = view.purposes.find((p) => p.purpose === 'dm');
        assert.ok(dm, 'the card is given a dm row');
        assert.equal(dm.defaultEffort, 'low');
        assert.equal(dm.macBrainGuarded, false);
        assert.equal(dm.saved, null);
    });
});

describe('the tenant purposes (P32): tenant_monteur_think, tenant_infographic, tenant_studio', () => {
    it('are purposes a route can be saved for, at the efforts 06 names', () => {
        for (const [purpose, effort] of [['tenant_monteur_think', 'high'], ['tenant_infographic', 'high'], ['tenant_studio', 'medium']] as const) {
            assert.equal(isAiPurpose(purpose), true, purpose);
            assert.equal(PURPOSE_DEFAULT_EFFORT[purpose], effort, purpose);
        }
    });

    it('the Monteur and the infographic are the Mac’s work, so the router refuses them for the owner; the Studio writer is not, so the owner’s is decided by who is asking, not by the router', () => {
        assert.deepEqual([...MAC_BRAIN_PURPOSES].sort(), ['tenant_infographic', 'tenant_monteur_think']);
        assert.equal(MAC_BRAIN_PURPOSES.has('tenant_studio'), false);
    });

    it('are described to the card with their guard: the two the Mac does, guarded; the Studio writer, not', () => {
        const budgets = { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null };
        const view = describeAi({ providers: {}, routing: {}, prices: {}, budgets }, new ProviderKeys(new Map(), new Set()));
        const row = (purpose: string) => view.purposes.find((p) => p.purpose === purpose)!;
        assert.deepEqual(['tenant_monteur_think', 'tenant_infographic', 'tenant_studio'].map((p) => [row(p).defaultEffort, row(p).macBrainGuarded]), [['high', true], ['high', true], ['medium', false]]);
    });
});

describe('the usage labels', () => {
    it('`eval` and `key_test` label spend and are not purposes: nothing can be routed for them', () => {
        assert.equal(EVAL, 'eval');
        assert.equal(KEY_TEST, 'key_test');
        for (const label of [EVAL, KEY_TEST]) {
            assert.equal(isAiPurpose(label), false, label);
            assert.equal((AI_PURPOSES as readonly string[]).includes(label), false, label);
        }
    });

    it('a UsagePurpose is a purpose or one of the two labels, so a harness can ask for the `dm` route and be recorded as `eval`', () => {
        const labels: UsagePurpose[] = [...AI_PURPOSES, KEY_TEST, EVAL];
        assert.equal(new Set(labels).size, AI_PURPOSES.length + 2);
    });

    it('a Test asks for no thinking at all', () => {
        assert.equal(KEY_TEST_EFFORT, 'low');
    });

    it('does not accept values that only look like purposes', () => {
        for (const value of ['DM', 'dm ', 'dms', 'eval', '', null, undefined, 5, {}, ['dm']]) assert.equal(isAiPurpose(value), false, JSON.stringify(value));
    });
});
