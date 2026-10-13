/**
 * The Campaigns screen's CSV import, now that its seeds come from the API (docs/onboarding/05 P13): the REAL
 * `dashboard/js/pages/campaigns.js` in a `node:vm` context with the API, the file reader and the DOM stubbed.
 *
 * What the owner's dashboard must keep doing: choosing a CSV asks `GET /api/profile/campaign-seeds` once, gives each course the
 * first seed whose `name_match` its name contains, and starts the rest from the server's `fallback` (P15: the page carries no wording
 * of its own; the owner's bytes are pinned by `campaigns.import-rows` in golden.test.ts); and what it must never do: import generic
 * text because the seeds could not be read, or put a `match_mode` on a campaign whose seed did not ask for one.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;

/** What the page made, as plain data of this realm: `deepStrictEqual` compares prototypes, and the vm's are its own. */
const plain = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

interface Harness {
    page: Json;
    toasts: { message: string; kind?: string }[];
    modals: number;
    created: Json[];
    seedCalls: number;
    /** The rows the import is about to create, as plain data. */
    rows(): Json[];
    /** Choose a CSV of these courses, and wait for the page's (async) reader handler to finish. */
    choose(courses?: typeof COURSES): Promise<void>;
    /** The form the rows' inputs make once the modal is on screen: one checkbox and three fields per pending row. */
    fillForm(): void;
}

/** A campaigns page whose `API.getCampaignSeeds` answers `answer` (or throws it, when it is an Error). */
function load(answer: unknown): Harness {
    const dom = new Map<string, Json>();
    const checkboxes: Json[] = [];
    let lastRead: Promise<void> | null = null;
    class FileReaderStub {
        onload: ((event: { target: { result: string } }) => Promise<void>) | null = null;
        readAsText(file: { text: string }): void {
            // The page's handler is async: what it returns is what the test waits for.
            lastRead = this.onload!({ target: { result: file.text } });
        }
    }
    const h: Harness = {
        page: {}, toasts: [], modals: 0, created: [], seedCalls: 0,
        rows: () => plain<Json[]>(h.page.pendingImport),
        async choose(courses = COURSES) {
            lastRead = null;
            h.page.handleCSVSelect({ files: [{ text: csv(courses) }], value: 'chosen.csv' });
            await lastRead;
        },
        fillForm() {
            const rows: Json[] = h.page.pendingImport;
            checkboxes.length = 0;
            rows.forEach((row, i) => {
                checkboxes.push({ checked: true, getAttribute: () => String(i) });
                dom.set(`import-trigger-${i}`, { value: row.triggerKeywords });
                dom.set(`import-dm-${i}`, { value: row.dmTemplate });
                dom.set(`import-public-${i}`, { value: row.publicReplies });
            });
        },
    };
    const ctx: Json = {
        UI: {
            registerActions: () => {},
            showModal: () => { h.modals++; },
            closeModal: () => {},
            formatNumber: (n: unknown) => String(n),
            button: () => '',
            toast: (message: string, kind?: string) => { h.toasts.push({ message, kind }); },
        },
        html: Object.assign(() => '', { raw: (s: unknown) => s }),
        t: (key: string) => key,
        API: {
            getCampaignSeeds: async () => { h.seedCalls++; if (answer instanceof Error) throw answer; return answer; },
            createCampaign: async (body: Json) => { h.created.push(plain(body)); return {}; },
        },
        document: {
            getElementById: (id: string) => dom.get(id) ?? null,
            querySelectorAll: (selector: string) => (selector === '.import-checkbox' ? checkboxes : []),
        },
        FileReader: FileReaderStub,
        console: { error: () => {}, log: () => {}, warn: () => {} },
    };
    vm.createContext(ctx);
    vm.runInContext(readFileSync('dashboard/js/pages/campaigns.js', 'utf8'), ctx, { filename: 'dashboard/js/pages/campaigns.js' });
    // The import ends by repainting the page, which is not what is under test.
    vm.runInContext('CampaignsPage.render = async () => {};', ctx);
    h.page = vm.runInContext('CampaignsPage', ctx);
    return h;
}

/** A coupon CSV as Udemy exports it: a header and one row per coupon, the course id first and its link tenth. */
const csv = (courses: { id: string; name: string; code: string; url: string }[]): string => [
    'id,name,type,redemptions,code,start,end,a,b,url',
    ...courses.map((c) => `${c.id},"${c.name}",free,3,${c.code},2026-01-01,2026-02-01,x,y,${c.url}`),
].join('\n');

const COURSES = [
    { id: '1', name: 'Twelve-week Plan: Strength', code: 'PLAN1', url: 'https://shop.example/plan?coupon=PLAN1' },
    { id: '2', name: 'Cooking For Beginners', code: 'COOK1', url: 'https://shop.example/cook?coupon=COOK1' },
];

