/**
 * What a draft is made from, and what makes two drafts the same (P24). The rule being tested is the money one: a tenant who retypes what
 * they typed must not start (and pay for) a second draft, and one who changes it must.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROFILE_DRAFT_V1 } from './draftPrompt.js';
import { canonicalYouTube, cleanAbout, hasAnyInput, inputsHash, MAX_ABOUT_CHARS, readDraftInputs, type DraftInputs } from './draftInputs.js';

const read = (body: unknown, fallback = {}, via: 'discovery' | 'own_token' = 'discovery') => {
    const r = readDraftInputs(body, fallback, via);
    assert.ok(r.ok, r.ok ? '' : r.error);
    return r.value;
};

describe('readDraftInputs: one canonical shape', () => {
    it('reads each field from the body, under either of its names', () => {
        const a = read({ instagram: '@Noor.Perfumes', website: 'noor-perfumes.example', youtube: '@NoorTV', about: ' متجر نور ' });
        const b = read({ instagram_username: 'instagram.com/noor.perfumes/', website_url: 'https://noor-perfumes.example/', youtube: 'https://www.youtube.com/@NoorTV', about_text: 'متجر نور' });
        assert.deepEqual(a, { instagram: 'noor.perfumes', website: 'https://noor-perfumes.example/', youtube: '@NoorTV', about: 'متجر نور', via: 'discovery' });
        assert.deepEqual(b, a);
    });

    it('what the body does not mention comes from the tenant\'s row; what it names, even as null or "", wins', () => {
        const fallback = { instagram: 'row.handle', website: 'https://row.example/' };
        assert.deepEqual(read({}, fallback), { instagram: 'row.handle', website: 'https://row.example/', youtube: null, about: null, via: 'discovery' });
        assert.deepEqual(read({ instagram: 'typed' }, fallback).instagram, 'typed');
        assert.deepEqual(read({ website: null }, fallback).website, null, 'null clears the row\'s site');
        assert.deepEqual(read({ instagram: '  ' }, fallback).instagram, null, 'blank clears it too');
        assert.deepEqual(read(undefined, fallback).instagram, 'row.handle');
        assert.deepEqual(read('not an object', fallback).instagram, 'row.handle', 'a body that is not an object says nothing');
        assert.deepEqual(read([1, 2], fallback).instagram, 'row.handle');
    });

    it('carries the road Instagram is read by', () => {
        assert.equal(read({ instagram: 'a' }, {}, 'own_token').via, 'own_token');
    });

    it('refuses what cannot be what its field says, naming the field', () => {
        const cases: Array<[unknown, string]> = [
            [{ instagram: 'two words' }, 'instagram'],
            [{ instagram: 'x){id}' }, 'instagram'],
            [{ instagram: 'instagram.com/p/ABC123/' }, 'instagram'],
            [{ website: 'ftp://example.com' }, 'website'],
            [{ website: 'http://localhost' }, 'website'],
            [{ website: 'http://10.0.0.1/' }, 'website'],
            [{ website: 'https://user:pass@example.com' }, 'website'],
            [{ youtube: 'not a channel!' }, 'youtube'],
            [{ youtube: 'https://example.com/@x' }, 'youtube'],
            [{ about: 42 }, 'about'],
            [{ about: 'x'.repeat(MAX_ABOUT_CHARS + 1) }, 'about'],
        ];
        for (const [body, field] of cases) {
            const r = readDraftInputs(body);
            assert.equal(r.ok, false, JSON.stringify(body).slice(0, 80));
            if (!r.ok) assert.equal(r.field, field);
        }
    });

    it('the about text loses invisible characters and extra blank lines, and nothing else', () => {
        assert.equal(cleanAbout('  hello​   world \n\n\n\n second‮ line  '), 'hello world\n\nsecond line');
        assert.equal(cleanAbout('​ \n '), null);
        assert.equal(read({ about: 'a\u0000b' }).about, 'ab');
    });

    it('YouTube is one string that reads back to the same channel', () => {
        assert.equal(canonicalYouTube('@Noor'), '@Noor');
        assert.equal(canonicalYouTube('youtube.com/@Noor'), '@Noor');
        assert.equal(canonicalYouTube('UCabcdefghijklmnopqrstuv'), 'UCabcdefghijklmnopqrstuv');
        assert.equal(canonicalYouTube('https://www.youtube.com/user/oldname'), 'youtube.com/user/oldname');
        assert.equal(canonicalYouTube('???'), null);
    });

    it('whether there is anything to read', () => {
        assert.equal(hasAnyInput(read({})), false);
        for (const body of [{ instagram: 'a' }, { website: 'a.example' }, { youtube: '@abc' }, { about: 'text' }]) assert.equal(hasAnyInput(read(body)), true);
    });
});

describe('inputsHash: what makes two drafts the same', () => {
    const base: DraftInputs = { instagram: 'noor.perfumes', website: 'https://noor-perfumes.example/', youtube: null, about: null, via: 'discovery' };

    it('is a sha256, the same for the same inputs however they were typed', () => {
        const h = inputsHash(base, PROFILE_DRAFT_V1);
        assert.match(h, /^[a-f0-9]{64}$/);
        assert.equal(inputsHash(read({ instagram: '@Noor.Perfumes', website: 'noor-perfumes.example' }), PROFILE_DRAFT_V1), h);
        assert.equal(inputsHash({ ...base }, PROFILE_DRAFT_V1), h);
    });

    it('changes when any input changes', () => {
        const h = inputsHash(base, PROFILE_DRAFT_V1);
        const others: Partial<DraftInputs>[] = [{ instagram: 'other' }, { website: 'https://noor-perfumes.example/shop' }, { youtube: '@noor' }, { about: 'a' }, { via: 'own_token' }, { instagram: null }];
        for (const change of others) assert.notEqual(inputsHash({ ...base, ...change }, PROFILE_DRAFT_V1), h, JSON.stringify(change));
    });

    it('changes with the prompt version: a new prompt makes every older draft stale, not reusable', () => {
        assert.notEqual(inputsHash(base, PROFILE_DRAFT_V1), inputsHash(base, 'profile_draft_v2'));
    });

    it('does not mix up two fields that hold the same text', () => {
        assert.notEqual(inputsHash({ ...base, instagram: 'abc', youtube: null }, 'v'), inputsHash({ ...base, instagram: null, youtube: 'abc' }, 'v'));
    });
});
