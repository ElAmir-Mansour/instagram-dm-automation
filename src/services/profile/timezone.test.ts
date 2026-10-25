/**
 * `tenantTimezone`: the one zone every time on the dashboard is read in, and whether the tenant chose it.
 *
 * The database is a fake `Exec` that answers the two statements this reads (the profile's narrow timezone select, and the Studio
 * settings row) and records what was sent, so what is asserted is the answer, the order the sources are tried in, and that the
 * profile itself (up to 128 KB) is never fetched for one string.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { resetProfileTableWarning } from './store.js';
import { FALLBACK_TIMEZONE, tenantTimezone } from './timezone.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Fake {
    /** `undefined`: no stored profile row. Otherwise what the profile row's two selected values are. */
    profile?: { schema: unknown; timezone: unknown };
    /** `undefined`: no studio_settings row. */
    settingsTimezone?: string | null;
    /** Make the profile select fail like a database without v33. */
    noProfileTable?: boolean;
}

function fakeExec(fake: Fake) {
    const statements: string[] = [];
    const exec = {
        async query(sql: string) {
            statements.push(sql.replace(/\s+/g, ' ').trim());
            if (/FROM creator_profiles/.test(sql)) {
                if (fake.noProfileTable) {
                    throw Object.assign(new Error('relation "creator_profiles" does not exist'), { code: '42P01' });
                }
                const rows = fake.profile ? [{ profile_schema: fake.profile.schema, identity_timezone: fake.profile.timezone }] : [];
                return { rows, rowCount: rows.length };
            }
            if (/FROM studio_settings/.test(sql)) {
                const rows = fake.settingsTimezone === undefined ? [] : [{ timezone: fake.settingsTimezone }];
                return { rows, rowCount: rows.length };
            }
            throw new Error(`unexpected statement: ${sql}`);
        },
    };
    return { exec: exec as never, statements };
}

let restoreSink: (() => void) | undefined;
beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    resetProfileTableWarning();
});
afterEach(() => restoreSink?.());

describe('tenantTimezone: a tenant with a stored profile', () => {
    it('answers with the profile’s zone, set, from one narrow select and nothing else', async () => {
        const { exec, statements } = fakeExec({ profile: { schema: 1, timezone: 'Asia/Tokyo' }, settingsTimezone: 'Europe/London' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'Asia/Tokyo', unset: false });
        assert.deepEqual(statements, [
            `SELECT profile->'schema' AS profile_schema, profile->'identity'->'timezone' AS identity_timezone FROM creator_profiles WHERE creator_id = $1`,
        ]);
    });

    it('is the profile’s zone even when the settings row says otherwise: the row is a mirror', async () => {
        const { exec } = fakeExec({ profile: { schema: 1, timezone: 'America/New_York' }, settingsTimezone: 'Asia/Tokyo' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'America/New_York', unset: false });
    });

    it('is UTC and unset when the profile holds no zone yet (a new profile’s empty string)', async () => {
        // The settings row is NOT consulted: the profile speaks for the tenant, and an empty zone is the answer.
        const { exec, statements } = fakeExec({ profile: { schema: 1, timezone: '' }, settingsTimezone: 'Asia/Tokyo' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'UTC', unset: true });
        assert.equal(statements.length, 1);
    });

    it('is UTC and unset when the stored value is absent, not a string, or whitespace', async () => {
        for (const timezone of [undefined, null, 7, '   ']) {
            const { exec } = fakeExec({ profile: { schema: 1, timezone } });
            assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'UTC', unset: true }, JSON.stringify(timezone));
        }
    });

    it('treats an explicit UTC in the profile as a choice', async () => {
        const { exec } = fakeExec({ profile: { schema: 1, timezone: 'UTC' } });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'UTC', unset: false });
    });

    it('does not hand a zone this runtime cannot use to anything that will put it after AT TIME ZONE', async () => {
        const { exec } = fakeExec({ profile: { schema: 1, timezone: 'Mars/Olympus' } });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'UTC', unset: true });
    });
});

describe('tenantTimezone: a tenant answered by its Studio settings row', () => {
    it('reads the row when there is no stored profile', async () => {
        const { exec, statements } = fakeExec({ settingsTimezone: 'Asia/Tokyo' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'Asia/Tokyo', unset: false });
        assert.equal(statements.length, 2);
        assert.match(statements[1]!, /^SELECT schedule->>'timezone' AS timezone FROM studio_settings WHERE creator_id = \$1$/);
    });

    it('reads the row when the profile was written by a newer release (nothing is overlaid from it)', async () => {
        const { exec } = fakeExec({ profile: { schema: 2, timezone: 'America/New_York' }, settingsTimezone: 'Asia/Tokyo' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'Asia/Tokyo', unset: false });
    });

    it('reads the row on a database without the profile table (v33 not applied yet)', async () => {
        const { exec } = fakeExec({ noProfileTable: true, settingsTimezone: 'Asia/Tokyo' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'Asia/Tokyo', unset: false });
    });

    it('the row’s default UTC is unset: nobody chose it', async () => {
        const { exec } = fakeExec({ settingsTimezone: 'UTC' });
        assert.deepEqual(await tenantTimezone(TENANT, exec), { tz: 'UTC', unset: true });
    });

    it('no row at all is unset', async () => {
        assert.deepEqual(await tenantTimezone(TENANT, fakeExec({}).exec), { tz: 'UTC', unset: true });
        assert.deepEqual(await tenantTimezone(TENANT, fakeExec({ settingsTimezone: null }).exec), { tz: 'UTC', unset: true });
    });
});

describe('tenantTimezone: failures are not swallowed', () => {
    it('lets a database error other than a missing profile table through', async () => {
        const exec = { async query() { throw new Error('connection terminated'); } } as never;
        await assert.rejects(tenantTimezone(TENANT, exec), /connection terminated/);
    });
});

describe('FALLBACK_TIMEZONE', () => {
    it('is UTC, the zone every unset answer carries', () => {
        assert.equal(FALLBACK_TIMEZONE, 'UTC');
    });
});
