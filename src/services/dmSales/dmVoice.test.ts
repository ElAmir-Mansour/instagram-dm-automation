/**
 * The DM's own voice guide, and the links the guard lets the model repeat (S6 follow-ups from the S5 review).
 *
 * `voice.guide` is tuned for carousels and captions ("one point per slide", "the link is in the bio"), and a chat reply is none of that. So the
 * profile has an optional `dm.voice_guide`: when it is typed, the sales prompt shows IT as the voice and `voice.guide` is nowhere in the
 * prompt; when it is absent or blank, the prompt is the one it always was. Its golden is `dm.sales-system-dm-voice.*` (golden.test.ts).
 *
 * The allowlist is the other half: the creator's own site and social links come from the profile into the guard's facts, so a model that
 * points to them is not stripped, and an offer's address (which the model is never shown) is not among them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contextFor } from '../profile/context.js';
import { defaultProfile } from '../profile/defaults.js';
import { upgradeProfile } from '../profile/defaults.js';
import { FITNESS_EN } from '../profile/fixtures.js';
import { throughJsonb } from '../profile/testSupport.js';
import type { CreatorProfile } from '../profile/types.js';
import { validateProfile } from '../profile/validate.js';
import { guardReply } from './guard.js';
import { buildSalesPrompt, ownLinks, type SalesPromptInput } from './prompt.js';
import { NOW, withSales } from './testFixtures.js';

const input = (profile: CreatorProfile): SalesPromptInput => ({
    persona: 'You are a friendly assistant.', knowledge: null, ctx: contextFor(profile, 'dm', null), timezone: 'Europe/London', now: NOW,
});

/** The profile's guide is written for posts; a chat reply has its own. Each carries a number only the one that is shown may use. */
const withVoices = (dmGuide: string | undefined): CreatorProfile => {
    const p = withSales(FITNESS_EN, 'en');
    p.voice = { ...p.voice, guide: 'POSTS-GUIDE: one point per slide, 7 slides, the link is in the bio.' };
    if (dmGuide === undefined) delete p.dm.voice_guide;
    else p.dm.voice_guide = dmGuide;
    return p;
};

describe('the DM\'s own voice guide (`dm.voice_guide`)', () => {
    it('when it is set, it is the voice, instead of the profile\'s guide, which is then nowhere in the prompt', () => {
        const p = buildSalesPrompt(input(withVoices('CHAT-GUIDE: short and friendly, 2 sentences.')));
        assert.match(p.system, /=== Voice ===\nCHAT-GUIDE: short and friendly, 2 sentences\.\n/);
        assert.ok(!p.system.includes('POSTS-GUIDE'));
        assert.ok(!p.system.includes('the link is in the bio'));
    });

    it('when it is absent, blank or only spaces, the profile\'s guide is the voice, as it was', () => {
        for (const dm of [undefined, '', '   \n  ']) {
            const p = buildSalesPrompt(input(withVoices(dm)));
            assert.match(p.system, /=== Voice ===\nPOSTS-GUIDE: one point per slide/, JSON.stringify(dm));
        }
    });

    it('its words are facts the reply may state, and the guide it displaced is not a fact', () => {
        const chat = buildSalesPrompt(input(withVoices('CHAT-GUIDE: 2 sentences.')));
        assert.ok(chat.claims.texts.some((t) => t.includes('CHAT-GUIDE')));
        assert.ok(!chat.claims.texts.some((t) => t.includes('POSTS-GUIDE')), 'the posts\' guide was not shown, so it is not data');
        const posts = buildSalesPrompt(input(withVoices(undefined)));
        assert.ok(posts.claims.texts.some((t) => t.includes('POSTS-GUIDE')));
    });

    it('is part of the static prefix, so it does not move between turns', () => {
        const a = buildSalesPrompt(input(withVoices('CHAT-GUIDE')), { stage: 'new', qualifierTurns: 0, linkSentFor: [] });
        const b = buildSalesPrompt(input(withVoices('CHAT-GUIDE')), { stage: 'link', qualifierTurns: 2, linkSentFor: ['plan'] });
        assert.equal(a.prefix, b.prefix);
        assert.ok(a.prefix.includes('CHAT-GUIDE'));
    });

    it('is in the DM context: the profile\'s value, "" for a profile that never typed one, and the tenant\'s timezone beside it', () => {
        assert.equal(contextFor(withVoices('CHAT-GUIDE'), 'dm', null).voice_guide, 'CHAT-GUIDE');
        assert.equal(contextFor(withVoices(undefined), 'dm', null).voice_guide, '');
        assert.equal(contextFor(withVoices(undefined), 'dm', null).timezone, 'Europe/London');
        assert.equal(contextFor(defaultProfile({ lang: 'en', rules: [] }), 'dm', null).timezone, 'UTC', 'UTC when the profile has none');
    });

    it('survives storage: written as jsonb and read back, the prompt still shows it (a guide lost here is a bot that talks in the posts\' voice)', () => {
        const stored = upgradeProfile(throughJsonb(withVoices('CHAT-GUIDE'))).profile;
        assert.equal(stored.dm.voice_guide, 'CHAT-GUIDE');
        assert.match(buildSalesPrompt(input(stored)).system, /=== Voice ===\nCHAT-GUIDE\n/);
    });

    it('is optional in a stored profile: one without the key reads without it, and nothing is repaired', () => {
        const without = withVoices(undefined);
        const read = upgradeProfile(throughJsonb(without));
        assert.equal('voice_guide' in read.profile.dm, false, 'an absent key stays absent');
        assert.deepEqual(read.repaired, []);
    });
});

