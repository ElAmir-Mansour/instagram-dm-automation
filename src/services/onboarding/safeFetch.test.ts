/**
 * `safeFetch` (docs/onboarding/03 §1), with the network replaced by `fakeNet`: no test here opens a socket or
 * asks a real name server anything. The rules are checked one at a time; a failing row says which.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { countedBody, fakeNet, html, stallingBody } from './fetchHarness.js';
import { isSafeFetchError, safeFetch, safeFetchSite, siteUrlCandidates, SafeFetchError, USER_AGENT, decodeBody, parseContentType, FETCH_KINDS, type SafeFetchErrorKind } from './safeFetch.js';

const PUBLIC = '93.184.216.34';
const dnsFor = (...hosts: string[]) => Object.fromEntries(hosts.map((h) => [h, [PUBLIC]]));
const enc = new TextEncoder();

/** The kind of the error `promise` rejects with, or a failure if it does not reject with a `SafeFetchError`. */
async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(isSafeFetchError(err), `expected a SafeFetchError, got ${String(err)}`);
        return err;
    }
    assert.fail('expected the fetch to be refused');
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#2E7D6B"/></svg>';

describe('safeFetch: the happy path', () => {
    it('fetches a page, decodes it, and says what it did', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': html('Hello', '<p>مرحبا</p>') } });
        const res = await safeFetch('https://example.com/', { kind: 'html', ...net });
        assert.equal(res.status, 200);
        assert.equal(res.contentType, 'text/html');
        assert.match(res.text, /مرحبا/);
        assert.equal(res.url, 'https://example.com/');
        assert.deepEqual(res.redirects, []);
        assert.equal(res.address, PUBLIC);
    });

    it('connects to the vetted address and keeps the name for Host and the TLS server name', async () => {
        const net = fakeNet({ dns: dnsFor('shop.example.com'), routes: { 'https://shop.example.com/a?b=1': html() } });
        await safeFetch('https://shop.example.com/a?b=1', { kind: 'html', ...net });
        assert.equal(net.calls.length, 1);
        const call = net.calls[0]!;
        assert.equal(call.address, PUBLIC);
        assert.equal(call.family, 4);
        assert.equal(call.port, 443);
        assert.equal(call.headers.Host, 'shop.example.com');
        // The transport is given the URL whose hostname is the SNI; the connection itself is by `address`.
        assert.equal(call.url.hostname, 'shop.example.com');
        assert.equal(net.resolveCalls.filter((h) => h === 'shop.example.com').length, 1);
    });

    it('sends a fixed set of headers: the bot, no cookie, no authorization, no referer', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': html() } });
        await safeFetch('https://example.com/', { kind: 'html', ...net });
        const headers = net.calls[0]!.headers;
        assert.deepEqual(Object.keys(headers).map((h) => h.toLowerCase()).sort(), ['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
        assert.equal(headers['User-Agent'], USER_AGENT);
        assert.match(USER_AGENT, /^AutoReplyProBot\//);
        assert.equal(headers.Connection, 'close');
    });

    it('lets a caller add a contact URL to the user agent', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': html() } });
        await safeFetch('https://example.com/', { kind: 'html', userAgent: 'AutoReplyProBot/1.0 (+https://app.example)', ...net });
        assert.equal(net.calls[0]!.headers['User-Agent'], 'AutoReplyProBot/1.0 (+https://app.example)');
    });

    it('uses port 80 for http and 443 for https', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'http://example.com/': html() } });
        await safeFetch('http://example.com/', { kind: 'html', ...net });
        assert.equal(net.calls[0]!.port, 80);
    });

    it('does not send what the server asked it to remember, on the next hop either', async () => {
        const net = fakeNet({
            dns: dnsFor('example.com'),
            routes: {
                'https://example.com/a': { status: 302, headers: { location: '/b', 'set-cookie': ['session=abc; Path=/', 'x=y'] } },
                'https://example.com/b': html(),
            },
        });
        await safeFetch('https://example.com/a', { kind: 'html', ...net });
        assert.equal(net.calls.length, 2);
        for (const call of net.calls) {
            const names = Object.keys(call.headers).map((h) => h.toLowerCase());
            assert.ok(!names.includes('cookie') && !names.includes('authorization') && !names.includes('proxy-authorization'), names.join(','));
        }
    });

    it('turns header names it is given in any case into one', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'Content-Type': 'TEXT/HTML; Charset=UTF-8' }, body: '<p>x</p>' } } });
        const res = await safeFetch('https://example.com/', { kind: 'html', ...net });
        assert.equal(res.contentType, 'text/html');
    });
});

