/**
 * No owner markers in shared code (docs/onboarding/05 §3, P15): the repo-wide guard that the owner's data stays out of what every
 * tenant runs.
 *
 * Every tracked or new file under `src/` and `dashboard/js/` is read, and none may hold one of `OWNER_MARKERS` (his course, his name and
 * links, his stack, his reels' lines, the no-women rule, his time zone: the list of 05 §3, with «بالعربي» as a whole word) unless it is on
 * the allow-list below. The allow-list is the whole exception and is written to stay small:
 *
 *   - **an entry is a file and a reason**, and for a source file the markers it may hold. A file that grows another marker fails, and
 *     so does an entry that is no longer needed (its file is gone, or holds none of its markers any more), so the list can only shrink
 *     by being cleaned, never rot. A test file may hold any marker but one: it asserts on the owner's strings, which are its fixtures.
 *   - **`Clario` is never covered by "any marker".** It is named, file by file, or it fails; and it is not in `public/` or `dashboard/`
 *     at all, in any file, with no allow-list (DESIGN.md: never name it anywhere public).
 *   - **the goldens are the only directories**: two, byte-for-byte pins of the owner's prompts and of the control fed his turn.
 *
 * What a new tenant is written for is checked where it is built, not here: `neutralDefaults.test.ts` runs every builder of the prompt
 * surface for a brand-new tenant and none of them may say a marker. This test is about the source that holds them.
 *
 * A marker in code that a tenant's request can reach is an owner default, and is taken out (P8-P15 did: the Arabic persona, the
 * Gulf fallbacks, the examples, the call to action, the CSV import's fallback, the placeholders). What is allowed is one of three things:
 * the owner's own data in a module only he reads (his legacy assumptions, his offers, his mappings, his goldens and fixtures), a kit that
 * is said only to the creators it describes (the Gulf register, the tech domain, the course noun), or a word that is the product's
 * own vocabulary (the course library, `course_lessons`, an offer of kind `course`, the worker repo's name).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { OWNER_MARKERS, ownerMarkersIn } from './testSupport.js';

// ─── The allow-list ─────────────────────────────────────────────────────────────────────────

/** A file (or, for the two golden directories, a path prefix ending in "/"), the markers it may hold (all but Clario when left out), and why. */
interface Allowed {
    file: string;
    markers?: readonly string[];
    reason: string;
}

const REASON = {
    test: 'a test: it asserts on the owner\'s strings, which are its fixtures; tests are not shipped and are not a default any tenant receives',
    golden: 'the goldens: byte-for-byte pins of the prompts the owner is served (and, for the control, the same builders fed his turn); tests only',
    fixture: 'a test fixture (the owner\'s real configuration, the source of his goldens; or a site or captions the onboarding reader is tested on, which sell a course); production code never imports it',
    legacy: 'the owner\'s legacy assumptions: what a tenant with no readable profile is described as, which only the platform owner is (profileContextOrLegacy)',
    offers: 'the owner\'s own nine offers, written into his profile by scripts/seed-owner-offers.mts; read by that script and by tests, never by a tenant\'s request',
    mappings: 'the owner\'s own legacy campaign mappings and his CSV-import fallback, served to the platform owner alone (campaignSeeds.ts); pinned by his goldens',
    sql: 'a historical migration: an applied migration is never edited (its checksum is in the ledger), so the owner\'s seed and its comments stay as written',
    kit: 'a language kit: the Gulf register IS the owner\'s text word for word (pinned by __golden__/elamir), and the `course` noun and pitch are said only to a creator who sells a course',
    tech: 'the `tech` domain kit: the owner\'s tool examples, hashtags and reviewer, said only to a creator whose domain is tech (05 P10-P12)',
    preset: 'the no-women preset\'s canonical line: said only to a tenant that ticked the preset (assertNoOwnerMarkers\'s `except`), never by default',
    vocabulary: 'the product\'s own vocabulary: the course library (`course_lessons`, the Monteur\'s `course` source), an offer of kind `course`, and the worker repo\'s name (aicourse-captions)',
    comment: 'a comment, not text a tenant is given: it names the owner\'s example or his golden directory to explain the code beside it',
    operator: 'an operator default the platform owner set for his own deployment (05 §1: left alone)',
    docs: 'the in-app documentation: worked examples (an Arabic keyword, the course library, the worker\'s `courseRoot`), not a default any tenant receives',
    ui: 'a label of a course feature (the course library as the Monteur\'s source, the coupon-CSV import): its copy says course because the feature is one',
    scan: 'the definition of the rule: it lists every marker',
    conversation: 'a golden conversation of the DM evaluation (docs/DM_SALES_PLAN.md §11): what the owner\'s followers write, in their own word for his offer; read only by scripts/eval-dm-sales.mts and its tests, never by a tenant\'s request',
} as const;

