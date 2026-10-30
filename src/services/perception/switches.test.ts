/**
 * The perception settings (`switches.ts`): three per-tenant `app_settings` rows, read strictly, every one of them defaulting to the product as it was.
 * Nothing here reaches Postgres: `pool.query` answers from a map, on the SQL `getSetting` sends.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { TENANT_SETTING_PREFIXES, tenantSettingKey } from '../appSettings.js';
import {
    capabilityOn, MUSE_ALL_SENDERS, MUSE_DAILY_USD_DEFAULT, MUSE_DAILY_USD_MAX, museSettingsOff, parseAllowSenders, parseDailyUsd, parseMuseSwitches,
    readMuseSettings, senderAllowed,
} from './switches.js';

const originalQuery = pool.query;
let logged: { level: string; event: string; [k: string]: unknown }[] = [];
let restoreSink = (): void => undefined;

beforeEach(() => {
    logged = [];
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => { setLogSink(previous); };
});

afterEach(() => {
    (pool as any).query = originalQuery;
    restoreSink();
});

/** `pool.query` answers `getSetting`'s read from `store`, and remembers which keys were asked for. */
function stubSettings(store: Record<string, string>): { asked: string[] } {
    const asked: string[] = [];
    (pool as any).query = async (text: string, params: unknown[] = []) => {
        if (!/SELECT value, is_secret FROM app_settings WHERE key = \$1/.test(text)) throw new Error(`unexpected SQL ${text}`);
        const key = String(params[0]);
        asked.push(key);
        const value = store[key];
        return { rows: value === undefined ? [] : [{ value, is_secret: false }], rowCount: value === undefined ? 0 : 1 };
    };
    return { asked };
}

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

describe('parseMuseSwitches: strict, and off for anything odd', () => {
    it('is all off when nothing is stored', () => {
        assert.deepEqual(parseMuseSwitches(null), { dm_media: false, voice: false, memory: false });
        assert.deepEqual(parseMuseSwitches(''), { dm_media: false, voice: false, memory: false });
    });

    it('turns on exactly the fields that are the boolean true, and leaves the others off', () => {
        assert.deepEqual(parseMuseSwitches('{"dm_media":true}'), { dm_media: true, voice: false, memory: false });
        assert.deepEqual(parseMuseSwitches('{"dm_media":true,"voice":true,"memory":true}'), { dm_media: true, voice: true, memory: true });
        assert.deepEqual(parseMuseSwitches('{"dm_media":false,"voice":true}'), { dm_media: false, voice: true, memory: false });
    });

    it('reads "true", 1, "on" and null as off: only the boolean counts', () => {
        assert.deepEqual(parseMuseSwitches('{"dm_media":"true","voice":1,"memory":"on"}'), { dm_media: false, voice: false, memory: false });
        assert.deepEqual(parseMuseSwitches('{"dm_media":null}'), { dm_media: false, voice: false, memory: false });
    });

    it('reads what is not an object as all off: text that is not JSON, a list, a bare value', () => {
        for (const raw of ['not json', '[true,true,true]', 'true', '1', '"dm_media"', 'null', '{']) {
            assert.deepEqual(parseMuseSwitches(raw), { dm_media: false, voice: false, memory: false }, raw);
        }
    });

    it('knows no switch for the phases the build cut: comments and cards are not read, even when stored', () => {
        const parsed = parseMuseSwitches('{"dm_media":true,"comments":true,"cards":true}');
        assert.deepEqual(Object.keys(parsed).sort(), ['dm_media', 'memory', 'voice']);
    });
});

