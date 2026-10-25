/**
 * Test support for the WhatsApp account, health and free-tier code: an in-memory `platform_connections` table that answers the exact
 * statements `whatsappAccount.ts`, `whatsappHealth.ts` and `whatsappConnections.ts` make, by SQL text, and THROWS on any other statement.
 *
 * What it models, because each is what the code under test depends on:
 *   - the compare-and-set of `casUpdate`: an UPDATE `WHERE profile IS NOT DISTINCT FROM $7` writes only when the stored profile still equals
 *     what the caller read (deep equality, like Postgres jsonb), so a test can make another writer win a race (`beforeUpdate`)
 *   - `profile || $3::jsonb` (a shallow merge) for the health read, and `profile - 'account_block' - 'block_until'`
 *   - every select the connection reads make, with the same columns (`has_token`, no token column, `access_token` only for `getAccessToken`)
 *
 * Not a Postgres: it knows nothing it was not told. Test files fall through to their own router for every other statement
 * (`connectionQuery` answers `null` for those).
 */
import { encryptSecret } from '../config/crypto.js';

export interface FakeConnection {
    id: string;
    creator_id: string;
    external_account_id: string;
    display_name: string | null;
    status: 'active' | 'invalid' | 'revoked';
    last_error: string | null;
    scopes: string[];
    /** Encrypted at rest, as the column holds it. NULL = disconnected. */
    access_token: string | null;
    access_expires_at: Date | null;
    last_refreshed_at: Date | null;
    created_at: Date;
    profile: Record<string, unknown> | null;
    settings: Record<string, unknown>;
}

export interface ConnectionDb {
    connections: FakeConnection[];
    /** Called just before a CAS UPDATE is judged: a test mutates a row here to make another writer win the race. */
    beforeUpdate?: (sql: string, params: unknown[]) => void;
    /** How many CAS UPDATEs wrote and how many found the profile changed under them. */
    cas: { written: number; lost: number };
}

export const newConnectionDb = (connections: FakeConnection[] = []): ConnectionDb => ({ connections, cas: { written: 0, lost: 0 } });

export const TEST_TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';

/** A connection as `saveConnection` leaves it, with a token. Override anything. */
export function fakeConnection(over: Partial<FakeConnection> = {}): FakeConnection {
    return {
        id: 'conn-1',
        creator_id: '11111111-1111-4111-8111-111111111111',
        external_account_id: '106540352242922',
        display_name: 'Lucky Shrub',
        status: 'active',
        last_error: null,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
        access_token: encryptSecret(TEST_TOKEN),
        access_expires_at: null,
        last_refreshed_at: new Date('2026-10-18T08:00:00Z'),
        created_at: new Date('2026-10-01T08:00:00Z'),
        profile: {
            waba_id: '102290129340398', waac_id: null, display_phone_number: '+1 555-078-3881', quality_rating: 'GREEN', messaging_limit: 'TIER_250',
            name_status: 'APPROVED', code_verification_status: 'VERIFIED', throughput: 'STANDARD', number_status: 'CONNECTED', is_test_number: false,
            timezone: null, read_at: '2026-10-18T08:00:00.000Z',
        },
        settings: { allow_billable: false, free_tier_alert_at: 900 },
        ...over,
    };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value), (_k, v) => v) as T));
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, sortKeys(v)]));
    return value;
}

const live = (db: ConnectionDb) => db.connections.filter((c) => c.status !== 'revoked');
/** The row as a read returns it: a copy (so a caller cannot edit the table), dates kept as dates. */
const copy = (c: FakeConnection) => ({ ...c, scopes: [...c.scopes], profile: clone(c.profile), settings: clone(c.settings) });
const withToken = (c: FakeConnection) => ({ ...copy(c), has_token: c.access_token !== null });

type Result = { rows: any[]; rowCount: number };
const result = (rows: any[], rowCount = rows.length): Result => ({ rows, rowCount });