describe('safeFetch: which addresses are refused before anything is sent', () => {
    const REFUSED: Array<[string, SafeFetchErrorKind]> = [
        ['ftp://example.com/', 'blocked_url'], ['file:///etc/passwd', 'blocked_url'], ['javascript:alert(1)', 'blocked_url'],
        ['http://127.0.0.1/', 'blocked_url'], ['http://2130706433/', 'blocked_url'], ['http://0x7f.1/', 'blocked_url'], ['http://[::1]/', 'blocked_url'],
        ['http://169.254.169.254/latest/meta-data/', 'blocked_url'], ['http://localhost/', 'blocked_url'], ['http://db.internal/', 'blocked_url'],
        ['https://user:pw@example.com/', 'blocked_url'], ['https://example.com:8443/', 'blocked_url'], ['http://example.com:22/', 'blocked_url'],
        ['', 'invalid_url'], ['not a url', 'invalid_url'], [`https://example.com/${'a'.repeat(3000)}`, 'invalid_url'],
    ];
    for (const [url, kind] of REFUSED) {
        it(`${JSON.stringify(url.length > 50 ? `${url.slice(0, 30)}...` : url)} is ${kind}`, async () => {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': html() } });
            const err = await failure(safeFetch(url, { kind: 'html', ...net }));
            assert.equal(err.kind, kind);
            assert.equal(net.calls.length, 0, 'no connection may be made');
            assert.equal(net.resolveCalls.length, 0, 'no name may be looked up');
        });
    }
});

describe('safeFetch: what a name resolves to', () => {
    it('refuses a name that resolves to a private address, and never connects', async () => {
        for (const bad of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.10', '100.64.1.1', '::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '224.0.0.1', '0.0.0.0']) {
            const net = fakeNet({ dns: { 'evil.example.com': [bad] }, routes: { 'https://evil.example.com/': html() } });
            const err = await failure(safeFetch('https://evil.example.com/', { kind: 'html', ...net }));
            assert.equal(err.kind, 'blocked_address', bad);
            assert.equal(net.calls.length, 0, bad);
        }
    });

    it('refuses a name with one public record and one private one', async () => {
        const net = fakeNet({ dns: { 'mixed.example.com': [PUBLIC, '10.0.0.5'] }, routes: { 'https://mixed.example.com/': html() } });
        const err = await failure(safeFetch('https://mixed.example.com/', { kind: 'html', ...net }));
        assert.equal(err.kind, 'blocked_address');
        assert.equal(net.calls.length, 0);
        // The message a person might read has no address in it; the log's detail has.
        assert.doesNotMatch(err.message, /10\.0\.0\.5/);
        assert.equal(err.details.blocked?.address, '10.0.0.5');
    });

    it('says "dns" for a name that does not exist', async () => {
        const net = fakeNet({});
        assert.equal((await failure(safeFetch('https://nowhere.example.com/', { kind: 'html', ...net }))).kind, 'dns');
    });

    it('DNS REBINDING: connects to the address it checked, and does not ask DNS again', async () => {
        // The first answer is public; every later answer is the metadata address. A client that looked the name
        // up again at connect time would be handed 169.254.169.254.
        const net = fakeNet({
            dns: { 'rebind.example.com': (nth) => (nth === 1 ? [PUBLIC] : ['169.254.169.254']) },
            routes: { 'https://rebind.example.com/': html('ok') },
        });
        const res = await safeFetch('https://rebind.example.com/', { kind: 'html', ...net });
        assert.equal(res.address, PUBLIC);
        assert.equal(net.calls.length, 1);
        assert.equal(net.calls[0]!.address, PUBLIC);
        assert.equal(net.resolveCalls.length, 1, 'the name is resolved once per hop, never again');
    });

    it('DNS REBINDING: a name that is private at the check is refused even if it would be public a moment later', async () => {
        const net = fakeNet({ dns: { 'rebind.example.com': (nth) => (nth === 1 ? ['127.0.0.1'] : [PUBLIC]) }, routes: { 'https://rebind.example.com/': html() } });
        assert.equal((await failure(safeFetch('https://rebind.example.com/', { kind: 'html', ...net }))).kind, 'blocked_address');
        assert.equal(net.calls.length, 0);
    });

    it('tries the next vetted address when one refuses the connection, IPv4 first', async () => {
        const net = fakeNet({
            dns: { 'dual.example.com': ['2606:4700:4700::1111', '93.184.216.34', '8.8.8.8'] },
            routes: {
                'https://dual.example.com/': (req) => (req.address === '93.184.216.34' ? Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) : html()),
            },
        });
        const res = await safeFetch('https://dual.example.com/', { kind: 'html', ...net });
        assert.deepEqual(net.calls.map((c) => c.address), ['93.184.216.34', '8.8.8.8']);
        assert.equal(res.address, '8.8.8.8');
    });

    it('gives up as "network" when every vetted address refuses, never trying an unvetted one', async () => {
        const net = fakeNet({ dns: { 'down.example.com': [PUBLIC, '8.8.8.8'] }, routes: {} });
        const err = await failure(safeFetch('https://down.example.com/', { kind: 'html', ...net }));
        assert.equal(err.kind, 'network');
        assert.equal(err.details.code, 'ECONNREFUSED');
        assert.equal(err.retryable, true);
        assert.deepEqual(net.calls.map((c) => c.address), [PUBLIC, '8.8.8.8']);
    });
});

