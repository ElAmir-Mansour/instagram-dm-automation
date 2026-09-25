import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Carousel, Slide } from './carouselTypes.js';
import { ARABIC_EXAMPLES, ENGLISH_EXAMPLES } from './examples.js';
import {
    StudioGenerationError,
    altTextFor,
    chooseKeyword,
    generateDraft,
    normalizeInstagramCaption,
    normalizeTiktokCaption,
    pickAccent,
    pickAccents,
    planWeek,
    rewriteSlide,
    setModelCaller,
    shotName,
    toArabicDigits,
    trimText,
    type CallModel,
    type GenContext,
    type GenSource,
    type LessonRow,
    type ModelRequest,
    type Moment,
} from './generate.js';
import { buildDm } from './prompts.js';
import { ALT_TEXT_BUDGET, fillKeyword, validateCarousel } from './rules.js';
import { DEFAULT_PALETTE } from './settingsTypes.js';
import { ELAMIR_SETTINGS as AR, ENGLISH_SETTINGS as EN, SECTION_8_DM } from './testFixtures.js';

// No test may reach Gemini: the module's own caller fails loudly for the whole file.
let restoreCaller: CallModel;
before(() => { restoreCaller = setModelCaller(async () => { throw new Error('network disabled in tests'); }); });
after(() => { setModelCaller(restoreCaller); });

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────

