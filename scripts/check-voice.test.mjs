/**
 * The voice guard (identity B3): `npm run check:voice` is what CI runs; this file tests the guard.
 *
 * Three blocks. The first asserts the repo is clean (and that the strings B3 wrote are there, in both languages, and are the ones
 * IDENTITY.md §7 names). The second asserts every word on the list is caught, in English and in Arabic, and that the registered name and a
 * limit stated are not. The third mutates ONE file at a time IN MEMORY (`withFile` lays an override over the repo) and requires a finding
 * that names the file and the line. A guard that was never shown to fail has not been shown to work, and a mutation that matched nothing
 * passes silently, so every mutation below first asserts that its anchor exists, exactly once.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    ALLOWED,
    DICT_FILES,
    NAME_PATTERNS,
    RULES,
    collectCopy,
    decodeEntities,
    dictionaryEntries,
    foldArabic,
    judge,
    pageCopy,
    scanPieces,
    scanRepo,
    violations,
    withoutName,
} from './check-voice.mjs';

const read = (rel) => readFileSync(rel, 'utf8');
const real = { read: (p) => readFileSync(p, 'utf8'), list: (d) => readdirSync(d) };

/** The repo with one file's text replaced: `anchor` must occur exactly once, and is swapped for `replacement`. */
function withFile(path, anchor, replacement) {
    const src = read(path);
    const n = src.split(anchor).length - 1;
    assert.equal(n, 1, `${path}: anchor ${JSON.stringify(anchor)} occurs ${n} times, not once; the mutation would be a no-op`);
    const mutated = src.replace(anchor, () => replacement);
    assert.notEqual(mutated, src);
    return { read: (p) => (p === path ? mutated : real.read(p)), list: real.list };
}

const rulesOf = (text) => violations(text).map((v) => v.rule);

// ─── 1. The repo, and the strings B3 wrote ────────────────────────────────────────────────────────────────────────────────

