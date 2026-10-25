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
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLogSink } from '../utils/log.js';
import { setJobQueue } from '../jobs/queue.js';
import type { EnqueueInput, JobQueue } from '../jobs/types.js';
import { enqueueWebhookBody, isAcceptedWebhookObject, planJobs } from './router.js';
import { normalizeWhatsAppChange } from './whatsapp.js';

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

describe('planJobs: leadgen (lead ads, A10)', () => {
    const leadgen = (value: Record<string, unknown>) => ({
        object: 'page',
        entry: [{ id: '200000000000001', time: 1, changes: [{ field: 'leadgen', value }] }],
    });

    it('a leadgen change is an ads.lead job keyed by the lead id, with ids only, and never a comment job', () => {
        const planned = planJobs(leadgen({ leadgen_id: '9001', page_id: '200000000000001', form_id: '777', ad_id: '555', adgroup_id: '444', created_time: 1760000000 }));
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'ads.lead');
        assert.equal(planned[0]!.dedupeKey, 'lead:9001');
        assert.equal(planned[0]!.tenantKey, '200000000000001');
        assert.deepEqual(planned[0]!.payload, { leadgenId: '9001', pageId: '200000000000001', formId: '777', adId: '555', createdTime: 1760000000 });
    });

    it('a leadgen change without a lead id is dropped', () => {
        assert.deepEqual(planJobs(leadgen({ page_id: '200000000000001' })), []);
    });

    it('a comment next to a lead still becomes a comment job', () => {
        const body = leadgen({ leadgen_id: '9002' });
        (body.entry[0]!.changes as any[]).push({ field: 'feed', value: { item: 'comment', comment_id: 'c1', verb: 'add' } });
        assert.deepEqual(planJobs(body).map(j => j.kind), ['ads.lead', 'comment.process']);
    });
});

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

    it('carries the body object with a DM, because that is the only place the platform is said (v26)', () => {
        // `object` is on the body and not the event; without it in the payload the pipeline
        // can only guess the conversation's platform from page ids.
        assert.equal((planJobs(dmDelivery)[0]!.payload as any).object, 'instagram');
        const messenger = planJobs({ ...dmDelivery, object: 'page' });
        assert.equal((messenger[0]!.payload as any).object, 'page');
        // A body with no object plans the same job as before, with no key at all.
        const bare = planJobs({ entry: dmDelivery.entry });
        assert.deepEqual(Object.keys(bare[0]!.payload as object).sort(), ['entryId', 'event']);
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

    it('does not enqueue read watermarks, delivery receipts or reactions', () => {
        // On an active account these are the bulk of `entry.messaging`. None of them can
        // reach a reply — `normalizeDm` rejects every one for having no text and no payload —
        // and none of them carry a `mid`, so they got no dedupe key either: a redelivered
        // batch of read receipts wrote a fresh `jobs` row per receipt per delivery, each of
        // which was then claimed, run, logged and marked done.
        const planned = planJobs({
            entry: [{
                id: 'p',
                messaging: [
                    { sender: { id: 'u' }, read: { watermark: 1700000000000 } },
                    { sender: { id: 'u' }, delivery: { mids: ['m1'], watermark: 1700000000000 } },
                    { sender: { id: 'u' }, reaction: { mid: 'm1', action: 'react', emoji: '❤' } },
                    { sender: { id: 'u' }, messaging_referral: { ref: 'promo' } },
                ],
            }],
        });
        assert.deepEqual(planned, []);
    });

    it('still enqueues a message whose only content is an attachment', () => {
        // Erring towards enqueueing: the handler is what knows whether an image or a voice
        // note can be answered. Dropping a real customer message here would be far worse
        // than one wasted job.
        const planned = planJobs({
            entry: [{
                id: 'p',
                messaging: [{
                    sender: { id: 'u' },
                    message: { mid: 'm1', attachments: [{ type: 'image', payload: { url: 'x' } }] },
                }],
            }],
        });
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'dm.process');
    });

    it('still enqueues a postback, which carries no `message` at all', () => {
        const planned = planJobs({
            entry: [{
                id: 'p',
                messaging: [{ sender: { id: 'u' }, postback: { mid: 'pb1', payload: 'GO' } }],
            }],
        });
        assert.deepEqual(planned.map((p) => p.dedupeKey), ['dm:pb1']);
    });

    it('carries the page id as the fair-queueing partition key', () => {
        // `creator_id` would be the natural partition and is unusable: resolving the tenant
        // needs a database read, and the point of enqueueing is to acknowledge Meta first, so
        // every row the webhook writes has it NULL. Without `tenant_key` the round-robin claim
        // puts every tenant in one group and silently degrades back to FIFO.
        const planned = planJobs({
            entry: [
                { id: 'page-a', changes: [{ field: 'comments', value: { id: 'c1' } }] },
                { id: 'page-b', messaging: [{ sender: { id: 'u' }, message: { mid: 'm1', text: 'hi' } }] },
            ],
        });
        assert.deepEqual(planned.map((p) => p.tenantKey), ['page-a', 'page-b']);
    });

    it('leaves the partition key undefined when the entry has no id', () => {
        // Rather than inventing one. An unattributed job becomes its own partition in the
        // claim, which cannot crowd anyone out.
        const planned = planJobs({
            entry: [{ changes: [{ field: 'comments', value: { id: 'c1' } }] }],
        });
        assert.equal(planned[0]!.tenantKey, undefined);
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
        async pruneCompleted() { return 0; },
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

// ─── Instagram and Facebook: unchanged by WhatsApp ───────────────────────────────────────

describe('planJobs — Instagram and Facebook plan exactly what they planned before WhatsApp existed', () => {
    // Whole-job equality, key for key (`assert.deepStrictEqual` tells an absent key from an `undefined` one): the WhatsApp branch is one `if` in
    // front of this code, and these are the outputs it must leave alone. A key added, dropped or renamed here changes what a real DM or comment does.
    it('an Instagram comment', () => {
        assert.deepEqual(planJobs(igComment), [{
            kind: 'comment.process',
            payload: { change: igComment.entry[0]!.changes[0], entryId: 'ig-page-1' },
            dedupeKey: 'comment:ig-comment-1',
            tenantKey: 'ig-page-1',
        }]);
    });

    it('a Facebook comment', () => {
        assert.deepEqual(planJobs(fbComment), [{
            kind: 'comment.process',
            payload: { change: fbComment.entry[0]!.changes[0], entryId: 'fb-page-1' },
            dedupeKey: 'comment:fb-comment-1',
            tenantKey: 'fb-page-1',
        }]);
    });

    it('an Instagram DM, a Messenger DM and a postback', () => {
        assert.deepEqual(planJobs(dmDelivery), [{
            kind: 'dm.process',
            payload: { event: dmDelivery.entry[0]!.messaging[0], entryId: 'ig-page-1', object: 'instagram' },
            dedupeKey: 'dm:mid-1',
            tenantKey: 'ig-page-1',
        }]);
        assert.deepEqual(planJobs({ ...dmDelivery, object: 'page' }), [{
            kind: 'dm.process',
            payload: { event: dmDelivery.entry[0]!.messaging[0], entryId: 'ig-page-1', object: 'page' },
            dedupeKey: 'dm:mid-1',
            tenantKey: 'ig-page-1',
        }]);
        const postback = { sender: { id: 'u' }, postback: { mid: 'pb1', payload: 'GO' } };
        assert.deepEqual(planJobs({ object: 'instagram', entry: [{ id: 'p', messaging: [postback] }] }), [{
            kind: 'dm.process', payload: { event: postback, entryId: 'p', object: 'instagram' }, dedupeKey: 'dm:pb1', tenantKey: 'p',
        }]);
    });

    it('a delivery with no `object`, which is how a job queued before v26 was planned', () => {
        assert.deepEqual(planJobs({ entry: dmDelivery.entry }), [{
            kind: 'dm.process', payload: { event: dmDelivery.entry[0]!.messaging[0], entryId: 'ig-page-1' }, dedupeKey: 'dm:mid-1', tenantKey: 'ig-page-1',
        }]);
    });

    it('an Instagram body whose change is named like a WhatsApp field is still a comment job: only the `object` selects the WhatsApp branch', () => {
        const planned = planJobs({ object: 'instagram', entry: [{ id: 'p', changes: [{ field: 'messages', value: { id: 'c1' } }] }] });
        assert.deepEqual(planned.map((j) => j.kind), ['comment.process']);
    });
});

// ─── WhatsApp ────────────────────────────────────────────────────────────────────────────

const FIXTURES = fileURLToPath(new URL('./__fixtures__/whatsapp/', import.meta.url));
const FIXTURE_NAMES = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const fixture = (name: string): any => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'));

const PHONE_ID = '106540352242922';
const WABA = '102290129340398';
const BSUID = 'US.13491208655302741918';
const sha1 = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

/** Meta's pre-BSUID samples carry no BSUID; this adds ONLY the two fields the BSUID page says every message gains. */
function bsuidify(body: any, userId = BSUID): any {
    const out = structuredClone(body);
    for (const entry of out.entry) for (const change of entry.changes) {
        for (const contact of change.value.contacts ?? []) if (contact.user_id === undefined) contact.user_id = userId;
        for (const message of change.value.messages ?? []) if (message.type !== 'system' && message.from_user_id === undefined) message.from_user_id = userId;
    }
    return out;
}

/** One `messages` delivery holding the given messages and statuses, with `contacts` as given. */
function whatsappBody(parts: { messages?: any[]; statuses?: any[]; contacts?: any[] }, over: Record<string, unknown> = {}): any {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: WABA,
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_ID },
                    ...(parts.contacts ? { contacts: parts.contacts } : {}),
                    ...(parts.messages ? { messages: parts.messages } : {}),
                    ...(parts.statuses ? { statuses: parts.statuses } : {}),
                    ...over,
                },
            }],
        }],
    };
}

