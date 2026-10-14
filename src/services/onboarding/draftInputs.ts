/**
 * What a draft is made from, and what makes two drafts "the same" (docs/onboarding/03 §4, "Idempotency"). Pure.
 *
 * A draft's inputs are the four things a person can type: an Instagram handle, a website, a YouTube channel and a few lines
 * about themselves, plus which road Instagram is read by (the platform's own account through Business Discovery, or the
 * tenant's own token once it is connected). They are read ONCE, here, into one canonical shape, so that `@Noor.Perfumes`
 * and `instagram.com/noor.perfumes/` are the same input and hash the same: a tenant who retypes what they typed does not
 * start (and pay for) a second draft.
 *
 * `inputsHash` covers the inputs AND the prompt version, so changing the prompt makes every older draft stale rather than
 * reusable.
 */
import { createHash } from 'node:crypto';
import { readWebsiteUrl } from '../adminGuards.js';
import { normalizeInstagramHandle, parseYouTubeRef } from './handles.js';
import { stripInvisible } from './textClean.js';

/** Which road Instagram is read by (03 §1): the platform's account by handle, or the tenant's own connected token. */
export type InstagramRoad = 'discovery' | 'own_token';

export interface DraftInputs {
    /** An Instagram username, lower case, no `@`. */
    instagram: string | null;
    /** An absolute https or http address, as `readWebsiteUrl` writes it. */
    website: string | null;
    /** `@handle`, a channel id (`UC…`) or `youtube.com/user/name`: the three things `parseYouTubeRef` takes back. */
    youtube: string | null;
    /** Text the tenant pasted about themselves (the "paste your About text" fallback, or just more to read). */
    about: string | null;
    via: InstagramRoad;
}

/** The longest "about" text: the same as the cap the model is shown (`SOURCE_CAPS.typed`). */
export const MAX_ABOUT_CHARS = 4000;

export const INPUT_FIELDS = ['instagram', 'website', 'youtube', 'about'] as const;
export type InputField = (typeof INPUT_FIELDS)[number];

export type ReadInputs = { ok: true; value: DraftInputs } | { ok: false; error: string; field: InputField };

const isBlank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** A body key under either of its names (`instagram` or `instagram_username`). `undefined` when the body has neither. */
function pickKey(body: Record<string, unknown>, names: readonly string[]): unknown {
    for (const name of names) if (body[name] !== undefined) return body[name];
    return undefined;
}

/** A YouTube reference as the one string that `parseYouTubeRef` reads back to the same thing. */
export function canonicalYouTube(raw: unknown): string | null {
    const ref = parseYouTubeRef(raw);
    if (!ref) return null;
    if (ref.kind === 'handle') return `@${ref.value}`;
    if (ref.kind === 'channel_id') return ref.value;
    return `youtube.com/user/${ref.value}`;
}

/** Pasted text as it is kept: invisible characters out, whitespace runs folded, trimmed. Null when nothing is left. */
export function cleanAbout(raw: string): string | null {
    const text = stripInvisible(raw).split('\n').map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return text === '' ? null : text;
}

/**
 * The inputs a request means. A field the body names (even as `null` or `""`, which clears it) wins; a field it does not
 * mention comes from `fallback`, which is the tenant's own row (`creators.instagram_username`, `website_url`). A value that
 * cannot be what its field says is a refusal that names the field, so the wizard can mark it.
 */
export function readDraftInputs(body: unknown, fallback: Partial<Pick<DraftInputs, 'instagram' | 'website' | 'youtube' | 'about'>> = {}, via: InstagramRoad = 'discovery'): ReadInputs {
    const source = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const from = <K extends InputField>(field: K, names: readonly string[]): unknown => {
        const given = pickKey(source, names);
        return given === undefined ? fallback[field] ?? null : given;
    };

    const rawInstagram = from('instagram', ['instagram', 'instagram_username']);
    let instagram: string | null = null;
    if (!isBlank(rawInstagram)) {
        instagram = normalizeInstagramHandle(rawInstagram);
        if (!instagram) return { ok: false, field: 'instagram', error: 'That is not an Instagram username: letters, digits, dots and underscores, up to 30.' };
    }

    const rawWebsite = from('website', ['website', 'website_url']);
    let website: string | null = null;
    if (!isBlank(rawWebsite)) {
        const read = readWebsiteUrl(rawWebsite);
        if (!read.ok) return { ok: false, field: 'website', error: read.error };
        website = read.value;
    }

    const rawYouTube = from('youtube', ['youtube', 'youtube_channel']);
    let youtube: string | null = null;
    if (!isBlank(rawYouTube)) {
        youtube = canonicalYouTube(rawYouTube);
        if (!youtube) return { ok: false, field: 'youtube', error: 'That is not a YouTube handle or channel link.' };
    }

    const rawAbout = from('about', ['about', 'about_text']);
    let about: string | null = null;
    if (!isBlank(rawAbout)) {
        if (typeof rawAbout !== 'string') return { ok: false, field: 'about', error: 'The about text must be text.' };
        if (rawAbout.length > MAX_ABOUT_CHARS * 2) return { ok: false, field: 'about', error: `The about text is too long: at most ${MAX_ABOUT_CHARS} characters.` };
        about = cleanAbout(rawAbout);
        if (about && Array.from(about).length > MAX_ABOUT_CHARS) return { ok: false, field: 'about', error: `The about text is too long: at most ${MAX_ABOUT_CHARS} characters.` };
    }

    return { ok: true, value: { instagram, website, youtube, about, via } };
}

/** Whether there is anything to read. */
export const hasAnyInput = (inputs: DraftInputs): boolean => Boolean(inputs.instagram || inputs.website || inputs.youtube || inputs.about);

/**
 * sha256 over the canonical inputs and the prompt version. A change in any of them is a different draft; the same inputs
 * typed differently are the same. `about` is compared with its whitespace folded and case kept (a name's capital is a fact).
 */
export function inputsHash(inputs: DraftInputs, promptVersion: string): string {
    const canonical = JSON.stringify({
        v: 1,
        prompt: promptVersion,
        instagram: inputs.instagram,
        website: inputs.website,
        youtube: inputs.youtube,
        about: inputs.about,
        via: inputs.via,
    });
    return createHash('sha256').update(canonical).digest('hex');
}