describe('safeFetch: redirects', () => {
    const chain = (n: number, finalStatus = 200) => {
        const routes: Record<string, { status: number; headers: Record<string, string>; body?: string } | ReturnType<typeof html>> = {};
        for (let i = 0; i < n; i++) routes[`https://example.com/r${i}`] = { status: 301, headers: { location: `/r${i + 1}` } };
        routes[`https://example.com/r${n}`] = finalStatus === 200 ? html('done') : { status: finalStatus, headers: {} };
        return routes;
    };

    it('follows a relative redirect and reports where it ended', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/a': { status: 302, headers: { location: '/b?x=1#frag' } }, 'https://example.com/b?x=1': html('b') } });
        const res = await safeFetch('https://example.com/a', { kind: 'html', ...net });
        assert.equal(res.url, 'https://example.com/b?x=1#frag');
        assert.deepEqual(res.redirects, ['https://example.com/b?x=1#frag']);
    });

    it('follows an absolute redirect to another public host and vets that host too', async () => {
        const net = fakeNet({
            dns: dnsFor('example.com', 'www.example.com'),
            routes: { 'https://example.com/': { status: 308, headers: { location: 'https://www.example.com/' } }, 'https://www.example.com/': html() },
        });
        await safeFetch('https://example.com/', { kind: 'html', ...net });
        assert.deepEqual(net.resolveCalls, ['example.com', 'www.example.com']);
    });

    it('follows three redirects and refuses a fourth', async () => {
        const ok = fakeNet({ dns: dnsFor('example.com'), routes: chain(3) });
        assert.equal((await safeFetch('https://example.com/r0', { kind: 'html', ...ok })).redirects.length, 3);
        const tooMany = fakeNet({ dns: dnsFor('example.com'), routes: chain(4) });
        const err = await failure(safeFetch('https://example.com/r0', { kind: 'html', ...tooMany }));
        assert.equal(err.kind, 'too_many_redirects');
        assert.equal(tooMany.calls.length, 4);
    });

    it('lets a caller lower the limit, not raise it', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: chain(2) });
        assert.equal((await failure(safeFetch('https://example.com/r0', { kind: 'html', maxRedirects: 1, ...net }))).kind, 'too_many_redirects');
        const net2 = fakeNet({ dns: dnsFor('example.com'), routes: chain(4) });
        assert.equal((await failure(safeFetch('https://example.com/r0', { kind: 'html', maxRedirects: 99, ...net2 }))).kind, 'too_many_redirects');
    });

    it('re-checks every hop: a redirect to an IP literal, a private name, another scheme or credentials is refused before a connection', async () => {
        const targets: Array<[string, SafeFetchErrorKind]> = [
            ['http://127.0.0.1/admin', 'blocked_url'],
            ['http://169.254.169.254/latest/meta-data/', 'blocked_url'],
            ['http://[::1]/', 'blocked_url'],
            ['http://2130706433/', 'blocked_url'],
            ['http://0x7f.0.0.1/', 'blocked_url'],
            ['https://localhost/', 'blocked_url'],
            ['//localhost/x', 'blocked_url'],
            ['https://svc.internal/', 'blocked_url'],
            ['ftp://example.com/file', 'blocked_url'],
            ['file:///etc/passwd', 'blocked_url'],
            ['gopher://example.com/', 'blocked_url'],
            ['https://user:pw@example.com/', 'blocked_url'],
            ['https://example.com:8443/', 'blocked_url'],
        ];
        for (const [target, kind] of targets) {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/start': { status: 302, headers: { location: target } } } });
            const err = await failure(safeFetch('https://example.com/start', { kind: 'html', ...net }));
            assert.equal(err.kind, kind, target);
            assert.equal(net.calls.length, 1, `${target}: only the first hop may connect`);
        }
    });

    it('re-checks every hop: a redirect to a name that resolves privately is refused after the lookup and before a connection', async () => {
        const net = fakeNet({
            dns: { 'example.com': [PUBLIC], 'sneaky.example.org': ['10.0.0.9'] },
            routes: { 'https://example.com/start': { status: 302, headers: { location: 'https://sneaky.example.org/' } }, 'https://sneaky.example.org/': html('SECRET') },
        });
        const err = await failure(safeFetch('https://example.com/start', { kind: 'html', ...net }));
        assert.equal(err.kind, 'blocked_address');
        assert.equal(net.calls.length, 1);
        assert.deepEqual(net.resolveCalls, ['example.com', 'sneaky.example.org']);
    });

    it('refuses https to http, and allows http to https', async () => {
        const down = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { status: 301, headers: { location: 'http://example.com/' } }, 'http://example.com/': html() } });
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', ...down }));
        assert.equal(err.kind, 'insecure_redirect');
        assert.equal(down.calls.length, 1);
        const up = fakeNet({ dns: dnsFor('example.com'), routes: { 'http://example.com/': { status: 301, headers: { location: 'https://example.com/' } }, 'https://example.com/': html() } });
        assert.equal((await safeFetch('http://example.com/', { kind: 'html', ...up })).url, 'https://example.com/');
    });

    it('refuses a redirect with no Location', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { status: 302, headers: {} } } });
        assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...net }))).kind, 'bad_redirect');
    });

    it('does not treat 300 and 304 as a redirect', async () => {
        for (const status of [300, 304]) {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { status, headers: { location: '/x' } } } });
            assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...net }))).kind, 'status');
        }
    });

    it('closes the connection of a redirect it will not read', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/a': { status: 302, headers: { location: '/b' }, body: 'x'.repeat(1000) }, 'https://example.com/b': html() } });
        await safeFetch('https://example.com/a', { kind: 'html', ...net });
        assert.ok(net.closed.count >= 2);
    });
});