describe('planJobs — WhatsApp', () => {
    let lines: Array<Record<string, any>>;
    let restore: (() => void) | undefined;
    beforeEach(() => {
        lines = [];
        const previous = setLogSink((_level, line) => { lines.push(JSON.parse(line)); });
        restore = () => setLogSink(previous);
    });
    afterEach(() => restore?.());
    const logged = (event: string) => lines.filter((l) => l.event === event);

    it('turns a text message into one dm.process job keyed dm:<wamid>, partitioned by the number', () => {
        const body = fixture('bsuid-text-no-phone');
        const planned = planJobs(body);
        const wamid = body.entry[0].changes[0].value.messages[0].id;

        assert.equal(planned.length, 1);
        const job = planned[0]!;
        assert.equal(job.kind, 'dm.process');
        assert.equal(job.dedupeKey, `dm:${wamid}`, 'the dm: prefix: the inbox delivery chip reads the job through it');
        assert.equal(job.tenantKey, PHONE_ID, 'the number, which names the tenant without a database read');
        const payload = job.payload as any;
        assert.equal(payload.object, 'whatsapp', 'the app’s name for the network, not the body’s object');
        assert.equal(payload.entryId, WABA);
        assert.equal(payload.phoneNumberId, PHONE_ID);
        assert.deepEqual(Object.keys(payload).sort(), ['change', 'entryId', 'object', 'phoneNumberId']);
        assert.deepEqual(payload.change.metadata, body.entry[0].changes[0].value.metadata);
        assert.deepEqual(payload.change.messages, body.entry[0].changes[0].value.messages);
        assert.deepEqual(payload.change.contacts, body.entry[0].changes[0].value.contacts);
        assert.deepEqual(planJobs(body).map((j) => j.dedupeKey), [`dm:${wamid}`], 'the same delivery plans the same key: that is what dedupes a redelivery');
    });

    it('makes one job per message, and each carries only its own contact', () => {
        const alice = { profile: { name: 'Alice Secret' }, user_id: 'EG.111' };
        const bob = { profile: { name: 'Bob Private', username: 'bobby' }, user_id: 'EG.222' };
        const body = whatsappBody({
            contacts: [alice, bob],
            messages: [
                { from_user_id: 'EG.111', id: 'wamid.A', timestamp: '1', type: 'text', text: { body: 'hello from alice' } },
                { from_user_id: 'EG.222', id: 'wamid.B', timestamp: '2', type: 'text', text: { body: 'hello from bob' } },
            ],
        });
        const planned = planJobs(body);

        assert.deepEqual(planned.map((j) => j.dedupeKey), ['dm:wamid.A', 'dm:wamid.B']);
        const [a, b] = planned.map((j) => (j.payload as any).change);
        assert.deepEqual(a.contacts, [alice]);
        assert.deepEqual(b.contacts, [bob]);
        assert.ok(!JSON.stringify(a).includes('Bob Private') && !JSON.stringify(a).includes('hello from bob'), 'one person’s job holds nothing of the other');
        assert.ok(!JSON.stringify(b).includes('Alice Secret') && !JSON.stringify(b).includes('hello from alice'));
        assert.equal(a.messages.length, 1);
        assert.equal(b.messages.length, 1);
    });

    it('keeps the lone contact of a delivery that does not name it, as the normaliser would, and never guesses between several', () => {
        const only = { profile: { name: 'Only One' } };
        const named = planJobs(whatsappBody({ contacts: [only], messages: [{ from_user_id: 'EG.1', id: 'wamid.A', type: 'text', text: { body: 'x' } }] }));
        assert.deepEqual((named[0]!.payload as any).change.contacts, [only]);
        const two = planJobs(whatsappBody({
            contacts: [{ profile: { name: 'P' } }, { profile: { name: 'Q' } }],
            messages: [{ from_user_id: 'EG.1', id: 'wamid.A', type: 'text', text: { body: 'x' } }],
        }));
        assert.deepEqual((two[0]!.payload as any).change.contacts, [], 'two contacts and none named: neither is guessed at');
    });

    it('re-normalises to exactly what was planned from, for every message in every fixture, as published and with BSUIDs added', () => {
        // The handler re-reads the trimmed change; if trimming changed what the normaliser makes of it, a stored message would differ from the planned one.
        let checked = 0;
        for (const name of FIXTURE_NAMES) {
            for (const body of [fixture(name), bsuidify(fixture(name))]) {
                const value = body.entry?.[0]?.changes?.[0]?.value;
                if (body.entry?.[0]?.changes?.[0]?.field !== 'messages' || !Array.isArray(value?.messages)) continue;
                const original = normalizeWhatsAppChange(value).messages;
                const jobs = planJobs(body).filter((j) => j.kind === 'dm.process');
                const replanned = jobs.flatMap((j) => normalizeWhatsAppChange((j.payload as any).change).messages);
                const expected = original.filter((m) => !(m.kind === 'ignored' && (m.reason === 'group' || m.reason === 'no_user_id')));
                assert.deepEqual(replanned, expected, name);
                checked += expected.length;
            }
        }
        assert.ok(checked >= 24, `only ${checked} messages were checked`);
    });

    it('re-normalises every status the same way, too', () => {
        let checked = 0;
        for (const name of FIXTURE_NAMES) {
            const body = fixture(name);
            const value = body.entry?.[0]?.changes?.[0]?.value;
            if (body.entry?.[0]?.changes?.[0]?.field !== 'messages' || !Array.isArray(value?.statuses)) continue;
            const jobs = planJobs(body).filter((j) => j.kind === 'wa.event');
            assert.equal(jobs.length, value.statuses.length, name);
            const replanned = jobs.flatMap((j) => normalizeWhatsAppChange((j.payload as any).change).statuses);
            assert.deepEqual(replanned, normalizeWhatsAppChange(value).statuses, name);
            checked += jobs.length;
        }
        assert.ok(checked >= 7, `only ${checked} statuses were checked`);
    });

    it('drops a group message and a message with no BSUID, each with one wa.ignored line that names the reason and the number', () => {
        assert.deepEqual(planJobs(fixture('text-group')), []);
        assert.deepEqual(planJobs(fixture('text-message')), [], 'Meta’s pre-BSUID sample has no BSUID anywhere');
        const ignored = logged('wa.ignored');
        assert.deepEqual(ignored.map((l) => [l.reason, l.phone_number_id, l.level]), [['group', PHONE_ID, 'info'], ['no_user_id', PHONE_ID, 'info']]);
    });

    it('still makes a job for a reaction, an unsupported message, and one with nothing to keep: the handler stores or logs them', () => {
        for (const name of ['reaction', 'unsupported', 'interactive-product', 'edit', 'revoke']) {
            const planned = planJobs(bsuidify(fixture(name)));
            assert.equal(planned.length, 1, name);
            assert.equal(planned[0]!.kind, 'dm.process', name);
            assert.match(planned[0]!.dedupeKey!, /^dm:wamid\./, name);
        }
        assert.deepEqual(logged('wa.ignored'), [], 'none of these is dropped at plan time');
    });

    it('makes a dm.process job for a system message, so the handler re-keys the contact', () => {
        const planned = planJobs(fixture('system-user-changed-user-id'));
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'dm.process');
        assert.equal(planned[0]!.dedupeKey, `dm:${fixture('system-user-changed-user-id').entry[0].changes[0].value.messages[0].id}`);
        assert.equal(planned[0]!.tenantKey, PHONE_ID);
    });

    it('makes a wa.event for each status, keyed on the message AND the status, so sent, delivered and read are three jobs', () => {
        const template = fixture('bsuid-status-delivered-with-phone');
        const base = template.entry[0].changes[0].value.statuses[0];
        const body = whatsappBody({
            statuses: ['sent', 'delivered', 'read'].map((status) => ({ ...base, status })),
            contacts: template.entry[0].changes[0].value.contacts,
        });
        const planned = planJobs(body);

        assert.deepEqual(planned.map((j) => j.kind), ['wa.event', 'wa.event', 'wa.event']);
        assert.deepEqual(planned.map((j) => j.dedupeKey), [`wa:st:${base.id}:sent`, `wa:st:${base.id}:delivered`, `wa:st:${base.id}:read`]);
        assert.ok(planned.every((j) => j.tenantKey === PHONE_ID));
        const first = planned[0]!.payload as any;
        assert.equal(first.kind, 'status');
        assert.equal(first.phoneNumberId, PHONE_ID);
        assert.equal(first.entryId, WABA);
        assert.equal(first.change.statuses.length, 1);
        // Never a customer message: a status does not become a dm.process job.
        assert.ok(planned.every((j) => j.kind !== 'dm.process'));
    });

    it('keys a status whose name Meta added later on the raw name, and a status with no id is dropped with a line', () => {
        const planned = planJobs(whatsappBody({ statuses: [{ id: 'wamid.X', status: 'brand_new' }, { status: 'sent' }] }));
        assert.deepEqual(planned.map((j) => j.dedupeKey), ['wa:st:wamid.X:brand_new']);
        assert.deepEqual(logged('wa.status_ignored').map((l) => l.reason), ['no_id']);
    });

    it('makes one account wa.event for each account-level field, keyed on field, time and a hash of the value, partitioned by the account', () => {
        const cases: Array<[string, string]> = [
            ['account-alerts', 'account_alerts'],
            ['account-update-partner-added', 'account_update'],
            ['phone-number-quality-update', 'phone_number_quality_update'],
            ['phone-number-name-update', 'phone_number_name_update'],
            ['business-capability-update', 'business_capability_update'],
        ];
        for (const [name, field] of cases) {
            const body = fixture(name);
            const entry = body.entry[0];
            const planned = planJobs(body);
            assert.equal(planned.length, 1, name);
            const job = planned[0]!;
            assert.equal(job.kind, 'wa.event', name);
            assert.equal(job.dedupeKey, `wa:acct:${field}:${entry.time}:${sha1(entry.changes[0].value)}`, name);
            assert.equal(job.tenantKey, entry.id, `${name}: an account event names the account, not a number`);
            assert.deepEqual(job.payload, { kind: 'account', entryId: entry.id, field, value: entry.changes[0].value, time: entry.time }, name);
        }
    });

    it('tells a repeated alert from a redelivery: same value at another time is another job, same value at the same time is the same one (review M13)', () => {
        const body = fixture('phone-number-quality-update');
        const key = (b: any) => planJobs(b)[0]!.dedupeKey;
        const later = structuredClone(body);
        later.entry[0].time = body.entry[0].time + 3600;
        assert.notEqual(key(later), key(body), 'GREEN -> YELLOW -> GREEN -> YELLOW is four events, not two');
        assert.equal(key(structuredClone(body)), key(body), 'a redelivery is the same event');
        const other = structuredClone(body);
        other.entry[0].changes[0].value.event = 'FLAGGED';
        assert.notEqual(key(other), key(body));
    });

    it('plans an account event with no time at all without a dedupe key, rather than guessing one', () => {
        const body = fixture('phone-number-quality-update');
        delete body.entry[0].time;
        const job = planJobs(body)[0]!;
        assert.equal(job.dedupeKey, undefined, 'a duplicate is harmless, a dropped alert is not');
        assert.equal((job.payload as any).time, null);
        const changeTime = structuredClone(body);
        changeTime.entry[0].changes[0].time = 1760000000;
        assert.equal(planJobs(changeTime)[0]!.dedupeKey, `wa:acct:phone_number_quality_update:1760000000:${sha1(body.entry[0].changes[0].value)}`, 'the change’s own time is the second choice');
    });

    it('makes a preference wa.event for user_preferences', () => {
        const body = fixture('user-preferences');
        const planned = planJobs(body);
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'wa.event');
        assert.equal(planned[0]!.dedupeKey, `wa:pref:${sha1(body.entry[0].changes[0].value)}`);
        assert.equal(planned[0]!.tenantKey, PHONE_ID);
        assert.deepEqual(planned[0]!.payload, { kind: 'preference', entryId: WABA, phoneNumberId: PHONE_ID, change: body.entry[0].changes[0].value });
    });

    it('drops any other field with wa.unhandled_field, including template status updates, which are logged only in v1', () => {
        for (const name of ['message-template-status-update-approved', 'message-template-status-update-rejected']) {
            assert.deepEqual(planJobs(fixture(name)), [], name);
        }
        const unknown = whatsappBody({ messages: [] });
        unknown.entry[0].changes[0].field = 'calls';
        assert.deepEqual(planJobs(unknown), []);
        assert.deepEqual(logged('wa.unhandled_field').map((l) => l.field), ['message_template_status_update', 'message_template_status_update', 'calls']);
    });

    it('says so when a delivery holds nothing to do: value-level errors (warn), an empty change, an entry with no changes', () => {
        assert.deepEqual(planJobs(fixture('value-errors')), []);
        const errors = logged('wa.value_errors');
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.level, 'warn');
        assert.equal(errors[0]!.phone_number_id, PHONE_ID);
        assert.ok(Array.isArray(errors[0]!.codes) && errors[0]!.codes.length > 0);

        assert.deepEqual(planJobs(whatsappBody({})), []);
        assert.equal(logged('wa.empty_change').length, 1);
        assert.deepEqual(planJobs({ object: 'whatsapp_business_account', entry: [{ id: WABA }] }), []);
        assert.equal(logged('wa.empty_entry').length, 1);
    });

    it('plans a message with no phone_number_id too, partitioned by the account, and leaves the handler to say it has no tenant', () => {
        const body = whatsappBody({ messages: [{ from_user_id: 'EG.1', id: 'wamid.A', type: 'text', text: { body: 'x' } }] });
        delete body.entry[0].changes[0].value.metadata;
        const [job] = planJobs(body);
        assert.equal(job!.tenantKey, WABA);
        assert.equal((job!.payload as any).phoneNumberId, null);
    });

    it('returns nothing, and never throws, for a malformed WhatsApp body: it runs before Meta is acknowledged', () => {
        const object = 'whatsapp_business_account';
        for (const body of [
            { object }, { object, entry: null }, { object, entry: [null] }, { object, entry: [{ changes: null }] }, { object, entry: [{ changes: [null] }] },
            { object, entry: [{ changes: [{ field: 'messages' }] }] }, { object, entry: [{ changes: [{ field: 'messages', value: 'x' }] }] },
            { object, entry: [{ changes: [{ field: 'messages', value: { messages: [null, 5, 'x'], statuses: [null] } }] }] },
            { object, entry: [{ changes: [{ field: 7, value: {} }] }] },
        ]) {
            assert.deepEqual(planJobs(body), [], JSON.stringify(body));
        }
    });

    it('is selected by the body’s object alone: an Instagram-shaped entry under the WhatsApp object makes no Instagram job', () => {
        assert.deepEqual(planJobs({ object: 'whatsapp_business_account', entry: dmDelivery.entry }), []);
    });
});

