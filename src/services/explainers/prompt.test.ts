/**
 * What the writer is asked (prompt.ts): the system prompt, the user prompt, the plan (how many scenes, how many seconds) and the schema of the answer.
 * Pure: no database and no network. The prompt is the heart of the video's quality, so what it must say is pinned here phrase by phrase, and the two lists
 * it quotes (what a brief may never contain, what a closing line may never ask) are held against the guards that really refuse them (spec.ts), so the
 * prompt cannot promise a refusal the app does not make.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ExplainerLanguage, ExplainerLengthTier } from '../../db/rows.js';
import {
    BAIT_EXAMPLES, buildWriterInputs, FEMALE_WORDS_AR, FEMALE_WORDS_EN, SENTENCE_WORDS, writeSystemPrompt, writeUserPrompt, writerPlan, writerSchema,
    WRITER_SCHEMA_FILE, type PreviousDraft, type WriterRequest,
} from './prompt.js';
import { DEFAULT_PACE, DURATION_RANGE_S, engagementBait, findFemaleSubject, LIMITS, MAX_SCENES, SCENE_BOUNDS } from './spec.js';
import { assertCheckable } from './writerOutput.js';

const TIERS: readonly ExplainerLengthTier[] = ['short', 'medium', 'long'];
const LANGUAGES: readonly ExplainerLanguage[] = ['ar', 'en'];

/** Whether the phrases occur in `text` in the order given, or the first one that does not. */
function inOrder(text: string, phrases: readonly string[]): { ok: true } | { ok: false; missing: string } {
    let from = 0;
    for (const phrase of phrases) {
        const at = text.indexOf(phrase, from);
        if (at < 0) return { ok: false, missing: phrase };
        from = at + 1;
    }
    return { ok: true };
}

// ─── The schema ────────────────────────────────────────────────────────────────────────────────

