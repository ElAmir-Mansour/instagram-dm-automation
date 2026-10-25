/**
 * Per-tenant Studio settings: the neutral defaults, the seed script's values, the partial-merge
 * PUT and the rules every stored setting holds. Nothing here reaches a database: the pool is
 * stubbed where the read and write paths are exercised.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { StudioSettings } from '../../db/rows.js';
import { MAC_BRAIN_TENANT_MESSAGE, MacBrainRefused, NEEDS_API_BRAIN_MESSAGE } from '../macBrain.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { StudioError } from './common.js';
import { changedPaths, STUDIO_PROFILE_PATHS } from '../profile/views.js';
import {
    defaultStudioSettings, EXPLAINER_VOICES, getMonteurSettings, getStudioSettings, mergeSettings, overDefaults, seedApiBrain, settingsProblems,
    STUDIO_SETTINGS_SECTIONS, updateStudioSettings,
} from './settings.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** The problems a PUT with this body would get, over the defaults. */
function problemsFor(patch: Record<string, unknown>): string[] {
    const problems: string[] = [];
    const next = mergeSettings(defaultStudioSettings(), patch, problems);
    return [...problems, ...settingsProblems(next)];
}

describe('defaultStudioSettings', () => {
    it('passes its own rules — the fallback every tenant starts on must be savable as it is', () => {
        assert.deepEqual(settingsProblems(defaultStudioSettings()), []);
    });

    it('is neutral: English, Latin digits, no product, no library folder', () => {
        const s = defaultStudioSettings();
        assert.equal(s.voice.language, 'en');
        assert.equal(s.voice.digits, 'latin');
        assert.equal(s.brand.direction, 'ltr');
        assert.deepEqual(s.product, { name: '', url: '', facts: [], dmBullets: [] });
        assert.equal(s.library.root, null);
        assert.equal(s.examples, null);
        // Nothing about any one creator: no course, no referral link, no Arabic.
        assert.doesNotMatch(JSON.stringify(s), /udemy|referralCode|elamir|[؀-ۿ]/i);
    });

    it('is a fresh object each call, so one tenant’s merge cannot leak into the next', () => {
        const first = defaultStudioSettings();
        first.brand.palette.push('#000000');
        first.cta.slide.swipe = 'changed';
        assert.notDeepEqual(defaultStudioSettings().brand.palette, first.brand.palette);
        assert.equal(defaultStudioSettings().cta.slide.swipe, 'Swipe');
    });
});

describe('scripts/seed-studio-settings.mjs', () => {
    it('holds ElAmir’s values to the same rules as PUT /settings', async () => {
        // Imported, not run: the script only touches a database when executed directly.
        const seed = await import(new URL('../../../scripts/seed-studio-settings.mjs', import.meta.url).href);
        const s = seed.STUDIO_SETTINGS as StudioSettings;
        assert.deepEqual(settingsProblems(s), []);
        assert.equal(s.schedule.timezone, 'Asia/Riyadh');
        assert.deepEqual(s.schedule.slots, ['13:00', '21:00']);
        assert.equal(s.library.root, '/Users/elamir/Desktop/AI Course');
        assert.equal(s.brand.palette.length, 13);
        assert.deepEqual(s.brand.signature, { latin: 'AGENTIC AI', local: 'بالعربي' });
        assert.equal(s.product.dmBullets.length, 4);
        for (const placeholder of ['{username}', '{question}', '{pitch}', '{url}', '{bullets}']) {
            assert.ok(s.cta.dmTemplate.includes(placeholder), placeholder);
        }
        // Every section the table stores, and nothing else: a key the merge does not know
        // would be dropped on the first read.
        assert.deepEqual(problemsFor(s as unknown as Record<string, unknown>), []);
    });
});

describe('mergeSettings — a partial update', () => {
    it('changes only what was sent, however deep, and keeps the rest', () => {
        const problems: string[] = [];
        const next = mergeSettings(defaultStudioSettings(), {
            brand: { signature: { local: 'بالعربي' } },
            schedule: { timezone: 'Asia/Riyadh' },
        }, problems);
        assert.deepEqual(problems, []);
        assert.equal(next.brand.signature.local, 'بالعربي');
        assert.equal(next.brand.signature.latin, defaultStudioSettings().brand.signature.latin, 'the sibling field is kept');
        assert.equal(next.brand.name, defaultStudioSettings().brand.name);
        assert.equal(next.schedule.timezone, 'Asia/Riyadh');
        assert.deepEqual(next.schedule.slots, defaultStudioSettings().schedule.slots, 'the sibling field is kept');
        assert.equal(next.voice.language, 'en', 'an untouched section is kept whole');
    });

    it('replaces a list whole rather than merging it item by item', () => {
        const next = mergeSettings(defaultStudioSettings(), { brand: { palette: ['#123456'] } }, []);
        assert.deepEqual(next.brand.palette, ['#123456']);
    });

    it('reports a key that is not a setting, instead of keeping a typo that does nothing', () => {
        const problems: string[] = [];
        mergeSettings(defaultStudioSettings(), { brand: { pallete: ['#123456'] }, colour: {} }, problems);
        assert.ok(problems.some((p) => p.includes('brand.pallete is not a setting')), problems.join('\n'));
        assert.ok(problems.some((p) => p.includes('"colour" is not a Studio setting')), problems.join('\n'));
    });

    it('can set the library folder, and clear it again', () => {
        const set = mergeSettings(defaultStudioSettings(), { library: { root: '/Volumes/Course' } }, []);
        assert.equal(set.library.root, '/Volumes/Course');
        const cleared = mergeSettings(set, { library: { root: null } }, []);
        assert.equal(cleared.library.root, null);
    });
});

