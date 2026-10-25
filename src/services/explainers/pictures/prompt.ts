/**
 * The words a picture is drawn from, the seed, and the guard that keeps a woman or a girl out of a prompt (illustrated explainers, research.md R5;
 * spec FR-013, FR-014, FR-018). Pure: no database, no clock, no network, so the same scene always gives the same prompt and the guard can be
 * tested on its own.
 *
 * ORDER (T038): the style, then each character named by the index of the reference picture it is sent as ("Image 0 shows the recurring
 * character: …"), then the brief, then the owner's note for this drawing, then the rules every picture carries. The model reads the references
 * as images 0..3 in the order they are attached, and `draw.ts` attaches them in the order of the characters listed here.
 *
 * THE PEOPLE RULE IS POSITIVE. The fixed text says "every person in the picture is a man or a boy", not "no women or girls": a diffusion prompt
 * that names what it must not draw can prime the model with it (the owner's lead, 2026-10-25). The words "woman" and "girl" therefore never
 * appear in a prompt we write. What keeps them out of the picture is on our side of the provider: this guard refuses a brief, a note or a
 * character description that names one (`EXPLAINER_PROMPT_REFUSED`, before any allowance is reserved and before any call), the writer is told the
 * rule, and the owner approves every picture. The other fixed rules (no text, no real faces) are the plan's own wording; FLUX.2 klein takes no
 * negative prompt, so they stay in the prompt.
 *
 * What is NOT guarded: the style line. It is the owner's own art direction and a word such as "mother-of-pearl" is not a person; FR-013 names the
 * brief and the character descriptions, and the lead's brief adds the redraw note.
 */
import { createHash } from 'node:crypto';
import { ExplainerError } from '../errors.js';
import { findFemaleSubject } from '../spec.js';

/** A scene's picture: 16:9, a multiple of 16 on both sides as the model wants. */
export const SCENE_SIZE = { width: 1024, height: 576 } as const;
/** A character candidate. Under 512 on both sides, so an approved one is always small enough to be sent back as a reference. */
export const CANDIDATE_SIZE = { width: 448, height: 448 } as const;
/** The platform admin's "Test" on the provider card: the smallest picture the model draws. */
export const TEST_SIZE = { width: 256, height: 256 } as const;

/** A redraw note's limit (data-model §2: `draw_note`). */
export const MAX_NOTE_CHARS = 300;
/** A character description's limit (data-model §6.1). */
export const MAX_CHARACTER_DESCRIPTION_CHARS = 400;

/** What the provider test draws: no person in it at all, so there is nothing to guard and nothing to prime. */
export const TEST_PROMPT = 'A simple flat illustration of a single tree on a hill, with a few small clouds in a pale sky.';

/** A character as a prompt needs it: its key, for the refusal that names it, and its English description. */
export interface PromptCharacter {
    key: string;
    description: string;
}

export interface ScenePromptInput {
    /** The art direction (`studio_settings.explainer.style`). May be empty. */
    style: string;
    /** In the order their references are attached: the character at index i is "image i". */
    characters: readonly PromptCharacter[];
    brief: string;
    note?: string | null;
}

/** Code points, as Postgres's `char_length` and the limits in settings count them: an emoji is one. */
const countCharacters = (text: string): number => [...text].length;

const clean = (text: string | null | undefined): string => (typeof text === 'string' ? text.trim() : '');

function refuse(field: string, message: string, extra: Record<string, unknown> = {}): never {
    throw new ExplainerError('EXPLAINER_PROMPT_REFUSED', message, { field, ...extra });
}

function refuseWoman(field: string, label: string, text: string, extra: Record<string, unknown> = {}): void {
    const word = findFemaleSubject(text);
    if (word) refuse(field, `${label} mentions «${word}»; Explainers never draw women or girls.`, { ...extra, word });
}

/**
 * Refuses, with 422 `EXPLAINER_PROMPT_REFUSED`, the first text that names a woman or a girl: the brief, then the note, then each character's
 * description. Called before an allowance is reserved and before a provider is asked, so a refusal costs nothing.
 */
export function refuseFemaleSubjects(parts: { brief?: string | null; note?: string | null; characters?: readonly PromptCharacter[] }): void {
    refuseWoman('brief', 'The picture brief', clean(parts.brief));
    refuseWoman('note', 'The redraw note', clean(parts.note));
    for (const character of parts.characters ?? []) {
        refuseWoman('character', `The description of the character «${character.key}»`, clean(character.description), { character: character.key });
    }
}

/**
 * The owner's redraw note, checked on its own: the trimmed note, or null for none. 422 `EXPLAINER_PROMPT_REFUSED` for one over 300 characters or one
 * that names a woman or a girl. It is the owner's own text and costs nothing to refuse, so a redraw calls this before it reads a thing.
 */
