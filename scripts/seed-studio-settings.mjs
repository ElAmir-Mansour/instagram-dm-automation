#!/usr/bin/env node
/**
 * Seed one tenant's Carousel Studio settings with ElAmir's values (STUDIO.md §10).
 *
 * A script, not a migration: the Studio is a feature for any tenant, and nothing about one
 * creator may live in code the whole deployment runs. A migration would write these values
 * into every database the schema is applied to. This writes them to one tenant, once.
 *
 *   node --env-file=.env scripts/seed-studio-settings.mjs <creatorId>             write them
 *   node --env-file=.env scripts/seed-studio-settings.mjs <creatorId> --dry-run   print, write nothing
 *   node --env-file=.env scripts/seed-studio-settings.mjs <creatorId> --force     replace saved settings
 *
 * Refuses to replace settings the tenant has already saved unless `--force` is given: those
 * were edited in the dashboard, and this would silently undo them.
 *
 * `settings.test.ts` imports STUDIO_SETTINGS and holds it to the same validation as
 * `PUT /api/studio/settings`, so a typo here fails CI instead of the first render.
 */
import pg from 'pg';
import path from 'path';
import { pathToFileURL } from 'url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STUDIO_SETTINGS = {
    brand: {
        name: 'Agentic AI بالعربي',
        signature: { latin: 'AGENTIC AI', local: 'بالعربي' },
        palette: [
            '#FFD60A', '#FF8A3D', '#22C7F0', '#FF5FA2', '#B06AFF', '#FFB020', '#A3E635',
            '#F0ABFC', '#FF3B5C', '#5EEAD4', '#22D39A', '#5B8CFF', '#FF6B6B',
        ],
        colors: { ink: '#08080A', paper: '#FAFAFA', muted: '#8A8A93' },
        fonts: { display: 'Cairo', mono: 'JetBrains Mono' },
        direction: 'rtl',
        theme: 'dark-grid',
    },
    voice: {
        language: 'ar',
        digits: 'arabic-indic',
        guide: [
            'Write in a light Gulf / white Arabic dialect: warm and direct, the way a Saudi creator talks to followers.',
            'Never formal MSA, never heavy slang.',
            'Use Arabic-Indic digits (٣ not 3) everywhere in Arabic text.',
            'Lead with the result the viewer gets, then name the tool that gets it.',
            'Short lines: one idea per line, one point per slide.',
            'Product and tool names stay in English (NotebookLM, Gemini, Stitch).',
            'No invented features or numbers: every claim comes from the lesson.',
            'TikTok copy points to the link in the bio («رابطه في البايو»), never to the comments.',
        ].join('\n'),
        // The course's MCP section is not published yet.
        avoid: ['MCP'],
    },
    product: {
        name: 'Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي',
        url: 'https://www.udemy.com/course/agentic-ai-arabic/?referralCode=02A626DDDA3FDAB6AB34',
        facts: ['٣٤ درس', '٥ ساعات و٤٠ دقيقة', 'شهادة إتمام'],
        dmBullets: [
            '✅ ٣٤ درس · ٥ ساعات و٤٠ دقيقة',
            '✅ ١١ قسم — كل قسم تطبيق عملي من الصفر',
            '✅ شهادة إتمام + وصول مدى الحياة',
            '✅ ضمان استرجاع ٣٠ يوم من Udemy',
        ],
    },
    cta: {
        instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩',
        tiktokLine: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗',
        // STUDIO.md §8, with its two topical lines, the link and the ✅ lines as placeholders.
        dmTemplate: [
            'هلا {username} 👋',
            '',
            '{question}',
            '',
            '{pitch}',
            '',
            '🎬 شوف الكورس كامل من هنا:',
            '{url}',
            '',
            'داخل الكورس:',
            '{bullets}',
            '',
            'عندك سؤال؟ رد على هالرسالة — أنا أرد بنفسي ✌️',
        ].join('\n'),
        slide: {
            igAsk: 'اكتب في التعليقات',
            igSub: 'ويوصلك الرابط بالخاص 📩',
            save: 'احفظ المنشور',
            ttHeadline: 'الكورس كامل بالعربي',
            ttPill: 'رابطه في البايو',
            ttSub: 'ادخل البروفايل واضغط الرابط 👆',
            follow: 'تابعني للمزيد',
            swipe: 'اسحب',
        },
    },
    schedule: { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] },
    library: { root: '/Users/elamir/Desktop/AI Course' },
    examples: null,
};

async function main() {
    const [creatorId, ...flags] = process.argv.slice(2);
    const dryRun = flags.includes('--dry-run');
    const force = flags.includes('--force');

    if (!creatorId || !UUID.test(creatorId)) {
        console.error('Usage: node --env-file=.env scripts/seed-studio-settings.mjs <creatorId> [--dry-run] [--force]');
        process.exitCode = 1;
        return;
    }
    if (dryRun) {
        console.log(JSON.stringify(STUDIO_SETTINGS, null, 2));
        return;
    }
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set. Try: node --env-file=.env scripts/seed-studio-settings.mjs <creatorId>');
        process.exitCode = 1;
        return;
    }

    const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
    });
    try {
        const creator = await pool.query('SELECT id, name FROM creators WHERE id = $1', [creatorId]);
        if (!creator.rows[0]) {
            console.error(`No creator with id ${creatorId}.`);
            process.exitCode = 1;
            return;
        }
        const existing = await pool.query('SELECT updated_at FROM studio_settings WHERE creator_id = $1', [creatorId]);
        if (existing.rows[0] && !force) {
            console.error(`This tenant already has Studio settings (saved ${existing.rows[0].updated_at?.toISOString?.() ?? 'earlier'}). Re-run with --force to replace them.`);
            process.exitCode = 1;
            return;
        }
        const s = STUDIO_SETTINGS;
        await pool.query(
            `INSERT INTO studio_settings (creator_id, brand, voice, product, cta, schedule, library, examples, updated_at)
             VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
             ON CONFLICT (creator_id) DO UPDATE
                SET brand = EXCLUDED.brand, voice = EXCLUDED.voice, product = EXCLUDED.product,
                    cta = EXCLUDED.cta, schedule = EXCLUDED.schedule, library = EXCLUDED.library,
                    examples = EXCLUDED.examples, updated_at = NOW()`,
            [
                creatorId,
                JSON.stringify(s.brand), JSON.stringify(s.voice), JSON.stringify(s.product),
                JSON.stringify(s.cta), JSON.stringify(s.schedule), JSON.stringify(s.library),
                s.examples === null ? null : JSON.stringify(s.examples),
            ]
        );
        console.log(`Seeded Studio settings for ${creator.rows[0].name ?? creatorId}.`);
    } finally {
        await pool.end();
    }
}

// Run only when executed, so the test can import STUDIO_SETTINGS without touching a database.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        console.error(err?.message ?? err);
        process.exitCode = 1;
    });
}
