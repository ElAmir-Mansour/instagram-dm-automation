import { normalizeArabic } from '../src/utils/arabic.js';

// Simple assertions for testing
function assert(condition: boolean, message: string) {
    if (!condition) {
        console.error(`❌ FAILURE: ${message}`);
        process.exit(1);
    }
    console.log(`✅ SUCCESS: ${message}`);
}

console.log('🧪 Starting validation tests for enhancements...\n');

// ─── 1. Test Arabic Normalization ───────────────────────────────────────────
console.log('--- 1. Testing Arabic Normalization ---');

assert(normalizeArabic('أوبال') === 'اوبال', 'Should normalize Hamza on Alef ("أ" -> "ا")');
assert(normalizeArabic('إيلاف') === 'ايلاف', 'Should normalize Hamza under Alef ("إ" -> "ا")');
assert(normalizeArabic('آية') === 'ايه', 'Should normalize Alef Madda and Teh Marbuta ("آ" -> "ا", "ة" -> "ه")');
assert(normalizeArabic('علي') === 'علي', 'Should keep standard Yeh ("ي")');
assert(normalizeArabic('على') === 'علي', 'Should normalize Alef Maksura to Yeh ("ى" -> "ي")');
assert(normalizeArabic('تَمَّ') === 'تم', 'Should strip diacritics / tashkeel');
assert(normalizeArabic('  كورس  برمجة  ') === 'كورس برمجه', 'Should trim and collapse multiple spaces');

// ─── 2. Test Campaign Matching Logic ─────────────────────────────────────────
console.log('\n--- 2. Testing Campaign Matching Logic ---');

interface Campaign {
    id: string;
    trigger_keyword: string;
    post_id: string | null;
    is_active: boolean;
}

const mockCampaigns: Campaign[] = [
    { id: '1', trigger_keyword: 'أوبال', post_id: null, is_active: true }, // active, global
    { id: '2', trigger_keyword: 'كورس', post_id: 'post_abc', is_active: true }, // active, post-specific
    { id: '3', trigger_keyword: 'تم', post_id: null, is_active: false }, // inactive campaign
];

function findCampaign(text: string, postId: string, campaigns: Campaign[]): Campaign | undefined {
    const normalizedCommentText = normalizeArabic(text);

    return campaigns.find((c: any) => {
        if (c.is_active === false) return false;
        
        const normalizedKeyword = normalizeArabic(c.trigger_keyword);
        const keywordMatches = normalizedCommentText.includes(normalizedKeyword);
        const postIdMatches = !c.post_id || c.post_id === postId;
        
        return keywordMatches && postIdMatches;
    });
}

// Case A: Global campaign matches keyword regardless of post ID
assert(
    findCampaign('أريد كورس أوبال', 'post_xyz', mockCampaigns)?.id === '1',
    'Should match active global campaign "أوبال" on any post ID'
);
assert(
    findCampaign('اريد اوبال', 'post_xyz', mockCampaigns)?.id === '1',
    'Should match "اوبال" due to Arabic normalization'
);

// Case B: Post-specific campaign only matches matching post ID
assert(
    findCampaign('اريد كورس', 'post_abc', mockCampaigns)?.id === '2',
    'Should match active campaign "كورس" when post ID aligns'
);
assert(
    findCampaign('اريد كورس', 'post_other', mockCampaigns) === undefined,
    'Should NOT match campaign "كورس" when post ID does not align'
);

// Case C: Inactive campaign is ignored
assert(
    findCampaign('تم التسجيل', 'post_xyz', mockCampaigns) === undefined,
    'Should NOT match inactive campaign "تم" even if keyword is present'
);

console.log('\n🎉 All local assertions passed successfully!');
