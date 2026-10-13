/**
 * Register detection (docs/onboarding/03 §3.2): marker counting by whole word, the verdict and its thresholds, call-to-action
 * lines scored apart, and the traps the spec names (`بس` inside `لبس`, `زي` inside `زيت`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeSignals } from './draftSignals.js';
import { EGYPTIAN, ENGLISH, GULF, LEVANTINE, MIXED, MSA, MSA_WITH_GULF_ASKS, WORD_BOUNDARY_TRAPS } from './fixtures/captions.js';
import { decideRegister, isCtaLine, languageOfCaptions, registerSignals, splitCaption, type RegisterSignals } from './register.js';

describe('registerSignals: counting markers', () => {
    it('finds each register\'s markers in its own captions and in nobody else\'s', () => {
        const gulf = registerSignals(GULF);
        assert.ok(gulf.scores.gulf > 10);
        assert.deepEqual([gulf.scores.egyptian, gulf.scores.levantine, gulf.scores.msa], [0, 0, 0]);
        assert.deepEqual(registerSignals(EGYPTIAN).scores.gulf, 0);
        assert.deepEqual(registerSignals(LEVANTINE).scores.egyptian, 0);
        assert.ok(registerSignals(MSA).scores.msa > 5);
        assert.deepEqual(registerSignals(MSA).scores.gulf + registerSignals(MSA).scores.egyptian + registerSignals(MSA).scores.levantine, 0);
    });

    it('lists the distinct markers found, normalised', () => {
        const gulf = registerSignals(GULF);
        for (const marker of ['وش', 'ايش', 'الحين', 'زين', 'كذا', 'واجد', 'وايد', 'ودك', 'يجيك']) assert.ok(gulf.markers.gulf.includes(marker), marker);
        assert.ok(gulf.markers.gulf.includes('ابي'), 'أبي is read as ابي, as normalizeArabic writes it');
        assert.ok(!gulf.markers.gulf.includes('ابغي'), 'the ask in the first caption is a call-to-action line, scored apart');
        assert.ok(registerSignals(EGYPTIAN).markers.egyptian.includes('ازاي'));
    });

    it('counts a marker once per caption, so one shouted word is not a register', () => {
        const once = registerSignals(['وش وش وش وش وش وش وش وش وش وش وش وش وش وش وش وش وش وش وش وش']);
        assert.equal(once.scores.gulf, 1);
        assert.equal(once.captionsWith.gulf, 1);
        const three = registerSignals(['وش', 'وش', 'وش']);
        assert.equal(three.scores.gulf, 3);
        assert.equal(three.captionsWith.gulf, 3);
    });

    it('matches WHOLE words: بس is not in لبس, زي is not in زيت', () => {
        const traps = registerSignals(WORD_BOUNDARY_TRAPS);
        assert.deepEqual(traps.shared.distinct, []);
        assert.equal(traps.shared.weight, 0);
        assert.deepEqual(traps.scores, { msa: 0, gulf: 0, egyptian: 0, levantine: 0 });
        assert.deepEqual(registerSignals(['لبس']).shared.distinct, []);
        assert.deepEqual(registerSignals(['زيت']).shared.distinct, []);
        assert.deepEqual(registerSignals(['بس']).shared.distinct, ['بس']);
        assert.deepEqual(registerSignals(['زي']).shared.distinct, ['زي']);
        // More traps: a marker inside a longer word never counts.
        for (const word of ['وشاح', 'كذابين', 'مشكلة', 'دعوشة', 'شوكة', 'هونج', 'فينيق', 'عايزين', 'الحينما', 'مرتبة', 'ليسانس', 'لقدام', 'حيثيات', 'فقطعة', 'سوفا']) {
            const s = registerSignals([word]);
            assert.deepEqual([s.scores.gulf, s.scores.egyptian, s.scores.levantine, s.scores.msa], [0, 0, 0, 0], word);
        }
    });

    it('counts shared markers at 0.3 each and toward no register', () => {
        const s = registerSignals(['بس يعني كمان يلا عشان']);
        assert.deepEqual(s.shared.distinct.sort(), ['بس', 'عشان', 'كمان', 'يعني', 'يلا'].sort());
        assert.ok(Math.abs(s.shared.weight - 1.5) < 1e-9);
        assert.deepEqual(s.scores, { msa: 0, gulf: 0, egyptian: 0, levantine: 0 });
        assert.ok(s.dialectPer100 > 0, 'but they do count toward "this is not فصحى"');
    });

    it('reads a marker through hamza, ya and ta-marbuta variants, diacritics and tatweel', () => {
        for (const spelling of ['أبغى', 'ابغى', 'ابغي', 'أَبْغَى']) assert.ok(registerSignals([spelling]).markers.gulf.includes('ابغي'), spelling);
        assert.ok(registerSignals(['إزاي', 'ازاي', 'ازّاي']).markers.egyptian.includes('ازاي'));
        assert.ok(registerSignals(['وشـــ']).markers.gulf.includes('وش'));
        assert.ok(registerSignals(['يسوّي']).markers.gulf.includes('يسوي'));
        assert.ok(registerSignals(['هلّق']).markers.levantine.includes('هلق'));
    });

    it('finds a marker behind the conjunction و, but only for markers of three letters or more', () => {
        assert.ok(registerSignals(['وابغى', 'والحين', 'وكذا']).markers.gulf.length === 3);
        assert.ok(registerSignals(['وسوف']).markers.msa.includes('سوف'));
        assert.deepEqual(registerSignals(['ومش']).markers.egyptian, [], 'a two-letter marker is not read behind a و');
        assert.deepEqual(registerSignals(['وبس']).shared.distinct, []);
        assert.deepEqual(registerSignals(['وشاح']).markers.gulf, []);
    });

    it('reads the two-word markers: عم and رح before a present verb, لم and لن before one for فصحى', () => {
        assert.deepEqual(registerSignals(['عم نشرح', 'رح نبلش']).markers.levantine.sort(), ['رح+فعل', 'عم+فعل']);
        assert.deepEqual(registerSignals(['لم يفعل', 'لن نتوقف']).markers.msa.sort(), ['لم+فعل', 'لن+فعل']);
        assert.deepEqual(registerSignals(['عم']).markers.levantine, [], 'alone it is nothing');
        assert.deepEqual(registerSignals(['عم الشارع']).markers.levantine, [], 'before a word that is not a present verb');
        assert.deepEqual(registerSignals(['وعم يشتغل']).markers.levantine, ['عم+فعل']);
    });

    it('does not read Latin text, digits or emoji as anything', () => {
        const s = registerSignals(['hello world 123 😀 wesh kza', '١٢٣ !!! ---']);
        assert.deepEqual(s.scores, { msa: 0, gulf: 0, egyptian: 0, levantine: 0 });
        assert.equal(s.dialectPer100, 0);
    });

    it('handles no captions', () => {
        const s = registerSignals([]);
        assert.deepEqual([s.words, s.captions, s.dialectPer100], [0, 0, 0]);
    });
});

describe('call-to-action lines', () => {
    it('recognises a line that asks for a comment, or ends in 📩 or 👇', () => {
        for (const line of ['اكتب "كورس" وأرسل لك الرابط', 'علّق بكلمة ابدأ', 'علق وراح يوصلك', 'Comment START below', 'comment the word', 'التفاصيل هنا 📩', 'اضغط هنا 👇', 'اضغط هنا 👇🏽', 'اضغط هنا 👇️  ', 'اكتبوا لنا']) {
            assert.equal(isCtaLine(line), true, line);
        }
        for (const line of ['', '   ', 'سوف نتعرف على الأساسيات', 'Learn to code from scratch', 'يوم جميل 😀', 'هذا مكتوب بخط جميل', '👇 فوق السهم']) {
            assert.equal(isCtaLine(line), false, line);
        }
    });

    it('splits a caption into its body and its asks', () => {
        const { body, cta } = splitCaption('سوف نبدأ اليوم.\nاكتب "برمجة" لتصلك المواد 📩\nنهاية');
        assert.equal(body, 'سوف نبدأ اليوم.\nنهاية');
        assert.deepEqual(cta, ['اكتب "برمجة" لتصلك المواد 📩']);
    });

    it('scores the asks apart from the bodies', () => {
        const s = registerSignals(MSA_WITH_GULF_ASKS);
        assert.deepEqual([s.scores.gulf, s.captionsWith.gulf], [0, 0], 'the body has no Gulf in it');
        assert.equal(s.cta.captionsWith.gulf, 3);
        assert.equal(s.cta.lines, 3);
    });
});

describe('decideRegister: the verdicts', () => {
    const verdict = (captions: readonly string[]) => decideRegister(registerSignals(captions));

    it('names a dialect when its markers dominate', () => {
        for (const [captions, register] of [[GULF, 'gulf'], [EGYPTIAN, 'egyptian'], [LEVANTINE, 'levantine']] as const) {
            const d = verdict(captions);
            assert.equal(d.register, register);
            assert.equal(d.confidence, 'high');
            assert.equal(d.reason, 'dialect');
            assert.equal(d.suggested, register);
        }
    });

    it('names فصحى when there is hardly any dialect', () => {
        const d = verdict(MSA);
        assert.deepEqual([d.register, d.confidence, d.reason, d.suggested], ['msa', 'high', 'msa', 'msa']);
    });

    it('calls a فصحى body with Gulf asks "mixed", says why, and suggests فصحى until a person chooses', () => {
        const d = verdict(MSA_WITH_GULF_ASKS);
        assert.deepEqual([d.register, d.confidence, d.reason, d.ctaRegister, d.suggested], ['mixed', 'low', 'mixed_cta', 'gulf', 'msa']);
    });

    it('calls two dialects of equal weight "mixed", and defaults a low-confidence result to فصحى', () => {
        const d = verdict(MIXED);
        assert.deepEqual([d.register, d.confidence, d.reason, d.suggested], ['mixed', 'low', 'mixed', 'msa']);
    });

    it('is not a verdict at all for too few words', () => {
        const d = verdict(['وش رايك الحين؟ زين كذا']);
        assert.deepEqual([d.register, d.confidence, d.reason, d.suggested], ['msa', 'low', 'too_little_text', 'msa']);
        assert.equal(verdict([]).reason, 'too_little_text');
    });

    /** Signals built by hand to hit each threshold from both sides. */
    const base = (over: Partial<RegisterSignals> & { gulf?: number; egyptian?: number; gulfMarkers?: number; gulfCaptions?: number }): RegisterSignals => ({
        scores: { msa: 0, gulf: over.gulf ?? 0, egyptian: over.egyptian ?? 0, levantine: 0 },
        markers: { msa: [], gulf: Array.from({ length: over.gulfMarkers ?? 0 }, (_, i) => `g${i}`), egyptian: [], levantine: [] },
        captionsWith: { msa: 0, gulf: over.gulfCaptions ?? 0, egyptian: 0, levantine: 0 },
        shared: { distinct: [], weight: 0 },
        words: 200,
        dialectPer100: 10,
        cta: { scores: { msa: 0, gulf: 0, egyptian: 0, levantine: 0 }, captionsWith: { msa: 0, gulf: 0, egyptian: 0, levantine: 0 }, lines: 0 },
        captions: 10,
        ...Object.fromEntries(Object.entries(over).filter(([k]) => !['gulf', 'egyptian', 'gulfMarkers', 'gulfCaptions'].includes(k))),
    });

    it('requires a score at least twice the runner-up\'s', () => {
        assert.equal(decideRegister(base({ gulf: 10, egyptian: 5, gulfMarkers: 5, gulfCaptions: 5 })).register, 'gulf');
        assert.equal(decideRegister(base({ gulf: 10, egyptian: 6, gulfMarkers: 5, gulfCaptions: 5 })).register, 'mixed');
        assert.equal(decideRegister(base({ gulf: 10, egyptian: 5.1, gulfMarkers: 5, gulfCaptions: 5 })).register, 'mixed');
    });

    it('requires at least 3 distinct markers', () => {
        assert.equal(decideRegister(base({ gulf: 9, gulfMarkers: 3, gulfCaptions: 5 })).register, 'gulf');
        assert.equal(decideRegister(base({ gulf: 9, gulfMarkers: 2, gulfCaptions: 5 })).register, 'mixed');
    });

    it('requires the markers across at least 3 captions', () => {
        assert.equal(decideRegister(base({ gulf: 9, gulfMarkers: 3, gulfCaptions: 3 })).register, 'gulf');
        assert.equal(decideRegister(base({ gulf: 9, gulfMarkers: 3, gulfCaptions: 2 })).register, 'mixed');
    });

    it('names فصحى below 0.5 dialect markers per 100 words, and not at it', () => {
        assert.equal(decideRegister(base({ dialectPer100: 0.49 })).register, 'msa');
        assert.equal(decideRegister(base({ dialectPer100: 0.5 })).register, 'mixed');
        assert.equal(decideRegister(base({ dialectPer100: 0 })).register, 'msa');
    });

    it('asks for at least two captions with a dialect ask before it calls a فصحى body "mixed"', () => {
        const ask = (captions: number) => base({ dialectPer100: 0.1, cta: { scores: { msa: 0, gulf: captions, egyptian: 0, levantine: 0 }, captionsWith: { msa: 0, gulf: captions, egyptian: 0, levantine: 0 }, lines: captions } });
        assert.equal(decideRegister(ask(1)).register, 'msa');
        assert.equal(decideRegister(ask(2)).register, 'mixed');
    });
});