const LESSON_ID = '11111111-1111-4111-8111-111111111111';
const moment = (n: number, clean: boolean, t: number, description: string): Moment => ({
    id: `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, lesson_id: LESSON_ID, t, description, kind: 'result', clean, thumb_url: null,
});
/** Sorted by t, so their catalog aliases are M1…M5 in this order. M3 isn't clean. */
const MOMENTS: Moment[] = [
    moment(1, true, 12, 'A laptop with a lock on screen'),
    moment(2, true, 95.5, 'The model answering with Wi-Fi off'),
    moment(3, false, 130, 'Arrows scribbled over the settings'),
    moment(4, true, 200, 'RAG answering from a PDF'),
    moment(5, true, 250, 'The model list in LM Studio'),
];
const idOf = (alias: string): string => MOMENTS[Number(alias.slice(1)) - 1]!.id;

const LESSON: LessonRow = {
    id: LESSON_ID, lesson_no: '8.3', title: 'Local RAG with LM Studio', section_no: 8,
    section_title: 'Chapter 8 - Local RAG lmstudio', status: 'indexed',
    notes: {
        summary: 'تشغيل نموذج على جهازك والإجابة من ملفاتك.',
        points: [{ title: 'ليش محلي', detail: 'الملفات ما تطلع من الجهاز', t: 10 }, { title: 'LM Studio', detail: 'تنزيل نموذج مفتوح', t: 60 }],
        prompts: [{ text: 'جاوب فقط من المستندات المرفقة', t: 210 }],
        tools: ['LM Studio'],
        demos: [{ title: 'بدون إنترنت', result: 'النموذج يجاوب والنت مفصول', t: 95 }],
    },
};
const SOURCES: GenSource[] = [{ lesson: LESSON, moments: MOMENTS }];

const ctx = (over: Partial<GenContext> = {}): GenContext =>
    ({ recentTopics: [], recentAccents: [], activeKeywords: [], settings: AR, ...over });

const localAI = ARABIC_EXAMPLES[2]!;
const LOCAL_MOMENTS: Record<string, string> = { 'local-hero': 'M1', 'local-offline': 'M2', 'local-rag': 'M4' };

type Flat = { slides: Record<string, any>[]; captions: Carousel['captions']; [k: string]: any };

/** A typed carousel in the model's flat output format, every middle slide citing `sources`. */
function toFlat(c: Carousel, moments: Record<string, string> = LOCAL_MOMENTS, sources: string[] = ['L1.point1']): Flat {
    return {
        id: c.id, keyword: c.keyword, keywordAlternatives: [], variants: [],
        slides: c.slides.map((s) => {
            const f: Record<string, any> = { ...structuredClone(s), sources: s.kind === 'cover' || s.kind === 'cta' ? [] : sources };
            if ('shot' in s && s.shot) { f.momentId = moments[s.shot.name] ?? s.shot.name; delete f.shot; }
            if (s.kind === 'compare') {
                Object.assign(f, { leftLabel: s.left.label, leftItems: s.left.items, rightLabel: s.right.label, rightItems: s.right.items });
                delete f.left; delete f.right;
            }
            return f;
        }),
        captions: { ...c.captions },
        dmQuestion: 'تبي ذكاء اصطناعي شغّال على جهازك؟ 🔒',
        dmPitch: 'في قسم الذكاء المحلي أشرح لك كيف تشغّله خطوة بخطوة.',
    };
}

/** A model that answers from a script (the last answer repeats) and records every request. */
function fakeModel(...answers: unknown[]): { call: CallModel; requests: ModelRequest[] } {
    const requests: ModelRequest[] = [];
    let i = 0;
    return {
        requests,
        call: async (req) => {
            requests.push(structuredClone(req));
            const a = answers[Math.min(i++, answers.length - 1)];
            if (a instanceof Error) throw a;
            return structuredClone(a);
        },
    };
}
const lastTurn = (req: ModelRequest | undefined): string => req?.turns.at(-1)?.text ?? '';

const hasLoneSurrogate = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const bracketsBalanced = (s: string): boolean => (s.match(/\[/g) ?? []).length === (s.match(/\]/g) ?? []).length && !/\[[^\]]*$/.test(s);

// ─── The happy path ─────────────────────────────────────────────────────────────────────────

describe('generateDraft: an approved carousel through the flat format', () => {
    it('comes back identical, valid, in one call', async () => {
        const m = fakeModel(toFlat(localAI));
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 1);
        const expected = localAI.slides.map((s) =>
            'shot' in s && s.shot ? { ...s, shot: { name: shotName(idOf(LOCAL_MOMENTS[s.shot.name]!)) } } : s);
        assert.deepEqual(out.carousel.slides, expected);
        assert.deepEqual(out.carousel.captions, localAI.captions);
        assert.equal(out.carousel.id, 'LocalAI');
        assert.deepEqual(validateCarousel(out.carousel, new Set(Object.keys(out.shots)), AR), []);
    });

    it('sends the tenant\'s system prompt, schema and model settings', async () => {
        const m = fakeModel(toFlat(localAI));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        const req = m.requests[0]!;
        assert.equal(req.purpose, 'draft');
        assert.equal(req.schema.type, 'OBJECT');
        assert.ok(req.schema.properties?.slides, 'the draft schema has slides');
        assert.ok(req.system.includes(AR.voice.guide), 'the voice guide comes from settings');
        assert.ok(req.system.includes(fillKeyword(AR.cta.instagramAsk, 'KEYWORD')), 'the ask comes from settings');
        assert.ok(req.system.includes(AR.cta.tiktokLine), 'the TikTok line comes from settings');
        assert.ok(req.system.includes('Never mention: MCP'), 'the avoid list comes from settings');
        assert.ok(req.timeoutMs > 0 && req.timeoutMs <= 120_000);
        assert.ok(req.turns[0]!.text.includes('[M1]') && req.turns[0]!.text.includes('[L1.point1]'), 'the sources are catalogued');
    });

    it('uses the module-level caller when no callModel is passed', async () => {
        const m = fakeModel(toFlat(localAI));
        const previous = setModelCaller(m.call);
        try {
            await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx());
        } finally {
            setModelCaller(previous);
        }
        assert.equal(m.requests.length, 1);
    });
});

// ─── Shots ──────────────────────────────────────────────────────────────────────────────────

describe('generateDraft: shots', () => {
    it('maps each clean moment id to a ShotSpec at its t, zoom 1.3, focus at the centre', async () => {
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(toFlat(localAI)).call });
        assert.deepEqual(Object.keys(out.shots).sort(), ['M1', 'M2', 'M4'].map((a) => shotName(idOf(a))).sort());
        assert.deepEqual(out.shots[shotName(idOf('M2'))], {
            lessonId: LESSON_ID, t: 95.5, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'The model answering with Wi-Fi off',
        });
    });

    it('accepts a moment by alias, by id, or by shot name', async () => {
        const flat = toFlat(localAI, { 'local-hero': 'm1', 'local-offline': idOf('M2'), 'local-rag': `m-${idOf('M4')}` });
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(flat).call });
        assert.equal(Object.keys(out.shots).length, 3);
    });

    it('drops unclean and unknown moment ids from their slides; a shot slide without one becomes a point', async () => {
        const flat = toFlat(localAI, { 'local-hero': 'M3', 'local-offline': 'M3', 'local-rag': 'M99' });
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(flat).call });
        const [cover, , offline] = out.carousel.slides;
        assert.equal(cover?.kind, 'cover');
        assert.equal((cover as { shot?: unknown }).shot, undefined);
        assert.deepEqual(offline, { kind: 'point', title: 'النت مفصول… وهو شغّال', body: 'بدون إنترنت، والنموذج يجاوبك من جهازك. شوفه يقولها بنفسه' });
        assert.ok(out.carousel.slides.every((s) => !('shot' in s) || !s.shot));
        assert.deepEqual(out.shots, {});
    });

    it('keeps at most 3 screenshots, dropping the extras', async () => {
        const flat = toFlat(localAI);
        flat.slides[3] = { kind: 'point', sources: ['L1.point1'], title: 'قائمة النماذج', body: 'تختار النموذج من القائمة', momentId: 'M5' };
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(flat).call });
        assert.equal(Object.keys(out.shots).length, 3);
        assert.equal(out.carousel.slides.filter((s) => 'shot' in s && s.shot).length, 3);
    });
});

// ─── Repair and trimming ────────────────────────────────────────────────────────────────────

const LONG_TITLE = `${localAI.slides[0]!.kind === 'cover' ? (localAI.slides[0] as { title: string }).title : ''} وبدون اشتراك`;

describe('generateDraft: repair', () => {
    it('sends validateCarousel\'s problems back to the model and takes its fix', async () => {
        const bad = toFlat(localAI);
        bad.slides[0]!.title = LONG_TITLE;
        const m = fakeModel(bad, toFlat(localAI));
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 2);
        const repair = m.requests[1]!;
        assert.equal(repair.purpose, 'repair');
        assert.equal(repair.turns.at(-2)?.role, 'model', 'the model sees its own answer');
        assert.deepEqual(JSON.parse(repair.turns.at(-2)!.text).slides[0].title, LONG_TITLE);
        assert.ok(lastTurn(repair).includes(`slide 1 (cover).title: ${LONG_TITLE.length} > 34 «${LONG_TITLE}»`), lastTurn(repair));
        assert.equal((out.carousel.slides[0] as { title: string }).title, (localAI.slides[0] as { title: string }).title);
    });

    it('stops after 2 repair rounds, then trims without splitting an emoji or a [placeholder]', async () => {
        const bad = toFlat(localAI);
        bad.slides[0]!.title = LONG_TITLE;
        const prompt = bad.slides.find((s) => s.kind === 'prompt')!;
        prompt.prompt = 'خلّه يجاوب من [اسم الملف] بس 📄 '.repeat(14).trim();
        const m = fakeModel(bad);
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 3, 'one draft and two repairs');
        const cover = out.carousel.slides[0] as Extract<Slide, { kind: 'cover' }>;
        assert.ok(cover.title.length <= 34);
        assert.ok(!cover.highlight || cover.title.includes(cover.highlight));
        const trimmed = (out.carousel.slides.find((s) => s.kind === 'prompt') as Extract<Slide, { kind: 'prompt' }>).prompt;
        assert.ok(trimmed.length <= 320 && trimmed.length > 200, `${trimmed.length}`);
        assert.ok(!hasLoneSurrogate(trimmed) && bracketsBalanced(trimmed), trimmed);
        assert.deepEqual(validateCarousel(out.carousel, new Set(Object.keys(out.shots)), AR), []);
    });

    it('skips a repair the budget can\'t fit, and trims instead', async () => {
        const bad = toFlat(localAI);
        bad.slides[0]!.title = LONG_TITLE;
        const m = fakeModel(bad);
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call, timeoutMs: 30_000 });
        assert.equal(m.requests.length, 1);
        assert.ok((out.carousel.slides[0] as { title: string }).title.length <= 34);
    });

    it('keeps the better answer when a repair makes things worse', async () => {
        const good = toFlat(localAI);
        good.slides[0]!.title = LONG_TITLE;
        const worse = toFlat(localAI);
        worse.slides[0]!.kind = 'point';
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(good, worse).call });
        assert.equal(out.carousel.slides[0]!.kind, 'cover');
    });

    it('throws a clear StudioGenerationError when a problem survives trimming', async () => {
        const bad = toFlat(localAI);
        bad.slides[0]!.kind = 'point';
        const m = fakeModel(bad);
        await assert.rejects(
            generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call }),
            (err: unknown) => err instanceof StudioGenerationError
                && err.problems.includes('first slide must be cover')
                && err.message.includes('after 2 repair round(s)'),
        );
        assert.equal(m.requests.length, 3);
    });

    it('retries a transient failure of the first call once', async () => {
        const transient = Object.assign(new Error('Gemini request failed [HTTP 503]: overloaded'), { retryable: true });
        const m = fakeModel(transient, toFlat(localAI));
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 2);
        assert.equal(out.carousel.slides.length, 8);
    });

    it('does not retry a permanent failure', async () => {
        const permanent = Object.assign(new Error('Gemini request failed [HTTP 400]: bad schema'), { retryable: false });
        const m = fakeModel(permanent);
        await assert.rejects(generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call }), /HTTP 400/);
        assert.equal(m.requests.length, 1);
    });
});

// ─── Sources ────────────────────────────────────────────────────────────────────────────────

describe('generateDraft: sources', () => {
    it('sends a slide with no sources back for repair', async () => {
        const bad = toFlat(localAI);
        bad.slides[3]!.sources = [];
        const m = fakeModel(bad, toFlat(localAI));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 2);
        assert.ok(lastTurn(m.requests[1]).includes('slide 4 (stat): no sources'), lastTurn(m.requests[1]));
    });

    it('doesn\'t count ids the catalog doesn\'t have', async () => {
        const bad = toFlat(localAI);
        bad.slides[3]!.sources = ['L9.point1', 'banana'];
        const m = fakeModel(bad, toFlat(localAI));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.ok(lastTurn(m.requests[1]).includes('slide 4 (stat): no sources'));
    });

    it('drops a slide that stays unsourced when the carousel can spare it', async () => {
        const bad = toFlat(localAI);
        bad.slides[3]!.sources = [];
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(bad).call });
        assert.equal(out.carousel.slides.length, 7);
        assert.ok(!out.carousel.slides.some((s) => s.kind === 'stat'));
    });

    it('throws when an unsourced slide can\'t be spared', async () => {
        const six = toFlat(localAI);
        six.slides.splice(1, 2);
        six.slides[1]!.sources = [];
        await assert.rejects(
            generateDraft({ lessonIds: [LESSON_ID], slides: 6 }, SOURCES, ctx(), { callModel: fakeModel(six).call }),
            (err: unknown) => err instanceof StudioGenerationError && err.problems.some((p) => p.startsWith('slide 2 (stat): no sources')),
        );
    });

    it('catalogues product facts and the idea as citable sources', async () => {
        const flat = toFlat(localAI, LOCAL_MOMENTS, ['facts']);
        const m = fakeModel(flat);
        await generateDraft({ lessonIds: [], idea: 'الذكاء المحلي' }, [], ctx(), { callModel: m.call });
        const text = m.requests[0]!.turns[0]!.text;
        assert.ok(text.includes('[facts]') && text.includes('٣٤ درس') && text.includes('[idea]'), text);
    });
});

// ─── Keyword and campaign ───────────────────────────────────────────────────────────────────

describe('generateDraft: keyword and campaign', () => {
    it('passes over a keyword that overlaps a live campaign, to the next candidate', async () => {
        const flat = toFlat(localAI);
        flat.keyword = 'متجري';
        flat.keywordAlternatives = ['محلي'];
        flat.captions.instagram = flat.captions.instagram.replace('"محلي"', '"متجري"');
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ activeKeywords: ['متجر', 'وكيل'] }), { callModel: fakeModel(flat).call });
        assert.equal(out.campaign.keyword, 'محلي');
        assert.equal(out.campaign.create, true);
        assert.ok(out.carousel.captions.instagram.includes(fillKeyword(AR.cta.instagramAsk, 'محلي')));
        assert.ok(!out.carousel.captions.instagram.includes('متجري'));
    });

    it('reuses a live keyword that fits, in its own spelling, and creates no campaign', async () => {
        const flat = toFlat(localAI);
        flat.keyword = 'اوبال';
        flat.captions.instagram = flat.captions.instagram.replace('"محلي"', '"اوبال"');
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ activeKeywords: ['أوبال'] }), { callModel: fakeModel(flat).call });
        assert.deepEqual([out.campaign.keyword, out.campaign.create, out.campaign.variants], ['أوبال', false, []]);
        assert.equal(out.carousel.keyword, 'أوبال');
        assert.ok(out.carousel.captions.instagram.includes(fillKeyword(AR.cta.instagramAsk, 'أوبال')));
    });

    it('splits a comma-separated trigger list', () => {
        assert.deepEqual(chooseKeyword(['محلي'], ['خصم, كوبون، محلي']).choice, { keyword: 'محلي', create: false });
        assert.deepEqual(chooseKeyword(['كوب'], ['خصم, كوبون']).rejected, ['«كوب» overlaps the active keyword «كوبون»']);
    });

    it('sends the model back when every candidate collides', async () => {
        const flat = toFlat(localAI);
        flat.keyword = 'متجري';
        const m = fakeModel(flat, toFlat(localAI));
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ activeKeywords: ['متجر'] }), { callModel: m.call });
        assert.ok(lastTurn(m.requests[1]).includes('keyword: no usable candidate («متجري» overlaps the active keyword «متجر»)'), lastTurn(m.requests[1]));
        assert.equal(out.campaign.keyword, 'محلي');
    });

    it('uses the operator\'s keyword as given, and rewrites the ask to match', async () => {
        const out = await generateDraft({ lessonIds: [LESSON_ID], keyword: 'سياق' }, SOURCES, ctx(), { callModel: fakeModel(toFlat(localAI)).call });
        assert.deepEqual([out.campaign.keyword, out.campaign.create], ['سياق', true]);
        assert.ok(out.carousel.captions.instagram.includes(fillKeyword(AR.cta.instagramAsk, 'سياق')));
        assert.ok(!out.carousel.captions.instagram.includes('"محلي"'));
        const reused = await generateDraft({ lessonIds: [LESSON_ID], keyword: 'سياق' }, SOURCES, ctx({ activeKeywords: ['سياق'] }), { callModel: fakeModel(toFlat(localAI)).call });
        assert.equal(reused.campaign.create, false);
    });

    it('rejects a multi-word keyword before calling the model', async () => {
        const m = fakeModel(toFlat(localAI));
        await assert.rejects(generateDraft({ lessonIds: [LESSON_ID], keyword: 'كلمتين هنا' }, SOURCES, ctx(), { callModel: m.call }), StudioGenerationError);
        assert.equal(m.requests.length, 0);
    });

    it('keeps variants that are one word, not redundant and not colliding', async () => {
        const flat = toFlat(localAI);
        flat.variants = ['المحلي', 'local', 'loc al', 'متجر', 'mahali', 'lo'];
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ activeKeywords: ['متجر'] }), { callModel: fakeModel(flat).call });
        assert.deepEqual(out.campaign.variants, ['local', 'mahali']);
    });

    it('builds the DM from the tenant template, changing only the two topical lines', async () => {
        const flat = toFlat(localAI);
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(flat).call });
        const expected = SECTION_8_DM
            .replace('<question line about the topic>', flat.dmQuestion)
            .replace('<one-sentence pitch naming the course section>', flat.dmPitch);
        assert.equal(out.campaign.dm, expected);
    });
});

describe('buildDm', () => {
    const fill = (question: string, pitch: string) =>
        buildDm(AR.cta.dmTemplate, { question, pitch, url: AR.product.url, bullets: AR.product.dmBullets });

    it('reproduces STUDIO.md §8 exactly, apart from lines 3 and 5', () => {
        const got = fill('سؤال عن الموضوع؟', 'جملة تذكر القسم.').split('\n');
        const want = SECTION_8_DM.split('\n');
        assert.equal(got.length, want.length);
        want.forEach((l, i) => {
            if (i === 2) assert.equal(got[i], 'سؤال عن الموضوع؟');
            else if (i === 4) assert.equal(got[i], 'جملة تذكر القسم.');
            else assert.equal(got[i], l, `line ${i + 1}`);
        });
    });

    it('matches the contract text in STUDIO.md, when the file is there', { skip: !fs.existsSync(path.resolve('STUDIO.md')) }, () => {
        const md = fs.readFileSync(path.resolve('STUDIO.md'), 'utf8');
        const block = /## 8\. The DM template\s+```\n([\s\S]*?)\n```/.exec(md)?.[1];
        assert.equal(block, SECTION_8_DM);
    });

    it('flattens a multi-line answer, keeps {username}, and drops the line of an empty value', () => {
        const dm = buildDm('Hi {username}\n\n{question}\n\n{url}\n\n{bullets}\n\nBye', { question: 'one\ntwo', pitch: '', url: '', bullets: ['A', '• B'] });
        assert.equal(dm, 'Hi {username}\n\none two\n\n✅ A\n• B\n\nBye');
    });

    it('is safe against $ patterns in the model\'s lines', () => {
        assert.ok(fill('$& $1', 'x').includes('\n$& $1\n'));
    });
});

// ─── Accent ─────────────────────────────────────────────────────────────────────────────────

describe('accent', () => {
    it('comes from the brand palette, avoiding recent accents', async () => {
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ recentAccents: ['#FFD60A', '#ff8a3d'] }), { callModel: fakeModel(toFlat(localAI)).call });
        assert.equal(out.carousel.accent, '#22D39A');
    });

    it('honours a valid requested accent', async () => {
        const out = await generateDraft({ lessonIds: [LESSON_ID], accent: '#abcdef' }, SOURCES, ctx(), { callModel: fakeModel(toFlat(localAI)).call });
        assert.equal(out.carousel.accent, '#ABCDEF');
    });

    it('pickAccent: skips recent colours, then falls back to the least recently used', () => {
        const palette = ['#111111', '#222222', '#333333'];
        assert.equal(pickAccent(undefined, palette, ['#111111']), '#222222');
        assert.equal(pickAccent(undefined, palette, ['#333333', '#111111', '#222222']), '#222222');
        assert.equal(pickAccent('red', palette, []), '#111111');
        assert.equal(pickAccent(undefined, ['nope'], []), DEFAULT_PALETTE[0]);
    });

    it('pickAccents: gives each proposal its own colour', () => {
        assert.deepEqual(pickAccents(3, ['#111111', '#222222', '#333333'], ['#222222']), ['#111111', '#333333', '#222222']);
    });

    it('uses ctx.palette only when the brand palette is empty', async () => {
        const settings = { ...AR, brand: { ...AR.brand, palette: [] } };
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ settings, palette: ['#010203'] }), { callModel: fakeModel(toFlat(localAI)).call });
        assert.equal(out.carousel.accent, '#010203');
    });
});

// ─── Captions ───────────────────────────────────────────────────────────────────────────────

describe('captions', () => {
    for (const ex of ARABIC_EXAMPLES) {
        it(`leaves ${ex.id}'s approved captions exactly as they are`, () => {
            assert.equal(normalizeInstagramCaption(ex.captions.instagram, ex.keyword, [], AR), ex.captions.instagram);
            assert.equal(normalizeTiktokCaption(ex.captions.tiktok, [ex.keyword], AR), ex.captions.tiktok);
        });
    }

    it('leaves the English example\'s captions as they are, under the English settings', () => {
        const ex = ENGLISH_EXAMPLES[0]!;
        assert.equal(normalizeInstagramCaption(ex.captions.instagram, ex.keyword, [], EN), ex.captions.instagram);
        assert.equal(normalizeTiktokCaption(ex.captions.tiktok, [ex.keyword], EN), ex.captions.tiktok);
    });

    it('adds a missing ask and save line before the hashtags', () => {
        const got = normalizeInstagramCaption('الهوك 🔒\n\n🔒 فايدة\n\n#تقنية #AI', 'محلي', [], AR);
        assert.equal(got, `الهوك 🔒\n\n🔒 فايدة\n\nاحفظ المنشور 🔖\n\n${fillKeyword(AR.cta.instagramAsk, 'محلي')}\n\n#تقنية #AI`);
    });

    it('replaces a reworded ask with the tenant\'s exact line, once', () => {
        const got = normalizeInstagramCaption('هوك\n\nاكتب «محلي» في التعليقات ويوصلك الرابط بالخاص\n\nاكتب "محلي" بالتعليقات ويوصلك رابط الكورس بالخاص.\n\nاحفظ المنشور 🔖', 'محلي', [], AR);
        assert.equal(got.split(fillKeyword(AR.cta.instagramAsk, 'محلي')).length, 2, got);
        assert.ok(!got.includes('في التعليقات'));
    });

    it('keeps the hook first when the ask it removes was the opening paragraph', () => {
        const got = normalizeTiktokCaption('اكتب "محلي" بالتعليقات ويوصلك رابط الكورس بالخاص 📩\n\nهوك\n\n#تقنية', ['محلي'], AR);
        assert.equal(got, `هوك\n\n${AR.cta.tiktokLine}\n\n#تقنية #تعلم_على_تيك_توك #LearnOnTikTok`);
    });

    it('leaves a value line that only shares a few words with the ask', () => {
        const ig = 'Hook 🎯\n\n👉 Comment on the draft and you get the link to the checklist\n\n#AI #Work';
        const got = normalizeInstagramCaption(ig, 'goal', [], EN);
        assert.ok(got.includes('👉 Comment on the draft and you get the link to the checklist'), got);
        assert.ok(got.includes('Comment "goal" and I\'ll DM you the link 📩'), got);
        const tt = normalizeTiktokCaption('Hook\n\nThe full course covers the basics\n\n#AI', ['goal'], EN);
        assert.equal(tt, `Hook\n\nThe full course covers the basics\n\n${EN.cta.tiktokLine}\n\n#AI #LearnOnTikTok`);
    });

    it('still catches an ask reworded without quotes', () => {
        const got = normalizeInstagramCaption('Hook\n\nComment goal and I\'ll DM you the link\n\n#AI', 'goal', [], EN);
        assert.equal(got, 'Hook\n\nSave this post 🔖\n\nComment "goal" and I\'ll DM you the link 📩\n\n#AI');
    });

    it('takes the keyword ask off TikTok and adds the link line and learning tags', () => {
        const got = normalizeTiktokCaption('هوك\n\nاكتب "محلي" بالتعليقات ويوصلك رابط الكورس بالخاص 📩\n\n#تقنية', ['محلي'], AR);
        assert.equal(got, `هوك\n\n${AR.cta.tiktokLine}\n\n#تقنية #تعلم_على_تيك_توك #LearnOnTikTok`);
    });
});

