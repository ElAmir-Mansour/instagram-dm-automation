/**
 * robots.txt, read for `AutoReplyProBot` and `*` (docs/onboarding/03 §1.7), the way RFC 9309 reads it:
 * the group that names this bot wins over `*`, the longest matching rule wins inside it, and when an
 * `Allow` and a `Disallow` match equally long the `Allow` wins. `*` matches anything and a trailing
 * `$` anchors the end. Pure: fetching the file is `safeFetch`'s business (kind `text`).
 */
import { BOT_TOKEN } from './safeFetch.js';

interface Rule {
    allow: boolean;
    pattern: string;
}

export interface Robots {
    /** Whether `path` (with its query) may be fetched. */
    allows(path: string): boolean;
    /** The group that applies: the bot's own, `*`, or none. */
    group: 'bot' | 'wildcard' | 'none';
    rules: readonly Rule[];
}

/** An unreadable or absent file allows everything (RFC 9309 §2.3.1.3: a 4xx means "no restrictions"). */
export const ALLOW_ALL: Robots = { allows: () => true, group: 'none', rules: [] };
/** A file that could not be fetched because the server failed allows nothing (§2.3.1.4: "assume complete disallow"). */
export const DISALLOW_ALL: Robots = { allows: () => false, group: 'wildcard', rules: [{ allow: false, pattern: '/' }] };

/** A rule's pattern as a test against a path: `*` is anything, a final `$` is the end, everything else is literal. */
function matches(pattern: string, path: string): number {
    if (pattern === '') return -1;
    const anchored = pattern.endsWith('$');
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const pieces = body.split('*');
    // Walk the pieces left to right; the first must be a prefix.
    let at = 0;
    for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]!;
        if (i === 0) {
            if (!path.startsWith(piece)) return -1;
            at = piece.length;
            continue;
        }
        const found = path.indexOf(piece, at);
        if (found < 0) return -1;
        at = found + piece.length;
    }
    if (anchored) {
        // The last piece must end the path: re-check from the end, since `indexOf` found the first occurrence.
        const last = pieces[pieces.length - 1]!;
        if (pieces.length === 1 ? path !== body : !path.endsWith(last)) return -1;
    }
    // Specificity is the length of the pattern, wildcards counted.
    return pattern.length;
}

/** Parses a robots.txt body. Only `user-agent`, `allow` and `disallow` lines matter here. */
export function parseRobots(text: string): Robots {
    const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
    let current: { agents: string[]; rules: Rule[] } | null = null;
    let collectingAgents = false;
    for (const rawLine of text.slice(0, 256 * 1024).split(/\r?\n|\r/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const field = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (field === 'user-agent') {
            if (!current || !collectingAgents) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            collectingAgents = true;
        } else if (field === 'allow' || field === 'disallow') {
            collectingAgents = false;
            // A rule before any user-agent line belongs to no group.
            if (current) current.rules.push({ allow: field === 'allow', pattern: value });
        } else {
            collectingAgents = false;
        }
    }
    const bot = BOT_TOKEN.toLowerCase();
    const named = groups.filter((g) => g.agents.some((a) => a !== '*' && a !== '' && bot.includes(a)));
    const wildcard = groups.filter((g) => g.agents.includes('*'));
    const chosen = named.length > 0 ? named : wildcard;
    const group: Robots['group'] = named.length > 0 ? 'bot' : wildcard.length > 0 ? 'wildcard' : 'none';
    // Groups for the same agent are merged, as the RFC says.
    const rules = chosen.flatMap((g) => g.rules);
    return {
        group,
        rules,
        allows(path: string): boolean {
            const target = path.startsWith('/') ? path : `/${path}`;
            let best: { length: number; allow: boolean } | null = null;
            for (const rule of rules) {
                const length = matches(rule.pattern, target);
                if (length < 0) continue;
                // An empty Disallow is "allow everything" and never matches (length -1 above).
                if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { length, allow: rule.allow };
            }
            return best ? best.allow : true;
        },
    };
}
