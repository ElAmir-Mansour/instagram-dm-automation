/**
 * The pure rules of an explainer draft (src/services/explainers/spec.ts, data-model.md §1): scene counts by length tier, the spoken-duration
 * estimate and its target range, sources, the closing question, engagement bait, field limits and the no-women guard. Nothing here
 * reaches a database, a clock or the network.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    checkDraft, countWords, DEFAULT_PACE, DURATION_RANGE_S, endsWithQuestion, engagementBait, estimateSeconds, FEMALE_TERMS, findFemaleSubject,
    LIMITS, MAX_SCENES, PICTURE_SECONDS, PICTURE_WARN_SECONDS, pictureHolds, SCENE_BOUNDS, type DraftFinding, type DraftInput, type DraftScene,
} from './spec.js';

type Tier = keyof typeof SCENE_BOUNDS;
const TIERS = ['short', 'medium', 'long'] as const satisfies readonly Tier[];

/** `n` distinct words: "w1 w2 w3 …". */
const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i + 1}`).join(' ');
const codes = (findings: readonly DraftFinding[]): string[] => findings.map((f) => f.code);

function scene(over: Partial<DraftScene> = {}): DraftScene {
    return {
        narration: 'A model answers from what it remembers.', spoken: 'A model answers from what it remembers.', label: 'RAG',
        brief: 'The man at a desk, reading a printed paper, warm light from the window.', characters: ['karim'], continues: false, source_ids: [0],
        ...over,
    };
}

const source = (n: number) => ({ title: `Paper ${n}`, by: 'Lewis et al.', year: '2020', url: `https://arxiv.org/abs/2005.1140${n}` });

/** A draft a test may edit in place: `DraftInput` itself only reads its scenes. */
type TestDraft = Omit<DraftInput, 'scenes'> & { scenes: DraftScene[] };

/** `n` scenes, the last one a genuine question, three sources, and nothing else wrong. */
function draft(n: number, over: Partial<Omit<DraftInput, 'scenes'>> = {}): TestDraft {
    const scenes: DraftScene[] = Array.from({ length: n }, () => scene());
    if (n > 0) scenes[n - 1] = scene({ narration: 'Would you trust an answer that has no source?', spoken: 'Would you trust an answer that has no source?', source_ids: [] });
    return {
        title: 'Why AI makes things up',
        scenes,
        sources: [source(1), source(2), source(3)],
        captions: { meta: 'How retrieval keeps a model honest. Would you trust it?', youtube: { title: 'RAG explained', description: 'Sources are linked below.' }, tiktok: 'RAG in 60 seconds' },
        first_comment: 'Sources: Lewis et al., 2020.',
        ...over,
    };
}

/** A draft of `n` scenes whose spoken forms add up to exactly `total` words, spread evenly so that no scene passes its limit. */
function draftOfWords(n: number, total: number): TestDraft {
    const d = draft(n);
    const scenes = d.scenes.map((s, i) => ({ ...s, spoken: words(Math.floor(total / n) + (i < total % n ? 1 : 0)) }));
    return { ...d, scenes };
}

const ctxFor = (tier: Tier, language: 'ar' | 'en' = 'en', pace?: number) => ({ tier, language, ...(pace === undefined ? {} : { pace }) });

// ─── Scene counts ──────────────────────────────────────────────────────────────────────────────

describe('scene counts by length tier', () => {
    it('are short 10–30, medium 30–90 and long 120–300', () => {
        assert.deepEqual(SCENE_BOUNDS, { short: { min: 10, max: 30 }, medium: { min: 30, max: 90 }, long: { min: 120, max: 300 } });
        assert.equal(MAX_SCENES, 300, 'the writer schema allows 300 scenes, whatever the tier');
    });

    for (const tier of TIERS) {
        const { min, max } = SCENE_BOUNDS[tier];
        it(`${tier}: ${min} and ${max} scenes are inside, one fewer or one more is warned about`, () => {
            for (const n of [min, max]) {
                assert.ok(!codes(checkDraft(draft(n), ctxFor(tier)).warnings).includes('scene_count'), `${n} scenes`);
            }
            for (const n of [min - 1, max + 1]) {
                const warned = checkDraft(draft(n), ctxFor(tier)).warnings.filter((w) => w.code === 'scene_count');
                assert.equal(warned.length, 1, `${n} scenes`);
                assert.match(warned[0]!.message, new RegExp(`${n} scenes`));
                assert.match(warned[0]!.message, new RegExp(`${min}.${max}`));
            }
        });
    }

    it('is a warning and never a problem, so the owner can still approve a script that runs short or long', () => {
        const check = checkDraft(draft(SCENE_BOUNDS.short.min - 1), ctxFor('short'));
        assert.ok(codes(check.warnings).includes('scene_count'));
        assert.ok(!codes(check.problems).includes('scene_count'));
    });

    it('a draft with no scene is a problem, and so is one past the 300 the schema allows', () => {
        assert.deepEqual(codes(checkDraft(draft(0), ctxFor('short')).problems), ['no_scenes']);
        assert.ok(codes(checkDraft(draft(MAX_SCENES), ctxFor('long')).problems).length === 0);
        assert.ok(codes(checkDraft(draft(MAX_SCENES + 1), ctxFor('long')).problems).includes('too_many_scenes'));
    });
});