// ─── Trimming and digits ────────────────────────────────────────────────────────────────────

describe('trimText', () => {
    it('leaves text within budget alone', () => assert.equal(trimText('قصير', 10), 'قصير'));

    it('never splits a surrogate pair', () => {
        assert.equal(trimText(`${'ب'.repeat(9)}🔒🔒`, 10), 'ب'.repeat(9));
    });

    it('never splits a ZWJ emoji', () => {
        assert.equal(trimText('abcdefgh👨‍💻xyz', 11), 'abcdefgh');
    });

    it('never cuts inside a [placeholder]; it backs up before the bracket', () => {
        const got = trimText('اكتب طلبك هنا [اسم المنتج الكامل هنا] الآن', 20);
        assert.equal(got, 'اكتب طلبك هنا');
    });

    it('prefers a word boundary in the last 40%', () => {
        assert.equal(trimText('one two three four five', 16), 'one two three');
    });

    it('holds for every cut of a long mixed string', () => {
        const s = 'جرّب [اسم الأداة] 🔒 مع 👨‍💻 [placeholder two] ثم «نتيجة» 📄 '.repeat(4);
        for (let max = 1; max < s.length; max++) {
            const t = trimText(s, max);
            assert.ok(t.length <= max, `max ${max}`);
            assert.ok(!hasLoneSurrogate(t) && bracketsBalanced(t), `max ${max}: ${t}`);
        }
    });
});

