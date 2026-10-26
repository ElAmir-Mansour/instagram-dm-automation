/**
 * Help Center: five statements that did not match the product, pinned to what the product says and does.
 *
 * `help-labels.test.ts` checks that the NAMES in the Help Center are the interface's names. It cannot check a SENTENCE, and five sentences were wrong
 * (2026-10-25): what Disconnect TikTok does to a scheduled post, what "public automatically" covers after TikTok's audit, the city radius, the alerts
 * the Settings card lists and the button that tests them, and "Lead ads come later". Each was true once, or true of one screen, and nothing tied it to
 * the code afterwards. This does, the same way for each: the number, the list or the rule is read from the code (or the dictionary) the sentence is about,
 * and the article has to say it. When a test here fails, the code changed under a sentence: read the sentence again before changing the test.
 *
 * Read from the code, never retyped: the alert kinds from `settings.ts`, the radius from `spec.ts` and `ads_create.js`, the labels from the dictionaries.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { decideAgent, HISTORY_WINDOW } from '../services/ai.js';
import { REQUIRED_ALERT_KINDS, SHOWN_ALERT_KINDS } from '../services/ads/settings.js';
import { MIN_VARIANT_SAMPLE } from '../services/dmVariantFunnel.js';
import { FOLLOWUP_MINUTES_DEFAULT, FOLLOWUP_MINUTES_MAX, FOLLOWUP_MINUTES_MIN, FOLLOWUP_WINDOW_MS, MAX_FOLLOWUPS_PER_CONVERSATION } from '../services/dmSales/followup.js';
import { MAX_ABUSE_STRIKES, MAX_AI_REPLIES_PER_HOUR } from '../services/dmSales/flow.js';
import { ICE_BREAKER_MAX, ICE_BREAKER_QUESTION_MAX, MENU_ITEMS_MAX, MENU_TITLE_MAX, TAP_CODES } from '../services/dmSales/iceBreakers.js';
import { DEFAULT_SALES_MODE, MAX_TEST_SENDERS, SALES_MODES, SENDER_ID } from '../services/dmSales/mode.js';
import { MAX_QUALIFIER_TURNS } from '../services/dmSales/types.js';
import { MAX_VARIANTS, MIN_VARIANTS, VARIANT_LABEL_MAX, VARIANT_TEXT_MAX, VARIANT_WEIGHT_MAX } from '../services/dmSales/variants.js';
import { MINUTES_PER_REEL, reelsForLength } from '../services/monteur/pick.js';
import { DRAFTS_PER_DAY } from '../services/onboarding/draftStep.js';
import { PROOFS_PER_DAY, REGENERATIONS_PER_CARD } from '../services/onboarding/proofRules.js';
import { stepsFor, NO_FLAGS, WIZARD_STEPS } from '../services/onboardingWizard.js';
import { captionProblems } from '../services/studio/infographicSpec.js';
import { PICK_FOLDER_TTL_MINUTES } from '../services/studio/jobs.js';
import { SCAN_EXTENSIONS, SCAN_MIN_AGE_S } from '../services/monteur/daily.js';
import { toYouTubeError, YouTubeApiError } from '../services/youtube.js';
import { uploadPrivacy } from '../services/youtubePublish.js';

type Json = Record<string, any>;
type Lang = 'ar' | 'en';

const ctx: Json = {};
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const file of ['dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js']) {
    vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
}
const STRINGS = vm.runInContext('I18N.strings', ctx) as Record<Lang, Record<string, string>>;
const CONTENT = vm.runInContext(`${readFileSync('dashboard/js/help-content.js', 'utf8')}\n;HelpContent`, ctx, { filename: 'help-content.js' }) as Json;
const LANGS = ['ar', 'en'] as const;

const label = (lang: Lang, key: string): string => {
    const value = STRINGS[lang][key];
    assert.ok(typeof value === 'string', `${lang} has ${key}`);
    return value!;
};

function sectionBody(slug: string, id: string, lang: Lang): unknown[] {
    const article = (CONTENT.articles as Json[]).find((a) => a.slug === slug);
    assert.ok(article, `the article ${slug}`);
    const section = (article!.sections as Json[]).find((s) => s.id === id);
    assert.ok(section, `${slug}#${id}`);
    return section!.body[lang] as unknown[];
}

/** The items of the n-th list block (`ul`, `ol` or `dl`) of a section. */
function listOf(slug: string, id: string, lang: Lang, kind: 'ul' | 'ol' | 'dl', n = 0): any[] {
    const lists = sectionBody(slug, id, lang).filter((b): b is Json => !!b && typeof b === 'object' && Array.isArray((b as Json)[kind]));
    assert.ok(lists[n], `${slug}#${id} (${lang}) has a ${kind} list number ${n}`);
    return lists[n]![kind] as any[];
}

