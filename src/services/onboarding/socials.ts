/**
 * Which platform a link belongs to, and which account on it. Pure: the site extractor reads every
 * `<a href>` and every JSON-LD `sameAs` through this, so that a "Share on Facebook" button or a link to
 * one post is never taken for the creator's own page.
 *
 * Only the platforms a profile can link (`SOCIALS`) are classified, plus WhatsApp, which is a contact
 * and not a social link. The URL returned is canonical: https, no query, no fragment, no trailing slash.
 */
import type { InfographicSocial } from '../profile/types.js';

export interface SocialLink {
    platform: InfographicSocial;
    url: string;
    handle: string;
}

const hostOf = (u: URL): string => u.hostname.toLowerCase().replace(/^(?:www|m|mobile|web)\./, '');
const segments = (u: URL): string[] => u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponentSafe(s));

function decodeURIComponentSafe(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about', 'developer', 'legal', 'web', 'challenge', 'directory', 'popular', 'share', 'privacy', 'terms']);
const X_RESERVED = new Set(['intent', 'share', 'home', 'i', 'search', 'hashtag', 'explore', 'settings', 'login', 'signup', 'tos', 'privacy', 'messages', 'notifications', 'compose', 'about', 'download']);
const FACEBOOK_RESERVED = new Set(['sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'login.php', 'recover', 'policies', 'privacy', 'help', 'events', 'watch', 'marketplace', 'profile.php', 'pages', 'hashtag', 'about', 'ads', 'business', 'public', 'gaming', 'stories', 'reel', 'reels', 'photo', 'photo.php', 'video', 'videos', 'permalink.php', 'story.php', 'l.php']);
const GITHUB_RESERVED = new Set(['features', 'about', 'pricing', 'login', 'join', 'topics', 'orgs', 'marketplace', 'sponsors', 'settings', 'explore', 'notifications', 'search', 'security', 'contact', 'site', 'enterprise']);

/** The account a profile link points at, or null for a post, a share button, a login page or anything that is not a platform. */
export function classifySocialUrl(href: string): SocialLink | null {
    let u: URL;
    try {
        u = new URL(href);
    } catch {
        return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = hostOf(u);
    const [first = '', second = ''] = segments(u);
    const link = (platform: InfographicSocial, url: string, handle: string): SocialLink => ({ platform, url, handle });

    if (host === 'instagram.com' || host === 'instagr.am') {
        if (!/^[A-Za-z0-9._]{1,30}$/.test(first) || INSTAGRAM_RESERVED.has(first.toLowerCase())) return null;
        return link('instagram', `https://www.instagram.com/${first}`, first);
    }
    if (host === 'youtube.com') {
        if (first.startsWith('@') && /^@[\w.\-؀-ۿ]{2,60}$/u.test(first)) return link('youtube', `https://www.youtube.com/${first}`, first.slice(1));
        if ((first === 'channel' || first === 'c' || first === 'user') && /^[\w.\-]{2,80}$/.test(second)) return link('youtube', `https://www.youtube.com/${first}/${second}`, second);
        return null;
    }
    if (host === 'linkedin.com') {
        if ((first === 'in' || first === 'company' || first === 'school' || first === 'showcase') && /^[\w\-%.]{2,100}$/.test(second)) {
            return link('linkedin', `https://www.linkedin.com/${first}/${second}`, second);
        }
        return null;
    }
    if (host === 'x.com' || host === 'twitter.com') {
        if (!/^[A-Za-z0-9_]{1,15}$/.test(first) || X_RESERVED.has(first.toLowerCase())) return null;
        return link('x', `https://x.com/${first}`, first);
    }
    if (host === 'tiktok.com') {
        if (first.startsWith('@') && /^@[\w.]{2,40}$/.test(first)) return link('tiktok', `https://www.tiktok.com/${first}`, first.slice(1));
        return null;
    }
    if (host === 'facebook.com' || host === 'fb.com') {
        if (!/^[A-Za-z0-9.\-]{3,80}$/.test(first) || FACEBOOK_RESERVED.has(first.toLowerCase())) return null;
        return link('facebook', `https://www.facebook.com/${first}`, first);
    }
    if (host === 'github.com') {
        if (!/^[A-Za-z0-9-]{1,39}$/.test(first) || GITHUB_RESERVED.has(first.toLowerCase())) return null;
        return link('github', `https://github.com/${first}`, first);
    }
    return null;
}

/**
 * A WhatsApp contact link as `https://wa.me/<digits>` (or the `wa.me/message/<code>` form, which hides the
 * number), or null. Reads `wa.me/<n>`, `api.whatsapp.com/send?phone=<n>`, `web.whatsapp.com/send?phone=<n>`
 * and `whatsapp://send?phone=<n>`.
 */
export function whatsappFrom(href: string): string | null {
    let u: URL;
    try {
        u = new URL(href);
    } catch {
        return null;
    }
    const digits = (s: string): string | null => {
        const d = s.replace(/\D/g, '');
        return d.length >= 7 && d.length <= 15 ? d : null;
    };
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.protocol === 'whatsapp:') {
        const d = digits(u.searchParams.get('phone') ?? '');
        return d ? `https://wa.me/${d}` : null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (host === 'wa.me') {
        const [first = '', second = ''] = segments(u);
        if (first === 'message' && /^[A-Za-z0-9]{6,40}$/.test(second)) return `https://wa.me/message/${second}`;
        const d = digits(first);
        return d ? `https://wa.me/${d}` : null;
    }
    if (host === 'api.whatsapp.com' || host === 'web.whatsapp.com' || host === 'whatsapp.com') {
        const d = digits(u.searchParams.get('phone') ?? '');
        return d ? `https://wa.me/${d}` : null;
    }
    return null;
}

/** The link-in-bio hubs (03 §1, "Website"): a page that is only a list of outbound links. */
const HUB_HOSTS = ['linktr.ee', 'beacons.ai', 'bio.link', 'lnk.bio', 'linkin.bio', 'taplink.cc', 'solo.to', 'msha.ke', 'campsite.bio'];

export function isLinkHubHost(host: string): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return HUB_HOSTS.some((hub) => h === hub || h.endsWith(`.${hub}`));
}