describe('settingsProblems — what a PUT is refused for', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
        ['a colour that is not #RRGGBB', { brand: { colors: { ink: 'black' } } }, /brand\.colors\.ink/],
        ['a palette colour that is not #RRGGBB', { brand: { palette: ['#FFD60A', 'red'] } }, /brand\.palette\[1\]/],
        ['an empty palette', { brand: { palette: [] } }, /palette needs at least one/],
        ['a font the templates do not have', { brand: { fonts: { display: 'Comic Sans' } } }, /brand\.fonts\.display/],
        ['a timezone Intl does not know', { schedule: { timezone: 'Mars/Olympus' } }, /schedule\.timezone/],
        ['a slot that is not HH:MM', { schedule: { slots: ['9am'] } }, /schedule\.slots\[0\]/],
        ['a slot listed twice', { schedule: { slots: ['13:00', '13:00'] } }, /lists a time twice/],
        ['no slots at all', { schedule: { slots: [] } }, /needs at least one time/],
        ['an Instagram ask without {keyword}', { cta: { instagramAsk: 'Comment below!' } }, /must contain \{keyword\}/],
        ['a DM placeholder nobody fills in', { cta: { dmTemplate: 'Hi {usernmae}' } }, /\{usernmae\}/],
        ['a relative library folder', { library: { root: 'Desktop/Course' } }, /full folder path/],
        ['a product link that is not a web address', { product: { url: 'udemy course' } }, /product\.url/],
        ['a language the writer does not speak', { voice: { language: 'fr' } }, /voice\.language/],
    ];
    for (const [name, patch, expected] of cases) {
        it(`refuses ${name}`, () => {
            const problems = problemsFor(patch);
            assert.ok(problems.some((p) => expected.test(p)), `expected ${expected} in:\n${problems.join('\n')}`);
        });
    }

    it('accepts a full, valid change', () => {
        assert.deepEqual(problemsFor({
            voice: { language: 'ar', digits: 'arabic-indic' },
            schedule: { timezone: 'Europe/London', slots: ['08:30', '19:45'] },
            product: { name: 'A course', url: 'https://example.com/c', facts: ['10 lessons'] },
        }), []);
    });
});

describe('overDefaults', () => {
    it('reads a stored row over the defaults, so a field added later needs no backfill', () => {
        const s = overDefaults({
            brand: { name: 'Stored', palette: ['#111111'] },
            cta: { instagramAsk: 'Say {keyword}', slide: { igAsk: 'Say it' } },
            examples: null,
        });
        assert.equal(s.brand.name, 'Stored');
        assert.equal(s.brand.theme, 'dark-grid', 'missing from the row, so the default');
        assert.equal(s.cta.slide.igAsk, 'Say it');
        assert.equal(s.cta.slide.swipe, 'Swipe', 'missing from the row, so the default');
        assert.equal(s.voice.language, 'en', 'a section the row lacks entirely');
    });
});

describe('getStudioSettings / updateStudioSettings', () => {
    let statements: { sql: string; params: unknown[] }[] = [];
    let stored: Record<string, unknown> | null = null;
    const originalQuery = pool.query;
    const originalConnect = pool.connect;

    beforeEach(() => {
        statements = [];
        stored = null;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' '), params });
            if (/FROM studio_settings/.test(sql)) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
            return { rows: [], rowCount: 1 };
        };
        // An update is a transaction (BEGIN, the tenant lock, the locked read, the write, COMMIT) on one connection.
        (pool as unknown as { connect: unknown }).connect = async () => ({ query: (pool as unknown as { query: unknown }).query, release() {} });
    });
    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalQuery;
        (pool as unknown as { connect: unknown }).connect = originalConnect;
    });

    const writes = () => statements.filter((s) => /INSERT INTO studio_settings/.test(s.sql));

    it('falls back to the defaults for a tenant with no row', async () => {
        assert.deepEqual(await getStudioSettings(TENANT), defaultStudioSettings());
        assert.equal(statements[0]!.params[0], TENANT);
    });

    it('upserts every section, with SQL NULL — not JSON null — for "no examples"', async () => {
        const { settings, changed } = await updateStudioSettings(TENANT, { schedule: { timezone: 'Asia/Riyadh' } });
        assert.equal(settings.schedule.timezone, 'Asia/Riyadh');
        assert.deepEqual(changed, ['schedule']);
        const [write] = writes();
        assert.ok(write, 'one upsert');
        assert.match(write!.sql, /ON CONFLICT \(creator_id\) DO UPDATE/);
        assert.equal(write!.params[0], TENANT);
        assert.equal(JSON.parse(write!.params[5] as string).timezone, 'Asia/Riyadh');
        assert.equal(write!.params[7], null);
    });

    it('merges over what the tenant already saved, not over the defaults', async () => {
        stored = { ...defaultStudioSettings(), brand: { ...defaultStudioSettings().brand, name: 'Saved name' } };
        const { settings } = await updateStudioSettings(TENANT, { voice: { guide: 'Short.' } });
        assert.equal(settings.brand.name, 'Saved name');
        assert.equal(settings.voice.guide, 'Short.');
    });

    it('refuses the whole update, writing nothing, when any part breaks a rule', async () => {
        await assert.rejects(
            updateStudioSettings(TENANT, { schedule: { timezone: 'Asia/Riyadh', slots: ['25:00'] } }),
            (err: unknown) => err instanceof StudioError && err.status === 400
                && Boolean(err.problems?.some((p) => /schedule\.slots\[0\]/.test(p)))
        );
        assert.equal(writes().length, 0);
    });

    it('refuses an empty update rather than rewriting the row with nothing changed', async () => {
        await assert.rejects(updateStudioSettings(TENANT, {}), (err: unknown) => err instanceof StudioError && err.status === 400);
        await assert.rejects(updateStudioSettings(TENANT, 'brand'), (err: unknown) => err instanceof StudioError && err.status === 400);
        assert.equal(writes().length, 0);
    });
});

