/**
 * The handles a tenant types. An Instagram one is spliced into a Graph field expression, so the property that matters is that
 * nothing that is not a username comes out, whatever goes in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INSTAGRAM_USERNAME, normalizeInstagramHandle, parseYouTubeRef } from './handles.js';

describe('normalizeInstagramHandle', () => {
    it('reads a username however it was typed', () => {
        for (const [input, expected] of [
            ['noor.perfumes', 'noor.perfumes'],
            ['@Noor.Perfumes', 'noor.perfumes'],
            ['  @@noor_perfumes  ', 'noor_perfumes'],
            ['instagram.com/noor.perfumes', 'noor.perfumes'],
            ['www.instagram.com/Noor.Perfumes/', 'noor.perfumes'],
            ['https://www.instagram.com/noor.perfumes/?hl=ar', 'noor.perfumes'],
            ['https://instagram.com/noor.perfumes#top', 'noor.perfumes'],
            ['https://m.instagram.com/noor.perfumes', 'noor.perfumes'],
            ['instagr.am/noor', 'noor'],
            ['a', 'a'],
            ['x'.repeat(30), 'x'.repeat(30)],
        ] as const) {
            assert.equal(normalizeInstagramHandle(input), expected, input);
        }
    });

    it('is not fooled into a link by a username that has a dot and a domain in it', () => {
        assert.equal(normalizeInstagramHandle('instagram.com.shop'), 'instagram.com.shop');
    });

    it('refuses what is not a username: a path, a post, a space, other scripts, too long, not text', () => {
        for (const input of [
            '', '   ', '@', 'two words', 'x'.repeat(31), 'نور.للعطور', 'noor-perfumes', 'noor/perfumes', 'a,b', 'a%20b',
            'https://www.instagram.com/p/C1x2y3/', 'https://www.instagram.com/reel/C1x2y3/', 'https://www.instagram.com/explore/',
            'https://www.instagram.com/', 'https://evil.example/instagram.com/noor', 'https://youtube.com/@noor',
            'https://instagram.com.evil.example/noor', 'x'.repeat(301),
        ]) {
            assert.equal(normalizeInstagramHandle(input), null, JSON.stringify(input.slice(0, 40)));
        }
        for (const input of [undefined, null, 5, {}, [], ['noor']]) assert.equal(normalizeInstagramHandle(input), null);
    });

    it('never lets anything through that could change a field expression: parentheses, braces, commas, dots-and-slashes, whitespace, controls', () => {
        const hostile = [
            'x){id}', 'x){username,biography}//', 'x).media{id', 'a}b', '(x)', 'x(', 'a,b', 'a\nb', 'a\tb', 'a\u0000b', 'a;b', 'a&fields=id', 'a?b', 'a#b',
            'a‮b', 'a​b', 'ａｂｃ', 'a b', '../x', 'a\\b', "a'b", 'a"b', 'a`b', 'a$b', 'a{b', 'a|b', '<script>', 'a=b',
        ];
        // And some generated ones: every printable ASCII and a few other characters in every position of a short name.
        const alphabet = [...'abc.0_', ...'(){},;=&?#/\\ \n"\'`$|<>%@:', '​', '‮', 'é', 'ع'];
        for (const first of alphabet) for (const second of alphabet) hostile.push(`${first}x${second}`, `${first}${second}`);
        for (const input of hostile) {
            const out = normalizeInstagramHandle(input);
            if (out !== null) assert.match(out, INSTAGRAM_USERNAME, JSON.stringify(input));
        }
        for (const input of hostile.slice(0, 26)) assert.equal(normalizeInstagramHandle(input), null, JSON.stringify(input));
    });
});

describe('parseYouTubeRef', () => {
    const ID = 'UCabcdefghijklmnopqrstuv';

    it('reads a handle with or without the @, in any case, and Arabic ones', () => {
        assert.deepEqual(parseYouTubeRef('@barmaga-academy'), { kind: 'handle', value: 'barmaga-academy' });
        assert.deepEqual(parseYouTubeRef('Barmaga.Academy'), { kind: 'handle', value: 'Barmaga.Academy' });
        assert.deepEqual(parseYouTubeRef('  @@abc  '), { kind: 'handle', value: 'abc' });
        assert.deepEqual(parseYouTubeRef('@أكاديمية_البرمجة'), { kind: 'handle', value: 'أكاديمية_البرمجة' });
    });

    it('reads a channel link: a handle URL, a channel id URL, a legacy /user/ link, a /c/ custom URL', () => {
        assert.deepEqual(parseYouTubeRef('https://www.youtube.com/@barmaga-academy'), { kind: 'handle', value: 'barmaga-academy' });
        assert.deepEqual(parseYouTubeRef('youtube.com/@barmaga-academy/videos'), { kind: 'handle', value: 'barmaga-academy' });
        assert.deepEqual(parseYouTubeRef('https://m.youtube.com/@barmaga-academy?si=abc'), { kind: 'handle', value: 'barmaga-academy' });
        assert.deepEqual(parseYouTubeRef(`https://www.youtube.com/channel/${ID}`), { kind: 'channel_id', value: ID });
        assert.deepEqual(parseYouTubeRef('https://www.youtube.com/user/GoogleDevelopers'), { kind: 'username', value: 'GoogleDevelopers' });
        assert.deepEqual(parseYouTubeRef('https://www.youtube.com/c/barmaga'), { kind: 'handle', value: 'barmaga' });
        assert.deepEqual(parseYouTubeRef('https://www.youtube.com/%40barmaga-academy'), { kind: 'handle', value: 'barmaga-academy' });
    });

    it('reads a bare channel id', () => {
        assert.deepEqual(parseYouTubeRef(ID), { kind: 'channel_id', value: ID });
    });

    it('refuses what names no channel: a video, a playlist, another site, a short or odd handle, not text', () => {
        for (const input of [
            '', '@', '@ab', 'two words', 'a'.repeat(31), 'https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://www.youtube.com/playlist?list=PL1',
            'https://www.youtube.com/channel/UCshort', 'https://evil.example/@barmaga', 'https://youtube.com.evil.example/@barmaga', 'https://www.youtube.com/',
            'a/b', 'a&b', 'a?b', 'x'.repeat(301),
        ]) {
            assert.equal(parseYouTubeRef(input), null, JSON.stringify(input.slice(0, 40)));
        }
        for (const input of [undefined, null, 5, {}, ['@abc']]) assert.equal(parseYouTubeRef(input), null);
    });
});