export function refuseNote(note: string | null | undefined): string | null {
    const text = clean(note);
    if (!text) return null;
    if (countCharacters(text) > MAX_NOTE_CHARS) refuse('note', `The redraw note is ${countCharacters(text)} characters; the limit is ${MAX_NOTE_CHARS}.`);
    refuseWoman('note', 'The redraw note', text);
    return text;
}

/** What every scene picture carries. The people rule says what IS drawn; see the top of the file. */
const SCENE_RULES = 'Composition: a wide 16:9 picture. Keep the top quarter of the picture calm and empty. '
    + 'No text, letters, numbers or signage anywhere. Every person in the picture is a man or a boy. No real people\'s faces.';

const CANDIDATE_RULES = 'Composition: a square picture with the whole figure visible and some space around it. '
    + 'No text, letters, numbers or signage. Every person in the picture is a man or a boy. No real people\'s faces.';

/**
 * The prompt for one scene. Refuses (422 `EXPLAINER_PROMPT_REFUSED`) a scene with no brief, a note over 300 characters, and any brief, note or
 * character description that names a woman or a girl; otherwise the same input always gives the same text.
 */
export function buildScenePrompt(input: ScenePromptInput): string {
    const brief = clean(input.brief);
    if (!brief) refuse('brief', 'The scene has no picture brief, so there is nothing to draw.');
    const note = clean(input.note);
    if (countCharacters(note) > MAX_NOTE_CHARS) refuse('note', `The redraw note is ${countCharacters(note)} characters; the limit is ${MAX_NOTE_CHARS}.`);
    refuseFemaleSubjects({ brief, note, characters: input.characters });

    const lines: string[] = [];
    const style = clean(input.style);
    if (style) lines.push(`Style: ${style}`);
    input.characters.forEach((character, index) => {
        const description = clean(character.description).replace(/[.\s]+$/, '');
        lines.push(
            `Image ${index} shows the recurring character: ${description}. `
            + `Keep this character exactly as in image ${index}: the same face, hair, clothes and proportions.`
        );
    });
    lines.push(`Scene: ${brief}`);
    if (note) lines.push(`Change for this drawing: ${note}`);
    lines.push(SCENE_RULES);
    return lines.join('\n');
}

/**
 * A character description to design from, checked on its own: the trimmed text, or 422 `EXPLAINER_PROMPT_REFUSED` for an empty one, one over 400
 * characters, and one that names a woman or a girl, in that order. The candidates call this before they read a thing.
 */
export function refuseDescription(description: string | null | undefined): string {
    const text = clean(description);
    if (!text) refuse('description', 'Describe the character first: there is nothing to draw.');
    if (countCharacters(text) > MAX_CHARACTER_DESCRIPTION_CHARS) {
        refuse('description', `The character description is ${countCharacters(text)} characters; the limit is ${MAX_CHARACTER_DESCRIPTION_CHARS}.`);
    }
    refuseWoman('description', 'The character description', text);
    return text;
}

/**
 * The prompt for a character candidate: one figure, whole, on a plain background, which is what makes a good reference. Refuses a description that
 * `refuseDescription` refuses.
 */
export function buildCandidatePrompt(input: { style: string; description: string }): string {
    const description = refuseDescription(input.description);

    const lines: string[] = [];
    const style = clean(input.style);
    if (style) lines.push(`Style: ${style}`);
    lines.push(
        'Character design sheet: a single recurring cartoon character, shown full body from the front, centered, on a plain light background. '
        + `The character: ${description.replace(/[.\s]+$/, '')}.`
    );
    lines.push(CANDIDATE_RULES);
    return lines.join('\n');
}

/**
 * The seed of a scene's picture: from the explainer, the scene's position and the attempt (the number of pictures the scene has had, which only a
 * successful draw adds to). The same three give the same seed, so a retry of a draw that failed repeats it, and a redraw has a new attempt and
 * so a new seed. A whole number below 2^31, which every seed field the model's API takes accepts.
 */
export function pictureSeed(explainerId: string, position: number, attempt: number): number {
    const digest = createHash('sha256').update(`${explainerId.toLowerCase()}|${position}|${attempt}`).digest();
    return digest.readUInt32BE(0) & 0x7fffffff;
}

/**
 * A fingerprint of what a picture was drawn from: the prompt, the size and the references (by upload id, in the order they were attached). It is
 * stored with the picture (`prompt_hash`), so two pictures of one scene can be told apart by what they were asked for, not just by their bytes.
 */
export function promptHash(prompt: string, parts: { width: number; height: number; references: readonly string[] }): string {
    return createHash('sha256').update(JSON.stringify([prompt, parts.width, parts.height, parts.references])).digest('hex');
}
