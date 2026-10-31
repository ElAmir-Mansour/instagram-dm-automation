/**
 * The stand-in for Meta, for the dry run and the tests: canned answers, no key, no network, no database, and a clock that moves only when a stand-in says a call took
 * that long. `npm run eval:muse -- --stub --out <dir>` runs the WHOLE benchmark with it (the arms, the checks, the metrics, the table and the chart), so the report's layout and
 * the code behind it can be looked at without spending anything. A dry run's numbers are not a measurement, and its report says so at the top.
 *
 * The answers are the ones a good model would give, so a dry run is mostly green; the tests then put a bad answer in their place (a repeated price, a wrong offer, a refusal to
 * read) and watch the right number move and the failure appear with its case id. The words of the customer (what a case types, what a voice note says) are never in this
 * file: they come from the cases, so the stub holds nothing of the owner's.
 */
import type { AiCaller, AiGenerateArgs, AiGenerateResult } from '../../aiProviders/generate.js';
import { stubJudgeCaller } from '../../dmSales/__evals__/stub.js';
import type { EvalCaller, ModelRequest, ModelResponse } from '../../dmSales/__evals__/types.js';
import { billedFromUsage, costOf, DEFAULT_PRICES } from '../../llm/cost.js';
import { Ledger } from './caller.js';
import type { MuseCase } from './types.js';
import type { TranscribeVoice } from './voice.js';

/** Time that passes only when a stand-in says so. */
export class FakeClock {
    private t = 1_000;
    readonly now = (): number => this.t;
    advance(ms: number): void {
        this.t += ms;
    }
}

const MODEL = 'muse-spark-1.3';

interface CannedPerception {
    readable: boolean;
    seen: string;
    transcript: string;
    about_owner: 'own_content' | 'other_content' | 'personal' | 'unclear';
    confidence: number;
    mention_summary: string;
}

interface CannedSales {
    intent: string;
    stage: string;
    next_action: string;
    offer_id: string;
    handoff_reason: string;
    text: string;
}

const PRICE_PICTURE: CannedPerception = {
    readable: true, seen: 'A screenshot with Arabic text on a white background: an AI agents program, price 299 Egyptian pounds, a 50% discount until 5 November.',
    transcript: '', about_owner: 'unclear', confidence: 0.93, mention_summary: '',
};
const RIYAL_REEL: CannedPerception = {
    readable: true,
    seen: 'A reel about a meal priced at 45 riyals that was paid for with 1 riyal: the page checks everything but the backend server trusts the price it is sent.',
    transcript: 'طلبية غريبة وجبة ثمنها خمسة وأربعون ريالا', about_owner: 'unclear', confidence: 0.94, mention_summary: '',
};
const PROMO_REEL: CannedPerception = {
    readable: true, seen: 'A promo reel about turning study files into a podcast, ending on the offer name, its lesson count and a link on screen.',
    transcript: 'اكتب في التعليقات بودكاست', about_owner: 'unclear', confidence: 0.92, mention_summary: '',
};

/** What Muse reports for each case that is looked at. A case with only a caption is never shown to a model, and has none. */
const PERCEPTIONS: Readonly<Record<string, CannedPerception>> = {
    'image-price': PRICE_PICTURE,
    'image-price-words-ar': PRICE_PICTURE,
    'image-price-words-en': PRICE_PICTURE,
    'image-price-priced': PRICE_PICTURE,
    'image-price-again': PRICE_PICTURE,
    'image-garbled': { readable: false, seen: 'A picture of text that is corrupted and cannot be read.', transcript: '', about_owner: 'unclear', confidence: 0.2, mention_summary: '' },
    'image-id-card': { readable: true, seen: 'An identity card with a name, a number and a date of birth.', transcript: '', about_owner: 'personal', confidence: 0.96, mention_summary: '' },
    'video-price': {
        readable: true, seen: 'A short video: a white screen with Arabic text about a program, price 299 pounds with 50% off, then a red screen that says STEP 2.',
        transcript: '', about_owner: 'unclear', confidence: 0.9, mention_summary: '',
    },
    'reel-own-riyal': RIYAL_REEL,
    'reel-own-riyal-words-ar': RIYAL_REEL,
    'reel-own-podcast': PROMO_REEL,
    'reel-own-podcast-words-en': PROMO_REEL,
    'story-mention': {
        readable: true, seen: 'A story card that says it is their first day learning Python with a cup of coffee.', transcript: '', about_owner: 'unclear', confidence: 0.9,
        mention_summary: 'تعلم بايثون مع القهوة',
    },
};