describe('toArabicDigits', () => {
    it('converts Latin digits touching Arabic, and leaves Latin runs alone', () => {
        assert.equal(toArabicDigits('5 أخطاء'), '٥ أخطاء');
        assert.equal(toArabicDigits('في 10 دقايق'), 'في ١٠ دقايق');
        assert.equal(toArabicDigits('Gemini 2.5 Pro'), 'Gemini 2.5 Pro');
    });

    it('is applied only for an Arabic-Indic tenant', async () => {
        const flat = toFlat(localAI);
        flat.slides[3]!.label = 'ريال 0 اشتراك';
        const ar = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(flat).call });
        assert.equal((ar.carousel.slides[3] as { label: string }).label, 'ريال ٠ اشتراك');
    });
});

// ─── The avoid list ─────────────────────────────────────────────────────────────────────────

describe('generateDraft: the tenant\'s avoid list', () => {
    it('sends a banned term back, and rejects the draft if it stays', async () => {
        const bad = toFlat(localAI);
        bad.slides[5]!.body = 'زي MCP بالضبط، يدوّر في ملفاتك';
        const m = fakeModel(bad);
        await assert.rejects(
            generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call }),
            (err: unknown) => err instanceof StudioGenerationError && err.problems.some((p) => p.includes('mentions «MCP»')),
        );
        assert.ok(lastTurn(m.requests[1]).includes('slide 6 (point).body: mentions «MCP»'));
    });

    it('bans nothing for a tenant with no avoid list', async () => {
        const flat = toFlat(localAI);
        flat.slides[5]!.body = 'زي MCP بالضبط، يدوّر في ملفاتك';
        const settings = { ...AR, voice: { ...AR.voice, avoid: [] } };
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ settings }), { callModel: fakeModel(flat).call });
        assert.ok((out.carousel.slides[5] as { body: string }).body.includes('MCP'));
    });
});

