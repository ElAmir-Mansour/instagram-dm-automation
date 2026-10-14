/**
 * Tracked links (S7): the code, the target rule, the visitor classes, and the three statements.
 *
 * The statements run against a stand-in for the database that answers each by reading its behaviour OUT OF the SQL it is given: the stand-in
 * applies the ON CONFLICT arbiter only if the statement names it, so removing the clause from `CREATE_LINK_SQL` gives two codes for one
 * (conversation, offer) here, and removing `WHERE code = $1` from the resolver returns the wrong link.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import {
    classifyClick, CREATE_LINK_SQL, createTrackedLink, generateLinkCode, InvalidTargetUrlError, isLinkCode, LINK_CLICK_UA_CLASSES, LINK_CODE_LENGTH,
    LINK_CODE_PATTERN, recordClick, RECORD_CLICK_SQL, resolve, RESOLVE_LINK_SQL, toWireUrl, type RandomSource,
} from './links.js';

const REFERRAL = 'https://shop.example/p/handbook?ref=AB12CD34EF56GH78';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const OTHER_CONVERSATION = '33333333-3333-4333-8333-333333333333';

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const exact = (sql: string): RegExp => new RegExp(`^${flat(sql).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

// ─── Codes ───────────────────────────────────────────────────────────────────────────────────

describe('generateLinkCode', () => {
    it('is 10 characters of base62 by default, and matches the pattern the route and the database accept', () => {
        for (let i = 0; i < 200; i++) {
            const code = generateLinkCode();
            assert.equal(code.length, LINK_CODE_LENGTH);
            assert.equal(LINK_CODE_LENGTH, 10, 'the plan\'s length');
            assert.match(code, /^[0-9A-Za-z]{10}$/);
            assert.ok(isLinkCode(code));
        }
    });

    it('is not guessable by walking: 5,000 codes, no repeat, and they do not share a prefix or a counter', () => {
        const codes = new Set<string>();
        for (let i = 0; i < 5000; i++) codes.add(generateLinkCode());
        assert.equal(codes.size, 5000);
        const first = new Set([...codes].map((c) => c[0]));
        assert.ok(first.size > 40, `the first character takes ${first.size} of 62 values`);
        // A sequential or time-derived code would be nearly sorted. Random ones are sorted about as often as a coin lands heads.
        const list = [...codes];
        let ascending = 0;
        for (let i = 1; i < list.length; i++) if (list[i]! > list[i - 1]!) ascending++;
        assert.ok(ascending > 2000 && ascending < 3000, `${ascending} of 4999 steps went up`);
    });

    it('uses every one of the 62 characters, evenly enough that none is missing or twice as common', () => {
        const seen = new Map<string, number>();
        for (let i = 0; i < 3000; i++) for (const ch of generateLinkCode()) seen.set(ch, (seen.get(ch) ?? 0) + 1);
        assert.equal(seen.size, 62);
        const counts = [...seen.values()];
        const mean = (3000 * 10) / 62;
        assert.ok(Math.min(...counts) > mean * 0.8 && Math.max(...counts) < mean * 1.2, `${Math.min(...counts)}..${Math.max(...counts)} around ${Math.round(mean)}`);
    });

    it('discards bytes 248..255 instead of wrapping them: without that the first 8 characters would be likelier', () => {
        // 256 % 62 = 8, so a plain `byte % 62` makes the characters at indexes 0-7 come up 5 times in 256 and the rest 4. Rejection removes it.
        const script = [255, 254, 253, 252, 251, 250, 249, 248, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
        let asked = 0;
        const source: RandomSource = (size) => { asked = size; return Uint8Array.from(script); };
        assert.equal(generateLinkCode(10, source), '0123456789', 'the eight biased bytes were skipped, and the next ten used');
        assert.equal(asked, 20);
        // 247 is the last byte kept: 247 % 62 = 61, the last character.
        assert.equal(generateLinkCode(10, () => Uint8Array.from([247, 247, 247, 247, 247, 247, 247, 247, 247, 247])), 'z'.repeat(10));
    });

    it('asks for more entropy when a draw is mostly rejected, and still returns the full length', () => {
        let draws = 0;
        const stingy: RandomSource = () => { draws++; return Uint8Array.from(draws < 3 ? new Array(20).fill(255) : new Array(20).fill(1)); };
        assert.equal(generateLinkCode(10, stingy), '1'.repeat(10));
        assert.equal(draws, 3);
    });

    it('is never shorter than 10 characters, however it is asked', () => {
        assert.throws(() => generateLinkCode(9), RangeError);
        assert.throws(() => generateLinkCode(0), RangeError);
        assert.throws(() => generateLinkCode(10.5), RangeError);
        assert.equal(generateLinkCode(16).length, 16);
    });

    it('draws from the system CSPRNG: Math.random is not in the module', () => {
        const source = readFileSync('src/services/links.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        assert.match(source, /from 'node:crypto'/);
        assert.doesNotMatch(source, /Math\.random/);
    });
});

describe('isLinkCode', () => {
    it('accepts base62 of 10 to 32 characters and nothing else', () => {
        for (const ok of ['a'.repeat(10), 'A1b2C3d4E5', 'Z'.repeat(32)]) assert.equal(isLinkCode(ok), true, ok);
        for (const bad of ['', 'short', 'a'.repeat(9), 'a'.repeat(33), 'abcdefghi-', 'abcdefghi_', 'abcdefghij ', ' abcdefghij', 'abcdefghij\n', 'abcdefgh%20', 'عربيعربيعربي', '../abcdefghij']) {
            assert.equal(isLinkCode(bad), false, JSON.stringify(bad));
        }
        for (const notString of [undefined, null, 1234567890, ['abcdefghij'], {}]) assert.equal(isLinkCode(notString), false);
        assert.ok(LINK_CODE_PATTERN.test('abcdefghij'));
    });
});

// ─── Targets ─────────────────────────────────────────────────────────────────────────────────

describe('toWireUrl', () => {
    it('returns an ASCII address exactly as given: a product link with a referral code is the same link', () => {
        assert.equal(toWireUrl(REFERRAL), REFERRAL);
        for (const same of [
            'http://example.com',
            'HTTPS://Example.COM/Path?B=2&a=1&B=3#Frag',
            'https://example.com/a%20b/%E2%9C%93?q=%7Bx%7D&plus=a+b',
            'https://example.com/?',
            'https://example.com/#',
            'https://example.com:8443/x;y=z?x=1&amp;y=2',
            'https://user:pass@example.com/',
            'https://example.com/?next=https://other.example/',
        ]) assert.equal(toWireUrl(same), same);
    });

    it('percent-encodes only what a header cannot carry, as UTF-8, and leaves every other byte alone', () => {
        assert.equal(toWireUrl('https://example.com/منتج?x=1'), 'https://example.com/%D9%85%D9%86%D8%AA%D8%AC?x=1');
        assert.equal(toWireUrl('https://example.com/aé'), 'https://example.com/a%C3%A9');
        assert.equal(toWireUrl('https://example.com/\u{1F680}'), 'https://example.com/%F0%9F%9A%80');
        assert.equal(toWireUrl('https://example.com/a\u0001b'), 'https://example.com/a%01b');
        // Already-encoded bytes are not encoded twice.
        assert.equal(toWireUrl('https://example.com/%D9%83'), 'https://example.com/%D9%83');
    });

    it('refuses anything that is not an http(s) address with a host, naming why', () => {
        for (const bad of [
            '', 'example.com', '//example.com', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd',
            'https://', 'https:// example.com', ' https://example.com', 'https://example.com ', 'https://exa mple.com', 'https://example.com/\n',
            'https://example.com/\r\nSet-Cookie: a=b', 'https://example.com/ ', 'https://example.com/\ud800',
            `https://example.com/${'a'.repeat(2100)}`,
        ]) assert.throws(() => toWireUrl(bad), InvalidTargetUrlError, JSON.stringify(bad.slice(0, 40)));
        for (const notString of [undefined, null, 42, {}, ['https://example.com']]) assert.throws(() => toWireUrl(notString), InvalidTargetUrlError);
    });

    it('agrees with the database CHECK on what a stored target may be, so a value that passes here is never refused there', () => {
        const sql = readFileSync('src/config/migration_v38_tracked_links.sql', 'utf8').replace(/--[^\n]*/g, '');
        assert.match(sql, /CHECK \(target_url ~\* '\^https\?:\/\/\[!-~\]\+\$'\)/);
        const wire = /^https?:\/\/[!-~]+$/i;
        for (const target of [REFERRAL, 'HTTP://A.B', 'https://example.com/منتج', 'https://example.com/\u{1F680}', 'https://example.com/a\u0001b']) {
            assert.match(toWireUrl(target), wire, target);
        }
    });
});