describe('parseAllowSenders: a list of ids, `*` for everyone, anything else nobody', () => {
    it('is nobody when nothing is stored, or the list is empty', () => {
        assert.deepEqual(parseAllowSenders(null), []);
        assert.deepEqual(parseAllowSenders(''), []);
        assert.deepEqual(parseAllowSenders('[]'), []);
    });

    it('keeps the ids, trimmed and once each, in the order saved', () => {
        assert.deepEqual(parseAllowSenders('["17841400000000001"," 17841400000000002 ","17841400000000001"]'), ['17841400000000001', '17841400000000002']);
    });

    it('["*"] is everyone, and `*` among other ids makes it everyone', () => {
        assert.deepEqual(parseAllowSenders('["*"]'), ['*']);
        assert.deepEqual(parseAllowSenders('["17841400000000001"," * "]'), ['*']);
    });

    it('drops what is not a string (an id that is a JSON number has lost its digits) and blanks', () => {
        assert.deepEqual(parseAllowSenders('[17841400000000001, null, true, {}, "", "  ", "17841400000000009"]'), ['17841400000000009']);
    });

    it('reads what is not a list as nobody: text that is not JSON, an object, a bare string', () => {
        for (const raw of ['not json', '{"*":true}', '"*"', '*', 'true', '[']) assert.deepEqual(parseAllowSenders(raw), [], raw);
    });
});

describe('parseDailyUsd: 0 to 50, 3 when none is saved, and 0 for something that is not a number', () => {
    it('is the default when nothing is stored', () => {
        assert.equal(parseDailyUsd(null), MUSE_DAILY_USD_DEFAULT);
        assert.equal(MUSE_DAILY_USD_DEFAULT, 3);
        assert.equal(MUSE_DAILY_USD_MAX, 50);
    });

    it('keeps a number in range, 0 and the maximum included', () => {
        assert.equal(parseDailyUsd('0'), 0);
        assert.equal(parseDailyUsd('7.5'), 7.5);
        assert.equal(parseDailyUsd('10'), 10);
        assert.equal(parseDailyUsd('50'), 50);
    });

    it('clamps a number that is out of range: above the maximum is the maximum, below zero is zero', () => {
        assert.equal(parseDailyUsd('100'), 50);
        assert.equal(parseDailyUsd('50.01'), 50);
        assert.equal(parseDailyUsd('-3'), 0);
    });

    it('is 0, which refuses everything, for a value that is not a number: a typo must not become a bigger cap', () => {
        for (const raw of ['abc', 'NaN', 'Infinity', '-Infinity', '3 dollars', '$3']) assert.equal(parseDailyUsd(raw), 0, raw);
    });
});

describe('senderAllowed', () => {
    it('lets in a listed id and nobody else', () => {
        assert.equal(senderAllowed(['111', '222'], '111'), true);
        assert.equal(senderAllowed(['111', '222'], '333'), false);
    });

    it('lets in everyone for `*`', () => {
        assert.equal(senderAllowed([MUSE_ALL_SENDERS], '333'), true);
        assert.equal(senderAllowed(['111', MUSE_ALL_SENDERS], '333'), true);
    });

    it('lets in nobody for an empty list', () => {
        assert.equal(senderAllowed([], '111'), false);
    });

    it('is an exact match: a longer, shorter or padded id is another sender, and an empty id is nobody', () => {
        assert.equal(senderAllowed(['1111'], '111'), false);
        assert.equal(senderAllowed(['111'], '1111'), false);
        assert.equal(senderAllowed(['111'], ' 111'), false);
        assert.equal(senderAllowed([MUSE_ALL_SENDERS], ''), false);
        assert.equal(senderAllowed([''], ''), false);
    });
});

describe('capabilityOn', () => {
    it('reads one switch', () => {
        const settings = { switches: { dm_media: true, voice: false, memory: true } };
        assert.equal(capabilityOn(settings, 'dm_media'), true);
        assert.equal(capabilityOn(settings, 'voice'), false);
        assert.equal(capabilityOn(settings, 'memory'), true);
    });
});

