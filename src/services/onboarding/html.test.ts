/** The tokenizer: what it reads, and that no page can make it throw, hang or run away. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collapse, decodeEntities, MAX_HTML_CHARS, tokenize, type Token } from './html.js';

const opens = (tokens: Token[]) => tokens.flatMap((t) => (t.t === 'open' ? [t] : []));
const texts = (tokens: Token[]) => tokens.flatMap((t) => (t.t === 'text' ? [t.text] : []));

describe('tokenize', () => {
    it('reads tags, attributes in every quoting, and text', () => {
        const tokens = tokenize(`<A HREF="/x?a=1&amp;b=2" class='one two' data-n=5 hidden>Hi <b>there</b></A>`);
        const a = opens(tokens)[0]!;
        assert.equal(a.tag, 'a');
        assert.deepEqual(a.attrs, { href: '/x?a=1&b=2', class: 'one two', 'data-n': '5', hidden: '' });
        assert.deepEqual(texts(tokens), ['Hi ', 'there']);
        assert.deepEqual(tokens.filter((t) => t.t === 'close').map((t) => (t as { tag: string }).tag), ['b', 'a']);
    });

    it('keeps the first value of a repeated attribute, as a browser does', () => {
        assert.equal(opens(tokenize('<a href="/first" href="/second">x</a>'))[0]!.attrs.href, '/first');
    });

    it('treats script and style content as code, not markup', () => {
        const tokens = tokenize('<script>if (a < b && c > d) { document.write("<b>x</b>"); }</script><p>after</p>');
        assert.deepEqual(texts(tokens), ['if (a < b && c > d) { document.write("<b>x</b>"); }', 'after']);
        assert.equal(opens(tokens).map((t) => t.tag).join(), 'script,p');
    });

    it('reads a title as text with its entities decoded', () => {
        assert.deepEqual(texts(tokenize('<title>A &amp; B &#1575;</title>')), ['A & B ا']);
    });

    it('drops comments, doctypes, processing instructions and CDATA, and an unterminated comment to the end', () => {
        assert.deepEqual(texts(tokenize('<!DOCTYPE html><!-- x --><?xml version="1.0"?>a<![CDATA[hidden]]>b')), ['a', 'b']);
        assert.deepEqual(texts(tokenize('before<!-- never closed <p>text</p>')), ['before']);
    });

    it('treats a lone < as text', () => {
        // It may come back in several pieces; what matters is that none of it is lost and none is read as a tag.
        const tokens = tokenize('a < b and 3<4 and <3');
        assert.equal(texts(tokens).join(''), 'a < b and 3<4 and <3');
        assert.equal(opens(tokens).length, 0);
    });

    it('survives broken markup: unterminated tags, quotes and attributes', () => {
        for (const html of ['<a href="never closed', '<div class=', '<', '</', '<a <b <c', '<p/>text', '<img src=x/><br/>', '<a =x>y</a>', '<a "q">z', '<!', '<!--', '</>', '<</a>', '<a\u0000b>']) {
            assert.doesNotThrow(() => tokenize(html), html);
        }
        assert.deepEqual(texts(tokenize('<p/>text')), ['text']);
        assert.equal(opens(tokenize('<img src=x/><br/>')).length, 2);
    });

    it('finds the end of a tag past a > inside a quoted attribute', () => {
        const tokens = tokenize('<a title="1 > 0" href="/y">go</a>');
        assert.equal(opens(tokens)[0]!.attrs.href, '/y');
        assert.deepEqual(texts(tokens), ['go']);
    });

    it('caps the number of attributes and their length', () => {
        const many = `<a ${Array.from({ length: 500 }, (_, i) => `a${i}=1`).join(' ')}>x</a>`;
        assert.ok(Object.keys(opens(tokenize(many))[0]!.attrs).length <= 64);
        const long = `<a href="${'x'.repeat(100_000)}">x</a>`;
        assert.ok(opens(tokenize(long))[0]!.attrs.href!.length <= 20_000);
    });

    it('cuts off input past the cap and a flood of tokens, quickly', () => {
        const started = Date.now();
        const tokens = tokenize('<p>x</p>'.repeat(400_000));
        assert.ok(tokens.length <= 300_001);
        assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
        assert.equal(tokenize('a'.repeat(MAX_HTML_CHARS + 5000)).length, 1);
    });

    it('is not made quadratic by a page of unclosed constructs', () => {
        const started = Date.now();
        for (const html of ['<a '.repeat(100_000), '<!--'.repeat(100_000), '</a'.repeat(100_000), '<script>'.repeat(50_000), '<p title="'.repeat(50_000), '&#'.repeat(100_000)]) tokenize(html);
        assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    });

    it('lower-cases tag names without moving anything', () => {
        // U+0130 lower-cases to two characters with toLowerCase; the scan uses ASCII-only lower-casing, so indexes stay right.
        const tokens = tokenize('İ<SCRIPT>var x = "</p>";</SCRIPT><p>ok</p>');
        assert.deepEqual(texts(tokens), ['İ', 'var x = "</p>";', 'ok']);
    });
});

describe('decodeEntities', () => {
    it('decodes numeric and named references once', () => {
        assert.equal(decodeEntities('&lt;b&gt; &amp;lt; &#65;&#x42; &quot;q&quot; &nbsp;|&copy;'), '<b> &lt; AB "q" \u00A0|©');
    });

    it('leaves unknown names and bare ampersands alone', () => {
        assert.equal(decodeEntities('R&D &unknownthing; a & b &amp'), 'R&D &unknownthing; a & b &amp');
    });

    it('replaces impossible code points instead of throwing', () => {
        assert.equal(decodeEntities('&#0; &#xD800; &#x110000; &#99999999;'), '� � � &#99999999;');
    });

    it('collapses whitespace', () => {
        assert.equal(collapse('  a \n\t b\u00A0\u00A0c  '), 'a b c');
    });
});
