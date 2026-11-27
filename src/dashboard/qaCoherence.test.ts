/**
 * The live QA sweep of 2026-11-28 (docs/research/2026-11-28-qa/findings.md): screens that disagreed with each other or said less than they knew.
 *
 *   QA-02  Today counts a conversation's wait from the customer's LAST message and leads with the reply window, like the Inbox chip;
 *   QA-04  a failed post dated ahead says its year, and "replaced on purpose" says there is nothing to fix;
 *   QA-07  a remote avatar (TikTok, YouTube) whose signed link expired falls back to initials;
 *   QA-09  every date, number and age is drawn in Latin digits, whatever the language;
 *   (5)    short durations pass `count`, so Arabic reads «منذ ساعة», «منذ ساعتين», «منذ 48 يومًا»;
 *   QA-15  the tab names the route at once, not after the page's data has loaded.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const ok = (value: unknown) => ({ status: 'fulfilled', value });
const ARABIC_INDIC = /[٠-٩۰-۹]/;

// ═══ QA-02, QA-04: Today ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

for (const lang of ['en', 'ar'] as const) {
    describe(`Today (${lang}): the waiting card measures from the last message and leads with the reply window (QA-02)`, () => {
        const h = loadDashboard({ lang, files: ['dashboard/js/pages/overview.js'] });
        const O = h.run<Json>('OverviewPage');
        const thread = (type: string, count: number, window: Json | null, over: Json = {}): Json => ({
            type, severity: 'warning', count, sentence: { key: `attention.${type}`, params: { n: count } },
            action: { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' }, oldestAt: ago(16 * DAY),
            ...(window ? { detail: { window } } : {}), ...over,
        });
        const summary = (items: Json[], inbox: number): Json => ({ status: 'fulfilled', value: { items, counts: { inbox, studio: 0, scheduler: 0 }, heartbeat: null } });
        const card = (res: Json): Json => plain(O.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), undefined, undefined, res)).find((a: Json) => a.icon === 'message-square-dot');
        const hours = (n: number): string => h.t('overview.age.hours', { count: n });
        const open = (lastHoursAgo: number, leftHours: number): Json => ({ lastInboundAt: ago(lastHoursAgo * HOUR), open: 1, closesAt: new Date(Date.now() + leftHours * HOUR + 60_000).toISOString() });

        it('a thread handed over 16 days ago whose customer wrote 22 h ago: "last message 22 hours ago · 2 hours left to reply", never "16 days"', () => {
            const body = card(summary([thread('handoff', 1, open(22, 2))], 1)).body as string;
            assert.equal(body, h.t('overview.alert.waitingWindow', { count: 1, ago: hours(22), left: hours(2) }));
            assert.equal(body.includes(h.t('overview.age.days', { count: 16 })), false, body);
            assert.equal(/16/.test(body), false, body);
            if (lang === 'en') assert.equal(body, 'Last message 22 hours ago · 2 hours left to reply');
            else assert.equal(body, 'آخر رسالة منذ 22 ساعة · المتبقي للردّ: ساعتين');
        });

        it('says the window has closed when it has, and still offers Mark handled for the closed thread', () => {
            const closed = { lastInboundAt: ago(3 * DAY), open: 0, closesAt: null };
            const res = summary([thread('handoff', 1, closed, { detail: { window: closed, closed: { count: 1, ids: ['0b0a6a80-1111-4222-8333-444455556666'], oldestAt: ago(3 * DAY) } } })], 1);
            const alert = card(res);
            assert.equal(alert.body, h.t('overview.alert.waitingWindowClosed', { count: 1, ago: h.t('overview.age.days', { count: 3 }) }));
            assert.equal(alert.clear.kind, 'handled', 'Mark handled, as the card already offered');
            if (lang === 'ar') assert.equal(alert.body, 'آخر رسالة منذ 3 أيام · انتهت مهلة الردّ');
        });

        it('across a handoff and a waiting thread: the newest message, the soonest window to close, in the dual form for two', () => {
            const res = summary([thread('handoff', 1, open(22, 2)), thread('thread_waiting', 1, open(5, 19), { oldestAt: ago(2 * DAY) })], 2);
            const body = card(res).body as string;
            assert.equal(body, h.t('overview.alert.waitingWindow', { count: 2, ago: hours(5), left: hours(2) }));
            if (lang === 'ar') assert.equal(body, 'آخر رسالة منذ 5 ساعات · أقرب مهلة ردّ تنتهي بعد ساعتين');
            else assert.equal(body, 'Last message 5 hours ago · the first reply window closes in 2 hours');
        });

        it('counts the minutes under an hour and says "under a minute" under one', () => {
            const soon = (minutes: number): Json => ({ lastInboundAt: ago(23 * HOUR), open: 1, closesAt: new Date(Date.now() + minutes * 60_000 + 5_000).toISOString() });
            assert.equal(card(summary([thread('handoff', 1, soon(40))], 1)).body, h.t('overview.alert.waitingWindow', { count: 1, ago: hours(23), left: h.t('overview.age.minutes', { count: 40 }) }));
            assert.equal(card(summary([thread('handoff', 1, { lastInboundAt: ago(23 * HOUR), open: 1, closesAt: new Date(Date.now() + 20_000).toISOString() })], 1)).body,
                h.t('overview.alert.waitingWindow', { count: 1, ago: hours(23), left: h.t('overview.window.lt1') }));
        });

        it('an answer from before the window existed keeps the old wording, and one item without it does not mix the two', () => {
            assert.equal(card(summary([thread('handoff', 1, null)], 1)).body, h.t('overview.alert.waitingOldest', { age: h.t('overview.age.days', { count: 16 }), count: 1 }));
            const mixed = card(summary([thread('handoff', 1, open(22, 2)), thread('thread_waiting', 1, null)], 2)).body;
            assert.equal(mixed, h.t('overview.alert.waitingOldest', { age: h.t('overview.age.days', { count: 16 }), count: 2 }));
        });

        it('the tile under "waiting" says the last message too, from the same fact', () => {
            const res = summary([thread('handoff', 1, open(22, 2))], 1);
            assert.ok(String(O.renderStats({ activeCampaigns: 1 }, ok([]), res)).includes(h.t('overview.stat.waitingLast', { age: hours(22) })));
        });
    });

    describe(`Today (${lang}): a failed post's reason line (QA-04)`, () => {
        const h = loadDashboard({ lang, files: ['dashboard/js/pages/overview.js'] });
        const O = h.run<Json>('OverviewPage');

        it('a post dated in another year says the year; this year does not need it, and the digits are Latin', () => {
            const next = O.datedWords('2099-01-01T12:00:00Z') as string;
            assert.match(next, /2099/);
            const thisYear = new Date(new Date().getFullYear(), 0, 2, 12).toISOString();
            assert.equal(String(O.datedWords(thisYear)).includes(String(new Date().getFullYear())), false);
            assert.equal(ARABIC_INDIC.test(next), false, next);
            const line = O.failureAge(new Date(Date.now() + 400 * DAY).toISOString()) as string;
            assert.ok(line.includes(String(new Date(Date.now() + 400 * DAY).getFullYear())), line);
        });

        it('"replaced on purpose" reads as nothing to fix: archive it', () => {
            const one = h.t('overview.failed.reason.replaced', { count: 1 });
            const many = h.t('overview.failed.reason.replaced', { count: 4 });
            const pattern = lang === 'en' ? /nothing to fix, archive it/ : /لا شيء لإصلاحه، أرشِفه/;
            assert.match(one, pattern);
            assert.match(many, lang === 'en' ? /nothing to fix, archive them/ : /لا شيء لإصلاحها، أرشِفها/);
        });
    });
}

// ═══ QA-07: remote avatars ═════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('a remote avatar falls back to initials when its signed link has expired (QA-07)', () => {
    const h = loadDashboard();
    const img = (attrs: string[], classes: string[] = []): Json => {
        const el = h.document.createElement('img');
        el.tagName = 'IMG';
        attrs.forEach((a: string) => el.setAttribute(a, ''));
        classes.forEach((c) => el.classes.add(c));
        return el;
    };

    it('draws the initials under the picture, which is marked for the fallback', () => {
        const markup = String(h.UI.remoteAvatar({ src: 'https://p16.tiktokcdn.com/a.jpg', name: 'Amir Mansour', icon: 'music-2', size: 'lg' }));
        assert.match(markup, /class="avatar avatar--lg"/);
        assert.match(markup, /class="avatar-initials"><bdi dir="auto">AM</);
        assert.match(markup, /<img class="avatar-img" data-avatar-fallback src="https:\/\/p16\.tiktokcdn\.com\/a\.jpg"/);
        assert.match(markup, /referrerpolicy="no-referrer"/);
    });

    it('with no picture, or a name with no letter, it still draws something: initials, or the platform glyph', () => {
        assert.equal(/<img/.test(String(h.UI.remoteAvatar({ src: '', name: 'Amir' }))), false);
        assert.match(String(h.UI.remoteAvatar({ src: '', name: '🎵', icon: 'music-2' })), /data-lucide="music-2"/);
    });

    it('a failed load removes the picture and leaves the initials; any other image is left alone', () => {
        const broken = img(['data-avatar-fallback']);
        const parent = h.document.createElement('span');
        parent.appendChild(broken);
        h.UI.handleAvatarError({ target: broken });
        assert.equal(parent.children.length, 0, 'removed');
        const other = img([], ['msg-attachment-img']);
        const holder = h.document.createElement('span');
        holder.appendChild(other);
        h.UI.handleAvatarError({ target: other });
        assert.equal(holder.children.length, 1, 'not ours');
    });

    it('is one capturing listener on the document (error events do not bubble, and the dashboard has no inline handlers)', () => {
        h.UI.watchAvatarFallbacks();
        h.UI.watchAvatarFallbacks();
        const registered = (h.listeners.document.get('error') ?? []).filter((l) => l.capture);
        assert.equal(registered.length, 1, 'once, however often it is asked for');
    });

    it('the TikTok and YouTube cards draw their avatar through it, and the shell starts the listener', () => {
        const settings = readFileSync('dashboard/js/pages/settings.js', 'utf8');
        assert.match(settings, /UI\.remoteAvatar\(\{ src: avatar, name: c\.displayName/);
        assert.match(settings, /UI\.remoteAvatar\(\{ src: thumb, name: c\.channelTitle/);
        assert.equal(/<img class="tiktok-avatar-lg"/.test(settings), false, 'no bare remote <img> left in Settings');
        assert.match(readFileSync('dashboard/js/app.js', 'utf8'), /UI\.watchAvatarFallbacks\(\)/);
    });
});

// ═══ QA-09: Latin digits ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('every number, date and age is in Latin digits, in Arabic too (QA-09)', () => {
    const h = loadDashboard({ lang: 'ar' });

    it('the Arabic locale asks for Latin numerals and the Gregorian calendar', () => {
        assert.match(h.I18N.LANGS.ar.locale, /-u-nu-latn/);
        assert.match(h.I18N.LANGS.ar.locale, /ca-gregory/);
    });

    it('formats of every kind draw no Arabic-Indic digit', () => {
        const iso = '2027-01-01T12:34:00Z';
        const drawn = [
            h.UI.formatNumber(2027), h.UI.formatNumber(1234567.5), h.UI.formatDay(iso), h.UI.formatDayShort(iso), h.UI.formatTime(iso), h.UI.formatDate(iso),
            h.UI.formatDateTime(iso), h.UI.formatWeekday(iso), h.UI.zoneTime(iso, { zone: 'Africa/Cairo' }),
            h.UI.relativeAge(ago(5 * HOUR)).text, h.UI.relativeAge(ago(48 * DAY)).text, h.UI._elapsed(ago(3 * HOUR)),
        ].map(String);
        for (const text of drawn) assert.equal(ARABIC_INDIC.test(text), false, text);
        assert.ok(drawn[2]!.includes('2027'), drawn[2]);
    });

    it('no dashboard script builds a formatter on a bare locale: each uses I18N.locale() or an English one', () => {
        const dir = 'dashboard/js';
        const files = [...readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`), ...readdirSync(`${dir}/pages`).filter((f) => f.endsWith('.js')).map((f) => `${dir}/pages/${f}`)]
            .filter((f) => !/help-content|i18n\.(ar|en)\.js/.test(f));
        const bad: string[] = [];
        for (const file of files) {
            readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
                // `toLocaleString()` / `toLocaleDateString()` with no locale take the browser's, which is Arabic-Indic for an Arabic browser.
                if (/\.toLocale(Date|Time)?String\(\s*\)/.test(line)) bad.push(`${file}:${i + 1} no locale`);
                const m = /(?:Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat)|\.toLocale(?:Date|Time)?String)\(\s*(['"`])([^'"`]*)\1/.exec(line);
                if (m && /^ar(-|$)/.test(m[2]!) && !/-u-nu-latn/.test(m[2]!)) bad.push(`${file}:${i + 1} ${m[2]}`);
            });
        }
        assert.deepEqual(bad, []);
    });
});

// ═══ Durations ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('short durations pass `count`, so Arabic picks the plural (the common.* forms)', () => {
    const ar = loadDashboard({ lang: 'ar' });
    const en = loadDashboard({ lang: 'en' });
    const at = (ms: number): string => ago(ms + 5_000);

    it('relativeAge in Arabic: one hour «منذ ساعة», two «منذ ساعتين», 3 «منذ 3 ساعات», 48 days «منذ 48 يومًا»', () => {
        const word = (ms: number): string => ar.UI.relativeAge(at(ms)).text;
        assert.equal(word(HOUR), 'منذ ساعة');
        assert.equal(word(2 * HOUR), 'منذ ساعتين');
        assert.equal(word(3 * HOUR), 'منذ 3 ساعات');
        assert.equal(word(11 * HOUR), 'منذ 11 ساعة');
        assert.equal(word(60_000), 'منذ دقيقة');
        assert.equal(word(2 * 60_000), 'منذ دقيقتين');
        assert.equal(word(48 * DAY), 'منذ 48 يومًا');
        assert.equal(word(DAY), 'منذ يوم');
        assert.equal(word(2 * DAY), 'منذ يومين');
    });

    it('the bare duration of the Mac chip uses the same forms: «الماك نائم منذ ساعتين»', () => {
        assert.equal(ar.UI._elapsed(at(2 * HOUR)), 'ساعتين');
        assert.equal(ar.UI._elapsed(at(5 * DAY)), '5 أيام');
    });

    it('English has no plural keys for these and keeps its short form', () => {
        assert.equal(en.UI.relativeAge(at(3 * HOUR)).text, '3h ago');
        assert.equal(en.UI.relativeAge(at(HOUR)).text, '1h ago');
        assert.equal(en.UI._elapsed(at(48 * DAY)), '48d');
    });

    it('a future time and "just now" still read as before', () => {
        assert.equal(ar.UI.relativeAge(new Date(Date.now() + 3 * HOUR + 5_000).toISOString()).text, 'بعد 3 ساعات');
        assert.equal(ar.UI.relativeAge(ago(5_000)).text, 'الآن');
    });
});

// ═══ QA-15: the tab title ══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('the tab names the route at once (QA-15)', () => {
    const stubbed = (lang: 'en' | 'ar', hash: string) => {
        const h = loadDashboard({ app: true, lang, hash });
        for (const id of ['page-title', 'page-subtitle', 'page-container', 'sidebar', 'mobile-menu-btn']) h.el(id);
        return h;
    };

    it('navigate() sets the title before the page module has loaded', async () => {
        const h = stubbed('en', '#/inbox');
        h.App.pages.inbox = { src: 'inbox', page: () => ({ render: () => {}, destroy: () => {} }) };
        h.App.loadPageModule = () => new Promise(() => { /* the network never answers */ });
        h.document.title = 'old title';
        void h.App.navigate('inbox');
        await settle();
        assert.equal(h.document.title, `${h.t('nav.inbox')} · ${h.t('app.name')}`, 'named while the module is still loading');
    });

    it('does not rename the tab when the person is asked about leaving and stays', () => {
        const source = readFileSync('dashboard/js/app.js', 'utf8');
        const confirmAt = source.indexOf('const leave = await this.confirmLeave(kind)');
        const earlyAt = source.indexOf("this.setBaseTitle(`${this.title(page)} · ${t('app.name')}`);\n\n        const instance = await loading;");
        assert.ok(confirmAt > 0 && earlyAt > confirmAt, 'the early title comes after the leave question');
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`a reload on #/posts with a session starts on that page's title in ${lang}, not the landing page's`, () => {
            const h = stubbed(lang, '#/posts');
            assert.equal(h.App.routeTitle(), `${h.t('nav.posts')} · ${h.t('app.name')}`);
            assert.notEqual(h.App.routeTitle(), h.App.appTitle());
        });
    }

    it('without a session, on an invite link or an unknown page it is the app\'s own title or the default page\'s', () => {
        const h = stubbed('en', '#/posts');
        h.ctx.API = { token: null };
        assert.equal(h.App.routeTitle(), h.App.appTitle());
        const g = stubbed('en', '#/not-a-page');
        assert.equal(g.App.routeTitle(), `${g.t(`nav.${g.App.DEFAULT_PAGE}`)} · ${g.t('app.name')}`);
    });

    it('init() uses it for the first title', () => {
        assert.match(readFileSync('dashboard/js/app.js', 'utf8'), /this\.renderLanguageToggle\(\);[\s\S]{0,400}this\.setBaseTitle\(this\.routeTitle\(\)\)/);
    });
});