describe('enqueueWebhookBody — WhatsApp', () => {
    it('enqueues the WhatsApp jobs of a delivery, dedupe keys and partitions with them', async () => {
        const queue = recordingQueue();
        const previous = setJobQueue(queue);
        try {
            const result = await enqueueWebhookBody(fixture('bsuid-text-no-phone'), 'req-wa');
            assert.deepEqual(result, { planned: 1, enqueued: 1, deduped: 0 });
            assert.equal(queue.calls[0]!.kind, 'dm.process');
            assert.equal(queue.calls[0]!.tenantKey, PHONE_ID);
            assert.equal(queue.calls[0]!.requestId, 'req-wa');
        } finally {
            setJobQueue(previous);
        }
    });

    it('counts a redelivered message as deduped', async () => {
        const queue = recordingQueue('dedupe');
        const previous = setJobQueue(queue);
        try {
            assert.deepEqual(await enqueueWebhookBody(fixture('bsuid-text-no-phone')), { planned: 1, enqueued: 0, deduped: 1 });
        } finally {
            setJobQueue(previous);
        }
    });
});

describe('isAcceptedWebhookObject', () => {
    it('takes Instagram, a Facebook Page and a WhatsApp Business Account, and nothing else', () => {
        for (const object of ['instagram', 'page', 'whatsapp_business_account']) assert.equal(isAcceptedWebhookObject(object), true, object);
        for (const object of ['whatsapp', 'user', 'permissions', 'application', '', undefined, null, 5, {}, 'Instagram']) {
            assert.equal(isAcceptedWebhookObject(object), false, String(object));
        }
    });
});

