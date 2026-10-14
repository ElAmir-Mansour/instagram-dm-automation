/**
 * The completeness meter and the next three actions (P30), for the people they are shown to:
 *
 *   - **a new tenant**, who has just finished the wizard and should be told what is worth doing next;
 *   - **two tenants who are nothing like the owner** (`FITNESS_EN`, `SHOP_EG`), so the meter is not secretly measuring him;
 *   - **the owner**, whose setup predates profiles: he is shown his real state over what his setup can hold, and is NEVER told to fill in a
 *     field that setup was built without (a niche, a presenter's name, an audience description, voice samples, a DM hand-off rule).
 *
 * The owner's profile here is the fixture plus the portrait his live profile has, and the live SHAPE is pinned separately: what the
 * production profile looked like when this was written (read-only, 2026-10-14): a stored profile with an empty niche, no samples, no
 * pillars, an unnamed presenter, no audience, no DM hand-off, a portrait, a handle and a site.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import {
    ACTION_IDS, completeness, FIELDS, MAX_ACTIONS, nextBestActions, SAMPLES_ENOUGH, type ActionId, type Connections, type NextAction,
} from './completeness.js';
import { defaultProfile } from './defaults.js';
import { FITNESS_EN, SHOP_EG } from './fixtures.js';
import { profileFromLegacy } from './legacy.js';
import type { CreatorProfile } from './types.js';

const NONE: Connections = { meta: false, tiktok: false, youtube: false };
const ALL: Connections = { meta: true, tiktok: true, youtube: true };

const edit = (profile: CreatorProfile, change: (p: CreatorProfile) => void): CreatorProfile => {
    const copy = structuredClone(profile);
    change(copy);
    return copy;
};
const ids = (actions: NextAction[]): ActionId[] => actions.map((a) => a.id);
const fieldsOf = (profile: CreatorProfile, opts = {}): string[] => completeness(profile, opts).missing.map((m) => m.field);

/** A tenant that has finished W1 and W2 and nothing else: the six activation fields. */
const FINISHED_WIZARD: CreatorProfile = edit(defaultProfile({ lang: 'en', rules: [] }), (p) => {
    p.identity = { ...p.identity, display_name: { ar: '', en: 'Nour Shop' }, kind: 'shop', niche: 'Linen homewares', timezone: 'Europe/London' };
    p.offers = [{ id: 'main', kind: 'product', name: 'Linen throw', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }];
});

/** The owner's tenant: the fixture, with the portrait his live profile has. */
const OWNER = edit(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH), (p) => { p.brand.portrait_url = '/api/uploads/00000000-0000-4000-8000-000000000001'; });

/** The owner as production held him on 2026-10-14, by presence only: what he has, and what his setup never had a place for. */
const OWNER_LIVE_SHAPE = edit(defaultProfile({ lang: 'ar', rules: ['no_women_imagery'] }), (p) => {
    p.identity = { display_name: { ar: 'الأمير منصور', en: 'ElAmir Mansour' }, brand_name: 'Agentic AI بالعربي', kind: 'educator', role: 'tech educator', niche: '', country: null, timezone: 'Asia/Riyadh' };
    p.language = { primary: 'ar', register: 'gulf', digits: 'arabic-indic', surfaces: { infographic: { register: 'msa' } } };
    p.offers = [{ id: 'main', kind: 'course', name: 'A course', order_via: 'url', url: 'https://example.test/course', price: '', facts: [], bullets: [], keyword: '', primary: true }];
    p.voice = { ...p.voice, guide: 'x'.repeat(551), tone: [], samples: [], address: 'masc' };
    p.presenter = { name: '', pronouns: 'he', on_camera: 'face' };
    p.content = { ...p.content, domain: 'tech', pillars: [], never_mention: ['x'] };
    p.brand = { ...p.brand, portrait_url: '/api/uploads/00000000-0000-4000-8000-000000000001', logo_url: null };
    p.socials = { handle: '@elamir.mansour', site: 'elamir.dev', platforms: ['instagram', 'youtube', 'linkedin', 'x', 'tiktok'], links: {} };
    p.dm = { faq: [], handoff: null, hours: null };
});