const send = (text: string, offer = 'main'): CannedSales => ({ intent: 'price', stage: 'link', next_action: 'send_link', offer_id: offer, handoff_reason: 'none', text });
const ask = (text: string): CannedSales => ({ intent: 'info', stage: 'qualify', next_action: 'ask_qualifier', offer_id: 'none', handoff_reason: 'none', text });
const reply = (text: string): CannedSales => ({ intent: 'off_topic', stage: 'new', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text });
const handoff = (text: string): CannedSales => ({ intent: 'info', stage: 'handoff', next_action: 'handoff', offer_id: 'none', handoff_reason: 'unsure', text });

const GULF_PRICE = 'هلا فيك! السعر الحالي موضّح في صفحة العرض ويتغير مع العروض، وهذا الرابط تشوفه بنفسك.';

/** The sales turn's answer to each case when it has been told what the customer sent. */
const SALES: Readonly<Record<string, CannedSales>> = {
    'image-price': send(GULF_PRICE),
    'image-price-words-ar': send('أهلا بيك! الخصم والسعر الحالي بيظهروا في صفحة العرض نفسها، ده الرابط تبص عليه.'),
    'image-price-words-en': send('Hi! The current price is shown on the offer page and it moves with promotions. Here is the link.'),
    'image-price-priced': send('هلا فيك! السعر الحالي 49 USD، وهذا الرابط تشوف التفاصيل.'),
    'image-price-again': send(GULF_PRICE),
    'video-price': send(GULF_PRICE),
    'reel-own-riyal': ask('هلا فيك! الريل يشرح الفرق بين الفرونت إند والباك إند من قصة طلب انحسب بسعر غلط. وش اللي تبي تعرفه عنه؟'),
    'reel-own-riyal-words-ar': handoff('هتأكد من صاحب الحساب وهيرد عليك.'),
    'reel-own-podcast': { ...send('هلا فيك! الريل عن تحويل ملفات المذاكرة لبودكاست، وهو من العرض نفسه. تبي أرسل لك الرابط؟'), next_action: 'recommend', stage: 'recommend' },
    'reel-own-podcast-words-en': { ...send('Yes, this reel is about our program. The price and details are on its page, and here is the link.'), intent: 'info' },
    'reel-other': reply('هلا فيك! هذا الريل مو من محتوى حسابنا. لو عندك سؤال عن عروضنا أو عن التعلم، أنا هنا أساعدك.'),
    'reel-other-words-en': reply('That reel is not from this account, so I cannot tell you what it covers. If you have a question about what we offer, I am happy to help.'),
    'voice-price-certificate': send('وعليكم السلام! أيوه فيه شهادة إتمام، والسعر الحالي بيظهر في صفحة العرض، ده الرابط.'),
    'voice-beginner': { ...send('أهلا بيك! العرض بيبدأ من الصفر ومش محتاج خبرة في البرمجة، ده الرابط لو حابب.'), intent: 'level_fit' },
    'voice-payment': handoff('هتأكد من صاحب الحساب وهيرد عليك.'),
};

/** What the sales turn says with NOTHING about the media in front of it (today's text path): a question, in the customer's own register. */
function blind(c: MuseCase | undefined): CannedSales {
    if (c?.writes === 'english') return ask('Which one do you mean? Tell me what you would like to know and I will help.');
    if (c?.writes === 'egyptian') return ask('أهلا بيك! تقصد أنهي واحد؟ قولي عايز تعرف إيه وأنا أساعدك.');
    return ask('هلا فيك! تقصد أي واحد؟ وش اللي تبي تعرفه؟');
}

