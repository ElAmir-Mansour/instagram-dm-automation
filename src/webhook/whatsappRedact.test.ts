/**
 * What a WhatsApp job's payload is cut down to (whatsappRedact.ts), run over Meta's own sample payloads.
 *
 * The check is a leak scan, not a list of expected fields: every string in the original payload that is not on a short list of what may stay
 * (the wamid, the BSUIDs, the types, the timestamps, the ids of the account and the number) must be absent from the redacted JSON. A field added
 * to a future payload that names a person is therefore caught by the first fixture that carries it, not by someone remembering to extend a list.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isWhatsAppDmPayload, type WaEventPayload, type WhatsAppDmPayload } from '../jobs/types.js';
import { planJobs } from './router.js';
import { normalizeWhatsAppChange } from './whatsapp.js';
import { redactedInboundPayload, redactedPreferencePayload, redactedStatusPayload } from './whatsappRedact.js';

const DIR = fileURLToPath(new URL('./__fixtures__/whatsapp/', import.meta.url));
const NAMES = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const fixture = (name: string): any => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
const BSUID = 'US.13491208655302741918';

/** Meta's pre-BSUID samples carry no BSUID; add ONLY the two fields the BSUID page says every message gains. */
function bsuidify(body: any): any {
    const out = structuredClone(body);
    for (const change of out.entry[0].changes) {
        for (const contact of change.value.contacts ?? []) if (contact.user_id === undefined) contact.user_id = BSUID;
        for (const message of change.value.messages ?? []) if (message.type !== 'system' && message.from_user_id === undefined) message.from_user_id = BSUID;
    }
    return out;
}

const leaves = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) leaves(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out);
    return out;
};

/** Every string of `original` that may NOT survive, given what may: the leaves a job keeps for audit and dedupe. */
function mustBeGone(original: unknown, mayStay: Set<string>): string[] {
    return [...new Set(leaves(original))].filter((s) => s.length >= 4 && !mayStay.has(s));
}

const jobsOf = (body: any, kind: string) => planJobs(body).filter((j) => j.kind === kind).map((j) => j.payload);

describe('redactedInboundPayload', () => {
    it('keeps what an audit and the dedupe need, and not one other string the payload held, for every message fixture', () => {
        let messages = 0;
        for (const name of NAMES) {
            for (const body of [fixture(name), bsuidify(fixture(name))]) {
                for (const payload of jobsOf(body, 'dm.process') as WhatsAppDmPayload[]) {
                    const original = normalizeWhatsAppChange(payload.change).messages;
                    const redacted = redactedInboundPayload(payload);

                    const mayStay = new Set<string>([payload.entryId, payload.phoneNumberId!, 'whatsapp']);
                    for (const m of original) {
                        if (m.metaMessageId) mayStay.add(m.metaMessageId);
                        if (m.kind === 'system') { mayStay.add('system'); mayStay.add(m.systemType); mayStay.add(m.userId); if (m.rekey) mayStay.add(m.rekey.from); }
                        else { if (m.messageType) mayStay.add(m.messageType); if (m.senderId) mayStay.add(m.senderId); }
                        if (m.timestamp !== null) mayStay.add(String(m.timestamp));
                    }
                    // The wire type and an interactive reply's flavour are the same words as `messageType` (`interactive.button_reply`): the type survives.
                    for (const raw of (payload.change as any).messages ?? []) {
                        if (typeof raw?.type === 'string') mayStay.add(raw.type);
                        if (typeof raw?.interactive?.type === 'string') mayStay.add(raw.interactive.type);
                    }
                    const gone = mustBeGone(payload.change, mayStay);
                    const json = JSON.stringify(redacted);
                    for (const secret of gone) assert.ok(!json.includes(secret), `${name}: "${secret}" survived the redaction`);
                    messages += original.length;
                }
            }
        }
        assert.ok(messages >= 24, `only ${messages} messages were scanned`);
    });

    it('keeps the object, the account, the number, the wamid, the type, the time and the BSUID of a text message, and nothing else', () => {
        const [payload] = jobsOf(fixture('bsuid-text-no-phone'), 'dm.process') as WhatsAppDmPayload[];
        const redacted = redactedInboundPayload(payload!);
        assert.deepEqual(redacted, {
            object: 'whatsapp',
            entryId: '102290129340398',
            phoneNumberId: '106540352242922',
            change: {
                redacted: true,
                metadata: { phone_number_id: '106540352242922' },
                messages: [{ id: payload!.change && (payload!.change as any).messages[0].id, type: 'text', timestamp: '1749416383', from_user_id: 'US.13491208655302741918' }],
            },
        });
        const json = JSON.stringify(redacted);
        for (const gone of ['Does it come in another color?', 'Sheena Nelson', 'realsheenanelson', 'US.ENT.11815799212886844830', '15550783881']) {
            assert.ok(!json.includes(gone), gone);
        }
    });

    it('drops a referral’s ad, click id and headline, a caption, a media id, a filename and the raw phone', () => {
        const referral = bsuidify(fixture('text-ctwa-referral'));
        const image = bsuidify(fixture('image'));
        const document = bsuidify(fixture('document'));
        for (const body of [referral, image, document]) {
            const [payload] = jobsOf(body, 'dm.process') as WhatsAppDmPayload[];
            const message = (payload!.change as any).messages[0];
            const json = JSON.stringify(redactedInboundPayload(payload!));
            for (const secret of [message.from, message.referral?.source_id, message.referral?.ctwa_clid, message.referral?.headline, message.image?.id, message.image?.caption, message.document?.filename, message.document?.id]) {
                if (secret) assert.ok(!json.includes(secret), `${secret} survived`);
            }
        }
    });

    it('keeps a system message’s type and its two BSUIDs, and drops its text, its new phone and its parent ids', () => {
        const [payload] = jobsOf(fixture('system-user-changed-user-id'), 'dm.process') as WhatsAppDmPayload[];
        const redacted = redactedInboundPayload(payload!);
        const [message] = (redacted.change as any).messages;
        assert.equal(message.type, 'system');
        assert.deepEqual(message.system, { type: 'user_changed_user_id', user_id: 'US.13491208655302741918', previous_user_id: 'US.10230984751029384756' });
        const json = JSON.stringify(redacted);
        for (const gone of ['User changed from', 'US.ENT.506847293015824', 'US.ENT.918273645500112']) assert.ok(!json.includes(gone), gone);
    });

    it('is still a WhatsApp dm.process payload, so a replay of a redacted job ends in a log line and not in the Instagram pipeline', () => {
        const [payload] = jobsOf(fixture('bsuid-text-no-phone'), 'dm.process') as WhatsAppDmPayload[];
        const redacted = redactedInboundPayload(payload!);
        assert.equal(isWhatsAppDmPayload(redacted), true);
        const replayed = normalizeWhatsAppChange(redacted.change).messages;
        assert.equal(replayed.length, 1);
        assert.equal(replayed[0]!.kind, 'ignored', 'a message with no body is nothing to store');
        assert.equal(replayed[0]!.metaMessageId, (payload!.change as any).messages[0].id);
    });

    it('gives a redacted payload back unchanged, for every message fixture', () => {
        for (const name of NAMES) {
            for (const payload of jobsOf(bsuidify(fixture(name)), 'dm.process') as WhatsAppDmPayload[]) {
                const once = redactedInboundPayload(payload);
                assert.deepEqual(redactedInboundPayload(once), once, name);
            }
        }
    });

    it('copes with a payload that is not what it should be, and still drops what it held', () => {
        const odd = redactedInboundPayload({ object: 'whatsapp', entryId: 'w', phoneNumberId: null, change: { messages: [null, 5, { id: 'wamid.X', type: 'text', text: { body: 'secret words' }, from: '201001234567' }] } });
        const json = JSON.stringify(odd);
        assert.ok(!json.includes('secret words') && !json.includes('201001234567'));
        assert.equal(redactedInboundPayload({ object: 'whatsapp', entryId: 'w', phoneNumberId: null, change: 'nonsense' }).change && (redactedInboundPayload({ object: 'whatsapp', entryId: 'w', phoneNumberId: null, change: 'nonsense' }).change as any).messages.length, 0);
    });
});