describe('the weights', () => {
    const total = (opts: { legacy?: boolean; dm?: boolean }) => completeness(FINISHED_WIZARD, opts).total;

    it('add up to what each kind of tenant is measured over', () => {
        assert.equal(total({}), 76, 'a tenant whose DM bot is off: the activation fields and the four a person can add');
        assert.equal(total({ dm: true }), 86, 'with the DM bot on, its hand-off rule counts for 10');
        assert.equal(total({ legacy: true }), 35, 'a tenant that predates profiles: only what its setup has a home for');
        assert.equal(total({ legacy: true, dm: true }), 35, 'and his DM bot never adds a field to it');
    });

    it('give the seven activation fields 35 between them, and no field a tenant cannot fix from the dashboard', () => {
        const activation = ['name', 'kind', 'niche', 'timezone', 'language', 'offer', 'offer_link'];
        assert.equal(FIELDS.filter((f) => activation.includes(f.id)).reduce((n, f) => n + f.weight, 0), 35);
        assert.deepEqual(FIELDS.map((f) => f.id).sort(), [...activation, 'voice_samples', 'presenter', 'audience', 'portrait', 'dm_handoff'].sort());
    });

    it('count a field once, whatever mix of fields is filled: 100 exactly when nothing that applies is missing, never otherwise', () => {
        // The five a person adds after the wizard, as bits: samples, presenter, audience, portrait, hand-off.
        const toggles: Array<(p: CreatorProfile) => void> = [
            (p) => { p.voice.samples = ['a', 'b', 'c']; },
            (p) => { p.presenter = { name: 'x', pronouns: 'they', on_camera: 'face' }; },
            (p) => { p.audience.description = 'a'; },
            (p) => { p.brand.portrait_url = '/api/uploads/1'; },
            (p) => { p.dm.handoff = { when: 'w', message: 'm' }; },
        ];
        for (let mask = 0; mask < 1 << toggles.length; mask++) {
            const profile = edit(FINISHED_WIZARD, (p) => toggles.forEach((on, bit) => { if (mask & (1 << bit)) on(p); }));
            for (const dm of [false, true]) {
                const score = completeness(profile, { dm });
                const everythingThatApplies = (mask & 0b01111) === 0b01111 && (!dm || (mask & 0b10000) !== 0);
                assert.equal(score.percent === 100, everythingThatApplies, `mask ${mask}, dm ${dm}`);
                assert.equal(score.missing.length === 0, everythingThatApplies, `mask ${mask}, dm ${dm}`);
                assert.ok(score.percent >= 35 / (dm ? 86 : 76) * 100 - 1 && score.percent <= 100, 'at least the activation fields, at most all of it');
            }
        }
    });

    it('rises with every field added and never falls', () => {
        let profile = FINISHED_WIZARD;
        let last = completeness(profile, { dm: true }).percent;
        for (const add of [
            (p: CreatorProfile) => { p.voice.samples = ['a']; }, (p: CreatorProfile) => { p.voice.samples = ['a', 'b', 'c']; },
            (p: CreatorProfile) => { p.presenter = { name: 'x', pronouns: 'she', on_camera: 'voice' }; }, (p: CreatorProfile) => { p.audience.description = 'a'; },
            (p: CreatorProfile) => { p.brand.portrait_url = '/api/uploads/1'; }, (p: CreatorProfile) => { p.dm.handoff = { when: 'w', message: 'm' }; },
        ]) {
            profile = edit(profile, add);
            const now = completeness(profile, { dm: true }).percent;
            assert.ok(now > last, `${last} to ${now}`);
            last = now;
        }
        assert.equal(last, 100);
    });

    it('moves with every voice sample added, and counts only text', () => {
        const withSamples = (samples: string[]) => completeness(edit(FINISHED_WIZARD, (p) => { p.voice.samples = samples; }));
        const filled = (samples: string[]) => withSamples(samples).missing.find((m) => m.field === 'voice_samples')?.filled ?? 1;
        assert.equal(filled([]), 0);
        assert.ok(Math.abs(filled(['a']) - 1 / 3) < 1e-9);
        assert.ok(Math.abs(filled(['a', 'b']) - 2 / 3) < 1e-9);
        assert.equal(filled(['a', 'b', 'c']), 1);
        assert.equal(filled(['a', 'b', 'c', 'd']), 1, 'a fourth is welcome and earns nothing more');
        assert.ok(Math.abs(filled(['a', '   ', '']) - 1 / 3) < 1e-9, 'blank samples are not samples');
        assert.equal(SAMPLES_ENOUGH, 3);
        assert.ok(withSamples(['a']).percent > withSamples([]).percent && withSamples(['a', 'b']).percent > withSamples(['a']).percent);
    });
});