const tests = (...files: string[]): Allowed[] => files.map((file) => ({ file, reason: REASON.test }));

const ALLOWED: readonly Allowed[] = [
    // ── The goldens: the only two directories ──
    { file: 'src/services/profile/__golden__/elamir/', reason: REASON.golden },
    { file: 'src/services/profile/__golden__/control-english/', reason: REASON.golden },

    // ── The owner's own data, in modules only he reads ──
    { file: 'src/services/profile/legacy.ts', markers: ['tech educator', 'Never a woman', 'course', 'كورس'], reason: REASON.legacy },
    { file: 'src/services/profile/ownerOffers.ts', markers: ['Agentic', 'course', 'Course', 'كورس', 'GO_TO_COURSE'], reason: REASON.offers },
    { file: 'src/services/profile/legacyCourseMappings.ts', markers: ['Agentic', 'Udemy', 'elamir', 'course', 'Course', 'كورس'], reason: REASON.mappings },
    { file: 'src/services/profile/campaignSeeds.ts', markers: ['Udemy', 'course', 'Course'], reason: 'comments about the owner\'s nine mappings and his Udemy courses, and the CSV import\'s "course name"; the code serves them to the platform owner alone' },
    { file: 'src/services/studio/testFixtures.ts', markers: ['Agentic', 'بالعربي', 'Udemy', 'udemy', 'referralCode', '02A626DDDA3FDAB6AB34', 'ElAmir', 'elamir', 'الأمير', 'منصور', 'MCP', 'ChatGPT', 'الذكاء_الاصطناعي', 'Asia/Riyadh', 'course', 'Course', 'كورس', 'الدردشة ماتت'], reason: REASON.fixture },
    { file: 'src/services/studio/exampleFixtures.ts', markers: ['Agentic', 'بالعربي', 'ChatGPT', 'الذكاء_الاصطناعي', 'course', 'كورس', 'Reference carousels', 'الدردشة ماتت', 'Stop asking AI'], reason: 'the owner\'s three reference carousels, as his row holds them (P14 moved them out of the writer): the source of his goldens; tests only' },
    { file: 'src/services/profile/promptSurface.ts', markers: ['elamir', 'course', 'كورس', 'الدردشة ماتت', 'Stop asking AI'], reason: 'the turn the goldens and the live parity check are fed (`SAY`: the owner\'s story and captions) and the name of the `elamir` golden set; production code never imports it' },
    { file: 'src/services/profile/golden.ts', markers: ['elamir'], reason: 'the golden helper: the `elamir` set is the owner\'s' },
    { file: 'src/services/profile/testSupport.ts', markers: [...OWNER_MARKERS], reason: REASON.scan },

    // ── Kits said only to the creators they describe ──
    { file: 'src/services/profile/kits.ts', markers: ['elamir', 'course', 'Course', 'كورس'], reason: REASON.kit },
    { file: 'src/services/monteur/copyKits.ts', markers: ['ChatGPT', 'الذكاء_الاصطناعي', 'course', 'كورس'], reason: REASON.tech },
    { file: 'src/services/monteur/editorKits.ts', markers: ['n8n', 'ChatGPT', 'course'], reason: REASON.tech },
    { file: 'src/services/studio/infographicSpec.ts', markers: ['senior engineer', 'goroutines', 'course'], reason: REASON.tech },
    { file: 'src/services/monteur/editor.ts', markers: ['Never a woman', 'course'], reason: REASON.preset },
    { file: 'src/services/studio/prompts.ts', markers: ['elamir', 'course', 'Reference carousels'], reason: 'the writer\'s `course` and `program` branches; "Reference carousels by another creator" is said only for examples a tenant marked as references (the owner\'s three)' },

    // ── The product's own vocabulary: the course library, the course offer kind ──
    { file: 'src/db/rows.ts', markers: ['course', 'Course'], reason: REASON.vocabulary },
    { file: 'src/services/ai.ts', markers: ['elamir', 'course', 'GO_TO_COURSE'], reason: 'the button id of a creator who sells courses (`GO_TO_COURSE_1`; anyone else gets `GO_TO_OFFER_1`, R2) and the kind test that picks it; comments name the golden' },
    { file: 'src/services/monteur/daily.ts', markers: ['course', 'Course'], reason: REASON.vocabulary },
    { file: 'src/services/monteur/results.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/monteur/view.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/settings.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/settingsTypes.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/drafts.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/jobs.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/lessons.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/worker.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/rules.ts', markers: ['course'], reason: REASON.vocabulary },
    { file: 'src/services/studio/generate.ts', markers: ['course'], reason: 'the draft schema of a creator who sells a course (the one the owner\'s golden pins), `course_lessons` columns, and the worker repo\'s name' },
    { file: 'src/services/studio/carouselTypes.ts', markers: ['Udemy', 'course', 'كورس'], reason: 'doc comments of the carousel schema, copied from aicourse-captions: the example captions and the TikTok slide\'s course line' },
    { file: 'src/services/profile/types.ts', markers: ['tech educator', 'course'], reason: 'OFFER_KINDS has `course` (an offer kind), and doc comments give the owner\'s role as the example of a role' },
    { file: 'src/services/profile/context.ts', markers: ['tech educator', 'course'], reason: 'doc comments and the offer-kind test (`course`): the context says what kind of offer a creator sells' },
    { file: 'src/services/profile/article.ts', markers: ['tech educator'], reason: REASON.comment },
    { file: 'src/services/appSettings.ts', markers: ['Udemy', 'elamir'], reason: 'the operator\'s contact email, and the Eid page\'s Udemy coupon setting: the platform\'s own page (05 §1: left alone)' },
    { file: 'src/config/schema_migration_v2.sql', markers: ['udemy', 'ElAmir', 'elamir', 'الأمير', 'منصور', 'كورس'], reason: REASON.sql },
    { file: 'src/config/migration_v21_studio.sql', markers: ['course'], reason: REASON.sql },
    { file: 'src/config/migration_v32_infographic_review.sql', markers: ['senior engineer'], reason: REASON.sql },

    // ── What the onboarding reader reads of a tenant's own site, and the fixtures it is tested on ──
    { file: 'src/services/onboarding/geo.ts', markers: ['Asia/Riyadh'], reason: 'one row of the country-to-time-zone table (Saudi Arabia\'s single zone, among forty countries): data about the world, not a default' },
    { file: 'src/services/onboarding/siteExtract.ts', markers: ['course', 'Course', 'كورس'], reason: 'reads a tenant\'s own site: schema.org `Course`, and the words (courses, الكورسات) that mark a page which lists offers' },
    { file: 'src/services/onboarding/draftSchema.ts', markers: ['course'], reason: 'the list of offer kinds the draft may choose from (`OFFER_KINDS` includes `course`)' },
    { file: 'src/services/onboarding/validateDraft.ts', markers: ['course'], reason: REASON.comment },
    { file: 'src/services/onboarding/fixtures/captions.ts', markers: ['كورس'], reason: REASON.fixture },
    { file: 'src/services/onboarding/fixtures/draftAnswers.ts', markers: ['كورس'], reason: REASON.fixture },
    { file: 'src/services/onboarding/fixtures/malformed-jsonld.html', markers: ['Course'], reason: REASON.fixture },
    { file: 'src/services/onboarding/fixtures/wordpress-faq.html', markers: ['course', 'Course'], reason: REASON.fixture },

    // ── The dashboard ──
    { file: 'dashboard/js/help-content.js', markers: ['course', 'Course', 'كورس'], reason: REASON.docs },
    { file: 'dashboard/js/i18n.ar.js', markers: ['course', 'Course', 'كورس'], reason: REASON.ui },
    { file: 'dashboard/js/i18n.en.js', markers: ['course', 'Course'], reason: REASON.ui },
    { file: 'dashboard/js/pages/campaigns.js', markers: ['course', 'Course', 'كورس'], reason: 'the coupon-CSV import\'s own vocabulary (a row of the CSV is a course), and «كورس» among the fifty common Arabic comment words the keyword-risk check demonstrates a false positive with' },
    { file: 'dashboard/js/pages/monteur.js', markers: ['course', 'Course'], reason: REASON.vocabulary },
    { file: 'dashboard/js/pages/tenant_profile.js', markers: ['course'], reason: 'the admin\'s profile editor: `course` is one of the eight offer kinds a creator can choose (OFFER_KINDS); it is a choice in a list, and never the default of a new offer (that is `product`)' },
    { file: 'dashboard/js/pages/studio.js', markers: ['Asia/Riyadh', 'course'], reason: 'Asia/Riyadh is one of nineteen zones offered when the browser cannot list its own; the Studio turns course lessons into carousels' },

    // ── The DM evaluation's golden conversations: a follower's message, as the owner's audience writes it ──
    ...['01-price-gulf', '02-beginner-egyptian', '09-refund-egyptian', '12-not-covered-egyptian', '15-multi-turn-gulf'].map((id): Allowed => (
        { file: `src/services/dmSales/__evals__/conversations/${id}.json`, markers: ['كورس'], reason: REASON.conversation }
    )),

    // ── Tests ──
    ...tests(
        'src/dashboard/campaign-seeds.test.ts',
        'src/dashboard/growth.test.ts',
        'src/dashboard/monteur.test.ts',
        'src/dashboard/screens.test.ts',
        'src/dashboard/wave2-settings.test.ts',
        'src/routes/aiSandbox.test.ts',
        'src/routes/profile.test.ts',
        'src/routes/studio.test.ts',
        'src/services/ai.test.ts',
        'src/services/dmSales/__evals__/cases.test.ts',
        'src/services/dmSales/__evals__/checks.test.ts',
        'src/services/dmSales/__evals__/dialect.test.ts',
        'src/services/dmSales/__evals__/judge.test.ts',
        'src/services/dmSales/__evals__/runner.test.ts',
        'src/services/growth/overview.test.ts',
        'src/services/growth/settings.test.ts',
        'src/services/growth/sync.test.ts',
        'src/services/landingLogos.test.ts',
        'src/services/matching.test.ts',
        'src/services/monteur/clips.test.ts',
        'src/services/monteur/copyKits.test.ts',
        'src/services/monteur/copyRules.test.ts',
        'src/services/monteur/daily.test.ts',
        'src/services/monteur/editor.test.ts',
        'src/services/monteur/editorKits.test.ts',
        'src/services/monteur/sweep.test.ts',
        'src/services/monteur/view.test.ts',
        'src/services/onboarding/draftFlow.test.ts',
        'src/services/onboarding/draftPrompt.test.ts',
        'src/services/onboarding/register.test.ts',
        'src/services/onboarding/siteExtract.test.ts',
        'src/services/onboarding/validateDraft.test.ts',
        'src/services/profile/article.test.ts',
        'src/services/profile/campaignSeeds.test.ts',
        'src/services/profile/completeness.test.ts',
        'src/services/profile/consumers.test.ts',
        'src/services/profile/context.test.ts',
        'src/services/profile/courseMappings.test.ts',
        'src/services/profile/dmComments.test.ts',
        'src/services/profile/golden.test.ts',
        'src/services/profile/goldenHelper.test.ts',
        'src/services/profile/kits.test.ts',
        'src/services/profile/legacy.test.ts',
        'src/services/profile/neutralDefaults.test.ts',
        'src/services/profile/ownerOffers.test.ts',
        'src/services/profile/parity.test.ts',
        'src/services/profile/patch.test.ts',
        'src/services/profile/promptSurface.test.ts',
        'src/services/profile/store.test.ts',
        'src/services/profile/validate.test.ts',
        'src/services/profile/views.test.ts',
        'src/services/profile/writers.test.ts',
        'src/services/publicPagesChrome.test.ts',
        'src/services/studio/drafts.test.ts',
        'src/services/studio/generate.test.ts',
        'src/services/studio/infographicPrompt.test.ts',
        'src/services/studio/infographics.test.ts',
        'src/services/studio/jobs.test.ts',
        'src/services/studio/monteurJobs.test.ts',
        'src/services/studio/rules.test.ts',
        'src/services/studio/settings.test.ts',
        'src/services/studio/slots.test.ts',
        'src/services/studio/writerPrompt.test.ts',
        'src/services/tiktok.test.ts',
        'src/utils/arabic.test.ts',
        'src/webhook/errors.test.ts',
        'src/webhook/messaging.test.ts',
        'src/webhook/meta-payload.test.ts',
        'src/webhook/router.test.ts',
    ),
    // The three tests that name Clario, each to say it is NOT somewhere (or to list it as a marker): the only files that may.
    { file: 'src/services/landingTruth.test.ts', markers: ['Clario', 'ElAmir'], reason: 'asserts the public pages never name Clario (DESIGN.md); a test' },
    { file: 'src/services/profile/defaults.test.ts', markers: ['Agentic', 'Clario', 'MCP', 'Udemy', 'course', 'elamir', 'referralCode', 'tech educator', 'الأمير', 'بالعربي', 'كورس', 'منصور'], reason: 'lists the owner\'s markers to prove the neutral profile holds none of them; a test' },
    { file: 'src/services/profile/ownerMarkerScan.test.ts', markers: [...OWNER_MARKERS], reason: 'this file: the allow-list names, file by file, the markers each may hold, and the scan\'s own tests use every one' },
];