/** Every string of a section, in order. */
function textOf(slug: string, id: string, lang: Lang): string {
    const out: string[] = [];
    const walk = (value: unknown): void => {
        if (typeof value === 'string') out.push(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(sectionBody(slug, id, lang));
    return out.join('\n');
}

const bold = (text: string) => `**${text}**`;

// ─── 1. Disconnect TikTok ────────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — what Disconnect TikTok does to a scheduled post', () => {
    for (const lang of LANGS) {
        it(`says a post that comes due while TikTok is disconnected fails, and that Publish now retries it (${lang})`, () => {
            const publishNow = bold(label(lang, 'posts.publishNow'));
            const failed = bold(label(lang, 'state.failed'));
            const items = listOf('tiktok', 'connect', lang, 'ul') as string[];

            const disconnect = items.find((i) => i.startsWith(bold(lang === 'en' ? label(lang, 'settings.tiktok.disconnect') : 'فصل تيك توك')));
            assert.ok(disconnect, 'the Disconnect bullet');
            assert.ok(disconnect!.includes(failed), `it says the post shows ${failed}`);
            assert.ok(disconnect!.includes(publishNow), `and that ${publishNow} retries it`);

            // The same publish path runs for a connection that needs reconnecting, so its bullet may not promise more.
            const invalid = items.find((i) => i.includes(bold(label(lang, 'settings.tiktok.statusInvalid'))));
            assert.ok(invalid, 'the Needs reconnecting bullet');
            assert.ok(invalid!.includes(failed) && invalid!.includes(publishNow), 'says the same of a post that comes due before the reconnect');

            const old = lang === 'en' ? /nothing is sent until|won.t be sent until/i : /ما تنرسل لين|لن تُرسَل حتى/;
            assert.equal(old.test(disconnect!), false, 'and no longer says nothing is sent');
        });

        it(`says the same in the Disconnect dialog, which is where the owner decides (${lang})`, () => {
            const hint = label(lang, 'settings.tiktok.disconnectHint');
            assert.ok(hint.includes(label(lang, 'posts.publishNow')), `the dialog names ${label(lang, 'posts.publishNow')}: ${hint}`);
            const old = lang === 'en' ? /won.t be sent until/i : /لن تُرسَل حتى/;
            assert.equal(old.test(hint), false);
        });
    }

    it('is what the code does: a due post with no stored connection, or one that needs reconnecting, is FAILED, never held', () => {
        // Behaviour is proved against the stubbed pool in tiktokPublish.test.ts; this pins the three facts the sentence stands on.
        const sweep = readFileSync('src/routes/api.ts', 'utf8');
        assert.match(sweep, /WHERE s\.status = 'PENDING' AND s\.scheduled_time <= NOW\(\) AND s\.archived_at IS NULL/, 'the sweep takes every due PENDING row, whatever its connection');
        assert.ok(!/platform_connections/.test(sweep.slice(sweep.indexOf('export async function publishDuePosts'), sweep.indexOf('export async function publishDuePosts') + 1500)), 'and looks at no connection to decide');
        const publish = readFileSync('src/services/tiktokPublish.ts', 'utf8');
        assert.match(publish, /const \{ accessToken, connection \} = await getAccessToken\(post\.creator_id\);/, 'the token is fetched inside publishTikTokPost\'s try');
        assert.match(publish, /SET status = 'FAILED', error_log = \$2\s+WHERE id = \$1 AND status IN \('PUBLISHING', 'PROCESSING', 'PENDING'\)/, 'and any error but a full inbox ends in FAILED');
    });
});

// ─── 2. TikTok after the audit ───────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — what "public automatically" covers once TikTok has approved the app', () => {
    it('is what the code does: the Studio and the Monteur set Everyone once audited, and the composer starts with no privacy chosen', () => {
        assert.match(readFileSync('src/services/studio/schedule.ts', 'utf8'), /privacy_level: audited \? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY'/, 'the Studio\'s options');
        assert.match(readFileSync('src/services/studio/schedule.ts', 'utf8'), /studioTikTokOptions\(carousel, flags\.audited\)/, 'used for a carousel');
        assert.match(readFileSync('src/services/monteur/clips.ts', 'utf8'), /studioTikTokOptions\(null, flags\.audited, 'video'\)/, 'and for a Monteur reel');
        assert.match(readFileSync('dashboard/js/pages/posts.js', 'utf8'), /TIKTOK_DEFAULT_CHOICES: Object\.freeze\(\{\s*privacy_level: '',/, 'while the composer\'s choice starts empty');
    });

    for (const lang of LANGS) {
        it(`says so: public by itself for what the Studio makes, a choice for what you make in the composer (${lang})`, () => {
            const items = listOf('tiktok', 'after-approval', lang, 'ul') as string[];
            const everyone = bold(label(lang, 'posts.tiktok.privacy.public'));
            const automatic = items[0]!;
            assert.ok(automatic.includes(bold(lang === 'en' ? 'public automatically' : 'عامة تلقائياً')), 'the first bullet keeps its emphasis');
            assert.ok(automatic.includes(bold(label(lang, 'nav.monteur'))), 'and names where the reels come from');
            assert.ok(automatic.includes(everyone), `and says the app chooses ${everyone}`);

            const composer = items[1]!;
            for (const key of ['nav.posts', 'posts.tiktok.direct.title', 'posts.tiktok.direct.privacy', 'posts.tiktok.direct.privacyPhoto', 'posts.tiktok.privacy.public']) {
                assert.ok(composer.includes(bold(label(lang, key))), `the composer bullet names ${bold(label(lang, key))}`);
            }
            const claim = lang === 'en' ? /with the privacy you choose/ : /بالخصوصية اللي تختارها/;
            assert.equal(items.some((i) => claim.test(i)), false, 'and no bullet says every post goes up with the privacy you choose');
        });
    }
});

// ─── 3. The city radius ──────────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — the city radius of an ad', () => {
    const spec = readFileSync('src/services/ads/spec.ts', 'utf8');
    const builder = readFileSync('dashboard/js/pages/ads_create.js', 'utf8');
    const server = /cityRadiusMin: (\d+), cityRadiusMax: (\d+)/.exec(spec);
    const screen = /RADIUS_MIN: (\d+),\s*RADIUS_MAX: (\d+)/.exec(builder);

    it('is one range in the server and in the builder', () => {
        assert.ok(server && screen, 'both constants found');
        assert.deepEqual([server![1], server![2]], [screen![1], screen![2]]);
    });

    for (const lang of LANGS) {
        it(`names that range in Audience, and the special category's own minimum (${lang})`, () => {
            const [min, max] = [server![1]!, server![2]!];
            const row = (listOf('ads', 'targeting', lang, 'dl') as string[][]).find((r) => r[0] === (lang === 'en' ? 'Cities' : 'المدن'));
            assert.ok(row, 'the Cities row');
            assert.ok(lang === 'en' ? row![1]!.includes(`radius of ${min} to ${max} km`) : row![1]!.includes(`بين ${min} و${max} كيلومترًا`), row![1]);
            const special = /specialCityRadiusMin: (\d+)/.exec(spec)![1]!;
            assert.ok(textOf('ads', 'targeting', lang).includes(special), `the special category's ${special} km is still said`);
        });
    }
});

// ─── 4. The alerts ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Source files the alert kinds could be raised from: everything under src that is not a test. */
function sources(dir = 'src'): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return sources(path);
        return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
    });
}

