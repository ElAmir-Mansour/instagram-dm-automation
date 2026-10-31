/**
 * What the agent can take in, told to the model when the customer asks about it (docs/specs/005-muse-sees): "can I send you a voice note?", «ممكن ابعتلك صورة؟».
 *
 *   sensesForTurn(input)   the sales turn's call (`runSalesTurn`, `dmSales/turn.ts`): cue → gate → the fact the turn tells its model. Returns null (nothing is added, and
 *                          the turn is exactly what it would have been) or the line. NEVER throws.
 *
 * **Why.** The sales prompt says nothing about attachments, so the model knows only what the conversation shows. A conversation that began before the owner's switches
 * were on shows the kit's own line, "I can't open photos, voice notes or videos here" (`webhook/attachmentAck.ts`), and the model repeated it on 2026-10-31 to an allowed
 * sender who asked whether a voice note was fine, when a voice note WOULD have been heard.
 *
 * **The order is the safety**, as in recall:
 *
 *   1. **A cue in the message** (`sensesCues`): a voice word (صوت، فويس، ريكورد، أوديو; voice, audio, record) or a picture word (صورة، الصور، سكرين، لقطة شاشة; photo,
 *      picture, pic, image, screenshot), found in the text folded the way keyword matching folds it (`normalizeArabic`). Pure and free: a message without one reads no
 *      setting, so every other DM is the same turn call for call. Video and reel words are not cues here: people use them to ask FOR a video (recall's cues) far more
 *      often than to send one.
 *   2. **The gate, once for each sense the cue names** (`voice` with the kind `audio`, `dm_media` with `image`): the switch, the sender on the allow-list, a route that can
 *      answer, the day's cap. "Send it" is only true when the next one WOULD be read, so the whole gate is asked, not the switch alone. A refusal logs
 *      `perception.skipped:<reason>`, as for every other gate.
 *   3. **The line** (`sensesFact`): what is read, to say yes if they ask whether they may send one, and that an older line of this chat saying otherwise is out of date.
 *
 * Nothing leaves the building: no model is called, and nothing is read but the settings and the day's spend.
 */
import { normalizeArabic } from '../../utils/arabic.js';
import { describeError, log } from '../../utils/log.js';
import { gatePerception, type GateArgs, type GateResult } from './gate.js';

/** What a message can ask about: whether a voice note would be heard, or a photo seen. The names are the capabilities the gate checks. */
export type Sense = 'voice' | 'dm_media';

const fold = (cues: readonly string[]): string[] => cues.map((cue) => normalizeArabic(cue));

/** «صوت» is inside صوتي، صوتية، الصوت، بصوت، صوتيات (not تصويت: a ي stands between); «فويس» inside فويسات. ڤ is not folded, so «ڤويس» is its own cue. */
const AR_VOICE: readonly string[] = fold(['صوت', 'فويس', 'ڤويس', 'ريكورد', 'أوديو']);
/**
 * «صورة» and «صورت» (صورتي، صورتك) and «الصور», never the bare «صور»: it is inside «تصوير», photography, a subject people ask about, not a photo they want
 * to send. «سكرين» is inside سكرينشوت and اسكرين.
 */
const AR_PICTURE: readonly string[] = fold(['صورة', 'صورت', 'الصور', 'سكرين', 'لقطة شاشة']);
const EN_VOICE = /(?<![a-z])(?:voice|audio|record|recording|voicenote|voicemail)s?(?![a-z])/;
const EN_PICTURE = /(?<![a-z])(?:photo|picture|pic|image|screenshot|screen shot)s?(?![a-z])/;

/**
 * The senses the message may be asking about, voice first. Arabic cues match inside a word (Arabic glues the article and prepositions on: «بالصوت», «الصورة»), English cues
 * as whole words. Pure; empty for anything that is not text. A cue only SAYS the gate is worth asking: the model decides what the customer meant.
 */
export function sensesCues(text: unknown): Sense[] {
    if (typeof text !== 'string' || !text.trim()) return [];
    const folded = normalizeArabic(text);
    const senses: Sense[] = [];
    if (EN_VOICE.test(folded) || AR_VOICE.some((cue) => folded.includes(cue))) senses.push('voice');
    if (EN_PICTURE.test(folded) || AR_PICTURE.some((cue) => folded.includes(cue))) senses.push('dm_media');
    return senses;
}

export const hasSensesCue = (text: unknown): boolean => sensesCues(text).length > 0;

/** The kind each sense is asked with: the gate checks that a capability and a kind agree (`capabilityOfKind`). */
const KIND: Readonly<Record<Sense, string>> = Object.freeze({ voice: 'audio', dm_media: 'image' });

/** In English like the other facts of this block ("No video on this topic yet"): the model answers in the customer's language whatever the facts are written in. */
export const SENSES_FACTS = Object.freeze({
    voice: 'Voice notes the customer sends in this chat are heard and answered. If they ask whether they can send one, say yes. '
        + 'A line earlier in this chat that said voice notes cannot be opened here is out of date.',
    dm_media: 'Photos, screenshots, videos and shared reels the customer sends in this chat are read and answered. If they ask whether they can send one, say yes. '
        + 'A line earlier in this chat that said these cannot be opened here is out of date.',
    both: 'Voice notes, photos, screenshots, videos and shared reels the customer sends in this chat are heard or read, and answered. If they ask whether they can send one, '
        + 'say yes. A line earlier in this chat that said these cannot be opened here is out of date.',
});

/** The line for the senses the gate let through, or null for none. Pure. */
export function sensesFact(open: readonly Sense[]): string | null {
    const voice = open.includes('voice');
    const media = open.includes('dm_media');
    if (voice && media) return SENSES_FACTS.both;
    if (voice) return SENSES_FACTS.voice;
    if (media) return SENSES_FACTS.dm_media;
    return null;
}

export interface SensesInput {
    creatorId: string;
    /** The Instagram sender: the allow-list is checked against it. It goes nowhere else. */
    senderId: string;
    /** What the customer wrote, or said (a voice note's transcript). */
    text: string;
}

export interface SensesDeps {
    /** The gate. Default: `gatePerception`, as the DM's own perception asks it. */
    gate?: (args: GateArgs) => Promise<GateResult>;
}

let overrides: SensesDeps = {};

/**
 * Tests only: replaces the gate for every `sensesForTurn` made through the sales turn (which passes none of its own), the way `setRecallDeps` does for recall. Returns the
 * previous overrides, so a test can put them back.
 */
export function setSensesDeps(next: SensesDeps): SensesDeps {
    const previous = overrides;
    overrides = next;
    return previous;
}

/** The line to tell the model, or null. Never throws: a gate that broke is a turn without the line, which is the turn as it was. */
export async function sensesForTurn(input: SensesInput, given: SensesDeps = {}): Promise<string | null> {
    const deps: SensesDeps = { ...overrides, ...given };
    const logBase = { creator_id: input.creatorId };
    try {
        const asked = sensesCues(input.text);
        if (asked.length === 0) return null;
        const open: Sense[] = [];
        for (const sense of asked) {
            const args: GateArgs = { creatorId: input.creatorId, senderId: input.senderId, capability: sense, kind: KIND[sense] };
            const gated = await (deps.gate ?? gatePerception)(args);
            if (gated.ok) open.push(sense);
        }
        const line = sensesFact(open);
        if (line) log('info', 'senses.told', { ...logBase, senses: open.join(',') });
        return line;
    } catch (err) {
        log('warn', 'senses.failed', { ...logBase, error: describeError(err) });
        return null;
    }
}
