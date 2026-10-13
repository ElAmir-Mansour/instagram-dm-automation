/**
 * What Instagram's Graph API sends for the draft's two reads, with Arabic and English accounts: a Business Discovery answer
 * (`{ business_discovery: {…}, id }`), the tenant's own user node and `/media`, and the YouTube answers beside them. Shaped
 * as Meta and Google send them (counts as numbers, a post with hidden likes lacking `like_count`, the profile picture present
 * in the body so that a test can show it is never kept). The accounts and captions are invented; the captions are the
 * register fixtures in `captions.ts`. Not a test file.
 */
import { EGYPTIAN, ENGLISH, GULF, LEVANTINE, MSA, MSA_WITH_GULF_ASKS } from './captions.js';

export const SHOP_HANDLE = 'noor.perfumes';
/** The id of the platform's own Instagram account, which Business Discovery is asked through. */
export const PLATFORM_IG_ID = '17841400000000001';
export const PLATFORM_TOKEN = 'EAAJ-platform-page-token-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJ';
export const OWN_IG_ID = '17841499999999999';
export const OWN_TOKEN = 'EAAJ-tenant-own-page-token-9876543210zyxwvutsrqponmlkjihgfedcba-KLMNOPQRST';

type Over = Record<string, unknown>;

/** One media object as Graph sends it. `i` (from 1) makes the id, the date and the permalink. */
export function graphMedia(i: number, caption: string | null, over: Over = {}): Over {
    const day = String(((i * 3) % 28) + 1).padStart(2, '0');
    const media: Over = {
        id: `1790000000000${String(i).padStart(4, '0')}`,
        media_type: 'IMAGE',
        media_product_type: 'FEED',
        timestamp: `2026-09-${day}T10:00:00+0000`,
        permalink: `https://www.instagram.com/p/C${i}x/`,
        like_count: 100 + i * 10,
        comments_count: i,
        ...over,
    };
    if (caption !== null) media.caption = caption;
    return media;
}

/** The captions as a media list, newest first. */
export function mediaFrom(captions: readonly string[], over: (i: number) => Over = () => ({})): Over[] {
    return captions.map((c, k) => graphMedia(k + 1, c, over(k + 1)));
}

export interface DiscoveryOptions {
    username?: string;
    biography?: string;
    website?: string | null;
    followers?: number;
    mediaCount?: number;
    media?: Over[];
}

/** A Business Discovery answer. The profile picture is in the body on purpose: it is never requested, and never kept. */
export function discoveryBody(o: DiscoveryOptions = {}): Over {
    const bd: Over = {
        username: o.username ?? SHOP_HANDLE,
        biography: o.biography ?? 'متجر نور للعطور 🌹\nعطور شرقية وغربية أصلية\nشحن لكل مدن المملكة',
        followers_count: o.followers ?? 12_400,
        media_count: o.mediaCount ?? 214,
        media: { data: o.media ?? mediaFrom(GULF), paging: { cursors: { before: 'QVFIUjBBYWF', after: 'QVFIUlhEeWo' } } },
        profile_picture_url: 'https://scontent.example/pfp-of-the-owner.jpg',
    };
    if (o.website !== null) bd.website = o.website ?? 'https://noor-perfumes.example';
    return { business_discovery: bd, id: PLATFORM_IG_ID };
}

/** The separate request for `name`. */
export const nameBody = (name: string): Over => ({ business_discovery: { name, id: '17841400000000777' }, id: PLATFORM_IG_ID });

/** What Meta sends inside a batch item for a failure: `{ code: <HTTP>, body: '<json>' }`. */
export const batchError = (http: number, code: number, message: string, subcode?: number): Over => ({
    code: http,
    body: JSON.stringify({ error: { message, type: 'OAuthException', code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), fbtrace_id: 'AbCdEf' } }),
});

export const batchOk = (body: unknown): Over => ({ code: 200, body: JSON.stringify(body) });