describe('readMuseSettings', () => {
    it('is the product as it was when nothing is stored: all off, nobody allowed, a $3 cap', async () => {
        stubSettings({});
        assert.deepEqual(await readMuseSettings(TENANT), {
            switches: { dm_media: false, voice: false, memory: false }, allowSenders: [], dailyUsd: MUSE_DAILY_USD_DEFAULT,
        });
    });

    it('reads the tenant\'s own three rows, and no other tenant\'s', async () => {
        const store = {
            [`muse.switches.${TENANT}`]: '{"dm_media":true,"voice":true}',
            [`muse.allow_senders.${TENANT}`]: '["17841400000000001"]',
            [`muse.daily_usd.${TENANT}`]: '10',
            // Another tenant's, which must not leak in.
            [`muse.switches.${OTHER}`]: '{"memory":true}',
            [`muse.allow_senders.${OTHER}`]: '["*"]',
            [`muse.daily_usd.${OTHER}`]: '50',
        };
        const { asked } = stubSettings(store);
        assert.deepEqual(await readMuseSettings(TENANT), {
            switches: { dm_media: true, voice: true, memory: false }, allowSenders: ['17841400000000001'], dailyUsd: 10,
        });
        assert.deepEqual([...asked].sort(), [`muse.allow_senders.${TENANT}`, `muse.daily_usd.${TENANT}`, `muse.switches.${TENANT}`]);
    });

    it('builds its keys from the prefixes the settings table lists', async () => {
        assert.equal(tenantSettingKey(TENANT_SETTING_PREFIXES.museSwitches, TENANT), `muse.switches.${TENANT}`);
        assert.equal(tenantSettingKey(TENANT_SETTING_PREFIXES.museAllowSenders, TENANT), `muse.allow_senders.${TENANT}`);
        assert.equal(tenantSettingKey(TENANT_SETTING_PREFIXES.museDailyUsd, TENANT), `muse.daily_usd.${TENANT}`);
        // The key is 100 characters at most (app_settings.key is VARCHAR(100)): a uuid fits in every one.
        for (const prefix of Object.values(TENANT_SETTING_PREFIXES)) assert.ok(`${prefix}${TENANT}`.length <= 100, prefix);
    });

    it('a stored value that is garbage is that setting off, and the others are still read', async () => {
        stubSettings({
            [`muse.switches.${TENANT}`]: 'garbage',
            [`muse.allow_senders.${TENANT}`]: '["*"]',
            [`muse.daily_usd.${TENANT}`]: 'lots',
        });
        assert.deepEqual(await readMuseSettings(TENANT), {
            switches: { dm_media: false, voice: false, memory: false }, allowSenders: ['*'], dailyUsd: 0,
        });
    });

    it('fails toward off when the database cannot be read: every switch off, nobody allowed, nothing to spend, and it says so', async () => {
        (pool as any).query = async () => { throw new Error('connection terminated'); };
        assert.deepEqual(await readMuseSettings(TENANT), museSettingsOff());
        assert.deepEqual(await readMuseSettings(TENANT), { switches: { dm_media: false, voice: false, memory: false }, allowSenders: [], dailyUsd: 0 });
        const warned = logged.filter((l) => l.event === 'perception.settings_unreadable');
        assert.equal(warned.length, 2);
        assert.equal(warned[0]!.level, 'warn');
        assert.equal(warned[0]!['creator_id'], TENANT);
    });

    it('a tenant id that is not a tenant id is off, not a throw, and asks the database nothing', async () => {
        const { asked } = stubSettings({ 'muse.switches.x': '{"dm_media":true}' });
        for (const id of ['', 'a/b', 'x'.repeat(65), 'tenant id']) assert.deepEqual(await readMuseSettings(id), museSettingsOff(), JSON.stringify(id));
        assert.deepEqual(asked, []);
    });

    it('hands out a fresh object each time: changing one answer changes no other', async () => {
        const a = museSettingsOff();
        a.switches.dm_media = true;
        a.allowSenders.push('1');
        assert.deepEqual(museSettingsOff(), { switches: { dm_media: false, voice: false, memory: false }, allowSenders: [], dailyUsd: 0 });
    });
});