describe('a new tenant', () => {
    it('with nothing typed is at 8 (the language the admin chose is the one thing it has), and is told to finish setup first', () => {
        const fresh = defaultProfile({ lang: 'ar' });
        const score = completeness(fresh);
        assert.equal(score.percent, 8, '6 of 76: Arabic with the MSA register is a language');
        assert.deepEqual(score.missing.map((m) => m.field).sort(), FIELDS.filter((f) => f.needs !== 'dm' && f.id !== 'language').map((f) => f.id).sort());
        assert.deepEqual(ids(nextBestActions(fresh, NONE)), ['finish_setup', 'connect_meta', 'voice_samples']);
        assert.deepEqual(nextBestActions(fresh, NONE)[0]!.link, { kind: 'wizard' });
        assert.deepEqual(nextBestActions(fresh, NONE)[0]!.unlocks, 'setup');
    });

    it('that has finished the wizard is at 46: the six activation fields are 35 of 76', () => {
        const score = completeness(FINISHED_WIZARD);
        assert.equal(score.earned, 35);
        assert.equal(score.percent, 46);
        assert.deepEqual(score.missing.map((m) => m.field), ['voice_samples', 'portrait', 'presenter', 'audience'], 'heaviest first');
    });

    it('is offered Instagram and Facebook before anything about its profile, then its own gaps, three at most', () => {
        assert.deepEqual(ids(nextBestActions(FINISHED_WIZARD, NONE)), ['connect_meta', 'voice_samples', 'presenter']);
        assert.deepEqual(ids(nextBestActions(FINISHED_WIZARD, { ...NONE, meta: true })), ['voice_samples', 'presenter', 'portrait']);
        assert.deepEqual(ids(nextBestActions(FINISHED_WIZARD, ALL)), ['voice_samples', 'presenter', 'portrait']);
    });

    it('is asked for a DM hand-off only once the DM bot is on, and then right after the voice samples', () => {
        assert.equal(ids(nextBestActions(FINISHED_WIZARD, ALL)).includes('dm_handoff'), false, 'a bot that is off needs no hand-off rule');
        assert.deepEqual(ids(nextBestActions(FINISHED_WIZARD, ALL, { dm: true })), ['voice_samples', 'dm_handoff', 'presenter']);
        assert.equal(completeness(FINISHED_WIZARD, { dm: true }).missing[0]!.field, 'voice_samples');
        assert.ok(fieldsOf(FINISHED_WIZARD, { dm: true }).includes('dm_handoff'));
        assert.equal(fieldsOf(FINISHED_WIZARD).includes('dm_handoff'), false);
    });

    it('is told about the other two platforms last, when nothing else is left to do', () => {
        const done = edit(FINISHED_WIZARD, (p) => {
            p.voice.samples = ['a', 'b', 'c'];
            p.presenter = { name: 'N', pronouns: 'they', on_camera: 'face' };
            p.audience.description = 'a';
            p.brand.portrait_url = '/api/uploads/1';
        });
        assert.deepEqual(ids(nextBestActions(done, { meta: true, tiktok: false, youtube: false })), ['connect_tiktok', 'connect_youtube']);
        assert.deepEqual(ids(nextBestActions(done, ALL)), []);
        assert.equal(completeness(done).percent, 100);
    });

    it('never gets more than three actions, whatever is missing and connected', () => {
        for (const profile of [defaultProfile({ lang: 'ar' }), FINISHED_WIZARD, FITNESS_EN, SHOP_EG, OWNER]) {
            for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
                const connections: Connections = { meta: !!(mask & 1), tiktok: !!(mask & 2), youtube: !!(mask & 4) };
                for (const opts of [{}, { dm: true }, { legacy: true }, { legacy: true, dm: true }]) {
                    assert.ok(nextBestActions(profile, connections, opts).length <= MAX_ACTIONS);
                }
            }
        }
    });
});

