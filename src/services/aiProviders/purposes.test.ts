/**
 * The closed list of purposes (`purposes.ts`): what a route can be saved for, and the two labels `ai_usage` can carry that are not routes.
 * The routing, the Mac guard and the card are tested where they live (route.test.ts, adminAi.test.ts, dashboard/ai-providers.test.ts);
 * this is the list itself, so that adding a purpose fails here, in one place, until it has everything a purpose needs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EFFORTS } from '../llm/types.js';
import {
    AI_PURPOSES, EVAL, isAiPurpose, isContributorModel, KEY_TEST, KEY_TEST_EFFORT, MAC_BRAIN_PURPOSES, NO_TRAINING_PROVIDERS, PERCEPTION_VOICE, PROVIDER_PURPOSE_ALLOWLIST,
    providerMayAnswer, providerPurposeReason, PURPOSE_ALLOWLIST_REASON, PURPOSE_DEFAULT_EFFORT, PURPOSE_PROVIDER_ALLOWLIST, PURPOSE_ROUTE_FALLBACK, TRANSCRIBE, type UsagePurpose,
} from './purposes.js';
import { PROVIDER_IDS } from '../llm/registry.js';
import { ProviderKeys } from './settings.js';
import { describeAi } from './view.js';

describe('AI_PURPOSES', () => {
    it('is the five existing purposes in their order, then `dm`, `dm_whatsapp`, the two ads purposes and the four Muse purposes', () => {
        assert.deepEqual([...AI_PURPOSES], [
            'onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm', 'dm_whatsapp', 'ads_draft', 'ads_review',
            'perception_dm', 'recall', 'reel_index', 'comment_intent',
        ]);
    });

    it('has a default effort for every purpose, a real level each, and no other keys', () => {
        assert.deepEqual(Object.keys(PURPOSE_DEFAULT_EFFORT).sort(), [...AI_PURPOSES].sort());
        for (const purpose of AI_PURPOSES) assert.ok((EFFORTS as readonly string[]).includes(PURPOSE_DEFAULT_EFFORT[purpose]), purpose);
    });
});

describe('the ads purposes (A7)', () => {
    it('`ads_draft` and `ads_review` are purposes, at effort medium', () => {
        for (const purpose of ['ads_draft', 'ads_review'] as const) {
            assert.equal(isAiPurpose(purpose), true);
            assert.equal(PURPOSE_DEFAULT_EFFORT[purpose], 'medium');
        }
    });

    it('are NOT Mac-brain purposes: that set means "refuse on the layer", and the owner\'s drafts are Studio ads_think jobs instead', () => {
        assert.equal(MAC_BRAIN_PURPOSES.has('ads_draft'), false);
        assert.equal(MAC_BRAIN_PURPOSES.has('ads_review'), false);
    });
});

describe('the Muse purposes (perception_dm, recall, reel_index, comment_intent)', () => {
    const MUSE = ['perception_dm', 'recall', 'reel_index', 'comment_intent'] as const;

    it('are purposes a route can be saved for, each at effort low: a person waits for the answer, and Muse Spark reasons before it gives one', () => {
        for (const purpose of MUSE) {
            assert.equal(isAiPurpose(purpose), true, purpose);
            assert.equal(PURPOSE_DEFAULT_EFFORT[purpose], 'low', purpose);
        }
    });

    it('may be answered by Meta alone, except the reel indexer, which Meta\'s open model at Baseten may answer too: and not WhatsApp\'s list of providers that forbid training', () => {
        for (const purpose of MUSE) assert.deepEqual([...PURPOSE_PROVIDER_ALLOWLIST[purpose]!], purpose === 'reel_index' ? ['meta', 'baseten'] : ['meta'], purpose);
        // Adding Meta to NO_TRAINING_PROVIDERS would open WhatsApp to it and protect nothing on Instagram: it is untouched, and Baseten is not in it either.
        assert.deepEqual([...NO_TRAINING_PROVIDERS], ['groq', 'anthropic', 'openai']);
        assert.deepEqual([...PURPOSE_PROVIDER_ALLOWLIST.dm_whatsapp!], ['groq', 'anthropic', 'openai']);
        assert.equal(PURPOSE_PROVIDER_ALLOWLIST.dm, undefined, '`dm` still takes any provider that may answer it');
        assert.equal(Object.keys(PURPOSE_PROVIDER_ALLOWLIST).length, 5);
    });

    it('have no default route to Meta or anyone: with none saved a purpose is answered by the first provider that has a key, and a borrowed route is WhatsApp\'s alone', () => {
        assert.deepEqual({ ...PURPOSE_ROUTE_FALLBACK }, { dm_whatsapp: 'dm' });
        for (const purpose of MUSE) assert.equal(PURPOSE_ROUTE_FALLBACK[purpose], undefined, purpose);
    });

    it('are not Mac-brain purposes: Muse work runs on the platform\'s key, never on the owner\'s Mac', () => {
        for (const purpose of MUSE) assert.equal(MAC_BRAIN_PURPOSES.has(purpose), false, purpose);
    });

    it('say why only Meta may answer them, in words that are not WhatsApp\'s (the reel indexer\'s also names Baseten), and WhatsApp has none of its own (it keeps the sentence it always had)', () => {
        for (const purpose of MUSE) {
            assert.equal(PURPOSE_ALLOWLIST_REASON[purpose], purpose === 'reel_index'
                ? 'only Meta (Muse), hosted by Meta or by Baseten, is set up to answer this purpose.'
                : 'only Meta (Muse) is set up to answer this purpose.', purpose);
        }
        assert.equal(PURPOSE_ALLOWLIST_REASON.dm_whatsapp, undefined);
    });

    it('are described to the card with their default effort, unguarded, and nothing saved', () => {
        const budgets = { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null };
        const view = describeAi({ providers: {}, routing: {}, prices: {}, budgets }, new ProviderKeys(new Map(), new Set()));
        for (const purpose of MUSE) {
            const row = view.purposes.find((p) => p.purpose === purpose);
            assert.ok(row, `the card is given a ${purpose} row`);
            assert.equal(row.defaultEffort, 'low');
            assert.equal(row.macBrainGuarded, false);
            assert.equal(row.saved, null);
        }
    });
});

describe('Baseten may answer one purpose: reel_index (PROVIDER_PURPOSE_ALLOWLIST)', () => {
    it('is exactly { baseten: [reel_index] }: the one provider that may answer only some purposes', () => {
        assert.deepEqual(Object.keys(PROVIDER_PURPOSE_ALLOWLIST), ['baseten']);
        assert.deepEqual([...PROVIDER_PURPOSE_ALLOWLIST.baseten!], ['reel_index']);
    });

    it('lets Baseten answer reel_index and no other purpose, for every purpose there is, and says nothing about a provider that has no list', () => {
        for (const purpose of AI_PURPOSES) assert.equal(providerMayAnswer('baseten', purpose), purpose === 'reel_index', purpose);
        for (const provider of PROVIDER_IDS) {
            if (provider === 'baseten') continue;
            for (const purpose of AI_PURPOSES) assert.equal(providerMayAnswer(provider, purpose), true, `${provider} ${purpose}`);
        }
    });

    it('gives the refusal words that name Baseten, the one purpose and what never reaches it, and the same shape for any provider that gets a list', () => {
        const reason = providerPurposeReason('Baseten', 'baseten');
        assert.equal(reason, 'Baseten may answer only reel_index: it watches the owner\'s own published reels, and no message, comment or follower data goes to it.');
        assert.ok(reason.length <= 140, 'short enough to sit inside an AiError\'s 240 characters with a route\'s name and advice around it');
    });

    it('keeps the two directions apart: reel_index lists Baseten as a provider that may answer it, and no other purpose lists it', () => {
        assert.ok(PURPOSE_PROVIDER_ALLOWLIST.reel_index!.includes('baseten'));
        for (const purpose of AI_PURPOSES) {
            if (purpose !== 'reel_index') assert.ok(!(PURPOSE_PROVIDER_ALLOWLIST[purpose] ?? []).includes('baseten'), purpose);
        }
    });
});

describe('isContributorModel', () => {
    it('is true for an id that ends -contributor, in any case and with space around it: that twin lets Meta train on what it is sent', () => {
        for (const model of ['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor', 'MUSE-SPARK-1.3-CONTRIBUTOR', '  muse-spark-1.3-contributor\n', 'x-contributor']) {
            assert.equal(isContributorModel(model), true, JSON.stringify(model));
        }
    });

    it('is false for the Standard models, every other provider\'s models, an empty id, and a name that only mentions the word', () => {
        for (const model of ['muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0', 'claude-opus-5-5', 'gemini-3.8-flash', 'openai/gpt-oss-120b', '', 'contributor', 'contributor-guide-v2', 'muse-spark-1.3-contributors']) {
            assert.equal(isContributorModel(model), false, JSON.stringify(model));
        }
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

    it('`perception_voice` labels the spend on a voice note Meta transcribes and is NOT a routable purpose: speech is not a chat model, so there is no row and no route (like `transcribe`)', () => {
        assert.equal(PERCEPTION_VOICE, 'perception_voice');
        assert.equal(isAiPurpose(PERCEPTION_VOICE), false);
        assert.equal((AI_PURPOSES as readonly string[]).includes(PERCEPTION_VOICE), false);
        assert.equal(Object.keys(PURPOSE_DEFAULT_EFFORT).includes(PERCEPTION_VOICE), false);
        const label: UsagePurpose = PERCEPTION_VOICE;
        assert.equal(label, 'perception_voice');
    });

    it('`transcribe` labels speech-to-text spend and is NOT a routable purpose: no routing row, so no chat model can be saved for it (T034)', () => {
        assert.equal(TRANSCRIBE, 'transcribe');
        assert.equal(isAiPurpose(TRANSCRIBE), false);
        assert.equal((AI_PURPOSES as readonly string[]).includes(TRANSCRIBE), false);
        assert.equal(Object.keys(PURPOSE_DEFAULT_EFFORT).includes(TRANSCRIBE), false);
        const label: UsagePurpose = TRANSCRIBE;
        assert.equal(label, 'transcribe');
    });

    it('a Test asks for no thinking at all', () => {
        assert.equal(KEY_TEST_EFFORT, 'low');
    });

    it('does not accept values that only look like purposes', () => {
        for (const value of ['DM', 'dm ', 'dms', 'eval', '', null, undefined, 5, {}, ['dm']]) assert.equal(isAiPurpose(value), false, JSON.stringify(value));
    });
});
