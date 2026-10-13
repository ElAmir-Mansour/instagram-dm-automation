/** robots.txt, read for AutoReplyProBot and `*` the way RFC 9309 reads it. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixture } from './fixtures/load.js';
import { ALLOW_ALL, DISALLOW_ALL, parseRobots } from './robots.js';

describe('parseRobots', () => {
    it('uses the group that names the bot over the wildcard group', () => {
        const robots = parseRobots(fixture('robots.txt'));
        assert.equal(robots.group, 'bot');
        // The bot's own rules.
        assert.equal(robots.allows('/'), true);
        assert.equal(robots.allows('/admin'), true, 'the wildcard group is not the bot\'s');
        assert.equal(robots.allows('/private/data'), false);
        assert.equal(robots.allows('/private/press/kit'), true, 'the longer Allow beats the shorter Disallow');
        assert.equal(robots.allows('/pages/faq'), false, '$ anchors the end');
        assert.equal(robots.allows('/pages/faq/more'), true);
    });

    it('falls back to * when no group names the bot', () => {
        const robots = parseRobots('User-agent: *\nDisallow: /admin\nDisallow: /cart\nAllow: /cart/help\nDisallow: /*.json$\n');
        assert.equal(robots.group, 'wildcard');
        assert.equal(robots.allows('/'), true);
        assert.equal(robots.allows('/admin'), false);
        assert.equal(robots.allows('/admin/users'), false);
        assert.equal(robots.allows('/cart'), false);
        assert.equal(robots.allows('/cart/help'), true);
        assert.equal(robots.allows('/data.json'), false);
        assert.equal(robots.allows('/data.json?x=1'), true, 'the $ means the path ends there');
        assert.equal(robots.allows('/data.jsonp'), true);
    });

    it('lets an Allow win a tie with a Disallow of the same length', () => {
        const robots = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x\n');
        assert.equal(robots.allows('/x'), true);
    });

    it('reads an empty Disallow as "everything is allowed"', () => {
        assert.equal(parseRobots('User-agent: *\nDisallow:\n').allows('/anything'), true);
    });

    it('closes everything for Disallow: /', () => {
        const robots = parseRobots('User-agent: AutoReplyProBot\nDisallow: /\n');
        assert.equal(robots.group, 'bot');
        assert.equal(robots.allows('/'), false);
        assert.equal(robots.allows('/about'), false);
    });

    it('is case-insensitive about field names and the agent, ignores comments, and reads any line ending', () => {
        const robots = parseRobots('USER-AGENT: autoreplyprobot # us\r\nDISALLOW: /nope # not this\r\rALLOW: /nope/yes\n');
        assert.equal(robots.group, 'bot');
        assert.equal(robots.allows('/nope'), false);
        assert.equal(robots.allows('/nope/yes'), true);
    });

    it('merges two groups for the same agent', () => {
        const robots = parseRobots('User-agent: AutoReplyProBot\nDisallow: /a\n\nUser-agent: AutoReplyProBot\nDisallow: /b\n');
        assert.equal(robots.allows('/a'), false);
        assert.equal(robots.allows('/b'), false);
        assert.equal(robots.allows('/c'), true);
    });

    it('ignores rules before any user-agent line, lines it does not know, and garbage', () => {
        const robots = parseRobots('Disallow: /orphan\nSitemap: https://x.example/s.xml\nCrawl-delay: 10\nnot a line\n\nUser-agent: *\nDisallow: /real\n');
        assert.equal(robots.allows('/orphan'), true);
        assert.equal(robots.allows('/real'), false);
        assert.equal(parseRobots('').allows('/x'), true);
        assert.equal(parseRobots('\u0000\u0001 garbage').allows('/x'), true);
    });

    it('does not mistake another bot whose name is part of ours for ours', () => {
        const robots = parseRobots('User-agent: Reply\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n');
        // "Reply" is a substring of "AutoReplyProBot" but the group is for a product token that matches ours: it applies.
        // A product token that is NOT part of ours does not.
        const other = parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n');
        assert.equal(other.group, 'wildcard');
        assert.equal(other.allows('/'), true);
        assert.equal(robots.allows('/'), false, 'a token that is part of our name matches us, as the RFC says');
    });

    it('matches patterns with several wildcards and with query strings', () => {
        const robots = parseRobots('User-agent: *\nDisallow: /*/private/*.html$\nDisallow: /search?*\n');
        assert.equal(robots.allows('/a/private/x.html'), false);
        assert.equal(robots.allows('/a/b/private/x.html'), false);
        assert.equal(robots.allows('/a/private/x.html?y=1'), true);
        assert.equal(robots.allows('/search?q=x'), false);
        assert.equal(robots.allows('/search'), true);
    });

    it('exposes an allow-all for a missing file and a disallow-all for a failing server', () => {
        assert.equal(ALLOW_ALL.allows('/anything'), true);
        assert.equal(DISALLOW_ALL.allows('/anything'), false);
        assert.equal(DISALLOW_ALL.allows('/'), false);
    });

    it('accepts a path with no leading slash', () => {
        assert.equal(parseRobots('User-agent: *\nDisallow: /x\n').allows('x'), false);
    });

    it('stays fast on a hostile pattern', () => {
        const robots = parseRobots(`User-agent: *\nDisallow: ${'*a'.repeat(200)}b$\n`);
        const started = Date.now();
        robots.allows(`/${'a'.repeat(5000)}`);
        assert.ok(Date.now() - started < 500);
    });
});