describe('safeFetch: how big a body may be', () => {
    it('refuses a body over the cap and stops reading it part-way', async () => {
        const { body, pulled } = countedBody(100 * 65_536, 65_536); // 6.5 MB on offer, in 64 KB pieces
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html' }, body } } });
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', ...net }));
        assert.equal(err.kind, 'too_large');
        // 1.5 MB is 23 pieces and a bit; nothing past the piece that crossed the line is pulled.
        assert.ok(pulled.chunks <= 25, `pulled ${pulled.chunks} of 100 pieces`);
        assert.ok(net.closed.count >= 1);
    });

    it('applies each kind its own cap: HTML 1.5 MB, CSS 512 KB, images 512 KB', () => {
        assert.equal(FETCH_KINDS.html.maxBytes, 1_500_000);
        assert.equal(FETCH_KINDS.css.maxBytes, 512 * 1024);
        assert.equal(FETCH_KINDS.image.maxBytes, 512 * 1024);
    });

    it('stops a stylesheet at 512 KB and a PNG at 512 KB', async () => {
        const css = countedBody(2_000_000, 65_536);
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/a.css': { headers: { 'content-type': 'text/css' }, body: css.body } } });
        assert.equal((await failure(safeFetch('https://example.com/a.css', { kind: 'css', ...net }))).kind, 'too_large');
        assert.ok(css.pulled.chunks <= 10, `pulled ${css.pulled.chunks}`);
        const big = new Uint8Array(600 * 1024);
        big.set(PNG);
        const net2 = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/a.png': { headers: { 'content-type': 'image/png' }, body: big } } });
        assert.equal((await failure(safeFetch('https://example.com/a.png', { kind: 'image', ...net2 }))).kind, 'too_large');
    });

    it('lets a body of exactly the cap through, and one byte more not', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/a': { headers: { 'content-type': 'text/html' }, body: 'a'.repeat(1000) }, 'https://example.com/b': { headers: { 'content-type': 'text/html' }, body: 'a'.repeat(1001) } } });
        assert.equal((await safeFetch('https://example.com/a', { kind: 'html', maxBytes: 1000, ...net })).bytes.byteLength, 1000);
        assert.equal((await failure(safeFetch('https://example.com/b', { kind: 'html', maxBytes: 1000, ...net }))).kind, 'too_large');
    });

    it('never lets a caller raise a cap', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/a.css': { headers: { 'content-type': 'text/css' }, body: new Uint8Array(600 * 1024).fill(0x61) } } });
        assert.equal((await failure(safeFetch('https://example.com/a.css', { kind: 'css', maxBytes: 10_000_000, ...net }))).kind, 'too_large');
    });

    it('refuses on a Content-Length over the cap without reading a byte', async () => {
        const { body, pulled } = countedBody(10_000, 1000);
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-length': '99999999' }, body } } });
        assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...net }))).kind, 'too_large');
        assert.equal(pulled.chunks, 0);
    });

    it('GZIP BOMB: counts after decompression and never inflates the rest', async () => {
        // 256 MB of zeros is about 250 KB of gzip. The cap is 1.5 MB of HTML. The stream buffers a few tens of KB of
        // its input ahead of what it has decoded, so a reader that stopped at the cap pulls a fraction of the pieces,
        // and one that inflated the whole thing pulls them all.
        const bomb = zlib.gzipSync(Buffer.alloc(256 * 1024 * 1024));
        assert.ok(bomb.byteLength > 150_000 && bomb.byteLength < 400_000, `the bomb is ${bomb.byteLength} bytes on the wire`);
        const chunkSize = 1024;
        const totalChunks = Math.ceil(bomb.byteLength / chunkSize);
        let pulled = 0;
        const body = async function* () {
            for (let at = 0; at < bomb.byteLength; at += chunkSize) {
                pulled++;
                yield new Uint8Array(bomb.subarray(at, at + chunkSize));
            }
        };
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body } } });
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', ...net }));
        assert.equal(err.kind, 'too_large');
        assert.ok(pulled < totalChunks / 2, `read ${pulled} of ${totalChunks} compressed pieces: the rest was never pulled`);
        assert.ok(pulled < 120, `read ${pulled} pieces`);
    });

    it('GZIP BOMB: the same with a cap a caller lowered, and with deflate and brotli', async () => {
        const zeros = Buffer.alloc(8 * 1024 * 1024);
        for (const [encoding, compressed] of [['gzip', zlib.gzipSync(zeros)], ['deflate', zlib.deflateSync(zeros)], ['br', zlib.brotliCompressSync(zeros)]] as const) {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-encoding': encoding }, body: new Uint8Array(compressed), chunk: 512 } } });
            const err = await failure(safeFetch('https://example.com/', { kind: 'html', maxBytes: 100_000, ...net }));
            assert.equal(err.kind, 'too_large', encoding);
        }
    });

    it('refuses a compressed body whose compressed size is over the cap', async () => {
        const noise = new Uint8Array(2_000_000);
        for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: new Uint8Array(zlib.gzipSync(noise)), chunk: 65_536 } } });
        assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...net }))).kind, 'too_large');
    });
});