// ─── Duration ──────────────────────────────────────────────────────────────────────────────────

describe('countWords', () => {
    it('counts what is separated by white space, newlines included', () => {
        assert.equal(countWords('one two  three\nfour'), 4);
        assert.equal(countWords(''), 0);
        assert.equal(countWords('   \n '), 0);
    });

    it('does not count punctuation that stands alone, or the question mark after a word', () => {
        assert.equal(countWords('Wait — really ? ... !'), 2);
        assert.equal(countWords('Really?'), 1);
    });

    it('counts Arabic words and numbers, and not the Arabic question mark', () => {
        assert.equal(countWords('ما هو الاسترجاع المعزز بالتوليد في عام 2020 ؟'), 8);
        assert.equal(countWords('في عام ٢٠٢٠'), 3);
    });
});

describe('the duration estimate: spoken words ÷ pace', () => {
    it('is 1.8 words a second for Arabic (measured 2026-10-25: 11 words in 6.3 s of speech) and 2.5 for English', () => {
        assert.deepEqual(DEFAULT_PACE, { ar: 1.8, en: 2.5 });
        assert.equal(estimateSeconds([{ spoken: words(108) }], 'ar'), 60);
        assert.equal(estimateSeconds([{ spoken: words(100) }], 'en'), 40);
    });

    it('adds up the scenes, and reads the spoken form: that is what the narrator says', () => {
        assert.equal(estimateSeconds([{ spoken: words(54) }, { spoken: words(54) }], 'ar'), 60);
        assert.equal(estimateSeconds([], 'ar'), 0);
    });

    it('takes the pace from the settings when one is given, and ignores one that cannot be a pace', () => {
        assert.equal(estimateSeconds([{ spoken: words(100) }], 'en', 2), 50);
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            assert.equal(estimateSeconds([{ spoken: words(100) }], 'en', bad), 40, String(bad));
        }
    });

    it('is rounded to a tenth of a second', () => {
        assert.equal(estimateSeconds([{ spoken: words(100) }], 'ar'), 55.6);
    });

    it('is what a draft check reports', () => {
        const d = draftOfWords(12, 100);
        assert.equal(checkDraft(d, ctxFor('short', 'en')).est_seconds, 40);
        assert.equal(checkDraft(d, ctxFor('short', 'en', 1)).est_seconds, 100);
        assert.equal(checkDraft(d, ctxFor('short', 'ar')).est_seconds, 55.6);
    });
});

describe('the target range of a length tier', () => {
    it('is short 55–95 s, medium 170–310 s and long 570–930 s', () => {
        assert.deepEqual(DURATION_RANGE_S, { short: { min: 55, max: 95 }, medium: { min: 170, max: 310 }, long: { min: 570, max: 930 } });
    });

    for (const tier of TIERS) {
        const { min, max } = DURATION_RANGE_S[tier];
        const scenes = SCENE_BOUNDS[tier].min;
        // Pace 1 word a second, so the words ARE the seconds.
        it(`${tier}: ${min} s and ${max} s are inside, a second under or over is warned about`, () => {
            for (const seconds of [min, max]) {
                const found = codes(checkDraft(draftOfWords(scenes, seconds), ctxFor(tier, 'en', 1)).warnings);
                assert.ok(!found.includes('duration_short') && !found.includes('duration_long'), `${seconds} s: ${found}`);
            }
            const under = checkDraft(draftOfWords(scenes, min - 1), ctxFor(tier, 'en', 1)).warnings.filter((w) => w.code === 'duration_short');
            assert.equal(under.length, 1);
            assert.match(under[0]!.message, new RegExp(`${min - 1} s`));
            assert.match(under[0]!.message, new RegExp(`${min}.${max} s`));
            const over = checkDraft(draftOfWords(scenes, max + 1), ctxFor(tier, 'en', 1)).warnings.filter((w) => w.code === 'duration_long');
            assert.equal(over.length, 1);
            assert.match(over[0]!.message, new RegExp(`${max + 1} s`));
        });
    }

    it('is only ever a warning: the owner can still approve', () => {
        const check = checkDraft(draftOfWords(12, 400), ctxFor('short', 'en', 1));
        assert.ok(codes(check.warnings).includes('duration_long'));
        assert.deepEqual(check.problems, []);
    });
});