describe('FITNESS_EN and SHOP_EG', () => {
    it('FITNESS_EN has everything but voice samples and a portrait: 51 of 76', () => {
        const score = completeness(FITNESS_EN);
        assert.equal(score.earned, 51);
        assert.equal(score.percent, 67);
        assert.deepEqual(score.missing.map((m) => m.field), ['voice_samples', 'portrait']);
    });

    it('FITNESS_EN with its DM bot on holds a hand-off rule, so it earns that too: 61 of 86', () => {
        const score = completeness(FITNESS_EN, { dm: true });
        assert.equal(score.earned, 61);
        assert.equal(score.total, 86);
        assert.equal(score.percent, 71);
        assert.deepEqual(score.missing.map((m) => m.field), ['voice_samples', 'portrait']);
    });

    it('FITNESS_EN is offered its samples and its portrait, and Instagram first if it is not connected', () => {
        assert.deepEqual(ids(nextBestActions(FITNESS_EN, ALL)), ['voice_samples', 'portrait']);
        assert.deepEqual(ids(nextBestActions(FITNESS_EN, NONE)), ['connect_meta', 'voice_samples', 'portrait']);
    });

    it('SHOP_EG has the activation fields and nothing else: 35 of 76', () => {
        const score = completeness(SHOP_EG);
        assert.equal(score.earned, 35);
        assert.equal(score.percent, 46);
        assert.deepEqual(score.missing.map((m) => m.field), ['voice_samples', 'portrait', 'presenter', 'audience']);
    });

    it('SHOP_EG is offered samples, a presenter and a portrait; with its bot on, a hand-off rule second', () => {
        assert.deepEqual(ids(nextBestActions(SHOP_EG, ALL)), ['voice_samples', 'presenter', 'portrait']);
        assert.deepEqual(ids(nextBestActions(SHOP_EG, ALL, { dm: true })), ['voice_samples', 'dm_handoff', 'presenter']);
    });

    it('measure the same way whatever the language: an Arabic shop and an English coach differ only in what they have', () => {
        const arabicCoach = edit(FITNESS_EN, (p) => { p.language = { primary: 'ar', register: 'egyptian', digits: 'latin', surfaces: {} }; });
        assert.equal(completeness(arabicCoach).percent, completeness(FITNESS_EN).percent);
        const noRegister = edit(arabicCoach, (p) => { p.language.register = null; });
        assert.ok(fieldsOf(noRegister).includes('language'), 'Arabic with no register is not a language yet');
        assert.equal(fieldsOf(edit(FITNESS_EN, (p) => { p.language.register = null; })).includes('language'), false, 'English needs none');
    });

    it('an offer ordered by link needs the link; one ordered by DM does not; none at all has neither', () => {
        const byUrl = (url: string) => edit(FITNESS_EN, (p) => { p.offers = [{ ...p.offers[1]!, order_via: 'url', url }]; });
        assert.ok(fieldsOf(byUrl('')).includes('offer_link'));
        assert.equal(fieldsOf(byUrl('https://x.example')).includes('offer_link'), false);
        assert.equal(fieldsOf(edit(FITNESS_EN, (p) => { p.offers = [{ ...p.offers[0]!, primary: true }]; })).includes('offer_link'), false);
        assert.ok(fieldsOf(edit(FITNESS_EN, (p) => { p.offers = []; })).includes('offer'));
        assert.ok(fieldsOf(edit(FITNESS_EN, (p) => { p.offers = []; })).includes('offer_link'));
    });
});

describe('the owner', () => {
    it('is at 100 and has nothing to do: his setup has a home for six fields and he holds all six', () => {
        for (const owner of [OWNER, OWNER_LIVE_SHAPE]) {
            const score = completeness(owner, { legacy: true });
            assert.equal(score.percent, 100);
            assert.deepEqual(score.missing, []);
            assert.equal(score.total, 35);
            assert.deepEqual(nextBestActions(owner, ALL, { legacy: true }), []);
        }
    });

    it('is NEVER told to fill in a field his setup was built without, however empty it is, with the DM bot on or off', () => {
        const never: ActionId[] = ['finish_setup', 'voice_samples', 'dm_handoff', 'presenter', 'audience'];
        for (const owner of [OWNER, OWNER_LIVE_SHAPE]) {
            for (const dm of [false, true]) {
                for (const meta of [false, true]) {
                    const actions = ids(nextBestActions(owner, { meta, tiktok: false, youtube: false }, { legacy: true, dm }));
                    for (const id of never) assert.equal(actions.includes(id), false, `${id} (dm ${dm}, meta ${meta})`);
                    const missing = fieldsOf(owner, { legacy: true, dm });
                    for (const field of ['niche', 'kind', 'voice_samples', 'presenter', 'audience', 'dm_handoff']) assert.equal(missing.includes(field), false, field);
                }
            }
        }
    });

    it('whose niche is empty (it is, in production) is still not asked for one, though a new tenant with that gap is', () => {
        assert.equal(OWNER_LIVE_SHAPE.identity.niche, '');
        assert.equal(fieldsOf(OWNER_LIVE_SHAPE, { legacy: true }).includes('niche'), false);
        assert.ok(fieldsOf(OWNER_LIVE_SHAPE).includes('niche'), 'the same profile, as a new tenant\'s, is missing it');
        assert.ok(completeness(OWNER_LIVE_SHAPE).percent < 100);
        assert.deepEqual(ids(nextBestActions(OWNER_LIVE_SHAPE, ALL)), ['finish_setup', 'voice_samples', 'audience'], 'a new tenant with his profile would be asked for exactly what he is spared');
    });

    it('is still shown what really is undone within what his setup holds: the fixture has no portrait, so that, and only that', () => {
        const withoutPortrait = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        const score = completeness(withoutPortrait, { legacy: true });
        assert.equal(score.percent, 71, '25 of 35');
        assert.deepEqual(score.missing.map((m) => m.field), ['portrait']);
        assert.deepEqual(ids(nextBestActions(withoutPortrait, ALL, { legacy: true })), ['portrait']);
        assert.deepEqual(nextBestActions(withoutPortrait, ALL, { legacy: true })[0]!.link, { kind: 'page', target: 'infographics' });
    });

    it('is told about a platform he has not connected, which is a fact about his accounts and not a profile field', () => {
        assert.deepEqual(ids(nextBestActions(OWNER, { meta: true, tiktok: false, youtube: true }, { legacy: true })), ['connect_tiktok']);
        assert.deepEqual(ids(nextBestActions(OWNER, { meta: false, tiktok: true, youtube: true }, { legacy: true })), ['connect_meta']);
    });

    it('measured as a new tenant would be, the same profile reads 62 and sends him to finish setup: exactly the nagging the flag prevents', () => {
        assert.equal(completeness(OWNER).percent, 62, '47 of 76');
        assert.equal(completeness(OWNER, { legacy: true }).percent, 100);
        assert.equal(ids(nextBestActions(OWNER, ALL))[0], 'finish_setup', 'his niche is empty');
        assert.deepEqual(ids(nextBestActions(OWNER, ALL, { legacy: true })), []);
    });
});