describe('the monteur section (MONTEUR.md §1)', () => {
    it('defaults to off, no folder, one reel a day from one video, on all three platforms, each reviewed', () => {
        assert.deepEqual(defaultStudioSettings().monteur, {
            enabled: false, source: 'folder', mode: 'review', brain: 'gemini', style: 'classic', human: true, folder: null, run_at: '07:00', videos_per_run: 1, reels_per_video: 1,
            platforms: ['instagram', 'facebook', 'tiktok'], post_at: ['19:00'], min_seconds: 20, max_seconds: 45,
        });
    });

    it('brain: Gemini by default, Claude on the Mac or the AI providers layer when chosen, nothing else', () => {
        assert.equal(overDefaults({ monteur: { enabled: true } } as never).monteur.brain, 'gemini', 'a section saved before brain existed: never moved onto the operator’s API key');
        assert.deepEqual(problemsFor({ monteur: { brain: 'claude_mac' } }), []);
        assert.deepEqual(problemsFor({ monteur: { brain: 'api' } }), []);
        assert.deepEqual(problemsFor({ monteur: { brain: 'claude' } }), ['monteur.brain must be one of gemini, claude_mac, api']);
        assert.deepEqual(problemsFor({ monteur: { brain: null } }), ['monteur.brain must be one of gemini, claude_mac, api']);
    });

    it('style: classic by default, paper when chosen, nothing else', () => {
        assert.equal(overDefaults({ monteur: { enabled: true, brain: 'claude_mac' } } as never).monteur.style, 'classic', 'a section saved before style existed');
        assert.deepEqual(problemsFor({ monteur: { style: 'paper' } }), []);
        assert.deepEqual(problemsFor({ monteur: { style: 'classic' } }), []);
        for (const bad of ['Paper', 'ali-abdaal', '', null, 1, ['paper']]) {
            assert.deepEqual(problemsFor({ monteur: { style: bad } }), ['monteur.style must be one of classic, paper'], JSON.stringify(bad));
        }
    });

    it('human: on by default, true or false, nothing else', () => {
        assert.equal(overDefaults({ monteur: { enabled: true, style: 'paper' } } as never).monteur.human, true, 'a section saved before human existed');
        assert.deepEqual(problemsFor({ monteur: { human: false } }), []);
        assert.deepEqual(problemsFor({ monteur: { human: true } }), []);
        for (const bad of ['true', 'off', 0, 1, null, [true]]) {
            assert.deepEqual(problemsFor({ monteur: { human: bad } }), ['monteur.human must be true or false'], JSON.stringify(bad));
        }
    });

    it('reads a section saved before source and mode existed as the folder, reviewed', () => {
        const read = overDefaults({ monteur: { enabled: true, folder: '/v' } });
        assert.equal(read.monteur.source, 'folder');
        assert.equal(read.monteur.mode, 'review');
    });

    it('takes the course library with no folder at all, switched on and scheduling by itself', () => {
        assert.deepEqual(problemsFor({ monteur: { source: 'course', mode: 'auto', enabled: true, folder: null } }), []);
    });

    const cases: [string, Record<string, unknown>, RegExp][] = [
        ['a relative folder', { folder: 'Movies/Monteur' }, /monteur\.folder must be a full folder path/],
        ['an empty folder (null clears it)', { folder: '' }, /monteur\.folder is required/],
        ['a folder over 1024 characters', { folder: `/${'a'.repeat(1024)}` }, /monteur\.folder is 1025 characters/],
        ['a run time that is not HH:MM', { run_at: '7am' }, /monteur\.run_at/],
        ['no videos per run', { videos_per_run: 0 }, /monteur\.videos_per_run must be a whole number from 1 to 10/],
        ['eleven videos per run', { videos_per_run: 11 }, /monteur\.videos_per_run/],
        ['half a video per run', { videos_per_run: 1.5 }, /monteur\.videos_per_run/],
        ['six reels per video', { reels_per_video: 6 }, /monteur\.reels_per_video must be a whole number from 1 to 5/],
        ['no platforms', { platforms: [] }, /monteur\.platforms needs at least one platform/],
        ['a platform it cannot post to', { platforms: ['threads'] }, /monteur\.platforms\[0\] must be one of instagram, facebook, tiktok, youtube/],
        ['a platform twice', { platforms: ['instagram', 'instagram'] }, /lists a platform twice/],
        ['no posting slot', { post_at: [] }, /monteur\.post_at needs at least one time/],
        ['five posting slots', { post_at: ['08:00', '10:00', '12:00', '14:00', '16:00'] }, /monteur\.post_at holds at most 4/],
        ['a posting slot that is not HH:MM', { post_at: ['7pm'] }, /monteur\.post_at\[0\] must be a time/],
        ['a slot twice', { post_at: ['19:00', '19:00'] }, /monteur\.post_at lists a time twice/],
        ['a minimum under 10 s', { min_seconds: 5 }, /monteur\.min_seconds must be a number from 10 to 60/],
        ['a maximum over 3 minutes', { max_seconds: 200 }, /monteur\.max_seconds must be a number from 15 to 180/],
        ['a maximum not above the minimum', { min_seconds: 30, max_seconds: 30 }, /max_seconds must be more than monteur\.min_seconds/],
        ['enabled as text', { enabled: 'yes' }, /monteur\.enabled must be true or false/],
        ['a source it cannot read', { source: 'drive' }, /^monteur\.source must be one of folder, course$/],
        ['no source', { source: null }, /^monteur\.source must be one of folder, course$/],
        ['a mode that is neither', { mode: 'yolo' }, /^monteur\.mode must be one of review, auto$/],
        ['a key that is not a setting', { run_time: '07:00' }, /monteur\.run_time is not a setting/],
    ];
    for (const [name, monteur, expected] of cases) {
        it(`refuses ${name}`, () => {
            const problems = problemsFor({ monteur });
            assert.ok(problems.some((p) => expected.test(p)), `expected ${expected} in:\n${problems.join('\n')}`);
        });
    }

    it('accepts a folder on any of the worker’s systems, and clearing it again', () => {
        for (const folder of ['/Users/me/Movies/Monteur', 'C:\\Users\\me\\Videos', 'D:/Videos', '\\\\nas\\videos']) {
            assert.deepEqual(problemsFor({ monteur: { folder } }), [], folder);
        }
        assert.deepEqual(problemsFor({ monteur: { folder: null } }), []);
    });

    it('accepts a full, valid change, merged into the rest of the section', () => {
        const problems: string[] = [];
        const next = mergeSettings(defaultStudioSettings(), {
            monteur: { enabled: true, folder: '/Volumes/Clips', post_at: ['13:00', '21:00'], reels_per_video: 3, platforms: ['instagram'] },
        }, problems);
        assert.deepEqual([...problems, ...settingsProblems(next)], []);
        assert.equal(next.monteur.run_at, '07:00', 'the sibling field is kept');
        assert.deepEqual(next.monteur.platforms, ['instagram'], 'a list is replaced whole');
    });

    it('is read and written with the other sections', async () => {
        const originalQuery = pool.query;
        const originalConnect = pool.connect;
        const statements: { sql: string; params: unknown[] }[] = [];
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' '), params });
            if (/FROM studio_settings/.test(sql)) return { rows: [{ monteur: { enabled: true, folder: '/v' } }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        };
        (pool as unknown as { connect: unknown }).connect = async () => ({ query: (pool as unknown as { query: unknown }).query, release() {} });
        try {
            const read = await getStudioSettings(TENANT);
            assert.equal(read.monteur.folder, '/v');
            assert.equal(read.monteur.run_at, '07:00', 'a stored section is merged over the defaults');
            assert.match(statements[0]!.sql, /SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic, explainer FROM studio_settings/);

            await updateStudioSettings(TENANT, { monteur: { run_at: '06:30' } });
            const write = statements.find((s) => /INSERT INTO studio_settings/.test(s.sql))!;
            assert.match(write.sql, /examples, monteur, infographic, explainer, updated_at\) VALUES/);
            assert.match(write.sql, /monteur = EXCLUDED\.monteur/);
            assert.deepEqual(JSON.parse(write.params[8] as string), { ...read.monteur, run_at: '06:30' });
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
            (pool as unknown as { connect: unknown }).connect = originalConnect;
        }
    });
});