// ─── How long each picture stays ───────────────────────────────────────────────────────────────

/** A draft whose scenes say `counts[i]` words each (at a pace of 1 that is seconds), the last still a question; `continued` keep the previous picture. */
function paced(counts: readonly number[], continued: readonly number[] = []): TestDraft {
    const d = draft(counts.length);
    d.scenes = d.scenes.map((s, i) => ({ ...s, spoken: words(counts[i]!), continues: continued.includes(i) }));
    return d;
}

const PACING = ['slow_opening', 'scene_long', 'scene_short'];
/** The pacing warnings of a short draft; `pace` null is the language's default. */
const pacing = (d: TestDraft, language: 'ar' | 'en' = 'en', pace: number | null = 1): DraftFinding[] =>
    checkDraft(d, ctxFor('short', language, pace ?? undefined)).warnings.filter((w) => PACING.includes(w.code));

describe('how long each picture stays', () => {
    it('is written for 3.5 to 6.5 s, about 4.5, the first within 4; warned over 7 s, under 2 s, and a first one over 4.5 s', () => {
        assert.deepEqual(PICTURE_SECONDS, { min: 3.5, aim: 4.5, max: 6.5, first: 4 });
        assert.deepEqual(PICTURE_WARN_SECONDS, { short: 2, long: 7, first: 4.5 });
    });

    it('a picture is a scene and the scenes after it that keep it, as the renderer holds them', () => {
        const holds = pictureHolds([{ spoken: words(4) }, { spoken: words(6) }, { spoken: words(3), continues: true }, { spoken: words(5) }], 'en', 1);
        assert.deepEqual(holds, [{ scene: 0, seconds: 4 }, { scene: 1, seconds: 9 }, { scene: 3, seconds: 5 }]);
        assert.deepEqual(pictureHolds([{ spoken: words(4), continues: true }], 'en', 1), [{ scene: 0, seconds: 4 }], 'a first scene has nothing to keep');
    });

    it('a first picture over 4.5 s is a slow opening, said once, at scene 0', () => {
        assert.deepEqual(pacing(paced([4, 5, 5, 5])), [], '4 s');
        const slow = pacing(paced([5, 5, 5, 5]));
        assert.deepEqual(codes(slow), ['slow_opening']);
        assert.equal(slow[0]!.scene, 0);
        assert.match(slow[0]!.message, /about 5 s/);
        assert.deepEqual(codes(pacing(paced([9, 5, 5]))), ['slow_opening'], 'a first picture over 7 s is not also too long');
    });

    it('a later picture over 7 s is too long, its scenes named by number; 7 s is not', () => {
        assert.deepEqual(pacing(paced([4, 7, 6, 7])), []);
        const long = pacing(paced([4, 8, 6, 9]));
        assert.deepEqual(codes(long), ['scene_long']);
        assert.match(long[0]!.message, /scenes 2, 4: split each of those sentences in two/);
        assert.match(pacing(paced([4, 8, 6, 5]))[0]!.message, /scene 2: split that sentence in two/);
    });

    it('two sentences that keep one picture are one picture: 4 + 4 s held is too long', () => {
        const kept = pacing(paced([4, 4, 4, 5], [2]));
        assert.deepEqual(codes(kept), ['scene_long']);
        assert.match(kept[0]!.message, /scene 2: /);
    });

    it('a picture under 2 s is too fast; a scene with no spoken words is a problem of its own, not a fast picture', () => {
        const fast = pacing(paced([4, 1, 5, 1]));
        assert.deepEqual(codes(fast), ['scene_short']);
        assert.match(fast[0]!.message, /scenes 2, 4: join each of those sentences to the one next to it/);
        assert.deepEqual(pacing(paced([4, 2, 5])), [], '2 s');
        const empty = paced([4, 0, 5]);
        assert.deepEqual(pacing(empty), []);
        assert.ok(codes(checkDraft(empty, ctxFor('short', 'en', 1)).problems).includes('field_empty'));
    });

    it('reads the pace from the settings: the same words are quicker pictures at a faster narrator', () => {
        const d = paced([9, 16, 12]);
        assert.deepEqual(codes(pacing(d)), ['slow_opening', 'scene_long'], 'at 1 word a second');
        assert.deepEqual(pacing(d, 'en', 2.5), [], 'at 2.5: 3.6, 6.4 and 4.8 s');
    });

    it('the RAG pilot’s sentence lengths, at the Arabic pace, are warned: its first picture, and scenes 2, 4 and 14', () => {
        const pilot = paced([10, 16, 10, 16, 12, 12, 10, 11, 10, 11, 11, 11, 12, 13, 11]);
        const found = pacing(pilot, 'ar', null);
        assert.deepEqual(codes(found), ['slow_opening', 'scene_long']);
        assert.match(found[0]!.message, /about 5\.6 s/);
        assert.match(found[1]!.message, /scenes 2, 4, 14:/);
    });

    it('is only ever a warning: the owner can still approve', () => {
        const check = checkDraft(paced([12, 16, 1]), ctxFor('short', 'en', 1));
        assert.deepEqual(codes(check.warnings.filter((w) => PACING.includes(w.code))), ['slow_opening', 'scene_long', 'scene_short']);
        assert.deepEqual(check.problems, []);
    });
});

