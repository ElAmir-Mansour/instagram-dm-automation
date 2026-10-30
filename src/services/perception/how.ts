/**
 * How a thing was looked at, as words (docs/specs/005-muse-sees research R18): the sentence a description starts with, and the phrase a decision trace starts with,
 * so that the owner reads what the agent actually did and never more. Pure, and kept apart from the code that looks (`source.ts`) so the sales turn's trace can name
 * the way without importing a download.
 *
 *   watched   a fresh mp4 of the creator's own reel or post was shown to the model        "Watched the reel."
 *   library   the creator's own reel, whose saved notes were used (no model, no download)  "Watched the reel earlier (the library's notes on it)."
 *   cover     only a shared post's cover picture was shown, with its caption when it had one "Saw the cover and caption." / "Saw the cover."
 *   caption   only a caption was read, with no model                                         "Read the caption."
 *   media     a photo, a story or a video the customer sent was shown whole                   (no prefix: nothing was left unseen)
 *
 * The way is written into the stored description by a sentence of this module's, so it is also READ back from it (`howOf`): `Perception` has no field for it (the data
 * model is fixed), and the sentence is ours, so what it says cannot be a model's guess.
 */
import { oneLine, SEEN_MAX_CHARS } from './text.js';
import type { PerceptionKind } from './types.js';

export type HowSeen = 'watched' | 'library' | 'cover' | 'caption' | 'media';

/** The sentence a description starts with, by how the media was looked at. A photo, a story or a video the customer sent needs none: it was shown whole. */
export const HOW_PREFIX: Readonly<Record<HowSeen, string>> = Object.freeze({
    watched: 'Watched the reel.',
    library: 'Watched the reel earlier (the library\'s notes on it).',
    cover: 'Saw the cover and caption.',
    caption: 'Read the caption.',
    media: '',
});

/** The cover of a post with no caption. */
const COVER_ONLY = 'Saw the cover.';

/** `seen` with how it was looked at in front of it. With no caption a cover is only a cover. Pure. */
export function withHow(how: HowSeen, seen: string, hasCaption: boolean): string {
    const prefix = how === 'cover' && !hasCaption ? COVER_ONLY : HOW_PREFIX[how];
    return oneLine(prefix ? `${prefix} ${seen}` : seen, SEEN_MAX_CHARS);
}

/** How a stored description says it was looked at, by the sentence it starts with: `media` for one that starts with none. */
export function howOf(seen: string | undefined): { how: HowSeen; captioned: boolean } {
    const text = seen ?? '';
    for (const how of ['watched', 'library', 'caption'] as const) if (text.startsWith(HOW_PREFIX[how])) return { how, captioned: false };
    if (text.startsWith(HOW_PREFIX.cover)) return { how: 'cover', captioned: true };
    if (text.startsWith(COVER_ONLY)) return { how: 'cover', captioned: false };
    return { how: 'media', captioned: false };
}

/** What was read, as a noun phrase. */
const READ: Readonly<Record<PerceptionKind, string>> = Object.freeze({
    reel: 'a shared reel',
    share: 'a shared post',
    story_reply: 'a reply to the account\'s story',
    story_share: 'a shared story',
    story_mention: 'a story mention',
    image: 'a photo',
    video: 'a video',
    audio: 'a voice note',
});

export const readNoun = (kind: PerceptionKind): string => READ[kind];

/** How the trace begins: what was read and how, in the words of what really happened. Pure. */
export function readPhrase(kind: PerceptionKind, seen: string | undefined): string {
    const noun = READ[kind];
    const { how, captioned } = howOf(seen);
    switch (how) {
        case 'watched': return `Watched ${noun}`;
        case 'library': return `Used the library's notes on ${noun}`;
        case 'cover': return `Saw the cover of ${noun}${captioned ? ' and its caption' : ''}`;
        case 'caption': return `Read the caption of ${noun}`;
        default: return `Read ${noun}`;
    }
}