describe('monteur.brain = claude_mac — the Mac is the owner’s (G1)', () => {
    const NEW_TENANT = '22222222-2222-4222-8222-222222222222';
    let db: FakeDb;
    let stored: Record<string, unknown> | null;
    let saved: string | null;

    beforeEach(() => {
        db = installFakeDb({ platformTenant: TENANT });
        stored = null;
        saved = null;
        db.routes.push(
            [/FROM studio_settings/, () => ({ rows: stored ? [stored] : [] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({
                rows: p[0] === 'studio.mac_brain_tenants' && saved !== null ? [{ value: saved, is_secret: false }] : [],
            })],
        );
    });
    afterEach(() => db.restore());

    const writes = () => db.ran(/^INSERT INTO studio_settings/);
    const onClaude = (over: Record<string, unknown> = {}) => ({ ...defaultStudioSettings(), monteur: { ...defaultStudioSettings().monteur, brain: 'claude_mac', ...over } });
    const refused = (err: unknown) => err instanceof MacBrainRefused && err.status === 400 && err.code === 'NEEDS_API_BRAIN' && err.message === NEEDS_API_BRAIN_MESSAGE;

    it('refuses a tenant that is not on the list with a 400 NEEDS_API_BRAIN, writing nothing', async () => {
        await assert.rejects(updateStudioSettings(NEW_TENANT, { monteur: { brain: 'claude_mac' } }), refused);
        assert.equal(writes().length, 0);
    });

    it('lets the owner switch it on, with nothing configured', async () => {
        const { settings } = await updateStudioSettings(TENANT, { monteur: { brain: 'claude_mac' } });
        assert.equal(settings.monteur.brain, 'claude_mac');
        assert.equal(writes().length, 1);
    });

    it('lets a listed tenant switch it on, and the owner still can: the list adds to him', async () => {
        saved = JSON.stringify([NEW_TENANT]);
        assert.equal((await updateStudioSettings(NEW_TENANT, { monteur: { brain: 'claude_mac' } })).settings.monteur.brain, 'claude_mac');
        assert.equal((await updateStudioSettings(TENANT, { monteur: { brain: 'claude_mac' } })).settings.monteur.brain, 'claude_mac');
        await assert.rejects(updateStudioSettings('33333333-3333-4333-8333-333333333333', { monteur: { brain: 'claude_mac' } }), refused);
        assert.equal(writes().length, 2);
    });

    it('only the switch is refused: Gemini is anyone’s choice, and so is every other Monteur setting', async () => {
        assert.equal((await updateStudioSettings(NEW_TENANT, { monteur: { brain: 'gemini' } })).settings.monteur.brain, 'gemini');
        assert.equal((await updateStudioSettings(NEW_TENANT, { monteur: { mode: 'auto' } })).settings.monteur.mode, 'auto');
        assert.equal(writes().length, 2);
    });

    it('a tenant already on the Mac (before the list changed) still saves its other settings: its calls are refused where they are made', async () => {
        stored = onClaude();
        const { settings } = await updateStudioSettings(NEW_TENANT, { monteur: { brain: 'claude_mac', mode: 'auto' } });
        assert.deepEqual([settings.monteur.brain, settings.monteur.mode], ['claude_mac', 'auto']);
        assert.equal(writes().length, 1);
    });

    it('a patch that breaks another rule is still that 400, not this one', async () => {
        await assert.rejects(
            updateStudioSettings(NEW_TENANT, { monteur: { brain: 'claude_mac', run_at: 'noon' } }),
            (err: unknown) => err instanceof StudioError && !(err instanceof MacBrainRefused) && err.status === 400 && Boolean(err.problems?.some((p) => /monteur\.run_at/.test(p))),
        );
    });
});

describe('monteur.brain = api — the AI providers layer is for the tenants the Mac is not for (P32)', () => {
    const NEW_TENANT = '22222222-2222-4222-8222-222222222222';
    let db: FakeDb;
    let stored: Record<string, unknown> | null;
    let saved: string | null;

    beforeEach(() => {
        db = installFakeDb({ platformTenant: TENANT });
        stored = null;
        saved = null;
        db.routes.push(
            [/FROM studio_settings/, () => ({ rows: stored ? [stored] : [] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({
                rows: p[0] === 'studio.mac_brain_tenants' && saved !== null ? [{ value: saved, is_secret: false }] : [],
            })],
        );
    });
    afterEach(() => db.restore());

    const writes = () => db.ran(/^INSERT INTO studio_settings/);
    const refusedMacTenant = (err: unknown) => err instanceof StudioError && err.status === 400 && err.code === 'MAC_BRAIN_TENANT' && err.message === MAC_BRAIN_TENANT_MESSAGE;

    it('lets a tenant the Mac is not for switch to it', async () => {
        assert.equal((await updateStudioSettings(NEW_TENANT, { monteur: { brain: 'api' } })).settings.monteur.brain, 'api');
        assert.equal(writes().length, 1);
    });

    it('refuses the owner with a 400 MAC_BRAIN_TENANT, writing nothing: his work stays on his Mac', async () => {
        await assert.rejects(updateStudioSettings(TENANT, { monteur: { brain: 'api' } }), refusedMacTenant);
        assert.equal(writes().length, 0);
    });

    it('refuses a tenant on the Mac list the same way, and lets it go back the moment it is taken off', async () => {
        saved = JSON.stringify([NEW_TENANT]);
        await assert.rejects(updateStudioSettings(NEW_TENANT, { monteur: { brain: 'api' } }), refusedMacTenant);
        saved = '[]';
        assert.equal((await updateStudioSettings(NEW_TENANT, { monteur: { brain: 'api' } })).settings.monteur.brain, 'api');
    });

    it('only the switch is refused: the owner whose stored brain is claude_mac saves every other Monteur setting, and one already on api keeps saving', async () => {
        stored = { monteur: { ...defaultStudioSettings().monteur, brain: 'claude_mac' } };
        const { settings } = await updateStudioSettings(TENANT, { monteur: { mode: 'auto' } });
        assert.deepEqual([settings.monteur.brain, settings.monteur.mode], ['claude_mac', 'auto']);
        stored = { monteur: { ...defaultStudioSettings().monteur, brain: 'api' } };
        assert.equal((await updateStudioSettings(TENANT, { monteur: { mode: 'auto' } })).settings.monteur.brain, 'api', 'a stored api is read as stored: the runtime keeps the owner on the Mac (brain.ts)');
    });

    it('a new tenant is seeded api, and only when its row says nothing about the brain', async () => {
        await seedApiBrain(pool, NEW_TENANT);
        const [seed] = db.ran(/^UPDATE studio_settings SET monteur/);
        assert.deepEqual(seed!.params, [NEW_TENANT]);
        assert.match(seed!.sql, /jsonb_build_object\('brain', 'api'\)/);
        assert.match(seed!.sql, /WHERE creator_id = \$1 AND \(monteur IS NULL OR monteur->>'brain' IS NULL\)/, 'a brain the row already has is never overwritten');
        assert.ok(!/SET[^W]*(brand|voice|cta)/.test(seed!.sql), 'and no other field is touched');
    });
});

describe('the monteur source — a scan still waiting for the old one is superseded', () => {
    async function change(stored: Record<string, unknown>, patch: Record<string, unknown>): Promise<{ sql: string; params: unknown[] }[]> {
        const originalQuery = pool.query;
        const originalConnect = pool.connect;
        const statements: { sql: string; params: unknown[] }[] = [];
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/FROM studio_settings/.test(sql)) return { rows: [{ monteur: stored }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        };
        (pool as unknown as { connect: unknown }).connect = async () => ({ query: (pool as unknown as { query: unknown }).query, release() {} });
        try {
            await updateStudioSettings(TENANT, { monteur: patch });
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
            (pool as unknown as { connect: unknown }).connect = originalConnect;
        }
        return statements.filter((s) => /^UPDATE studio_jobs SET status = 'failed'/.test(s.sql));
    }

    it('to the course library: every pending folder scan', async () => {
        const [superseded, ...more] = await change({ source: 'folder', folder: '/v' }, { source: 'course' });
        assert.equal(more.length, 0);
        assert.match(superseded!.sql, /kind = 'monteur_scan' AND status = 'pending' AND payload->'files' IS NULL$/);
        assert.deepEqual(superseded!.params, [TENANT, 'Superseded: the Monteur\'s source changed.']);
    });

    it('back to a folder: every pending course scan, and any for another folder', async () => {
        const [superseded] = await change({ source: 'course', folder: '/v' }, { source: 'folder' });
        assert.match(superseded!.sql, /status = 'pending' AND \(payload->'files' IS NOT NULL OR payload->>'folder' IS DISTINCT FROM \$3\)$/);
        assert.deepEqual(superseded!.params, [TENANT, 'Superseded: the Monteur\'s source changed.', '/v']);
    });

    it('a new folder in folder mode: the old folder’s, as before; nothing for a change that moves neither', async () => {
        const [superseded] = await change({ source: 'folder', folder: '/v' }, { folder: '/w' });
        assert.deepEqual(superseded!.params, [TENANT, 'Superseded: the Monteur\'s folder changed.', '/w']);
        assert.deepEqual(await change({ source: 'course', folder: '/v' }, { folder: '/w' }), [], 'course scans name no folder');
        assert.deepEqual(await change({ source: 'folder', folder: '/v' }, { mode: 'auto' }), []);
    });
});

describe('the monteur folder — what the worker is sent back', () => {
    it('refuses NUL, newlines and other control characters', () => {
        for (const folder of ['/Users/me/Mov\u0000ies', '/Users/me/Movies\n/etc', '/Users/me/\tTabs', '/Users/me/\u007fDel']) {
            const problems = problemsFor({ monteur: { folder } });
            assert.ok(problems.some((p) => /^monteur\.folder must not contain control characters/.test(p)), JSON.stringify(folder));
        }
    });
});

// ─── The explainer section (v59) ───────────────────────────────────────────────────────────────

describe('the explainer section (data-model §6.1)', () => {
    const UPLOAD = '44444444-4444-4444-8444-444444444444';
    const OTHER_UPLOAD = '55555555-5555-4555-8555-555555555555';
    const KARIM = 'a curious young man with a round head, short dark hair, dot eyes, dark green sweater, thin legs';

    const character = (over: Record<string, unknown> = {}) => ({
        key: 'karim', name: 'Karim', description: KARIM, ref_media_id: null, ref_url: null, approved_at: null, ...over,
    });
    const approved = (id = UPLOAD) => ({ ref_media_id: id, ref_url: `https://msg-response-auto.vercel.app/api/uploads/${id}`, approved_at: '2026-10-24T20:00:00Z' });
    const track = (over: Record<string, unknown> = {}) => ({
        key: 'calm-01', title: 'Calm', artist: 'A. Composer', media_id: UPLOAD, url: `/api/uploads/${UPLOAD}`, license: 'Pixabay Content License', credit: '',
        credit_required: false, ...over,
    });
    const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));

    it('defaults to the look of data-model §6.1: Claude on the Mac writes, Gemini steps in, no character and no music yet', () => {
        assert.deepEqual(defaultStudioSettings().explainer, {
            style: 'warm hand-painted gouache illustration, soft paper texture, beige, terracotta and olive palette, thin ink outlines, simple shapes',
            characters: [],
            voices: { ar: 'ar-001-commercial-3', en: 'Sadaltager' },
            voice_style: 'a calm, warm documentary narrator; clear, unhurried, curious',
            pace: { ar: 1.8, en: 2.5 },
            writer: 'claude_mac',
            writer_fallback: true,
            title_color: '#FFD43B',
            defaults: { sound_mode: 'sfx', subtitles: true, language: 'ar', length_tier: 'short' },
            music: [],
        });
        assert.deepEqual(settingsProblems(defaultStudioSettings()), []);
    });

    it('is a fresh object each call, so one tenant’s merge cannot leak into the next', () => {
        const first = defaultStudioSettings();
        first.explainer.characters.push(character() as never);
        first.explainer.voices.en = 'Charon';
        first.explainer.pace.ar = 3;
        first.explainer.defaults.subtitles = false;
        assert.deepEqual(defaultStudioSettings().explainer.characters, []);
        assert.equal(defaultStudioSettings().explainer.voices.en, 'Sadaltager');
        assert.equal(defaultStudioSettings().explainer.pace.ar, 1.8);
        assert.equal(defaultStudioSettings().explainer.defaults.subtitles, true);
    });

    it('is a section of the settings row, merged and written like the others', () => {
        assert.ok((STUDIO_SETTINGS_SECTIONS as readonly string[]).includes('explainer'));
    });

    it('is NOT one of the settings the Creator Profile owns: a change to it never goes into the profile', () => {
        assert.ok(!(STUDIO_PROFILE_PATHS as readonly string[]).some((path) => path === 'explainer' || path.startsWith('explainer.')));
        const before = defaultStudioSettings();
        const after = mergeSettings(before, { explainer: { writer: 'gemini', title_color: '#112233', characters: [character()] } }, []);
        assert.notDeepEqual(before.explainer, after.explainer);
        assert.deepEqual(changedPaths(before, after, STUDIO_PROFILE_PATHS), []);
    });

    it('is what the owner’s seed script writes: the same values as the defaults, so the two cannot drift apart', async () => {
        const seed = await import(new URL('../../../scripts/seed-studio-settings.mjs', import.meta.url).href);
        assert.deepStrictEqual(seed.STUDIO_SETTINGS.explainer, defaultStudioSettings().explainer);
        assert.equal(JSON.stringify(seed.STUDIO_SETTINGS.explainer), JSON.stringify(defaultStudioSettings().explainer), 'in the same key order');
    });

    describe('writer and writer_fallback', () => {
        it('writer is claude_mac or gemini, and nothing else is accepted', () => {
            assert.deepEqual(problemsFor({ explainer: { writer: 'claude_mac' } }), []);
            assert.deepEqual(problemsFor({ explainer: { writer: 'gemini' } }), []);
            for (const bad of ['openai', 'Claude', 'claude', 'gemini ', '', null, 1, true, ['gemini']]) {
                const problems = problemsFor({ explainer: { writer: bad } });
                assert.ok(problems.some((p) => /^explainer\.writer must be one of claude_mac, gemini/.test(p)), `${JSON.stringify(bad)}: ${problems}`);
            }
        });

        it('writer_fallback is true or false, and nothing else is accepted', () => {
            assert.deepEqual(problemsFor({ explainer: { writer_fallback: false } }), []);
            assert.deepEqual(problemsFor({ explainer: { writer_fallback: true } }), []);
            for (const bad of ['true', 'yes', 1, 0, null]) {
                assert.ok(problemsFor({ explainer: { writer_fallback: bad } }).some((p) => /^explainer\.writer_fallback must be true or false/.test(p)), JSON.stringify(bad));
            }
        });

        it('the two are independent: Gemini without the fallback, Claude without it, both are valid', () => {
            for (const writer of ['claude_mac', 'gemini']) {
                for (const writer_fallback of [true, false]) assert.deepEqual(problemsFor({ explainer: { writer, writer_fallback } }), [], `${writer} ${writer_fallback}`);
            }
        });

        it('a change to one keeps the other: the merge is by field', () => {
            const next = mergeSettings(defaultStudioSettings(), { explainer: { writer: 'gemini' } }, []);
            assert.equal(next.explainer.writer, 'gemini');
            assert.equal(next.explainer.writer_fallback, true);
        });
    });

    describe('what a PUT is refused for', () => {
        const cases: [string, Record<string, unknown>, RegExp][] = [
            ['a seventh character', { explainer: { characters: many(7, (i) => character({ key: `c${i}` })) } }, /^explainer\.characters holds at most 6/],
            ['a character name over 30 characters', { explainer: { characters: [character({ name: 'n'.repeat(31) })] } }, /^explainer\.characters\[0\]\.name is 31 characters; the limit is 30/],
            ['a character description over 400 characters', { explainer: { characters: [character({ description: 'd'.repeat(401) })] } }, /^explainer\.characters\[0\]\.description is 401 characters; the limit is 400/],
            ['a character with no name', { explainer: { characters: [character({ name: ' ' })] } }, /^explainer\.characters\[0\]\.name is required/],
            ['a character with no description', { explainer: { characters: [character({ description: '' })] } }, /^explainer\.characters\[0\]\.description is required/],
            ['a character key with capitals', { explainer: { characters: [character({ key: 'Karim' })] } }, /^explainer\.characters\[0\]\.key must be 1 to 30 lower-case/],
            ['a character key with a space', { explainer: { characters: [character({ key: 'the man' })] } }, /\.key must be 1 to 30 lower-case/],
            ['a character key of 31 characters', { explainer: { characters: [character({ key: 'k'.repeat(31) })] } }, /\.key must be 1 to 30 lower-case/],
            ['a character that is not an object', { explainer: { characters: ['karim'] } }, /^explainer\.characters\[0\] must be an object/],
            ['two characters with one key', { explainer: { characters: [character(), character({ name: 'Other' })] } }, /^explainer\.characters\[1\]\.key "karim" is used twice/],
            ['a description of a woman', { explainer: { characters: [character({ description: 'a woman with a red scarf' })] } }, /^explainer\.characters\[0\]\.description mentions «woman»: Explainers never draw women or girls/],
            ['a description that says she', { explainer: { characters: [character({ description: 'a student; she wears glasses' })] } }, /description mentions «she»/],
            ['an Arabic description of a woman', { explainer: { characters: [character({ description: 'رجل بجانب امرأة' })] } }, /description mentions «امرأة»/],
            ['a name that is a woman', { explainer: { characters: [character({ name: 'The Lady' })] } }, /^explainer\.characters\[0\]\.name mentions «Lady»/],
            ['an approved picture with no date', { explainer: { characters: [character({ ...approved(), approved_at: null })] } }, /all set together, or all null/],
            ['an approved picture with no url', { explainer: { characters: [character({ ...approved(), ref_url: null })] } }, /all set together, or all null/],
            ['a picture URL that names another upload than its id', { explainer: { characters: [character({ ...approved(), ref_media_id: OTHER_UPLOAD })] } }, /ref_url is not the upload explainer\.characters\[0\]\.ref_media_id names/],
            ['a picture URL that is not one of our uploads', { explainer: { characters: [character({ ...approved(), ref_url: 'https://evil.example/pic.png' })] } }, /ref_url must be one of your uploads/],
            ['a picture id that is not an id', { explainer: { characters: [character({ ...approved(), ref_media_id: 'karim' })] } }, /ref_media_id must be the id of one of your uploads/],
            ['an approval date that is not a date', { explainer: { characters: [character({ ...approved(), approved_at: 'yesterday' })] } }, /approved_at must be a date and time/],
            ['31 music tracks', { explainer: { music: many(31, (i) => track({ key: `t${i}` })) } }, /^explainer\.music holds at most 30/],
            ['a track with no title', { explainer: { music: [track({ title: '' })] } }, /^explainer\.music\[0\]\.title is required/],
            ['a track with no licence', { explainer: { music: [track({ license: ' ' })] } }, /^explainer\.music\[0\]\.license is required/],
            ['a track whose licence needs credit and has none', { explainer: { music: [track({ credit_required: true, credit: ' ' })] } }, /^explainer\.music\[0\]\.credit is required when the licence requires credit/],
            ['a track credit over 300 characters', { explainer: { music: [track({ credit: 'c'.repeat(301) })] } }, /^explainer\.music\[0\]\.credit is 301 characters; the limit is 300/],
            ['a track whose credit_required is not a boolean', { explainer: { music: [track({ credit_required: 'yes' })] } }, /credit_required must be true or false/],
            ['a track that is not one of our uploads', { explainer: { music: [track({ url: 'https://evil.example/a.mp3' })] } }, /^explainer\.music\[0\]\.url must be one of your uploads/],
            ['a track whose URL is another upload than its id', { explainer: { music: [track({ url: `/api/uploads/${OTHER_UPLOAD}` })] } }, /url is not the upload explainer\.music\[0\]\.media_id names/],
            ['a track with no id', { explainer: { music: [track({ media_id: null })] } }, /media_id must be the id of one of your uploads/],
            ['two tracks with one key', { explainer: { music: [track(), track({ title: 'Other' })] } }, /^explainer\.music\[1\]\.key "calm-01" is used twice/],
            ['a title colour that is not #RRGGBB', { explainer: { title_color: 'yellow' } }, /^explainer\.title_color must be a colour like/],
            ['an Arabic voice that is not in the list', { explainer: { voices: { ar: 'Kore' } } }, /^explainer\.voices\.ar must be one of ar-001-commercial-3, Charon/],
            ['an English voice that is the Arabic-only one', { explainer: { voices: { en: 'ar-001-commercial-3' } } }, /^explainer\.voices\.en must be one of Charon, Sadaltager/],
            ['a voice with the wrong case', { explainer: { voices: { en: 'charon' } } }, /^explainer\.voices\.en must be one of/],
            ['a style over 600 characters', { explainer: { style: 's'.repeat(601) } }, /^explainer\.style is 601 characters; the limit is 600/],
            ['a voice style over 300 characters', { explainer: { voice_style: 'v'.repeat(301) } }, /^explainer\.voice_style is 301 characters; the limit is 300/],
            ['an Arabic pace of zero', { explainer: { pace: { ar: 0 } } }, /^explainer\.pace\.ar must be a number from 1 to 4/],
            ['an English pace of five words a second', { explainer: { pace: { en: 5 } } }, /^explainer\.pace\.en must be a number from 1 to 4/],
            ['a pace that is text', { explainer: { pace: { en: '2.5' } } }, /^explainer\.pace\.en must be a number/],
            ['a default sound that is neither music nor effects', { explainer: { defaults: { sound_mode: 'silence' } } }, /^explainer\.defaults\.sound_mode must be one of music, sfx/],
            ['default subtitles that are not a boolean', { explainer: { defaults: { subtitles: 'on' } } }, /^explainer\.defaults\.subtitles must be true or false/],
            ['a default language the writer does not speak', { explainer: { defaults: { language: 'fr' } } }, /^explainer\.defaults\.language must be one of ar, en/],
            ['a default length that is no tier', { explainer: { defaults: { length_tier: 'epic' } } }, /^explainer\.defaults\.length_tier must be one of short, medium, long/],
            ['a section that is not an object', { explainer: 'gemini' }, /^explainer must be an object/],
            ['a key that is not a setting: a typo does nothing', { explainer: { writter: 'gemini' } }, /^explainer\.writter is not a setting/],
            ['a key that is not a setting, deeper down', { explainer: { voices: { fr: 'Charon' } } }, /^explainer\.voices\.fr is not a setting/],
        ];
        for (const [name, patch, expected] of cases) {
            it(`refuses ${name}`, () => {
                const problems = problemsFor(patch);
                assert.ok(problems.some((p) => expected.test(p)), `expected ${expected} in:\n${problems.join('\n') || '(no problem at all)'}`);
            });
        }

        it('lists every problem it finds, not the first', () => {
            const problems = problemsFor({ explainer: { writer: 'openai', title_color: 'x', pace: { ar: 9 }, characters: [character({ description: 'a girl' })] } });
            for (const expected of [/explainer\.writer/, /explainer\.title_color/, /explainer\.pace\.ar/, /description mentions «girl»/]) {
                assert.ok(problems.some((p) => expected.test(p)), String(expected));
            }
        });
    });

    describe('what a PUT accepts', () => {
        it('six characters and thirty tracks, to the limit', () => {
            assert.deepEqual(problemsFor({ explainer: { characters: many(6, (i) => character({ key: `c${i}` })) } }), []);
            assert.deepEqual(problemsFor({ explainer: { music: many(30, (i) => track({ key: `t${i}` })) } }), []);
        });

        it('a character with no approved picture yet, and one with its approved picture', () => {
            assert.deepEqual(problemsFor({ explainer: { characters: [character(), character({ key: 'omar', name: 'Omar', ...approved() })] } }), []);
        });

        it('names and descriptions at their limits, and a name in Arabic', () => {
            assert.deepEqual(problemsFor({ explainer: { characters: [character({ name: 'ن'.repeat(30), description: 'd'.repeat(400) }), character({ key: 'kareem', name: 'كريم' })] } }), []);
        });

        it('a picture URL written with our address or as a path, and with the extension TikTok photos use', () => {
            for (const url of [`https://msg-response-auto.vercel.app/api/uploads/${UPLOAD}`, `/api/uploads/${UPLOAD}`, `/api/uploads/${UPLOAD}.jpg`, `/api/uploads/${UPLOAD.toUpperCase()}`]) {
                assert.deepEqual(problemsFor({ explainer: { characters: [character({ ...approved(), ref_url: url })] } }), [], url);
            }
        });

        it('every voice the list names, for the language it names it for', () => {
            for (const voice of ['ar-001-commercial-3', 'Charon', 'Sadaltager', 'Schedar', 'Gacrux', 'Sulafat', 'Achernar', 'Vindemiatrix', 'Rasalgethi']) {
                assert.deepEqual(problemsFor({ explainer: { voices: { ar: voice } } }), [], `ar ${voice}`);
            }
            for (const voice of ['Charon', 'Sadaltager', 'Schedar', 'Gacrux', 'Sulafat', 'Achernar', 'Vindemiatrix', 'Rasalgethi']) {
                assert.deepEqual(problemsFor({ explainer: { voices: { en: voice } } }), [], `en ${voice}`);
            }
            assert.deepEqual([...EXPLAINER_VOICES.en], [...EXPLAINER_VOICES.ar.slice(1)], 'English has the same names, without the Arabic-only voice');
        });

        it('a pace from 1 to 4 words a second, a style and a voice style at their limits, a track that needs credit and has it', () => {
            assert.deepEqual(problemsFor({ explainer: { pace: { ar: 1, en: 4 }, style: 's'.repeat(600), voice_style: 'v'.repeat(300) } }), []);
            assert.deepEqual(problemsFor({ explainer: { music: [track({ credit_required: true, credit: 'Music: Kevin MacLeod (incompetech.com), CC BY 4.0' })] } }), []);
        });

        it('replaces a list whole and merges the objects field by field', () => {
            const problems: string[] = [];
            const base = mergeSettings(defaultStudioSettings(), { explainer: { characters: [character(), character({ key: 'omar', name: 'Omar' })], music: [track()] } }, problems);
            const next = mergeSettings(base, { explainer: { characters: [character({ key: 'only' })], voices: { en: 'Charon' }, defaults: { subtitles: false } } }, problems);
            assert.deepEqual(problems, []);
            assert.deepEqual(next.explainer.characters.map((c) => c.key), ['only'], 'the list is the one sent');
            assert.equal(next.explainer.music.length, 1, 'a list not sent is kept');
            assert.deepEqual(next.explainer.voices, { ar: 'ar-001-commercial-3', en: 'Charon' });
            assert.deepEqual(next.explainer.defaults, { sound_mode: 'sfx', subtitles: false, language: 'ar', length_tier: 'short' });
        });
    });

    describe('read and written with the other sections', () => {
        let statements: { sql: string; params: unknown[] }[] = [];
        let stored: Record<string, unknown> | null = null;
        const originalQuery = pool.query;
        const originalConnect = pool.connect;

        beforeEach(() => {
            statements = [];
            stored = null;
            (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
                statements.push({ sql: sql.replace(/\s+/g, ' '), params });
                if (/FROM studio_settings/.test(sql)) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
                return { rows: [], rowCount: 1 };
            };
            (pool as unknown as { connect: unknown }).connect = async () => ({ query: (pool as unknown as { query: unknown }).query, release() {} });
        });
        afterEach(() => {
            (pool as unknown as { query: unknown }).query = originalQuery;
            (pool as unknown as { connect: unknown }).connect = originalConnect;
        });

        const write = () => statements.find((s) => /INSERT INTO studio_settings/.test(s.sql));

        it('is selected with the row, and written with it as the eleventh value of the upsert', async () => {
            await getStudioSettings(TENANT);
            assert.match(statements[0]!.sql, /SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic, explainer FROM studio_settings/);
            await updateStudioSettings(TENANT, { schedule: { timezone: 'Asia/Riyadh' } });
            assert.match(write()!.sql, /infographic, explainer, updated_at\) VALUES \(\$1, \$2::jsonb, \$3::jsonb, \$4::jsonb, \$5::jsonb, \$6::jsonb, \$7::jsonb, \$8::jsonb, \$9::jsonb, \$10::jsonb, \$11::jsonb, NOW\(\)\)/);
            assert.match(write()!.sql, /explainer = EXCLUDED\.explainer/);
            assert.deepEqual(JSON.parse(write()!.params[10] as string), defaultStudioSettings().explainer);
        });

        it('reads a row from before the section over the defaults, whether the column is empty, missing, or null', async () => {
            for (const column of [{}, undefined, null]) {
                stored = { ...defaultStudioSettings(), explainer: column };
                assert.deepEqual((await getStudioSettings(TENANT)).explainer, defaultStudioSettings().explainer, JSON.stringify(column) ?? 'undefined');
            }
        });

        it('reads a stored section over the defaults, field by field: a section saved before a field existed gets its default', async () => {
            stored = { explainer: { writer: 'gemini', voices: { en: 'Charon' }, characters: [character()] } };
            const { explainer } = await getStudioSettings(TENANT);
            assert.equal(explainer.writer, 'gemini');
            assert.equal(explainer.writer_fallback, true, 'a field the row lacks is its default');
            assert.deepEqual(explainer.voices, { ar: 'ar-001-commercial-3', en: 'Charon' });
            assert.equal(explainer.characters.length, 1);
            assert.equal(explainer.title_color, '#FFD43B');
        });

        it('keeps what the tenant saved when another section is saved: the whole row is written back, this section as stored', async () => {
            const saved = { ...defaultStudioSettings().explainer, writer: 'gemini', writer_fallback: false, characters: [character({ ...approved() })] };
            stored = { ...defaultStudioSettings(), explainer: saved };
            await updateStudioSettings(TENANT, { voice: { guide: 'Short.' } });
            assert.deepEqual(JSON.parse(write()!.params[10] as string), saved);
        });

        it('saves a change to the section, merged into the stored one, and reports the section as changed', async () => {
            stored = { ...defaultStudioSettings(), explainer: { ...defaultStudioSettings().explainer, title_color: '#112233' } };
            const { settings, changed } = await updateStudioSettings(TENANT, { explainer: { writer: 'gemini', writer_fallback: false } });
            assert.deepEqual(changed, ['explainer']);
            assert.equal(settings.explainer.writer, 'gemini');
            assert.equal(settings.explainer.title_color, '#112233', 'the sibling field is kept');
            assert.deepEqual(JSON.parse(write()!.params[10] as string), { ...defaultStudioSettings().explainer, title_color: '#112233', writer: 'gemini', writer_fallback: false });
        });

        it('refuses a writer that is not Claude on the Mac or Gemini with a 400, and writes nothing', async () => {
            await assert.rejects(
                updateStudioSettings(TENANT, { explainer: { writer: 'openai' } }),
                (err: unknown) => err instanceof StudioError && err.status === 400 && Boolean(err.problems?.some((p) => /^explainer\.writer must be one of claude_mac, gemini/.test(p)))
            );
            assert.equal(write(), undefined);
        });

        it('refuses a character that describes a woman with a 400, before anything is saved', async () => {
            await assert.rejects(
                updateStudioSettings(TENANT, { explainer: { characters: [character({ description: 'a girl in a yellow coat' })] } }),
                (err: unknown) => err instanceof StudioError && err.status === 400 && Boolean(err.problems?.some((p) => /description mentions «girl»/.test(p)))
            );
            assert.equal(write(), undefined);
        });

        it('never writes to the profile for it: a change to the section only touches the settings row', async () => {
            await updateStudioSettings(TENANT, { explainer: { title_color: '#abcdef' } });
            assert.equal(statements.filter((s) => /creator_profile_versions|INSERT INTO creator_profiles|UPDATE creator_profiles/.test(s.sql)).length, 0);
        });
    });
});

describe('getMonteurSettings — the claim path’s read', () => {
    it('reads the monteur section and the timezone only, never the 100KB examples', async () => {
        const originalQuery = pool.query;
        const statements: string[] = [];
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            statements.push(sql.replace(/\s+/g, ' '));
            // The second statement is the profile's timezone (a different table); this tenant has no stored profile.
            if (/FROM creator_profiles/.test(sql)) return { rows: [], rowCount: 0 };
            return { rows: [{ monteur: { enabled: true, folder: '/v' }, schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] } }], rowCount: 1 };
        };
        try {
            const { monteur, timezone } = await getMonteurSettings(TENANT);
            assert.equal(monteur.folder, '/v');
            assert.equal(monteur.run_at, '07:00', 'over the defaults');
            assert.equal(timezone, 'Asia/Riyadh');
            assert.deepEqual(statements, [
                'SELECT monteur, schedule FROM studio_settings WHERE creator_id = $1',
                // Narrow: the two values the timezone is read from, never the whole profile.
                `SELECT profile->'schema' AS profile_schema, profile->'identity'->'timezone' AS identity_timezone FROM creator_profiles WHERE creator_id = $1`,
            ]);
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
        }
    });
});