// ─── A3: ad referrals ───────────────────────────────────────────────────────────────────────────

describe('planJobs — click-to-message ad referrals (A3)', () => {
    const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'));

    it('enqueues an Instagram first message that carries a referral, keyed on its mid as any message', () => {
        const planned = planJobs(fixture('ad-referral-instagram.json'));
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'dm.process');
        assert.match(planned[0]!.dedupeKey!, /^dm:aWdf/);
    });

    it('enqueues a Messenger postback that carries a referral (a new thread), keyed on the postback mid', () => {
        const planned = planJobs(fixture('ad-referral-messenger-postback.json'));
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.dedupeKey, 'dm:m_postback-ad-2');
    });

    it('enqueues a standalone referral from an ad (a returning person), keyed on who, which ad and when', () => {
        const planned = planJobs(fixture('ad-referral-messenger-standalone.json'));
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.kind, 'dm.process');
        assert.equal(planned[0]!.dedupeKey, 'dmref:PSID-ad-3:120210000000000003:1761134400000');
        assert.equal((planned[0]!.payload as any).object, 'page');
    });

    it('still drops a referral that is not from an ad, and a standalone referral event with no source', () => {
        const planned = planJobs({
            object: 'page',
            entry: [{
                id: 'p',
                messaging: [
                    { sender: { id: 'u' }, timestamp: 1, referral: { ref: 'promo', source: 'SHORTLINK', type: 'OPEN_THREAD' } },
                    { sender: { id: 'u' }, timestamp: 2, referral: { ref: 'promo' } },
                    { sender: { id: 'u' }, messaging_referral: { ref: 'promo' } },
                ],
            }],
        });
        assert.deepEqual(planned, []);
    });

    it('gives a standalone ad referral with no sender or timestamp no key (one attempt, like any event without a mid)', () => {
        const planned = planJobs({ object: 'page', entry: [{ id: 'p', messaging: [{ referral: { ad_id: '1', source: 'ADS' } }] }] });
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.dedupeKey, undefined);
    });
});