const call = (model: string, usage: { in: number; out: number }) => costOf([billedFromUsage(model, usage)], DEFAULT_PRICES);

/**
 * `setAiCaller`'s stand-in: Muse's answer to `perception_dm` for the case in progress (`ledger.current`). It records the call as a real one would be, and moves the clock by how long
 * it says it took.
 */
export function stubAiCaller(ledger: Ledger, clock: FakeClock): AiCaller {
    return async (args: AiGenerateArgs): Promise<AiGenerateResult> => {
        const id = ledger.current ?? '';
        const canned = PERCEPTIONS[id];
        if (!canned) throw new Error(`the dry run has no perception for ${id || 'no case'}`);
        const video = args.user.length > 0 && typeof args.user !== 'string' && args.user.some((t) => t.media?.some((m) => m.kind === 'video'));
        const ms = video ? 21_000 : 4_200;
        const usage = video ? { in: 11_000, out: 1_600 } : { in: 1_500, out: 700 };
        const cost = call(MODEL, usage);
        clock.advance(ms);
        ledger.add({ role: 'perception', provider: 'meta', model: MODEL, usd: cost.usd, priced: cost.priced, tokensIn: usage.in, tokensOut: usage.out, cacheRead: 0, ms, ok: true });
        return {
            json: canned, usage, billed: cost.billed, model: MODEL, provider: 'meta', stopReason: 'end_turn', elapsed_ms: ms, usd: cost.usd, priced: cost.priced, costSource: 'table',
            effort: args.effort ?? 'low', route: 'saved', usageId: 'dry-run',
        };
    };
}

/** The sales turn's stand-in: the canned answer for the case, or the blind one when the request holds no word about what was sent. */
export function stubSalesCaller(ledger: Ledger, cases: readonly MuseCase[]): EvalCaller {
    return async (request: ModelRequest): Promise<ModelResponse> => {
        const id = request.meta.case;
        const c = cases.find((x) => x.id === id);
        const told = request.system.includes('What the customer sent');
        // A voice note is answered as words (its transcript is what they said), so it has an answer of its own and no "what was sent".
        const wanted = told || c?.kind === 'voice' ? SALES[id] : undefined;
        const canned = wanted ?? blind(c);
        const usage = { in: 4_600, out: 520 };
        const cost = call(MODEL, usage);
        const ms = 3_100;
        ledger.add({ role: 'reply', provider: 'meta', model: MODEL, usd: cost.usd, priced: cost.priced, tokensIn: usage.in, tokensOut: usage.out, cacheRead: 0, ms, ok: true });
        return { json: { ...canned, quick_replies: [] }, model: MODEL, usage, usd: cost.usd, priced: cost.priced, latencyMs: ms };
    };
}

/** The judge: every criterion 5 (the DM evaluation's own stand-in). */
export const stubJudge = (): EvalCaller => stubJudgeCaller();

/** The voice stand-in: the words each voice case says it means, heard perfectly, at the speech model's price per hour of audio. */
export function stubTranscribe(cases: readonly MuseCase[], ledger: Ledger, clock: FakeClock): TranscribeVoice {
    return async (input) => {
        const c = cases.find((x) => x.id === input.caseId);
        const ms = 3_000;
        // Muse Voice Transcribe is billed by the hour of audio: $0.18 an hour, and these notes are a few seconds.
        const usd = 0.0003;
        clock.advance(ms);
        ledger.add({ role: 'transcription', provider: 'meta', model: 'muse-voice-transcribe-1.0', usd, priced: true, tokensIn: 0, tokensOut: 0, cacheRead: 0, ms, ok: true });
        return { status: 'ok', transcript: (c?.reference ?? '').replace(/[؟?،,.!]/g, '').trim(), ms, usd };
    };
}