describe('the shipped copy', () => {
    it('breaks none of the rules, and every allowed use is still used', () => {
        const { findings, stale, pieces } = scanRepo('.');
        assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.word}`), []);
        assert.deepEqual(stale.map((e) => `${e.file} [${e.rule}] ${e.key ?? e.text}`), []);
        assert.ok(pieces.length > 10000, `${pieces.length} pieces: the scan is reading the dictionaries`);
    });

    it('reads both dictionaries, every public page and the dashboard shell', () => {
        const files = new Set(collectCopy('.').map((p) => p.file));
        for (const f of Object.values(DICT_FILES)) assert.ok(files.has(f), f);
        for (const f of readdirSync('public').filter((n) => n.endsWith('.html'))) assert.ok(files.has(`public/${f}`), f);
        assert.ok(files.has('dashboard/index.html'));
    });
});

describe('the strings B3 wrote', () => {
    const dict = (lang) => Object.fromEntries(dictionaryEntries(read(DICT_FILES[lang]), DICT_FILES[lang]).map((e) => [e.where, e.text]));
    const ar = dict('ar');
    const en = dict('en');

    it('exist in both languages', () => {
        for (const key of ['login.subtitle', 'app.tagline', 'app.description']) {
            assert.ok(ar[key]?.trim(), `ar ${key}`);
            assert.ok(en[key]?.trim(), `en ${key}`);
            assert.match(ar[key], /[؀-ۿ]/, `ar ${key} is Arabic`);
            assert.doesNotMatch(en[key], /[؀-ۿ]/, `en ${key} is English`);
        }
    });

    it('are the tagline and the descriptor IDENTITY.md §7 names, and a description that states its limit', () => {
        // IDENTITY.md §7 tagline 1 and the descriptor; §8 puts the descriptor under the login title.
        assert.equal(en['app.tagline'], 'One word opens the conversation');
        assert.equal(ar['app.tagline'].normalize('NFC'), 'كلمةٌ واحدة تفتح المحادثة');
        assert.equal(en['login.subtitle'], 'A growth studio for Arabic creators');
        assert.equal(ar['login.subtitle'], 'استوديو نموّ لصنّاع المحتوى العرب');
        // DESIGN.md §9: "the limit stated in the same paragraph as the feature".
        assert.match(en['app.description'], /one message per person a day, within Meta’s limits/);
        assert.match(ar['app.description'], /رسالة واحدة لكل شخص في اليوم، وضمن حدود ميتا/);
    });

    it('carry no exclamation mark (IDENTITY.md §4, DESIGN.md §9) and keep the name out of the tagline', () => {
        for (const key of ['login.subtitle', 'app.tagline', 'app.description']) {
            for (const t of [ar[key], en[key]]) assert.doesNotMatch(t, /[!！]/, key);
        }
        assert.doesNotMatch(en['app.tagline'], /AutoReply/);
    });

    it('are what the dashboard shows: the static shell says the Arabic ones, and app.js sets the description from the dictionary', () => {
        const index = read('dashboard/index.html');
        const app = read('dashboard/js/app.js');
        assert.equal(index.match(/<title>([^<]*)<\/title>/)[1], `${ar['app.name']} — ${ar['app.tagline']}`);
        assert.equal(index.match(/<meta name="description" content="([^"]*)">/)[1], ar['app.description']);
        assert.equal(index.match(/data-i18n="login\.subtitle">([^<]*)</)[1], ar['login.subtitle']);
        assert.match(app, /document\.title = `\$\{t\('app\.name'\)\} — \$\{t\('app\.tagline'\)\}`/);
        assert.match(app, /meta\[name="description"\]'\)\?\.setAttribute\('content', t\('app\.description'\)\)/);
    });

    it('are gone from where the old ones were: no automation-dashboard wording is left in the shell', () => {
        const index = read('dashboard/index.html');
        assert.doesNotMatch(index, /لوحة تحكم أتمتة|أتمتة الردود/);
        assert.doesNotMatch(read(DICT_FILES.ar) + read(DICT_FILES.en), /reply automation|Messaging automation dashboard|لوحة تحكم أتمتة الرسائل/);
    });
});

// ─── 2. The rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the list IDENTITY.md §7 and DESIGN.md §7 name', () => {
    // [rule, English, Arabic]: every word of the "Never" list in both scripts, each in a sentence a page might write.
    const LIST = [
        ['pro', 'Get the Pro plan', 'احصل على خطة برو'],
        ['premium', 'A Premium tier', 'باقة بريميوم'],
        ['powered-by', 'Powered by Gemini', 'مدعوم من جيميناي'],
        ['instant', 'Instant replies', 'ردود فورية'],
        ['instant', 'Replies go out instantly', 'تصل الرسالة فوراً'],
        ['guaranteed', 'Guaranteed delivery', 'تسليم مضمون'],
        ['ai-powered', 'An AI-powered assistant', 'مساعد ذكي'],
        ['bot', 'Our bot answers', 'بوت يردّ عليهم'],
        ['revolutionary', 'A revolutionary studio', 'استوديو ثوري'],
        ['all-in-one', 'The all-in-one studio', 'استوديو متكامل'],
        ['magic', 'Pure magic', 'تجربة سحرية'],
        ['viral', 'Go viral', 'اصنع تريند'],
        ['growth-hack', 'A growth hack', 'اختراق النمو'],
        ['supercharge', 'Supercharge your engagement', 'ضاعف تفاعلك'],
        ['unlimited', 'Unlimited posts', 'منشورات بلا حدود'],
        ['trusted-by', 'Trusted by creators', 'موثوق من المبدعين'],
        ['manychat', 'The ManyChat alternative', 'بديل مانيشات'],
    ];

    for (const [rule, english, arabic] of LIST) {
        it(`${rule}: caught in «${english}» and «${arabic}»`, () => {
            assert.ok(rulesOf(english).includes(rule), `en ${english}: ${rulesOf(english)}`);
            assert.ok(rulesOf(arabic).includes(rule), `ar ${arabic}: ${rulesOf(arabic)}`);
        });
    }

    it('has a rule for every row above, and a row for every rule that can fire in both scripts', () => {
        assert.deepEqual([...new Set(LIST.map(([r]) => r))].sort(), RULES.filter((r) => r.id !== 'ai-powered-ar').map((r) => r.id).sort());
        assert.ok(rulesOf('يعمل بالذكاء الاصطناعي').includes('ai-powered-ar'));
    });

    it('catches the Arabic however it is written: tanween, diacritics, tatweel, hamza, clitics', () => {
        for (const w of ['فوراً', 'فورًا', 'فَوْراً', 'فـــوراً', 'فوري', 'الفوري', 'بشكل فوري', 'على الفور', 'وفوراً', 'مضمونة', 'غير محدودة', 'بلا حدود', 'للبوت', 'والبوتات', 'الذكي', 'ذكيّة', 'متكاملة', 'ثورية', 'وسحري', 'ضاعفوا', 'ضاعف']) {
            assert.ok(violations(`هذا ${w} هنا`).length > 0, w);
        }
    });

    it('catches the English however it is written: case, hyphens, no-break spaces, plurals', () => {
        for (const w of ['INSTANT', 'Instantly', 'GUARANTEED', 'Guarantees', 'AI powered', 'AI-Powered', 'Chatbot', 'chat bot', 'Bots', 'All in one', 'ALL-IN-ONE', 'Magical', 'Viral', 'growth-hacking', 'Supercharged', 'Unlimited', 'powered by', 'trusted by']) {
            assert.ok(violations(`It is ${w} here`).length > 0, w);
        }
    });

    it('does not fire on the words that merely contain a banned stem', () => {
        for (const ok of ['Instagram', 'protect your account', 'a professional page', 'the provider', 'bottom of the page', 'robot', 'the proof', 'Product', 'Promise', 'magnet', 'guard', 'growth and hacking']) {
            assert.deepEqual(rulesOf(ok), [], ok);
        }
        for (const ok of ['اهتمام', 'ثبوت', 'تذكير', 'ذكرى', 'الذكاء الاصطناعي', 'ضمن حدود ميتا', 'محدود', 'سحب', 'فورد', 'مثور', 'بروفايل', 'تكامل']) {
            assert.deepEqual(rulesOf(ok), [], ok);
        }
    });

    it('ALLOWS THE NAME: «AutoReply Pro» and «أوتوريبلاي برو», however it is spaced, and nothing else of "Pro"', () => {
        for (const name of ['AutoReply Pro', 'autoreply pro', 'AUTOREPLY PRO', 'AutoReply Pro', 'AutoReply Pro.', '“AutoReply Pro”', 'أوتوريبلاي برو', 'اوتوريبلاي برو', 'أوتوريبلاي برو', 'أوتوريبلاي‌برو', 'أُوتوريبلاي بَرو']) {
            assert.deepEqual(rulesOf(`مرحباً بك في ${name}، حيث تبدأ`), [], name);
            assert.deepEqual(rulesOf(`Welcome to ${name} today`), [], name);
        }
        // The name is masked, not trusted: a banned word beside it is still a finding, and "Pro" apart from it is one too.
        assert.deepEqual(rulesOf('AutoReply Pro Premium'), ['premium']);
        assert.deepEqual(rulesOf('AutoReply Pro, instantly'), ['instant']);
        assert.deepEqual(rulesOf('AutoReply Pro and Pro features'), ['pro']);
        assert.deepEqual(rulesOf('أوتوريبلاي برو وخطة برو'), ['pro']);
        assert.equal(withoutName('x AutoReply Pro y').includes('Pro'), false);
        assert.equal(NAME_PATTERNS.length, 2);
    });

    it('allows a LIMIT STATED, and only when the negator stands directly before the word', () => {
        for (const ok of ['Delivery is not guaranteed', 'There is no guarantee', 'We cannot guarantee a send', "It isn't guaranteed", 'Nothing guaranteed', 'Not always instant', 'It does not guarantee delivery', 'Without any guarantee', 'Never unlimited',
            'لا نضمن التسليم', 'التسليم غير مضمون', 'بلا ضمان', 'ليس مضمونا', 'لا يضمن ميتا ذلك', 'ولا نضمن', 'ليست فورية', 'دون ضمان']) {
            assert.deepEqual(rulesOf(ok), [], ok);
        }
        for (const bad of ['Guaranteed delivery', 'Not just fast, guaranteed', 'No fuss, guaranteed replies', 'We never wait. Instant replies', 'Not only reliable but guaranteed', 'No setup. Unlimited posts',
            'تسليم مضمون', 'ليس فقط سريعاً بل مضمون', 'لا انتظار، ردود فورية', 'ضمان التسليم']) {
            assert.ok(violations(bad).length > 0, bad);
        }
        // Only the three limit words are negatable: "not a bot" is still a bot, and a negated hype word is still hype.
        assert.deepEqual(rulesOf('It is not a bot'), ['bot']);
        assert.deepEqual(rulesOf('It is not magic'), ['magic']);
    });

    it('reads the HTML entities and the escapes a page uses', () => {
        assert.equal(decodeEntities('A&nbsp;&amp;&nbsp;B &mdash; &#1601; &#x641;'), 'A & B — ف ف');
        assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
        assert.equal(foldArabic('أَإآٱ ى فـــورًا'), 'اااا ي فورا');
    });
});

// ─── 3. What it reads, and what it does not ──────────────────────────────────────────────────────────────────────────────

describe('what the scan reads', () => {
    it('reads the VALUES of a dictionary and never its comments, and names the line of the key', () => {
        const source = `/** Never say instantly. */\n(globalThis.I18N_DICT = globalThis.I18N_DICT || {}).en = {\n    // 'a.b': 'Premium magic',\n    'a.c': 'Fine',\n    'a.d': 'Instantly done',\n    'a.e': 42,\n};\n`;
        const entries = dictionaryEntries(source, 'x/i18n.en.js');
        assert.deepEqual(entries.map((e) => [e.where, e.line]), [['a.c', 4], ['a.d', 5]]);
        assert.deepEqual(scanPieces(entries).map((f) => [f.where, f.rule, f.line]), [['a.d', 'instant', 5]]);
    });

    it('reads a page\'s text and copy attributes, and not its comments, styles or scripts; a JSON-LD block is copy', () => {
        const html = [
            '<!-- Instantly! the ledger names every banned word: Premium, magic, viral -->',
            '<title>Fine title</title>',
            '<style>.instant::before { content: "Premium magic"; }</style>',
            '<script>const s = "Premium instantly viral"; // magic</script>',
            '<script type="application/ld+json">{"description":"An all-in-one thing"}</script>',
            '<meta name="description" content="A viral tool">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<meta property="og:image:alt" content="A card: Powered by us">',
            '<img src="/x.png" alt="An unlimited sky">',
            '<button aria-label="Go premium" title="Try it">Fine</button>',
            '<p>Plain &amp; <b>fine</b>, then guaranteed&nbsp;results</p>',
        ].join('\n');
        const found = scanPieces(pageCopy(html, 'public/x.html')).map((f) => [f.line, f.rule, f.where]);
        assert.deepEqual(found, [
            [5, 'all-in-one', 'text'],
            [6, 'viral', 'meta description'],
            [8, 'powered-by', 'meta og:image:alt'],
            [9, 'unlimited', 'img alt'],
            [10, 'premium', 'button aria-label'],
            [11, 'guaranteed', 'text'],
        ]);
    });

    it('takes an attribute whose value holds a ">" and a quote of the other kind', () => {
        const pieces = pageCopy(`<img alt='say "instantly" > now' src="a.png"><p>ok</p>`, 'public/x.html');
        assert.deepEqual(pieces.map((p) => p.text), ['say "instantly" > now', 'ok']);
    });
});