describe('Help Center — the alerts the Settings card lists', () => {
    for (const lang of LANGS) {
        it(`lists every kind the card shows, in its order, under the card's own name, and marks the three that cannot be switched off (${lang})`, () => {
            const items = listOf('ads', 'alerts', lang, 'ul') as string[];
            assert.equal(items.length, SHOWN_ALERT_KINDS.length, 'one item per kind the card shows');
            const required = lang === 'en' ? 'Required:' : 'مطلوب:';
            SHOWN_ALERT_KINDS.forEach((kind, i) => {
                const name = label(lang, `settings.ads.alert.kind.${kind}`);
                assert.ok(items[i]!.startsWith(`**${name}:**`), `item ${i + 1} is «${name}», the card's name for ${kind}: ${items[i]!.slice(0, 80)}`);
                assert.equal(items[i]!.includes(required), (REQUIRED_ALERT_KINDS as readonly string[]).includes(kind), `${kind}: ${(REQUIRED_ALERT_KINDS as readonly string[]).includes(kind) ? 'says' : 'does not say'} it cannot be switched off`);
            });
        });

        it(`names the card's own button and field, and none of the names it used to give them (${lang})`, () => {
            const text = textOf('ads', 'alerts', lang);
            for (const key of ['settings.ads.alerts.test', 'settings.ads.alerts.chat', 'settings.ads.alerts.kinds', 'settings.ads.alerts.required', 'settings.ads.alerts.title', 'boost.settings.title']) {
                assert.ok(text.includes(bold(label(lang, key))), `${bold(label(lang, key))} (${key})`);
            }
            const stale = lang === 'en' ? ['Send test message', 'Your chat id', 'after saving'] : ['أرسل رسالة تجريبية', 'رقم محادثتك', 'بعد الحفظ'];
            for (const old of stale) assert.equal(text.includes(old), false, `no «${old}»`);
        });
    }

    it('says "not sent yet" for the kinds nothing raises, and only for them: the day one is wired, this fails and the row changes', () => {
        const defined = new Set(['src/services/ads/settings.ts', 'src/services/ads/notify.ts']);
        const raisedBy = (kind: string) => sources().filter((f) => !defined.has(f.replace(/\\/g, '/'))).filter((f) => new RegExp(`['"]${kind}['"]`).test(readFileSync(f, 'utf8')));
        const notRaised = SHOWN_ALERT_KINDS.filter((kind) => raisedBy(kind).length === 0);
        assert.deepEqual([...notRaised], [], 'the kinds no source file raises (a kind raised now is one more row to re-read, and one less "not sent yet")');

        for (const lang of LANGS) {
            const items = listOf('ads', 'alerts', lang, 'ul') as string[];
            const unsent = lang === 'en' ? /not sent yet/ : /لا يُرسَل حالياً/;
            SHOWN_ALERT_KINDS.forEach((kind, i) => assert.equal(unsent.test(items[i]!), (notRaised as readonly string[]).includes(kind), `${lang} ${kind}`));
        }
    });

    it('is what the code does for the three that cannot be switched off', () => {
        assert.deepEqual([...REQUIRED_ALERT_KINDS], ['cap_paused', 'guard_blind', 'token_dead']);
    });

    it('names every kind the card shows in both dictionaries, so none reaches the screen as its raw id', () => {
        for (const lang of LANGS) {
            for (const kind of SHOWN_ALERT_KINDS) assert.ok(label(lang, `settings.ads.alert.kind.${kind}`).length > 0, `${lang} ${kind}`);
        }
    });
});

// ─── 5. The Leads goal ───────────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — the Leads goal in the builder', () => {
    it('is what the code does: offered in the list, and locked per workspace until a legal sign-off', () => {
        const builder = readFileSync('dashboard/js/pages/ads_create.js', 'utf8');
        assert.match(builder, /GOALS: Object\.freeze\(\['messages', 'traffic', 'engagement', 'reach', 'leads'\]\)/);
        assert.match(builder, /LOCKED_GOALS: Object\.freeze\(\['leads'\]\)/);
        assert.match(builder, /this\.leadForms && this\.leadForms\.locked === false/, 'unlocked only when the server says a sign-off is recorded');
    });

    for (const lang of LANGS) {
        it(`says the goal is on the list and shows Locked, and links to the section about it (${lang})`, () => {
            const goal = (listOf('ads', 'builder', lang, 'ol') as string[])[0]!;
            assert.ok(goal.startsWith(bold(`${label(lang, 'adsCreate.step.goal')}:`)), goal);
            assert.ok(goal.includes(bold(label(lang, 'adsCreate.goal.leads'))), 'names the goal as the screen does');
            assert.ok(goal.includes(bold(label(lang, 'adsCreate.goal.locked'))), 'and the badge it carries');
            assert.ok(goal.includes('[[ads#lead-ads]]'), 'and where the sign-off is explained');
            assert.equal(lang === 'en' ? /come later/.test(goal) : /تأتي لاحقًا/.test(goal), false, 'and no longer says they come later');
        });
    }
});

