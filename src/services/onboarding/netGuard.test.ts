/**
 * The address rules of `safeFetch` (docs/onboarding/03 §1): every blocked range at both of its edges, every
 * spelling of an address, the IPv6 forms, and the URL rules. Table tests: a row that fails names itself.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BlockedHostError, classifyAddress, guardedLookup, isBlockedAddress, parseIpv4, parseIpv6, validateFetchUrl, type ResolvedAddress } from './netGuard.js';

/** [address, a word of the reason that must be in the verdict]. The last and first address of each range are both here. */
const BLOCKED_V4: Array<[string, string]> = [
    ['0.0.0.0', '0/8'], ['0.1.2.3', '0/8'], ['0.255.255.255', '0/8'],
    ['10.0.0.0', '10/8'], ['10.0.0.1', '10/8'], ['10.255.255.255', '10/8'],
    ['100.64.0.0', '100.64/10'], ['100.64.0.1', '100.64/10'], ['100.100.100.200', '100.64/10'], ['100.127.255.255', '100.64/10'],
    ['127.0.0.0', '127/8'], ['127.0.0.1', '127/8'], ['127.255.255.254', '127/8'],
    ['169.254.0.0', '169.254/16'], ['169.254.169.254', 'metadata'], ['169.254.255.255', '169.254/16'],
    ['172.16.0.0', '172.16/12'], ['172.20.1.1', '172.16/12'], ['172.31.255.255', '172.16/12'],
    ['192.0.0.0', '192.0.0/24'], ['192.0.0.170', '192.0.0/24'], ['192.0.0.255', '192.0.0/24'],
    ['192.0.2.0', '192.0.2/24'], ['192.0.2.255', '192.0.2/24'],
    ['192.168.0.0', '192.168/16'], ['192.168.1.1', '192.168/16'], ['192.168.255.255', '192.168/16'],
    ['198.18.0.0', '198.18/15'], ['198.19.255.255', '198.18/15'],
    ['198.51.100.0', '198.51.100/24'], ['198.51.100.255', '198.51.100/24'],
    ['203.0.113.0', '203.0.113/24'], ['203.0.113.255', '203.0.113/24'],
    ['224.0.0.0', '224/4'], ['224.0.0.1', '224/4'], ['239.255.255.255', '224/4'],
    ['240.0.0.0', '240/4'], ['250.1.2.3', '240/4'], ['255.255.255.255', '240/4'],
    ['168.63.129.16', 'Azure'],
];

/** Each is one step outside a blocked range, or an ordinary public address. */
const PUBLIC_V4 = [
    '1.0.0.1', '1.1.1.1', '8.8.8.8', '8.8.4.4', '9.255.255.255', '11.0.0.0', '93.184.216.34', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '191.255.255.255', '192.0.1.0', '192.0.3.0', '192.167.255.255', '192.169.0.0',
    '198.17.255.255', '198.20.0.0', '198.51.99.255', '198.51.101.0', '203.0.112.255', '203.0.114.0', '223.255.255.255', '168.63.129.15', '168.63.129.17',
];

describe('isBlockedAddress: IPv4', () => {
    for (const [address, why] of BLOCKED_V4) {
        it(`blocks ${address}`, () => {
            const verdict = classifyAddress(address);
            assert.equal(verdict.blocked, true);
            assert.ok(verdict.reason.includes(why), `${address}: "${verdict.reason}" should mention ${why}`);
            assert.equal(isBlockedAddress(address), true);
        });
    }
    for (const address of PUBLIC_V4) {
        it(`lets ${address} through`, () => {
            assert.equal(isBlockedAddress(address), false);
        });
    }
});

