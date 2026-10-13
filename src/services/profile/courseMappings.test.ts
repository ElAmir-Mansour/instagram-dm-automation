/**
 * The owner's nine `COURSE_MAPPINGS` as the `campaign` of his offers (01 §1, 05 P13): each becomes one offer's
 * campaign and comes back as the same mapping, byte for byte, and the bulk import's rule (the first key in order
 * that the course name contains) picks the same one.
 *
 * The nine are the table the dashboard carried until P13 (now `legacyCourseMappings.ts`, pinned by the golden). This file builds the
 * offers its own way (`toCampaign`, an independent reading of the two separators), so that the ones `planOwnerOffers` makes for
 * the seed script (ownerOffers.test.ts) are held against a second author. The page is the REAL shipped file, run in a bare
 * context (testSupport.ts), handed the seeds `campaignSeeds` makes from those offers, so a tenth mapping, a changed separator
 * or a reordered key fails here and not in the owner's next import.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { campaignSeeds } from './campaignSeeds.js';
import { profileFromLegacy } from './legacy.js';
import { LEGACY_COURSE_MAPPINGS } from './legacyCourseMappings.js';
import { inside, loadCampaignsPage } from './testSupport.js';
import type { CreatorProfile, Offer, OfferCampaign } from './types.js';
import { validateProfile } from './validate.js';

type Mapping = { triggerKeywords: string; dmTemplate: string; publicReplies: string };

/** What `campaignSeeds` (P13) reads, in one direction: a mapping becomes an offer's campaign. The separators are the documented ones. */
const toCampaign = (key: string, m: Mapping): OfferCampaign => ({
    name_match: key,
    match: 'substring',
    keywords: m.triggerKeywords.split(', '),
    dm_template: m.dmTemplate,
    public_replies: m.publicReplies.split(' | '),
});

/** And back: the key, and the mapping with its two joined fields. */
const toMapping = (c: OfferCampaign): [string, Mapping] => [
    c.name_match,
    { triggerKeywords: c.keywords.join(', '), dmTemplate: c.dm_template, publicReplies: c.public_replies.join(' | ') },
];

const page = loadCampaignsPage();
// A plain, mutable copy: the constant is frozen, and its key order is the point.
const MAPPINGS: Record<string, Mapping> = JSON.parse(JSON.stringify(LEGACY_COURSE_MAPPINGS));
const ENTRIES = Object.entries(MAPPINGS);

/** The owner with nine courses: the Agentic AI course is his primary offer, the others follow in the mappings' order. */
function ownerWithNineCourses(): CreatorProfile {
    const p = profileFromLegacy(ELAMIR_SEED_SETTINGS);
    p.offers = ENTRIES.map(([key, m], i): Offer => ({
        id: `course-${i + 1}`, kind: 'course', name: key, order_via: 'url', url: `https://www.udemy.com/course/course-${i + 1}/`, price: '',
        facts: [], bullets: [], keyword: '', primary: i === 0, campaign: toCampaign(key, m),
    }));
    return p;
}