describe('safeFetch: content', () => {
    it('decodes gzip, deflate and brotli bodies', async () => {
        const page = '<!doctype html><title>t</title><p>مرحبا بالعالم</p>';
        for (const [encoding, bytes] of [['gzip', zlib.gzipSync(page)], ['x-gzip', zlib.gzipSync(page)], ['deflate', zlib.deflateSync(page)], ['br', zlib.brotliCompressSync(page)], ['identity', Buffer.from(page)]] as const) {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': encoding }, body: new Uint8Array(bytes) } } });
            const res = await safeFetch('https://example.com/', { kind: 'html', ...net });
            assert.equal(res.text, page, encoding);
        }
    });

    it('refuses a compression it does not know, and a corrupt stream', async () => {
        const zstd = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-encoding': 'zstd' }, body: 'x' } } });
        assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...zstd }))).kind, 'content_encoding');
        const stacked = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip, br' }, body: 'x' } } });
        assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...stacked }))).kind, 'content_encoding');
        const corrupt = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: 'this is not gzip at all' } } });
        assert.equal((await failure(safeFetch('https://example.com/', { kind: 'html', ...corrupt }))).kind, 'bad_content');
    });

    const WRONG_TYPES: Array<[string, string | undefined, 'html' | 'css' | 'json' | 'text' | 'image']> = [
        ['html', 'image/png', 'html'], ['html', 'application/json', 'html'], ['html', 'application/pdf', 'html'], ['html', 'application/octet-stream', 'html'],
        ['html', 'text/plain', 'html'], ['html', 'application/javascript', 'html'], ['html', undefined, 'html'], ['html', '', 'html'],
        ['css', 'text/html', 'css'], ['css', 'text/plain', 'css'], ['css', undefined, 'css'],
        ['text', 'text/html', 'text'], ['text', 'application/json', 'text'],
        ['json', 'text/html', 'json'], ['json', 'image/png', 'json'],
        ['image', 'text/html', 'image'], ['image', 'application/octet-stream', 'image'], ['image', 'application/pdf', 'image'], ['image', 'image/tiff', 'image'], ['image', undefined, 'image'],
    ];
    for (const [label, type, kind] of WRONG_TYPES) {
        it(`refuses ${type === undefined ? 'no content type' : JSON.stringify(type)} for a ${label} fetch`, async () => {
            const headers: Record<string, string> = type === undefined ? {} : { 'content-type': type };
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/x': { headers, body: 'hello' } } });
            assert.equal((await failure(safeFetch('https://example.com/x', { kind, ...net }))).kind, 'content_type');
        });
    }

    it('accepts what each kind allows', async () => {
        const cases: Array<['html' | 'css' | 'json' | 'text', string]> = [
            ['html', 'text/html'], ['html', 'application/xhtml+xml'], ['css', 'text/css'], ['json', 'application/manifest+json'], ['json', 'application/json'], ['json', 'text/plain'], ['text', 'text/plain'],
        ];
        for (const [kind, type] of cases) {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/x': { headers: { 'content-type': type }, body: 'ok' } } });
            assert.equal((await safeFetch('https://example.com/x', { kind, ...net })).text, 'ok', `${kind} ${type}`);
        }
    });

    it('checks an image against its magic bytes, not the server\'s word', async () => {
        const serve = (type: string, body: Uint8Array | string) => fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/i': { headers: { 'content-type': type }, body } } });
        // Right.
        const png = await safeFetch('https://example.com/i', { kind: 'image', ...serve('image/png', PNG) });
        assert.equal(png.bytes.byteLength, PNG.byteLength);
        assert.equal(png.text, '', 'a raster image has no text');
        assert.equal((await safeFetch('https://example.com/i', { kind: 'image', ...serve('image/jpeg', JPEG) })).contentType, 'image/jpeg');
        assert.equal((await safeFetch('https://example.com/i', { kind: 'image', ...serve('image/jpg', JPEG) })).contentType, 'image/jpg');
        // Wrong: a PNG that says it is a JPEG, a JPEG that says PNG, HTML and a script that say image/png, an empty file.
        assert.equal((await failure(safeFetch('https://example.com/i', { kind: 'image', ...serve('image/jpeg', PNG) }))).kind, 'bad_content');
        assert.equal((await failure(safeFetch('https://example.com/i', { kind: 'image', ...serve('image/png', JPEG) }))).kind, 'bad_content');
        assert.equal((await failure(safeFetch('https://example.com/i', { kind: 'image', ...serve('image/png', '<html><script>alert(1)</script></html>') }))).kind, 'bad_content');
        assert.equal((await failure(safeFetch('https://example.com/i', { kind: 'image', ...serve('image/png', '#!/bin/sh\nrm -rf /') }))).kind, 'bad_content');
        assert.equal((await failure(safeFetch('https://example.com/i', { kind: 'image', ...serve('image/gif', '') }))).kind, 'bad_content');
    });

    it('reads an SVG as text and only as text', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/l.svg': { headers: { 'content-type': 'image/svg+xml' }, body: SVG }, 'https://example.com/h.svg': { headers: { 'content-type': 'image/svg+xml' }, body: '<html><svg></svg></html>' }, 'https://example.com/b.svg': { headers: { 'content-type': 'image/svg+xml' }, body: new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0, 1, 2]) } } });
        const svg = await safeFetch('https://example.com/l.svg', { kind: 'image', ...net });
        assert.match(svg.text, /fill="#2E7D6B"/);
        assert.equal((await failure(safeFetch('https://example.com/h.svg', { kind: 'image', ...net }))).kind, 'bad_content');
        assert.equal((await failure(safeFetch('https://example.com/b.svg', { kind: 'image', ...net }))).kind, 'bad_content');
    });

    it('decodes the charset the server or the page names', async () => {
        const windows1256 = Uint8Array.from([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]); // مرحبا
        const header = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html; charset=windows-1256' }, body: windows1256 } } });
        assert.equal((await safeFetch('https://example.com/', { kind: 'html', ...header })).text, 'مرحبا');
        const meta = new Uint8Array([...enc.encode('<meta charset="windows-1256"><p>'), ...windows1256]);
        const sniffed = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html' }, body: meta } } });
        assert.match((await safeFetch('https://example.com/', { kind: 'html', ...sniffed })).text, /مرحبا/);
        assert.equal(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), 'text/html; charset=windows-1256', 'html'), '\uFEFFhi'.replace('\uFEFF', ''), 'a BOM wins over a header');
        assert.equal(decodeBody(enc.encode('x'), 'text/html; charset=nonsense-9', 'html'), 'x', 'an unknown charset falls back to UTF-8');
    });

    it('parses content types', () => {
        assert.deepEqual(parseContentType('Text/HTML; charset="UTF-8"; boundary=x'), { type: 'text/html', charset: 'utf-8' });
        assert.deepEqual(parseContentType(['application/json']), { type: 'application/json', charset: null });
        assert.deepEqual(parseContentType(undefined), { type: '', charset: null });
    });
});