// ─── An English tenant ──────────────────────────────────────────────────────────────────────

describe('generateDraft: an English tenant', () => {
    it('writes with its own CTA lines, template, product and digits', async () => {
        const ex = ENGLISH_EXAMPLES[0]!;
        const flat = toFlat(ex, { 'example-result': 'M2' });
        flat.dmQuestion = 'Want answers that come back finished?';
        flat.dmPitch = 'The course walks through the whole method.';
        const m = fakeModel(flat);
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ settings: EN }), { callModel: m.call });
        assert.equal(m.requests.length, 1);
        assert.deepEqual(validateCarousel(out.carousel, new Set(Object.keys(out.shots)), EN), []);
        assert.ok(out.carousel.captions.instagram.includes('Comment "goal" and I\'ll DM you the link 📩'));
        assert.ok(out.carousel.captions.tiktok.includes(EN.cta.tiktokLine) && out.carousel.captions.tiktok.includes('#LearnOnTikTok'));
        assert.equal(out.campaign.dm, [
            'Hi {username} 👋', '', 'Want answers that come back finished?', '', 'The course walks through the whole method.', '',
            EN.product.url, '', '✅ 12 lessons · 3 hours of video', '✅ Lifetime access', '', 'Any questions? Just reply to this message.',
        ].join('\n'));
        const system = m.requests[0]!.system;
        assert.ok(system.includes('Write every slide, caption and DM line in English') && system.includes('Use Latin digits'));
        assert.ok(!system.includes('ElAmir') && !system.includes('بالعربي') && !system.includes('udemy'), 'no other tenant leaks in');
        assert.ok(system.includes('"GoalNotQuestion"'), 'the English built-in example');
    });

    it('prefers the tenant\'s own approved examples', async () => {
        const settings = { ...EN, examples: [localAI] };
        const m = fakeModel(toFlat(ENGLISH_EXAMPLES[0]!, { 'example-result': 'M2' }));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ settings }), { callModel: m.call });
        assert.ok(m.requests[0]!.system.includes('"LocalAI"') && !m.requests[0]!.system.includes('"GoalNotQuestion"'));
    });
});

