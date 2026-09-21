/**
 * These cases were previously in `scripts/test-enhancements.ts`, which re-implemented the
 * matcher rather than importing it — a green run proved only that the copy agreed with itself.
 * They now run against the real `matchCampaign`, which is what the webhook calls.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchCampaign, type CampaignMatchFields } from './matching.js';

interface Campaign extends CampaignMatchFields {
    id: string;
    trigger_keyword: string;
    post_id: string | null;
    is_active: boolean;
    created_at?: string;
}

const campaigns: Campaign[] = [
    { id: '1', trigger_keyword: 'أوبال', post_id: null, is_active: true },
    { id: '2', trigger_keyword: 'كورس', post_id: 'post_abc', is_active: true },
    { id: '3', trigger_keyword: 'تم', post_id: null, is_active: false },
    { id: '4', trigger_keyword: 'خصم, كوبون, مجاني', post_id: null, is_active: true },
];

describe('matchCampaign', () => {
    it('matches a global campaign on any post', () => {
        assert.equal(matchCampaign('أريد كورس أوبال', 'post_xyz', campaigns)?.id, '1');
    });

    it('matches through Arabic normalisation on both sides', () => {
        assert.equal(matchCampaign('اريد اوبال', 'post_xyz', campaigns)?.id, '1');
        assert.equal(matchCampaign('اريد اوبـــال', 'post_xyz', campaigns)?.id, '1');
    });

    it('matches a post-specific campaign only on its own post', () => {
        assert.equal(matchCampaign('اريد كورس', 'post_abc', campaigns)?.id, '2');
        assert.equal(matchCampaign('اريد كورس', 'post_other', campaigns), null);
    });

    it('ignores inactive campaigns', () => {
        assert.equal(matchCampaign('تم التسجيل', 'post_xyz', campaigns), null);
    });

    it('matches any keyword in a comma-separated list', () => {
        assert.equal(matchCampaign('هل هناك كوبون متاح؟', 'post_xyz', campaigns)?.id, '4');
        assert.equal(matchCampaign('ابي كود خصم', 'post_xyz', campaigns)?.id, '4');
        assert.equal(matchCampaign('ابيه مجاني', 'post_xyz', campaigns)?.id, '4');
    });

    it('prefers a post-specific campaign over a generic one, whatever the array order', () => {
        // Without the ordering, which campaign won depended on the order rows came back in —
        // and that could change after a VACUUM reordered the heap.
        const generic: Campaign = { id: 'generic', trigger_keyword: 'كورس', post_id: null, is_active: true };
        const specific: Campaign = { id: 'specific', trigger_keyword: 'كورس', post_id: 'post_abc', is_active: true };

        assert.equal(matchCampaign('اريد كورس', 'post_abc', [generic, specific])?.id, 'specific');
        assert.equal(matchCampaign('اريد كورس', 'post_abc', [specific, generic])?.id, 'specific');
    });

    it('falls back to the generic campaign on a post the specific one does not cover', () => {
        const generic: Campaign = { id: 'generic', trigger_keyword: 'كورس', post_id: null, is_active: true };
        const specific: Campaign = { id: 'specific', trigger_keyword: 'كورس', post_id: 'post_abc', is_active: true };

        assert.equal(matchCampaign('اريد كورس', 'post_zzz', [specific, generic])?.id, 'generic');
    });

    it('prefers the longer keyword when both match, whatever the array order', () => {
        const short: Campaign = { id: 'short', trigger_keyword: 'كورس', post_id: null, is_active: true };
        const long: Campaign = { id: 'long', trigger_keyword: 'كورس برمجة', post_id: null, is_active: true };

        assert.equal(matchCampaign('اريد كورس برمجة', 'p', [short, long])?.id, 'long');
        assert.equal(matchCampaign('اريد كورس برمجة', 'p', [long, short])?.id, 'long');
        assert.equal(matchCampaign('اريد كورس فقط', 'p', [long, short])?.id, 'short');
    });

    it('breaks a remaining tie on the newest campaign, whatever the array order', () => {
        const older: Campaign = {
            id: 'older', trigger_keyword: 'كورس', post_id: null, is_active: true,
            created_at: '2024-01-01T00:00:00Z',
        };
        const newer: Campaign = {
            id: 'newer', trigger_keyword: 'كورس', post_id: null, is_active: true,
            created_at: '2025-06-01T00:00:00Z',
        };

        assert.equal(matchCampaign('اريد كورس', 'p', [older, newer])?.id, 'newer');
        assert.equal(matchCampaign('اريد كورس', 'p', [newer, older])?.id, 'newer');
    });

    it('does not reorder the caller\'s array', () => {
        // The webhook passes a query result straight in; sorting it in place would change what
        // any later loop over the same rows sees.
        const input: Campaign[] = [
            { id: 'a', trigger_keyword: 'كورس', post_id: null, is_active: true },
            { id: 'b', trigger_keyword: 'كورس', post_id: 'post_abc', is_active: true },
        ];
        matchCampaign('اريد كورس', 'post_abc', input);
        assert.deepEqual(input.map((c) => c.id), ['a', 'b']);
    });

    it('matches nothing on empty or whitespace-only comment text', () => {
        assert.equal(matchCampaign('', 'post_abc', campaigns), null);
        assert.equal(matchCampaign('   ', 'post_abc', campaigns), null);
    });

    it('matches nothing when no campaigns are configured', () => {
        assert.equal(matchCampaign('اريد كورس', 'post_abc', []), null);
    });

    it('does not let a trailing comma in a keyword list match every comment', () => {
        // 'كورس,' splits into ['كورس', ''] and an empty keyword is a substring of everything.
        const sloppy: Campaign = { id: 'sloppy', trigger_keyword: 'كورس,', post_id: null, is_active: true };

        assert.equal(matchCampaign('تعليق لا علاقة له', 'p', [sloppy]), null);
        assert.equal(matchCampaign('اريد كورس', 'p', [sloppy])?.id, 'sloppy');
    });

    it('keeps substring matching, hazards and all', () => {
        // Documented and deliberate: changing it would silently stop live campaigns firing.
        const short: Campaign = { id: 'short', trigger_keyword: 'تم', post_id: null, is_active: true };
        assert.equal(matchCampaign('اهتمام كبير', 'p', [short])?.id, 'short');
        assert.equal(matchCampaign('تمام', 'p', [short])?.id, 'short');
    });

    it('fires on a keyword written in Arabic-Indic digits', () => {
        // Discount campaigns are routinely keyed on a number. If normalisation ever started
        // stripping U+0660–U+0669, this keyword would normalise to '', get dropped by the
        // .filter(Boolean), and the campaign would silently stop matching anything.
        const numeric: Campaign = {
            id: 'numeric', trigger_keyword: '٥٠', post_id: null, is_active: true,
        };

        assert.equal(matchCampaign('ابي خصم ٥٠', 'p', [numeric])?.id, 'numeric');
        assert.equal(matchCampaign('ابي خصم', 'p', [numeric]), null);
    });
});

/**
 * `match_mode` (migration v14). `keywordMatches` has supported `'word'` for a while, but no
 * campaign could reach it: the column did not exist, the API did not accept the field and this
 * function called the matcher with no mode at all. The dashboard warned that `تم` would misfire
 * on اهتمام and could not offer a fix.
 *
 * The test that matters most is the default. Every campaign that exists today has no explicit
 * mode, and if the absence read as `'word'` the live account's campaigns would quietly stop
 * firing on the comments they fire on now.
 */