describe('safeFetch: statuses', () => {
    const cases: Array<[number, SafeFetchErrorKind, boolean]> = [
        [401, 'forbidden', false], [403, 'forbidden', false], [404, 'not_found', false], [410, 'not_found', false], [429, 'rate_limited', true],
        [400, 'status', false], [418, 'status', false], [500, 'status', true], [502, 'status', true], [503, 'status', true],
    ];
    for (const [status, kind, retryable] of cases) {
        it(`${status} is ${kind}${retryable ? ' and retryable' : ''}`, async () => {
            const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { status, headers: { 'content-type': 'text/html' }, body: 'nope' } } });
            const err = await failure(safeFetch('https://example.com/', { kind: 'html', ...net }));
            assert.equal(err.kind, kind);
            assert.equal(err.status, status);
            assert.equal(err.retryable, retryable);
            assert.ok(net.closed.count >= 1, 'the body of an error is not read');
        });
    }
});

describe('safeFetch: time', () => {
    it('gives each request its own deadline and says it was the request', async () => {
        const hang = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': (req) => new Promise<never>((_, reject) => req.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) } });
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', timeoutMs: 40, ...hang }));
        assert.equal(err.kind, 'timeout');
        assert.equal(err.details.scope, 'request');
        assert.equal(err.retryable, true);
    });

    it('stops a name server that never answers', async () => {
        const net = fakeNet({});
        const slow = { ...net, resolve: () => new Promise<never>(() => {}) };
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', timeoutMs: 30, resolve: slow.resolve, transport: net.transport }));
        assert.equal(err.kind, 'timeout');
    });

    it('stops a body that stalls after the headers', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html' }, body: stallingBody('<p>start') } } });
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', timeoutMs: 40, ...net }));
        assert.equal(err.kind, 'timeout');
        assert.ok(net.closed.count >= 1);
    });

    it('stops at the phase deadline, not only at the request one, and says so', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { headers: { 'content-type': 'text/html' }, body: stallingBody() } } });
        const phase = new AbortController();
        setTimeout(() => phase.abort(), 30);
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', timeoutMs: 60_000, signal: phase.signal, ...net }));
        assert.equal(err.kind, 'timeout');
        assert.equal(err.details.scope, 'phase');
    });

    it('does not even start when the phase is already over', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': html() } });
        const phase = new AbortController();
        phase.abort();
        const err = await failure(safeFetch('https://example.com/', { kind: 'html', signal: phase.signal, ...net }));
        assert.equal(err.kind, 'timeout');
        assert.equal(net.calls.length, 0);
    });
});