// ─── rewriteSlide ───────────────────────────────────────────────────────────────────────────

describe('rewriteSlide', () => {
    const draft = async (): Promise<Carousel> =>
        (await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: fakeModel(toFlat(localAI)).call })).carousel;
    const stat = (value: string) => ({ kind: 'stat', sources: ['L1.point1'], value, label: 'ريال اشتراك شهري', body: 'نماذج مفتوحة على جهازك.' });

    it('returns the slide within budgets, sending its problems back first', async () => {
        const c = await draft();
        const m = fakeModel(stat('صفر ريال شهرياً'), stat('صفر'));
        const slide = await rewriteSlide(c, 3, 'أقصر', SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 2);
        assert.equal(m.requests[0]!.schema.properties?.kind?.enum?.length, 9, 'the single-slide schema');
        assert.ok(lastTurn(m.requests[1]).includes('slide 4 (stat).value: 15 > 8'), lastTurn(m.requests[1]));
        assert.deepEqual(slide, { kind: 'stat', value: 'صفر', label: 'ريال اشتراك شهري', body: 'نماذج مفتوحة على جهازك.' });
    });

    it('keeps slide 1 a cover', async () => {
        const c = await draft();
        const cover = { kind: 'cover', sources: [], title: 'ملفاتك ما تطلع من جهازك', kicker: 'الذكاء المحلي' };
        const m = fakeModel({ kind: 'point', sources: ['L1.point1'], title: 'نقطة' }, cover);
        const slide = await rewriteSlide(c, 0, undefined, SOURCES, ctx(), { callModel: m.call });
        assert.ok(lastTurn(m.requests[1]).includes('slide 1 must be cover, not point'));
        assert.equal(slide.kind, 'cover');
    });

    it('only reuses screenshots the carousel already shows', async () => {
        const c = await draft();
        const point = (momentId: string) => ({ kind: 'point', sources: ['L1.point2'], title: 'وش يعني RAG؟', body: 'يدوّر في ملفاتك أول.', momentId });
        const fresh = await rewriteSlide(c, 5, undefined, SOURCES, ctx(), { callModel: fakeModel(point('M5')).call });
        assert.equal((fresh as { shot?: unknown }).shot, undefined, 'M5 is clean but not in the draft\'s shots');
        const kept = await rewriteSlide(c, 5, undefined, SOURCES, ctx(), { callModel: fakeModel(point('M4')).call });
        assert.deepEqual((kept as { shot?: unknown }).shot, { name: shotName(idOf('M4')) });
    });

    it('rejects an index outside the carousel', async () => {
        await assert.rejects(rewriteSlide(await draft(), 8, undefined, SOURCES, ctx(), { callModel: fakeModel({}).call }), StudioGenerationError);
    });
});