// ─── 6. The Monteur ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One number a source file declares as `export const NAME = <number>`: read, never retyped. */
function declared(file: string, name: string): number {
    const m = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*(\\d+)`).exec(readFileSync(file, 'utf8'));
    assert.ok(m, `${file} declares ${name}`);
    return Number(m![1]);
}

describe('Help Center — the Monteur', () => {
    it('is what the code does: one reel for each started 10 minutes, up to the setting', () => {
        assert.equal(MINUTES_PER_REEL, 10);
        assert.deepEqual([5, 11, 33].map((minutes) => reelsForLength(minutes * 60, 3)), [1, 2, 3], 'the three videos the article works out, with the setting at 3');
        assert.equal(reelsForLength(33 * 60, 2), 2, 'and never more than the setting');
        const settings = readFileSync('src/services/studio/settings.ts', 'utf8');
        assert.match(settings, /between\(monteur\.reels_per_video, 'monteur\.reels_per_video', 1, 5, true\)/, 'Most reels per video: 1 to 5');
        assert.match(settings, /between\(monteur\.videos_per_run, 'monteur\.videos_per_run', 1, 10, true\)/, 'Videos per run: 1 to 10');
        assert.match(settings, /times\(monteur\.post_at, 'monteur\.post_at', 1, 4\)/, 'Post at: 1 to 4 times');
    });

    it('says so, with the same numbers, in both languages', () => {
        const en = textOf('monteur', 'count', 'en');
        for (const part of ['each started 10 minutes', '(1 to 5)', 'a 5-minute video gives one reel at most', 'an 11-minute one gives two', 'a 33-minute one gives three']) {
            assert.ok(en.includes(part), `en: «${part}»`);
        }
        const ar = textOf('monteur', 'count', 'ar');
        for (const part of ['لكل 10 دقائق', '(من 1 إلى 5)', 'فيديو من 5 دقائق', 'فيديو من 11 دقيقة', 'فيديو من 33 دقيقة']) {
            assert.ok(ar.includes(part), `ar: «${part}»`);
        }
        assert.ok(textOf('monteur', 'folder', 'en').includes('(1 to 10)') && textOf('monteur', 'folder', 'ar').includes('(من 1 إلى 10)'), 'Videos per run');
        assert.ok(textOf('monteur', 'start', 'en').includes('up to 4 posting times a day') && textOf('monteur', 'start', 'ar').includes('أربعة أوقات'), 'Post at');
    });

    it('names the limits of a reel as the code holds them: the title, the captions, the keyword', () => {
        const title = declared('src/services/monteur/transcript.ts', 'MAX_TITLE');
        const caption = declared('src/services/monteur/clips.ts', 'MAX_CAPTION').toLocaleString('en-US');
        const letters = declared('src/services/monteur/copy.ts', 'MIN_KEYWORD_LETTERS');
        const row = (lang: Lang, lead: string): string => (listOf('monteur', 'review', lang, 'dl') as string[][]).find((r) => r[0]!.includes(lead))![1]!;
        assert.ok(row('en', 'Title on the video').includes(`Up to ${title} characters`), `en title: ${title}`);
        assert.ok(row('ar', 'العنوان على الفيديو').includes(`حتى ${title} حرفاً`), `ar title: ${title}`);
        assert.ok(row('en', 'TikTok caption').includes(`Each up to ${caption} characters`), `en captions: ${caption}`);
        assert.ok(row('ar', 'نص تيك توك').includes(`حتى ${caption} حرف`), `ar captions: ${caption}`);
        assert.ok(row('en', 'Comment keyword').includes(`at least ${letters} letters`), `en keyword: ${letters}`);
        assert.ok(row('ar', 'الكلمة المفتاحية للتعليقات').includes(`${letters} أحرف على الأقل`), `ar keyword: ${letters}`);
    });

    it('names the folder as the code holds it: five kinds of file, a minute old, a folder window that expires after 10 minutes', () => {
        assert.deepEqual([...SCAN_EXTENSIONS], ['.mp4', '.mov', '.m4v', '.mkv', '.webm']);
        assert.equal(SCAN_MIN_AGE_S, 60);
        assert.equal(PICK_FOLDER_TTL_MINUTES, 10);
        for (const lang of LANGS) {
            const text = textOf('monteur', 'folder', lang);
            for (const ext of SCAN_EXTENSIONS) assert.ok(text.includes(`\`${ext}\``), `${lang}: ${ext}`);
            assert.ok(lang === 'en' ? text.includes('in the folder for a minute') : text.includes('يمر عليه دقيقة'), `${lang}: a file is taken once it is a minute old`);
            assert.ok(lang === 'en' ? text.includes(`If ${PICK_FOLDER_TTL_MINUTES} minutes pass`) : text.includes(`مرّت ${PICK_FOLDER_TTL_MINUTES} دقائق`), `${lang}: the window expires`);
        }
        // The 5 minutes the dialog waits are the worker's (MONTEUR.md §3), and the page says them in its own words.
        assert.match(readFileSync('MONTEUR.md', 'utf8'), /After 5 minutes it gives up and reports `cancelled`\./);
        assert.match(label('en', 'monteur.folder.timeout'), /within 5 minutes/);
    });

    it('is what Approve does: TikTok has to be ready, YouTube is not looked at, and the comment campaign is switched on in whole-word mode with no public reply', () => {
        const clips = readFileSync('src/services/monteur/clips.ts', 'utf8');
        const approve = clips.slice(clips.indexOf('export async function approveClip'), clips.indexOf('// ─── Reject'));
        assert.ok(approve.length > 1000, 'the function was found');
        assert.match(approve, /if \(platforms\.includes\('tiktok'\)\) \{[\s\S]*?await assertDirectPostReady\(creatorId, flags\)/, 'TikTok is checked at the click');
        assert.doesNotMatch(approve, /getAccessToken|YouTubeNotConnected|getYouTubeConnection|assertYouTube|youtubeConnection/i, 'and YouTube\'s connection is not');
        assert.match(approve, /\[creatorId, campaignPlan\.triggers, campaignPlan\.dm, null, null, true, 'word'\]/, 'the campaign: no public reply, every post, switched on, a whole word');
        assert.match(approve, /'REEL_DAY_TAKEN'/, 'two reels of one video never share a day');
        for (const lang of LANGS) {
            const text = textOf('monteur', 'approve', lang);
            assert.ok(text.includes(lang === 'en' ? 'matches the keyword as a whole word' : 'وتطابق الكلمة كاملة'), `${lang}: whole word`);
            assert.ok(text.includes(lang === 'en' ? 'with no public reply' : 'بدون رد علني'), `${lang}: no public reply`);
            assert.ok(text.includes('[[youtube#disconnected]]'), `${lang}: YouTube failing later, not at the click`);
        }
    });
});