describe('the actions', () => {
    it('name where each is done: a sheet for what only a person can type, a screen for a portrait or a platform, the wizard for setup', () => {
        const every = nextBestActions(defaultProfile({ lang: 'ar' }), NONE, { dm: true });
        assert.deepEqual(every.map((a) => a.link.kind), ['wizard', 'page', 'ask']);
        const asks = (profile: CreatorProfile, opts = {}): Record<string, unknown> => Object.fromEntries(
            [...nextBestActions(profile, ALL, opts), ...nextBestActions(edit(profile, (p) => { p.voice.samples = ['a', 'b', 'c']; }), ALL, opts)]
                .filter((a) => a.link.kind === 'ask').map((a) => [a.id, (a.link as { fields: readonly string[] }).fields])
        );
        assert.deepEqual(asks(FINISHED_WIZARD, { dm: true }), {
            voice_samples: ['voice.samples'], dm_handoff: ['dm.handoff'], presenter: ['presenter'],
        });
        const portrait = nextBestActions(FINISHED_WIZARD, ALL).find((a) => a.id === 'portrait')!;
        assert.deepEqual(portrait.link, { kind: 'page', target: 'infographics' });
        const meta = nextBestActions(FINISHED_WIZARD, NONE).find((a) => a.id === 'connect_meta')!;
        assert.deepEqual(meta.link, { kind: 'page', target: 'settings' });
        assert.deepEqual(meta.paths, []);
    });

    it('carry the profile paths they fill, which are the paths the meter\'s fields cover', () => {
        const covered = new Set(FIELDS.flatMap((f) => f.paths));
        for (const action of nextBestActions(defaultProfile({ lang: 'ar' }), NONE, { dm: true })) for (const path of action.paths) assert.ok(covered.has(path), path);
        for (const id of ACTION_IDS) assert.match(id, /^[a-z_]+$/);
        assert.equal(new Set(ACTION_IDS).size, ACTION_IDS.length, 'one rule per id');
    });

    it('say what they unlock with a word, never a sentence: the words are the dashboard\'s, in both languages', () => {
        const unlocks = new Set(nextBestActions(defaultProfile({ lang: 'ar' }), NONE, { dm: true }).map((a) => a.unlocks));
        for (const u of unlocks) assert.match(u, /^[a-z]+$/);
        assert.equal(JSON.stringify(nextBestActions(FINISHED_WIZARD, NONE)).includes(' '), false, 'no prose anywhere in what an action carries');
    });

    it('do not change the profile they read', () => {
        const before = JSON.stringify(FINISHED_WIZARD);
        completeness(FINISHED_WIZARD, { dm: true });
        nextBestActions(FINISHED_WIZARD, NONE, { dm: true });
        assert.equal(JSON.stringify(FINISHED_WIZARD), before);
    });
});