describe('IPv4 in every spelling', () => {
    /** Spellings of the same address: they must all be read as that address, and so blocked or not alike. */
    const SPELLINGS: Record<string, string[]> = {
        '127.0.0.1': ['2130706433', '0x7f000001', '0x7F000001', '0x7f.0.0.1', '0x7f.0x0.0x0.0x1', '0177.0.0.1', '0177.00.00.01', '0177.0.0.01', '127.1', '127.0.1', '127.0.0.1', '017700000001', '0x7f.1', '0177.1'],
        '169.254.169.254': ['2852039166', '0xa9fea9fe', '0251.0376.0251.0376', '169.254.43518', '169.16689662', '0xa9.0xfe.0xa9.0xfe', '0251.254.169.0xfe'],
        '10.0.0.1': ['167772161', '0xa000001', '012.0.0.1', '10.1', '10.0.1', '0xa.0.0.0x1'],
        '192.168.0.1': ['3232235521', '0xc0a80001', '0300.0250.0.1', '192.168.1', '0xc0.0xa8.0x0.0x1'],
        '0.0.0.0': ['0', '00', '0x0', '0.0', '0.0.0', '0.0.0.0', '00.0.0.0', '0x0.0x0.0x0.0x0'],
        '8.8.8.8': ['134744072', '0x8080808', '010.010.010.010', '8.8.2056', '0x8.0x8.0x8.0x8'],
    };
    for (const [canonical, spellings] of Object.entries(SPELLINGS)) {
        const expected = parseIpv4(canonical);
        for (const spelling of spellings) {
            it(`${spelling} is ${canonical}`, () => {
                assert.equal(parseIpv4(spelling), expected, spelling);
                assert.equal(isBlockedAddress(spelling), isBlockedAddress(canonical));
            });
        }
    }

    it('reads the canonical forms as the numbers they are', () => {
        assert.equal(parseIpv4('127.0.0.1'), 0x7f000001);
        assert.equal(parseIpv4('255.255.255.255'), 0xffffffff);
        assert.equal(parseIpv4('0.0.0.0'), 0);
        assert.equal(parseIpv4('1.2.3.4'), 0x01020304);
    });

    // Anything that is not an address is blocked: a guard that fails open is not one.
    const NOT_ADDRESSES = [
        '', ' ', 'abc', 'example.com', 'localhost', '1.2.3.4.5', '256.1.1.1', '1.2.3.256', '1.2.65536', '1.16777216', '16777216.1', '4294967296', '99999999999', '08.1.1.1',
        '0x', '0xg', '1..2', '1.2.3.', '.1.2.3', '-1.2.3.4', '1.2.3.4/8', '1.2.3.4:80', '+1.2.3.4', '1 .2.3.4', '0b11.1.1.1', '1e3.1.1.1',
        '::g', ':::', '::1::2', '1:2:3:4:5:6:7:8:9', '12345::', '1:2:3:4:5:6:7', '::ffff:1.2.3', '::ffff:1.2.3.256', 'fe80::1::', 'g::1',
    ];
    for (const text of NOT_ADDRESSES) {
        it(`blocks "${text}", which is not an address`, () => {
            const verdict = classifyAddress(text);
            assert.equal(verdict.blocked, true, text);
            assert.equal(verdict.reason, 'not an IP address');
        });
    }

    it('treats a non-string as not an address', () => {
        assert.equal(isBlockedAddress(undefined as unknown as string), true);
        assert.equal(isBlockedAddress(null as unknown as string), true);
        assert.equal(isBlockedAddress(2130706433 as unknown as string), true);
    });
});