// ─── The scan ───────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCOPE = ['src', 'dashboard/js'];
/** Tracked files, and new files not yet added: so a marker is caught before it is committed, not after. */
const filesUnder = (roots: readonly string[]): string[] =>
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...roots], { encoding: 'utf8', cwd: ROOT }).split('\n').filter(Boolean);

/** Text a human wrote: a file with a NUL byte is a picture or a video, and not scanned. */
function textOf(file: string): string | null {
    const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    return text.includes('\0') ? null : text;
}

interface Scanned { path: string; text: string }

const matches = (entry: Allowed, path: string): boolean => (entry.file.endsWith('/') ? path.startsWith(entry.file) : path === entry.file);
/** "Any marker" never covers Clario: it has to be named. */
const allows = (entry: Allowed, marker: string): boolean => (entry.markers === undefined ? marker !== 'Clario' : entry.markers.includes(marker));

/** What the scan says about `files` given `allowed`: the markers that are not allowed, and the entries that are not needed. */
function scan(files: readonly Scanned[], allowed: readonly Allowed[]): { violations: string[]; stale: string[] } {
    const violations: string[] = [];
    const used = new Map<Allowed, Set<string>>();
    for (const file of files) {
        const found = ownerMarkersIn(file.text);
        if (found.length === 0) continue;
        const entry = allowed.find((a) => matches(a, file.path));
        const refused = found.filter((marker) => !entry || !allows(entry, marker));
        if (refused.length > 0) violations.push(`${file.path}: ${refused.join(', ')}`);
        if (entry) used.set(entry, new Set([...(used.get(entry) ?? []), ...found]));
    }
    const stale: string[] = [];
    for (const entry of allowed) {
        const seen = used.get(entry);
        if (!seen) {
            stale.push(`${entry.file}: holds none of the markers (or is gone): delete the entry`);
            continue;
        }
        const unneeded = (entry.markers ?? []).filter((marker) => !seen.has(marker));
        // A directory entry has no marker list; a file entry lists exactly what it holds, so one it no longer holds is deleted from it.
        if (unneeded.length > 0 && !entry.file.endsWith('/')) stale.push(`${entry.file}: no longer holds ${unneeded.join(', ')}: take it off the entry`);
    }
    return { violations, stale };
}

