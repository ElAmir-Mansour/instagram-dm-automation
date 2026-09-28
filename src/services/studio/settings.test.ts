/**
 * Per-tenant Studio settings: the neutral defaults, the seed script's values, the partial-merge
 * PUT and the rules every stored setting holds. Nothing here reaches a database: the pool is
 * stubbed where the read and write paths are exercised.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { StudioSettings } from '../../db/rows.js';
import { StudioError } from './common.js';
import {
    defaultStudioSettings, getMonteurSettings, getStudioSettings, mergeSettings, overDefaults, settingsProblems, updateStudioSettings,
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

    beforeEach(() => {
        statements = [];
        stored = null;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' '), params });
            if (/FROM studio_settings/.test(sql)) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
            return { rows: [], rowCount: 1 };
        };
    });
    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalQuery;
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
            enabled: false, source: 'folder', mode: 'review', brain: 'gemini', folder: null, run_at: '07:00', videos_per_run: 1, reels_per_video: 1,
            platforms: ['instagram', 'facebook', 'tiktok'], post_at: ['19:00'], min_seconds: 20, max_seconds: 45,
        });
    });

    it('brain: Gemini by default, Claude on the Mac when chosen, nothing else', () => {
        assert.equal(overDefaults({ monteur: { enabled: true } } as never).monteur.brain, 'gemini', 'a section saved before brain existed');
        assert.deepEqual(problemsFor({ monteur: { brain: 'claude_mac' } }), []);
        assert.deepEqual(problemsFor({ monteur: { brain: 'claude' } }), ['monteur.brain must be one of gemini, claude_mac']);
        assert.deepEqual(problemsFor({ monteur: { brain: null } }), ['monteur.brain must be one of gemini, claude_mac']);
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
        ['a platform it cannot post to', { platforms: ['youtube'] }, /monteur\.platforms\[0\] must be one of instagram, facebook, tiktok/],
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
        const statements: { sql: string; params: unknown[] }[] = [];
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' '), params });
            if (/FROM studio_settings/.test(sql)) return { rows: [{ monteur: { enabled: true, folder: '/v' } }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        };
        try {
            const read = await getStudioSettings(TENANT);
            assert.equal(read.monteur.folder, '/v');
            assert.equal(read.monteur.run_at, '07:00', 'a stored section is merged over the defaults');
            assert.match(statements[0]!.sql, /SELECT brand, voice, product, cta, schedule, library, examples, monteur FROM studio_settings/);

            await updateStudioSettings(TENANT, { monteur: { run_at: '06:30' } });
            const write = statements.find((s) => /INSERT INTO studio_settings/.test(s.sql))!;
            assert.match(write.sql, /examples, monteur, updated_at\) VALUES/);
            assert.match(write.sql, /monteur = EXCLUDED\.monteur/);
            assert.deepEqual(JSON.parse(write.params[8] as string), { ...read.monteur, run_at: '06:30' });
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
        }
    });
});

describe('the monteur source — a scan still waiting for the old one is superseded', () => {
    async function change(stored: Record<string, unknown>, patch: Record<string, unknown>): Promise<{ sql: string; params: unknown[] }[]> {
        const originalQuery = pool.query;
        const statements: { sql: string; params: unknown[] }[] = [];
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/FROM studio_settings/.test(sql)) return { rows: [{ monteur: stored }], rowCount: 1 };
            return { rows: [], rowCount: 1 };
        };
        try {
            await updateStudioSettings(TENANT, { monteur: patch });
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
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

describe('getMonteurSettings — the claim path’s read', () => {
    it('reads the monteur section and the timezone only, never the 100KB examples', async () => {
        const originalQuery = pool.query;
        const statements: string[] = [];
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            statements.push(sql.replace(/\s+/g, ' '));
            return { rows: [{ monteur: { enabled: true, folder: '/v' }, schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] } }], rowCount: 1 };
        };
        try {
            const { monteur, timezone } = await getMonteurSettings(TENANT);
            assert.equal(monteur.folder, '/v');
            assert.equal(monteur.run_at, '07:00', 'over the defaults');
            assert.equal(timezone, 'Asia/Riyadh');
            assert.deepEqual(statements, ['SELECT monteur, schedule FROM studio_settings WHERE creator_id = $1']);
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
        }
    });
});
