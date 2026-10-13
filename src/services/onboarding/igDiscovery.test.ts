/**
 * Reading Instagram for the draft over a fake Graph (03 §1): the requests it makes, the answers it maps, the failures it names, and
 * that the token is in the Authorization header and nowhere else, in no error and in no log line.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { GRAPH_BASE } from '../instagram.js';
import {
    DISCOVERY_MEDIA_LIMIT, OWN_MEDIA_LIMIT, discoveryMainFields, discoveryNameFields, fetchBusinessDiscovery, fetchOwnInstagram, probeBusinessDiscovery,
} from './igDiscovery.js';
import { ENGLISH, GULF } from './fixtures/captions.js';
import { networkError, stubAxios, type Reply, type SeenRequest } from './fixtures/httpStub.js';
import {
    OWN_IG_ID, OWN_TOKEN, PLATFORM_IG_ID, PLATFORM_TOKEN, SHOP_HANDLE, batchError, batchOk, discoveryBody, mediaFrom, nameBody, ownMediaBody, ownUserBody,
} from './fixtures/instagram.js';

const platform = { token: PLATFORM_TOKEN, igUserId: PLATFORM_IG_ID };
const own = { token: OWN_TOKEN, igUserId: OWN_IG_ID };

let restoreHttp: (() => void) | undefined;
let seen: SeenRequest[] = [];
let lines: string[] = [];
let restoreSink: (() => void) | undefined;

before(() => {
    const previous = setLogSink((_, line) => lines.push(line));
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
beforeEach(() => { lines = []; });
afterEach(() => restoreHttp?.());

/** A fake Graph that answers each batch with `items` (one answer per item), or the whole call with a `Reply`. */
function graph(answer: (call: SeenRequest, n: number) => Reply | unknown[]): void {
    const stub = stubAxios(metaHttp, (call, n) => {
        const a = answer(call, n);
        return Array.isArray(a) ? { status: 200, data: a } : (a as Reply);
    });
    seen = stub.seen;
    restoreHttp = stub.restore;
}

const batchItems = (call: SeenRequest): Array<{ method: string; relative_url: string }> => JSON.parse(new URLSearchParams(call.data).get('batch') ?? '[]');
const decodedUrls = (call: SeenRequest): string[] => batchItems(call).map((i) => decodeURIComponent(i.relative_url));

/** The token must be in no request body, no URL, no parameter and no log line, in plain or URL-encoded form. */
function assertTokenOnlyInHeader(token: string): void {
    for (const call of seen) {
        assert.ok(!call.data.includes(token) && !call.data.includes(encodeURIComponent(token)), 'the token is not in the body');
        assert.ok(!call.url.includes(token), 'the token is not in the URL');
        assert.ok(!JSON.stringify(call.params).includes(token), 'the token is not in the params');
        assert.equal(call.headers.authorization, `Bearer ${token}`);
    }
}
function assertNoTokenAnywhere(value: unknown, token: string): void {
    for (const text of [JSON.stringify(value), inspect(value, { depth: 12, showHidden: true })]) {
        assert.ok(!text.includes(token) && !text.includes(encodeURIComponent(token)), 'the token is in the result');
        assert.ok(!text.includes(token.slice(0, 24)), 'the start of the token is in the result');
    }
    for (const line of lines) assert.ok(!line.includes(token) && !line.includes(token.slice(0, 24)), `a log line holds the token: ${line.slice(0, 120)}`);
}

