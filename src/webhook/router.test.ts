/**
 * Turning one Meta delivery into jobs.
 *
 * `planJobs` is pure on purpose: it is the step that runs before the 200 goes back to Meta,
 * so it must not be able to throw on a shape nobody anticipated, and it must produce a
 * dedupe key that actually matches what Meta will redeliver. Both are checked here against
 * the real payload shapes — Instagram and Facebook name nothing the same way, which is the
 * source of most of the special cases below.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { setJobQueue } from '../jobs/queue.js';
import type { EnqueueInput, JobQueue } from '../jobs/types.js';
import { enqueueWebhookBody, planJobs } from './router.js';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

/** An Instagram comment delivery, as Meta sends it. */
const igComment = {
    object: 'instagram',
    entry: [{
        id: 'ig-page-1',
        changes: [{
            field: 'comments',
            value: { id: 'ig-comment-1', text: 'اريد كورس', from: { id: 'u1', username: 'ali' }, media: { id: 'm1' } },
        }],
    }],
};

/** A Facebook Page comment delivery — different field, different id key. */
const fbComment = {
    object: 'page',
    entry: [{
        id: 'fb-page-1',
        changes: [{
            field: 'feed',
            value: { item: 'comment', verb: 'add', comment_id: 'fb-comment-1', post_id: 'p1', message: 'hi' },
        }],
    }],
};

const dmDelivery = {
    object: 'instagram',
    entry: [{
        id: 'ig-page-1',
        messaging: [{ sender: { id: 'u9' }, recipient: { id: 'ig-page-1' }, message: { mid: 'mid-1', text: 'hello' } }],
    }],
};

describe('planJobs', () => {
    it('turns an Instagram comment into one comment job keyed on value.id', () => {
        const planned = planJobs(igComment);
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'comment.process');
        assert.equal(planned[0]!.dedupeKey, 'comment:ig-comment-1');
        assert.deepEqual(planned[0]!.payload, {
            change: igComment.entry[0]!.changes[0],
            entryId: 'ig-page-1',
        });
    });

    it('turns a Facebook comment into one comment job keyed on value.comment_id', () => {
        const planned = planJobs(fbComment);
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.dedupeKey, 'comment:fb-comment-1');
        assert.equal((planned[0]!.payload as any).entryId, 'fb-page-1');
    });

    it('turns a DM into one job keyed on the Meta message id', () => {
        const planned = planJobs(dmDelivery);
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'dm.process');
        assert.equal(planned[0]!.dedupeKey, 'dm:mid-1');
    });

    it('keys a postback on its own mid', () => {
        const planned = planJobs({
            entry: [{ id: 'p', messaging: [{ postback: { mid: 'mid-pb', payload: 'GO' } }] }],
        });
        assert.equal(planned[0]!.dedupeKey, 'dm:mid-pb');
    });

    it('drops echo messages before they become jobs', () => {
        // The page's own outbound messages come back as events. On an active account these
        // are a large share of all messaging traffic, and every one of them would otherwise
        // be a row in `jobs` that exists only to be discarded by the handler.
        const planned = planJobs({
            entry: [{
                id: 'p',
                messaging: [
                    { message: { mid: 'a', is_echo: true, text: 'ours' } },
                    { message: { mid: 'b', text: 'theirs' } },
                ],
            }],
        });
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.dedupeKey, 'dm:b');
    });

    it('enqueues without a dedupe key rather than dropping an event that has no id', () => {
        // Losing the event is far worse than processing it twice: the row-level
        // `interactions.comment_id UNIQUE` claim still catches a redelivery one layer down.
        const planned = planJobs({
            entry: [{ id: 'p', changes: [{ field: 'comments', value: { text: 'no id here' } }] }],
        });
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.dedupeKey, undefined);
    });

    it('handles an entry carrying both messaging and changes', () => {
        const planned = planJobs({
            entry: [{
                id: 'p',
                messaging: [{ message: { mid: 'm1', text: 'x' } }],
                changes: [{ field: 'comments', value: { id: 'c1' } }],
            }],
        });
        assert.deepEqual(planned.map((p) => p.kind), ['dm.process', 'comment.process']);
    });

    it('flattens several entries in one delivery', () => {
        const planned = planJobs({
            entry: [
                { id: 'p1', changes: [{ field: 'comments', value: { id: 'c1' } }] },
                { id: 'p2', changes: [{ field: 'comments', value: { id: 'c2' } }] },
            ],
        });
        assert.deepEqual(planned.map((p) => p.dedupeKey), ['comment:c1', 'comment:c2']);
        assert.deepEqual(planned.map((p) => (p.payload as any).entryId), ['p1', 'p2']);
    });

    it('returns nothing rather than throwing on malformed bodies', () => {
        // This runs before Meta is acknowledged. An exception here is a 500, and a 500 is a
        // redelivery storm.
        for (const body of [undefined, null, {}, { entry: null }, { entry: 'nope' }, { entry: [] }, { entry: [null] }]) {
            assert.deepEqual(planJobs(body), [], `failed on ${JSON.stringify(body)}`);
        }
    });

    it('stores the change verbatim so a fixed parser can be replayed against it', () => {
        // Normalising before the queue would mean a bug in the normaliser is unrecoverable:
        // the original is gone.
        const weird = { field: 'comments', value: { id: 'c1', something_new: { nested: true } } };
        const planned = planJobs({ entry: [{ id: 'p', changes: [weird] }] });
        assert.deepEqual((planned[0]!.payload as any).change, weird);
    });
});

