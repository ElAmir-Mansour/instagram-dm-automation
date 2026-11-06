import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mediaClient } from './mediaClient.js';

const HOST = 'msg-response-auto.vercel.app';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

describe('mediaClient: who asked for an uploaded file', () => {
    it('names Meta, Google and TikTok fetchers by their User-Agent, even with a Referer', () => {
        assert.equal(mediaClient({ 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' }, HOST), 'meta');
        assert.equal(mediaClient({ 'user-agent': 'meta-externalagent/1.1', referer: `https://${HOST}/dashboard` }, HOST), 'meta');
        assert.equal(mediaClient({ 'user-agent': 'Google-Apps-Script' }, HOST), 'google');
        assert.equal(mediaClient({ 'user-agent': 'TikTok-Fetcher/1.0' }, HOST), 'tiktok');
    });

    it('a browser on this app\'s own pages is the dashboard; any other browser is a browser', () => {
        assert.equal(mediaClient({ 'user-agent': CHROME, referer: `https://${HOST}/dashboard#/posts` }, HOST), 'dashboard');
        assert.equal(mediaClient({ 'user-agent': CHROME, referer: 'https://example.com/' }, HOST), 'browser');
        assert.equal(mediaClient({ 'user-agent': CHROME }, HOST), 'browser');
        assert.equal(mediaClient({ 'user-agent': CHROME, referer: 'not a url' }, HOST), 'browser');
    });

    it('anything else with a User-Agent is a script, and nothing at all is unknown', () => {
        assert.equal(mediaClient({ 'user-agent': 'node' }, HOST), 'script');
        assert.equal(mediaClient({ 'user-agent': 'curl/8.7.1' }, HOST), 'script');
        assert.equal(mediaClient({}, HOST), 'unknown');
        assert.equal(mediaClient(undefined, undefined), 'unknown');
    });
});