describe('a site the tenant typed', () => {
    it('offers https first, then http, for a bare name; exactly what was typed otherwise', () => {
        assert.deepEqual(siteUrlCandidates('example.com'), ['https://example.com', 'http://example.com']);
        assert.deepEqual(siteUrlCandidates('  example.com/shop  '), ['https://example.com/shop', 'http://example.com/shop']);
        assert.deepEqual(siteUrlCandidates('http://example.com/x'), ['https://example.com/x', 'http://example.com/x']);
        assert.deepEqual(siteUrlCandidates('https://example.com/x'), ['https://example.com/x']);
        assert.deepEqual(siteUrlCandidates('ftp://example.com'), ['ftp://example.com']);
        assert.deepEqual(siteUrlCandidates('   '), []);
    });

    it('falls back to http only when https is not there at all', async () => {
        const net = fakeNet({ dns: dnsFor('example.com'), routes: { 'http://example.com/': html('plain') } });
        const res = await safeFetchSite('example.com', { kind: 'html', ...net });
        assert.equal(res.url, 'http://example.com/');
        assert.deepEqual(net.calls.map((c) => c.url.protocol), ['https:', 'http:']);
    });

    it('does not fall back when https answered, when the address was refused, or when the certificate failed', async () => {
        const answered = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': { status: 500 }, 'http://example.com/': html() } });
        assert.equal((await failure(safeFetchSite('example.com', { kind: 'html', ...answered }))).kind, 'status');
        assert.equal(answered.calls.length, 1);
        const refused = fakeNet({ dns: { 'evil.example.com': ['10.0.0.1'] }, routes: { 'http://evil.example.com/': html() } });
        assert.equal((await failure(safeFetchSite('evil.example.com', { kind: 'html', ...refused }))).kind, 'blocked_address');
        assert.equal(refused.calls.length, 0);
        const cert = fakeNet({ dns: dnsFor('example.com'), routes: { 'https://example.com/': Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), 'http://example.com/': html() } });
        const err = await failure(safeFetchSite('example.com', { kind: 'html', ...cert }));
        assert.equal(err.kind, 'network');
        assert.equal(err.details.code, 'CERT_HAS_EXPIRED');
        assert.equal(cert.calls.length, 1);
    });

    it('refuses an IP typed as a site', async () => {
        const net = fakeNet({});
        assert.equal((await failure(safeFetchSite('127.0.0.1', { kind: 'html', ...net }))).kind, 'blocked_url');
        assert.equal((await failure(safeFetchSite('', { kind: 'html', ...net }))).kind, 'invalid_url');
        assert.equal(net.calls.length, 0);
    });
});