/** The answer for a statement about `platform_connections`, or `null` when it is not one this support knows. */
export function connectionQuery(db: ConnectionDb, sqlIn: string, params: unknown[] = []): Result | null {
    const sql = norm(sqlIn);
    if (!/platform_connections/.test(sql)) return null;

    // The sweep's listing.
    if (/^SELECT creator_id FROM platform_connections WHERE platform = 'whatsapp' AND status <> 'revoked' AND access_token IS NOT NULL ORDER BY last_refreshed_at NULLS FIRST, id LIMIT \$1$/.test(sql)) {
        const rows = live(db).filter((c) => c.access_token !== null)
            .sort((a, b) => (a.last_refreshed_at?.getTime() ?? -Infinity) - (b.last_refreshed_at?.getTime() ?? -Infinity) || a.id.localeCompare(b.id))
            .slice(0, Number(params[0]));
        return result(rows.map((c) => ({ creator_id: c.creator_id })));
    }

    // An account event's lookup by Messaging account.
    if (/^SELECT id, creator_id, profile FROM platform_connections WHERE platform = 'whatsapp' AND status <> 'revoked' AND profile->>'waba_id' = \$1$/.test(sql)) {
        return result(live(db).filter((c) => c.profile?.waba_id === params[0]).map((c) => ({ id: c.id, creator_id: c.creator_id, profile: clone(c.profile) })));
    }

    // The raw rows `whatsappAccount.ts` reads.
    const accountColumns = 'SELECT id, creator_id, external_account_id, display_name, status, last_error, profile, settings FROM platform_connections';
    const pick = (c: FakeConnection) => ({
        id: c.id, creator_id: c.creator_id, external_account_id: c.external_account_id, display_name: c.display_name, status: c.status,
        last_error: c.last_error, profile: clone(c.profile), settings: clone(c.settings),
    });
    if (sql === `${accountColumns} WHERE id = $1 AND platform = 'whatsapp' AND status <> 'revoked'`) {
        return result(live(db).filter((c) => c.id === params[0]).map(pick));
    }
    if (sql === `${accountColumns} WHERE creator_id = $1 AND platform = 'whatsapp' AND external_account_id = $2 AND status <> 'revoked'`) {
        return result(live(db).filter((c) => c.creator_id === params[0] && c.external_account_id === params[1]).map(pick));
    }

    // The compare-and-set.
    if (/^UPDATE platform_connections SET profile = \$2::jsonb, status = \$3, last_error = \$4, display_name = COALESCE\(\$5, display_name\), updated_at = NOW\(\) WHERE id = \$1 AND platform = 'whatsapp' AND status = \$6 AND profile IS NOT DISTINCT FROM \$7::jsonb$/.test(sql)) {
        db.beforeUpdate?.(sql, params);
        const c = db.connections.find((x) => x.id === params[0]);
        const expected = params[6] === null ? null : JSON.parse(String(params[6]));
        if (!c || c.status !== params[5] || !same(c.profile, expected)) { db.cas.lost++; return result([], 0); }
        c.profile = JSON.parse(String(params[1]));
        c.status = params[2] as FakeConnection['status'];
        c.last_error = (params[3] as string | null) ?? null;
        if (params[4] !== null && params[4] !== undefined) c.display_name = String(params[4]);
        db.cas.written++;
        return result([], 1);
    }

    // `whatsappConnections.ts`: the reads and writes the health read makes.
    const connectionColumns = 'SELECT id, creator_id, external_account_id, display_name, status, last_error, scopes, access_token IS NOT NULL AS has_token, access_expires_at, last_refreshed_at, created_at, profile, settings FROM platform_connections';
    if (sql === `${connectionColumns} WHERE creator_id = $1 AND platform = 'whatsapp'`) {
        return result(db.connections.filter((c) => c.creator_id === params[0]).map(withToken));
    }
    // A webhook's own lookup: the connection a `phone_number_id` belongs to (`getConnectionByPhoneNumberId`), any row that is not revoked.
    if (sql === `${connectionColumns} WHERE platform = 'whatsapp' AND external_account_id = $1 AND status <> 'revoked'`) {
        return result(live(db).filter((c) => c.external_account_id === params[0]).map(withToken));
    }
    if (sql === connectionColumns.replace(' FROM platform_connections', ', access_token FROM platform_connections') + ` WHERE creator_id = $1 AND platform = 'whatsapp'`) {
        return result(db.connections.filter((c) => c.creator_id === params[0]).map(withToken));
    }
    if (/^UPDATE platform_connections SET display_name = COALESCE\(\$2, display_name\), profile = COALESCE\(profile, '\{\}'::jsonb\) \|\| \$3::jsonb, last_refreshed_at = NOW\(\), updated_at = NOW\(\) WHERE id = \$1 AND platform = 'whatsapp' AND status <> 'revoked' RETURNING/.test(sql)) {
        const c = live(db).find((x) => x.id === params[0]);
        if (!c) return result([]);
        if (params[1] !== null && params[1] !== undefined) c.display_name = String(params[1]);
        c.profile = { ...(c.profile ?? {}), ...JSON.parse(String(params[2])) };
        c.last_refreshed_at = new Date('2026-10-19T08:00:00Z');
        return result([withToken(c)]);
    }
    if (/^UPDATE platform_connections SET status = 'invalid', last_error = \$2, updated_at = NOW\(\) WHERE id = \$1 AND platform = 'whatsapp' AND status <> 'revoked'$/.test(sql)) {
        const c = live(db).find((x) => x.id === params[0]);
        if (c) { c.status = 'invalid'; c.last_error = String(params[1]); }
        return result([], c ? 1 : 0);
    }
    if (/^UPDATE platform_connections SET status = 'active', last_error = NULL, updated_at = NOW\(\) WHERE id = \$1 AND platform = 'whatsapp' AND status = 'invalid'$/.test(sql)) {
        const c = db.connections.find((x) => x.id === params[0] && x.status === 'invalid');
        if (c) { c.status = 'active'; c.last_error = null; }
        return result([], c ? 1 : 0);
    }
    if (/^UPDATE platform_connections SET profile = COALESCE\(profile, '\{\}'::jsonb\) - 'account_block' - 'block_until', updated_at = NOW\(\) WHERE id = \$1 AND platform = 'whatsapp'$/.test(sql)) {
        const c = db.connections.find((x) => x.id === params[0]);
        if (c?.profile) { delete c.profile.account_block; delete c.profile.block_until; }
        return result([], c ? 1 : 0);
    }
    return null;
}
