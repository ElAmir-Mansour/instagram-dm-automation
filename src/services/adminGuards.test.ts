/**
 * The refusals, in the cases that matter.
 *
 * The lockout guard is the one rule in the admin surface whose failure has no in-product
 * recovery: demote the last active platform admin and the only way back in is an UPDATE in
 * the Supabase SQL editor. So every combination of role, active flag and admin count is
 * exercised here rather than reasoned about.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isPageId, isUserRole, lockoutRefusal, LOCKOUT_CODE, MIN_PASSWORD_LENGTH, passwordProblem,
    readInstagramUsername, readNamedTenant, readPageIdField, readVerifyTokenField, readWebsiteUrl,
} from './adminGuards.js';

const lastAdmin = { id: 'a', role: 'platform_admin', is_active: true };

describe('lockoutRefusal', () => {
    it('refuses to demote the last active platform admin', () => {
        const refusal = lockoutRefusal(lastAdmin, { role: 'user' }, 0);

        assert.ok(refusal);
        assert.equal(refusal.code, LOCKOUT_CODE);
        assert.match(refusal.error, /demote/);
        // The message has to say what to do instead, or it is just a wall.
        assert.match(refusal.error, /platform admin first/);
    });

    it('refuses to deactivate the last active platform admin', () => {
        const refusal = lockoutRefusal(lastAdmin, { is_active: false }, 0);

        assert.ok(refusal);
        assert.match(refusal.error, /deactivate/);
    });

    it('names both when a patch does both at once', () => {
        const refusal = lockoutRefusal(lastAdmin, { role: 'user', is_active: false }, 0);

        assert.ok(refusal);
        assert.match(refusal.error, /demote and deactivate/);
    });

    it('allows it when another active admin exists', () => {
        assert.equal(lockoutRefusal(lastAdmin, { role: 'user' }, 1), null);
        assert.equal(lockoutRefusal(lastAdmin, { is_active: false }, 3), null);
    });

    it('allows a patch that changes neither the role nor the active flag', () => {
        // Setting role to the value it already holds is not a demotion.
        assert.equal(lockoutRefusal(lastAdmin, { role: 'platform_admin' }, 0), null);
        assert.equal(lockoutRefusal(lastAdmin, { is_active: true }, 0), null);
        assert.equal(lockoutRefusal(lastAdmin, {}, 0), null);
    });

    it('does not fire for a target who is not an active platform admin', () => {
        // An already-inactive admin is not holding the door open, so there is nothing to lose.
        const inactive = { id: 'a', role: 'platform_admin', is_active: false };
        assert.equal(lockoutRefusal(inactive, { role: 'user' }, 0), null);

        const ordinary = { id: 'b', role: 'user', is_active: true };
        assert.equal(lockoutRefusal(ordinary, { role: 'user', is_active: false }, 0), null);
    });
});

describe('isUserRole', () => {
    it('accepts exactly the two roles the schema means', () => {
        assert.equal(isUserRole('user'), true);
        assert.equal(isUserRole('platform_admin'), true);
    });

    it('rejects anything else, including near-misses', () => {
        for (const value of ['admin', 'owner', 'Platform_Admin', '', null, undefined, 42, {}]) {
            assert.equal(isUserRole(value), false, `input ${JSON.stringify(value)}`);
        }
    });
});

describe('isPageId', () => {
    it('accepts a Meta page id', () => {
        assert.equal(isPageId('17841400000000000'), true);   // IG business account id
        assert.equal(isPageId('102938475601234'), true);     // FB page id
    });

    it('rejects the pastes people actually make', () => {
        for (const value of [
            'https://instagram.com/someone',
            '@someone',
            '17841400000000000\n',   // trailing newline from a copy
            '1784 1400',             // space in the middle
            '17841400000000000a',
            '12',                    // too short to be anything real
            '',
            null,
            17841400000000000,       // a number, not a string — JSON would lose precision
        ]) {
            assert.equal(isPageId(value), false, `input ${JSON.stringify(value)}`);
        }
    });
});

describe('readPageIdField', () => {
    it('reports an absent field as absent, not as a clear', () => {
        // The distinction is the whole reason this exists: the old COALESCE form could not
        // tell "leave it alone" from "set it to null", so a facebook_page_id could never be
        // unset once set.
        assert.deepEqual(readPageIdField(undefined, 'facebook_page_id', true), { kind: 'absent' });
    });

    it('treats null and empty string as an explicit clear when the column is nullable', () => {
        assert.deepEqual(readPageIdField(null, 'facebook_page_id', true), { kind: 'clear' });
        assert.deepEqual(readPageIdField('', 'facebook_page_id', true), { kind: 'clear' });
    });

    it('refuses to clear a column the webhook routes by', () => {
        const result = readPageIdField(null, 'instagram_page_id', false);

        assert.equal(result.kind, 'error');
        assert.match((result as { error: string }).error, /every webhook/);
    });

    it('trims before validating, so a copied id with whitespace still works', () => {
        assert.deepEqual(readPageIdField('  17841400000000000 ', 'instagram_page_id', false),
            { kind: 'set', value: '17841400000000000' });
    });

    it('explains what a page id is when it rejects one', () => {
        const result = readPageIdField('@someone', 'instagram_page_id', false);

        assert.equal(result.kind, 'error');
        assert.match((result as { error: string }).error, /digits only/);
    });
});

describe('readVerifyTokenField', () => {
    it('applies the same rules as POST /api/settings/webhook-token', () => {
        // Two endpoints accepting the same column with different rules is how a value one of
        // them rejects gets in through the other.
        assert.equal(readVerifyTokenField('short').kind, 'error');
        assert.equal(readVerifyTokenField('has a space in it').kind, 'error');
        assert.deepEqual(readVerifyTokenField('  a-good-token  '),
            { kind: 'set', value: 'a-good-token' });
    });

    it('allows clearing it, and leaves it alone when absent', () => {
        assert.deepEqual(readVerifyTokenField(null), { kind: 'clear' });
        assert.deepEqual(readVerifyTokenField(undefined), { kind: 'absent' });
    });

    it('rejects a non-string rather than coercing one', () => {
        assert.equal(readVerifyTokenField(12345678).kind, 'error');
    });
});

describe('passwordProblem', () => {
    it('accepts a long enough password', () => {
        assert.equal(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH)), null);
    });

    it('rejects one character short, and says the minimum', () => {
        const problem = passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1));

        assert.ok(problem);
        assert.match(problem, new RegExp(String(MIN_PASSWORD_LENGTH)));
    });

    it('rejects a missing or non-string password', () => {
        for (const value of [undefined, null, 42, {}]) {
            assert.ok(passwordProblem(value), `input ${JSON.stringify(value)}`);
        }
    });
});

// ─── Creating a tenant by name (v34) ────────────────────────────────────────────────────

describe('readNamedTenant', () => {
    it('takes a name alone: Arabic, no handle, no site', () => {
        assert.deepEqual(readNamedTenant({ name: '  متجر نور  ' }), { ok: true, value: { name: 'متجر نور', lang: 'ar', instagramUsername: null, websiteUrl: null } });
    });

    it('takes the language the operator picked, and nothing but ar or en', () => {
        assert.equal((readNamedTenant({ name: 'x', lang: 'en' }) as { value: { lang: string } }).value.lang, 'en');
        assert.equal((readNamedTenant({ name: 'x', lang: 'ar' }) as { value: { lang: string } }).value.lang, 'ar');
        for (const lang of [undefined, null, '']) assert.equal((readNamedTenant({ name: 'x', lang }) as { value: { lang: string } }).value.lang, 'ar', `${lang} is the default`);
        for (const lang of ['fr', 'EN', 'arabic', 7, {}]) assert.deepEqual(readNamedTenant({ name: 'x', lang }), { ok: false, error: 'lang must be "ar" or "en".' }, String(lang));
    });

    it('needs a name that is text, not blank, not too long for the column, and without control characters', () => {
        for (const name of [undefined, null, '', '   ', 42, {}, ['x']]) assert.deepEqual(readNamedTenant({ name }), { ok: false, error: 'name is required.' }, JSON.stringify(name));
        assert.match((readNamedTenant({ name: 'x'.repeat(256) }) as { error: string }).error, /too long: at most 255/);
        assert.equal(readNamedTenant({ name: 'x'.repeat(255) }).ok, true);
        assert.match((readNamedTenant({ name: 'two\nlines' }) as { error: string }).error, /line breaks/);
    });

    it('reads the handle and the site, accepting website_url for the site and preferring website', () => {
        const a = readNamedTenant({ name: 'x', instagram_username: '@Sami.Fit', website: 'samifit.example' });
        assert.deepEqual(a, { ok: true, value: { name: 'x', lang: 'ar', instagramUsername: 'sami.fit', websiteUrl: 'https://samifit.example/' } });
        const b = readNamedTenant({ name: 'x', website_url: 'https://b.example/shop' });
        assert.equal((b as { value: { websiteUrl: string } }).value.websiteUrl, 'https://b.example/shop');
        const both = readNamedTenant({ name: 'x', website: 'https://a.example', website_url: 'https://b.example' });
        assert.equal((both as { value: { websiteUrl: string } }).value.websiteUrl, 'https://a.example/');
    });

    it('refuses what it cannot read, saying which field', () => {
        assert.match((readNamedTenant({ name: 'x', instagram_username: 'not a handle!' }) as { error: string }).error, /^instagram_username/);
        assert.match((readNamedTenant({ name: 'x', website: 'localhost' }) as { error: string }).error, /^website/);
    });

    it('ignores everything else in the body: the route decides what a Meta connection means', () => {
        const out = readNamedTenant({ name: 'x', instagram_page_id: '123', page_access_token: 'tok', is_active: false, creator_id: 'other' });
        assert.deepEqual(out, { ok: true, value: { name: 'x', lang: 'ar', instagramUsername: null, websiteUrl: null } });
    });
});

describe('readInstagramUsername', () => {
    it('reads a handle with or without the @, in any case, or a profile URL', () => {
        for (const raw of ['sami.fit', '@sami.fit', '  @Sami.Fit ', 'https://www.instagram.com/sami.fit/', 'instagram.com/sami.fit?hl=en', 'http://instagram.com/Sami.Fit#x']) {
            assert.deepEqual(readInstagramUsername(raw), { ok: true, value: 'sami.fit' }, raw);
        }
    });

    it('is null for nothing, and an error for anything that is not a handle', () => {
        for (const raw of [undefined, null, '', '   ']) assert.deepEqual(readInstagramUsername(raw), { ok: true, value: null });
        for (const raw of ['a b', 'x'.repeat(31), 'نور', 'a@b', 'https://evil.example/sami.fit', '@', 12]) assert.equal(readInstagramUsername(raw).ok, false, String(raw));
    });
});

describe('readWebsiteUrl', () => {
    it('takes a domain with or without the scheme, and keeps the scheme it was given', () => {
        assert.deepEqual(readWebsiteUrl('samifit.example'), { ok: true, value: 'https://samifit.example/' });
        assert.deepEqual(readWebsiteUrl(' http://samifit.example/shop?a=1 '), { ok: true, value: 'http://samifit.example/shop?a=1' });
        assert.deepEqual(readWebsiteUrl('https://shop.samifit.example'), { ok: true, value: 'https://shop.samifit.example/' });
        for (const raw of [undefined, null, '', '  ']) assert.deepEqual(readWebsiteUrl(raw), { ok: true, value: null });
    });

    it('refuses an address a person could not open from the internet, and anything that is not a web address', () => {
        for (const raw of [
            'localhost', 'http://intranet/admin', 'http://127.0.0.1/', 'http://192.168.1.10', 'http://10.0.0.1:8080/x', 'http://[::1]/', 'https://user:pass@example.com/',
            'ftp://example.com/', 'javascript:alert(1)', 'file:///etc/passwd', 'exa mple.com', `https://example.com/${'a'.repeat(2100)}`, 'https://exa\u0000mple.com', 5,
        ]) assert.equal(readWebsiteUrl(raw).ok, false, String(raw).slice(0, 40));
    });
});