// ─── The visitor classes ─────────────────────────────────────────────────────────────────────

const UA = {
    safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    instagramIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 Instagram 345.0.1.14.99 (iPhone14,5; iOS 17_5_1; en_US; en; scale=3.00; 1170x2532; 633215957)',
    instagramAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 345.0.0.34.101 Android (33/13; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; ar_SA; 633215957)',
    facebookIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F90 [FBAN/FBIOS;FBAV/460.0.0.55.109;FBBV/588000000;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
    facebookAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.45.109;]',
    facebookExternalHit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    metaExternalAgent: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    metaExternalFetcher: 'meta-externalfetcher/1.1',
    whatsapp: 'WhatsApp/2.24.12.78 A',
    whatsappIos: 'WhatsApp/2.24.12.78 i',
    instagramNativeFetch: 'Instagram 345.0.0.34.101 Android (33/13; 480dpi; 1080x2340; samsung; SM-S918B; dm3q; qcom; ar_SA; 633215957)',
    googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    twitterbot: 'Twitterbot/1.0',
    slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    curl: 'curl/8.7.1',
    pythonRequests: 'python-requests/2.31.0',
    unknownBrowser: 'SomeNewBrowser/1.0',
};

describe('classifyClick', () => {
    const person = (userAgent: string, method = 'GET', purpose?: string) => classifyClick({ method, userAgent, purpose });

    it('a person in an ordinary browser is a click, by device', () => {
        assert.deepEqual(person(UA.safariIphone), { uaClass: 'ios', isPrefetch: false });
        assert.deepEqual(person(UA.chromeAndroid), { uaClass: 'android', isPrefetch: false });
        assert.deepEqual(person(UA.chromeMac), { uaClass: 'desktop', isPrefetch: false });
        assert.deepEqual(person(UA.chromeWindows), { uaClass: 'desktop', isPrefetch: false });
        assert.deepEqual(person(UA.firefoxLinux), { uaClass: 'desktop', isPrefetch: false });
        assert.deepEqual(person(UA.unknownBrowser), { uaClass: 'other', isPrefetch: false });
    });

    it('the Instagram and Facebook in-app browsers are people: that is where a DM link is tapped', () => {
        assert.deepEqual(person(UA.instagramIphone), { uaClass: 'instagram', isPrefetch: false });
        assert.deepEqual(person(UA.instagramAndroid), { uaClass: 'instagram', isPrefetch: false });
        assert.deepEqual(person(UA.facebookIphone), { uaClass: 'facebook', isPrefetch: false });
        assert.deepEqual(person(UA.facebookAndroid), { uaClass: 'facebook', isPrefetch: false });
    });

    it('Meta\'s and WhatsApp\'s link-preview fetchers are previews, never clicks', () => {
        for (const ua of [UA.facebookExternalHit, UA.metaExternalAgent, UA.metaExternalFetcher, UA.whatsapp, UA.whatsappIos, UA.twitterbot, UA.slackbot]) {
            assert.deepEqual(person(ua), { uaClass: 'preview', isPrefetch: true }, ua);
        }
    });

    it('an Instagram user-agent with no browser engine is the app\'s own fetcher: a preview', () => {
        assert.deepEqual(person(UA.instagramNativeFetch), { uaClass: 'preview', isPrefetch: true });
    });

    it('crawlers, scripts and a request that names no client are bots, and not clicks', () => {
        for (const ua of [UA.googlebot, UA.curl, UA.pythonRequests, '', '   ', undefined]) {
            assert.deepEqual(classifyClick({ method: 'GET', userAgent: ua }), { uaClass: 'bot', isPrefetch: true }, JSON.stringify(ua));
        }
    });

    it('HEAD is a prefetch whatever sent it, and keeps the class the user-agent gives', () => {
        assert.deepEqual(person(UA.safariIphone, 'HEAD'), { uaClass: 'ios', isPrefetch: true });
        assert.deepEqual(person(UA.instagramIphone, 'HEAD'), { uaClass: 'instagram', isPrefetch: true });
        assert.deepEqual(person(UA.facebookExternalHit, 'head'), { uaClass: 'preview', isPrefetch: true }, 'any case');
        assert.deepEqual(person(UA.curl, 'HEAD'), { uaClass: 'bot', isPrefetch: true });
    });

    it('a speculative-load header makes a browser\'s request a prefetch', () => {
        for (const purpose of ['prefetch', 'prefetch;prerender', 'prerender', 'preview', 'PREFETCH', 'x prefetch y']) {
            assert.equal(person(UA.chromeAndroid, 'GET', purpose).isPrefetch, true, purpose);
        }
        for (const none of [undefined, '', 'navigate']) assert.equal(person(UA.chromeAndroid, 'GET', none).isPrefetch, false, String(none));
    });

    it('only ever returns a class from the closed list the database allows', () => {
        for (const ua of [...Object.values(UA), '', 'x'.repeat(5000), '\u0000', 'عربي']) {
            for (const method of ['GET', 'HEAD', 'POST']) assert.ok((LINK_CLICK_UA_CLASSES as readonly string[]).includes(classifyClick({ method, userAgent: ua }).uaClass), `${method} ${ua.slice(0, 30)}`);
        }
    });

    it('is the same list as the CHECK on link_clicks.ua_class, so the code cannot store a class the database refuses (or the reverse)', () => {
        const sql = readFileSync('src/config/migration_v38_tracked_links.sql', 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
        const listed = /CHECK \(ua_class IN \(([^)]*)\)\)/.exec(sql)?.[1];
        assert.ok(listed, 'the CHECK is there');
        assert.deepEqual([...listed.matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...LINK_CLICK_UA_CLASSES]);
    });

    it('stores a class and a flag, never the user-agent: the click row has no field that could hold it', () => {
        const click = person(UA.instagramIphone);
        assert.deepEqual(Object.keys(click).sort(), ['isPrefetch', 'uaClass']);
        assert.equal(JSON.stringify(click).includes('Mozilla'), false);
    });
});