describe('matchCampaign — match_mode', () => {
    const short = (mode?: string | null): Campaign & { match_mode?: string | null } => ({
        id: 'short', trigger_keyword: 'تم', post_id: null, is_active: true, match_mode: mode,
    });

    it("defaults to substring when the campaign has no mode", () => {
        for (const mode of [undefined, null]) {
            assert.equal(matchCampaign('اهتمام كبير', 'p', [short(mode)])?.id, 'short',
                `mode ${String(mode)} must keep matching as it does today`);
        }
    });

    it("stops the documented misfires once a campaign opts into 'word'", () => {
        // The whole point of the feature: اهتمام, تمام and يتم all contain تم as a substring.
        const campaign = short('word');
        assert.equal(matchCampaign('اهتمام كبير', 'p', [campaign]), null);
        assert.equal(matchCampaign('تمام', 'p', [campaign]), null);
        assert.equal(matchCampaign('يتم الرد', 'p', [campaign]), null);
    });

    it("still fires on the real keyword in 'word' mode", () => {
        const campaign = short('word');
        assert.equal(matchCampaign('تم التسجيل', 'p', [campaign])?.id, 'short');
        assert.equal(matchCampaign('تم', 'p', [campaign])?.id, 'short');
        assert.equal(matchCampaign('ابغى تم، شكرا', 'p', [campaign])?.id, 'short');
    });

    it('treats an unrecognised mode as substring rather than matching nothing', () => {
        // A hand-edited row, or a value from before the CHECK constraint existed. Refusing to
        // match would silently disable the campaign.
        assert.equal(matchCampaign('اهتمام', 'p', [short('exact')])?.id, 'short');
        assert.equal(matchCampaign('اهتمام', 'p', [short('WORD')])?.id, 'short');
    });

    it('applies each campaign its own mode when several compete', () => {
        // Ordering is by specificity, not by mode, so a word-mode campaign that does not match
        // must not shadow a substring-mode one that does.
        const wordMode: Campaign & { match_mode?: string } = {
            id: 'word', trigger_keyword: 'تم', post_id: 'p', is_active: true, match_mode: 'word',
        };
        const substringMode: Campaign & { match_mode?: string } = {
            id: 'substring', trigger_keyword: 'تم', post_id: null, is_active: true, match_mode: 'substring',
        };

        // The post-specific word-mode campaign is ranked first and declines اهتمام...
        assert.equal(matchCampaign('اهتمام', 'p', [wordMode, substringMode])?.id, 'substring');
        // ...and wins on a real word boundary.
        assert.equal(matchCampaign('تم التسجيل', 'p', [wordMode, substringMode])?.id, 'word');
    });

    it('applies the mode to every keyword in a comma-separated list', () => {
        const multi: Campaign & { match_mode?: string } = {
            id: 'multi', trigger_keyword: 'تم, خصم', post_id: null, is_active: true, match_mode: 'word',
        };
        assert.equal(matchCampaign('اهتمام واهتمامات', 'p', [multi]), null);
        assert.equal(matchCampaign('ابي خصم', 'p', [multi])?.id, 'multi');
    });
});
