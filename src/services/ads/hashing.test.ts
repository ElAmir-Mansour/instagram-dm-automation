/**
 * Customer-list hashing (spec 002, T149; research.md R15; research/02-policy-limits.md section 5.2).
 *
 * What is pinned:
 *   - every normaliser, with Egyptian and Saudi phone numbers and Arabic names;
 *   - SHA-256 as lowercase hex (one hard-coded digest, one computed with node:crypto);
 *   - batching: at most 10,000 per request, `batch_seq` from 1, only the last batch flagged;
 *   - opted-out people (by phone, by email) and countries outside the legal sign-off are dropped, duplicates collapse;
 *   - no raw value is persisted, logged or put in an error: the DB layer is stubbed, and no raw string may appear in any
 *     parameter sent to Meta, in any DB call, or in an error message.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import {
    buildUsersParams, CUSTOMER_COLUMNS, CustomerListError, DIAL_CODES, loadOptOutHashes, MAX_BATCH, MAX_TEXT_BYTES,
    newSessionId, normaliseCountry, normaliseEmail, normaliseName, normalisePhone, optOutHashesFromPhones, parseCustomerText,
    prepareCustomerList, sha256Hex, toBatches, countryOfPhone,
    type CustomerColumn, type PreparedList,
} from './hashing.js';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('constants', () => {
    it('limits and columns', () => {
        assert.equal(MAX_BATCH, 10_000);
        assert.equal(MAX_TEXT_BYTES, 3 * 1024 * 1024);
        assert.deepEqual([...CUSTOMER_COLUMNS], ['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY']);
    });
    it('dial codes cover the supported markets', () => {
        const want: Record<string, string> = {
            EG: '20', SA: '966', AE: '971', KW: '965', QA: '974', BH: '973', OM: '968', JO: '962', LB: '961', MA: '212', DZ: '213',
            TN: '216', LY: '218', SD: '249', IQ: '964', SY: '963', PS: '970', YE: '967', US: '1', GB: '44', DE: '49', FR: '33', TR: '90',
        };
        for (const [iso, code] of Object.entries(want)) assert.equal(DIAL_CODES[iso], code, iso);
    });
});

describe('normaliseEmail', () => {
    it('trims and lowercases', () => assert.equal(normaliseEmail('  Test@Example.COM \n'), 'test@example.com'));
    it('keeps plus tags and dots', () => assert.equal(normaliseEmail('A.B+tag@Mail.Co.UK'), 'a.b+tag@mail.co.uk'));
    it('rejects what does not look like x@y.z', () => {
        for (const bad of ['', '   ', 'plain', 'a@b', '@b.com', 'a@.com', 'a b@c.com', 'a@@b.com', 'a@b.', 'a@b..com']) {
            assert.equal(normaliseEmail(bad), null, JSON.stringify(bad));
        }
    });
});

describe('normalisePhone', () => {
    it('Egypt: national 0-prefixed number + EG', () => assert.equal(normalisePhone('01012345678', 'EG'), '201012345678'));
    it('KSA: national 0-prefixed number + SA', () => assert.equal(normalisePhone('0501234567', 'SA'), '966501234567'));
    it('strips +, spaces, dashes, parentheses and dots', () => {
        assert.equal(normalisePhone('+20 (101) 234-5678', 'EG'), '201012345678');
        assert.equal(normalisePhone('+966.50.123.4567', null), '966501234567');
    });
    it('a leading 00 is an international prefix', () => {
        assert.equal(normalisePhone('0020 101 234 5678', 'EG'), '201012345678');
        assert.equal(normalisePhone('00966501234567'), '966501234567');
    });
    it('keeps a number that already starts with a known dial code', () => {
        assert.equal(normalisePhone('201012345678', 'EG'), '201012345678');
        assert.equal(normalisePhone('966501234567', 'SA'), '966501234567');
        assert.equal(normalisePhone('971501234567', 'EG'), '971501234567');
        assert.equal(normalisePhone('201012345678'), '201012345678');
    });
    it('national number without the trunk zero gets the default dial code', () => {
        assert.equal(normalisePhone('1012345678', 'EG'), '201012345678');
        assert.equal(normalisePhone('501234567', 'SA'), '966501234567');
    });
    it('an explicit + wins over the default country', () => assert.equal(normalisePhone('+44 7911 123456', 'EG'), '447911123456'));
    it('E.164 digits of any country are kept without a default country (opt-out phones)', () => {
        assert.equal(normalisePhone('919876543210'), '919876543210');
    });
    it('Arabic-Indic and Persian digits', () => {
        assert.equal(normalisePhone('٠١٠١٢٣٤٥٦٧٨', 'EG'), '201012345678');
        assert.equal(normalisePhone('۰۵۰۱۲۳۴۵۶۷', 'SA'), '966501234567');
    });
    it('drops the stray trunk zero after the dial code (+20 0101...)', () => assert.equal(normalisePhone('+2001012345678', 'EG'), '201012345678'));
    it('never a leading zero, always 8 to 15 digits', () => {
        assert.equal(normalisePhone('01012345678'), null);          // national, no country to complete it
        assert.equal(normalisePhone('+0123456789'), null);
        assert.equal(normalisePhone('00'), null);
        assert.equal(normalisePhone('1234567'), null);              // 7 digits
        assert.equal(normalisePhone('12345678'), '12345678');       // 8 digits
        assert.equal(normalisePhone('123456789012345'), '123456789012345');   // 15
        assert.equal(normalisePhone('1234567890123456'), null);     // 16
    });
    it('rejects letters, empty input and spreadsheet scientific notation', () => {
        for (const bad of ['', '   ', 'abc', '0101234 ext 5', '2.01012E+11', 'n/a']) assert.equal(normalisePhone(bad, 'EG'), null, bad);
    });
});

describe('normaliseName', () => {
    it('lowercases and strips punctuation', () => {
        assert.equal(normaliseName('John'), 'john');
        assert.equal(normaliseName("  O'Brien-Smith. "), 'obriensmith');
    });
    it('strips digits and collapses spaces', () => assert.equal(normaliseName('Anne   Marie 2'), 'anne marie'));
    it('keeps letters of any script, Arabic included', () => {
        assert.equal(normaliseName('محمد'), 'محمد');
        assert.equal(normaliseName('أحمد'), 'أحمد');
        assert.equal(normaliseName('  عبد الله! '), 'عبد الله');
        assert.equal(normaliseName('JOSÉ'), 'josé');
    });
    it('drops Arabic diacritics and tatweel so a vowelled spelling matches the plain one', () => {
        assert.equal(normaliseName('مُحَمَّد'), 'محمد');
        assert.equal(normaliseName('مـحـمد'), 'محمد');
    });
    it('empty or letter-less input is null', () => {
        for (const bad of ['', '   ', '123', '...', '-']) assert.equal(normaliseName(bad), null, bad);
    });
});

describe('normaliseCountry', () => {
    it('ISO-2 in any case', () => {
        for (const v of ['EG', 'eg', ' Eg ']) assert.equal(normaliseCountry(v), 'eg');
        assert.equal(normaliseCountry('SA'), 'sa');
    });
    it('common names and aliases, English and Arabic', () => {
        assert.equal(normaliseCountry('Egypt'), 'eg');
        assert.equal(normaliseCountry('مصر'), 'eg');
        assert.equal(normaliseCountry('Saudi Arabia'), 'sa');
        assert.equal(normaliseCountry('السعودية'), 'sa');
        assert.equal(normaliseCountry('المملكة العربية السعودية'), 'sa');
        assert.equal(normaliseCountry('KSA'), 'sa');
        assert.equal(normaliseCountry('UAE'), 'ae');
        assert.equal(normaliseCountry('الإمارات'), 'ae');
        assert.equal(normaliseCountry('United Kingdom'), 'gb');
        assert.equal(normaliseCountry('UK'), 'gb');
    });
    it('unknown is null', () => {
        for (const bad of ['', ' ', 'Atlantis', 'e', 'egy', '12']) assert.equal(normaliseCountry(bad), null, bad);
    });
});

describe('countryOfPhone', () => {
    it('maps by dial code', () => {
        assert.equal(countryOfPhone('201012345678'), 'EG');
        assert.equal(countryOfPhone('966501234567'), 'SA');
        assert.equal(countryOfPhone('971501234567'), 'AE');
        assert.equal(countryOfPhone('14155552671'), 'US');
        assert.equal(countryOfPhone('447911123456'), 'GB');
    });
    it('unknown prefix is null', () => assert.equal(countryOfPhone('999912345678'), null));
});

describe('sha256Hex', () => {
    it('known digest', () => assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
    it('matches node:crypto, lowercase hex of 64 chars', () => {
        const h = sha256Hex('test@example.com');
        assert.equal(h, sha('test@example.com'));
        assert.match(h, /^[0-9a-f]{64}$/);
    });
    it('hashes UTF-8 (Arabic)', () => assert.equal(sha256Hex('محمد'), sha('محمد')));
});

describe('parseCustomerText', () => {
    it('header row with comma, columns in file order', () => {
        const r = parseCustomerText('email,phone\na@b.com,0101\nc@d.com,0102', 'auto');
        assert.deepEqual(r.columns, ['EMAIL', 'PHONE']);
        assert.deepEqual(r.rows, [['a@b.com', '0101'], ['c@d.com', '0102']]);
    });
    it('semicolon and tab delimiters', () => {
        assert.deepEqual(parseCustomerText('E-mail;Mobile\na@b.com;0101', 'auto').rows, [['a@b.com', '0101']]);
        const t = parseCustomerText('phone\temail\n0101\ta@b.com', 'auto');
        assert.deepEqual(t.columns, ['PHONE', 'EMAIL']);
        assert.deepEqual(t.rows, [['0101', 'a@b.com']]);
    });
    it('Arabic headers', () => {
        const r = parseCustomerText('البريد الإلكتروني;رقم الجوال;الاسم الأول;اسم العائلة;الدولة\na@b.com;0101;محمد;علي;مصر', 'auto');
        assert.deepEqual(r.columns, ['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY']);
        assert.deepEqual(r.rows, [['a@b.com', '0101', 'محمد', 'علي', 'مصر']]);
    });
    it('English header synonyms', () => {
        const r = parseCustomerText('First Name,Last_Name,WhatsApp,Country\nA,B,0101,EG', 'auto');
        assert.deepEqual(r.columns, ['FN', 'LN', 'PHONE', 'COUNTRY']);
    });
    it('unknown columns are dropped, the data of the others kept', () => {
        const r = parseCustomerText('id,email,notes\n1,a@b.com,vip', 'auto');
        assert.deepEqual(r.columns, ['EMAIL']);
        assert.deepEqual(r.rows, [['a@b.com']]);
    });
    it('quoted fields, doubled quotes, delimiters and newlines inside quotes', () => {
        const r = parseCustomerText('email,fn\n"a@b.com","Smith, ""JJ"""\n"c@d.com","two\nlines"', 'auto');
        assert.deepEqual(r.rows, [['a@b.com', 'Smith, "JJ"'], ['c@d.com', 'two\nlines']]);
    });
    it('one value per line, emails', () => {
        const r = parseCustomerText('a@b.com\n\nc@d.com\r\n  \ne@f.com\n', 'auto');
        assert.deepEqual(r.columns, ['EMAIL']);
        assert.deepEqual(r.rows, [['a@b.com'], ['c@d.com'], ['e@f.com']]);
    });
    it('one value per line, phones', () => {
        const r = parseCustomerText('01012345678\n+966 50 123 4567\n(20) 101 234 5678', 'auto');
        assert.deepEqual(r.columns, ['PHONE']);
        assert.equal(r.rows.length, 3);
    });
    it('no header: columns detected from the data', () => {
        const r = parseCustomerText('a@b.com,01012345678,EG\nc@d.com,01112345678,SA', 'auto');
        assert.deepEqual(r.columns, ['EMAIL', 'PHONE', 'COUNTRY']);
        assert.equal(r.rows.length, 2);
    });
    it('strips a BOM and handles CRLF', () => {
        const r = parseCustomerText('﻿email\r\na@b.com\r\n', 'auto');
        assert.deepEqual(r.columns, ['EMAIL']);
        assert.deepEqual(r.rows, [['a@b.com']]);
    });
    it('explicit columns: no detection, short rows are padded, a header row is skipped', () => {
        const r = parseCustomerText('a@b.com,Ali\nc@d.com', ['EMAIL', 'FN']);
        assert.deepEqual(r.columns, ['EMAIL', 'FN']);
        assert.deepEqual(r.rows, [['a@b.com', 'Ali'], ['c@d.com', '']]);
        const h = parseCustomerText('email,first name\na@b.com,Ali', ['EMAIL', 'FN']);
        assert.deepEqual(h.rows, [['a@b.com', 'Ali']]);
    });
    it('typed errors, with the field', () => {
        for (const [text, cols, field] of [
            ['a'.repeat(MAX_TEXT_BYTES + 1), 'auto', 'text'],
            ['', 'auto', 'text'],
            ['   \n\n', 'auto', 'text'],
            ['FN\nJohn', 'auto', 'columns'],
            ['Smith\nJones', 'auto', 'columns'],
            ['John', ['FN'], 'columns'],
            ['a@b.com', ['EMAIL', 'EMAIL'], 'columns'],
        ] as Array<[string, CustomerColumn[] | 'auto', string]>) {
            try {
                parseCustomerText(text, cols);
                assert.fail(`expected a throw for ${field}`);
            } catch (e) {
                assert.ok(e instanceof CustomerListError, 'typed');
                assert.equal((e as CustomerListError).code, 'INVALID');
                assert.equal((e as CustomerListError).field, field);
            }
        }
    });
    it('the byte limit counts bytes, not characters', () => {
        // 2 bytes per Arabic letter: 1.6M letters is over 3 MB although it is under 3M characters
        assert.throws(() => parseCustomerText('م'.repeat(Math.floor(MAX_TEXT_BYTES / 2) + 1), 'auto'), CustomerListError);
    });
});

const PHONE_OPTS = { optOutHashes: new Set<string>(), allowedCountries: ['EG', 'SA'], defaultCountry: 'EG' };
const parsed = (columns: CustomerColumn[], rows: string[][]) => ({ columns, rows });

describe('prepareCustomerList', () => {
    it('normalises then hashes every cell, adds COUNTRY, keeps order', () => {
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE', 'FN'], [[' A@B.com ', '01012345678', 'محمد']]), PHONE_OPTS);
        assert.deepEqual(p.schema, ['EMAIL', 'PHONE', 'FN', 'COUNTRY']);
        assert.deepEqual(p.hashedRows, [[sha('a@b.com'), sha('201012345678'), sha('محمد'), sha('eg')]]);
        assert.equal(p.rowsAccepted, 1);
        assert.equal(p.rowsInvalid + p.rowsExcludedOptOut + p.rowsExcludedCountry + p.rowsDuplicate, 0);
    });
    it('an empty or invalid optional cell is sent as an empty string', () => {
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE', 'LN'], [['a@b.com', 'garbage', '']]), PHONE_OPTS);
        assert.deepEqual(p.hashedRows, [[sha('a@b.com'), '', '', sha('eg')]]);
    });
    it('a row with no valid email and no valid phone is invalid', () => {
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE'], [['nope', '12'], ['', ''], ['a@b.com', '']]), PHONE_OPTS);
        assert.equal(p.rowsInvalid, 2);
        assert.equal(p.rowsAccepted, 1);
    });
    it('country: the COUNTRY cell, else the phone, else the default; outside the sign-off is excluded', () => {
        const rows = [
            ['01012345678', 'Egypt'],     // cell: eg
            ['966501234567', ''],         // phone: SA
            ['01012345678', 'DE'],        // cell says DE: excluded although the phone is Egyptian
            ['a@b.com', ''],               // email only: default EG
            ['971501234567', ''],         // phone: AE, not allowed
        ];
        const p = prepareCustomerList(parsed(['PHONE', 'COUNTRY'], rows), PHONE_OPTS);
        assert.equal(p.rowsAccepted, 2);
        assert.equal(p.rowsExcludedCountry, 2);
        assert.equal(p.rowsInvalid, 1);   // the email-only row has no phone column value: no valid phone, no EMAIL column
        assert.deepEqual(p.schema, ['PHONE', 'COUNTRY']);
        assert.deepEqual(p.hashedRows.map(r => r[1]), [sha('eg'), sha('sa')]);
    });
    it('an empty COUNTRY cell is filled with the derived country', () => {
        const p = prepareCustomerList(parsed(['PHONE', 'COUNTRY'], [['0501234567', '']]), { ...PHONE_OPTS, defaultCountry: 'SA' });
        assert.deepEqual(p.hashedRows, [[sha('966501234567'), sha('sa')]]);
    });
    it('unknown country (no cell, no phone prefix, no default) is excluded', () => {
        const p = prepareCustomerList(parsed(['EMAIL'], [['a@b.com']]), { optOutHashes: new Set(), allowedCountries: ['EG'], defaultCountry: null });
        assert.equal(p.rowsExcludedCountry, 1);
        assert.equal(p.rowsAccepted, 0);
        assert.deepEqual(p.hashedRows, []);
    });
    it('no allowed countries means nothing is uploaded', () => {
        const p = prepareCustomerList(parsed(['EMAIL'], [['a@b.com']]), { ...PHONE_OPTS, allowedCountries: [] });
        assert.equal(p.rowsExcludedCountry, 1);
    });
    it('opted-out by phone', () => {
        const optOut = optOutHashesFromPhones(['201012345678']);
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE'], [['a@b.com', '01012345678'], ['c@d.com', '01112345678']]), { ...PHONE_OPTS, optOutHashes: optOut });
        assert.equal(p.rowsExcludedOptOut, 1);
        assert.equal(p.rowsAccepted, 1);
        assert.equal(p.hashedRows[0]![0], sha('c@d.com'));
    });
    it('opted-out by email, even when the row also has a phone that is not opted out', () => {
        const optOut = new Set([sha('gone@x.com')]);
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE'], [['  Gone@X.com', '01012345678'], ['stay@x.com', '01112345678']]), { ...PHONE_OPTS, optOutHashes: optOut });
        assert.equal(p.rowsExcludedOptOut, 1);
        assert.equal(p.rowsAccepted, 1);
    });
    it('duplicates collapse after normalisation', () => {
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE'], [['A@b.com', '01012345678'], [' a@b.com', '+20 101 234 5678'], ['c@d.com', '']]), PHONE_OPTS);
        assert.equal(p.rowsAccepted, 2);
        assert.equal(p.rowsDuplicate, 1);
    });
    it('the counts add up to the rows given', () => {
        const rows = [['a@b.com', ''], ['bad', ''], ['a@b.com', ''], ['x@y.com', 'DE'], ['z@y.com', 'EG']];
        const p = prepareCustomerList(parsed(['EMAIL', 'COUNTRY'], rows), { ...PHONE_OPTS, optOutHashes: new Set([sha('z@y.com')]) });
        assert.equal(p.rowsAccepted + p.rowsInvalid + p.rowsExcludedOptOut + p.rowsExcludedCountry + p.rowsDuplicate, rows.length);
    });
    it('does not mutate the raw rows', () => {
        const rows = [[' A@B.com ', '01012345678']];
        const before = JSON.stringify(rows);
        prepareCustomerList(parsed(['EMAIL', 'PHONE'], rows), PHONE_OPTS);
        assert.equal(JSON.stringify(rows), before);
    });
    it('the result holds hashes only', () => {
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE', 'FN', 'LN'], [['a@b.com', '01012345678', 'Ali', 'Hassan']]), PHONE_OPTS);
        for (const cell of p.hashedRows.flat()) assert.match(cell, /^(|[0-9a-f]{64})$/);
    });
});

describe('batching', () => {
    const list = (n: number): PreparedList => ({
        schema: ['EMAIL'], hashedRows: Array.from({ length: n }, (_, i) => [sha(`u${i}@x.com`)]),
        rowsAccepted: n, rowsInvalid: 0, rowsExcludedOptOut: 0, rowsExcludedCountry: 0, rowsDuplicate: 0,
    });
    it('25,001 rows make three batches of 10,000, 10,000 and 5,001', () => {
        const b = toBatches(list(25_001), 7);
        assert.deepEqual(b.map(x => x.data.length), [10_000, 10_000, 5_001]);
        assert.deepEqual(b.map(x => x.batchSeq), [1, 2, 3]);
        assert.deepEqual(b.map(x => x.lastBatch), [false, false, true]);
        assert.ok(b.every(x => x.sessionId === 7));
        assert.deepEqual(b[0]!.schema, ['EMAIL']);
        assert.equal(b.flatMap(x => x.data).length, 25_001);
    });
    it('exactly one full batch is the last batch', () => {
        const b = toBatches(list(10_000), 1);
        assert.equal(b.length, 1);
        assert.equal(b[0]!.lastBatch, true);
    });
    it('an empty list has no batches', () => assert.deepEqual(toBatches(list(0), 1), []));
    it('a custom size, never above the maximum', () => {
        assert.equal(toBatches(list(10), 1, 4).length, 3);
        assert.equal(toBatches(list(10_001), 1, 50_000).length, 2);
        assert.equal(toBatches(list(3), 1, 0).length, 3);   // a nonsense size falls back to a size of 1, it does not loop or throw
    });
    it('session ids are positive safe integers and differ', () => {
        const ids = new Set(Array.from({ length: 50 }, () => newSessionId()));
        assert.ok(ids.size > 45);
        for (const id of ids) assert.ok(Number.isSafeInteger(id) && id > 0);
    });
    it('buildUsersParams: payload and session as Meta wants them', () => {
        const [b] = toBatches(list(2), 4242);
        const params = buildUsersParams(b!, 2);
        assert.deepEqual(Object.keys(params).sort(), ['payload', 'session']);
        assert.deepEqual(JSON.parse(params.payload!), { schema: ['EMAIL'], data: b!.data });
        assert.deepEqual(JSON.parse(params.session!), { session_id: 4242, batch_seq: 1, last_batch_flag: true, estimated_num_total: 2 });
        for (const v of Object.values(params)) assert.equal(typeof v, 'string');
    });
    it('a single-column schema is still an array', () => {
        const [b] = toBatches(list(1), 1);
        assert.ok(Array.isArray(JSON.parse(buildUsersParams(b!, 1).payload!).schema));
    });
});

describe('optOutHashesFromPhones', () => {
    it('normalises (no default country), hashes, skips invalid', () => {
        const s = optOutHashesFromPhones(['+201012345678', '966501234567', 'junk', '', '0123']);
        assert.deepEqual([...s].sort(), [sha('201012345678'), sha('966501234567')].sort());
    });
});

// ─── loadOptOutHashes against a stubbed pool ────────────────────────────────────────────────

type Call = { sql: string; params: unknown[] };
const originalQuery = pool.query;
let calls: Call[] = [];
let answer: (call: Call) => Array<Record<string, unknown>> = () => [];

beforeEach(() => {
    calls = [];
    answer = () => [];
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const call = { sql, params };
        calls.push(call);
        return { rows: answer(call), rowCount: 0 };
    };
});
afterEach(() => { (pool as unknown as { query: unknown }).query = originalQuery; });

describe('loadOptOutHashes', () => {
    it('hashes the phones, passes valid hashes through, ignores junk, binds the tenant', async () => {
        const emailHash = sha('never@x.com');
        answer = () => [
            { kind: 'phone', value: '201012345678' },
            { kind: 'phone', value: '+966 50 123 4567' },
            { kind: 'phone', value: 'not a phone' },
            { kind: 'hash', value: emailHash },
            { kind: 'hash', value: emailHash.toUpperCase() },
            { kind: 'hash', value: 'not-a-hash' },
            { kind: 'hash', value: 'abc' },
        ];
        const set = await loadOptOutHashes('tenant-1');
        assert.deepEqual([...set].sort(), [sha('201012345678'), sha('966501234567'), emailHash].sort());
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]!.params, ['tenant-1']);
    });
    it('the statement: the three sources, scoped to the tenant, only the columns it needs', () => {
        return loadOptOutHashes('t').then(() => {
            const sql = calls[0]!.sql;
            assert.ok(!/select\s+\*/i.test(sql), 'no SELECT *');
            assert.ok(!/\bc\.\*|\bcc\.\*/.test(sql));
            assert.match(sql, /conversations/);
            assert.match(sql, /opted_out_at IS NOT NULL/);
            assert.match(sql, /wa_phone/);
            assert.match(sql, /contact_consents/);
            assert.match(sql, /'marketing'/);
            assert.match(sql, /'withdrawn'/);
            assert.match(sql, /ORDER BY[^)]*created_at DESC/i);
            assert.match(sql, /'customer_list_optout'/);
            assert.match(sql, /contact_ref/);
            assert.ok((sql.match(/creator_id = \$1/g) ?? []).length >= 3, 'every branch is scoped to the tenant');
            assert.ok(!/\binsert\b|\bupdate\b|\bdelete\b/i.test(sql), 'reads only');
        });
    });
    it('nothing opted out is an empty set', async () => assert.equal((await loadOptOutHashes('t')).size, 0));
});

