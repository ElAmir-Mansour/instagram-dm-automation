import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
    currentLogContext,
    currentRequestId,
    describeError,
    isLevelEnabled,
    log,
    newRequestId,
    setLogSink,
    withLogContext,
    type LogLevel,
} from './log.js';

/** Collect emitted lines, already parsed — every assertion below is about fields, not text. */
function capture(): { lines: Array<Record<string, any>>; levels: LogLevel[]; restore: () => void } {
    const lines: Array<Record<string, any>> = [];
    const levels: LogLevel[] = [];
    const previous = setLogSink((level, line) => {
        levels.push(level);
        lines.push(JSON.parse(line));
    });
    return { lines, levels, restore: () => setLogSink(previous) };
}

const originalLevel = process.env.LOG_LEVEL;
const originalStacks = process.env.LOG_STACKS;

afterEach(() => {
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    if (originalStacks === undefined) delete process.env.LOG_STACKS;
    else process.env.LOG_STACKS = originalStacks;
});

describe('log', () => {
    it('emits one parseable JSON object per call', () => {
        const cap = capture();
        try {
            log('info', 'test.event', { comment_id: 'c1', count: 3 });
        } finally {
            cap.restore();
        }

        assert.equal(cap.lines.length, 1);
        const line = cap.lines[0]!;
        assert.equal(line['event'], 'test.event');
        assert.equal(line['level'], 'info');
        assert.equal(line['comment_id'], 'c1');
        assert.equal(line['count'], 3);
        assert.ok(typeof line['ts'] === 'string' && !Number.isNaN(Date.parse(line['ts'])));
    });

    it('sends warn and error to the error stream and everything else to stdout', () => {
        const cap = capture();
        try {
            log('info', 'a');
            log('warn', 'b');
            log('error', 'c');
        } finally {
            cap.restore();
        }
        assert.deepEqual(cap.levels, ['info', 'warn', 'error']);
    });

    it('drops lines below the configured level', () => {
        process.env.LOG_LEVEL = 'warn';
        const cap = capture();
        try {
            log('debug', 'dropped');
            log('info', 'dropped');
            log('warn', 'kept');
            log('error', 'kept');
        } finally {
            cap.restore();
        }
        assert.deepEqual(cap.lines.map((l) => l['event']), ['kept', 'kept']);
    });

    it('defaults to info when LOG_LEVEL is unset or nonsense', () => {
        delete process.env.LOG_LEVEL;
        assert.equal(isLevelEnabled('debug'), false);
        assert.equal(isLevelEnabled('info'), true);

        process.env.LOG_LEVEL = 'chatty';
        assert.equal(isLevelEnabled('debug'), false);
        assert.equal(isLevelEnabled('info'), true);
    });

    it('redacts fields whose names look like secrets', () => {
        const cap = capture();
        try {
            log('info', 'token.read', {
                page_access_token: 'EAAG-real-token',
                app_secret: 'hunter2',
                authorization: 'Bearer abc',
                creator_id: 'safe',
            });
        } finally {
            cap.restore();
        }

        const line = cap.lines[0]!;
        assert.equal(line['page_access_token'], '[redacted]');
        assert.equal(line['app_secret'], '[redacted]');
        assert.equal(line['authorization'], '[redacted]');
        assert.equal(line['creator_id'], 'safe');
    });

    it('redacts secret-looking keys nested inside an object', () => {
        const cap = capture();
        try {
            log('info', 'nested', { config: { headers: { 'x-goog-api-key': 'AIza-real' } } });
        } finally {
            cap.restore();
        }
        assert.equal(cap.lines[0]!['config'].headers['x-goog-api-key'], '[redacted]');
    });

    it('survives a circular structure instead of throwing', () => {
        // An axios error holds request -> response -> config -> request. Logging one used to
        // be a TypeError inside a catch block, which is the worst possible place for one.
        const circular: any = { name: 'outer' };
        circular.self = circular;

        const cap = capture();
        try {
            log('error', 'circular.test', { payload: circular });
        } finally {
            cap.restore();
        }

        assert.equal(cap.lines.length, 1);
        assert.equal(cap.lines[0]!['payload'].self, '[circular]');
    });

    it('serialises BigInt rather than throwing', () => {
        const cap = capture();
        try {
            log('info', 'bigint.test', { n: 10n });
        } finally {
            cap.restore();
        }
        assert.equal(cap.lines[0]!['n'], '10');
    });

    it('keeps four levels of nesting and truncates below that', () => {
        // Stops a whole webhook body or an axios config from becoming a 40KB log line, while
        // leaving room for the shapes actually logged here (an error with a nested Meta error).
        const cap = capture();
        try {
            log('info', 'deep', { a: { b: { c: { d: { e: { f: 'too far' } } } } } });
        } finally {
            cap.restore();
        }
        const a = cap.lines[0]!['a'];
        assert.equal(a.b.c.d.e, '[truncated]');
    });

    it('omits undefined fields but keeps null', () => {
        const cap = capture();
        try {
            log('info', 'sparse', { present: 1, absent: undefined, explicit: null });
        } finally {
            cap.restore();
        }
        const line = cap.lines[0]!;
        assert.ok(!('absent' in line));
        assert.equal(line['explicit'], null);
    });

    it('never throws even if the sink does', () => {
        const previous = setLogSink(() => {
            throw new Error('sink exploded');
        });
        try {
            assert.doesNotThrow(() => log('error', 'boom'));
        } finally {
            setLogSink(previous);
        }
    });
});