/** What the server hands a tenant for the rows no seed names (`neutralCampaignFallback`, here in plain English). */
const FALLBACK = { dm_template: 'Hi {username}! 👋\nHere is the link for "{name}":\n🔗 {url}', public_reply_template: 'Sent to your DMs, {username}! 📩 | Check your messages, {username}! 🚀' };

const SEEDS = [
    { name_match: 'twelve-week', match: 'substring', trigger_keyword: 'plan, twelve weeks', dm_template: 'Hi {username}! Your plan: {url}', public_reply_template: 'Sent! | Check your DMs' },
    { name_match: 'cooking', match: 'word', trigger_keyword: 'cook', dm_template: 'Recipes here: {url}', public_reply_template: 'Sent' },
];

describe('choosing a CSV asks the API for the seeds and seeds each course from the first that matches', () => {
    it('asks once, and the rows carry the seed\'s keywords, its DM with the course\'s own link, and its replies', async () => {
        const h = load({ seeds: SEEDS, source: 'profile', fallback: FALLBACK });
        await h.choose();
        assert.equal(h.seedCalls, 1);
        assert.equal(h.modals, 1);
        const rows = h.rows();
        assert.equal(rows.length, 2);
        assert.deepEqual([rows[0]!.matched, rows[0]!.triggerKeywords, rows[0]!.dmTemplate, rows[0]!.publicReplies], [
            true, 'plan, twelve weeks', 'Hi {username}! Your plan: https://shop.example/plan?coupon=PLAN1', 'Sent! | Check your DMs',
        ]);
        assert.deepEqual([rows[1]!.matched, rows[1]!.triggerKeywords, rows[1]!.dmTemplate], [true, 'cook', 'Recipes here: https://shop.example/cook?coupon=COOK1']);
        assert.equal(h.toasts.length, 0);
    });

    it('a tenant with no seeds (an empty list) gets every row generated, as an unknown course always was', async () => {
        const h = load({ seeds: [], source: 'profile', fallback: FALLBACK });
        await h.choose();
        const rows = h.rows();
        assert.deepEqual(rows.map((r) => r.matched), [false, false]);
        assert.match(rows[1]!.dmTemplate, /"Cooking For Beginners"/, 'the generated fallback names the course');
        assert.equal(h.toasts.length, 0);
    });

    it('a seed with no name to match is skipped: an empty string would otherwise claim every course', async () => {
        const h = load({ seeds: [{ ...SEEDS[0]!, name_match: '' }, { ...SEEDS[0]!, name_match: '   ' }], source: 'profile' });
        await h.choose();
        assert.deepEqual(h.rows().map((r) => r.matched), [false, false]);
    });

    it('matches case-insensitively on both sides, and the first seed in order wins when two match', async () => {
        const h = load({ seeds: [{ ...SEEDS[0]!, name_match: 'TWELVE' }, { ...SEEDS[0]!, name_match: 'plan', trigger_keyword: 'second' }], source: 'profile' });
        await h.choose([COURSES[0]!]);
        assert.equal(h.rows()[0]!.triggerKeywords, 'plan, twelve weeks');
    });

    it('if the seeds cannot be read NOTHING is imported: an error toast, no modal, and no generic text stamped on curated courses', async () => {
        const h = load(new Error('Failed to read the campaign seeds.'));
        await h.choose();
        assert.equal(h.seedCalls, 1);
        assert.equal(h.modals, 0);
        assert.equal(h.page.pendingImport, null);
        assert.deepEqual(h.toasts, [{ message: 'campaigns.bulk.seedsFailed', kind: 'error' }]);
    });

    it('an answer with no list is no seeds, not a crash', async () => {
        const h = load({});
        await h.choose();
        assert.equal(h.modals, 1);
        assert.deepEqual(h.rows().map((r) => r.matched), [false, false]);
    });
});

