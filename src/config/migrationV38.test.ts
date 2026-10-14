/**
 * Migration v38: tracked links (S7). The shape of the file, and the two promises the schema keeps for the code: a conversation or a tenant takes
 * its links and their clicks with it (erasure and tenant deletion need no statement of their own), and a click has no column that could hold an
 * address or a user-agent.
 *
 * Kept apart from migrations.test.ts, whose generic scans already cover this file (registered in apply order, RLS on every table it creates);
 * the checks here are the ones that are about THIS file.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { compareSchema, EXPECTED_MIGRATIONS } from './migrations.js';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = 'migration_v38_tracked_links.sql';
const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
const withoutComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const sql = withoutComments(raw).replace(/\s+/g, ' ');

const created = (text: string): string[] => [...text.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]!.toLowerCase());
const rlsOn = (text: string): string[] => [...text.matchAll(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => m[1]!.toLowerCase());

/** The text of one CREATE TABLE statement: from its name to the `);` that closes it. */
function tableBody(name: string): string {
    const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
    assert.ok(start >= 0, `${name} is created`);
    return sql.slice(start, sql.indexOf('); ', start) + 1);
}

describe('migration v38: tracked_links, link_clicks', () => {
    it('is registered right after v37, and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(EXPECTED_MIGRATIONS[i - 1], 'migration_v37_dm_engine.sql');
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
        assert.ok(readdirSync(CONFIG_DIR).includes(FILE));
    });

    it('is v38 exactly: another change takes v39', () => {
        assert.match(FILE, /^migration_v38_/);
        assert.equal(readdirSync(CONFIG_DIR).filter((f) => /^migration_v38_/.test(f)).length, 1, 'one v38');
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, as its first statement (the FKs lock creators and conversations)', () => {
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('creates the two tables, and no others', () => {
        assert.deepEqual(created(sql).sort(), ['link_clicks', 'tracked_links']);
    });

    it('enables RLS on both in this same file, deny by default: no policy is created', () => {
        assert.deepEqual(rlsOn(sql).sort(), ['link_clicks', 'tracked_links']);
        assert.doesNotMatch(sql, /CREATE POLICY/i);
        assert.doesNotMatch(sql, /FORCE ROW LEVEL SECURITY/i, 'the app connects as owner');
    });

    it('is idempotent: tables and indexes are created only if absent, and it removes and rewrites nothing', () => {
        assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length, (sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length);
        assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DROP INDEX|TRUNCATE|DELETE FROM|UPDATE |INSERT INTO|ALTER TABLE (?!tracked_links ENABLE|link_clicks ENABLE)/);
        assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 2, 'only the two RLS statements');
    });

    it('alters and references only tables that exist by the time it runs', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(before.flatMap((name) => created(withoutComments(readFileSync(name === 'schema.sql' ? path.join(CONFIG_DIR, '..', '..', 'schema.sql') : path.join(CONFIG_DIR, name), 'utf8')))));
        for (const table of ['creators', 'conversations']) assert.ok(existing.has(table), `${table} is created before v38`);
        const references = [...sql.matchAll(/REFERENCES (\w+)\(/g)].map((m) => m[1]!);
        assert.deepEqual(references.sort(), ['conversations', 'creators', 'tracked_links']);
        for (const table of references) assert.ok(existing.has(table) || table === 'tracked_links', `${table} exists first`);
    });

    describe('erasure and tenant deletion', () => {
        it('a link goes with its tenant: creator_id cascades', () => {
            assert.match(tableBody('tracked_links'), /creator_id UUID NOT NULL REFERENCES creators\(id\) ON DELETE CASCADE/);
        });

        it('a link goes with its conversation: conversation_id cascades, so the erasure tool\'s DELETE FROM conversations takes it', () => {
            assert.match(tableBody('tracked_links'), /conversation_id UUID REFERENCES conversations\(id\) ON DELETE CASCADE/);
        });

        it('a click goes with its link: code cascades, so a deleted conversation or tenant leaves no click behind either', () => {
            assert.match(tableBody('link_clicks'), /code TEXT NOT NULL REFERENCES tracked_links\(code\) ON DELETE CASCADE/);
        });

        it('every foreign key in the file cascades: nothing here can block a delete, or survive one', () => {
            const fks = [...sql.matchAll(/REFERENCES \w+\(\w+\)( ON DELETE (?:CASCADE|SET NULL|RESTRICT|NO ACTION))?/g)];
            assert.equal(fks.length, 3);
            for (const m of fks) assert.equal(m[1], ' ON DELETE CASCADE', m[0]);
        });

        it('the erasure tool deletes conversations, which is what the cascade hangs from (and does not name the new tables)', () => {
            const erasure = readFileSync('src/services/erasure.ts', 'utf8');
            assert.match(erasure, /'DELETE FROM conversations WHERE id = ANY\(\$1::uuid\[\]\)'/);
            assert.doesNotMatch(withoutComments(erasure).replace(/\/\/[^\n]*/g, ''), /tracked_links|link_clicks/, 'the schema does it, so an erasure on a database without v38 still runs');
        });
    });

    describe('what a click may hold', () => {
        const clicks = tableBody('link_clicks');

        it('is a link, a time, a flag and a coarse class: no address, no user-agent, no other personal field', () => {
            const columns = [...clicks.matchAll(/(?:^|[(,] )(\w+) (?:BIGSERIAL|TEXT|TIMESTAMP|BOOLEAN)/g)].map((m) => m[1]);
            assert.deepEqual(columns, ['id', 'code', 'clicked_at', 'is_prefetch', 'ua_class']);
            assert.doesNotMatch(clicks, /\b(ip|ip_address|inet|user_agent|ua|useragent|referer|referrer|ip_hash|fingerprint)\b\s+(?:TEXT|INET|VARCHAR|CHAR)/i);
            assert.doesNotMatch(clicks, /\bINET\b/i);
        });

        it('limits the class to a closed list in the database itself, so a user-agent string cannot be stored by mistake', () => {
            assert.match(clicks, /ua_class TEXT NOT NULL DEFAULT 'other' CHECK \(ua_class IN \('instagram', 'facebook', 'ios', 'android', 'desktop', 'preview', 'bot', 'other'\)\)/);
        });

        it('stamps the time itself, and says a person\'s click from a preview by a flag that defaults to a person', () => {
            assert.match(clicks, /clicked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW\(\)/);
            assert.match(clicks, /is_prefetch BOOLEAN NOT NULL DEFAULT FALSE/);
        });

        it('is indexed for the retention sweep (oldest first) and for the cascade from a link', () => {
            assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_link_clicks_clicked_at ON link_clicks \(clicked_at\)/);
            assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_link_clicks_code ON link_clicks \(code, clicked_at DESC\)/);
        });
    });

    describe('what a link is', () => {
        const links = tableBody('tracked_links');

        it('is keyed by an unguessable base62 code the database also refuses to see malformed', () => {
            assert.match(links, /code TEXT PRIMARY KEY CHECK \(code ~ '\^\[0-9A-Za-z\]\{10,32\}\$'\)/);
        });

        it('keeps the target as served: http(s), printable ASCII, no space', () => {
            assert.match(links, /target_url TEXT NOT NULL CHECK \(target_url ~\* '\^https\?:\/\/\[!-~\]\+\$'\)/);
        });

        it('is one per (conversation, offer), by a partial unique index on a table this file creates (v15: IF NOT EXISTS matches on the NAME)', () => {
            assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_links_conversation_offer ON tracked_links \(conversation_id, offer_id\) WHERE conversation_id IS NOT NULL/);
            const unique = [...sql.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS (\w+) ON (\w+)/g)].map((m) => m[2]);
            assert.deepEqual(unique, ['tracked_links']);
        });

        it('allows a link with no conversation (a test link) and requires a tenant and an offer', () => {
            assert.match(links, /conversation_id UUID REFERENCES/);
            assert.doesNotMatch(links, /conversation_id UUID NOT NULL/);
            assert.match(links, /offer_id TEXT NOT NULL CHECK \(char_length\(offer_id\) BETWEEN 1 AND 100\)/);
        });

        it('names the same arbiter the code\'s upsert does, so the ON CONFLICT clause finds this index', async () => {
            const { CREATE_LINK_SQL } = await import('../services/links.js');
            assert.match(CREATE_LINK_SQL, /ON CONFLICT \(conversation_id, offer_id\) WHERE conversation_id IS NOT NULL/);
        });
    });
});