// ─── Sources ───────────────────────────────────────────────────────────────────────────────────

describe('sources', () => {
    it('a draft with none is marked needs_sources, whatever its tier', () => {
        for (const tier of TIERS) {
            const check = checkDraft(draft(SCENE_BOUNDS[tier].min, { sources: [] }), ctxFor(tier));
            assert.ok(codes(check.warnings).includes('needs_sources'), tier);
        }
        assert.ok(!codes(checkDraft(draft(12, { sources: [source(1)] }), ctxFor('short')).warnings).includes('needs_sources'));
    });

    it('short wants three: one or two are few_sources, three are enough, and needs_sources does not repeat it', () => {
        for (const n of [1, 2]) {
            const found = codes(checkDraft(draft(12, { sources: Array.from({ length: n }, (_, i) => source(i)) }), ctxFor('short')).warnings);
            assert.ok(found.includes('few_sources'), `${n} sources`);
            assert.ok(!found.includes('needs_sources'));
        }
        assert.ok(!codes(checkDraft(draft(12), ctxFor('short')).warnings).includes('few_sources'));
        assert.ok(!codes(checkDraft(draft(12, { sources: [] }), ctxFor('short')).warnings).includes('few_sources'), 'none is needs_sources, not few');
    });

    it('asks for three only of the short tier: the data model names no number for the others', () => {
        const found = codes(checkDraft(draft(30, { sources: [source(1), source(2)] }), ctxFor('medium')).warnings);
        assert.ok(!found.includes('few_sources'));
    });

    it('a scene may only cite a source that is listed', () => {
        const d = draft(12);
        d.scenes[2] = scene({ source_ids: [0, 3] });
        d.scenes[4] = scene({ source_ids: [-1] });
        d.scenes[5] = scene({ source_ids: [1.5] });
        const bad = checkDraft(d, ctxFor('short')).problems.filter((p) => p.code === 'bad_source_id');
        assert.deepEqual(bad.map((p) => p.scene), [2, 4, 5]);
        assert.match(bad[0]!.message, /Scene 3/);
    });

    it('a scene with no source_ids at all (an owner’s edit does not carry them) is fine', () => {
        const d = draft(12);
        d.scenes[2] = { narration: 'x', spoken: 'x', label: '', brief: 'The man at a desk.', characters: [] };
        assert.ok(!codes(checkDraft(d, ctxFor('short')).problems).includes('bad_source_id'));
    });
});

// ─── The closing question ──────────────────────────────────────────────────────────────────────

