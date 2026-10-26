/**
 * The operator scripts call Meta through the app's Graph version, and follow `META_API_VERSION` the way the app does.
 * The scripts cannot import the app's TypeScript, so the default is repeated in ./graph.mjs; this pins the two together.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_API_VERSION } from '../../src/services/instagram.ts';
import { DEFAULT_GRAPH_VERSION, graphBase, graphVersion } from './graph.mjs';

describe('the scripts\' Graph version', () => {
    it('is the app\'s default', () => {
        assert.equal(DEFAULT_GRAPH_VERSION, DEFAULT_API_VERSION);
        assert.equal(graphVersion({}), DEFAULT_API_VERSION);
    });

    it('follows META_API_VERSION, and ignores a value that is not a version, saying so', () => {
        assert.equal(graphVersion({ META_API_VERSION: ' v25.0 ' }), 'v25.0');
        const warnings = [];
        assert.equal(graphVersion({ META_API_VERSION: '26' }, (m) => warnings.push(m)), DEFAULT_GRAPH_VERSION);
        assert.equal(warnings.length, 1);
        assert.equal(graphBase({ META_API_VERSION: 'v25.0' }), 'https://graph.facebook.com/v25.0');
    });

    it('is the only version diagnose.mjs and exchange-token.mjs use', () => {
        for (const script of ['scripts/diagnose.mjs', 'scripts/exchange-token.mjs']) {
            const source = readFileSync(script, 'utf8');
            assert.doesNotMatch(source, /['"`]v\d+\.\d+['"`]|graph\.facebook\.com\/v\d/, `${script} pins its own Graph version`);
            assert.match(source, /from '\.\/lib\/graph\.mjs'/, `${script} does not use scripts/lib/graph.mjs`);
        }
    });
});