// ─── 4. The mutations: one file at a time, in memory ──────────────────────────────────────────────────────────────────────

describe('the guard catches a planted word', () => {
    const find = (io, pred) => scanRepo('.', io).findings.filter(pred);

    it('in an i18n value (English): the file, the key, the line, the rule', () => {
        const anchor = "'app.tagline': 'One word opens the conversation',";
        const io = withFile(DICT_FILES.en, anchor, "'app.tagline': 'Supercharge every conversation',");
        const hits = find(io, (f) => f.file === DICT_FILES.en);
        assert.equal(hits.length, 1);
        assert.equal(hits[0].rule, 'supercharge');
        assert.equal(hits[0].where, 'app.tagline');
        assert.equal(read(DICT_FILES.en).split('\n')[hits[0].line - 1].trim().startsWith("'app.tagline':"), true, 'the line is the key\'s line');
    });

    it('in an i18n value (Arabic): فوراً, with a tanween', () => {
        const anchor = "'app.tagline': 'كلمةٌ واحدة تفتح المحادثة',";
        const io = withFile(DICT_FILES.ar, anchor, "'app.tagline': 'كلمةٌ واحدة تفتح المحادثة فوراً',");
        const hits = find(io, (f) => f.file === DICT_FILES.ar);
        assert.deepEqual(hits.map((h) => [h.where, h.rule]), [['app.tagline', 'instant']]);
    });

    it('in the new description, which is where B3 put its own copy', () => {
        const anchor = 'within Meta’s limits.';
        const io = withFile(DICT_FILES.en, anchor, 'with unlimited reach.');
        assert.deepEqual(find(io, (f) => f.file === DICT_FILES.en).map((h) => [h.where, h.rule]), [['app.description', 'unlimited']]);
    });

    it('in a public page: the file, the line, the rule', () => {
        const anchor = '<title data-lang-only="en">AutoReply Pro — a growth studio for Arabic creators</title>';
        const io = withFile('public/landing.html', anchor, '<title data-lang-only="en">AutoReply Pro — an all-in-one growth studio for Arabic creators</title>');
        const hits = find(io, (f) => f.file === 'public/landing.html');
        assert.equal(hits.length, 1);
        assert.equal(hits[0].rule, 'all-in-one');
        assert.equal(read('public/landing.html').split('\n')[hits[0].line - 1].includes('<title data-lang-only="en">'), true, 'the line is the title\'s line');
    });

    it('in a public page: a body sentence in Arabic, and the meta description', () => {
        const anchor = '<meta name="description" data-lang-only="ar" content="ريلز من فيديوهاتك الطويلة';
        const io = withFile('public/landing.html', anchor, '<meta name="description" data-lang-only="ar" content="ثورة في ريلز من فيديوهاتك الطويلة');
        assert.deepEqual(find(io, (f) => f.file === 'public/landing.html').map((h) => [h.rule, h.where]), [['revolutionary', 'meta description']]);
    });

    it('in the dashboard shell\'s <title> and meta description', () => {
        const title = withFile('dashboard/index.html', '<title>أوتوريبلاي برو — كلمةٌ واحدة تفتح المحادثة</title>', '<title>أوتوريبلاي برو — بوت ذكي</title>');
        assert.deepEqual(find(title, (f) => f.file === 'dashboard/index.html').map((h) => h.rule).sort(), ['ai-powered', 'bot']);
        const desc = withFile('dashboard/index.html', 'وتجدول منشوراتك من اللوحة نفسها."', 'وتجدول منشوراتك من اللوحة نفسها، مضمون."');
        assert.deepEqual(find(desc, (f) => f.file === 'dashboard/index.html').map((h) => [h.rule, h.where]), [['guaranteed', 'meta description']]);
    });

    it('in a legal page\'s body, beside a sentence the allow-list excuses: only the planted word is a finding', () => {
        const anchor = 'فيُلغى الوصول فوراً';
        const io = withFile('public/terms.html', anchor, `${anchor}، وبشكل فوري ومضمون`);
        const hits = find(io, (f) => f.file === 'public/terms.html');
        // The excused «فوراً» stays excused. An entry covers its own words and no others: the added «فوري» is a new use of the same
        // rule, and «مضمون» a different rule, so both are findings.
        assert.deepEqual(hits.map((h) => [h.rule, h.word]), [['instant', 'فوري'], ['guaranteed', 'ومضمون']]);
    });

    it('planting Pro as a plan name beside the name is caught; the name alone, as it stands in the repo, is not', () => {
        const io = withFile(DICT_FILES.en, "'app.name': 'AutoReply Pro',", "'app.name': 'AutoReply Pro Plus Pro',");
        assert.deepEqual(find(io, (f) => f.file === DICT_FILES.en).map((h) => [h.where, h.rule]), [['app.name', 'pro']]);
        assert.deepEqual(scanRepo('.').findings, []);
    });
});