// ─── 7. Infographics ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — infographics', () => {
    const spec = { columns: [{ name: 'RAG' }, { name: 'CAG' }, { name: 'الوكيل' }] };
    const arabicSpec = { columns: [{ name: 'RAG' }, { name: 'CAG' }, { name: 'الأمر' }] };

    it('is what the code does: the caption names every column, case and Arabic letter variants aside, and is neither empty nor over 2,200', () => {
        assert.deepEqual(captionProblems('RAG, CAG and الوكيل compared', spec), []);
        assert.deepEqual(captionProblems('rag cag الوكيل', spec), [], 'Latin case does not matter');
        assert.equal(captionProblems('RAG CAG الوكيل', arabicSpec).length, 1, 'a missing column is named');
        assert.deepEqual(captionProblems('RAG CAG الامر', arabicSpec), [], 'and أ, إ and ا are one letter');
        assert.equal(captionProblems('', spec).length, 1, 'empty');
        assert.equal(captionProblems(`RAG CAG الوكيل ${'x'.repeat(2200)}`, spec).length, 1, 'over 2,200');
    });

    it('says so in both languages, and says the GIF is never scheduled', () => {
        for (const lang of LANGS) {
            const text = textOf('infographics', 'caption', lang);
            assert.ok(text.includes('2,200'), `${lang}: the limit`);
            assert.ok(lang === 'en' ? text.includes('every column') && text.includes('أ, إ and ا') : text.includes('كل عمود') && text.includes('أ وإ وا'), `${lang}: the rule and its two exceptions`);
        }
        const source = readFileSync('src/services/studio/infographics.ts', 'utf8');
        const start = source.indexOf('export async function scheduleInfographic');
        const schedule = source.slice(start, source.indexOf('DELETE /infographics/:id. Its scheduled', start));
        assert.ok(schedule.length > 1000, 'the function was found');
        assert.match(schedule, /const issues = captionIssues\(row\.caption, row\.spec\);\s*const primary = primaryCaptionIssue\(issues\);\s*if \(primary\) throw/, 'Schedule is refused until the caption is right');
        assert.equal((schedule.match(/mediaUrl: row\.render\.mp4_url/g) || []).length, 2, 'Instagram and Facebook, and YouTube, post the MP4');
        assert.doesNotMatch(schedule, /\bgif\b|\bgif_|_gif\b|\.gif\b/i, 'and the GIF is nowhere in it');
        for (const lang of LANGS) {
            const gif = (listOf('infographics', 'what', lang, 'dl') as string[][]).find((r) => r[0] === 'GIF')![1]!;
            assert.ok(lang === 'en' ? gif.includes('never posted for you') : gif.includes('ما يُنشر عنك أبداً'), `${lang}: the GIF is yours to download`);
        }
    });

    it('posts where the code does: Instagram and Facebook as one post, YouTube as its sibling', () => {
        const source = readFileSync('src/services/studio/infographics.ts', 'utf8');
        assert.match(source, /const platforms = settings\.infographic\.platforms;\s*const meta = metaPlatformFor\(platforms\);\s*const youtube = platforms\.includes\('youtube'\);/);
        assert.match(source, /platform: 'youtube', caption, mediaUrl: row\.render\.mp4_url, coverUrl: row\.render\.cover_url/);
    });

    it('is what the code does about who writes it: a workspace with no provider is refused, and the Mac is never tried for it', () => {
        const tenant = readFileSync('src/services/studio/tenantAi.ts', 'utf8');
        assert.match(tenant, /Nothing was sent to the Mac\./, 'the refusal says the Mac was not tried');
        assert.match(tenant, /\*\*Nothing falls back\.\*\*/, 'and the file says it never falls back');
        for (const lang of LANGS) {
            const text = textOf('infographics', 'who', lang);
            assert.ok(lang === 'en' ? text.includes('It never falls back to a Mac.') : text.includes('وما يرجع للماك بدالاً عنه أبداً'), `${lang}: never the Mac instead`);
        }
    });
});