describe('the closing question', () => {
    it('ends with ? or ؟, quotes and brackets after it allowed', () => {
        for (const text of ['Would you trust it?', 'Would you trust it ?', 'هل تثق به؟', 'هل تثق به ؟  ', 'She asked: "Why?"', '«ما رأيك؟»', 'Is it (really) true?)', 'Is it so?\n']) {
            assert.equal(endsWithQuestion(text), true, text);
        }
    });

    it('is not a statement, nor a question that is followed by something else', () => {
        for (const text of ['Remember this.', 'What? Never mind.', '', '   ', 'Comment below!', 'تذكر هذا.', 'ما رأيك؟ شكرا لكم']) {
            assert.equal(endsWithQuestion(text), false, text);
        }
    });

    it('is a problem when the LAST scene does not ask, and not when only an earlier one does', () => {
        const d = draft(12);
        d.scenes[11] = scene({ narration: 'And that is the whole story.', spoken: 'And that is the whole story.', source_ids: [] });
        d.scenes[3] = scene({ narration: 'Why does it happen?', spoken: 'Why does it happen?' });
        const found = checkDraft(d, ctxFor('short')).problems.filter((p) => p.code === 'closing_question');
        assert.equal(found.length, 1);
        assert.equal(found[0]!.scene, 11);
        assert.deepEqual(codes(checkDraft(draft(12), ctxFor('short')).problems), [], 'a draft that ends in a question is clean');
    });
});

// ─── Engagement bait ───────────────────────────────────────────────────────────────────────────

describe('engagement bait', () => {
    const BAIT = [
        // The four the data model names.
        'اكتب نعم', 'علّق بكلمة', 'comment YES', 'type 1',
        // The same, dressed up: case, diacritics, tatweel, Arabic-Indic digits, quotes.
        'Comment YES below if you agree!', 'COMMENT "yes" now', 'اكتـــب نَعَم في التعليقات', 'علّق بكلمة «دليل» وسأرسله لك', 'اكتب ١', 'اكتب 1',
        'اكتب رقم', 'اكتب الكلمة', 'علّق بنعم إن وافقت', 'علقوا برقم', 'type "yes" in the comments', 'Type yes if you agree',
        'comment 1 for A and 2 for B', 'Comment the word GUIDE and I will send it', 'comment "AI" and I will send it', 'reply 1 for the link',
        // Reacting, sharing, tagging.
        'react with a heart', 'drop a 🔥 if you agree', 'drop a heart', 'like if you agree', 'share if you learned something',
        'tag a friend who needs this', 'tag your team', 'double tap if you agree', 'smash that like button', 'like and subscribe',
        'اضغط لايك إذا أعجبك', 'ضع لايك', 'ضعوا إعجاب', 'شارك الفيديو إذا استفدت', 'لايك لو أعجبك', 'منشن صديقك', 'لا تنس الاشتراك',
    ];

    for (const text of BAIT) {
        it(`refuses «${text}»`, () => {
            assert.notEqual(engagementBait(text), null);
        });
    }

    it('says which words it found, as the person typed them', () => {
        assert.equal(engagementBait('Great question. Comment YES below!'), 'Comment YES');
        assert.equal(engagementBait('هل تعرف الإجابة؟ اكتـــب نَعَم'), 'اكتـــب نَعَم');
    });

    const GENUINE = [
        'What would you do if the retriever found nothing?', 'Would you trust an answer that has no source?', 'Which matters more to you: speed or accuracy?',
        'Tell me in the comments what you think.', 'Let me know your thoughts below.', 'Write a function that returns the top three results.',
        'A type of memory the model does not have.', 'He reacted quickly to the new result.', 'It works like a library.', 'Follow the sources, not the headline.',
        'There is a comment section for notes in the code.', 'ما الذي ستفعله إذا لم يجد المسترجع شيئًا؟', 'هل تثق بإجابة بلا مصدر؟',
        'اكتب الكود بعناية', 'علّق الباحث على النتيجة', 'ما رأيك في هذه النتيجة؟',
    ];

    for (const text of GENUINE) {
        it(`lets «${text}» through`, () => {
            assert.equal(engagementBait(text), null);
        });
    }

    it('is a problem in the closing scene, and in a caption or the first comment', () => {
        const d = draft(12);
        d.scenes[11] = scene({ narration: 'Which would you pick? Comment YES for the first.', spoken: 'Which would you pick? Comment YES for the first.', source_ids: [] });
        d.captions = { meta: 'Would you trust it? اكتب نعم', youtube: { title: 'RAG', description: 'Type 1 if you agree' }, tiktok: 'drop a 🔥 if you agree' };
        d.first_comment = 'Like if you agree. Sources below.';
        const found = checkDraft(d, ctxFor('short')).problems.filter((p) => p.code === 'engagement_bait');
        assert.deepEqual(found.map((p) => p.field ?? `scene ${p.scene}`).sort(), [
            'captions.meta', 'captions.tiktok', 'captions.youtube.description', 'first_comment', 'narration',
        ]);
        assert.equal(found.find((p) => p.field === 'narration')!.scene, 11);
    });

    it('is not looked for in the middle of the script, where "type 1" can be an instruction in a lesson', () => {
        const d = draft(12);
        d.scenes[4] = scene({ narration: 'Now type 1 into the console and press enter.', spoken: 'Now type 1 into the console and press enter.' });
        assert.deepEqual(codes(checkDraft(d, ctxFor('short')).problems), []);
    });
});