describe('the writer schema (writerSchema.json)', () => {
    it('is the contract’s writer-output.schema.json, byte for byte: change the contract and the worker’s explainerSchema.json with it, then this hash', () => {
        // The three copies are one: contracts/writer-output.schema.json (the spec), this file (the app asks with it and checks with it) and the worker's
        // scripts/studio/explainerSchema.json (the worker checks Claude's answer against ITS copy). A change to one that misses the others makes the worker
        // accept what the app refuses, or the reverse.
        const hash = createHash('sha256').update(readFileSync(WRITER_SCHEMA_FILE)).digest('hex');
        assert.equal(hash, '6a54b8fda6ea02b74f81c0e26092e45991ce9d6ad078b92f18e72c3e17dcf9f7');
    });

    it('uses only keywords the worker’s schema check knows: it refuses any other, so a schema that used one could not be sent', () => {
        assert.doesNotThrow(() => assertCheckable(writerSchema(), 'writerSchema.json'));
        assert.throws(() => assertCheckable({ type: 'object', oneOf: [] }), /uses "oneOf"/);
        assert.throws(() => assertCheckable({ type: 'array', items: { type: 'string', format: 'uri' } }), /\.items uses "format"/);
    });

    it('says the limits spec.ts holds a draft to: the prompt, the schema and the check cannot drift apart', () => {
        const schema = writerSchema() as any;
        const scene = schema.properties.scenes.items.properties;
        assert.equal(schema.properties.title.maxLength, LIMITS.title);
        assert.equal(scene.narration.maxLength, LIMITS.narration);
        assert.equal(scene.spoken.maxLength, LIMITS.spoken);
        assert.equal(scene.brief.maxLength, LIMITS.brief);
        assert.equal(scene.label.maxLength, LIMITS.labelChars);
        assert.equal(scene.characters.maxItems, LIMITS.characters);
        assert.equal(schema.properties.scenes.maxItems, MAX_SCENES);
        assert.equal(schema.properties.scenes.minItems, SCENE_BOUNDS.short.min, 'the smallest tier’s smallest script');
        assert.equal(schema.properties.replies.minItems, 5, 'at least five likely replies (FR-007)');
        assert.equal(schema.properties.replies.maxItems, 10);
        assert.deepEqual(schema.required, ['title', 'scenes', 'captions', 'first_comment', 'replies', 'sources']);
        assert.deepEqual(schema.properties.scenes.items.required, ['narration', 'spoken', 'label', 'brief', 'characters', 'continues', 'source_ids']);
    });

    it('is closed everywhere: an object with a key the schema does not name is refused', () => {
        const objects: Record<string, unknown>[] = [];
        (function walk(node: unknown): void {
            if (Array.isArray(node)) return node.forEach(walk);
            if (!node || typeof node !== 'object') return;
            if ((node as Record<string, unknown>).type === 'object') objects.push(node as Record<string, unknown>);
            Object.values(node).forEach(walk);
        })(writerSchema());
        assert.ok(objects.length >= 6, `${objects.length} objects`);
        for (const object of objects) assert.equal(object.additionalProperties, false);
    });

    it('is a fresh copy each time: a caller that changes its own does not change the next one’s', () => {
        const first = writerSchema() as any;
        first.properties.title.maxLength = 1;
        delete first.required;
        const second = writerSchema() as any;
        assert.equal(second.properties.title.maxLength, LIMITS.title);
        assert.ok(Array.isArray(second.required));
    });

    it('is read by a LITERAL path.join(__dirname, …), the shape Vercel’s file tracing bundles, and lazily: a missing file fails explainers and not the app’s start', () => {
        const source = readFileSync(new URL('./prompt.ts', import.meta.url), 'utf8');
        assert.match(source, /path\.join\(__dirname, 'writerSchema\.json'\)/);
        assert.match(source, /cachedSchema \?\?= JSON\.parse\(readFileSync\(WRITER_SCHEMA_FILE/, 'read on first use, inside a function');
        assert.doesNotMatch(source, /^(?:const|let) \w+ = JSON\.parse\(readFileSync/m, 'not at import');
    });
});

// ─── The plan ──────────────────────────────────────────────────────────────────────────────────

describe('writerPlan: the tier’s bounds, with the pace from the settings', () => {
    it('is spec.ts’s scene counts and seconds, and the words they come to at the pace', () => {
        for (const tier of TIERS) {
            for (const language of LANGUAGES) {
                const plan = writerPlan(tier, language);
                const pace = DEFAULT_PACE[language];
                assert.equal(plan.scenes_min, SCENE_BOUNDS[tier].min, `${tier} ${language}`);
                assert.equal(plan.scenes_max, SCENE_BOUNDS[tier].max);
                assert.equal(plan.seconds_min, DURATION_RANGE_S[tier].min);
                assert.equal(plan.seconds_max, DURATION_RANGE_S[tier].max);
                assert.equal(plan.pace, pace);
                assert.equal(plan.words_min, Math.round(DURATION_RANGE_S[tier].min * pace));
                assert.equal(plan.words_max, Math.round(DURATION_RANGE_S[tier].max * pace));
            }
        }
    });

    it('a short Arabic script is 99 to 171 words, and a dozen scenes is the middle of it', () => {
        const plan = writerPlan('short', 'ar');
        assert.deepEqual([plan.words_min, plan.words_max, plan.scenes_aim], [99, 171, 12]);
    });

    it('aims inside the tier’s scene count, whatever the pace: a very slow narrator does not ask for fewer scenes than the tier has', () => {
        for (const tier of TIERS) {
            for (const pace of [0.5, 1, 1.8, 2.5, 4]) {
                const { scenes_aim, scenes_min, scenes_max } = writerPlan(tier, 'en', pace);
                assert.ok(scenes_aim >= scenes_min && scenes_aim <= scenes_max, `${tier} at ${pace}: ${scenes_aim}`);
            }
        }
        assert.equal(writerPlan('long', 'ar', 1).scenes_aim, SCENE_BOUNDS.long.min);
    });

    it('takes the settings’ pace, and ignores one that cannot be a pace, as the estimate does', () => {
        assert.equal(writerPlan('short', 'en', 2).pace, 2);
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(writerPlan('short', 'ar', bad).pace, DEFAULT_PACE.ar, String(bad));
    });
});

// ─── The system prompt ─────────────────────────────────────────────────────────────────────────

describe('the system prompt: the story', () => {
    const system = writeSystemPrompt('ar', 'short');

    it('is hook → the research story → the explanation → the takeaway → a closing question, in that order (FR-004)', () => {
        const found = inOrder(system, ['1. The hook', '2. The research story', '3. The explanation', '4. The takeaway', '5. The closing question']);
        assert.deepEqual(found, { ok: true });
        assert.match(system, /The research story: who found what, when, and in which source/);
        assert.match(system, /The closing question: the LAST scene, alone/);
        assert.match(system, /A real question that asks the viewer for an opinion or an experience of their own/);
    });

    it('says the closing question is never a request for a keyword, a number, an emoji, a like, a share, a tag or a follow, and names the ones the app refuses', () => {
        assert.match(system, /Never a request for a keyword, a number, an emoji, a like, a share, a tag or a follow/);
        for (const example of ['comment YES', 'type 1', 'tag a friend', 'اكتب نعم', 'علّق بكلمة']) assert.ok(system.includes(example), example);
    });

    it('every bait it names is one the app really refuses (spec.ts engagementBait): it cannot promise a refusal that is not made', () => {
        const examples = [...BAIT_EXAMPLES.matchAll(/["«]([^"»]+)["»]/g)].map((m) => m[1]!);
        assert.equal(examples.length, 9);
        for (const example of examples) assert.notEqual(engagementBait(example), null, `engagementBait must refuse "${example}"`);
        // And a genuine question is not one of them.
        for (const question of ['Which of these have you seen fail in your own project?', 'ما الذي جرّبته أنت من هذه الطرق في مشروعك؟']) assert.equal(engagementBait(question), null);
    });

    it('forbids the hook to be a greeting, and a claim to be an absolute', () => {
        assert.match(system, /No greeting, no "welcome", no "did you know", no channel introduction/);
        assert.match(system, /No absolutes: not "always", "never", "only", "X is dead", "scientists proved"/);
    });
});

describe('the system prompt: research is mandatory (the owner’s live test, 2026-10-25)', () => {
    const system = writeSystemPrompt('en', 'short');

    it('requires WebSearch for the primary sources and WebFetch to open them BEFORE the script is written', () => {
        assert.match(system, /RESEARCH IS MANDATORY: do it before you write anything/);
        assert.match(system, /Use WebSearch to find the primary sources/);
        assert.match(system, /Open every page you mean to cite with WebFetch, and read the part you rely on, BEFORE you write the script/);
        assert.deepEqual(inOrder(system, ['Use WebSearch', 'with WebFetch', 'THE STORY']), { ok: true }, 'the research comes before the story');
    });

    it('allows citing only addresses that were opened, never from memory, and drops what could not be verified', () => {
        assert.match(system, /Cite only addresses you actually opened in this session\. Never cite from memory/);
        assert.match(system, /Never reconstruct a title, an author, a year, an address, a quote or a number from what you remember, even when you are sure of it/);
        assert.match(system, /A fact you could not verify in a page you opened is left out of the script/);
        assert.match(system, /every address in `sources` is a page you opened with WebFetch; no name, year, number or address comes from memory/);
    });

    it('prefers primary sources and names what is not one', () => {
        assert.match(system, /the paper that reported the result \(arXiv, a journal, a conference\), the standard or RFC, the official documentation/);
        assert.match(system, /A news article, a listicle, a social post, a vendor's benchmark and a paywalled page you cannot read are not sources/);
    });

    it('says what to do when the tools fail: say less, never more', () => {
        assert.match(system, /When the tools fail or nothing reliable can be found, say less, never more/);
    });

    it('opens the creator’s links first', () => {
        assert.match(system, /The creator may give you links: open them first/);
    });
});

describe('the system prompt: the notes variant, for a writer that has no web tools (Gemini’s second call)', () => {
    const notes = writeSystemPrompt('en', 'short', undefined, 'notes');

    it('does not tell the writer to use tools it has not got, and makes the numbered sources the whole truth', () => {
        assert.doesNotMatch(notes, /WebSearch|WebFetch/);
        assert.doesNotMatch(notes, /RESEARCH IS MANDATORY/);
        assert.match(notes, /RESEARCH \(already done for you\)/);
        assert.match(notes, /The research notes and the numbered sources below are everything you may rely on/);
        assert.match(notes, /Put EVERY numbered source in `sources`, in the order of its number, so that source n is `sources\[n\]`/);
        assert.match(notes, /Never add a source and never change an address/);
        assert.match(notes, /when the notes do not back a claim, leave the claim out/);
        assert.match(notes, /You do three jobs in one answer, from the research notes you are given/);
    });

    it('is the same prompt otherwise: the story, the scenes, the pictures, the captions, the replies, the language and the check', () => {
        const research = writeSystemPrompt('en', 'short');
        const tail = (text: string) => text.slice(text.indexOf('THE STORY'));
        const strip = (text: string) => tail(text).replace(/^2\. Every sentence that states a fact.*$/m, '');
        assert.equal(strip(notes), strip(research));
    });

    it('is the default only when asked for: a call that names no mode is the research prompt', () => {
        assert.equal(writeSystemPrompt('en', 'short'), writeSystemPrompt('en', 'short', undefined, 'research'));
    });
});

describe('the system prompt: scenes', () => {
    it('is one sentence a scene, 8 to 16 words, at most 300 characters, in what a narrator says', () => {
        const system = writeSystemPrompt('en', 'short');
        assert.deepEqual(SENTENCE_WORDS, { min: 8, max: 16 });
        assert.match(system, /One sentence per scene, 8 to 16 words/);
        assert.match(system, new RegExp(`\`narration\` is at most ${LIMITS.narration} characters`));
        assert.match(system, /short and concrete enough to be drawn as one picture/);
    });

    it('states the tier’s scene count, seconds, pace and word budget, from spec.ts', () => {
        for (const tier of TIERS) {
            for (const language of LANGUAGES) {
                const plan = writerPlan(tier, language);
                const system = writeSystemPrompt(language, tier);
                assert.match(system, new RegExp(`${plan.scenes_min} to ${plan.scenes_max} scenes, spoken in ${plan.seconds_min} to ${plan.seconds_max} seconds at ${plan.pace} words a second, which is ${plan.words_min} to ${plan.words_max} spoken words`), `${tier} ${language}`);
                assert.match(system, new RegExp(`Aim for about ${plan.scenes_aim} scenes`));
                assert.match(system, /spoken words in all \(a (?:60-90 second|3-5 minute|10-15 minute) video\)/, 'a length, said as a person says it');
            }
        }
    });

    it('uses the settings’ pace when one is given', () => {
        assert.match(writeSystemPrompt('en', 'short', 2), /at 2 words a second, which is 110 to 190 spoken words/);
    });

    it('holds every field to its limit: a label of at most 4 words that is never drawn into the picture, a brief in English, at most 4 characters in a scene, a source for every fact', () => {
        const system = writeSystemPrompt('ar', 'short');
        assert.match(system, new RegExp(`label: the key word or short phrase of the sentence, at most ${LIMITS.labelWords} words, or a number`));
        assert.match(system, new RegExp(`Never more than ${LIMITS.labelWords} words`));
        assert.match(system, /The label is added by the video, on top of the picture/);
        assert.match(system, new RegExp(`brief: the picture \\(see the picture rules; English; at most ${LIMITS.brief} characters\\)`));
        assert.match(system, new RegExp(`at most ${LIMITS.characters}; \\[\\] for none\\. Use no key that is not in the list`));
        assert.match(system, /EVERY sentence that states a fact .* cites at least one/);
        assert.match(system, /an empty list for a sentence that states no fact/);
        assert.match(system, /continues: true when this sentence still belongs to the previous picture/);
        assert.match(system, /Never on the first scene, and at most one scene in six/);
    });

    it('asks for sources that are primary and real, each one cited, with no invention', () => {
        const system = writeSystemPrompt('en', 'short');
        assert.match(system, /`sources`: only the sources you used, each cited by at least one scene, primary ones first: \{ title, by \(the authors or the publisher\), year/);
        assert.match(system, /At least 3 for a 60-90 second video when they exist/);
        assert.match(system, /Never invent a source, an author, a year, an address, a quote or a number|Never reconstruct a title, an author, a year/);
    });
});

describe('the system prompt: the pictures', () => {
    const system = writeSystemPrompt('en', 'short');

    it('never a woman or a girl, in any picture, and not even in "no women": the words a brief may not contain are listed', () => {
        assert.match(system, /NEVER a woman or a girl, in any picture/);
        assert.ok(system.includes(FEMALE_WORDS_EN));
        assert.ok(system.includes(FEMALE_WORDS_AR));
        assert.match(system, /not even to say "no women": the app refuses a brief that contains one/);
        assert.match(system, /show her work \(a paper, a lab bench, a chart, an object\) and never her/);
        assert.match(system, /never the face or likeness of a real, named person/);
    });

    it('every word it forbids in a brief is one the guard really refuses (spec.ts findFemaleSubject), in both languages', () => {
        const english = FEMALE_WORDS_EN.split(', ');
        const arabic = FEMALE_WORDS_AR.split('، ');
        assert.ok(english.length >= 10 && arabic.length >= 9);
        for (const word of [...english, ...arabic]) assert.notEqual(findFemaleSubject(`karim holds a book, ${word}`), null, `findFemaleSubject must refuse "${word}"`);
        // The prompt's own example of a good brief is not refused.
        assert.equal(findFemaleSubject('karim stands at a whiteboard with a stack of papers, a magnifying glass in his hand, wide shot from the side'), null);
    });

    it('no text in a picture: no letters, numbers, signs, logos, speech bubbles, labels or readable screens', () => {
        assert.match(system, /No text of any kind in a picture: no letters, numbers, signs, logos, speech bubbles, labels or readable screens/);
        assert.match(system, /A chart or a diagram is made of shapes and colours only/);
    });

    it('is ONE picture per brief, in English, naming a recurring character by its key, with the top quarter left calm for the label', () => {
        assert.match(system, /A brief is ONE picture/);
        assert.match(system, /a recurring character by its key, such as karim, which you also list in `characters`/);
        assert.match(system, /Keep the top quarter of the frame calm and empty: the label goes there/);
        assert.match(system, /Do not describe the art style \(the app adds it\)/);
    });
});

describe('the system prompt: captions, first comment and likely replies', () => {
    const system = writeSystemPrompt('en', 'short');

    it('a caption per platform, about this video, with no link and no bait', () => {
        assert.match(system, /captions\.meta \(Instagram and Facebook\): a hook line that names the topic/);
        assert.match(system, /No links and no "link in bio" \(the sources go in the first comment\)/);
        assert.match(system, /no request for a keyword, a comment, a like, a share or a follow/);
        assert.match(system, /captions\.youtube\.title: up to 100 characters/);
        assert.match(system, /captions\.youtube\.description: .* then the sources/);
        assert.match(system, /captions\.tiktok: a short hook, the closing question and 3 to 5 hashtags/);
        assert.match(system, /No request for likes, subscriptions or comments/);
        assert.match(system, new RegExp(`title: the on-screen title, 5 to ${LIMITS.title} characters`));
    });

    it('the first comment lists the sources', () => {
        assert.match(system, /first_comment: .*each source on its own line: its number, title, authors or publisher, year and address/);
    });

    it('five to ten likely replies to the comments an expert will post (the owner’s rule: a post must survive expert comments)', () => {
        assert.match(system, /the owner's rule: a post must survive expert comments/);
        assert.match(system, /a senior practitioner or researcher in this field/);
        assert.match(system, /First fix every fixable point in the script itself/);
        assert.match(system, /write 5 to 10 `replies`/);
        assert.match(system, /agrees where they are right and shows why the video still holds/);
    });
});

describe('the system prompt: language', () => {
    it('Arabic is Modern Standard Arabic and never dialect: the dialect words of the infographics prompt are named', () => {
        const system = writeSystemPrompt('ar', 'short');
        assert.match(system, /LANGUAGE: Modern Standard Arabic \(العربية الفصحى\)/);
        assert.match(system, /Never use dialect: not يوصل، لين، يسوّي، وش، كذا، زي، علشان/);
        assert.match(system, /عايز، إزاي، دلوقتي، كده/, 'the Egyptian words too: the owner’s notes may be written in his own dialect');
        assert.match(system, /The creator's notes may be written in dialect: understand them and never copy their words/);
        assert.match(system, /in Latin letters in `narration` and `label` \(RAG, API, LLM, GPU\)/);
    });

    it('`spoken` spells English terms the way an Arabic voice says them, and stays the narration otherwise: the subtitles are timed from it', () => {
        const system = writeSystemPrompt('ar', 'short');
        assert.match(system, /`spoken` is what the narrator says: word for word the same sentence as `narration`, changed only where the voice needs help, because the subtitles are timed from it/);
        assert.match(system, /Write every English word, name and acronym in Arabic letters the way an Arabic-speaking engineer says it \(RAG → «راغ»/);
        assert.match(system, /Keep digits as digits/);
    });

    it('English is plain English, with `spoken` the same words and abbreviations written out', () => {
        const system = writeSystemPrompt('en', 'short');
        assert.match(system, /LANGUAGE: English/);
        assert.match(system, /Write in clear, plain English\. Short words, no hype/);
        assert.match(system, /`spoken` is what the narrator says: the same words as `narration`/);
        assert.doesNotMatch(system, /Never use dialect/);
        assert.doesNotMatch(system, /Modern Standard Arabic/);
    });

    it('is deterministic: the same inputs give the same text, so the prompt can be pinned and reviewed', () => {
        for (const tier of TIERS) for (const language of LANGUAGES) assert.equal(writeSystemPrompt(language, tier), writeSystemPrompt(language, tier));
    });

    it('ends with the last check and the instruction to answer with the JSON object alone', () => {
        const system = writeSystemPrompt('en', 'medium');
        assert.match(system, /BEFORE YOU ANSWER, CHECK\n1\. The first scene is the hook\. The last scene is the closing question and nothing else/);
        assert.ok(system.endsWith('Answer with the JSON object of the schema and nothing else.'));
    });
});

// ─── The user prompt ───────────────────────────────────────────────────────────────────────────

describe('the user prompt', () => {
    const request = (over: Partial<WriterRequest> = {}): WriterRequest => ({
        topic: '  لماذا يجيب الذكاء الاصطناعي بثقة وهو مخطئ؟  ', notes: null, language: 'ar', tier: 'short', sourceLinks: [], characters: [],
        style: ' warm hand-painted gouache illustration ', ...over,
    });
    const draft: PreviousDraft = {
        title: 'الهلوسة', scenes: [{ narration: 'جملة.', spoken: 'جملة.', label: 'RAG', brief: 'karim reads a book at a desk', characters: ['karim'], continues: false }],
        captions: { meta: 'm', youtube: { title: 't', description: 'd' }, tiktok: 'k' }, first_comment: 'c', replies: [{ q: 'q', a: 'a' }], sources: [{ title: 'S', by: 'B', year: '2020', url: 'https://arxiv.org/abs/2005.11401' }],
    };

    it('names the topic (trimmed), the language, and the tier’s length', () => {
        const user = writeUserPrompt(request());
        assert.match(user, /^Topic: لماذا يجيب الذكاء الاصطناعي بثقة وهو مخطئ؟\nLanguage: Arabic \(Modern Standard Arabic, الفصحى\)\nLength: 60-90 seconds: 10 to 30 scenes\.$/m);
        assert.match(writeUserPrompt(request({ language: 'en', tier: 'long' })), /Language: English\nLength: 10-15 minutes: 120 to 300 scenes\./);
    });

    it('shows the creator’s notes and links only when there are some, links first to be read', () => {
        const plain = writeUserPrompt(request());
        assert.doesNotMatch(plain, /Notes from the creator|Links from the creator/);
        const full = writeUserPrompt(request({ notes: ' point to the course chapters ', sourceLinks: ['https://arxiv.org/abs/2005.11401', 'https://lmstudio.ai/docs/app/basics/rag'] }));
        assert.match(full, /Notes from the creator \(follow them\):\npoint to the course chapters/);
        assert.match(full, /Links from the creator \(read them first\):\n- https:\/\/arxiv\.org\/abs\/2005\.11401\n- https:\/\/lmstudio\.ai\/docs\/app\/basics\/rag/);
    });

    it('lists the recurring characters by key, or says there are none and what to do about a person', () => {
        const withCast = writeUserPrompt(request({ characters: [{ key: 'karim', name: 'كريم', description: 'a curious young man with a round head' }] }));
        assert.match(withCast, /Recurring characters \(use the key in a brief and in `characters`; use no other key\):\n- karim: كريم, a curious young man with a round head/);
        const none = writeUserPrompt(request());
        assert.match(none, /Recurring characters: none yet\. When a scene needs a person, describe a man or a faceless silhouette in the brief, and leave `characters` empty\./);
    });

    it('gives the art direction as information, and the words never to use when there are some', () => {
        const user = writeUserPrompt(request({ avoid: ['كورس', 'free'] }));
        assert.match(user, /Art direction the pictures are drawn in \(for your information; never repeat it in a brief\): warm hand-painted gouache illustration$/m);
        assert.match(user, /Never use these words or topics: كورس, free\./);
        assert.doesNotMatch(writeUserPrompt(request()), /Never use these words/);
    });

    it('says today’s date when it is given, and not otherwise (the prompt of a given request is the same every time)', () => {
        assert.match(writeUserPrompt(request({ today: '2026-10-25' })), /^Today: 2026-10-25$/m);
        assert.doesNotMatch(writeUserPrompt(request()), /Today:/);
        assert.equal(writeUserPrompt(request()), writeUserPrompt(request()));
    });

    it('a rewrite carries the request and the previous draft, and asks for a whole new draft with the honesty kept', () => {
        const user = writeUserPrompt(request({ rewriteNote: ' shorter hook, add the 2020 result ', previousDraft: draft }));
        assert.match(user, /REWRITE REQUEST from the creator: shorter hook, add the 2020 result/);
        assert.match(user, /Write a NEW, complete draft that follows the request\. Keep what the request does not touch, but check every rule again, and keep the research honest: a source you did not read stays out\./);
        const json = user.slice(user.indexOf('Previous draft:\n') + 'Previous draft:\n'.length);
        const parsed = JSON.parse(json);
        assert.equal(parsed.title, 'الهلوسة');
        assert.deepEqual(parsed.scenes[0], { narration: 'جملة.', spoken: 'جملة.', label: 'RAG', brief: 'karim reads a book at a desk', characters: ['karim'], continues: false });
        assert.deepEqual(parsed.sources, draft.sources);
        assert.deepEqual(parsed.replies, draft.replies);
    });

    it('a note with no draft, or a draft with no note, is no rewrite: nothing about one is said', () => {
        assert.doesNotMatch(writeUserPrompt(request({ rewriteNote: 'shorter', previousDraft: null })), /REWRITE REQUEST|Previous draft/);
        assert.doesNotMatch(writeUserPrompt(request({ rewriteNote: '  ', previousDraft: draft })), /REWRITE REQUEST|Previous draft/);
        assert.doesNotMatch(writeUserPrompt(request({ previousDraft: draft })), /REWRITE REQUEST|Previous draft/);
    });
});

describe('buildWriterInputs', () => {
    it('is the prompts, a copy of the schema and the bounds the answer is held to, with the pace from the settings', () => {
        const req: WriterRequest = { topic: 'RAG', notes: null, language: 'ar', tier: 'medium', sourceLinks: [], characters: [], style: 's' };
        const inputs = buildWriterInputs(req, 1.9);
        assert.equal(inputs.system, writeSystemPrompt('ar', 'medium', 1.9));
        assert.equal(inputs.user, writeUserPrompt(req));
        assert.deepEqual(inputs.schema, writerSchema());
        assert.deepEqual(inputs.bounds, { scenes_min: 30, scenes_max: 90, seconds_min: 170, seconds_max: 310, pace: 1.9 });
    });

    it('asks in notes mode when told to, and for the default pace when none is given', () => {
        const req: WriterRequest = { topic: 'RAG', notes: null, language: 'en', tier: 'short', sourceLinks: [], characters: [], style: 's' };
        assert.equal(buildWriterInputs(req, undefined, 'notes').system, writeSystemPrompt('en', 'short', undefined, 'notes'));
        assert.equal(buildWriterInputs(req).bounds.pace, 2.5);
    });
});
