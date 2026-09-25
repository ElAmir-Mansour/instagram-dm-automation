/**
 * `GET /api/growth/status`'s permission states, from the pure `composeStatus`: what each platform
 * can give, which permission is missing, and the one-line fix the banner shows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GrowthSyncState } from '../../db/rows.js';
import { composeStatus, type StatusInput } from './status.js';

const BOTH = { instagram: true, facebook: true };
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
    connected: BOTH, hasToken: true, inspection: { isValid: true, scopes: [], error: null }, state: null, tiktokConnected: false, ...over,
});
const synced = (over: Partial<GrowthSyncState> = {}): GrowthSyncState => {
    const platform = { status: 'ok' as const, posts: 0, with_insights: 0, days: 0, throttled: false, error: null };
    return { finished_at: '2026-09-25T00:00:00.000Z', instagram: platform, facebook: platform, scopes: null, missing: [], ...over };
};

describe('composeStatus', () => {
    it('names both insights permissions, and the fix, when the token has neither', () => {
        const s = composeStatus(input({ inspection: { isValid: true, scopes: ['instagram_basic', 'pages_read_engagement'], error: null } }));
        assert.equal(s.instagram, 'missing_permission');
        assert.equal(s.facebook, 'missing_permission');
        assert.deepEqual(s.missing, ['instagram_manage_insights', 'read_insights']);
        assert.match(s.fix!, /instagram_manage_insights and read_insights/);
        assert.match(s.fix!, /docs\/TOKEN_GUIDE\.md/);
        assert.equal(s.checked, true);
    });

    it('is ok with no fix once the token carries both', () => {
        const s = composeStatus(input({ inspection: { isValid: true, scopes: ['instagram_manage_insights', 'read_insights'], error: null } }));
        assert.deepEqual([s.instagram, s.facebook, s.missing, s.fix], ['ok', 'ok', [], null]);
    });

    it('says not_connected, with the reason, for no token or a dead one', () => {
        const none = composeStatus(input({ hasToken: false, inspection: null }));
        assert.deepEqual([none.instagram, none.facebook], ['not_connected', 'not_connected']);
        assert.match(none.tokenError!, /No access token/);
        const dead = composeStatus(input({ inspection: { isValid: false, scopes: [], error: 'Meta reports the token as not valid: expired' } }));
        assert.equal(dead.instagram, 'not_connected');
        assert.match(dead.tokenError!, /expired/);
        assert.deepEqual(dead.missing, [], 'a dead token is not a missing permission');
    });

    it('leaves a platform with no account out of the missing list', () => {
        const s = composeStatus(input({ connected: { instagram: true, facebook: false } }));
        assert.equal(s.facebook, 'not_connected');
        assert.deepEqual(s.missing, ['instagram_manage_insights']);
    });

    it('falls back to the last sync when debug_token can’t be asked', () => {
        const s = composeStatus(input({
            inspection: null,
            state: synced({ instagram: { status: 'missing_permission', posts: 46, with_insights: 0, days: 1, throttled: false, error: null } }),
        }));
        assert.equal(s.checked, false);
        assert.equal(s.instagram, 'missing_permission');
        assert.equal(s.facebook, 'ok');
        assert.equal(s.lastSync, '2026-09-25T00:00:00.000Z');

        const fromScopes = composeStatus(input({ inspection: null, state: synced({ scopes: ['read_insights'] }) }));
        assert.deepEqual([fromScopes.instagram, fromScopes.facebook], ['missing_permission', 'ok'], 'the last sync’s scopes');
    });

    it('reports TikTok as unavailable with the scopes it would need, once connected', () => {
        assert.equal(composeStatus(input()).tiktok, 'not_connected');
        const s = composeStatus(input({ tiktokConnected: true }));
        assert.equal(s.tiktok, 'unavailable');
        assert.deepEqual(s.tiktokMissing, ['video.list', 'user.info.stats']);
        assert.deepEqual(s.missing.filter((m) => m.startsWith('video') || m.startsWith('user')), [], 'the Meta banner never asks for TikTok scopes');
    });
});