describe('isBlockedAddress: IPv6', () => {
    const BLOCKED: Array<[string, string]> = [
        ['::', 'outside 2000::/3'], ['::1', 'outside 2000::/3'], ['0:0:0:0:0:0:0:1', 'outside 2000::/3'], ['0000:0000:0000:0000:0000:0000:0000:0001', 'outside 2000::/3'],
        ['fe80::1', 'outside 2000::/3'], ['FE80::ABCD', 'outside 2000::/3'], ['fe80::1%eth0', 'outside 2000::/3'], ['[fe80::1%25eth0]', 'outside 2000::/3'], ['febf::1', 'outside 2000::/3'],
        ['fc00::1', 'outside 2000::/3'], ['fd12:3456:789a::1', 'outside 2000::/3'], ['fdff:ffff::1', 'outside 2000::/3'], ['fd00:ec2::254', 'outside 2000::/3'],
        ['ff02::1', 'outside 2000::/3'], ['ff00::', 'outside 2000::/3'], ['ffff::1', 'outside 2000::/3'],
        ['fec0::1', 'outside 2000::/3'], ['100::1', 'outside 2000::/3'], ['5f00::1', 'outside 2000::/3'], ['::7f00:1', 'outside 2000::/3'], ['4000::1', 'outside 2000::/3'],
        ['2001:db8::1', 'documentation'], ['2001:0db8:85a3::8a2e:370:7334', 'documentation'], ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation'],
        ['2001::1', 'Teredo'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo'], ['2001:1::1', '2001::/23'], ['2001:1ff::1', '2001::/23'],
        ['3fff::1', 'documentation'], ['3fff:fff::1', 'documentation'],
        ['64:ff9b:1::1', 'NAT64 local-use'], ['64:ff9b:1:ffff::1', 'NAT64 local-use'],
        // IPv4 inside IPv6: judged as the IPv4 address it carries.
        ['::ffff:127.0.0.1', 'IPv4-mapped'], ['::ffff:7f00:1', 'IPv4-mapped'], ['::FFFF:10.0.0.1', 'IPv4-mapped'], ['::ffff:a00:1', 'IPv4-mapped'],
        ['::ffff:169.254.169.254', 'IPv4-mapped'], ['0:0:0:0:0:ffff:192.168.1.1', 'IPv4-mapped'], ['::ffff:0.0.0.0', 'IPv4-mapped'], ['::ffff:255.255.255.255', 'IPv4-mapped'],
        ['::ffff:0:127.0.0.1', 'IPv4-mapped'],
        ['64:ff9b::7f00:1', 'NAT64'], ['64:ff9b::10.0.0.1', 'NAT64'], ['64:ff9b::a9fe:a9fe', 'NAT64'], ['64:ff9b::c0a8:1', 'NAT64'],
        ['2002:7f00:1::', '6to4'], ['2002:a00:1::1', '6to4'], ['2002:c0a8:101::', '6to4'], ['2002:a9fe:a9fe::1', '6to4'], ['2002:0:0::1', '6to4'],
    ];
    for (const [address, why] of BLOCKED) {
        it(`blocks ${address}`, () => {
            const verdict = classifyAddress(address);
            assert.equal(verdict.blocked, true, address);
            assert.ok(verdict.reason.includes(why), `${address}: "${verdict.reason}" should mention ${why}`);
        });
    }
    const PUBLIC = [
        '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '2400:cb00::1', '2620:fe::fe', '2001:200::1', '2001:db9::1', '2003::1', '3ffe::1',
        '[2606:4700:4700::1111]', '2606:4700:4700:0:0:0:0:1111',
        '::ffff:8.8.8.8', '::ffff:808:808', '::ffff:93.184.216.34', '64:ff9b::808:808', '64:ff9b::8.8.8.8', '2002:808:808::', '2002:5db8:d822::1',
    ];
    for (const address of PUBLIC) {
        it(`lets ${address} through`, () => {
            assert.equal(isBlockedAddress(address), false, address);
        });
    }

    it('reads :: compression, mixed-case letters and a dotted tail to the same 16 bytes', () => {
        const a = parseIpv6('2001:db8:0:0:0:0:0:1');
        assert.deepEqual(parseIpv6('2001:db8::1'), a);
        assert.deepEqual(parseIpv6('2001:DB8::1'), a);
        assert.deepEqual(parseIpv6('2001:0db8::0001'), a);
        assert.deepEqual(parseIpv6('::ffff:1.2.3.4'), parseIpv6('::ffff:102:304'));
        assert.equal(parseIpv6('::')?.every((b) => b === 0), true);
        assert.equal(parseIpv6('1:2:3:4:5:6:7::')?.length, 16);
        assert.equal(parseIpv6('1::2::3'), null);
        assert.equal(parseIpv6('1:2:3:4:5:6:7:8::'), null);
    });
});

describe('validateFetchUrl', () => {
    const OK: Array<[string, string]> = [
        ['https://example.com/', 'example.com'],
        ['http://example.com', 'example.com'],
        ['HTTPS://EXAMPLE.COM/Path', 'example.com'],
        ['https://sub.example.co.uk/path?q=1#h', 'sub.example.co.uk'],
        ['https://example.com:443/', 'example.com'],
        ['http://example.com:80/', 'example.com'],
        ['https://example.com./', 'example.com'],
        ['  https://example.com/  ', 'example.com'],
        ['https://xn--mgbaakc7dvf.example/', 'xn--mgbaakc7dvf.example'],
        ['https://موقع.السعودية/', 'xn--4gbrim.xn--mgberp4a5d4ar'],
        ['https://my_shop.example.com/', 'my_shop.example.com'],
        // The parser's reading is the one that counts: the host here is example.com, whatever the rest looks like.
        ['http://example.com\\@127.0.0.1/', 'example.com'],
        ['http://example.com#@127.0.0.1/', 'example.com'],
        ['http://example.com?@127.0.0.1/', 'example.com'],
        ['http://example.com/@127.0.0.1', 'example.com'],
    ];
    for (const [input, host] of OK) {
        it(`accepts ${JSON.stringify(input)} as ${host}`, () => {
            const verdict = validateFetchUrl(input);
            assert.equal(verdict.ok, true, JSON.stringify(verdict));
            if (verdict.ok) {
                assert.equal(verdict.host, host);
                // What was checked is what will be connected to.
                assert.equal(verdict.url.hostname.replace(/\.$/, ''), host);
            }
        });
    }

    const REFUSED: Array<[string, string]> = [
        ['ftp://example.com/', 'scheme'], ['file:///etc/passwd', 'scheme'], ['javascript:alert(1)', 'scheme'], ['data:text/html,hi', 'scheme'], ['gopher://example.com/', 'scheme'],
        ['ws://example.com/', 'scheme'], ['blob:https://example.com/x', 'scheme'], ['mailto:a@b.com', 'scheme'],
        ['https://user:pass@example.com/', 'userinfo'], ['https://user@example.com/', 'userinfo'], ['http://:pw@example.com/', 'userinfo'], ['http://user@127.0.0.1@example.com/', 'userinfo'],
        ['https://example.com:8080/', 'port'], ['http://example.com:22/', 'port'], ['https://example.com:444/', 'port'], ['http://example.com:8000/', 'port'], ['https://example.com:65535/', 'port'],
        ['http://127.0.0.1/', 'ip_literal'], ['http://127.1/', 'ip_literal'], ['http://2130706433/', 'ip_literal'], ['http://0x7f.0.0.1/', 'ip_literal'], ['http://0x7f000001/', 'ip_literal'],
        ['http://0177.0.0.1/', 'ip_literal'], ['http://017700000001/', 'ip_literal'], ['http://0/', 'ip_literal'], ['http://0.0.0.0/', 'ip_literal'],
        ['http://[::1]/', 'ip_literal'], ['http://[::]/', 'ip_literal'], ['http://[::ffff:7f00:1]/', 'ip_literal'], ['http://[::ffff:127.0.0.1]/', 'ip_literal'], ['http://[fe80::1]/', 'ip_literal'],
        ['http://[2001:db8::1]/', 'ip_literal'], ['http://[fd00:ec2::254]/', 'ip_literal'], ['https://[2606:4700:4700::1111]/', 'ip_literal'],
        ['https://8.8.8.8/', 'ip_literal'], ['https://1.1.1.1:443/', 'ip_literal'], ['http://169.254.169.254/latest/meta-data/', 'ip_literal'], ['http://2852039166/', 'ip_literal'],
        ['http://192.168.1.1/', 'ip_literal'], ['http://10.0.0.1/', 'ip_literal'], ['http://127.0.0.1#@example.com/', 'ip_literal'], ['http://100.100.100.200/', 'ip_literal'],
        ['http://localhost/', 'single_label'], ['http://localhost:80/', 'single_label'], ['http://intranet/', 'single_label'], ['http://metadata/', 'single_label'], ['https://router/', 'single_label'],
        ['http://LOCALHOST./', 'single_label'],
        ['http://foo.local/', 'private_name'], ['http://db.internal/', 'private_name'], ['http://metadata.google.internal/', 'private_name'], ['http://x.localhost/', 'private_name'],
        ['http://router.lan/', 'private_name'], ['http://nas.home.arpa/', 'private_name'], ['http://host.localdomain/', 'private_name'], ['http://1.0.0.127.in-addr.arpa/', 'private_name'],
        ['http://printer.intranet/', 'private_name'], ['http://wiki.corp/', 'private_name'], ['http://a.b.private/', 'private_name'], ['http://App.INTERNAL/', 'private_name'], ['http://svc.local./', 'private_name'],
        ['', 'invalid'], ['not a url', 'invalid'], ['//example.com', 'invalid'], ['http://', 'invalid'], ['http://exa mple.com/', 'invalid'], ['example.com', 'invalid'], ['http://%00.com/', 'invalid'],
        ['http://a!b.com/', 'bad_host'], ['http://a..b.com/', 'bad_host'], ['http://a,b.com/', 'bad_host'], ['http://a$b.example.com/', 'bad_host'],
        [`http://example.com/${'a'.repeat(3000)}`, 'too_long'],
    ];
    for (const [input, reason] of REFUSED) {
        it(`refuses ${JSON.stringify(input.length > 60 ? `${input.slice(0, 40)}...` : input)} as ${reason}`, () => {
            const verdict = validateFetchUrl(input);
            assert.equal(verdict.ok, false, JSON.stringify(verdict));
            if (!verdict.ok) assert.equal(verdict.reason, reason);
        });
    }

    it('takes a URL object as well and checks the same things', () => {
        assert.equal(validateFetchUrl(new URL('https://example.com/x')).ok, true);
        assert.equal(validateFetchUrl(new URL('http://127.0.0.1/')).ok, false);
    });
});

describe('guardedLookup', () => {
    const answer = (...addresses: string[]): ((host: string) => Promise<ResolvedAddress[]>) => async () =>
        addresses.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) }));

    it('returns the addresses of a public name, IPv4 first and without repeats', async () => {
        const out = await guardedLookup('example.com', answer('2606:4700:4700::1111', '93.184.216.34', '93.184.216.34', '8.8.8.8'));
        assert.deepEqual(out, [
            { address: '93.184.216.34', family: 4 },
            { address: '8.8.8.8', family: 4 },
            { address: '2606:4700:4700::1111', family: 6 },
        ]);
    });

    it('blocks the whole host when ONE of its records is private, whichever comes first', async () => {
        for (const records of [['93.184.216.34', '10.0.0.5'], ['10.0.0.5', '93.184.216.34'], ['93.184.216.34', '2606:4700:4700::1111', '::1'], ['8.8.8.8', '169.254.169.254'], ['8.8.8.8', '::ffff:127.0.0.1']]) {
            await assert.rejects(
                guardedLookup('mixed.example.com', answer(...records)),
                (err: unknown) => err instanceof BlockedHostError && err.kind === 'blocked_address' && err.blocked !== undefined,
                records.join(', '),
            );
        }
    });

    it('names the blocked address for the log and not in the message a person reads', async () => {
        await assert.rejects(guardedLookup('x.example.com', answer('93.184.216.34', '192.168.7.7')), (err: unknown) => {
            assert.ok(err instanceof BlockedHostError);
            assert.equal(err.blocked?.address, '192.168.7.7');
            assert.doesNotMatch(err.message, /192\.168|\d+\.\d+\.\d+\.\d+/);
            return true;
        });
    });

    it('treats a name with no answers, a failing resolver and junk answers as a name that does not resolve', async () => {
        await assert.rejects(guardedLookup('none.example.com', async () => []), (e: unknown) => e instanceof BlockedHostError && e.kind === 'dns');
        await assert.rejects(guardedLookup('boom.example.com', async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); }), (e: unknown) => e instanceof BlockedHostError && e.kind === 'dns');
        await assert.rejects(guardedLookup('again.example.com', async () => { throw Object.assign(new Error('x'), { code: 'EAI_AGAIN' }); }), (e: unknown) => e instanceof BlockedHostError && /did not answer/.test(e.message));
        await assert.rejects(guardedLookup('junk.example.com', (async () => 'nope') as never), (e: unknown) => e instanceof BlockedHostError && e.kind === 'dns');
        await assert.rejects(guardedLookup('junk2.example.com', answer('not-an-ip')), (e: unknown) => e instanceof BlockedHostError && e.kind === 'blocked_address');
    });

    it('strips brackets and zones from what it returns, so what is connected to is a bare address', async () => {
        const out = await guardedLookup('v6.example.com', answer('[2606:4700:4700::1111]'));
        assert.deepEqual(out, [{ address: '2606:4700:4700::1111', family: 6 }]);
    });
});
