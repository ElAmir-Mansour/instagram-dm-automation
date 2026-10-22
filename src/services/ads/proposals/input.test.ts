/**
 * What the model is told (FR-049, spec Story 3): aggregates, the offers' own words, the limits, the policy rules and the stored copy's
 * numbers. Never a contact, a lead's answer, a conversation or a message's text. The profile fixture below carries every one of those
 * on purpose, and none of them may show up in the input or in the prompt built from it.
 *
 * No database: the profile is injected.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultProfile } from '../../profile/defaults.js';
import { offer } from '../../profile/fixtures.js';
import type { CreatorProfile } from '../../profile/types.js';
import { buildInput } from './input.js';
import { buildPrompt } from './prompt.js';
import type { InputObject, MirrorPort, MoneyPort, PolicyPort, ProposalPorts } from './types.js';

const SECRETS = [
    'sara.private@gmail.example', '+966 55 123 4567', '0551234567', 'Abdullah Al-Qahtani', 'refund me please', 'my budget is 3000 and my daughter is sick',
    'lead-answer-bank-IBAN-SA0380000000608010167519', 'secret-handoff-message', 'hours-secret-note', 'the-bot-knowledge-base-secret', 'testimonial-student-Mona',
] as const;

/** A tenant whose profile holds contacts, a customer's words, a lead's answer and a testimonial next to the offers. */
const PROFILE: CreatorProfile = {
    ...defaultProfile({ lang: 'ar', rules: [] }),
    identity: { display_name: { ar: 'متجر نور', en: 'Nour' }, brand_name: 'Nour', kind: 'shop', role: 'online shop', niche: 'candles', country: 'EG', timezone: 'Africa/Cairo' },
    language: { primary: 'ar', register: 'msa', digits: 'latin', surfaces: {} },
    audience: { description: 'Women who like candles', level: null, pains: [], goals: [], countries: ['EG', 'SA'], languages: ['ar'] },
    offers: [
        offer({
            id: 'candle', kind: 'product', name: 'شمعة لافندر', order_via: 'url', url: 'https://nour.example/candle', price: '99 SAR', primary: true,
            bullets: ['تدوم ٤٠ ساعة', 'شمع الصويا'], facts: ['صناعة يدوية', `contact ${SECRETS[0]} or ${SECRETS[1]} for wholesale`],
            sales: {
                for_whom: 'everyone', level: 'any', outcomes: [], faqs: [{ q: SECRETS[4], a: 'no' }], objections: [{ said: SECRETS[5], answer: 'x' } as never],
                proof: [{ kind: 'testimonial', text: SECRETS[10], source: SECRETS[3] } as never], price_note: '', price_valid_until: '', currency: 'SAR', image_url: '',
            },
        }),
        offer({ id: 'box', kind: 'product', name: 'علبة هدية', order_via: 'dm', price: '' }),
    ],
    socials: { handle: '@nour', site: 'nour.example', platforms: [], links: {} },
    dm: {
        faq: [{ q: SECRETS[4], a: `call ${SECRETS[2]}` }], handoff: { when: SECRETS[3], message: SECRETS[6] }, hours: { days: [1], from: '09:00', to: '17:00' }, voice_guide: SECRETS[7],
    },
};

const OBJECT: InputObject = {
    id: 'c1', level: 'campaign', name: 'Candles', goal: 'messages', status: 'ACTIVE', budget: { kind: 'daily', amount: 20 }, targetingSummary: { countries: ['EG'] },
    last7d: { spend: 140, results: 12, costPerResult: 11.67, conversations: 12, costPerConversation: 11.67, ctr: 1.8, frequency: 1.4, trackedClicks: 30, handoffs: 3 },
};

const mirror: MirrorPort = {
    async snapshot() {
        return { currency: 'SAR', timezone: 'Europe/Lisbon', objects: [OBJECT], audiences: [{ id: 'au1', kind: 'custom', name: 'Buyers', size: 1200 }], daysOfData: 21 };
    },
};
const money: MoneyPort = {
    async check() { return { fits: true, currency: 'SAR', remaining: 640, maxDailyBudget: 50, monthlyCap: 1000, reason: null }; },
    async minimumDaily() { return { messages: 3.75, traffic: 3.75 }; },
};
const policy: PolicyPort = {
    rules: (lang) => [{ id: 'no_guarantee', severity: 'block', description: lang === 'ar' ? 'لا وعود بنتائج مضمونة' : 'No guaranteed results' }],
    check: () => [],
};

const NO_PORTS: ProposalPorts = { policy: null, money: null, mirror: null, apply: null, tenants: null, alerts: null };
const FULL_PORTS: ProposalPorts = { ...NO_PORTS, policy, money, mirror };
const deps = { loadProfile: async () => ({ profile: PROFILE }) };

