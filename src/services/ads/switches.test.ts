/** The two A3 switches: read strictly (anything odd is off), written per field, validated per field. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { ADS_SWITCHES_OFF, parseExtendedWindow, parseSwitchesInput, readAdsSwitches, writeAdsSwitches } from './switches.js';

async function withSettings<T>(store: Map<string, string>, run: () => Promise<T>): Promise<T> {
    const original = pool.query;
    (pool as any).query = async (text: string, params: any[] = []) => {
        if (/SELECT value, is_secret FROM app_settings WHERE key = \$1/.test(text)) {
            const v = store.get(params[0]);
            return { rows: v === undefined ? [] : [{ value: v, is_secret: false }], rowCount: v === undefined ? 0 : 1 };
        }
        if (/INSERT INTO app_settings/.test(text)) { store.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
        if (/DELETE FROM app_settings/.test(text)) { store.delete(params[0]); return { rows: [], rowCount: 1 }; }
        throw new Error(`unexpected SQL ${text}`);
    };
    try {
        return await run();
    } finally {
        (pool as any).query = original;
    }
}

describe('parseExtendedWindow', () => {
    it('only real booleans count; anything else is off', () => {
        assert.deepEqual(parseExtendedWindow(null), { instagram: false, messenger: false });
        assert.deepEqual(parseExtendedWindow('{"instagram":true}'), { instagram: true, messenger: false });
        assert.deepEqual(parseExtendedWindow('{"instagram":"true","messenger":1}'), { instagram: false, messenger: false });
        assert.deepEqual(parseExtendedWindow('not json'), { instagram: false, messenger: false });
    });
});

describe('parseSwitchesInput', () => {
    it('takes either switch, each a boolean, and names the field that is not', () => {
        assert.deepEqual(parseSwitchesInput({ botContext: true }), { ok: true, value: { botContext: true } });
        assert.deepEqual(parseSwitchesInput({ extendedWindow: { messenger: false } }), { ok: true, value: { extendedWindow: { messenger: false } } });
        assert.deepEqual(parseSwitchesInput({ botContext: 'yes' }), { ok: false, field: 'botContext' });
        assert.deepEqual(parseSwitchesInput({ extendedWindow: { instagram: 'on' } }), { ok: false, field: 'extendedWindow.instagram' });
        assert.deepEqual(parseSwitchesInput({ extendedWindow: [] }), { ok: false, field: 'extendedWindow' });
        assert.deepEqual(parseSwitchesInput({}), { ok: false, field: 'botContext' });
        assert.deepEqual(parseSwitchesInput(null), { ok: false, field: 'botContext' });
    });
});

describe('readAdsSwitches and writeAdsSwitches', () => {
    it('both off when nothing is stored', async () => {
        assert.deepEqual(await withSettings(new Map(), () => readAdsSwitches('t1')), ADS_SWITCHES_OFF);
    });

    it('writes per field, keeps the rest, and stores an all-off window as nothing', async () => {
        const store = new Map<string, string>();
        await withSettings(store, async () => {
            assert.deepEqual(await writeAdsSwitches('t1', { botContext: true }, 'u'), { botContext: true, extendedWindow: { instagram: false, messenger: false } });
            assert.equal(store.get('ads.bot_context.t1'), 'on');
            await writeAdsSwitches('t1', { extendedWindow: { instagram: true } }, 'u');
            await writeAdsSwitches('t1', { extendedWindow: { messenger: true } }, 'u');
            assert.deepEqual(JSON.parse(store.get('ads.extended_window.t1')!), { instagram: true, messenger: true });
            await writeAdsSwitches('t1', { botContext: false, extendedWindow: { instagram: false, messenger: false } }, 'u');
        });
        assert.equal(store.has('ads.bot_context.t1'), false);
        assert.equal(store.has('ads.extended_window.t1'), false);
    });

    it('a database that cannot be read is off, never an error', async () => {
        const original = pool.query;
        (pool as any).query = async () => { throw new Error('down'); };
        try {
            assert.deepEqual(await readAdsSwitches('t1'), ADS_SWITCHES_OFF);
        } finally {
            (pool as any).query = original;
        }
    });
});