// ─── planWeek ───────────────────────────────────────────────────────────────────────────────

describe('planWeek', () => {
    const L2: LessonRow = { ...LESSON, id: '22222222-2222-4222-8222-222222222222', lesson_no: '9.1', title: 'CV agent' };
    const UNINDEXED: LessonRow = { id: '33333333-3333-4333-8333-333333333333', lesson_no: '2.1', title: 'NotebookLM', notes: null };
    const p = (lessons: string[], angle: string, title: string, slides = 8) => ({ lessons, angle, title, idea: `فكرة ${title}`, rationale: `Why ${title}`, slides });

    it('maps lesson ids, clamps slides, drops the unusable, and gives each its own accent', async () => {
        const m = fakeModel({ proposals: [p(['L1'], 'tips', 'أ', 14), p(['L9'], 'steps', 'ب'), p(['l1'], 'tips', 'تكرار'), p(['L2', 'L1'], 'compare', 'ج', 6)] });
        const out = await planWeek(2, [LESSON, L2, UNINDEXED], ctx({ recentAccents: ['#FFD60A'], recentTopics: ['موضوع قديم'] }), { callModel: m.call });
        assert.equal(m.requests.length, 1);
        assert.deepEqual(out, [
            { lessonIds: [LESSON_ID], idea: 'فكرة أ', angle: 'tips', slides: 10, title: 'أ', rationale: 'Why أ', accent: '#FF8A3D' },
            { lessonIds: [L2.id, LESSON_ID], idea: 'فكرة ج', angle: 'compare', slides: 6, title: 'ج', rationale: 'Why ج', accent: '#22D39A' },
        ]);
        const text = m.requests[0]!.turns[0]!.text;
        assert.ok(text.includes('موضوع قديم') && !text.includes('NotebookLM'), 'recent topics shown; unindexed lessons left out');
    });

    it('asks once more when too few proposals are usable', async () => {
        const m = fakeModel({ proposals: [p(['L1'], 'tips', 'أ'), p(['L9'], 'steps', 'ب')] }, { proposals: [p(['L1'], 'tips', 'أ'), p(['L2'], 'steps', 'ب')] });
        const out = await planWeek(2, [LESSON, L2], ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 2);
        assert.ok(lastTurn(m.requests[1]).startsWith('Only 1 of those are usable'));
        assert.equal(out.length, 2);
    });

    it('needs lessons to plan from', async () => {
        await assert.rejects(planWeek(2, [], ctx(), { callModel: fakeModel({ proposals: [] }).call }), StudioGenerationError);
    });
});