/** A queue that records enqueues and can be told to dedupe or to fail. */
function recordingQueue(behaviour: 'ok' | 'dedupe' | 'throw' = 'ok'): JobQueue & { calls: EnqueueInput[] } {
    const calls: EnqueueInput[] = [];
    return {
        calls,
        async enqueue(input) {
            calls.push(input as EnqueueInput);
            if (behaviour === 'throw') throw new Error('jobs table does not exist');
            return behaviour === 'dedupe' ? null : 'job-id';
        },
        async claim() { return []; },
        async complete() {},
        async fail() {},
        async reapStale() { return 0; },
    };
}

describe('enqueueWebhookBody', () => {
    it('enqueues every planned job and carries the correlation id', async () => {
        const queue = recordingQueue();
        const previous = setJobQueue(queue);
        try {
            const result = await enqueueWebhookBody(igComment, 'req-abc');
            assert.deepEqual(result, { planned: 1, enqueued: 1, deduped: 0 });
            assert.equal(queue.calls[0]!.requestId, 'req-abc');
        } finally {
            setJobQueue(previous);
        }
    });

    it('counts a deduplicated enqueue separately from a real one', async () => {
        const queue = recordingQueue('dedupe');
        const previous = setJobQueue(queue);
        try {
            const result = await enqueueWebhookBody(igComment);
            assert.deepEqual(result, { planned: 1, enqueued: 0, deduped: 1 });
        } finally {
            setJobQueue(previous);
        }
    });

    it('reports nothing to do for a body with no events', async () => {
        const queue = recordingQueue();
        const previous = setJobQueue(queue);
        try {
            const result = await enqueueWebhookBody({ object: 'instagram', entry: [] });
            assert.deepEqual(result, { planned: 0, enqueued: 0, deduped: 0 });
            assert.equal(queue.calls.length, 0);
        } finally {
            setJobQueue(previous);
        }
    });

    it('propagates a queue failure so the caller can fall back to the inline path', async () => {
        // Deliberate: the webhook catches this and processes inline instead. Swallowing it
        // here would mean the delivery is silently dropped, which is the one outcome worse
        // than doing the work on Meta's clock.
        const queue = recordingQueue('throw');
        const previous = setJobQueue(queue);
        try {
            await assert.rejects(() => enqueueWebhookBody(igComment), /jobs table does not exist/);
        } finally {
            setJobQueue(previous);
        }
    });
});