// ─── 8. YouTube ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — YouTube', () => {
    it('is what the code does: every upload is private unless the platform switch is on, and then it asks for public', () => {
        assert.equal(uploadPrivacy({}, false), 'private');
        assert.equal(uploadPrivacy({ privacy: 'public' }, false), 'private', 'a post cannot ask for more than the switch allows');
        assert.equal(uploadPrivacy({}, true), 'public');
        assert.equal(uploadPrivacy({ privacy: 'unlisted' }, true), 'unlisted');
        assert.match(readFileSync('src/services/appSettings.ts', 'utf8'), /\(await getSetting\(APP_SETTING_KEYS\.youtubePublicUploads\)\) === 'true'/, 'and the switch is off until it is set to true');
        for (const lang of LANGS) {
            const text = textOf('youtube', 'public', lang);
            assert.ok(text.includes(label(lang, 'settings.youtube.privacyPrivate')), `${lang}: the card's own words for private`);
            assert.ok(text.includes(label(lang, 'settings.youtube.privacyPublic')), `${lang}: and for public`);
        }
    });

    it('says the daily limit as the code does, and that nothing retries a post that hit it: the message and the article both say to press Publish now', () => {
        const youtube = readFileSync('src/services/youtube.ts', 'utf8');
        // The reason as a failed upload writes it on the post, built by the function that builds it and never retyped here.
        const refused = toYouTubeError('YouTube upload start', { response: { status: 403, data: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } } });
        assert.ok(refused instanceof YouTubeApiError && refused.reason === 'quotaExceeded');
        const message = refused.message.replace(/^YouTube upload start: /, '');
        assert.match(message, /^The YouTube API’s daily quota is used up \(about six uploads a day\)/);
        assert.match(youtube, /10,000 quota units a day, and a thumbnail 50/, '1,600 for the upload, 50 for the thumbnail, 10,000 a day');
        assert.equal((youtube.match(/RETRYABLE_REASONS/g) || []).length, 1, 'RETRYABLE_REASONS is declared and consulted nowhere in this file');
        const consumers = sources().filter((f) => f.replace(/\\/g, '/') !== 'src/services/youtube.ts').filter((f) => /RETRYABLE_REASONS/.test(readFileSync(f, 'utf8')));
        assert.deepEqual(consumers, [], 'nor in any other, so no sweep retries a failed Short: the message may not promise one');
        // So the message tells the owner to do it, with the button's own name, and after the day the quota counts in.
        assert.ok(message.includes(label('en', 'posts.publishNow')) && message.includes('after midnight Pacific time'), message);
        assert.doesNotMatch(message, /retried|retry|retrying/i, 'and promises no retry');
        // …which Publish now can do: it takes a FAILED row (pinned for the whole YouTube card in the test below).
        assert.match(readFileSync('src/routes/api.ts', 'utf8'), /WHERE id = \$1 AND creator_id = \$2 AND status IN \('PENDING', 'FAILED'\)/);
        for (const lang of LANGS) {
            const text = textOf('youtube', 'quota', lang);
            for (const part of ['10,000', '1,600', '50', 'about six uploads a day']) assert.ok(text.includes(part), `${lang}: ${part}`);
            assert.ok(text.includes(bold(label(lang, 'posts.publishNow'))), `${lang}: Publish now is the way to retry`);
            assert.ok(text.includes(message), `${lang}: the article quotes the reason as the code words it`);
            assert.equal((lang === 'en' ? /whatever the message may suggest/i : /حتى لو قالت الرسالة/).test(text), false, `${lang}: and no longer argues with it`);
        }
    });

    for (const lang of LANGS) {
        it(`says what Disconnect YouTube does to a scheduled post, in the dialog and in the article: it fails when it comes due, and Publish now retries it (${lang})`, () => {
            const hint = label(lang, 'settings.youtube.disconnectHint');
            assert.ok(hint.includes(label(lang, 'posts.publishNow')), `the dialog names ${label(lang, 'posts.publishNow')}: ${hint}`);
            assert.equal((lang === 'en' ? /won.t upload until/i : /ما ترفع لين/).test(hint), false, 'and no longer promises the post waits');
            const text = textOf('youtube', 'disconnected', lang);
            assert.ok(text.includes(bold(label(lang, 'posts.publishNow'))), 'the article names it too');
            assert.ok(text.includes(bold(label(lang, 'settings.youtube.disconnect'))) && text.includes(bold(label(lang, 'settings.youtube.statusInvalid'))), 'for both ways the connection goes');
        });
    }

    it('is what the code does: a due post with no usable connection is claimed, fails with the reason written on it, and Publish now takes it again', () => {
        const api = readFileSync('src/routes/api.ts', 'utf8');
        assert.match(api, /WHERE s\.status = 'PENDING' AND s\.scheduled_time <= NOW\(\) AND s\.archived_at IS NULL/, 'the sweep takes every due PENDING row, whatever its connection');
        assert.match(api, /if \(post\.platform === 'youtube'\) \{\s*return publishYouTubePost\(/, 'a YouTube row goes to publishYouTubePost');
        assert.match(api, /WHERE id = \$1 AND creator_id = \$2 AND status IN \('PENDING', 'FAILED'\)/, 'and Publish now takes a PENDING or a FAILED one');
        const publish = readFileSync('src/services/youtubePublish.ts', 'utf8');
        assert.match(publish, /const \{ accessToken, connection \} = await getAccessToken\(post\.creator_id\);/, 'the token is fetched inside the try');
        assert.match(publish, /SET status = 'FAILED', error_log = \$2\s+WHERE id = \$1 AND status IN \('PUBLISHING', 'PENDING'\)/, 'and any error ends in FAILED');
        assert.match(readFileSync('src/services/youtubeConnections.ts', 'utf8'), /constructor\(message = 'YouTube is not connected for this account — connect it in Settings\.'\)/, 'with the sentence the article quotes');
    });

    it('is what the code does when Google refuses the login: the tokens, the channel name and its picture are deleted at once, the channel id stays', () => {
        const connections = readFileSync('src/services/youtubeConnections.ts', 'utf8');
        const start = connections.indexOf('export async function markConnectionInvalid');
        const invalid = connections.slice(start, connections.indexOf('async function writeRefreshed', start));
        assert.match(invalid, /SET status = 'invalid', last_error = \$2, access_token = NULL, access_expires_at = NULL,\s*refresh_token = NULL, refresh_expires_at = NULL, display_name = NULL, avatar_url = NULL,/);
        assert.doesNotMatch(invalid, /external_account_id/, 'and the channel id is not among them');
    });
});

// ─── 9. Joining a workspace ──────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — the setup a new workspace goes through', () => {
    it('is the order and the rules the code holds: About you and Your voice are required, Accounts is there only when the operator switched it on', () => {
        assert.deepEqual(WIZARD_STEPS.map((s) => s.id), ['about', 'voice', 'brand', 'connect', 'proof', 'done']);
        assert.deepEqual(WIZARD_STEPS.filter((s) => s.required).map((s) => s.id), ['about', 'voice']);
        assert.equal(stepsFor(NO_FLAGS).find((s) => s.id === 'connect')!.enabled, false, 'Accounts is off until the platform administrator switches it on');
        assert.equal(stepsFor({ connect: true }).find((s) => s.id === 'connect')!.enabled, true);
        for (const lang of LANGS) {
            const rows = listOf('onboarding', 'steps', lang, 'dl') as string[][];
            assert.equal(rows.length, WIZARD_STEPS.length, `${lang}: one row per step`);
            const required = lang === 'en' ? /^Required\./ : /^إلزامية\./;
            const optional = lang === 'en' ? /^Optional/ : /^اختيارية/;
            rows.forEach((row, i) => {
                const step = WIZARD_STEPS[i]!;
                if (step.id === 'done') return;
                assert.equal(required.test(row[1]!), step.required, `${lang}: ${step.id} ${step.required ? 'is' : 'is not'} required`);
                if (!step.required) assert.ok(optional.test(row[1]!), `${lang}: ${step.id} is optional`);
            });
        }
    });
});