describe('the Business Discovery request', () => {
    it('asks for exactly the fields of 03 §1, by the handle, and never for a picture', () => {
        const main = discoveryMainFields('noor.perfumes');
        assert.equal(
            main,
            'business_discovery.username(noor.perfumes){username,biography,website,followers_count,media_count,'
            + 'media.limit(30){id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,view_count}}',
        );
        assert.equal(DISCOVERY_MEDIA_LIMIT, 30);
        assert.equal(discoveryNameFields('noor.perfumes'), 'business_discovery.username(noor.perfumes){name}');
        assert.ok(!/picture|media_url|thumbnail|comments\{|from/.test(main));
        assert.ok(!/[{,]name[,}]/.test(main), '`name` is asked in its own batch item: one unknown field fails the whole call');
    });
});

describe('fetchBusinessDiscovery', () => {
    it('makes ONE batch POST of two items as the platform\'s account, with the token in the header only', async () => {
        graph(() => [batchOk(discoveryBody()), batchOk(nameBody('متجر نور للعطور'))]);
        const result = await fetchBusinessDiscovery(platform, '@Noor.Perfumes');
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.method, 'POST');
        assert.equal(seen[0]!.url, `${GRAPH_BASE}/`);
        assert.deepEqual(decodedUrls(seen[0]!), [
            `${PLATFORM_IG_ID}?fields=${discoveryMainFields('noor.perfumes')}`,
            `${PLATFORM_IG_ID}?fields=${discoveryNameFields('noor.perfumes')}`,
        ]);
        assert.ok(batchItems(seen[0]!).every((i) => i.method === 'GET'), 'a read: no item is a write');
        assertTokenOnlyInHeader(PLATFORM_TOKEN);
        assert.ok(result.ok);
        assert.equal(result.value.via, 'business_discovery');
        assert.equal(result.value.name, 'متجر نور للعطور');
        assert.equal(result.value.posts.length, GULF.length);
        assert.equal(result.value.followers, 12_400);
    });

    it('reads a handle typed as a link, and asks for the normalised one', async () => {
        graph(() => [batchOk(discoveryBody()), batchOk(nameBody('x'))]);
        await fetchBusinessDiscovery(platform, 'https://www.instagram.com/Noor.Perfumes/?hl=ar');
        assert.match(decodedUrls(seen[0]!)[0]!, /^\d+\?fields=business_discovery\.username\(noor\.perfumes\)\{/);
    });

    it('still returns the profile when the `name` request fails: it is not a field Business Discovery promises', async () => {
        graph(() => [batchOk(discoveryBody()), batchError(400, 100, '(#100) Tried accessing nonexisting field (name) on node type (IGUser)')]);
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(result.ok);
        assert.equal(result.value.name, null);
        assert.equal(result.value.posts.length, GULF.length);
    });

    it('answers `not_readable` for code 110 (does not exist, private or personal), final, and does not ask again', async () => {
        graph(() => [batchError(400, 110, 'Invalid user id'), batchError(400, 110, 'Invalid user id')]);
        const result = await fetchBusinessDiscovery(platform, 'a.personal.account');
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'not_readable');
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.code, 110);
        assert.equal(result.error.source, 'instagram_discovery');
        assert.equal(seen.length, 1);
    });

    it('answers `age_gated` for a 200 with no profile in it', async () => {
        graph(() => [batchOk({ id: PLATFORM_IG_ID }), batchOk({ id: PLATFORM_IG_ID })]);
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'age_gated');
        assert.equal(result.error.retryable, false);
    });

    it('answers `rate_limited`, retryable, for each of Meta\'s throttling codes, and does not hammer: one request', async () => {
        for (const code of [4, 17, 32, 613, 80001, 80002]) {
            graph(() => [batchError(400, code, '(#80002) There have been too many calls to this Instagram account'), batchError(400, code, 'x')]);
            const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'rate_limited', String(code));
            assert.equal(result.error.retryable, true);
            assert.equal(seen.length, 1);
            restoreHttp?.();
        }
    });

    it('treats a usage header near the ceiling as a throttle for the call that fails with it', async () => {
        const stub = stubAxios(metaHttp, () => ({
            status: 200, headers: { 'x-business-use-case-usage': JSON.stringify({ [PLATFORM_IG_ID]: [{ call_count: 95, total_cputime: 10, total_time: 10, type: 'instagram' }] }) },
            data: [{ code: 500, body: JSON.stringify({ error: { message: 'Service busy', code: 1 } }) }, null],
        }));
        seen = stub.seen;
        restoreHttp = stub.restore;
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'rate_limited');
    });

    it('answers `no_access` for a dead token or a missing permission, final', async () => {
        for (const failure of [batchError(400, 190, 'Error validating access token: Session has expired', 463), batchError(403, 10, '(#10) Application does not have permission for this action'), batchError(400, 200, '(#200) Requires instagram_basic permission')]) {
            graph(() => [failure, failure]);
            const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'no_access');
            assert.equal(result.error.retryable, false);
            restoreHttp?.();
        }
    });

    it('answers `upstream`, retryable, for an item Meta timed out', async () => {
        graph(() => [null, null]);
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'upstream');
        assert.equal(result.error.retryable, true);
    });

    it('retries a failed call ONCE (the app\'s own `withRetry`, one retry) and then answers `upstream`', async () => {
        graph(() => ({ status: 503, data: { error: { message: 'Service Unavailable', code: 2 } } }));
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'upstream');
        assert.equal(result.error.http_status, 503);
        assert.equal(seen.length, 2);
    });

    it('answers `upstream` for a connection that never completed, with no HTTP status', async () => {
        graph(() => networkError('ECONNABORTED', 'timeout of 10000ms exceeded'));
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'upstream');
        assert.equal(result.error.http_status, null);
    });

    it('asks nothing for a handle that is not a username: no request is made, and nothing can be spliced into the field expression', async () => {
        graph(() => [batchOk(discoveryBody()), batchOk(nameBody('x'))]);
        for (const bad of ['x){id}', 'x){username}//', '', 'two words', 'https://www.instagram.com/p/abc/', 'ع'.repeat(5)]) {
            const result = await fetchBusinessDiscovery(platform, bad);
            assert.ok(!result.ok, bad);
            assert.equal(result.error.kind, 'invalid_handle');
            assert.equal(result.error.retryable, false);
        }
        assert.equal(seen.length, 0);
    });

    it('is `not_configured`, with no request, when there is no account to read with', async () => {
        graph(() => [batchOk(discoveryBody()), batchOk(nameBody('x'))]);
        for (const creds of [null, undefined, { token: '', igUserId: PLATFORM_IG_ID }, { token: PLATFORM_TOKEN, igUserId: '' }, { token: PLATFORM_TOKEN, igUserId: '123/../456' }, { token: PLATFORM_TOKEN, igUserId: 'abc' }]) {
            const result = await fetchBusinessDiscovery(creds, SHOP_HANDLE);
            assert.ok(!result.ok);
            assert.equal(result.error.kind, 'not_configured');
        }
        assert.equal(seen.length, 0);
    });

    it('reads an English account the same way', async () => {
        graph(() => [batchOk(discoveryBody({ username: 'ahmed.coach', biography: 'Online fitness coach', media: mediaFrom(ENGLISH) })), batchOk(nameBody('Ahmed'))]);
        const result = await fetchBusinessDiscovery(platform, 'ahmed.coach');
        assert.ok(result.ok);
        assert.equal(result.value.name, 'Ahmed');
        assert.equal(result.value.posts[0]!.caption, ENGLISH[0]);
    });
});