// ─── Alt text and the Growth settings (GROWTH.md §4) ────────────────────────────────────────

describe('generateDraft: alt text and SEO', () => {
    it('keeps each slide’s altText, on one line, cut to the 200 budget', async () => {
        const flat = toFlat(localAI);
        flat.slides[0]!.altText = '  غلاف عن  الذكاء المحلي\nعلى جهازك ';
        flat.slides[1]!.altText = 'ن'.repeat(260);
        const m = fakeModel(flat);
        const out = await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        assert.equal(m.requests.length, 1, 'a long alt text is trimmed, not sent back for a repair round');
        assert.equal(out.carousel.slides[0]!.altText, 'غلاف عن الذكاء المحلي على جهازك');
        assert.equal(out.carousel.slides[1]!.altText!.length <= ALT_TEXT_BUDGET, true);
        assert.equal(out.carousel.slides[2]!.altText, undefined, 'none written, none invented here');
        assert.deepEqual(validateCarousel(out.carousel, new Set(Object.keys(out.shots)), AR), []);
    });

    it('asks for alt text in the schema and the field guide', async () => {
        const m = fakeModel(toFlat(localAI));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: m.call });
        const slide = m.requests[0]!.schema.properties!.slides!.items!;
        assert.ok(slide.properties!.altText, 'altText is in the slide schema');
        assert.ok(!slide.required!.includes('altText'), 'but optional');
        assert.match(m.requests[0]!.system, /every slide: altText ≤ 200/);
    });

    it('works the tenant’s search keywords into the brief, and its hashtag sets', async () => {
        const m = fakeModel(toFlat(localAI));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx({ seo: { keywords: ['ذكاء اصطناعي', 'برومبت'], hashtags: ['#ذكاء_اصطناعي', '#AI'] } }), { callModel: m.call });
        const brief = m.requests[0]!.turns[0]!.text;
        assert.match(brief, /Search terms this audience types: «ذكاء اصطناعي», «برومبت»/);
        assert.match(brief, /Instagram caption's first line/);
        assert.match(brief, /from this creator's sets.*#ذكاء_اصطناعي #AI/);

        const plain = fakeModel(toFlat(localAI));
        await generateDraft({ lessonIds: [LESSON_ID] }, SOURCES, ctx(), { callModel: plain.call });
        assert.doesNotMatch(plain.requests[0]!.turns[0]!.text, /Search terms this audience types/, 'no settings, no line');
    });

    it('falls back to the slide’s own words when a slide has no alt text', () => {
        assert.equal(altTextFor({ kind: 'cover', title: 'شغّل الذكاء على جهازك', subtitle: 'بدون إنترنت' }), 'شغّل الذكاء على جهازك — بدون إنترنت');
        assert.equal(altTextFor({ kind: 'list', title: 'Tools', items: [{ text: 'LM Studio' }, { text: 'Ollama' }] }), 'Tools — LM Studio · Ollama');
        assert.equal(altTextFor({ kind: 'point', title: 't', altText: 'the writer’s' }), 'the writer’s');
        assert.equal(altTextFor({ kind: 'cta' }), '');
    });

    it('holds a stored alt text to its budget in the rules', () => {
        const c: Carousel = { ...structuredClone(localAI), slides: localAI.slides.map((s, i) => (i === 0 ? { ...s, altText: 'x'.repeat(201) } : s)) };
        const shots = new Set(localAI.slides.flatMap((s) => ('shot' in s && s.shot ? [s.shot.name] : [])));
        assert.ok(validateCarousel(c, shots, AR).some((p) => /slide 1 \(cover\)\.altText: 201 > 200/.test(p)));
    });
});