describe('the allow-list', () => {
    it('is small, and every entry names one rule in one place with a reason', () => {
        assert.ok(ALLOWED.length <= 12, `${ALLOWED.length} entries: this list is meant to shrink`);
        const ruleIds = new Set(RULES.map((r) => r.id));
        for (const e of ALLOWED) {
            assert.ok(ruleIds.has(e.rule), `${e.rule} is a rule`);
            assert.equal((e.text === undefined) !== (e.key === undefined), true, 'exactly one of text and key');
            assert.ok(e.reason.length > 40, `a reason for ${e.rule} ${e.text ?? e.key}`);
            for (const f of Array.isArray(e.file) ? e.file : [e.file]) assert.ok(existsSync(f), f);
            if (e.text !== undefined) assert.ok(e.text.length >= 12, 'a sentence, not a word: a bare word would excuse every other use');
        }
    });

    it('goes stale, loudly: remove the sentence it excuses and the entry is reported', () => {
        const anchor = 'No uptime or delivery guarantee';
        const io = withFile('public/landing.html', anchor, 'Meta decides what is delivered');
        const { findings, stale } = scanRepo('.', io);
        assert.deepEqual(findings, []);
        assert.deepEqual(stale.map((e) => [e.file, e.rule, e.text]), [['public/landing.html', 'guaranteed', anchor]]);
    });

    it('excuses one sentence, not the page: the same word elsewhere on the same page is a finding', () => {
        const anchor = 'No uptime or delivery guarantee';
        const io = withFile('public/landing.html', anchor, `${anchor}. Guaranteed delivery`);
        const { findings } = scanRepo('.', io);
        assert.deepEqual(findings.map((f) => [f.file, f.rule]), [['public/landing.html', 'guaranteed']]);
    });

    it('excuses the Telegram setup\'s "bot" and nothing else in the dictionaries', () => {
        const kept = scanPieces(collectCopy('.')).filter((f) => f.rule === 'bot');
        assert.ok(kept.length >= 20, `${kept.length} Telegram hits are excused`);
        assert.ok(kept.every((f) => f.where.startsWith('settings.notify.') || f.file.startsWith('public/landing')), 'every raw "bot" hit is the Telegram setup or the landing\'s sample infographic');
        const io = withFile(DICT_FILES.en, "'inbox.funnel.reply.median': 'Agent reply time (median)',", "'inbox.funnel.reply.median': 'Bot reply time (median)',");
        assert.deepEqual(scanRepo('.', io).findings.map((f) => [f.where, f.rule]), [['inbox.funnel.reply.median', 'bot']]);
        assert.equal(judge([{ file: DICT_FILES.en, rule: 'bot', where: 'settings.notify.token', word: 'bot', text: 'Telegram bot token' }]).findings.length, 0);
    });
});
