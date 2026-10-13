/**
 * The address rules of `safeFetch` (docs/onboarding/03 §1, "the SSRF guard"): which URLs may be
 * fetched at all, and which IP addresses a host may resolve to. Pure: no socket, no DNS of its own.
 * `guardedLookup` takes the resolver it should ask, so a test hands it a table.
 *
 * Two layers, because they catch different things:
 *
 *   - `validateFetchUrl` looks at what was typed. http or https, ports 80 and 443, no credentials,
 *     no single-label name, no `.local` / `.internal` name and no IP literal in any spelling
 *     (`2130706433`, `0x7f.1`, `0177.0.0.1` and `[::ffff:7f00:1]` all name 127.0.0.1; the URL
 *     parser turns them into one canonical form, and an IP in that form is refused whatever it is).
 *   - `guardedLookup` looks at what a name *resolves* to. A public-looking name can point at a
 *     private address, and a name can carry one public and one private record, so the whole host
 *     is refused if ANY answer is blocked.
 *
 * `isBlockedAddress` fails closed: an address it cannot parse is blocked. For IPv6 the default is
 * blocked too: only global unicast (2000::/3) is let through, minus the documentation and
 * special-purpose ranges inside it, and the three forms that carry an IPv4 address (mapped, NAT64
 * and 6to4) are judged by the IPv4 address they carry.
 */

// ─── IPv4 ────────────────────────────────────────────────────────────────────────────────────

/** One part of an address the way `inet_aton` reads it: `0x7f` hex, `0177` octal, `127` decimal. */
function ipv4Part(part: string): number | null {
    if (part.length === 0 || part.length > 12) return null;
    if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
    if (/^0[0-7]*$/.test(part)) return parseInt(part, 8) || 0;
    if (/^[1-9]\d*$/.test(part)) return parseInt(part, 10);
    return null;
}

/**
 * An IPv4 address as an unsigned 32-bit number, read as `inet_aton` (and so getaddrinfo, and
 * so a connect by name) reads it: one to four parts, each decimal, octal or hex, the last one
 * filling the bytes the others leave. `127.1`, `2130706433`, `0x7f000001` and `0177.0.0.1` are all
 * 127.0.0.1. `null` for anything that is not an address.
 */
export function parseIpv4(text: string): number | null {
    const parts = text.split('.');
    if (parts.length < 1 || parts.length > 4) return null;
    const values = parts.map(ipv4Part);
    if (values.some((v) => v === null)) return null;
    const nums = values as number[];
    const last = nums[nums.length - 1]!;
    const head = nums.slice(0, -1);
    if (head.some((n) => n > 255)) return null;
    if (last >= 256 ** (5 - parts.length)) return null;
    let value = last;
    head.forEach((n, i) => {
        value += n * 256 ** (3 - i);
    });
    return value >>> 0;
}

/** [address, prefix length, why]. The spec's list (03 §1) plus the one metadata address that sits in public space. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number, string]> = [
    ['0.0.0.0', 8, 'this-network (0/8)'],
    ['10.0.0.0', 8, 'private (10/8)'],
    ['100.64.0.0', 10, 'carrier-grade NAT (100.64/10)'],
    ['127.0.0.0', 8, 'loopback (127/8)'],
    ['169.254.0.0', 16, 'link-local and cloud metadata (169.254/16)'],
    ['172.16.0.0', 12, 'private (172.16/12)'],
    ['192.0.0.0', 24, 'IETF protocol assignments (192.0.0/24)'],
    ['192.0.2.0', 24, 'documentation (192.0.2/24)'],
    ['192.168.0.0', 16, 'private (192.168/16)'],
    ['198.18.0.0', 15, 'benchmarking (198.18/15)'],
    ['198.51.100.0', 24, 'documentation (198.51.100/24)'],
    ['203.0.113.0', 24, 'documentation (203.0.113/24)'],
    ['224.0.0.0', 4, 'multicast (224/4)'],
    ['240.0.0.0', 4, 'reserved and broadcast (240/4)'],
    // Azure's wire server answers metadata-style requests from inside a VM, and it is not in a private range.
    ['168.63.129.16', 32, 'cloud metadata (Azure wire server)'],
];

const BLOCKED_V4_NUMERIC = BLOCKED_V4.map(([base, bits, why]) => ({ base: parseIpv4(base)!, bits, why }));

function inV4(n: number, base: number, bits: number): boolean {
    return ((n ^ base) >>> (32 - bits)) === 0;
}

/** Why an IPv4 address (as a number) is blocked, or null when it is public. */
function blockedV4Reason(n: number): string | null {
    for (const range of BLOCKED_V4_NUMERIC) if (inV4(n, range.base, range.bits)) return range.why;
    return null;
}

// ─── IPv6 ────────────────────────────────────────────────────────────────────────────────────

