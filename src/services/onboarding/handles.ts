/**
 * The handles a tenant types into the wizard, made safe to send to a platform. Pure.
 *
 * Both are SPLICED into a request: an Instagram username goes inside the parentheses of Business Discovery's
 * field expression (`business_discovery.username(<here>){…}`), so a value such as `x){id}` would change what is
 * asked. A handle is therefore only ever what the platform's own rules allow, and anything else is `null`,
 * which the caller turns into `invalid_handle` before any request is made.
 */
import { classifySocialUrl } from './socials.js';

/** Text that is a link and not a username that happens to contain a dot: it starts with the host (after an optional scheme and `www.`). */
const INSTAGRAM_LINK = /^(?:https?:\/\/)?(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)(?:[/?#]|$)/i;
const YOUTUBE_LINK = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?youtube\.com(?:[/?#]|$)/i;

/** Instagram usernames: letters, digits, periods and underscores, at most 30. Always lower case here (they are not case-sensitive). */
export const INSTAGRAM_USERNAME = /^[a-z0-9._]{1,30}$/;

/**
 * `@Name`, `name` or a profile link (`instagram.com/name`, `https://www.instagram.com/name/?hl=ar`) to `name`, or null
 * when the text cannot be a username: a post link, a path, a space, a character Instagram does not allow, or more
 * than 30 characters.
 */
export function normalizeInstagramHandle(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let text = raw.trim();
    if (!text || text.length > 300) return null;
    if (INSTAGRAM_LINK.test(text)) {
        const link = classifySocialUrl(/^https?:\/\//i.test(text) ? text : `https://${text}`);
        if (!link || link.platform !== 'instagram') return null;
        text = link.handle;
    }
    text = text.replace(/^@+/, '').toLowerCase();
    return INSTAGRAM_USERNAME.test(text) ? text : null;
}

/** What names a YouTube channel to `channels.list`: its `@handle`, its id (`UC…`) or, for a legacy `/user/` link, its username. */
export type YouTubeRef =
    | { kind: 'handle'; value: string }
    | { kind: 'channel_id'; value: string }
    | { kind: 'username'; value: string };

/** `@name` is 3 to 30 characters of letters, digits, `_`, `-` and `.`. */
const YOUTUBE_HANDLE = /^[\p{L}\p{M}\p{N}_.\-]{3,30}$/u;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const LEGACY_USERNAME = /^[A-Za-z0-9._-]{2,80}$/;

/**
 * `@Name`, `name`, a channel id, or a channel link (`youtube.com/@name`, `/channel/UC…`, `/user/name`, `/c/name`) as the
 * one thing the API can look up, or null. The handle is returned WITHOUT the `@`; the client adds it. A `/c/name` custom
 * URL is tried as a handle, which is what it usually is; if it is not, the lookup finds nothing and says so.
 */
export function parseYouTubeRef(raw: unknown): YouTubeRef | null {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text || text.length > 300) return null;

    if (YOUTUBE_LINK.test(text)) {
        let url: URL;
        try {
            url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
        } catch {
            return null;
        }
        if (!/^(?:www\.|m\.|music\.)?youtube\.com$/i.test(url.hostname)) return null;
        const [first = '', second = ''] = url.pathname.split('/').filter(Boolean).map((s) => safeDecode(s));
        if (first.startsWith('@')) return handleRef(first.slice(1));
        if (first === 'channel') return CHANNEL_ID.test(second) ? { kind: 'channel_id', value: second } : null;
        if (first === 'user') return LEGACY_USERNAME.test(second) ? { kind: 'username', value: second } : null;
        if (first === 'c') return handleRef(second);
        return null;
    }

    if (CHANNEL_ID.test(text)) return { kind: 'channel_id', value: text };
    return handleRef(text.replace(/^@+/, ''));
}

function handleRef(handle: string): YouTubeRef | null {
    return YOUTUBE_HANDLE.test(handle) ? { kind: 'handle', value: handle } : null;
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}