/** The tenant's own user node and `/media`. */
export function ownUserBody(over: Over = {}): Over {
    return {
        username: 'ahmed.coach',
        name: 'Ahmed | Fitness Coach',
        biography: 'Online fitness coach\nPlans that fit a busy week',
        website: 'https://ahmed-fit.example',
        followers_count: 5_300,
        media_count: 88,
        id: OWN_IG_ID,
        ...over,
    };
}
export const ownMediaBody = (captions: readonly string[] = ENGLISH): Over => ({ data: mediaFrom(captions), paging: {} });

// ─── Caption sets as accounts ───────────────────────────────────────────────────────────

export const ACCOUNTS: Readonly<Record<string, { handle: string; captions: readonly string[] }>> = {
    gulf: { handle: 'noor.perfumes', captions: GULF },
    egyptian: { handle: 'sama.academy', captions: EGYPTIAN },
    levantine: { handle: 'layali.shop', captions: LEVANTINE },
    msa: { handle: 'tarbiya.edu', captions: MSA },
    msaGulfAsks: { handle: 'dawra.online', captions: MSA_WITH_GULF_ASKS },
    english: { handle: 'ahmed.coach', captions: ENGLISH },
};

// ─── YouTube ────────────────────────────────────────────────────────────────────────────

export const CHANNEL_ID = 'UCabcdefghijklmnopqrstuv';
export const YT_KEY = 'AIzaSyD-platform-api-key-0123456789abcdefghij';

export interface ChannelOptions {
    title?: string;
    description?: string;
    customUrl?: string;
    country?: string;
    defaultLanguage?: string;
    keywords?: string;
    subscribers?: number;
    hiddenSubscribers?: boolean;
    videoCount?: number;
    uploads?: string | null;
}

/** A `channels.list` answer for one channel. The thumbnails are in the body: they are never kept. */
export function channelsBody(o: ChannelOptions = {}): Over {
    return {
        kind: 'youtube#channelListResponse',
        pageInfo: { totalResults: 1, resultsPerPage: 5 },
        items: [{
            kind: 'youtube#channel',
            id: CHANNEL_ID,
            snippet: {
                title: o.title ?? 'أكاديمية البرمجة',
                description: o.description ?? 'قناة لتعليم البرمجة من الصفر باللغة العربية.\nدروس أسبوعية ومشاريع عملية.',
                customUrl: o.customUrl ?? '@barmaga-academy',
                publishedAt: '2021-03-04T12:00:00Z',
                thumbnails: { default: { url: 'https://yt3.example/avatar.jpg' } },
                country: o.country ?? 'SA',
                defaultLanguage: o.defaultLanguage ?? 'ar',
            },
            contentDetails: { relatedPlaylists: o.uploads === null ? {} : { uploads: o.uploads ?? 'UUabcdefghijklmnopqrstuv' } },
            statistics: { viewCount: '1200345', subscriberCount: String(o.subscribers ?? 48_200), hiddenSubscriberCount: o.hiddenSubscribers ?? false, videoCount: String(o.videoCount ?? 126) },
            brandingSettings: { channel: { title: o.title ?? 'أكاديمية البرمجة', keywords: o.keywords ?? 'برمجة "تعلم البرمجة" python', country: o.country ?? 'SA' } },
        }],
    };
}

/** An item of `playlistItems.list`. */
export function playlistItem(n: number, title: string, description = '', over: Over = {}): Over {
    return {
        kind: 'youtube#playlistItem',
        snippet: {
            publishedAt: `2026-09-${String(n).padStart(2, '0')}T08:00:00Z`,
            title,
            description,
            resourceId: { kind: 'youtube#video', videoId: `vid${String(n).padStart(8, '0')}` },
            thumbnails: { default: { url: `https://i.ytimg.example/vi/${n}/default.jpg` } },
            ...over,
        },
    };
}

export const playlistBody = (items: Over[]): Over => ({ kind: 'youtube#playlistItemListResponse', pageInfo: { totalResults: items.length, resultsPerPage: 15 }, items });

/** What Google sends for an error. */
export const googleError = (code: number, message: string, reason: string, status = 'ERR'): Over => ({
    error: { code, message, errors: [{ message, domain: 'youtube.quota', reason }], status },
});
/** The newer envelope, where the reason is in `details`. */
export const googleDetailError = (code: number, message: string, reason: string, status: string): Over => ({
    error: { code, message, status, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }] },
});