/** An IPv6 address as its 16 bytes, or null. Accepts `::` compression, an embedded dotted IPv4 tail and any letter case. */
export function parseIpv6(text: string): Uint8Array | null {
    let s = text;
    if (s.length === 0 || s.length > 64) return null;
    // A dotted IPv4 tail ("::ffff:127.0.0.1") is two groups.
    const tail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (tail) {
        const v4 = parseIpv4(tail[2]!);
        if (v4 === null || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail[2]!)) return null;
        s = `${tail[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const groups = (part: string): string[] | null => {
        if (part === '') return [];
        const items = part.split(':');
        return items.every((g) => /^[0-9a-f]{1,4}$/i.test(g)) ? items : null;
    };
    const head = groups(halves[0]!);
    const rest = halves.length === 2 ? groups(halves[1]!) : [];
    if (!head || !rest) return null;
    let all: string[];
    if (halves.length === 2) {
        const missing = 8 - head.length - rest.length;
        // "::" stands for at least one group of zeros.
        if (missing < 1) return null;
        all = [...head, ...Array<string>(missing).fill('0'), ...rest];
    } else {
        all = head;
    }
    if (all.length !== 8) return null;
    const out = new Uint8Array(16);
    all.forEach((g, i) => {
        const v = parseInt(g, 16);
        out[i * 2] = v >> 8;
        out[i * 2 + 1] = v & 0xff;
    });
    return out;
}

/** The first `bits` bits of `bytes` equal those of the address `base`. */
function inV6(bytes: Uint8Array, base: Uint8Array, bits: number): boolean {
    const whole = bits >> 3;
    for (let i = 0; i < whole; i++) if (bytes[i] !== base[i]) return false;
    const rem = bits & 7;
    if (rem === 0) return true;
    const mask = (0xff << (8 - rem)) & 0xff;
    return ((bytes[whole]! ^ base[whole]!) & mask) === 0;
}

const v6 = (text: string): Uint8Array => parseIpv6(text)!;

/** Ranges inside global unicast (2000::/3) that are not for the public internet. Everything outside 2000::/3 is blocked already. */
const BLOCKED_V6_IN_UNICAST: ReadonlyArray<readonly [Uint8Array, number, string]> = [
    [v6('2001::'), 23, 'IETF protocol assignments and Teredo (2001::/23)'],
    [v6('2001:db8::'), 32, 'documentation (2001:db8::/32)'],
    [v6('3fff::'), 20, 'documentation (3fff::/20)'],
];

/** The IPv4 address in the last four bytes. */
const embeddedV4 = (bytes: Uint8Array, at = 12): number => (((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0);

function blockedV6Reason(bytes: Uint8Array): string | null {
    // IPv4-mapped (::ffff:a.b.c.d) and its SIIT sibling (::ffff:0:a.b.c.d): judged by the IPv4 address they carry.
    if (inV6(bytes, v6('::ffff:0:0'), 96) || inV6(bytes, v6('::ffff:0:0:0'), 96)) {
        const why = blockedV4Reason(embeddedV4(bytes));
        return why ? `IPv4-mapped, ${why}` : null;
    }
    // NAT64: the well-known prefix carries an IPv4 address; the local-use prefix carries whatever the operator likes.
    if (inV6(bytes, v6('64:ff9b::'), 96)) {
        const why = blockedV4Reason(embeddedV4(bytes));
        return why ? `NAT64, ${why}` : null;
    }
    if (inV6(bytes, v6('64:ff9b:1::'), 48)) return 'NAT64 local-use (64:ff9b:1::/48)';
    // Not global unicast: unspecified, loopback, IPv4-compatible, unique-local (fc00::/7, which holds
    // fd00:ec2::254), link-local, site-local, multicast, discard, SRv6: all of it.
    if (!inV6(bytes, v6('2000::'), 3)) return 'not global unicast (outside 2000::/3)';
    // 6to4 carries an IPv4 address in bytes 2 to 5.
    if (inV6(bytes, v6('2002::'), 16)) {
        const why = blockedV4Reason(embeddedV4(bytes, 2));
        return why ? `6to4, ${why}` : null;
    }
    for (const [base, bits, why] of BLOCKED_V6_IN_UNICAST) if (inV6(bytes, base, bits)) return why;
    return null;
}

// ─── One address ─────────────────────────────────────────────────────────────────────────────

/** An address as a resolver prints it, or as someone typed it: without brackets and without an IPv6 zone. */
function bareAddress(text: string): string {
    let s = text.trim();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    const zone = s.indexOf('%');
    if (zone >= 0) s = s.slice(0, zone);
    return s;
}

/** Whether an address may not be connected to, and why. `blocked: true, reason: 'not an IP address'` for anything it cannot read. */
export function classifyAddress(address: string): { blocked: boolean; reason: string } {
    const s = bareAddress(String(address ?? ''));
    if (s.includes(':')) {
        const bytes = parseIpv6(s);
        if (!bytes) return { blocked: true, reason: 'not an IP address' };
        const why = blockedV6Reason(bytes);
        return why ? { blocked: true, reason: why } : { blocked: false, reason: 'public' };
    }
    const n = parseIpv4(s);
    if (n === null) return { blocked: true, reason: 'not an IP address' };
    const why = blockedV4Reason(n);
    return why ? { blocked: true, reason: why } : { blocked: false, reason: 'public' };
}

/**
 * True when `address` is private, loopback, link-local, carrier-grade NAT, multicast, reserved,
 * documentation, a cloud metadata address, or anything that is not an address. IPv4 is read the way
 * `inet_aton` reads it (decimal, octal and hex spellings, short forms); IPv6 in every form, with
 * the IPv4 inside a mapped, NAT64 or 6to4 address judged as IPv4.
 */
export function isBlockedAddress(address: string): boolean {
    return classifyAddress(address).blocked;
}

// ─── One URL ─────────────────────────────────────────────────────────────────────────────────

export type UrlRejection = 'invalid' | 'too_long' | 'scheme' | 'userinfo' | 'port' | 'bad_host' | 'ip_literal' | 'single_label' | 'private_name';

export type UrlCheck = { ok: true; url: URL; host: string } | { ok: false; reason: UrlRejection };

const MAX_URL_LENGTH = 2048;
export const ALLOWED_PORTS: readonly number[] = [80, 443];

/** Names that only mean something on a private network (RFC 6761 and 6762, `.internal` for clouds, and the usual home and office ones). */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp', '.private', '.arpa'];

/**
 * Whether a URL may be fetched, judging only what it says. The parsed URL is returned and is the one
 * to connect with: its `hostname` is what was checked, so nothing is re-parsed between the check and
 * the use (the usual way a parser difference becomes a bypass).
 */
export function validateFetchUrl(input: string | URL): UrlCheck {
    let url: URL;
    try {
        if (typeof input === 'string') {
            if (input.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
            url = new URL(input.trim());
        } else {
            url = new URL(input.href);
        }
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    if (url.href.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
    if (url.username || url.password) return { ok: false, reason: 'userinfo' };
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!ALLOWED_PORTS.includes(port)) return { ok: false, reason: 'port' };

    const hostname = url.hostname.toLowerCase();
    // An IPv6 literal is bracketed; an IPv4 one has been put in dotted form by the parser, which is
    // checked in its raw spellings as well in case a parser ever leaves one alone.
    if (hostname.startsWith('[') || parseIpv4(hostname) !== null || /^[\d.]+$/.test(hostname)) return { ok: false, reason: 'ip_literal' };
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (!/^[a-z0-9_.-]+$/.test(host) || host === '' || host.includes('..') || host.startsWith('.')) return { ok: false, reason: 'bad_host' };
    if (!host.includes('.')) return { ok: false, reason: 'single_label' };
    if (host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { ok: false, reason: 'private_name' };
    return { ok: true, url, host };
}

// ─── One host ────────────────────────────────────────────────────────────────────────────────

export interface ResolvedAddress {
    address: string;
    family: 4 | 6;
}

/** What `dns.lookup(host, {all: true})` answers, or a stand-in: every address a name has. */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export class BlockedHostError extends Error {
    constructor(
        readonly kind: 'blocked_address' | 'dns',
        message: string,
        /** For the log, never for the person: the address that decided it. */
        readonly blocked?: { address: string; reason: string },
    ) {
        super(message);
        this.name = 'BlockedHostError';
    }
}

/**
 * Resolves `host` and refuses it if ANY of its addresses is blocked: one public and one private record
 * is blocked, because the connection could be handed either. Returns the addresses the connection may
 * use, IPv4 first (a serverless function usually has no IPv6 route), without duplicates. The caller
 * connects to one of THESE, not to the name again, which is what makes a rebinding answer harmless.
 */
export async function guardedLookup(host: string, resolve: Resolver): Promise<ResolvedAddress[]> {
    let answers: ResolvedAddress[];
    try {
        answers = await resolve(host);
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        throw new BlockedHostError('dns', code === 'EAI_AGAIN' ? 'The name server did not answer.' : 'That name does not resolve.');
    }
    if (!Array.isArray(answers) || answers.length === 0) throw new BlockedHostError('dns', 'That name does not resolve.');
    const seen = new Set<string>();
    const vetted: ResolvedAddress[] = [];
    for (const answer of answers) {
        const verdict = classifyAddress(answer?.address);
        if (verdict.blocked) {
            throw new BlockedHostError('blocked_address', 'That name resolves to an address that is not on the public internet.', {
                address: String(answer?.address).slice(0, 64),
                reason: verdict.reason,
            });
        }
        const clean = bareAddress(answer.address);
        if (seen.has(clean)) continue;
        seen.add(clean);
        vetted.push({ address: clean, family: clean.includes(':') ? 6 : 4 });
    }
    return vetted.sort((a, b) => a.family - b.family);
}
