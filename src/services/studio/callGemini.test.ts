/**
 * The Studio's Gemini call uses the platform's key — the same one the DM bot answers with.
 *
 * generate.test.ts disables the model call for its whole file, so this one drives the real
 * `callGemini` with axios and the database stubbed: which key goes out, and what happens with
 * none at all.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { encryptSecret } from '../../config/crypto.js';
import { MISSING_GEMINI_KEY } from '../appSettings.js';
import { setLogSink } from '../../utils/log.js';
import { callGemini, type ModelRequest } from './generate.js';

const REQUEST: ModelRequest = {
    purpose: 'draft', system: 's', turns: [{ role: 'user', text: 'u' }],
    schema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } },
    temperature: 0.5, thinkingBudget: 128, timeoutMs: 5_000,
};

let sentKeys: unknown[];
let savedRow: { value: string; is_secret: boolean } | null;
const restore: Array<() => void> = [];

beforeEach(() => {
    sentKeys = [];
    savedRow = null;
    const original = { query: pool.query, post: axios.post, gemini: process.env.GEMINI_API_KEY, enc: process.env.TOKEN_ENCRYPTION_KEY };
    const previousSink = setLogSink(() => {});
    process.env.TOKEN_ENCRYPTION_KEY = '12'.repeat(32);
    (pool as unknown as { query: unknown }).query = async (sql: string) => {
        assert.match(sql, /FROM app_settings WHERE key = \$1/);
        return { rows: savedRow ? [savedRow] : [], rowCount: savedRow ? 1 : 0 };
    };
    (axios as any).post = async (_url: string, _body: unknown, config: any) => {
        sentKeys.push(config?.headers?.['x-goog-api-key']);
        return { data: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] } };
    };
    restore.push(() => {
        (pool as unknown as { query: unknown }).query = original.query;
        (axios as any).post = original.post;
        setLogSink(previousSink);
        for (const [name, value] of [['GEMINI_API_KEY', original.gemini], ['TOKEN_ENCRYPTION_KEY', original.enc]] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
});

afterEach(() => { while (restore.length) restore.pop()!(); });

describe('callGemini — the key', () => {
    it('writes with the key saved on the Operations screen, over GEMINI_API_KEY', async () => {
        process.env.GEMINI_API_KEY = 'AIza-the-environment-one';
        savedRow = { value: encryptSecret('AIza-saved-on-operations'), is_secret: true };

        assert.deepEqual(await callGemini(REQUEST), { ok: true });
        assert.deepEqual(sentKeys, ['AIza-saved-on-operations']);
    });

    it('falls back to GEMINI_API_KEY while nothing is saved', async () => {
        process.env.GEMINI_API_KEY = 'AIza-the-environment-one';

        await callGemini(REQUEST);
        assert.deepEqual(sentKeys, ['AIza-the-environment-one']);
    });

    it('fails without calling Google, and not as a retry, when there is no key anywhere', async () => {
        delete process.env.GEMINI_API_KEY;

        await assert.rejects(callGemini(REQUEST), (err: Error & { retryable?: boolean }) => {
            assert.equal(err.message, MISSING_GEMINI_KEY);
            assert.equal(err.retryable, false, 'retrying cannot conjure a key');
            return true;
        });
        assert.deepEqual(sentKeys, []);
    });
});