describe('the owner\'s nine COURSE_MAPPINGS as offers[].campaign', () => {
    it('are nine, and the shipped page carries none: it asks the API for them', () => {
        assert.equal(inside(page, 'typeof CampaignsPage.COURSE_MAPPINGS'), 'undefined');
        assert.equal(ENTRIES.length, 9);
        assert.deepStrictEqual(Object.keys(MAPPINGS), ['agentic ai', 'golang', 'swift', 'css3', 'html5', 'problem solving', 'java', 'python', 'c#']);
    });

    it('every entry round-trips through an offer\'s campaign and back: same key, same order, same bytes', () => {
        const offers = ENTRIES.map(([key, m]) => toCampaign(key, m));
        const back = Object.fromEntries(offers.map(toMapping));
        assert.deepStrictEqual(back, MAPPINGS);
        assert.equal(JSON.stringify(back), JSON.stringify(MAPPINGS), 'key order included');
        for (const [key, m] of ENTRIES) {
            const [k, again] = toMapping(toCampaign(key, m));
            assert.equal(k, key);
            for (const field of ['triggerKeywords', 'dmTemplate', 'publicReplies'] as const) {
                assert.ok(Buffer.from(again[field], 'utf8').equals(Buffer.from(m[field], 'utf8')), `${key}.${field} is the same bytes`);
            }
        }
    });

    it('survives the separators: no keyword holds ", " or a stray space, and no reply holds " | "', () => {
        for (const [key, m] of ENTRIES) {
            const c = toCampaign(key, m);
            assert.ok(c.keywords.length >= 2, `${key} has keywords`);
            for (const k of c.keywords) {
                assert.ok(k.length > 0 && k === k.trim(), `${key}: «${k}» is a whole keyword`);
                assert.ok(!k.includes(','), `${key}: «${k}» has no comma of its own`);
            }
            assert.ok(c.public_replies.length >= 2, `${key} has replies`);
            for (const r of c.public_replies) assert.ok(r.length > 0 && r === r.trim() && !r.includes(' | '), `${key}: a reply is whole`);
            assert.ok(c.dm_template.includes('{url}') && c.dm_template.includes('{username}'), `${key}: the DM keeps its placeholders`);
        }
    });

    it('holds the lower-case keys the import matches against a lower-cased course name, and the mode it creates campaigns with', () => {
        for (const [key] of ENTRIES) assert.equal(key, key.toLowerCase(), key);
        // The bulk import never sends a match_mode, so the campaigns it creates are substring ones.
        assert.ok(ENTRIES.every(([key, m]) => toCampaign(key, m).match === 'substring'));
    });

    it('make a valid profile of nine offers, one of them primary, each with its campaign', () => {
        const p = ownerWithNineCourses();
        const out = validateProfile(p);
        assert.ok('profile' in out, 'problems' in out ? out.problems.join('; ') : '');
        assert.equal(p.offers.filter((o) => o.primary).length, 1);
        assert.deepStrictEqual(p.offers.map((o) => o.campaign!.name_match), Object.keys(MAPPINGS), 'the offers are in the order of the keys, which is the order the import tries them');
    });

    it('are matched the way the bulk import matches them: the first key, in order, that the lower-cased course name contains', () => {
        const offers = ownerWithNineCourses().offers;
        const course = (id: number, name: string) => ({ id, name, url: `https://www.udemy.com/course/golden-${id}/?couponCode=GOLDEN${id}`, code: `GOLDEN${id}`, redemptions: id * 7 });
        const names = [
            'Agentic AI: الدليل العملي لبناء ما تحتاجه بالذكاء الاصطناعي', 'GoLang Course: Learn Go in Arabic', 'Swift Programming Language | in Arabic',
            'CSS3 For Beginners [In Arabic]', 'HTML5 For Beginners [In Arabic]',
            // Contains two keys, 'problem solving' and 'c#': the first in the order wins.
            'Problem Solving - with C# [in Arabic]',
            'Java for Beginners [in Arabic]', 'Python For Beginners [in Arabic]', 'C# For Beginners [in Arabic]', 'Rust Systems Programming [in Arabic] - Part 1',
        ];
        const courses = names.map((name, i) => course(i + 1, name));
        // What the API answers for these offers, and what the page does with it.
        const seeds = campaignSeeds({ offers });
        assert.equal(seeds.length, 9);
        const shipped = inside(page, `(CampaignsPage.showBulkImportModal(${JSON.stringify(courses)}, ${JSON.stringify(seeds)}), CampaignsPage.pendingImport)`) as {
            triggerKeywords: string; dmTemplate: string; publicReplies: string; matched: boolean;
        }[];
        assert.equal(shipped.length, 10);

        courses.forEach((c, i) => {
            const lower = c.name.toLowerCase();
            const offer = offers.find((o) => lower.includes(o.campaign!.name_match));
            const row = shipped[i]!;
            assert.equal(Boolean(offer), row.matched, `${c.name}: matched`);
            if (!offer) return;
            const [, mapping] = toMapping(offer.campaign!);
            assert.equal(mapping.triggerKeywords, row.triggerKeywords, `${c.name}: trigger keywords`);
            assert.equal(mapping.dmTemplate.replace(/{url}/g, c.url), row.dmTemplate, `${c.name}: the DM, with the course's link in place of {url}`);
            assert.equal(mapping.publicReplies, row.publicReplies, `${c.name}: public replies`);
        });
        assert.equal(shipped[5]!.triggerKeywords, MAPPINGS['problem solving']!.triggerKeywords, 'the two-key name took the first key\'s mapping');
        assert.equal(shipped[9]!.matched, false);
    });
});
