/**
 * A log field must not be named like a secret unless it is one.
 *
 * The logger blanks a field by its NAME (`REDACT_KEY`, ./log.ts), whatever the value holds. So a count named `total_tokens`, a
 * status named `token_status` and a boolean named `has_cookie` all printed `[redacted]`, and nothing said so: the line was
 * there, only the number was not. `ai.usage` measured the DM bot's AI cost that way for a month, and the signature rejection's
 * two diagnostics went the same way until PR #261. This reads every `log()` call in `src/` and fails on a field it writes whose
 * name the redaction matches. A secret should not be handed to `log()` at all: the redaction is the net under spread objects and
 * error objects, not a way to log one.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { log, REDACT_KEY, setLogSink } from './log.js';

interface LoggedFields {
    file: string;
    line: number;
    event: string;
    keys: string[];
}

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
    }
    return out;
}

/** From the `{` at `start`, the object literal up to its matching `}`, stepping over strings and template literals. */
function objectLiteral(src: string, start: number): string {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const c = src[i]!;
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
        else if (c === "'" || c === '"' || c === '`') {
            for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
        }
    }
    return src.slice(start);
}

/** Every `log(level, event, { … })` in one file, with the field names its literal writes, at any depth. */
function loggedFields(file: string, src: string): LoggedFields[] {
    const out: LoggedFields[] = [];
    for (const m of src.matchAll(/\blog\(\s*'(?:debug|info|warn|error)'\s*,\s*(['`])([^'`]+)\1\s*,\s*\{/g)) {
        const literal = objectLiteral(src, m.index! + m[0].length - 1);
        const keys = new Set<string>();
        for (const k of literal.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.add(k[1]!);
        for (const k of literal.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) keys.add(k[1]!);
        out.push({ file, line: src.slice(0, m.index).split('\n').length, event: m[2]!, keys: [...keys] });
    }
    return out;
}

describe('log field names', () => {
    it('finds the fields of a log call, nested ones and shorthand ones included', () => {
        const found = loggedFields('fixture.ts', [
            "log('info', 'ai.usage', { model, total_tokens: n, nested: { has_cookie: true }, ok: `a${b}` });",
            "log('warn', `ads.alert_${kind}`, { token_status: s });",
            "log('info', 'plain.event');",
        ].join('\n'));
        assert.deepEqual(found.map((f) => [f.event, f.line, f.keys.filter((k) => REDACT_KEY.test(k)).sort()]), [
            ['ai.usage', 1, ['has_cookie', 'total_tokens']],
            ['ads.alert_${kind}', 2, ['token_status']],
        ]);
    });

    it('no field written at a log() call in src/ is named so the logger blanks it', () => {
        const calls = sourceFiles('src').flatMap((file) => loggedFields(file, readFileSync(file, 'utf8')));
        // The scan must be reading the real calls: a broken pattern would find none and pass.
        assert.ok(calls.length > 500, `only ${calls.length} log() calls with fields found`);
        const blanked = calls.flatMap((c) => c.keys.filter((k) => REDACT_KEY.test(k)).map((k) => `${c.file}:${c.line} ${c.event} → ${k}`));
        assert.deepEqual(blanked, [], 'these fields print [redacted]: name them for what they hold, or do not log a secret at all');
    });

    it('prints the renamed fields', () => {
        const lines: string[] = [];
        const previous = setLogSink((_level, line) => lines.push(line));
        try {
            log('info', 'ai.usage', { usage_in: 2100, usage_out: 140, usage_total: 2240, usage_cache_read: 0 });
            log('info', 'token.rechecked', { status: 'valid', type: 'PAGE' });
            log('warn', 'meta.oauth_state_mismatch', { browser_state: 'missing' });
        } finally {
            setLogSink(previous);
        }
        const [usage, recheck, mismatch] = lines.map((l) => JSON.parse(l));
        assert.equal(usage.usage_in, 2100);
        assert.equal(usage.usage_total, 2240);
        assert.equal(recheck.status, 'valid');
        assert.equal(mismatch.browser_state, 'missing');
        assert.ok(!lines.join('\n').includes('[redacted]'));
    });
});
