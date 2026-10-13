/**
 * What the draft engine's pure half (P21 and P23) may depend on. It has no database and no settings, and exactly one module opens a
 * socket, so "every read of a tenant-supplied address goes through `safeFetch`" is a fact about the imports and not only a habit.
 * The list is explicit: the other draft-engine modules (the Instagram and YouTube sources, the state machine) talk to Meta, Google
 * and the database by design and are not held to this.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

const DIR = new URL('./', import.meta.url);

const PURE_MODULES = [
    'brand.ts', 'captions.ts', 'colour.ts', 'discoveryProbe.ts', 'draftPrompt.ts', 'draftSchema.ts', 'draftSignals.ts', 'fence.ts', 'geo.ts', 'handles.ts', 'html.ts',
    'igMap.ts', 'imageSniff.ts', 'netGuard.ts', 'register.ts', 'robots.ts', 'safeFetch.ts', 'siteExtract.ts', 'socials.ts', 'sourceError.ts', 'textClean.ts',
    'validateDraft.ts', 'website.ts', 'ytMap.ts',
];

const importsOf = (file: string): string[] =>
    (fs.readFileSync(new URL(file, DIR), 'utf8').match(/^\s*(?:import|export)\b[^\n]*\bfrom\b\s*['"][^'"]+['"]/gm) ?? []).map((l) => l.match(/['"]([^'"]+)['"]/)![1]!);

describe('the draft engine\'s pure half', () => {
    it('exists, every module of it', () => {
        for (const file of PURE_MODULES) assert.ok(fs.existsSync(new URL(file, DIR)), file);
    });

    it('imports no database, no HTTP client, no settings and nothing that reads either', () => {
        for (const file of PURE_MODULES) {
            for (const spec of importsOf(file)) {
                assert.doesNotMatch(spec, /config\/db|^pg$|axios|appSettings|services\/http|\/store\.js|\/patch\.js|studio\/(?:settings|common|jobs|drafts)|monteur\/|growth\/|webhook\/|jobs\//, `${file} imports ${spec}`);
            }
        }
    });

    it('lets only safeFetch.ts open a socket or ask DNS anything', () => {
        for (const file of PURE_MODULES) {
            const sockets = importsOf(file).filter((spec) => /^node:(?:http|https|http2|net|tls|dns|dns\/promises|dgram|child_process|worker_threads)$/.test(spec));
            if (file === 'safeFetch.ts') assert.deepEqual(sockets.sort(), ['node:dns/promises', 'node:http', 'node:https']);
            else assert.deepEqual(sockets, [], `${file} imports ${sockets.join()}`);
        }
    });

    it('never calls fetch, XMLHttpRequest or WebSocket: nothing but safeFetch reads a tenant\'s address', () => {
        for (const file of PURE_MODULES) {
            const source = fs.readFileSync(new URL(file, DIR), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(source, /(?<![.\w])fetch\s*\(|XMLHttpRequest|new WebSocket|globalThis\.fetch/, file);
        }
    });

    it('does not name the draft table: nothing outside the state machine reads or writes profile_drafts', () => {
        for (const file of PURE_MODULES) assert.doesNotMatch(fs.readFileSync(new URL(file, DIR), 'utf8'), /profile_drafts/, file);
    });
});