// ─── Field limits ──────────────────────────────────────────────────────────────────────────────

describe('field limits', () => {
    it('are title 70, narration 300, spoken 400, brief 500, a label of 4 words and 40 characters, 4 characters', () => {
        assert.deepEqual(LIMITS, { title: 70, narration: 300, spoken: 400, brief: 500, labelWords: 4, labelChars: 40, characters: 4 });
    });

    const problemsOf = (over: Partial<DraftScene>, at = 3): DraftFinding[] => {
        const d = draft(12);
        d.scenes[at] = scene(over);
        return checkDraft(d, ctxFor('short')).problems;
    };

    for (const [field, limit] of [['narration', 300], ['spoken', 400], ['brief', 500]] as const) {
        it(`${field}: ${limit} characters are fine, ${limit + 1} are refused, and the scene is named`, () => {
            assert.deepEqual(problemsOf({ [field]: 'x'.repeat(limit) }), []);
            const found = problemsOf({ [field]: 'x'.repeat(limit + 1) });
            assert.equal(found.length, 1);
            assert.equal(found[0]!.code, 'field_too_long');
            assert.equal(found[0]!.field, field);
            assert.equal(found[0]!.scene, 3);
            assert.match(found[0]!.message, new RegExp(`Scene 4.*${field}.*${limit + 1}.*${limit}`));
        });
    }

    it('counts characters, not UTF-16 units: an emoji is one, as Postgres and the schema count it', () => {
        assert.deepEqual(problemsOf({ narration: '😀'.repeat(300) }), []);
        assert.equal(problemsOf({ narration: '😀'.repeat(301) })[0]!.code, 'field_too_long');
    });

    it('refuses a narration, a spoken form or a brief that is empty', () => {
        for (const field of ['narration', 'spoken', 'brief'] as const) {
            for (const blank of ['', '   ', undefined as unknown as string]) {
                const found = problemsOf({ [field]: blank });
                assert.ok(found.some((p) => p.code === 'field_empty' && p.field === field && p.scene === 3), `${field} ${JSON.stringify(blank)}`);
            }
        }
    });

    it('characters: 4 are fine, 5 are refused', () => {
        assert.deepEqual(problemsOf({ characters: ['a', 'b', 'c', 'd'] }), []);
        const found = problemsOf({ characters: ['a', 'b', 'c', 'd', 'e'] });
        assert.deepEqual(codes(found), ['too_many_characters']);
        assert.equal(found[0]!.scene, 3);
    });

    it('the title: 70 characters are fine, 71 are refused', () => {
        assert.deepEqual(checkDraft(draft(12, { title: 'x'.repeat(70) }), ctxFor('short')).problems, []);
        const found = checkDraft(draft(12, { title: 'x'.repeat(71) }), ctxFor('short')).problems;
        assert.deepEqual(codes(found), ['field_too_long']);
        assert.equal(found[0]!.field, 'title');
    });

    describe('a label is at most 4 words, or a number', () => {
        it('may be empty: that is "no label"', () => {
            assert.deepEqual(problemsOf({ label: '' }), []);
            assert.deepEqual(problemsOf({ label: '   ' }), []);
        });

        it('allows 1 to 4 words, in either language', () => {
            for (const label of ['RAG', 'Retrieval Augmented Generation', 'Four words are fine', 'الاسترجاع المعزز بالتوليد', 'ذاكرة النموذج المحدودة جدا']) {
                assert.deepEqual(problemsOf({ label }), [], label);
            }
        });

        it('refuses 5 words', () => {
            for (const label of ['Five words are too many', 'ذاكرة النموذج المحدودة جدا للغاية']) {
                const found = problemsOf({ label });
                assert.deepEqual(codes(found), ['label_too_long'], label);
                assert.equal(found[0]!.scene, 3);
                assert.match(found[0]!.message, /Scene 4.*label.*4 words/);
            }
        });

        it('allows a number such as a year, in Latin or Arabic-Indic digits, with its separators and signs', () => {
            for (const label of ['2020', '٢٠٢٠', '1,000,000', '95%', '$1.5M', '10K+']) {
                assert.deepEqual(problemsOf({ label }), [], label);
            }
        });

        it('refuses a label longer than 40 characters, however few its words: it must fit the tag', () => {
            assert.deepEqual(problemsOf({ label: 'x'.repeat(40) }), []);
            assert.deepEqual(codes(problemsOf({ label: 'x'.repeat(41) })), ['label_too_long']);
        });
    });
});

