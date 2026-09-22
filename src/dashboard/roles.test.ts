/**
 * The screens that make an in-tenant role legible.
 *
 * `memberships.role` was rendered on the Users page for four migrations while no
 * authorization decision read it, and the form that set it said so in as many words: "a label
 * only — access is the membership itself, not this value". It decides something now
 * (src/services/tenant.ts), so three things about this markup are worth pinning rather than
 * eyeballing:
 *
 *   1. The dashboard's normalisation matches the server's, INCLUDING the direction it fails
 *      in. A UI that resolved an unrecognised role to `viewer` would show every existing
 *      member a downgrade that has not happened to them.
 *   2. Nothing is spelled in English inside a template. Every visible string goes through
 *      `t()`, which is what keeps an Arabic RTL page Arabic.
 *   3. No inline `on*` handler survives, anywhere. The CSP has no `'unsafe-inline'` escape
 *      hatch for attributes, so one would simply not fire in production while looking
 *      perfectly correct here.
 *
 * Loaded the same way as escaping.test.ts, charts.test.ts and buttons.test.ts: the REAL
 * dashboard files in a `node:vm` context, so this tests what ships rather than a copy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

interface Page {
    renderMembership(userId: string, email: string, m: Record<string, unknown>): { toString(): string };
    renderMember(m: Record<string, unknown>): { toString(): string };
    memberships(u: Record<string, unknown>): Array<Record<string, unknown>>;
}

interface AdminApi {
    TENANT_ROLES: string[];
    tenantRole(raw: unknown): string;
    roleChip(raw: unknown): { toString(): string };
    roleOptions(current: unknown): unknown;
    roleLegend(): { toString(): string };
}

interface Loaded {
    Admin: AdminApi;
    UsersPage: Page;
    TenantDetailPage: Page;
    /** Every `t()` key the sandbox was asked for. */
    keys: string[];
}

/**
 * Load the real files. `t()` returns the key itself, which is what makes assertion 2 above
 * checkable: a hardcoded English string appears in the output verbatim, while a translated
 * one appears as its dotted key.
 */
function load(): Loaded {
    const noop = (): void => {};
    const keys: string[] = [];
    const stubEl = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [],
    };
    const t = (key: string): string => { keys.push(key); return key; };
    const ctx: Record<string, unknown> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang: 'ar', dir: 'rtl' },
            getElementById: () => null, activeElement: null,
        },
        window: {
            addEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location: { hash: '', origin: 'https://example.test' },
        },
        Intl, console, setTimeout, clearTimeout,
        requestAnimationFrame: (f: () => void) => f(),
        I18N: { lang: 'ar', locale: () => 'ar-u-nu-latn-ca-gregory', t, strings: { ar: {}, en: {} } },
        t,
        navigator: { language: 'ar' },
        CSS: { escape: (v: string) => String(v) },
        // The page modules reach for these at call time, not load time; the few methods
        // these two render paths touch are the ones stubbed.
        API: {}, Motion: { announce: noop }, App: { session: null },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of [
        'dashboard/js/components.js',
        'dashboard/js/pages/admin_common.js',
        'dashboard/js/pages/users.js',
        'dashboard/js/pages/tenant_detail.js',
    ]) {
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }

    const { Admin, UsersPage, TenantDetailPage } = vm.runInContext(
        '({ Admin, UsersPage, TenantDetailPage })', ctx
    ) as Omit<Loaded, 'keys'>;
    return { Admin, UsersPage, TenantDetailPage, keys };
}

describe('Admin.tenantRole', () => {
    it('agrees with the server, including which way it fails', () => {
        const { Admin } = load();

        assert.equal(Admin.tenantRole('operator'), 'operator');
        assert.equal(Admin.tenantRole('viewer'), 'viewer');
        // Everything else is an owner — which is what every membership row in the live
        // database already is, and what the legacy 'member' value always meant in practice.
        for (const raw of ['owner', 'member', '', null, undefined, 'Viewer', 42]) {
            assert.equal(Admin.tenantRole(raw), 'owner', JSON.stringify(raw));
        }
    });
});

describe('Admin.roleChip', () => {
    it('names the role and explains it on hover, both through t()', () => {
        const { Admin } = load();
        const out = String(Admin.roleChip('viewer'));

        assert.match(out, /class="tenant-role-chip tenant-role-viewer"/);
        assert.match(out, /title="roles\.viewer\.what"/);
        assert.match(out, />roles\.viewer</);
    });

    it('cannot be talked into an arbitrary class by a stored value', () => {
        // The role reaches this function from a server payload. `tenant-role-${raw}` would
        // put whatever it said inside a class attribute; normalising first means the class
        // can only ever be one of three this stylesheet defines.
        const { Admin } = load();
        const out = String(Admin.roleChip('viewer" onload="alert(1)'));

        assert.match(out, /tenant-role-owner/);
        assert.equal(out.includes('onload'), false);
    });
});

describe('Admin.roleOptions', () => {
    it('offers exactly the three the server accepts', () => {
        const { Admin } = load();
        const out = String(Admin.roleOptions('operator'));

        assert.deepEqual([...out.matchAll(/value="([a-z]+)"/g)].map((m) => m[1]),
            ['owner', 'operator', 'viewer']);
        // The stored role is the one shown, or the picker silently proposes a change.
        assert.match(out, /<option value="operator" selected>/);
    });

    it('selects owner for the legacy value, so no picker shows a downgrade', () => {
        const { Admin } = load();

        assert.match(String(Admin.roleOptions('member')), /<option value="owner" selected>/);
    });
});

