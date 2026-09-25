/**
 * What the app refuses to start without.
 *
 * `validateEnv` failing turns every route into a 503 (src/index.ts), so each entry on the
 * required list is a promise that the app is useless without that variable. GEMINI_API_KEY
 * stopped being one when the key moved to the Operations screen: required here, deleting it
 * from Vercel after saving a key in the dashboard would take down webhooks, publishing and the
 * dashboard over a missing AI key.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { validateEnv } from './env.js';

const REQUIRED = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    META_VERIFY_TOKEN: 'verify-token',
    META_APP_SECRET: 'meta-app-secret',
    INSTAGRAM_APP_SECRET: 'instagram-app-secret',
    DASHBOARD_PASSWORD: 'not-the-published-default',
    CRON_SECRET: 'cron-secret',
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = Object.fromEntries([...Object.keys(REQUIRED), 'GEMINI_API_KEY'].map((k) => [k, process.env[k]]));
    Object.assign(process.env, REQUIRED);
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

describe('validateEnv', () => {
    it('starts without GEMINI_API_KEY — the Gemini key can live on the Operations screen instead', () => {
        delete process.env.GEMINI_API_KEY;
        assert.doesNotThrow(() => validateEnv());
    });

    it('still refuses to start without a variable the app cannot run without', () => {
        delete process.env.CRON_SECRET;
        assert.throws(() => validateEnv(), /CRON_SECRET/);
    });
});