describe('no owner markers in shared code', () => {
    const files: Scanned[] = filesUnder(SCOPE).flatMap((path) => {
        const text = textOf(path);
        return text === null ? [] : [{ path, text }];
    });
    const result = scan(files, ALLOWED);

    it('scans the whole of src/ and dashboard/js/', () => {
        assert.ok(files.length > 400, `${files.length} files were scanned`);
        for (const must of ['src/index.ts', 'src/services/ai.ts', 'src/services/studio/prompts.ts', 'dashboard/js/app.js', 'dashboard/js/pages/campaigns.js', 'src/services/profile/neutralDefaults.test.ts']) {
            assert.ok(files.some((f) => f.path === must), `${must} was scanned`);
        }
    });

    it('no file holds a marker that is not allowed it', () => {
        assert.deepEqual(result.violations, [], 'an owner marker in shared code is an owner default: take it out (or, if it is a kit, a fixture or the product\'s own word, allow the file with its reason)');
    });

    it('every allowance is still needed: a file that is clean, or gone, comes off the list', () => {
        assert.deepEqual(result.stale, []);
    });

    it('the list is small and says why: a reason for every entry, no file twice, no directory but the two golden ones', () => {
        const names = ALLOWED.map((a) => a.file);
        assert.equal(new Set(names).size, names.length, 'a file is on the list once');
        for (const entry of ALLOWED) assert.ok(entry.reason.trim().length >= 20, `${entry.file} says why`);
        assert.deepEqual(names.filter((n) => n.endsWith('/')), ['src/services/profile/__golden__/elamir/', 'src/services/profile/__golden__/control-english/']);
        for (const entry of ALLOWED) {
            if (entry.file.endsWith('/')) continue;
            assert.ok(files.some((f) => f.path === entry.file), `${entry.file} is a file in scope`);
            assert.ok(/^(src|dashboard\/js)\//.test(entry.file), `${entry.file} is under a scanned root`);
        }
    });

    it('a test may hold any marker but Clario; a source file holds exactly the markers it lists', () => {
        const source = ALLOWED.filter((a) => !a.file.endsWith('/') && a.reason !== REASON.test);
        for (const entry of source) assert.ok(entry.markers && entry.markers.length > 0, `${entry.file} lists its markers`);
        const testEntries = ALLOWED.filter((a) => a.reason === REASON.test);
        assert.ok(testEntries.length > 40);
        for (const entry of testEntries) assert.ok(/\.test\.ts$/.test(entry.file) && entry.markers === undefined, `${entry.file} is a test`);
    });
});

describe('Clario is nowhere public', () => {
    // DESIGN.md: "No Clario. Never name Clario or ClarioDR anywhere public." Every text file of public/ and dashboard/, no allow-list.
    const TEXT = /\.(html|js|mjs|css|json|svg|txt|md|xml|webmanifest|map)$/i;
    const publicFiles = filesUnder(['public', 'dashboard']).filter((path) => TEXT.test(path));

    it('is in no file under public/ or dashboard/, in any case', () => {
        assert.ok(publicFiles.length > 40, `${publicFiles.length} files`);
        assert.ok(publicFiles.some((f) => f === 'public/landing.html') && publicFiles.some((f) => f === 'dashboard/index.html'), 'the landing page and the dashboard shell are scanned');
        const named = publicFiles.filter((path) => /clario/i.test(textOf(path) ?? ''));
        assert.deepEqual(named, []);
    });

    it('is in no public page by the marker scan either: public/*.html, case-insensitively', () => {
        const pages = publicFiles.filter((f) => /^public\/[^/]+\.html$/.test(f));
        assert.ok(pages.length >= 6, `${pages.length} public pages`);
        for (const page of pages) assert.ok(!/clario/i.test(textOf(page) ?? ''), page);
    });

    it('is named in src/ only by the files that say it is not somewhere or list it as a marker, each by name', () => {
        const namers = filesUnder(['src']).filter((path) => /clario/i.test(textOf(path) ?? ''));
        assert.deepEqual(namers.sort(), [
            'src/services/landingTruth.test.ts', 'src/services/profile/defaults.test.ts', 'src/services/profile/ownerMarkerScan.test.ts', 'src/services/profile/testSupport.ts',
        ]);
        for (const path of namers) {
            const entry = ALLOWED.find((a) => matches(a, path));
            assert.ok(entry?.markers?.includes('Clario'), `${path} names Clario on its allow-list entry`);
        }
    });
});

describe('the scan itself', () => {
    const allowed: Allowed[] = [
        { file: 'src/a.ts', markers: ['course'], reason: 'a reason that is long enough to be one' },
        { file: 'src/tests/b.test.ts', reason: 'a reason that is long enough to be one' },
        { file: 'src/gold/', reason: 'a directory of goldens, long enough' },
    ];

    it('a marker in a file that is not allowed fails, naming the file and the marker', () => {
        const out = scan([{ path: 'src/c.ts', text: 'const x = "Udemy";' }], allowed);
        assert.deepEqual(out.violations, ['src/c.ts: Udemy']);
    });

    it('a file with a marker it lists passes; with another marker it fails, and says which', () => {
        assert.deepEqual(scan([{ path: 'src/a.ts', text: 'course' }, { path: 'src/tests/b.test.ts', text: 'x' }, { path: 'src/gold/x.txt', text: 'x' }], allowed).violations, []);
        const out = scan([{ path: 'src/a.ts', text: 'a course taught by elamir' }], allowed);
        assert.deepEqual(out.violations, ['src/a.ts: elamir']);
    });

    it('"any marker" never covers Clario, in a test or in a golden', () => {
        assert.deepEqual(scan([{ path: 'src/tests/b.test.ts', text: 'Udemy and course' }, { path: 'src/gold/x.txt', text: 'Udemy' }], allowed).violations, []);
        assert.deepEqual(scan([{ path: 'src/tests/b.test.ts', text: 'Clario' }], allowed).violations, ['src/tests/b.test.ts: Clario']);
        assert.deepEqual(scan([{ path: 'src/gold/x.txt', text: 'Clario' }], allowed).violations, ['src/gold/x.txt: Clario']);
    });

    it('an entry that is no longer needed is stale: its file is clean, gone, or no longer holds a marker it lists', () => {
        assert.deepEqual(scan([{ path: 'src/a.ts', text: 'clean' }, { path: 'src/tests/b.test.ts', text: 'Udemy' }, { path: 'src/gold/x.txt', text: 'Udemy' }], allowed).stale.length, 1);
        const stale = scan([{ path: 'src/tests/b.test.ts', text: 'Udemy' }, { path: 'src/gold/x.txt', text: 'Udemy' }], allowed).stale;
        assert.deepEqual(stale, ['src/a.ts: holds none of the markers (or is gone): delete the entry']);
        const narrower = scan([{ path: 'src/a.ts', text: 'a course' }, { path: 'src/tests/b.test.ts', text: 'Udemy' }, { path: 'src/gold/x.txt', text: 'Udemy' }], [{ ...allowed[0]!, markers: ['course', 'Udemy'] }, allowed[1]!, allowed[2]!]).stale;
        assert.deepEqual(narrower, ['src/a.ts: no longer holds Udemy: take it off the entry']);
    });

    it('«بالعربي» is a marker as a whole word, with or without a leading «و», and not inside «بالعربية»', () => {
        assert.deepEqual(scan([{ path: 'src/c.ts', text: 'Agentic AI بالعربي' }], []).violations, ['src/c.ts: Agentic, بالعربي']);
        assert.deepEqual(scan([{ path: 'src/c.ts', text: 'وبالعربي' }], []).violations, ['src/c.ts: بالعربي']);
        assert.deepEqual(scan([{ path: 'src/c.ts', text: 'اكتب بالعربية الفصحى' }], []).violations, []);
    });

    it('the scan sees every marker of 05 §3, and a clean file says none', () => {
        for (const marker of OWNER_MARKERS) assert.deepEqual(scan([{ path: 'src/c.ts', text: `x ${marker} y` }], []).violations, [`src/c.ts: ${marker}`], marker);
        assert.deepEqual(scan([{ path: 'src/c.ts', text: 'a neutral file about a candle shop' }], []).violations, []);
    });
});
