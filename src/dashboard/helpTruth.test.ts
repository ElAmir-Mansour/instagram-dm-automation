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
import { REQUIRED_ALERT_KINDS, SHOWN_ALERT_KINDS } from '../services/ads/settings.js';

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
        assert.deepEqual([...notRaised], ['ad_rejected', 'ad_issues'], 'the kinds no source file raises (a kind raised now is one more row to re-read, and one less "not sent yet")');

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