// ─── The statements ──────────────────────────────────────────────────────────────────────────

interface LinkRow { code: string; creator_id: string; conversation_id: string | null; offer_id: string; target_url: string }

describe('createTrackedLink, resolve, recordClick', () => {
    let db: FakeDb;
    let links: LinkRow[];
    let clicks: Array<{ code: string; ua_class: string; is_prefetch: boolean }>;
    let failNextInsertWith: { code: string } | null;

    beforeEach(() => {
        links = []; clicks = []; failNextInsertWith = null;
        db = installFakeDb();
        db.routes.push([exact(CREATE_LINK_SQL), ([code, creator, offer, target, conversation], sql) => {
            if (failNextInsertWith) { const err = Object.assign(new Error('duplicate key value violates unique constraint "tracked_links_pkey"'), failNextInsertWith); failNextInsertWith = null; throw err; }
            if (links.some((l) => l.code === code)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
            // The arbiter applies only when the statement names it, as the partial unique index is only a conflict target when it is spelled.
            const arbiter = sql.includes('ON CONFLICT (conversation_id, offer_id) WHERE conversation_id IS NOT NULL');
            const existing = arbiter && conversation !== null ? links.find((l) => l.conversation_id === conversation && l.offer_id === offer) : undefined;
            if (existing) {
                if (sql.includes('DO UPDATE SET target_url = EXCLUDED.target_url')) existing.target_url = target;
                return { rows: [{ code: existing.code }] };
            }
            links.push({ code, creator_id: creator, conversation_id: conversation, offer_id: offer, target_url: target });
            return { rows: [{ code }] };
        }]);
        db.routes.push([exact(RESOLVE_LINK_SQL), ([code], sql) => ({ rows: sql.includes('WHERE code = $1') ? links.filter((l) => l.code === code) : links })]);
        db.routes.push([exact(RECORD_CLICK_SQL), ([code, uaClass, isPrefetch]) => { clicks.push({ code, ua_class: uaClass, is_prefetch: isPrefetch }); return { rows: [], rowCount: 1 }; }]);
    });
    afterEach(() => db.restore());

    it('stores the link under a fresh code and hands the code back', async () => {
        const code = await createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION);
        assert.ok(isLinkCode(code));
        assert.deepEqual(links, [{ code, creator_id: CREATOR, conversation_id: CONVERSATION, offer_id: 'handbook', target_url: REFERRAL }]);
    });

    it('stores the target byte for byte', async () => {
        const code = await createTrackedLink(CREATOR, 'o', REFERRAL, CONVERSATION);
        assert.equal(links.find((l) => l.code === code)!.target_url, REFERRAL);
        assert.equal((await resolve(code))!.targetUrl, REFERRAL);
    });

    it('stores the wire form of an address with characters a header cannot carry', async () => {
        const code = await createTrackedLink(CREATOR, 'o', 'https://example.com/منتج', CONVERSATION);
        assert.equal(links.find((l) => l.code === code)!.target_url, 'https://example.com/%D9%85%D9%86%D8%AA%D8%AC');
    });

    it('gives the same code for the same (conversation, offer) every time, and a new one for another conversation or another offer', async () => {
        const a = await createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION);
        const again = await createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION);
        const otherPerson = await createTrackedLink(CREATOR, 'handbook', REFERRAL, OTHER_CONVERSATION);
        const otherOffer = await createTrackedLink(CREATOR, 'book', REFERRAL, CONVERSATION);
        assert.equal(again, a);
        assert.equal(new Set([a, otherPerson, otherOffer]).size, 3);
        assert.equal(links.length, 3);
    });

    it('moves the existing link to the newer address when the offer\'s URL changed, and keeps the code a DM already carries', async () => {
        const code = await createTrackedLink(CREATOR, 'handbook', 'https://example.com/old', CONVERSATION);
        assert.equal(await createTrackedLink(CREATOR, 'handbook', 'https://example.com/new', CONVERSATION), code);
        assert.equal(links[0]!.target_url, 'https://example.com/new');
    });

    it('makes a new link every time when there is no conversation: a test link has no pair to share', async () => {
        const a = await createTrackedLink(CREATOR, 'handbook', REFERRAL);
        const b = await createTrackedLink(CREATOR, 'handbook', REFERRAL, null);
        assert.notEqual(a, b);
        assert.deepEqual(links.map((l) => l.conversation_id), [null, null]);
    });

    it('retries with a new code when the code collides, and gives up after five', async () => {
        failNextInsertWith = { code: '23505' };
        const code = await createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION);
        assert.ok(isLinkCode(code));
        assert.equal(db.ran(/^INSERT INTO tracked_links/).length, 2);
        assert.notEqual(db.ran(/^INSERT INTO tracked_links/)[0]!.params[0], db.ran(/^INSERT INTO tracked_links/)[1]!.params[0], 'a fresh code, not the same one again');

        db.statements.length = 0;
        db.routes.unshift([exact(CREATE_LINK_SQL), () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); }]);
        await assert.rejects(createTrackedLink(CREATOR, 'other', REFERRAL, CONVERSATION), { code: '23505' });
        assert.equal(db.ran(/^INSERT INTO tracked_links/).length, 5);
    });

    it('does not retry any other database error', async () => {
        db.routes.unshift([exact(CREATE_LINK_SQL), () => { throw Object.assign(new Error('relation "tracked_links" does not exist'), { code: '42P01' }); }]);
        await assert.rejects(createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION), { code: '42P01' });
        assert.equal(db.ran(/^INSERT INTO tracked_links/).length, 1);
    });

    it('refuses a target that is not an http(s) address, and a missing creator or offer, before it touches the database', async () => {
        await assert.rejects(createTrackedLink(CREATOR, 'handbook', 'javascript:alert(1)', CONVERSATION), InvalidTargetUrlError);
        await assert.rejects(createTrackedLink(CREATOR, 'handbook', '', CONVERSATION), InvalidTargetUrlError);
        await assert.rejects(createTrackedLink('', 'handbook', REFERRAL, CONVERSATION), TypeError);
        await assert.rejects(createTrackedLink(CREATOR, '', REFERRAL, CONVERSATION), TypeError);
        await assert.rejects(createTrackedLink(CREATOR, 'o'.repeat(101), REFERRAL, CONVERSATION), TypeError);
        assert.equal(db.statements.length, 0);
    });

    it('resolves a code to its link, an unknown code to null, and a malformed code to null without a query', async () => {
        const code = await createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION);
        await createTrackedLink(CREATOR, 'book', 'https://example.com/other', CONVERSATION);
        db.statements.length = 0;
        assert.deepEqual(await resolve(code), { code, creatorId: CREATOR, conversationId: CONVERSATION, offerId: 'handbook', targetUrl: REFERRAL });
        assert.equal(await resolve('abcdefghij'), null);
        assert.equal(db.statements.length, 2, 'two lookups, each by code');
        db.statements.length = 0;
        for (const bad of ['', 'short', 'abcdefghi!', '../etc/passwd1', 'a'.repeat(40)]) assert.equal(await resolve(bad), null);
        assert.equal(db.statements.length, 0);
    });

    it('records one click as the code, the class and the flag, and nothing else', async () => {
        const code = await createTrackedLink(CREATOR, 'handbook', REFERRAL, CONVERSATION);
        await recordClick(code, { uaClass: 'instagram', isPrefetch: false });
        await recordClick(code, { uaClass: 'preview', isPrefetch: true });
        assert.deepEqual(clicks, [{ code, ua_class: 'instagram', is_prefetch: false }, { code, ua_class: 'preview', is_prefetch: true }]);
        const insert = db.ran(/^INSERT INTO link_clicks/)[0]!;
        assert.deepEqual(insert.params, [code, 'instagram', false], 'three parameters: no address, no user-agent');
        assert.equal(/\bip\b|user_agent|useragent/i.test(insert.sql), false);
    });

    it('lets a failed insert reach the caller: the route logs it and redirects anyway', async () => {
        db.routes.unshift([exact(RECORD_CLICK_SQL), () => { throw new Error('connection terminated'); }]);
        await assert.rejects(recordClick('abcdefghij', { uaClass: 'ios', isPrefetch: false }), /connection terminated/);
    });
});