describe('language by script', () => {
    it('tells Arabic, English and both apart, and says nothing for too little', () => {
        assert.equal(languageOfCaptions(GULF), 'ar');
        assert.equal(languageOfCaptions(MSA), 'ar');
        assert.equal(languageOfCaptions(ENGLISH), 'en');
        assert.equal(languageOfCaptions([...GULF.slice(0, 2), ...ENGLISH.slice(0, 2)]), 'mixed');
        assert.equal(languageOfCaptions(['hi']), null);
        assert.equal(languageOfCaptions([]), null);
        assert.equal(languageOfCaptions(['123 456 😀😀 !!!']), null);
    });

    it('decides no Arabic register for English captions: the caller reads the language first', () => {
        const signals = computeSignals({ sources: ENGLISH.map((text, i) => ({ id: `p${i + 1}`, kind: 'ig_caption' as const, text })) });
        assert.equal(signals.language, 'en');
        assert.deepEqual(signals.register.scores, { msa: 0, gulf: 0, egyptian: 0, levantine: 0 });
    });
});

describe('computeSignals', () => {
    const captions = (set: readonly string[]) => set.map((text, i) => ({ id: `p${i + 1}`, kind: 'ig_caption' as const, text }));

    it('turns captions into the facts the model is shown', () => {
        const s = computeSignals({ sources: [...captions(GULF), { id: 'bio', kind: 'ig_bio', text: 'مبرمج' }], keywordsInUse: ['كورس'], handle: 'someone', siteHost: 'x.example', followers: 1200, mediaCount: 40 });
        assert.equal(s.language, 'ar');
        assert.deepEqual([s.register.verdict, s.register.confidence, s.register.suggested], ['gulf', 'high', 'gulf']);
        assert.equal(s.counts.captions, 6);
        assert.equal(s.counts.sources, 7);
        assert.deepEqual(s.keywords_in_use, ['كورس']);
        assert.deepEqual([s.handle, s.site_host, s.followers, s.media_count], ['someone', 'x.example', 1200, 40]);
        assert.ok(s.register.distinct_markers.gulf >= 10);
        assert.equal(s.register.cta_register, null);
    });

    it('counts the digits and the emoji the creator uses', () => {
        const s = computeSignals({ sources: captions(['الدورة ٣ ساعات ٢٠ درس 😀😀🔥', 'خصم ١٠٪ اليوم 🎉', 'سجّل الآن 👇']) });
        assert.equal(s.digits.arabic_indic, 5);
        assert.equal(s.digits.latin, 0);
        assert.equal(s.emoji.level, 'light');
        assert.equal(computeSignals({ sources: captions(['Course 3 hours', '20 lessons', '10% off']) }).digits.latin, 5);
        assert.equal(computeSignals({ sources: captions(['no emoji here at all', 'none here either', 'nor here']) }).emoji.level, 'none');
        assert.equal(computeSignals({ sources: captions(['😀😀😀😀😀 x', '🔥🔥🔥🔥🔥 y', '🎉🎉🎉🎉🎉 z']) }).emoji.level, 'rich');
    });

    it('says what is missing as null and empty, not as a guess', () => {
        const s = computeSignals({ sources: [] });
        assert.deepEqual([s.language, s.counts.captions, s.handle, s.followers, s.candidates, s.keywords_in_use], [null, 0, null, null, [], []]);
        assert.equal(s.register.reason, 'too_little_text');
    });
});
