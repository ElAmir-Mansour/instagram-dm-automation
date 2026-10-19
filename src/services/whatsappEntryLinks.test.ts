/**
 * Entry links: the ref that tags a first message, the message Meta is given, the label map beside Meta's own list, and the SQL that keeps it.
 *
 * Everything but the last describe is pure. The last runs the three statements against a recording `pool.query` (never Postgres: `.env`
 * holds the production connection string) and pins what can be pinned without a database: that each statement is ONE atomic UPDATE of the
 * `entry_links` key, scoped to the tenant's live row, with the label travelling as a bound parameter and never inside the SQL text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import type { WhatsAppQrCode } from './whatsapp.js';
import {
    composePrefill, dropEntryLinkLabel, ENTRY_ERRORS, ENTRY_LABEL_MAX_CHARS, ENTRY_POINT_ERROR_CODES, ENTRY_PREFILL_MAX_CHARS, entryLinkView,
    getEntryLinkLabels, isRef,
    mergeEntryLinks, newRef, newUniqueRef, parseEntryLinkInput, putEntryLinkLabel, readEntryLinkLabels, REF_ALPHABET, REF_LENGTH, refFromText,
    stripRef,
} from './whatsappEntryLinks.js';

const REF = 'K7M3QA';

describe('isRef / newRef', () => {
    it('accepts six characters of the alphabet with at least one digit, and nothing else', () => {
        assert.equal(isRef(REF), true);
        assert.equal(isRef('234567'), true);
        for (const bad of ['SUMMER', 'K7M3Q', 'K7M3QAB', 'k7m3qa', 'K0M3QA', 'KOM3QA', 'K1M3QA', 'KIM3QA', 'KLM3QA', 'K7M3Q ', '', null, 42]) {
            assert.equal(isRef(bad), false, String(bad));
        }
    });

    it('never uses a character that is misread: no 0, O, 1, I or L', () => {
        assert.equal(REF_ALPHABET.length, 31);
        for (const ch of '0O1IL') assert.ok(!REF_ALPHABET.includes(ch), ch);
    });

    it('makes well-formed refs, every time, from the crypto source', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 2000; i++) {
            const ref = newRef();
            assert.equal(ref.length, REF_LENGTH);
            assert.equal(isRef(ref), true, ref);
            seen.add(ref);
        }
        assert.ok(seen.size > 1990, 'refs are not repeating');
    });

    it('puts a digit in a ref that came out all letters, rather than making a word', () => {
        const ref = newRef(() => 0);
        assert.equal(isRef(ref), true, ref);
        assert.match(ref, /\d/);
    });

    it('makes one that is not taken, and fails loudly (not forever) when it cannot', () => {
        const first = newRef(() => 3);
        const next = (() => { let n = 0; return (k: number) => (n++ < 6 ? 3 : 5) % k; })();
        assert.notEqual(newUniqueRef(new Set([first]), next), first);
        assert.throws(() => newUniqueRef(new Set([first]), () => 3), /unused entry-link ref/);
    });
});

describe('refFromText', () => {
    it('finds the ref a first message carries, in Arabic or English, and upper-cases it', () => {
        assert.equal(refFromText(`مرحبا، أريد معلومات عن الخدمة #${REF}`), REF);
        assert.equal(refFromText(`Hi, tell me about the service #${REF}`), REF);
        assert.equal(refFromText(`hello #${REF.toLowerCase()}`), REF);
        assert.equal(refFromText(`#${REF}`), REF);
    });

    it('still finds it when something follows: Meta\'s own example appends " 1" to a message it was given', () => {
        assert.equal(refFromText(`Cyber Monday #${REF} 1`), REF);
        assert.equal(refFromText(`Hello #${REF}.`), REF);
        assert.equal(refFromText(`Hello #${REF}!`), REF);
        assert.equal(refFromText(`Hello #${REF}\n`), REF);
    });

    it('takes the LAST one: ours is appended after anything the owner wrote', () => {
        assert.equal(refFromText('Offer #AAAAA2 today #BBBBB3'), 'BBBBB3');
    });

    it('is null for text that is not a ref: wrong length, forbidden characters, a word, glued to other text', () => {
        for (const text of [
            'Hello', '', '#', '#K7M3Q', '#K7M3QAB', '#K7M3Q-', '#SUMMER', '#Python', '#K0M3QA', '#KOM3QA', '#K1M3QA',
            `C#${REF}`, `abc#${REF}`, `##${REF}`, `#${REF}9`, `#${REF}٣`, `#${REF}é`, `K7M3QA`, `# ${REF}`,
        ]) {
            assert.equal(refFromText(text), null, JSON.stringify(text));
        }
    });

    it('is null for anything that is not a string', () => {
        for (const v of [null, undefined, 42, {}, [], true]) assert.equal(refFromText(v), null);
    });

    it('does not fold look-alike characters onto the alphabet', () => {
        assert.equal(refFromText('#ſ7M3QA'), null, 'long s');
        assert.equal(refFromText('#K7M3QA'), null, 'Kelvin sign');
    });

    it('finds the ref in a message built by composePrefill, whatever the owner wrote', () => {
        for (const prefill of ['أريد التسجيل', 'Hello #SUMMER offer', 'Price: 50$ #1', 'مرحبا\nسطر ثان', 'x'.repeat(ENTRY_PREFILL_MAX_CHARS)]) {
            const m = composePrefill(prefill, REF);
            assert.ok('text' in m, prefill);
            assert.equal(refFromText(m.text), REF, prefill);
        }
    });
});

describe('stripRef', () => {
    it('gives back the owner\'s own text', () => {
        assert.equal(stripRef(`Hello there #${REF}`, REF), 'Hello there');
        assert.equal(stripRef(`Hello #${REF.toLowerCase()} 1`, REF), 'Hello 1');
        assert.equal(stripRef('  Hello  ', REF), 'Hello', 'a message without the ref is only trimmed');
        assert.equal(stripRef(`Hello #${REF}`, null), `Hello #${REF}`, 'with no ref known nothing is removed');
    });

    it('removes only the last occurrence', () => {
        assert.equal(stripRef(`#${REF} first, then #${REF}`, REF), `#${REF} first, then`);
    });
});

describe('composePrefill', () => {
    it('joins the owner\'s text and the ref with " #", and fits Meta\'s 140 characters', () => {
        assert.deepEqual(composePrefill('  Hello  ', REF), { text: `Hello #${REF}` });
        const longest = composePrefill('x'.repeat(120), REF);
        assert.ok('text' in longest);
        assert.equal(longest.text.length, 128);
        assert.ok(longest.text.length <= 140);
    });

    it('accepts a total of exactly 140 and refuses 141, never cutting the ref off the end', () => {
        const exactly = composePrefill('x'.repeat(132), REF);
        assert.ok('text' in exactly);
        assert.equal(exactly.text.length, 140);
        assert.ok(exactly.text.endsWith(`#${REF}`));

        const over = composePrefill('x'.repeat(133), REF);
        assert.ok('error' in over);
        assert.equal(over.code, 'prefill_too_long');
    });

    it('throws on a ref that is not one: that is a bug, not something an owner typed', () => {
        assert.throws(() => composePrefill('Hello', 'SUMMER'), TypeError);
    });
});

describe('parseEntryLinkInput', () => {
    it('trims a label and a prefill', () => {
        assert.deepEqual(parseEntryLinkInput({ label: '  Instagram bio ', prefill: ' Hello ' }), { value: { label: 'Instagram bio', prefill: 'Hello' } });
    });

    it(`accepts a ${ENTRY_LABEL_MAX_CHARS}-character label and a ${ENTRY_PREFILL_MAX_CHARS}-character prefill, and refuses one more of either`, () => {
        assert.ok('value' in parseEntryLinkInput({ label: 'l'.repeat(ENTRY_LABEL_MAX_CHARS), prefill: 'p'.repeat(ENTRY_PREFILL_MAX_CHARS) }));

        const tooLongLabel = parseEntryLinkInput({ label: 'l'.repeat(ENTRY_LABEL_MAX_CHARS + 1), prefill: 'Hello' });
        assert.ok('error' in tooLongLabel);
        assert.equal(tooLongLabel.code, 'label_too_long');

        const tooLongPrefill = parseEntryLinkInput({ label: 'Bio', prefill: 'p'.repeat(ENTRY_PREFILL_MAX_CHARS + 1) });
        assert.ok('error' in tooLongPrefill);
        assert.equal(tooLongPrefill.code, 'prefill_too_long');
    });

    it('refuses a missing or blank label or prefill, and a body that is not an object', () => {
        const code = (input: unknown) => {
            const r = parseEntryLinkInput(input);
            return 'error' in r ? r.code : null;
        };
        assert.equal(code({ prefill: 'Hello' }), 'invalid_label');
        assert.equal(code({ label: '   ', prefill: 'Hello' }), 'invalid_label');
        assert.equal(code({ label: 5, prefill: 'Hello' }), 'invalid_label');
        assert.equal(code({ label: 'Bio' }), 'invalid_prefill');
        assert.equal(code({ label: 'Bio', prefill: '  ' }), 'invalid_prefill');
        assert.equal(code(null), 'invalid_label');
        assert.equal(code([]), 'invalid_label');
    });
});

describe('the label map and the merged list', () => {
    const qr = (code: string, prefilledMessage: string, qrImageUrl: string | null = null): WhatsAppQrCode => ({
        code, prefilledMessage, deepLinkUrl: `https://wa.me/message/${code}`, qrImageUrl,
    });

    it('reads a stored map defensively: bad entries are skipped, not trusted', () => {
        assert.deepEqual(
            readEntryLinkLabels({
                GOOD0000AAAA11: { label: 'Bio', ref: REF, created_at: '2026-10-19T08:00:00.000Z' },
                BADREF0000BBBB: { label: 'x', ref: 'nope' },
                NOLABEL000CCCC: { ref: REF },
                NOTOBJ0000DDDD: 'x',
            }),
            { GOOD0000AAAA11: { label: 'Bio', ref: REF, created_at: '2026-10-19T08:00:00.000Z' } }
        );
        for (const v of [null, undefined, 'x', [], 5]) assert.deepEqual(readEntryLinkLabels(v), {});
    });

    it('joins Meta\'s list with the labels, in Meta\'s order, showing the owner\'s text without the ref', () => {
        const list = mergeEntryLinks(
            [qr('NEWEST000000001', `Hello #${REF}`, 'https://scontent.xx.fbcdn.net/n.png'), qr('OLDER0000000002', 'Plain message')],
            { NEWEST000000001: { label: 'Instagram bio', ref: REF, created_at: '2026-10-19T08:00:00.000Z' } }
        );

        assert.deepEqual(list[0], {
            id: 'NEWEST000000001', code: 'NEWEST000000001', label: 'Instagram bio', ref: REF, prefill: 'Hello', prefilled_message: `Hello #${REF}`,
            url: 'https://wa.me/message/NEWEST000000001', qr_image_url: 'https://scontent.xx.fbcdn.net/n.png',
            created_at: '2026-10-19T08:00:00.000Z', managed: true, conversations: null,
        });
        assert.equal(list[1]!.label, null);
        assert.equal(list[1]!.managed, false, 'a code made in WhatsApp Manager is listed, and says it was not made here');
        assert.equal(list[1]!.prefill, 'Plain message');
        assert.equal(list[1]!.ref, null);
    });

    it('reads the ref back from Meta\'s message when the label map has lost it (a disconnect resets settings)', () => {
        const view = entryLinkView(qr('LOST0000000001', `Hello #${REF}`));
        assert.equal(view.ref, REF);
        assert.equal(view.label, null);
        assert.equal(view.prefill, 'Hello');
    });

    it('does not show a label whose code Meta no longer lists: Meta is the source of truth', () => {
        const list = mergeEntryLinks([qr('KEPT0000000001', 'x')], { GONE0000000002: { label: 'Gone', ref: REF, created_at: '' } });
        assert.deepEqual(list.map((l) => l.code), ['KEPT0000000001']);
    });
});

describe('the label map in the database', () => {
    const originalQuery = pool.query;
    let statements: Array<{ sql: string; params: unknown[] }>;
    let answer: { rows: unknown[]; rowCount: number };

    beforeEach(() => {
        statements = [];
        answer = { rows: [], rowCount: 1 };
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            return answer;
        };
    });
    afterEach(() => { (pool as unknown as { query: unknown }).query = originalQuery; });

    const TENANT = '11111111-1111-4111-8111-111111111111';

    it('reads the one key of the live connection, and nothing else of `settings`', async () => {
        answer = { rows: [{ entry_links: { AAAAAA111111: { label: 'Bio', ref: REF, created_at: '2026-10-19T08:00:00.000Z' } } }], rowCount: 1 };

        const labels = await getEntryLinkLabels(TENANT);

        assert.deepEqual(Object.keys(labels), ['AAAAAA111111']);
        assert.equal(statements.length, 1);
        assert.match(statements[0]!.sql, /^SELECT settings -> 'entry_links' AS entry_links FROM platform_connections WHERE creator_id = \$1 AND platform = 'whatsapp' AND status <> 'revoked'$/);
        assert.deepEqual(statements[0]!.params, [TENANT]);
    });

    it('is {} for a tenant with no live connection', async () => {
        answer = { rows: [], rowCount: 0 };
        assert.deepEqual(await getEntryLinkLabels(TENANT), {});
    });

    it('writes ONE label as one atomic UPDATE of the entry_links key, scoped to the tenant\'s live row', async () => {
        const entry = { label: 'Instagram bio', ref: REF, created_at: '2026-10-19T08:00:00.000Z' };

        assert.equal(await putEntryLinkLabel(TENANT, 'AAAAAA111111', entry), true);

        const { sql, params } = statements[0]!;
        assert.equal(statements.length, 1, 'one statement: no read-modify-write of the whole settings object');
        assert.match(sql, /^UPDATE platform_connections SET settings = jsonb_set\( COALESCE\(settings, '\{\}'::jsonb\), '\{entry_links\}',/);
        assert.match(sql, /WHERE creator_id = \$1 AND platform = 'whatsapp' AND status <> 'revoked'$/);
        assert.deepEqual(params, [TENANT, JSON.stringify({ AAAAAA111111: entry })]);
        assert.ok(!sql.includes('Instagram bio') && !sql.includes('AAAAAA111111'), 'the label and the code are bound parameters, never SQL text');
    });

    it('is false when no live connection took the write', async () => {
        answer = { rows: [], rowCount: 0 };
        assert.equal(await putEntryLinkLabel(TENANT, 'AAAAAA111111', { label: 'x', ref: REF, created_at: '' }), false);
        assert.equal(await dropEntryLinkLabel(TENANT, 'AAAAAA111111'), false);
    });

    it('drops ONE label with the path operator, the code as a bound parameter', async () => {
        assert.equal(await dropEntryLinkLabel(TENANT, 'AAAAAA111111'), true);

        const { sql, params } = statements[0]!;
        assert.match(sql, /SET settings = COALESCE\(settings, '\{\}'::jsonb\) #- ARRAY\['entry_links', \$2::text\]/);
        assert.match(sql, /WHERE creator_id = \$1 AND platform = 'whatsapp' AND status <> 'revoked'$/);
        assert.deepEqual(params, [TENANT, 'AAAAAA111111']);
    });
});

describe('the words the dashboard must translate', () => {
    const codesIn = (file: string) => [...readFileSync(file, 'utf8').matchAll(/code: '([a-z][a-z_]*)'/g)].map((m) => m[1]!);

    it('ENTRY_POINT_ERROR_CODES is exactly the codes the entry points can send: none missing, none stale', () => {
        const sendable = new Set([
            ...Object.values(ENTRY_ERRORS),
            ...codesIn('src/services/whatsappEntryLinks.ts'),
            ...codesIn('src/services/whatsapp.ts'),
        ]);
        assert.deepEqual([...sendable].sort(), [...ENTRY_POINT_ERROR_CODES].sort());
    });
});
