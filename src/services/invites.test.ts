/**
 * The invite service's pure parts: the token, its hash, the status a link is in, and the settings that shape it.
 * The routes that put them to work are in `src/routes/invites.test.ts`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
    buildInviteUrl, describeInvite, generateInviteToken, hashesEqual, hashInviteToken, INVITE_TOKEN_BYTES, INVITE_TOKEN_LENGTH,
    inviteStatus, isUsable, isWellFormedToken, normaliseEmail, readTtl,
} from './invites.js';
import {
    DEFAULT_RESET_WHATSAPP_TEXT, DEFAULT_WHATSAPP_TEXT, ONBOARDING_LIMITS, readInt, readRole, renderWhatsappText, validateOnboardingPatch,
} from './onboardingSettings.js';
import { APP_SETTING_KEYS } from './appSettings.js';

describe('tokens', () => {
    it('are 32 bytes of randomness, written as 43 characters of base64url', () => {
        const token = generateInviteToken();
        assert.equal(INVITE_TOKEN_BYTES, 32);
        assert.equal(token.length, INVITE_TOKEN_LENGTH);
        assert.equal(Buffer.from(token, 'base64url').length, 32);
        assert.match(token, /^[A-Za-z0-9_-]+$/, 'safe in a URL fragment without encoding');
    });

    it('carry about 256 bits: no collision in ten thousand, and every byte position varies', () => {
        const seen = new Set<string>();
        const columns = Array.from({ length: 32 }, () => new Set<number>());
        for (let i = 0; i < 10_000; i += 1) {
            const token = generateInviteToken();
            seen.add(token);
            Buffer.from(token, 'base64url').forEach((byte, at) => columns[at]!.add(byte));
        }
        assert.equal(seen.size, 10_000);
        for (const [at, values] of columns.entries()) assert.ok(values.size > 150, `byte ${at} takes ${values.size} different values`);
    });

    it('hash to a 64-character sha256 that is neither the token nor derivable from anything else stored', () => {
        const token = generateInviteToken();
        const hash = hashInviteToken(token);
        assert.equal(hash, createHash('sha256').update(token).digest('hex'));
        assert.match(hash, /^[0-9a-f]{64}$/);
        assert.notEqual(hash, token);
        assert.equal(hashInviteToken(token), hash, 'deterministic: that is what makes it a lookup key');
        assert.notEqual(hashInviteToken(generateInviteToken()), hash);
    });

    it('are recognised by shape before anything is looked up', () => {
        assert.equal(isWellFormedToken(generateInviteToken()), true);
        for (const bad of [undefined, null, 0, '', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)} `, `${'a'.repeat(42)}+`, ['a'.repeat(43)], {}]) {
            assert.equal(isWellFormedToken(bad), false, JSON.stringify(bad));
        }
    });

    it('compare in constant time, and a different length is simply different, never an error', () => {
        const a = hashInviteToken('one');
        assert.equal(hashesEqual(a, hashInviteToken('one')), true);
        assert.equal(hashesEqual(a, hashInviteToken('two')), false);
        assert.equal(hashesEqual(a, a.slice(1)), false);
        assert.equal(hashesEqual('', a), false);
        assert.doesNotThrow(() => hashesEqual(a, 'é'.repeat(64)));
    });

    it('go in the URL fragment: the server, its logs and every Referer see /dashboard and nothing after it', () => {
        const token = generateInviteToken();
        const url = buildInviteUrl('https://app.example.org', token, 'ar');
        assert.equal(url, `https://app.example.org/dashboard#/invite?t=${token}&lang=ar`);
        const parsed = new URL(url);
        assert.equal(parsed.search, '');
        assert.equal(parsed.pathname + parsed.search, '/dashboard');
        assert.equal(buildInviteUrl('https://app.example.org', token, 'en').endsWith('&lang=en'), true);
    });
});

describe('inviteStatus', () => {
    const now = new Date('2026-10-14T12:00:00Z');
    const base = { used_at: null, revoked_at: null, expires_at: new Date('2026-10-20T00:00:00Z'), open_count: 0 };

    it('is pending until opened, then opened', () => {
        assert.equal(inviteStatus(base, now), 'pending');
        assert.equal(inviteStatus({ ...base, open_count: 3 }, now), 'opened');
    });

    it('expires at its expiry, to the millisecond', () => {
        assert.equal(inviteStatus({ ...base, expires_at: new Date(now.getTime() + 1) }, now), 'pending');
        assert.equal(inviteStatus({ ...base, expires_at: new Date(now.getTime()) }, now), 'expired');
        assert.equal(inviteStatus({ ...base, expires_at: now.toISOString() as unknown as Date }, now), 'expired', 'a string from the driver');
    });

    it('says used before revoked before expired: what the operator most needs to know is whether somebody got in', () => {
        const all = { ...base, used_at: new Date(), revoked_at: new Date(), expires_at: new Date('2020-01-01') };
        assert.equal(inviteStatus(all, now), 'used');
        assert.equal(inviteStatus({ ...all, used_at: null }, now), 'revoked');
        assert.equal(inviteStatus({ ...all, used_at: null, revoked_at: null }, now), 'expired');
    });

    it('is usable only while pending or opened', () => {
        assert.equal(isUsable(base, now), true);
        assert.equal(isUsable({ ...base, open_count: 2 }, now), true);
        assert.equal(isUsable({ ...base, used_at: new Date() }, now), false);
        assert.equal(isUsable({ ...base, revoked_at: new Date() }, now), false);
        assert.equal(isUsable({ ...base, expires_at: new Date('2026-10-14T11:59:59Z') }, now), false);
    });

    it('is all describeInvite shows of a row: no hash, no creator, no token', () => {
        const row = {
            id: 'i-1', creator_id: 't-1', email: null, membership_role: 'owner' as const, purpose: 'join' as const, user_id: null,
            created_at: new Date('2026-10-14T10:00:00Z'), expires_at: base.expires_at, first_opened_at: null, open_count: 0,
            used_at: null, revoked_at: null, token_hash: 'deadbeef', created_by: 'u-1', used_by: 'u-2',
        };
        const described = describeInvite(row as never, now);
        assert.equal(JSON.stringify(described).includes('deadbeef'), false);
        assert.deepEqual(Object.keys(described).sort(), [
            'created_at', 'creator_id', 'email', 'expires_at', 'first_opened_at', 'id', 'open_count', 'purpose', 'revoked_at', 'role',
            'status', 'used_at', 'used_by_email', 'user_id',
        ]);
    });
});

describe('what an operator may type', () => {
    it('reads an email as one address, lower-cased', () => {
        assert.equal(normaliseEmail('  Nour@Example.COM '), 'nour@example.com');
        for (const bad of ['', 'nour', 'a b@c.d', 'a@b', '@x.y', 'a@@b.c', 5, null, undefined, `${'a'.repeat(251)}@b.co`]) assert.equal(normaliseEmail(bad), null, String(bad));
    });

    it('reads a lifetime as a whole number in range, or nothing at all', () => {
        assert.deepEqual(readTtl(undefined, 'days'), { ok: true, value: null });
        assert.deepEqual(readTtl('', 'days'), { ok: true, value: null });
        assert.deepEqual(readTtl(14, 'days'), { ok: true, value: 14 });
        assert.deepEqual(readTtl('90', 'days'), { ok: true, value: 90 });
        assert.deepEqual(readTtl(168, 'hours'), { ok: true, value: 168 });
        for (const bad of [0, -1, 91, 1.5, '7 days', 'x', NaN, {}]) assert.equal(readTtl(bad, 'days').ok, false, String(bad));
        assert.equal(readTtl(169, 'hours').ok, false);
    });
});

describe('the onboarding settings', () => {
    it('read an integer inside its range, and anything else is the default', () => {
        const range = ONBOARDING_LIMITS.inviteTtlDays;
        assert.equal(readInt('14', range), 14);
        assert.equal(readInt(' 3 ', range), 3);
        for (const bad of [null, '', '0', '-3', '7.5', '7 days', '1e2', '91', '99999', 'abc']) assert.equal(readInt(bad, range), range.fallback, String(bad));
        assert.deepEqual([ONBOARDING_LIMITS.inviteTtlDays.fallback, ONBOARDING_LIMITS.resetTtlHours.fallback, ONBOARDING_LIMITS.sessionDays.fallback], [7, 24, 30]);
    });

    it('read a role, and anything else is owner', () => {
        assert.equal(readRole('viewer'), 'viewer');
        assert.equal(readRole('operator'), 'operator');
        for (const bad of [null, '', 'root', 'OWNER', 'platform_admin']) assert.equal(readRole(bad), 'owner');
    });

    it('write nothing until everything is valid, and name the field that is not', () => {
        const ok = validateOnboardingPatch({ inviteTtlDays: 14, sessionDays: '45', defaultRole: 'viewer', inviterName: ' Amir ', whatsappText: 'Hi {link}', defaultRules: ['no_women_imagery'] });
        assert.equal(ok.ok, true);
        if (ok.ok) {
            const byField = Object.fromEntries(ok.writes.map((w) => [w.field, w.value]));
            assert.deepEqual(byField, { inviteTtlDays: '14', sessionDays: '45', defaultRole: 'viewer', inviterName: 'Amir', whatsappText: 'Hi {link}', defaultRules: '["no_women_imagery"]' });
            assert.equal(ok.writes.find((w) => w.field === 'sessionDays')!.key, APP_SETTING_KEYS.onboardingSessionDays);
        }
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ inviteTtlDays: 0 }, 'inviteTtlDays'],
            [{ inviteTtlDays: 91 }, 'inviteTtlDays'],
            [{ resetTtlHours: 200 }, 'resetTtlHours'],
            [{ sessionDays: 'a month' }, 'sessionDays'],
            [{ defaultRole: 'god' }, 'defaultRole'],
            [{ inviterName: 'me@example.com' }, 'inviterName'],
            [{ inviterName: 'a\nb' }, 'inviterName'],
            [{ inviterName: 'x'.repeat(81) }, 'inviterName'],
            [{ whatsappText: 'no link here' }, 'whatsappText'],
            [{ whatsappText: `{link}${'x'.repeat(600)}` }, 'whatsappText'],
            [{ defaultRules: ['no_women_imagery', 'something_else'] }, 'defaultRules'],
            [{ defaultRules: 'no_women_imagery' }, 'defaultRules'],
            // The first valid field does not save when a later one is not.
            [{ inviteTtlDays: 5, defaultRole: 'god' }, 'defaultRole'],
        ];
        for (const [body, field] of cases) {
            const result = validateOnboardingPatch(body);
            assert.equal(result.ok, false, JSON.stringify(body));
            if (!result.ok) assert.equal(result.field, field, JSON.stringify(body));
        }
    });

    it('clear a field back to its default with null or an empty string, and keep [] as a deliberate "no rules"', () => {
        const cleared = validateOnboardingPatch({ inviteTtlDays: null, sessionDays: '', defaultRole: '', inviterName: null, whatsappText: '  ', defaultRules: null });
        assert.equal(cleared.ok, true);
        if (cleared.ok) assert.ok(cleared.writes.every((w) => w.value === null), 'every one is a delete');
        const none = validateOnboardingPatch({ defaultRules: [] });
        assert.equal(none.ok, true);
        if (none.ok) assert.deepEqual(none.writes, [{ field: 'defaultRules', key: APP_SETTING_KEYS.onboardingDefaultRules, value: '[]' }]);
        assert.deepEqual((validateOnboardingPatch({}) as { writes: unknown[] }).writes, [], 'an empty body asks for nothing');
    });
});

describe('the WhatsApp message', () => {
    const vars = { name: 'Nour Shop', link: 'https://x.test/dashboard#/invite?t=abc', inviter: 'Amir' };

    it('is in the language of the link, with the tenant\'s name and the link, when the operator saved nothing', () => {
        const ar = renderWhatsappText(null, vars, 'ar');
        assert.ok(ar.includes('Nour Shop') && ar.includes(vars.link));
        assert.match(ar, /[؀-ۿ]/);
        const en = renderWhatsappText(null, vars, 'en');
        assert.ok(en.includes('Nour Shop') && en.includes(vars.link));
        assert.doesNotMatch(en, /[؀-ۿ]/);
        for (const text of [...Object.values(DEFAULT_WHATSAPP_TEXT), ...Object.values(DEFAULT_RESET_WHATSAPP_TEXT)]) {
            assert.ok(text.includes('{link}'), 'every default carries the link');
            assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(text), false, 'no emoji in the product\'s own words');
        }
    });

    it('fills each placeholder in one pass, so a value that looks like one is left alone', () => {
        const text = renderWhatsappText('{inviter} says: {name} / {link} / {unknown}', { ...vars, name: '{link}', inviter: '{name}' }, 'en');
        assert.equal(text, `{name} says: {link} / ${vars.link} / {unknown}`);
    });

    it('drops {inviter} cleanly when nobody is named, and ignores a template with no link', () => {
        assert.equal(renderWhatsappText('From {inviter}: {link}', { ...vars, inviter: null }, 'en'), `From : ${vars.link}`);
        assert.equal(renderWhatsappText('no link', vars, 'en'), renderWhatsappText(null, vars, 'en'));
    });

    it('says something else for a reset, whatever the join template is', () => {
        const reset = renderWhatsappText('Your workspace is ready: {link}', vars, 'en', 'reset');
        assert.match(reset, /new password/);
        assert.ok(reset.includes(vars.link));
    });
});