// ─── The no-women guard ────────────────────────────────────────────────────────────────────────

describe('the no-women guard', () => {
    it('catches every English term of research.md R5, in any case', () => {
        for (const term of ['woman', 'women', 'girl', 'lady', 'female', 'mother', 'wife', 'sister', 'daughter', 'she', 'her']) {
            for (const text of [term, term.toUpperCase(), `${term[0]!.toUpperCase()}${term.slice(1)}`, `The scene shows a ${term} at a desk.`]) {
                assert.equal(findFemaleSubject(text)?.toLowerCase(), term, text);
            }
        }
    });

    it('catches every Arabic term of research.md R5', () => {
        for (const term of ['امرأة', 'نساء', 'فتاة', 'بنت', 'سيدة', 'أم', 'زوجة', 'أخت', 'ابنة']) {
            assert.notEqual(findFemaleSubject(term), null, term);
            assert.notEqual(findFemaleSubject(`رجل يقرأ كتابا بجانب ${term} في المكتب`), null, term);
        }
    });

    it('is not fooled by diacritics, tatweel or the spellings of the hamza', () => {
        for (const text of ['امْرَأَة', 'امــرأة', 'امراة', 'إمرأة', 'ام', 'أُمّ', 'نِسَاء', 'فَتَاة', 'فتـــاة', 'سَيِّدَة']) {
            assert.notEqual(findFemaleSubject(text), null, text);
        }
    });

    it('catches the Arabic article, the one-letter prefixes and the possessive endings', () => {
        for (const text of [
            'المرأة', 'للمرأة', 'والمرأة', 'بالمرأة', 'لامرأة', 'النساء', 'الفتاة', 'البنت', 'السيدة', 'الأم', 'للأم', 'وللأم', 'الزوجة', 'الأخت', 'الابنة',
            'أمي', 'أمها', 'أمك', 'أمنا', 'أمهات', 'زوجته', 'وزوجتي', 'امرأته', 'أختي', 'أختها', 'بنتي', 'ابنته', 'ابنتي', 'فتيات', 'بنات', 'سيدات',
        ]) {
            assert.notEqual(findFemaleSubject(text), null, text);
        }
    });

    it('returns the word as it was typed, so the message can quote it', () => {
        assert.equal(findFemaleSubject('A man and a Woman, talking.'), 'Woman');
        assert.equal(findFemaleSubject('رجل يقف بجانب امــرأة'), 'امــرأة');
        assert.equal(findFemaleSubject('The man thinks. She nods.'), 'She');
    });

    it('matches whole words only: human is not man, and nothing is found inside a longer word', () => {
        for (const text of [
            'human feedback', 'the human in the loop', 'a man at a desk', 'the man in image 0', 'management', 'a shell', 'there and here', 'the other one', 'wholesome',
            'a motherboard', 'a ladybug', 'sisterhood', 'ashes', 'a mamba',
        ]) {
            assert.equal(findFemaleSubject(text), null, text);
        }
        assert.notEqual(findFemaleSubject('the book is hers'), null, 'hers is a female pronoun, and a whole word');
        assert.notEqual(findFemaleSubject("she's reading, and it's her book"), null, 'an apostrophe ends a word');
    });

    it('matches Arabic whole words only: «أمثلة» is not «أم»', () => {
        for (const text of [
            'أمثلة', 'أمر', 'أمام', 'أمين', 'اهتمام', 'بنتاغون', 'الأمة', 'نسخة', 'سيدنا', 'ابنه', 'عمه', 'أمل', 'فتح', 'أمس', 'تمام',
            // The nation typed with a ha, and the Egyptian «كام» ("how many") and the letter «لام»: none is a mother, with or without her article.
            'الامه', 'كام', 'لام',
        ]) {
            assert.equal(findFemaleSubject(`رجل مع ${text} على المكتب`), null, text);
            assert.equal(findFemaleSubject(text), null, text);
        }
    });

    it('does not take a taa marbuta for a haa: «ابنه» (his son) is not «ابنة» (a daughter), «عمه» (his uncle) is not «عمة»', () => {
        assert.equal(findFemaleSubject('ابنه'), null);
        assert.notEqual(findFemaleSubject('ابنة'), null);
        assert.equal(findFemaleSubject('عمه'), null);
        assert.notEqual(findFemaleSubject('عمة'), null);
    });

    it('catches the other words of its list, and every listed word stands alone', () => {
        assert.ok(FEMALE_TERMS.en.length >= 40 && FEMALE_TERMS.ar.length >= 25);
        for (const term of [...FEMALE_TERMS.en, ...FEMALE_TERMS.ar]) {
            assert.notEqual(findFemaleSubject(term), null, term);
            assert.notEqual(findFemaleSubject(`${term}.`), null, `${term}.`);
        }
    });

    it('finds nothing in the character the app draws: a man, and the rest of a normal brief', () => {
        assert.equal(findFemaleSubject('a curious young man with a round head, short dark hair, dot eyes, dark green sweater, thin legs'), null);
        assert.equal(findFemaleSubject('The man at a desk, reading a printed paper, warm light from the window.'), null);
        assert.equal(findFemaleSubject(''), null);
    });

    it('sees through a zero-width character hidden in the word', () => {
        assert.notEqual(findFemaleSubject('wo\u200Bman'), null);
        assert.notEqual(findFemaleSubject('ام\u200Cرأة'), null);
    });

    it('is applied to the picture briefs of a draft, and not to its narration: a sentence may be about a woman, a picture may not show one', () => {
        const d = draft(12);
        d.scenes[2] = scene({ brief: 'The man shows a chart to a woman at the next desk.', narration: 'Ada Lovelace saw it first, and she wrote it down.', spoken: 'Ada Lovelace saw it first, and she wrote it down.' });
        const found = checkDraft(d, ctxFor('short')).problems;
        assert.deepEqual(codes(found), ['female_subject']);
        assert.equal(found[0]!.scene, 2);
        assert.equal(found[0]!.field, 'brief');
        assert.match(found[0]!.message, /Scene 3.*«woman».*women or girls/);
    });
});