describe('the token never leaves the Authorization header: not in a URL, an error, a result or a log line', () => {
    it('when Meta echoes the token in an item error', async () => {
        const echo = `Invalid OAuth access token - Cannot parse access token ${PLATFORM_TOKEN}`;
        graph(() => [batchError(400, 190, echo), batchError(400, 190, echo)]);
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, 'no_access');
        assertTokenOnlyInHeader(PLATFORM_TOKEN);
        assertNoTokenAnywhere(result, PLATFORM_TOKEN);
    });

    it('when the whole call fails and axios throws an error that holds the request, headers and all', async () => {
        graph(() => ({ status: 400, data: { error: { message: `Invalid token ${PLATFORM_TOKEN}`, code: 190 } } }));
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assertTokenOnlyInHeader(PLATFORM_TOKEN);
        assertNoTokenAnywhere(result, PLATFORM_TOKEN);
    });

    it('when the failure is a network error whose message names the URL, and when a 5xx is retried and logged', async () => {
        graph(() => networkError('ECONNRESET', `read ECONNRESET while sending Authorization: Bearer ${PLATFORM_TOKEN}`));
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(!result.ok);
        assertNoTokenAnywhere(result, PLATFORM_TOKEN);
        assert.ok(lines.some((l) => l.includes('meta.retrying')), 'the retry was logged, and the log holds no token');
    });

    it('on success: the token is in the header and the result and the logs hold none', async () => {
        graph(() => [batchOk(discoveryBody()), batchOk(nameBody('x'))]);
        const result = await fetchBusinessDiscovery(platform, SHOP_HANDLE);
        assert.ok(result.ok);
        assertTokenOnlyInHeader(PLATFORM_TOKEN);
        assertNoTokenAnywhere(result, PLATFORM_TOKEN);
        assert.ok(lines.some((l) => l.includes('onboarding.ig_source')), 'a read is logged');
    });

    it('for the tenant\'s own token, in the same ways', async () => {
        graph(() => [batchError(400, 190, `Token ${OWN_TOKEN} expired`, 463), batchError(400, 190, `Token ${OWN_TOKEN} expired`, 463)]);
        const result = await fetchOwnInstagram(own);
        assert.ok(!result.ok);
        assertTokenOnlyInHeader(OWN_TOKEN);
        assertNoTokenAnywhere(result, OWN_TOKEN);
    });
});