describe('Help Center — the limits of the setup', () => {
    it('are the ones the code holds: 5 rounds of suggestions a day, 3 rounds of samples a day, 3 rewrites of a sample, 10 minutes for the test comment', () => {
        assert.equal(DRAFTS_PER_DAY, 5);
        assert.equal(PROOFS_PER_DAY, 3);
        assert.equal(REGENERATIONS_PER_CARD, 3);
        assert.match(readFileSync('dashboard/js/pages/welcome.js', 'utf8'), /CHECK_GIVE_UP_MS: 10 \* 60 \* 1000,/, 'the page waits 10 minutes for the comment');
        assert.ok(textOf('onboarding', 'draft', 'en').includes(`ask for suggestions ${DRAFTS_PER_DAY} times a day`));
        assert.ok(textOf('onboarding', 'draft', 'ar').includes(`تطلب الاقتراحات ${DRAFTS_PER_DAY} مرات في اليوم`));
        assert.ok(textOf('onboarding', 'samples', 'en').includes(`up to ${REGENERATIONS_PER_CARD} times, and samples can be written ${PROOFS_PER_DAY} times a day`));
        assert.ok(textOf('onboarding', 'samples', 'ar').includes(`حتى ${REGENERATIONS_PER_CARD} مرات، والعيّنات تُكتب ${PROOFS_PER_DAY} مرات في اليوم`));
        assert.ok(textOf('onboarding', 'accounts', 'en').includes('It waits for 10 minutes'));
        assert.ok(textOf('onboarding', 'accounts', 'ar').includes('وتنتظره 10 دقائق'));
    });
});

// ─── 10. The DM assistant ────────────────────────────────────────────────────────────────────────────────────────────