describe('the DM voice guide in the profile validator', () => {
    /** What `validateProfile` says is wrong, as a list: empty when it accepts the profile. */
    const problemsIn = (p: unknown): string[] => {
        const out = validateProfile(p);
        return 'problems' in out ? out.problems : [];
    };
    const problems = (guide: unknown): string[] => {
        const p = structuredClone(FITNESS_EN) as any;
        p.dm.voice_guide = guide;
        return problemsIn(p);
    };

    it('accepts text, blank text and no key at all', () => {
        assert.deepEqual(problems('Short and friendly.'), []);
        assert.deepEqual(problems(''), []);
        assert.deepEqual(problemsIn(structuredClone(FITNESS_EN)), []);
    });

    it('holds it to 4000 characters, as the profile\'s own guide is', () => {
        assert.deepEqual(problems('x'.repeat(4000)), []);
        assert.match(problems('x'.repeat(4001)).join('\n'), /dm\.voice_guide is 4001 characters; the limit is 4000/);
    });

    it('refuses what is not text', () => {
        for (const bad of [5, true, ['a'], { a: 1 }]) assert.match(problems(bad).join('\n'), /dm\.voice_guide must be text/, JSON.stringify(bad));
    });

    it('still refuses a key it does not know in the dm section', () => {
        const p = structuredClone(FITNESS_EN) as any;
        p.dm.tone = 'x';
        assert.match(problemsIn(p).join('\n'), /dm\.tone is not a profile field/);
    });
});

describe('the links the guard lets the model repeat', () => {
    it('are the creator\'s own site and socials from the profile, and never an offer\'s address, which the model is not shown and the server inserts itself', () => {
        const p = buildSalesPrompt(input(withSales(FITNESS_EN, 'en')));
        assert.deepEqual(p.claims.allowedLinks, ['samifit.example', 'https://instagram.com/sami.fit']);
        assert.ok(!p.claims.allowedLinks!.includes('https://samifit.example/plan'));
    });

    it('are none for a profile with no site and no socials', () => {
        const bare = withSales(FITNESS_EN, 'en');
        bare.socials = { handle: '@sami.fit', site: '', platforms: [], links: {} };
        assert.deepEqual(buildSalesPrompt(input(bare)).claims.allowedLinks, []);
        assert.deepEqual(ownLinks({ handle: '', site: '  ', links: {} }), []);
    });

    it('lets a reply keep the creator\'s own link and still loses every other', () => {
        const p = buildSalesPrompt(input(withSales(FITNESS_EN, 'en')));
        const g = guardReply('Follow https://instagram.com/sami.fit, not https://instagram.com/someone.else', p.claims);
        assert.equal(g.text, 'Follow https://instagram.com/sami.fit, not');
        assert.deepEqual(g.linksRemoved, ['https://instagram.com/someone.else']);
    });
});
