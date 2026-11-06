/**
 * Who is asking for an uploaded file, in a word, for the `media.served` log line: storage downloads cost money (Supabase blocked the
 * org for 22 GB in a month, 2026-11), and the log is how a spike is traced to its caller. A guess from the request's own headers, never
 * trusted for anything else.
 *
 *   dashboard  a browser on this app's own pages (the Referer names this host)
 *   meta       Facebook / Instagram fetchers
 *   google     YouTube and Google's fetchers
 *   tiktok     TikTok's fetchers
 *   browser    any other browser
 *   script     the Mac worker, curl, Node and the like
 *   unknown    no User-Agent at all
 */
export type MediaClient = 'dashboard' | 'meta' | 'google' | 'tiktok' | 'browser' | 'script' | 'unknown';

export function mediaClient(headers: Record<string, string | string[] | undefined> | undefined, ownHost: string | undefined): MediaClient {
    const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? '' : value ?? '');
    const agent = one(headers?.['user-agent']).toLowerCase();
    const referer = one(headers?.['referer']).toLowerCase();
    if (/facebookexternalhit|facebookplatform|facebookcatalog|meta-external|instagram/.test(agent)) return 'meta';
    if (/google|youtube/.test(agent)) return 'google';
    if (/tiktok|bytespider|bytedance/.test(agent)) return 'tiktok';
    if (ownHost && referer) {
        try {
            if (new URL(referer).host === ownHost.toLowerCase()) return 'dashboard';
        } catch {
            // not a URL: not ours
        }
    }
    if (/mozilla\//.test(agent)) return 'browser';
    if (agent) return 'script';
    return 'unknown';
}
