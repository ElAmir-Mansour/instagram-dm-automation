/**
 * The failure translator (QA-05, QA-06, QA-08, QA-13, QA-17; DW-S5, CP-S5): `UI.failure` and its parts.
 *
 * The REAL components.js and both catalogues in a `node:vm` context. Every text below is one production held on 2026-11-28 (studio_jobs,
 * monteur_sources, scheduled_posts, interactions, ads_proposals) or one the server writes (`pickRoute`):
 *
 *   - each known text becomes its `failure.<CODE>` sentence and next step, in Arabic and English, and the sentence never holds the raw text;
 *   - the raw text is behind "Details", ESCAPED, and a server code the catalogue knows keeps `errors.<CODE>`;
 *   - an unknown text is the generic sentence in both languages, never the server's English as the main line;
 *   - a date says WHEN (QA-06), and an old one says it may be fixed;
 *   - every code in the table has a sentence and a next step in both catalogues, and the Arabic sentence is Arabic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard } from './_harness.js';

const ARABIC = /[؀-ۿ]/;

/** [the text production holds, the code it is]. */
const LIVE: Array<[string, string]> = [
    ['Private Reply Failed [me]: (#-1) The comment you are trying to reply to, already has a reply. (Code: -1) Replied publicly with the link instead.', 'META'],
    ['Private Reply Failed: Error validating access token: Session has expired on Monday, 18-May-26 04:00:00 PDT. The current time is Tuesday, 19-May-26 00:28:33 PDT. (Code: 190)', 'META_TOKEN_EXPIRED'],
    ['Public Reply Failed: (#200) The permission(s) pages_read_user_content,pages_manage_engagement are not available. It could because either they are deprecated or need to be approved by App Review. (Code: 200)', 'META'],
    ['Private Reply Failed [N]: Invalid thing nobody listed (Code: 2207)', 'META_GENERIC'],
    ['TikTok post init: Until TikTok approves this app, direct posts only work when your TikTok account is set to private. Switch the account to private (TikTok → Settings → Privacy), then retry.', 'TIKTOK_PRIVATE_ONLY'],
    ['Held: waiting for TikTok to approve the app (2026-11-12).', 'TIKTOK_HELD_APPROVAL'],
    ['Replaced: the reel is being remade with Claude.', 'REPLACED_ON_PURPOSE'],
    ['whisper.cpp timed out after 17 min on 40 chunks', 'TRANSCRIBE_TIMEOUT'],
    ['whisper.cpp made no transcription of 39 of 40 chunks (exit 0): whisper_print_timings:    total time = 1071320.12 ms | ggml_metal_free: deallocating', 'TRANSCRIBE_EMPTY'],
    ['claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed', 'MAC_SIGNED_OUT'],
    ['Claude on the Mac could not draft it: claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed', 'MAC_SIGNED_OUT'],
    ['claude answered with an error: You\'ve hit your weekly limit · resets 11am (Africa/Cairo)', 'CLAUDE_LIMIT'],
    ['No answer within 20 minutes: the Mac may be asleep, or its Studio worker stopped.', 'MAC_NO_ANSWER'],
    ['Claude on the Mac didn\'t answer: No answer within 20 minutes: the Mac may be asleep, or its Studio worker stopped.', 'MAC_NO_ANSWER'],
    ['claude didn\'t answer within 12 min', 'CLAUDE_TIMEOUT'],
    ['Gemini generateContent: HTTP 429 You exceeded your current quota, please check your plan and billing details.', 'GEMINI_QUOTA'],
    ['Gemini generateContent: HTTP 503 This model is currently experiencing high demand. Spikes in demand are usually temporary.', 'GEMINI_BUSY'],
    ['Writing the carousel failed: Gemini request failed [HTTP 404]: This model models/gemini-2.5-pro is no longer available to new users.', 'GEMINI_MODEL_GONE'],
    ['Writing the carousel failed: Gemini request failed [HTTP 400]: Request contains an invalid argument.', 'AI_REQUEST_REFUSED'],
    ['The model rated all 1 moment(s) it proposed below the bar (hook or standalone ≤ 1, or rank under 9).', 'NO_STRONG_MOMENT'],
    ['clip 1: L42–L50 would cut mid-sentence (no pause or punctuation within 2 s of its edge)', 'CLIP_CUT_MID_SENTENCE'],
    ['Uploaded to YouTube as private: YouTube keeps uploads from this app private until it passes the YouTube API audit (Settings → YouTube).', 'YOUTUBE_PRIVATE_UPLOAD'],
    ['Uploaded to YouTube as unlisted. Visibility check 2026-11-27: YouTube now shows this Short as unlisted — make it public in YouTube Studio.', 'YOUTUBE_NOT_PUBLIC'],
    ['Thumbnail not set: YouTube thumbnail: The thumbnail can\'t be set for the specified video. The request might not be properly authorized.', 'YOUTUBE_THUMBNAIL'],
    ['storage answered HTTP 400 to the upload: {"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"}', 'STORAGE_FILE_TOO_LARGE'],
    ['ENOSPC: no space left on device, write', 'MAC_DISK_FULL'],
    ['The render hung after Chrome lost its page (the Mac was out of memory). The worker was restarted with fewer tabs.', 'MAC_OUT_OF_MEMORY'],
    ['Gemini generateContent: HTTP 500 Internal error encountered.', 'GEMINI_BUSY'],
    // QA-08: what `pickRoute` writes (route.ts), one per branch.
    ['The route for dm uses Meta, which has no API key. Fix the key or choose another provider for this purpose.', 'AI_ROUTE_PROVIDER_PROBLEM'],
    ['The route for dm uses Baseten. Baseten may answer only reel_index: it watches the owner\'s own published reels, and no message, comment or follower data goes to it. Choose another provider.', 'AI_ROUTE_NOT_ALLOWED'],
    ['The route for dm_whatsapp (taken from the dm route) uses Groq, which is not on the list of providers that may answer this purpose (Meta, Baseten). Choose one of them.', 'AI_ROUTE_NOT_ALLOWED'],
    ['The route for dm uses Meta, which has no model: name one on the route or set the provider\'s default model.', 'AI_ROUTE_NO_MODEL'],
    ['The route for dm uses muse-spark-contributor, a Contributor-mode model: Meta may train on what it is sent, so no purpose may use it. Choose the Standard model instead.', 'AI_ROUTE_CONTRIBUTOR'],
    ['No AI provider is ready: save an API key for one in Operations → AI providers.', 'AI_NO_PROVIDER_READY'],
];