// ─── no raw value is persisted, logged or put in an error ───────────────────────────────────

describe('no raw value is persisted', () => {
    const RAW_EMAILS = ['Sara.Hassan@Example.com', 'khaled.private@mail.example.org', 'optout.person@example.net'];
    const RAW_PHONES = ['01012345678', '+966 50 123 4567', '01198765432', '0551234567'];
    const RAW_NAMES = ['Sara', 'خالد', 'Hassan', 'الحسيني'];
    const rawStrings = [...RAW_EMAILS, ...RAW_PHONES, ...RAW_NAMES, ...RAW_EMAILS.map(e => e.toLowerCase()), '201012345678', '966501234567'];

    it('the pipeline touches the database only to read opt-outs, and nothing raw leaves it or reaches a request to Meta', async () => {
        const logged: string[] = [];
        const origLog = console.log, origErr = console.error, origWarn = console.warn, origInfo = console.info;
        for (const k of ['log', 'error', 'warn', 'info'] as const) (console as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
        try {
            answer = () => [{ kind: 'phone', value: '201198765432' }];
            const optOut = await loadOptOutHashes('tenant-9');
            const text = [
                'email,phone,first name,last name',
                `${RAW_EMAILS[0]},${RAW_PHONES[0]},${RAW_NAMES[0]},${RAW_NAMES[2]}`,
                `${RAW_EMAILS[1]},"${RAW_PHONES[1]}",${RAW_NAMES[1]},${RAW_NAMES[3]}`,
                `${RAW_EMAILS[2]},${RAW_PHONES[2]},,`,           // opted out by phone
                `no-phone@example.com,${RAW_PHONES[3]},,`,
            ].join('\n');
            const list = prepareCustomerList(parseCustomerText(text, 'auto'), { optOutHashes: optOut, allowedCountries: ['EG', 'SA'], defaultCountry: 'EG' });
            assert.equal(list.rowsExcludedOptOut, 1);
            assert.equal(list.rowsAccepted, 3);
            const batches = toBatches(list, newSessionId());
            const params = batches.map(b => buildUsersParams(b, list.rowsAccepted));

            const everything = JSON.stringify({ params, batches, list, calls, logged });
            for (const raw of rawStrings) {
                assert.ok(!everything.includes(raw), `raw value leaked: ${raw.length} chars`);
                assert.ok(!everything.toLowerCase().includes(raw.toLowerCase()), `raw value leaked (case-insensitive): ${raw.length} chars`);
            }
            // the only database traffic is the one read, and it carries the tenant id and nothing else
            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0]!.params, ['tenant-9']);
            assert.ok(/^\s*(select|with)\b/i.test(calls[0]!.sql));
            // what Meta gets: 64-hex cells or empty strings, nothing else
            for (const p of params) for (const row of JSON.parse(p.payload!).data as string[][]) for (const cell of row) assert.match(cell, /^(|[0-9a-f]{64})$/);
        } finally {
            Object.assign(console, { log: origLog, error: origErr, warn: origWarn, info: origInfo });
        }
    });

    it('CustomerListError messages contain no row content', () => {
        const secretText = 'Secret Person\nAnother Secret\nsecret.person@x\n12';
        const cases: Array<() => unknown> = [
            () => parseCustomerText(secretText, 'auto'),
            () => parseCustomerText(`${'secret.person@example.com\n'.repeat(200_000)}`, 'auto'),
            () => parseCustomerText('Secret Person', ['FN']),
            () => parseCustomerText('secret.person@example.com,secret.person@example.com', ['EMAIL', 'EMAIL']),
            () => parseCustomerText(`secret.person@example.com${'x'.repeat(MAX_TEXT_BYTES)}`, 'auto'),
            () => parseCustomerText('  \n ', 'auto'),
        ];
        let threw = 0;
        for (const run of cases) {
            try { run(); } catch (e) {
                threw++;
                assert.ok(e instanceof CustomerListError);
                const blob = `${(e as Error).message} ${(e as Error).stack?.split('\n')[0] ?? ''} ${JSON.stringify(e)}`.toLowerCase();
                for (const bit of ['secret', 'person', 'example.com', '@x']) assert.ok(!blob.includes(bit), `error leaks "${bit}"`);
            }
        }
        assert.ok(threw >= 5, 'the cases do throw');
    });

    it('prepareCustomerList never throws on hostile cells and never echoes them', () => {
        const hostile = ['\u0000', 'a'.repeat(100_000), '<script>', '💥', '%s%s'];
        const p = prepareCustomerList(parsed(['EMAIL', 'PHONE', 'FN'], hostile.map(h => [h, h, h])), PHONE_OPTS);
        assert.equal(p.rowsAccepted, 0);
        assert.equal(p.rowsInvalid, hostile.length);
        assert.ok(!JSON.stringify(p).includes('script'));
    });
});