describe('withLogContext', () => {
    it('attaches context fields to every line inside it', () => {
        const cap = capture();
        try {
            withLogContext({ request_id: 'req-1' }, () => {
                log('info', 'inside');
            });
            log('info', 'outside');
        } finally {
            cap.restore();
        }

        assert.equal(cap.lines[0]!['request_id'], 'req-1');
        assert.ok(!('request_id' in cap.lines[1]!));
    });

    it('survives an await boundary — the whole point of using AsyncLocalStorage', async () => {
        const cap = capture();
        try {
            await withLogContext({ request_id: 'req-async' }, async () => {
                await new Promise((r) => setTimeout(r, 1));
                log('info', 'after.await');
            });
        } finally {
            cap.restore();
        }
        assert.equal(cap.lines[0]!['request_id'], 'req-async');
    });

    it('merges nested context instead of replacing it', () => {
        const cap = capture();
        try {
            withLogContext({ request_id: 'req-1' }, () => {
                withLogContext({ job_id: 'job-9' }, () => {
                    log('info', 'nested');
                });
            });
        } finally {
            cap.restore();
        }
        const line = cap.lines[0]!;
        assert.equal(line['request_id'], 'req-1');
        assert.equal(line['job_id'], 'job-9');
    });

    it('lets an explicit field override the ambient one', () => {
        const cap = capture();
        try {
            withLogContext({ creator_id: 'ambient' }, () => {
                log('info', 'override', { creator_id: 'explicit' });
            });
        } finally {
            cap.restore();
        }
        assert.equal(cap.lines[0]!['creator_id'], 'explicit');
    });

    it('does not leak context to sibling calls', () => {
        const cap = capture();
        try {
            withLogContext({ request_id: 'a' }, () => log('info', 'first'));
            withLogContext({ request_id: 'b' }, () => log('info', 'second'));
        } finally {
            cap.restore();
        }
        assert.equal(cap.lines[0]!['request_id'], 'a');
        assert.equal(cap.lines[1]!['request_id'], 'b');
    });

    it('exposes the current context and request id', () => {
        withLogContext({ request_id: 'req-x', creator_id: 'c1' }, () => {
            assert.equal(currentRequestId(), 'req-x');
            assert.deepEqual(currentLogContext(), { request_id: 'req-x', creator_id: 'c1' });
        });
        assert.equal(currentRequestId(), undefined);
        assert.deepEqual(currentLogContext(), {});
    });
});

describe('newRequestId', () => {
    it('produces distinct 16-character hex ids', () => {
        const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
        assert.equal(ids.size, 200);
        for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
    });
});

describe('describeError', () => {
    it('flattens a plain Error', () => {
        const fields = describeError(new TypeError('nope'));
        assert.equal(fields['message'], 'nope');
        assert.equal(fields['name'], 'TypeError');
    });

    it('handles a thrown non-Error', () => {
        assert.equal(describeError('just a string')['message'], 'just a string');
    });

    it('lifts the Meta error code out of an axios failure', () => {
        // This is the field that distinguishes "dead token" (190) from "missing permission"
        // (200) from "user blocked DMs" (10903) — three different operator actions that the
        // existing `err.message` logging renders as one indistinguishable string.
        const axiosish: any = new Error('Request failed with status code 400');
        axiosish.response = {
            status: 400,
            data: { error: { code: 190, error_subcode: 460, message: 'Session expired', type: 'OAuthException' } },
        };

        const fields = describeError(axiosish);
        assert.equal(fields['http_status'], 400);
        assert.equal(fields['meta_code'], 190);
        assert.equal(fields['meta_subcode'], 460);
        assert.equal(fields['meta_message'], 'Session expired');
        assert.equal(fields['meta_type'], 'OAuthException');
    });

    it('keeps a network error code', () => {
        const netErr: any = new Error('socket hang up');
        netErr.code = 'ECONNRESET';
        assert.equal(describeError(netErr)['code'], 'ECONNRESET');
    });

    it('omits the stack unless LOG_STACKS is set', () => {
        const err = new Error('with stack');
        delete process.env.LOG_STACKS;
        assert.ok(!('stack' in describeError(err)));

        process.env.LOG_STACKS = '1';
        assert.ok(typeof describeError(err)['stack'] === 'string');
    });
});