// ─── Putting it together ───────────────────────────────────────────────────────────────────────

describe('checkDraft', () => {
    it('finds nothing wrong with a draft that follows every rule', () => {
        // 12 scenes, 80 spoken words: at a pace of one word a second that is 80 s, inside the 55-95 s of a short explainer; a hook of 4 words
        // (its picture changes at 4 s), ten sentences of 7 and a closing question of 6.
        const d = draft(12);
        d.scenes[0] = scene({ narration: 'Models make things up.', spoken: 'Models make things up.' });
        d.scenes[11] = scene({ narration: 'Would you trust an unsourced answer?', spoken: 'Would you trust an unsourced answer?', source_ids: [] });
        const check = checkDraft(d, ctxFor('short', 'en', 1));
        assert.deepEqual(check.problems, []);
        assert.deepEqual(check.warnings, []);
        assert.equal(check.est_seconds, 80);
    });

    it('and the same words at the real English pace are 34.4 s, which a short explainer is warned about', () => {
        const real = checkDraft(draft(12), ctxFor('short', 'en'));
        assert.deepEqual(real.problems, []);
        assert.deepEqual(codes(real.warnings), ['duration_short']);
        assert.equal(real.est_seconds, 34.4);
    });

    it('lists every problem it finds, not the first one', () => {
        const d = draft(12, { title: 'x'.repeat(80) });
        d.scenes[0] = scene({ narration: '', label: 'one two three four five', characters: ['a', 'b', 'c', 'd', 'e'] });
        d.scenes[11] = scene({ narration: 'Comment YES', spoken: 'Comment YES' });
        const found = codes(checkDraft(d, ctxFor('short')).problems);
        for (const code of ['field_too_long', 'field_empty', 'label_too_long', 'too_many_characters', 'closing_question', 'engagement_bait']) {
            assert.ok(found.includes(code), code);
        }
    });

    it('does not change what it is given', () => {
        const d = draft(12);
        const before = JSON.stringify(d);
        checkDraft(d, ctxFor('short'));
        assert.equal(JSON.stringify(d), before);
    });

    it('survives a draft whose fields are not what the schema says: that is a problem to report, not a crash', () => {
        const d = draft(12);
        (d.scenes[1] as unknown as Record<string, unknown>).narration = 42;
        (d.scenes[2] as unknown as Record<string, unknown>).characters = 'karim';
        (d.scenes[3] as unknown as Record<string, unknown>).brief = null;
        const check = checkDraft(d, ctxFor('short'));
        assert.ok(codes(check.problems).includes('field_empty'));
    });
});