describe('Admin.roleLegend', () => {
    it('says what each tier gets, beside the picker that grants it', () => {
        const { Admin } = load();
        const out = String(Admin.roleLegend());

        // Asserted on the VISIBLE cell, not on the whole string: every chip already carries
        // the same key in a `title`, so "it appears somewhere" stays true for a legend whose
        // descriptions have been emptied — a hover tooltip is not the explanation somebody
        // choosing a role from a dropdown needs.
        const described = [...out.matchAll(/<dd>([^<]*)<\/dd>/g)].map((m) => m[1]!.trim());

        assert.deepEqual(described, ['roles.owner.what', 'roles.operator.what', 'roles.viewer.what']);
    });
});

describe('UsersPage.renderMembership', () => {
    const membership = { id: 'c-1', name: 'متجر التمور', role: 'viewer' };

    it('makes the role editable in place rather than printing it', () => {
        // Granting and revoking were the only two operations; changing a role meant doing
        // both. The grant endpoint is an upsert, so the picker IS the edit.
        const { UsersPage } = load();
        const out = String(UsersPage.renderMembership('u-1', 'a@b.test', membership));

        assert.match(out, /data-change="users:changeMembershipRole"/);
        assert.match(out, /<option value="viewer" selected>/);
        assert.match(out, /data-creator="c-1"/);
    });

    it('labels the picker, because a card can hold several of them', () => {
        const { UsersPage } = load();
        const out = String(UsersPage.renderMembership('u-1', 'a@b.test', membership));

        const id = /id="(membership-role-[^"]+)"/.exec(out);
        assert.ok(id, 'the picker needs an id for its label');
        assert.ok(out.includes(`for="${id![1]}"`), 'and a label pointing at it');
    });

    it('delegates every handler, so the CSP cannot silence it', () => {
        const { UsersPage } = load();
        const out = String(UsersPage.renderMembership('u-1', 'a@b.test', membership));

        assert.equal(/\son[a-z]+=/i.test(out), false, 'no inline handler may survive');
    });

    it('escapes a tenant name rather than rendering it', () => {
        const { UsersPage } = load();
        const out = String(UsersPage.renderMembership(
            'u-1', 'a@b.test', { id: 'c-1', name: '<img src=x onerror=alert(1)>', role: 'owner' }
        ));

        assert.equal(out.includes('<img'), false);
        assert.match(out, /&lt;img/);
    });

    it('disables both controls for a membership with no tenant id', () => {
        const { UsersPage } = load();
        const out = String(UsersPage.renderMembership('u-1', 'a@b.test', { id: '', name: 'x', role: 'owner' }));

        assert.equal((out.match(/disabled/g) || []).length, 2);
    });
});

describe('TenantDetailPage.renderMember', () => {
    it('shows the in-tenant role for an ordinary member', () => {
        const { TenantDetailPage } = load();
        const out = String(TenantDetailPage.renderMember({
            email: 'ops@client.test', role: 'user', membershipRole: 'operator', isActive: true,
        }));

        assert.match(out, /tenant-role-operator/);
        assert.match(out, /ops@client\.test/);
    });

    it('shows a platform admin as an admin, not as their membership row', () => {
        // A platform_admin reaches every tenant as an owner whatever the membership says, so
        // rendering the membership role beside them would be a number that is not in force.
        const { TenantDetailPage } = load();
        const out = String(TenantDetailPage.renderMember({
            email: 'me@agency.test', role: 'platform_admin', membershipRole: 'viewer', isActive: true,
        }));

        assert.match(out, /role-chip role-admin/);
        assert.equal(out.includes('tenant-role-viewer'), false);
        assert.match(out, /title="tenantDetail\.adminOverride"/);
    });

    it('marks a disabled account, which can hold a membership and still not log in', () => {
        const { TenantDetailPage } = load();
        const out = String(TenantDetailPage.renderMember({
            email: 'gone@client.test', role: 'user', membershipRole: 'owner', isActive: false,
        }));

        assert.match(out, /member-item-off/);
        assert.match(out, /chip-danger/);
    });

    it('writes no English of its own', () => {
        const { TenantDetailPage, keys } = load();
        const out = String(TenantDetailPage.renderMember({
            email: 'ops@client.test', role: 'user', membershipRole: 'viewer', isActive: false,
        }));

        // `t()` returns its argument here, so every translated word comes out as a dotted
        // key. Anything left that is a bare English word was written into the template.
        assert.ok(keys.length > 0, 't() must have been called at all');
        const words = out
            .replace(/<[^>]*>/g, ' ')          // markup is not copy
            .replace(/ops@client\.test/g, ' ') // the datum under test
            .split(/\s+/)
            .filter((word) => /[A-Za-z]/.test(word));
        const hardcoded = words.filter((word) => !/^[a-zA-Z]+(\.[a-zA-Z]+)+$/.test(word));

        assert.deepEqual(hardcoded, [], 'these words never reached the translation catalogue');
    });
});