describe('redactedStatusPayload', () => {
    const statusFixtures = ['status-delivered', 'status-sent-pricing', 'status-sent-minimal', 'status-failed', 'bsuid-status-delivered-with-phone', 'bsuid-status-delivered-no-phone', 'bsuid-status-failed'];

    it('keeps the wamid, status, time, pricing and Meta’s error codes, and drops the recipient’s phone and contact, for every status fixture', () => {
        for (const name of statusFixtures) {
            const [payload] = jobsOf(fixture(name), 'wa.event') as Array<Extract<WaEventPayload, { kind: 'status' }>>;
            const original = normalizeWhatsAppChange(payload!.change).statuses[0]!;
            const redacted = redactedStatusPayload(payload!);
            const json = JSON.stringify(redacted);

            const mayStay = new Set<string>([payload!.entryId, payload!.phoneNumberId!, 'whatsapp', original.wamid, original.rawStatus, String(original.timestamp)]);
            if (original.recipientUserId) mayStay.add(original.recipientUserId);
            for (const v of [original.pricing?.category, original.pricing?.type]) if (v) mayStay.add(v);
            for (const e of original.errors ?? []) for (const v of [e.title, e.details]) if (v) mayStay.add(v);
            for (const secret of mustBeGone(payload!.change, mayStay)) assert.ok(!json.includes(secret), `${name}: "${secret}" survived`);

            // What the handler needs again, if a replay ever happens, is still there and still reads the same.
            const replayed = normalizeWhatsAppChange(redacted.change).statuses[0]!;
            assert.equal(replayed.wamid, original.wamid, name);
            assert.equal(replayed.status, original.status, name);
            assert.deepEqual(replayed.pricing, original.pricing, name);
            assert.deepEqual(replayed.errors?.map((e) => e.code), original.errors?.map((e) => e.code), name);
        }
    });

    it('is unchanged by a second pass', () => {
        const [payload] = jobsOf(fixture('bsuid-status-delivered-with-phone'), 'wa.event') as Array<Extract<WaEventPayload, { kind: 'status' }>>;
        const once = redactedStatusPayload(payload!);
        assert.deepEqual(redactedStatusPayload(once), once);
    });
});

describe('redactedPreferencePayload', () => {
    it('keeps what was chosen and when, and drops who chose it', () => {
        const [payload] = jobsOf(fixture('user-preferences'), 'wa.event') as Array<Extract<WaEventPayload, { kind: 'preference' }>>;
        const redacted = redactedPreferencePayload(payload!);
        assert.deepEqual((redacted.change as any).user_preferences, [{ category: 'marketing_messages', value: 'resume', timestamp: 1731705721 }]);
        const json = JSON.stringify(redacted);
        for (const gone of ['16505551234', 'US.13491208655302741918', 'US.ENT.506847293015824', 'User requested to resume marketing messages']) assert.ok(!json.includes(gone), gone);
        assert.equal(redacted.phoneNumberId, '106540352242922');
        assert.deepEqual(redactedPreferencePayload(redacted), redacted, 'unchanged by a second pass');
    });
});