describe('a course no seed names starts from the server\'s fallback (P15), and the page adds no words of its own', () => {
    const csvOf = (name: string, url = 'https://shop.example/x?coupon=X1') => [{ id: '9', name, code: 'X1', url }];

    it('puts the course\'s name (cut at the first «[», «|» or «-») and its link into the DM, and keeps {username} for the webhook', async () => {
        const h = load({ seeds: [], source: 'profile', fallback: FALLBACK });
        await h.choose(csvOf('Cooking For Beginners [in Arabic] - Part 1'));
        const row = h.rows()[0]!;
        assert.equal(row.matched, false);
        assert.equal(row.dmTemplate, 'Hi {username}! 👋\nHere is the link for "Cooking For Beginners":\n🔗 https://shop.example/x?coupon=X1');
        assert.equal(row.publicReplies, FALLBACK.public_reply_template);
        assert.equal(row.triggerKeywords, 'cooking, Cooking For Beginners', 'the keywords are the course\'s own words, as they always were');
    });

    it('fills {name} and {url} in one pass: a link that contains «{name}» is not read a second time', async () => {
        const h = load({ seeds: [], source: 'profile', fallback: FALLBACK });
        await h.choose(csvOf('Plan', 'https://shop.example/{name}?x=1'));
        assert.equal(h.rows()[0]!.dmTemplate, 'Hi {username}! 👋\nHere is the link for "Plan":\n🔗 https://shop.example/{name}?x=1');
    });

    it('the owner\'s fallback, handed to the page, writes his words, and the page itself holds none of them', async () => {
        const his = {
            dm_template: 'أهلاً بك {username}! 👋\nإليك رابط التسجيل المجاني لكورس "{name}":\n🔗 {url}\n\nسجل الآن قبل نفاد الكوبون! ✨',
            public_reply_template: 'تم إرسال الرابط والتفاصيل على الخاص يا {username}! 📩 | تفقد الخاص {username} للحصول على كوبون الدورة! 🚀',
        };
        const h = load({ seeds: [], source: 'legacy', fallback: his });
        await h.choose(csvOf('Cooking For Beginners'));
        assert.equal(h.rows()[0]!.dmTemplate, 'أهلاً بك {username}! 👋\nإليك رابط التسجيل المجاني لكورس "Cooking For Beginners":\n🔗 https://shop.example/x?coupon=X1\n\nسجل الآن قبل نفاد الكوبون! ✨');
        assert.equal(h.rows()[0]!.publicReplies, his.public_reply_template);
        const source = readFileSync('dashboard/js/pages/campaigns.js', 'utf8');
        for (const word of ['التسجيل المجاني', 'سجل الآن', 'للحصول على كوبون', 'تم إرسال الرابط']) assert.ok(!source.includes(word), `campaigns.js still holds «${word}»`);
    });

    it('with no fallback from the server (a stub, a bug) a row starts from the link alone: no words, so no one\'s language', async () => {
        const h = load({ seeds: [], source: 'profile' });
        await h.choose(csvOf('Cooking For Beginners'));
        assert.equal(h.rows()[0]!.dmTemplate, 'https://shop.example/x?coupon=X1');
        assert.equal(h.rows()[0]!.publicReplies, '');
        assert.equal(h.toasts.length, 0);
    });
});

describe('the campaigns the import creates', () => {
    it('a substring seed creates exactly what it always did: no match_mode on the body (the server\'s default is substring)', async () => {
        const h = load({ seeds: [SEEDS[0]!], source: 'profile', fallback: FALLBACK });
        await h.choose([COURSES[0]!]);
        assert.ok(!('matchMode' in h.rows()[0]!), 'the row carries no extra key');
        h.fillForm();
        await h.page.executeBulkImport();
        assert.deepEqual(h.created, [{
            trigger_keyword: 'plan, twelve weeks', dm_template: 'Hi {username}! Your plan: https://shop.example/plan?coupon=PLAN1',
            public_reply_template: 'Sent! | Check your DMs', post_id: null,
        }]);
    });

    it('a seed that asks for whole-word matching creates its campaign with match_mode "word"', async () => {
        const h = load({ seeds: SEEDS, source: 'profile', fallback: FALLBACK });
        await h.choose();
        assert.equal(h.rows()[1]!.matchMode, 'word');
        h.fillForm();
        await h.page.executeBulkImport();
        assert.equal(h.created.length, 2);
        assert.ok(!('match_mode' in h.created[0]!));
        assert.equal(h.created[1]!.match_mode, 'word');
    });

    it('a generated row never carries a match_mode', async () => {
        const h = load({ seeds: [], source: 'profile', fallback: FALLBACK });
        await h.choose();
        h.fillForm();
        await h.page.executeBulkImport();
        assert.equal(h.created.length, 2);
        for (const body of h.created) assert.ok(!('match_mode' in body));
    });
});

describe('the dashboard carries no tenant\'s mappings', () => {
    it('the page has no COURSE_MAPPINGS and none of the owner\'s course copy', () => {
        const h = load({ seeds: [], source: 'profile', fallback: FALLBACK });
        assert.equal(h.page.COURSE_MAPPINGS, undefined);
        const source = readFileSync('dashboard/js/pages/campaigns.js', 'utf8');
        for (const word of ['COURSE_MAPPINGS', 'جولانج', 'سويفت', 'ايجنتك', 'agentic ai', 'golang']) assert.ok(!source.includes(word), `campaigns.js still holds «${word}»`);
    });

    it('the API client has the route', () => {
        const api = readFileSync('dashboard/js/api.js', 'utf8');
        assert.match(api, /getCampaignSeeds: \(\) => API\.request\('\/profile\/campaign-seeds'\)/);
    });
});