describe('fetchOwnInstagram', () => {
    it('makes ONE batch of the user node and the media, no comments, 50 posts asked for and the 30 newest kept', async () => {
        const media = { data: Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, caption: `Post ${i} about training and nutrition for people in a hurry` })) };
        graph(() => [batchOk(ownUserBody()), batchOk(media)]);
        const result = await fetchOwnInstagram(own, null);
        assert.equal(seen.length, 1);
        assert.deepEqual(decodedUrls(seen[0]!), [
            `${OWN_IG_ID}?fields=username,name,biography,website,followers_count,media_count`,
            `${OWN_IG_ID}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count&limit=${OWN_MEDIA_LIMIT}`,
        ]);
        assert.equal(OWN_MEDIA_LIMIT, 50);
        for (const url of decodedUrls(seen[0]!)) assert.ok(!/(?:^|[?,{&/])comments(?:[,}&/]|$)/.test(url), `no comment text is asked for (privacy): ${url}`);
        assertTokenOnlyInHeader(OWN_TOKEN);
        assert.ok(result.ok);
        assert.equal(result.value.via, 'own_token');
        assert.equal(result.value.posts.length, 30);
        assert.equal(result.value.username, 'ahmed.coach');
    });

    it('flags a typed handle that is not the connected account\'s, and says nothing for one that is', async () => {
        graph(() => [batchOk(ownUserBody()), batchOk(ownMediaBody())]);
        const same = await fetchOwnInstagram(own, '@Ahmed.Coach');
        assert.ok(same.ok && !same.value.handleMismatch);
        restoreHttp?.();
        graph(() => [batchOk(ownUserBody()), batchOk(ownMediaBody())]);
        const other = await fetchOwnInstagram(own, 'someone.else');
        assert.ok(other.ok && other.value.handleMismatch);
    });

    it('keeps the bio when the media list fails: a profile with no posts, and why', async () => {
        graph(() => [batchOk(ownUserBody()), batchError(400, 10, '(#10) Application does not have permission for this action')]);
        const result = await fetchOwnInstagram(own);
        assert.ok(result.ok);
        assert.deepEqual(result.value.posts, []);
        assert.equal(result.value.biography, 'Online fitness coach\nPlans that fit a busy week');
        assert.equal(result.value.postsError?.kind, 'no_access');
        assert.equal(result.value.postsError?.source, 'instagram_own');
    });

    it('answers `no_access` for a token that no longer works, `rate_limited` for a throttle', async () => {
        graph(() => [batchError(400, 190, 'Session has expired', 463), batchError(400, 190, 'Session has expired', 463)]);
        const dead = await fetchOwnInstagram(own);
        assert.ok(!dead.ok);
        assert.equal(dead.error.kind, 'no_access');
        assert.equal(dead.error.source, 'instagram_own');
        restoreHttp?.();
        graph(() => [batchError(400, 4, 'Application request limit reached'), batchError(400, 4, 'x')]);
        const slow = await fetchOwnInstagram(own);
        assert.ok(!slow.ok);
        assert.equal(slow.error.kind, 'rate_limited');
    });

    it('is `invalid_handle` for a typed handle that cannot be one, `not_configured` with no connection, and asks nothing in either case', async () => {
        graph(() => [batchOk(ownUserBody()), batchOk(ownMediaBody())]);
        const bad = await fetchOwnInstagram(own, 'x){id}');
        assert.ok(!bad.ok);
        assert.equal(bad.error.kind, 'invalid_handle');
        const none = await fetchOwnInstagram(null);
        assert.ok(!none.ok);
        assert.equal(none.error.kind, 'not_configured');
        assert.equal(seen.length, 0);
    });
});

describe('probeBusinessDiscovery', () => {
    it('makes ONE GET (not a batch, not a POST) for the main field expression, and returns Meta\'s body as it is', async () => {
        const body = discoveryBody();
        const stub = stubAxios(metaHttp, () => ({ status: 200, data: body }));
        seen = stub.seen;
        restoreHttp = stub.restore;
        const probe = await probeBusinessDiscovery(platform, 'natgeo');
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.method, 'GET');
        assert.equal(seen[0]!.url, `${GRAPH_BASE}/${PLATFORM_IG_ID}`);
        assert.deepEqual(seen[0]!.params, { fields: discoveryMainFields('natgeo') });
        assertTokenOnlyInHeader(PLATFORM_TOKEN);
        assert.ok(probe.ok);
        assert.deepEqual(probe.body, body);
        assert.equal(probe.requests, 1);
    });

    it('returns the failure reduced to code, subcode, status and a message with the token taken out', async () => {
        const stub = stubAxios(metaHttp, () => ({ status: 400, data: { error: { message: `Invalid token ${PLATFORM_TOKEN}`, code: 190, error_subcode: 463 } } }));
        seen = stub.seen;
        restoreHttp = stub.restore;
        const probe = await probeBusinessDiscovery(platform, 'natgeo');
        assert.ok(!probe.ok);
        assert.deepEqual([probe.failure.code, probe.failure.subcode, probe.failure.status], [190, 463, 400]);
        assert.match(probe.failure.message, /^Invalid token /, 'Meta\'s own words are kept, not ours');
        assertNoTokenAnywhere(probe, PLATFORM_TOKEN);
    });
});