/** Texts that must NOT be taken for a known failure (a script about OAuth that failed is not the Mac signed out). */
const UNKNOWN = [
    'ffprobe could not read the file',
    'Remotion could not find the composition',
    'The OAuth redirect URI did not match the one registered',
    'Unsupported post request. Object with ID \'me\' does not exist',
];

const sentenceOf = (markup: unknown): string => /<strong class="error-sentence"[^>]*>([\s\S]*?)<\/strong>/.exec(String(markup))?.[1]?.trim() ?? '';
const detailsOf = (markup: unknown): string => /<p class="error-details-text"[^>]*>([\s\S]*?)<\/p>/.exec(String(markup))?.[1] ?? '';

describe('every text production holds is named, in both languages', () => {
    for (const lang of ['en', 'ar'] as const) {
        for (const [raw, code] of LIVE) {
            it(`${lang}: ${code}: ${raw.slice(0, 48)}…`, () => {
                const { UI, t } = loadDashboard({ lang });
                const parts = UI.failureParts(raw);
                assert.equal(parts.code, code);
                assert.equal(parts.translated, true);
                assert.doesNotMatch(parts.sentence, /whisper|OAuth|Failed to authenticate|\(#|Code:|HTTP|statusCode|private reply failed/i, 'the raw text is never the sentence');
                if (lang === 'ar') assert.match(parts.sentence, ARABIC);
                else assert.doesNotMatch(parts.sentence, ARABIC);
                if (code !== 'META' && code !== 'STORAGE_FILE_TOO_LARGE') {
                    const space = t(`failure.${code}`) !== `failure.${code}` ? 'failure' : 'errors';
                    assert.equal(parts.sentence, t(`${space}.${code}`));
                }
                // The raw text is kept, behind Details.
                const markup = String(UI.failure(raw));
                assert.match(markup, /<details class="error-details">/);
                assert.ok(detailsOf(markup).length > 0, 'Details holds the raw text');
            });
        }
    }

    it('the sentence of a named failure is the catalogue\'s, with its one next step', () => {
        const { UI, t } = loadDashboard();
        const markup = String(UI.failure(LIVE[4]![0]));
        assert.equal(sentenceOf(markup), t('failure.TIKTOK_PRIVATE_ONLY'));
        assert.match(markup, /<span class="error-next"[^>]*>Make the TikTok account private, or send the post as an inbox draft\.<\/span>/);
        assert.match(markup, /data-failure="TIKTOK_PRIVATE_ONLY"/);
    });

    it('the Meta (#-1) "already has a reply" text is the Log\'s existing sentence, not a generic Meta refusal', () => {
        const { UI, t } = loadDashboard();
        assert.equal(UI.failureParts(LIVE[0]![0]).sentence, t('activity.err.alreadyReplied'));
        assert.equal(UI.failureParts(LIVE[2]![0]).sentence, t('activity.err.permission'));
    });
});

describe('an unknown text is the generic sentence, never the server\'s English as the main line', () => {
    for (const lang of ['en', 'ar'] as const) {
        for (const raw of UNKNOWN) {
            it(`${lang}: ${raw.slice(0, 40)}`, () => {
                const { UI, t } = loadDashboard({ lang });
                const parts = UI.failureParts(raw);
                assert.equal(parts.code, '');
                assert.equal(parts.translated, false);
                assert.equal(parts.sentence, t('failure.generic'));
                const markup = String(UI.failure(raw));
                assert.equal(sentenceOf(markup), t('failure.generic').replace(/&/g, '&amp;'));
                assert.ok(!sentenceOf(markup).includes(raw.slice(0, 10)), 'the raw text is not the main line');
                assert.ok(detailsOf(markup).includes(raw.slice(0, 20).replace(/'/g, '&#39;')), 'it is behind Details');
            });
        }
    }

    it('an empty or missing text is still a sentence, with no Details', () => {
        const { UI, t } = loadDashboard();
        for (const none of ['', '   ', null, undefined, {}, { message: '' }]) {
            const markup = String(UI.failure(none));
            assert.equal(sentenceOf(markup), t('failure.generic').replace(/&/g, '&amp;'));
            assert.doesNotMatch(markup, /<details/);
        }
    });

    it('a server code this catalogue knows keeps errors.<CODE>; one it does not know goes behind Details with its status', () => {
        const { UI, t } = loadDashboard();
        assert.equal(UI.failureParts({ code: 'META_NOT_CONNECTED', message: 'English' }).sentence, t('errors.META_NOT_CONNECTED'));
        const unknown = UI.failureParts({ code: 'WHO_KNOWS', status: 409, message: 'Nope, said the server.' });
        assert.equal(unknown.sentence, t('failure.generic'));
        assert.match(unknown.details, /Nope, said the server\./);
        assert.match(unknown.details, /WHO_KNOWS \(HTTP 409\)/);
        // A `failure.*` code (the translator's own) works as a code too, through errorText.
        assert.equal(UI.errorText({ code: 'MAC_SIGNED_OUT', message: 'x' }).sentence, t('failure.MAC_SIGNED_OUT'));
    });
});

describe('the raw text is escaped, and cut when it is a whole log', () => {
    it('markup in a worker\'s text is text', () => {
        const { UI } = loadDashboard();
        const markup = String(UI.failure('boom <img src=x onerror=alert(1)> & "quoted"'));
        assert.doesNotMatch(markup, /<img/);
        assert.match(detailsOf(markup), /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
        const named = String(UI.failure('whisper.cpp timed out after 3 min <script>x</script>'));
        assert.doesNotMatch(named, /<script/);
    });

    it('Details keeps at most FAILURE_DETAILS_MAX characters of it, and says it was cut', () => {
        const { UI } = loadDashboard();
        const long = 'x'.repeat(5000);
        const details = UI.failureParts(long).details;
        assert.equal(details.length, UI.FAILURE_DETAILS_MAX + 1);
        assert.ok(details.endsWith('…'));
    });
});

describe('when it happened (QA-06)', () => {
    it('a dated failure says so; an old one says it may already be fixed; an undated one says nothing', () => {
        const { UI, t } = loadDashboard();
        const raw = 'claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed';
        const recent = String(UI.failure({ message: raw, at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }));
        assert.match(recent, /<span class="failure-when"[^>]*><time datetime="[^"]+">Happened /);
        assert.doesNotMatch(recent, /may already be fixed/);
        const old = String(UI.failure({ message: raw, at: new Date(Date.now() - 40 * 86400000).toISOString() }));
        assert.match(old, /may already be fixed/);
        assert.ok(old.includes(t('failure.whenOld', { when: '' }).split('{')[0]!.trim().slice(0, 8)));
        assert.doesNotMatch(String(UI.failure(raw)), /failure-when/);
        assert.doesNotMatch(String(UI.failure({ message: raw, at: 'not a date' })), /failure-when/);
    });

    it('the Arabic one says «حدث» and the date, in Arabic', () => {
        const { UI } = loadDashboard({ lang: 'ar' });
        const markup = String(UI.failure({ message: 'whisper.cpp timed out after 3 min', at: new Date(Date.now() - 40 * 86400000).toISOString() }));
        assert.match(markup, /failure-when[^>]*><time[^>]*>حدث /);
        assert.match(markup, /وربما أُصلح/);
    });
});

describe('the other forms of the same helper', () => {
    it('failureLine is the sentence and next step, never the raw text; failureDetails is the disclosure alone; next:false drops the step', () => {
        const { UI, t } = loadDashboard();
        const raw = LIVE[7]![0];
        assert.equal(UI.failureLine(raw), `${t('failure.TRANSCRIBE_TIMEOUT')} ${t('failure.TRANSCRIBE_TIMEOUT.next')}`);
        assert.match(String(UI.failureDetails(raw)), /^<details class="error-details">[\s\S]*whisper\.cpp timed out/);
        assert.equal(String(UI.failureDetails('')), '');
        assert.doesNotMatch(String(UI.failure(raw, { next: false })), /error-next/);
        const box = String(UI.failureBox(raw, 'strip-9'));
        assert.match(box, /<div class="inline-error" role="alert" id="strip-9">/);
        assert.equal(sentenceOf(box), t('failure.TRANSCRIBE_TIMEOUT'));
    });

    it('QA-13: a TikTok permission is words, in both languages, never video.list', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { UI } = loadDashboard({ lang });
            for (const scope of ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list', 'video.upload', 'video.publish']) {
                const label = UI.tiktokScopeLabel(scope);
                assert.doesNotMatch(label, /video\.|user\.info/);
                assert.notEqual(label, UI.tiktokScopeLabel('something.new'), scope);
                if (lang === 'ar') assert.match(label, ARABIC);
            }
            assert.equal(UI.tiktokScopeLabel('something.new'), UI.tiktokScopeLabel(''));
        }
    });
});

describe('the table and the catalogues agree', () => {
    const read = (file: string): Record<string, string> => {
        const src = readFileSync(file, 'utf8');
        const keys: Record<string, string> = {};
        for (const m of src.matchAll(/^\s*'([^']+)': '((?:[^'\\]|\\.)*)',$/gm)) keys[m[1]!] = m[2]!;
        return keys;
    };
    const en = read('dashboard/js/i18n.en.js');
    const ar = read('dashboard/js/i18n.ar.js');
    const components = readFileSync('dashboard/js/components.js', 'utf8');
    const table = components.slice(components.indexOf('FAILURE_PATTERNS: Object.freeze(['), components.indexOf('META_GENERIC_TEXT'));
    const codes = [...table.matchAll(/, '([A-Z_]+)'\],/g)].map((m) => m[1]!);

    it('the table names the codes the live list uses, and there are no duplicates', () => {
        assert.ok(codes.length >= 25, `only ${codes.length} codes`);
        for (const [, code] of LIVE) {
            if (code === 'META' || code === 'META_GENERIC') continue;
            assert.ok(codes.includes(code), code);
        }
    });

    it('every code has a sentence and a next step in both catalogues (a client code in failure.*, a server code in errors.*), the Arabic one in Arabic', () => {
        for (const code of codes) {
            const space = en[`failure.${code}`] !== undefined ? 'failure' : 'errors';
            for (const [lang, dict] of [['en', en], ['ar', ar]] as const) {
                assert.ok(dict[`${space}.${code}`], `${lang} ${space}.${code}`);
                assert.ok(dict[`${space}.${code}.next`], `${lang} ${space}.${code}.next`);
            }
            if (space === 'failure') {
                assert.match(ar[`failure.${code}`]!, ARABIC);
                assert.match(ar[`failure.${code}.next`]!, ARABIC);
            }
        }
        for (const key of ['failure.generic', 'failure.META_GENERIC', 'failure.when', 'failure.whenOld']) {
            assert.ok(en[key] && ar[key], key);
        }
    });

    it('no failure.<CODE> key is orphaned: every one is in the table (or is one of the four fixed ones)', () => {
        const fixed = new Set(['generic', 'META_GENERIC', 'when', 'whenOld']);
        for (const key of Object.keys(en)) {
            const m = /^failure\.([A-Za-z_]+)(?:\.next)?$/.exec(key);
            if (!m || fixed.has(m[1]!)) continue;
            assert.ok(codes.includes(m[1]!), `${key} is in no pattern`);
        }
    });
});