describe('buildInput', () => {
    it('holds the tenant, the limits, the offers, the policy rules and the account aggregates', async () => {
        const input = await buildInput('t1', { task: 'draft_campaign', request: 'روّج للشمعة' }, FULL_PORTS, deps);
        assert.deepEqual(input.tenant, { lang: 'ar', currency: 'SAR', timezone: 'Europe/Lisbon', countries: ['EG', 'SA'] });
        assert.deepEqual(input.limits, { maxDailyBudget: 50, monthlyCap: 1000, remainingThisMonth: 640, metaMinimumDaily: { messages: 3.75, traffic: 3.75 } });
        assert.equal(input.task, 'draft_campaign');
        assert.equal(input.request, 'روّج للشمعة');
        assert.equal(input.post, null);
        assert.deepEqual(input.policy.rules, [{ id: 'no_guarantee', severity: 'block', description: 'لا وعود بنتائج مضمونة' }]);
        assert.deepEqual(input.account.objects, [OBJECT]);
        assert.deepEqual(input.account.audiences, [{ id: 'au1', kind: 'custom', name: 'Buyers', size: 1200 }]);
        assert.equal(input.daysOfData, 21);
        assert.deepEqual(input.offers.map((o) => [o.id, o.title, o.price, o.url_is_tracked]), [['candle', 'شمعة لافندر', '99 SAR', true], ['box', 'علبة هدية', null, false]]);
        assert.match(input.offers[0]!.summary, /تدوم ٤٠ ساعة/);
    });

    it('falls back to nulls and empties when no port is wired', async () => {
        const input = await buildInput('t1', { task: 'review' }, NO_PORTS, deps);
        assert.deepEqual(input.limits, { maxDailyBudget: null, monthlyCap: null, remainingThisMonth: null, metaMinimumDaily: {} });
        assert.deepEqual(input.policy, { rules: [] });
        assert.deepEqual(input.account, { objects: [], audiences: [] });
        assert.equal(input.daysOfData, 0);
        assert.equal(input.tenant.timezone, 'Africa/Cairo');
        assert.equal(input.request, null);
    });

    it('carries the post an organic number belongs to, and nothing else of it', async () => {
        const post = { id: 'p1', platform: 'instagram', caption: 'new candle', kind: 'reel', organic: { views: 4200, reach: 3100, saves: 40, skipRate: 0.31 }, owner_email: SECRETS[0] };
        const input = await buildInput('t1', { task: 'draft_campaign', post }, NO_PORTS, deps);
        assert.deepEqual(input.post, { id: 'p1', platform: 'instagram', caption: 'new candle', kind: 'reel', organic: { views: 4200, reach: 3100, saves: 40, skipRate: 0.31 } });
        assert.ok(!JSON.stringify(input).includes(SECRETS[0]));
    });

    it('never lets a contact, a customer message, a lead answer or a testimonial reach the model (FR-049)', async () => {
        const request = 'Promote the candle';
        for (const ports of [FULL_PORTS, NO_PORTS]) {
            for (const task of ['draft_campaign', 'review'] as const) {
                const input = await buildInput('t1', { task, request }, ports, deps);
                const prompt = buildPrompt(input, ['spec.budget.amount: must be greater than 0']);
                const everything = JSON.stringify(input) + prompt.system + prompt.user;
                for (const secret of SECRETS) assert.ok(!everything.includes(secret), `${secret} reached the model`);
                assert.ok(!/@gmail|IBAN|\+966/.test(everything));
            }
        }
    });

    it('cuts a summary short and removes an address or number a bullet carries', async () => {
        const profile: CreatorProfile = {
            ...PROFILE,
            offers: [offer({ id: 'x', name: 'X', bullets: ['a'.repeat(500)], facts: ['mail me at owner@example.com or 0551234567 or +20 100 123 4567'] })],
        };
        const input = await buildInput('t1', { task: 'draft_campaign' }, NO_PORTS, { loadProfile: async () => ({ profile }) });
        assert.ok(input.offers[0]!.summary.length <= 300);
        const long = await buildInput('t1', { task: 'draft_campaign' }, NO_PORTS, { loadProfile: async () => ({ profile: { ...profile, offers: [offer({ id: 'y', name: 'Y', facts: ['mail owner@example.com or 0551234567 or +20 100 123 4567'] })] } }) });
        assert.ok(!/owner@example|0551234567|100 123/.test(long.offers[0]!.summary), long.offers[0]!.summary);
    });

    it('caps the owner\'s words', async () => {
        const input = await buildInput('t1', { task: 'draft_campaign', request: 'x'.repeat(5000) }, NO_PORTS, deps);
        assert.equal(input.request?.length, 1000);
        const blank = await buildInput('t1', { task: 'draft_campaign', request: '   ' }, NO_PORTS, deps);
        assert.equal(blank.request, null);
    });

    it('keeps drafting when a port cannot be read', async () => {
        const broken: ProposalPorts = {
            ...NO_PORTS,
            money: { check: async () => { throw new Error('meta down'); }, minimumDaily: async () => { throw new Error('meta down'); } },
            mirror: { snapshot: async () => { throw new Error('db down'); } },
        };
        const input = await buildInput('t1', { task: 'draft_campaign' }, broken, deps);
        assert.equal(input.limits.maxDailyBudget, null);
        assert.deepEqual(input.account.objects, []);
    });
});