describe('Help Center — the DM assistant', () => {
    const has = (slug: string, id: string, lang: Lang, ...parts: string[]): void => {
        const text = textOf(slug, id, lang);
        for (const part of parts) assert.ok(text.includes(part), `${slug}#${id} (${lang}) says «${part}»`);
    };

    it('is what the code does about who it answers: nothing before a first save, and nothing while it is off, but the test box answers either way', () => {
        assert.deepEqual(decideAgent(null, false), { speak: false, reason: 'unconfigured' });
        assert.deepEqual(decideAgent({ is_active: false } as never, false), { speak: false, reason: 'disabled' });
        assert.equal(decideAgent({ is_active: false } as never, true).speak, true, 'the sandbox speaks while the switch is off');
        assert.equal(decideAgent(null, true).speak, true, 'and before anything was saved');
        const admin = readFileSync('src/routes/admin.ts', 'utf8');
        assert.match(admin, /VALUES \(\$1, false, \$2, ''\)\s*ON CONFLICT \(creator_id\) DO NOTHING/, 'a workspace the platform administrator creates starts with the assistant off');
        assert.equal(HISTORY_WINDOW, 8);
        assert.match(readFileSync('src/services/dmSales/turn.ts', 'utf8'), /export const SALES_HISTORY_WINDOW = 12;/);
        assert.match(readFileSync('src/webhook/messaging.ts', 'utf8'), /const DISCLOSURE_MAX_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1000;/, 'the automated-reply line returns after 7 days');
        for (const lang of LANGS) has('dm-assistant', 'what', lang, lang === 'en' ? 'last 8 messages' : 'آخر 8 رسائل', lang === 'en' ? '12 for sales replies' : 'و12 في ردود المبيعات', lang === 'en' ? 'more than 7 days old' : 'أكثر من 7 أيام');
    });

    it('is what the code does about Sales replies: off for everybody to start, a test list of at most 20 ids of 5 to 32 digits', () => {
        assert.equal(DEFAULT_SALES_MODE, 'off');
        assert.deepEqual([...SALES_MODES], ['off', 'test', 'on']);
        assert.equal(MAX_TEST_SENDERS, 20);
        assert.ok(SENDER_ID.test('1'.repeat(5)) && SENDER_ID.test('1'.repeat(32)) && !SENDER_ID.test('1'.repeat(4)) && !SENDER_ID.test('1'.repeat(33)) && !SENDER_ID.test('12a45'));
        for (const lang of LANGS) {
            const labels = ['ai.salesOff', 'ai.salesTest', 'ai.salesOn'].map((key) => bold(label(lang, key)));
            // Spread into this realm's array: the article's own lists come from the page's `vm` context, and a deep equal compares prototypes.
            const rows = [...(listOf('dm-assistant', 'sales', lang, 'dl', 0) as string[][]).map((r) => r[0])];
            assert.deepEqual(rows, labels, `${lang}: the three states, in the screen's own words and order`);
            has('dm-assistant', 'sales', lang, lang === 'en' ? '(5 to 32 digits)' : '(من 5 إلى 32 رقماً)', lang === 'en' ? 'up to 20' : 'وحتى 20');
        }
    });

    it('is what the code does about the guard and the hand-over: two questions, 15 replies an hour, a second insult stops it', () => {
        assert.equal(MAX_QUALIFIER_TURNS, 2);
        assert.equal(MAX_AI_REPLIES_PER_HOUR, 15);
        assert.equal(MAX_ABUSE_STRIKES, 2);
        for (const lang of LANGS) {
            has('dm-assistant', 'sales', lang, lang === 'en' ? 'up to two questions' : 'حتى سؤالين', lang === 'en' ? '15 replies' : '15 رداً', lang === 'en' ? 'a second one stops the assistant' : 'والثانية توقف المساعد');
        }
        const price = readFileSync('src/services/dmSales/price.ts', 'utf8');
        assert.match(price, /if \(!isCalendarDate\(until\) \|\| todayIn\(now, timezone\) > until\) return null;/, 'a price is said only until its date has passed');
        assert.match(readFileSync('src/services/dmSales/link.ts', 'utf8'), /return `\$\{base\}\/r\/\$\{code\}`;/, 'the link is a tracked /r/ link');
        for (const lang of LANGS) assert.ok(textOf('dm-assistant', 'sales', lang).includes(bold(label(lang, 'tenantProfile.sales.f.price_valid_until'))), `${lang}: the price's date field, by its own name`);
    });

    it('is what the code does after a reply that could not be written: the customer gets one line, the conversation shows Needs you, and the assistant stays on', () => {
        const failure = readFileSync('src/services/dmSales/failureHandoff.ts', 'utf8');
        const start = failure.indexOf('async function stamp');
        const stamp = failure.slice(start, failure.indexOf('async function recordLine', start));
        assert.match(stamp, /SET stage = 'handoff', handoff_at = NOW\(\), handoff_reason = \$3/);
        assert.doesNotMatch(stamp, /is_bot_active/, 'it never pauses the bot');
        assert.match(readFileSync('src/webhook/messaging.ts', 'utf8'), /if \(dmReply\.kind === 'handoff'\) \{\s*await handOver\(\);/, 'the engine failing, with the fallback off, ends the same way');
        for (const lang of LANGS) {
            const text = textOf('dm-assistant', 'engine', lang);
            assert.ok(text.includes(bold(label(lang, 'inbox.filter.needs_you'))), `${lang}: the Inbox label`);
            assert.ok(text.includes(bold(label(lang, 'ai.fallbackTitle'))) && text.includes(bold(label(lang, 'ai.engineProviders'))), `${lang}: the two switches, as the page names them`);
        }
    });

    it('is what the code does about the follow-up: one, after 240 minutes unless set, from 0 to 1,320, inside 23 hours', () => {
        assert.equal(FOLLOWUP_MINUTES_DEFAULT, 240);
        assert.equal(FOLLOWUP_MINUTES_MIN, 0);
        assert.equal(FOLLOWUP_MINUTES_MAX, 1320);
        assert.equal(MAX_FOLLOWUPS_PER_CONVERSATION, 1);
        assert.equal(FOLLOWUP_WINDOW_MS, 23 * 60 * 60 * 1000);
        for (const lang of LANGS) {
            has('dm-assistant', 'followup', lang, lang === 'en' ? '4 hours later (the default)' : 'بعد 4 ساعات (الافتراضي)', lang === 'en' ? 'from 0 to 1,320 minutes' : 'من 0 إلى 1320 دقيقة', lang === 'en' ? '240 by default' : 'والافتراضي 240', lang === 'en' ? 'after 23 hours' : 'بعد مرور 23 ساعة', lang === 'en' ? 'only one is ever sent per conversation' : 'ما يُرسل إلا واحدة لكل محادثة');
            assert.ok(textOf('dm-assistant', 'followup', lang).includes(bold(label(lang, 'ai.salesFollowup'))), `${lang}: the field's own name`);
        }
    });

    it('is what the code does about the wording experiment: two or three variants, a name of 40, guidance of 300, a share of 0 to 100, percentages from 30 conversations', () => {
        assert.deepEqual([MIN_VARIANTS, MAX_VARIANTS, VARIANT_LABEL_MAX, VARIANT_TEXT_MAX, VARIANT_WEIGHT_MAX, MIN_VARIANT_SAMPLE], [2, 3, 40, 300, 100, 30]);
        for (const lang of LANGS) {
            const rows = listOf('dm-assistant', 'variants', lang, 'dl') as string[][];
            const desc = (key: string): string => rows.find((r) => r[0] === bold(label(lang, key)))![1]!;
            assert.ok(desc('ai.variantName').includes(lang === 'en' ? '40 characters' : '40 حرفاً'), `${lang}: name`);
            assert.ok(desc('ai.variantShare').includes(lang === 'en' ? 'from 0 to 100' : 'من 0 إلى 100'), `${lang}: share`);
            assert.ok(desc('ai.variantOpening').includes(lang === 'en' ? '300 characters' : '300 حرف'), `${lang}: opening`);
            assert.ok(desc('ai.variantCta').includes(lang === 'en' ? '300 characters' : '300 حرف'), `${lang}: offer`);
            has('dm-assistant', 'variants', lang, lang === 'en' ? 'until a variant has 30 conversations' : 'قبل ما تصل الصيغة إلى 30 محادثة', lang === 'en' ? 'at least two variants' : 'صيغتان على الأقل');
        }
    });

    it('is what the code does about ice breakers: 4 questions of 80 characters, a menu of 5 items of 30, seven answers to "what it asks", the owner only', () => {
        assert.deepEqual([ICE_BREAKER_MAX, ICE_BREAKER_QUESTION_MAX, MENU_ITEMS_MAX, MENU_TITLE_MAX], [4, 80, 5, 30]);
        const route = readFileSync('src/routes/iceBreakers.ts', 'utf8');
        assert.match(route, /const canAdminister = requireTenantRole\('owner'\);/, 'every route is the owner\'s');
        assert.match(readFileSync('dashboard/js/pages/settings.js', 'utf8'), /id: 'iceb', group: 'messages', who: 'owner'/, 'and the card is the owner\'s, under Messages & alerts');
        for (const lang of LANGS) {
            const steps = listOf('dm-assistant', 'ice-breakers', lang, 'ol') as string[];
            const asks = TAP_CODES.map((code) => bold(label(lang, `iceb.tap.${code}`)));
            const at = (s: string): number => steps[1]!.indexOf(s);
            assert.ok(asks.every((s) => at(s) > -1), `${lang}: every answer, by the screen's name`);
            assert.deepEqual([...asks].sort((a, b) => at(a) - at(b)), asks, `${lang}: in the screen's order`);
            assert.ok(steps[0]!.includes(lang === 'en' ? `up to ${ICE_BREAKER_MAX} questions, each at most ${ICE_BREAKER_QUESTION_MAX} characters` : `حتى ${ICE_BREAKER_MAX} أسئلة، وطول كل سؤال ${ICE_BREAKER_QUESTION_MAX} حرفاً`), `${lang}: questions`);
            assert.ok(steps[2]!.includes(lang === 'en' ? `up to ${MENU_ITEMS_MAX} items, each title at most ${MENU_TITLE_MAX} characters` : `حتى ${MENU_ITEMS_MAX} عناصر، وعنوان كل عنصر ${MENU_TITLE_MAX} حرفاً`), `${lang}: menu`);
            assert.ok(textOf('dm-assistant', 'ice-breakers', lang).includes(bold(label(lang, 'settings.group.messages'))), `${lang}: where to find it`);
        }
    });
});

// ─── 11. Which AI the product uses ───────────────────────────────────────────────────────────────────────────────────

describe('Help Center — which AI the product uses', () => {
    for (const lang of LANGS) {
        it(`no longer says all of it is Gemini, and points at where the other choices are (${lang})`, () => {
            const text = textOf('ai-usage', 'where', lang);
            assert.equal((lang === 'en' ? /All the AI in the product is/ : /كل الذكاء الاصطناعي في المنتج من/).test(text), false);
            for (const link of ['[[dm-assistant#engine]]', '[[monteur#settings]]', '[[infographics#who]]']) assert.ok(text.includes(link), `${lang}: ${link}`);
        });
    }
});
