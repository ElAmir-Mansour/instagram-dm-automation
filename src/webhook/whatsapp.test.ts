/**
 * The WhatsApp normaliser, run against Meta's own sample payloads (`__fixtures__/whatsapp/`, provenance in `SOURCES.md` there).
 *
 * **Two kinds of input, on purpose.**
 *   1. The fixtures, byte for byte as Meta publishes them. Most of Meta's per-type samples predate BSUIDs: they carry a
 *      phone (`from`, `wa_id`) and no `user_id`. By the contract a message with no BSUID is `Ignored{no_user_id}`, so run
 *      raw they all say exactly that. That is asserted, not skipped: it is the behaviour the owner's number will see if
 *      a payload ever arrives without one.
 *   2. The same fixtures through `bsuidify`, which adds ONLY `contacts[].user_id` and `messages[].from_user_id`, the two
 *      fields Meta's BSUID page says every incoming message type gains ("the changes are the same for all incoming message
 *      types"). That is how every type's mapping is exercised against a real payload without inventing one. The fixtures
 *      that Meta already published with BSUIDs (`bsuid-*`, `system-*`) run as they are.
 *
 * Anything else built here (a status of `read`, a message with its caption removed) is a labelled variant of a fixture,
 * never added to the fixtures folder: Meta publishes no sample for it.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dmPromptText } from './messaging.js';
import {
    normalizeWhatsAppChange,
    normalizeWhatsAppMessage,
    normalizeWhatsAppStatus,
    type WaChange,
    type WaIgnored,
    type WaInbound,
    type WaSystemEvent,
} from './whatsapp.js';

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------------

const DIR = fileURLToPath(new URL('./__fixtures__/whatsapp/', import.meta.url));
const FIXTURE_NAMES = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();

function load(name: string): any {
    return JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
}

function change(name: string): any {
    return load(name).entry[0].changes[0];
}

/** `entry[0].changes[0].value`, a fresh deep copy each call so a test may edit it. */
function value(name: string): any {
    return structuredClone(change(name).value);
}

const BSUID = 'US.TEST00000000000000001';

/** Adds the BSUID fields (and nothing else) that Meta's BSUID page says every incoming message type gains. */
function bsuidify(v: any, userId = BSUID): any {
    const out = structuredClone(v);
    for (const contact of out.contacts ?? []) if (contact.user_id === undefined) contact.user_id = userId;
    for (const message of out.messages ?? []) if (message.type !== 'system' && message.from_user_id === undefined) message.from_user_id = userId;
    return out;
}

function onlyMessage(v: unknown): WaInbound | WaSystemEvent | WaIgnored {
    const result = normalizeWhatsAppChange(v);
    assert.equal(result.messages.length, 1, 'one message in, one out');
    return result.messages[0]!;
}

function inbound(v: unknown): WaInbound {
    const m = onlyMessage(v);
    assert.equal(m.kind, 'message', `expected an inbound message, got ${JSON.stringify(m)}`);
    return m as WaInbound;
}

function ignoredOf(v: unknown): WaIgnored {
    const m = onlyMessage(v);
    assert.equal(m.kind, 'ignored', `expected an ignored message, got ${JSON.stringify(m)}`);
    return m as WaIgnored;
}

function systemOf(v: unknown): WaSystemEvent {
    const m = onlyMessage(v);
    assert.equal(m.kind, 'system', `expected a system event, got ${JSON.stringify(m)}`);
    return m as WaSystemEvent;
}

const EMPTY: WaChange = { messages: [], statuses: [], errors: [] };

// ---------------------------------------------------------------------------------------------------------------------
// What every fixture is expected to do. A fixture with no entry here fails `every fixture has an expectation`.
// ---------------------------------------------------------------------------------------------------------------------

type Outcome = { kind: 'message' } | { kind: 'system' } | { kind: 'ignored'; reason: string };

/** raw = as Meta published it; bsuid = after `bsuidify` (same as raw when the fixture already has BSUIDs). */
const MESSAGE_CASES: Record<string, { raw: Outcome; bsuid: Outcome }> = (() => {
    const noId: Outcome = { kind: 'ignored', reason: 'no_user_id' };
    const dm: Outcome = { kind: 'message' };
    const legacy = (bsuid: Outcome) => ({ raw: noId, bsuid });
    return {
        'text-message': legacy(dm),
        'text-message-business-button': legacy(dm),
        'text-ctwa-referral': legacy(dm),
        'text-group': { raw: { kind: 'ignored', reason: 'group' }, bsuid: { kind: 'ignored', reason: 'group' } },
        'interactive-list-reply': legacy(dm),
        'interactive-button-reply': legacy(dm),
        'interactive-product': legacy({ kind: 'ignored', reason: 'unsupported' }),
        'button-template-reply': legacy(dm),
        'audio-voice': legacy(dm),
        image: legacy(dm),
        video: legacy(dm),
        document: legacy(dm),
        sticker: legacy(dm),
        location: legacy(dm),
        contacts: legacy(dm),
        reaction: legacy({ kind: 'ignored', reason: 'reaction' }),
        'reaction-removed': legacy({ kind: 'ignored', reason: 'reaction' }),
        unsupported: legacy({ kind: 'ignored', reason: 'unsupported' }),
        edit: legacy({ kind: 'ignored', reason: 'edit_or_revoke' }),
        revoke: legacy({ kind: 'ignored', reason: 'edit_or_revoke' }),
        order: legacy({ kind: 'ignored', reason: 'unsupported' }),
        'system-user-changed-number': { raw: { kind: 'system' }, bsuid: { kind: 'system' } },
        'system-user-changed-user-id': { raw: { kind: 'system' }, bsuid: { kind: 'system' } },
        'bsuid-text-no-phone': { raw: dm, bsuid: dm },
    };
})();

/** Fixtures whose `statuses[]` normalise to one status each. */
const STATUS_FIXTURES = [
    'status-delivered', 'status-sent-pricing', 'status-sent-minimal', 'status-failed',
    'bsuid-status-delivered-with-phone', 'bsuid-status-delivered-no-phone', 'bsuid-status-failed',
];

const VALUE_ERROR_FIXTURES = ['value-errors'];

function isNotMessagesField(name: string): boolean {
    return change(name).field !== 'messages';
}

describe('the fixtures themselves', () => {
    it('are there (a few dozen of Meta\'s samples)', () => {
        assert.ok(FIXTURE_NAMES.length >= 40, `only ${FIXTURE_NAMES.length} fixtures`);
    });

    it('are valid webhook envelopes', () => {
        for (const name of FIXTURE_NAMES) {
            const body = load(name);
            assert.equal(body.object, 'whatsapp_business_account', name);
            assert.ok(Array.isArray(body.entry) && body.entry.length > 0, `${name}: entry`);
            for (const entry of body.entry) {
                assert.equal(typeof entry.id, 'string', `${name}: entry.id`);
                assert.ok(Array.isArray(entry.changes) && entry.changes.length > 0, `${name}: changes`);
                for (const c of entry.changes) {
                    assert.equal(typeof c.field, 'string', `${name}: field`);
                    assert.ok(c.value && typeof c.value === 'object', `${name}: value`);
                }
            }
        }
    });

    it('have no leftover HTML entities or template placeholders from the docs', () => {
        // Meta's own account_alerts sample has a literal <BUSINESS_PORTFOLIO_NAME> inside a description string. It is valid
        // JSON and published that way, so it stays (see SOURCES.md); it is the only one.
        const publishedPlaceholders: Record<string, string[]> = { 'account-alerts': ['<BUSINESS_PORTFOLIO_NAME>'] };
        for (const name of FIXTURE_NAMES) {
            const raw = readFileSync(`${DIR}${name}.json`, 'utf8');
            assert.doesNotMatch(raw, /&(quot|amp|lt|gt|#\d+);/, `${name}: an HTML entity`);
            const placeholders = raw.match(/<[A-Z][A-Z_0-9]+>/g) ?? [];
            assert.deepEqual(placeholders, publishedPlaceholders[name] ?? [], `${name}: a <PLACEHOLDER>`);
        }
    });

    it('are all listed in SOURCES.md, and SOURCES.md lists nothing that is not there', () => {
        const sources = readFileSync(`${DIR}SOURCES.md`, 'utf8');
        const listed = [...sources.matchAll(/^\| `([^`]+)\.json` \|/gm)].map((m) => m[1]!).sort();
        assert.deepEqual(listed, FIXTURE_NAMES);
        for (const name of FIXTURE_NAMES) {
            const row = sources.split('\n').find((line) => line.startsWith(`| \`${name}.json\``))!;
            assert.match(row, /<https:\/\/developers\.facebook\.com\/documentation\/business-messaging\/whatsapp\//, `${name}: a source URL`);
        }
    });

    it('every fixture has an expectation in this file', () => {
        const known = new Set([...Object.keys(MESSAGE_CASES), ...STATUS_FIXTURES, ...VALUE_ERROR_FIXTURES]);
        const unexpected = FIXTURE_NAMES.filter((name) => !known.has(name) && !isNotMessagesField(name));
        assert.deepEqual(unexpected, [], 'a messages-field fixture with no expectation: add it to MESSAGE_CASES / STATUS_FIXTURES');
        for (const name of known) assert.ok(FIXTURE_NAMES.includes(name), `${name} is expected here but is not a fixture`);
    });
});

describe('every fixture through normalizeWhatsAppChange', () => {
    for (const name of FIXTURE_NAMES) {
        it(name, () => {
            const v = value(name);
            const result = normalizeWhatsAppChange(v);

            if (isNotMessagesField(name)) {
                // account_update, phone_number_quality_update, user_preferences, template updates...: routed elsewhere.
                assert.deepEqual(result, EMPTY);
                return;
            }
            if (VALUE_ERROR_FIXTURES.includes(name)) {
                assert.equal(result.messages.length + result.statuses.length, 0);
                assert.equal(result.errors.length, 1);
                return;
            }
            if (STATUS_FIXTURES.includes(name)) {
                assert.equal(result.messages.length, 0);
                assert.equal(result.statuses.length, 1);
                assert.equal(result.errors.length, 0);
                return;
            }

            const expected = MESSAGE_CASES[name]!;
            assert.equal(result.statuses.length, 0);
            assert.equal(result.messages.length, 1);
            const check = (outcome: Outcome, got: WaInbound | WaSystemEvent | WaIgnored, label: string) => {
                assert.equal(got.kind, outcome.kind === 'message' ? 'message' : outcome.kind, `${name} (${label}): ${JSON.stringify(got)}`);
                if (outcome.kind === 'ignored') assert.equal((got as WaIgnored).reason, outcome.reason, `${name} (${label})`);
            };
            check(expected.raw, result.messages[0]!, 'as published');
            check(expected.bsuid, normalizeWhatsAppChange(bsuidify(v)).messages[0]!, 'with BSUIDs added');
        });
    }
});

// ---------------------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------------------

describe('sender identity: BSUID first, phone optional', () => {
    it('keys a message on from_user_id and keeps the phone as an extra, never the other way round', () => {
        // Both a phone (`from`, `wa_id`) and a BSUID are present: the BSUID is the key.
        const m = inbound(bsuidify(value('text-message')));
        assert.equal(m.senderId, BSUID);
        assert.equal(m.phone, '16505551234');
        assert.notEqual(m.senderId, m.phone);
    });

    it('falls back to contacts[].user_id when the message carries no from_user_id', () => {
        const v = value('text-message');
        v.contacts[0].user_id = 'US.FROMCONTACT000001';
        const m = inbound(v);
        assert.equal(m.senderId, 'US.FROMCONTACT000001');
        assert.equal(m.phone, '16505551234');
    });

    it('prefers from_user_id over a different contacts[].user_id', () => {
        const v = value('text-message');
        v.contacts[0].user_id = 'US.CONTACT0000000002';
        v.messages[0].from_user_id = 'US.MESSAGE0000000002';
        assert.equal(inbound(v).senderId, 'US.MESSAGE0000000002');
    });

    it('a phone with no BSUID anywhere is Ignored{no_user_id}, with the phone kept for the log, never used as the id', () => {
        const m = ignoredOf(value('text-message'));
        assert.equal(m.reason, 'no_user_id');
        assert.equal(m.senderId, null);
        assert.equal(m.phone, '16505551234');
        assert.equal(m.metaMessageId, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=');
        assert.equal(m.store, false);
    });

    it('a username user with no phone: BSUID, username and profile name, phone null (Meta\'s own BSUID sample)', () => {
        const m = inbound(value('bsuid-text-no-phone'));
        assert.equal(m.senderId, 'US.13491208655302741918');
        assert.equal(m.phone, null);
        assert.equal(m.username, 'realsheenanelson');
        assert.equal(m.profileName, 'Sheena Nelson');
        assert.equal(m.parentUserId, 'US.ENT.11815799212886844830');
        assert.equal(m.text, 'Does it come in another color?');
        assert.equal(m.phoneNumberId, '106540352242922');
        assert.equal(m.timestamp, 1749416383);
    });

    it('carries the profile name, username and the tenant key (phone_number_id)', () => {
        const v = bsuidify(value('text-message'));
        v.contacts[0].profile.username = 'sheena';
        const m = inbound(v);
        assert.equal(m.profileName, 'Sheena Nelson');
        assert.equal(m.username, 'sheena');
        assert.equal(m.phoneNumberId, '106540352242922');
    });

    it('never puts one contact\'s name on another contact\'s message when a delivery carries several', () => {
        const v = {
            metadata: { phone_number_id: 'P1' },
            contacts: [
                { profile: { name: 'Alice' }, wa_id: '111', user_id: 'US.AAAA' },
                { profile: { name: 'Bob' }, wa_id: '222', user_id: 'US.BBBB' },
            ],
            messages: [
                { from: '222', from_user_id: 'US.BBBB', id: 'wamid.B', timestamp: '1', type: 'text', text: { body: 'hi from bob' } },
                { from: '111', from_user_id: 'US.AAAA', id: 'wamid.A', timestamp: '2', type: 'text', text: { body: 'hi from alice' } },
            ],
        };
        const [bob, alice] = normalizeWhatsAppChange(v).messages as WaInbound[];
        assert.equal(bob!.profileName, 'Bob');
        assert.equal(bob!.senderId, 'US.BBBB');
        assert.equal(alice!.profileName, 'Alice');
        assert.equal(alice!.senderId, 'US.AAAA');
    });

    it('with several contacts and nothing to match on, takes no sender instead of guessing', () => {
        const v = {
            metadata: { phone_number_id: 'P1' },
            contacts: [{ profile: { name: 'Alice' }, user_id: 'US.AAAA' }, { profile: { name: 'Bob' }, user_id: 'US.BBBB' }],
            messages: [{ id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'who am I' } }],
        };
        const m = ignoredOf(v);
        assert.equal(m.reason, 'no_user_id');
        assert.equal(m.profileName, null);
    });

    it('does not borrow a different user\'s profile when the only contact names another BSUID', () => {
        const v = {
            metadata: { phone_number_id: 'P1' },
            contacts: [{ profile: { name: 'Alice' }, user_id: 'US.AAAA' }],
            messages: [{ from_user_id: 'US.BBBB', id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hello' } }],
        };
        const m = inbound(v);
        assert.equal(m.senderId, 'US.BBBB');
        assert.equal(m.profileName, null);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------------------------------------------------

describe('message type mapping (fixtures with BSUIDs added)', () => {
    it('text: the body, no payload, not word-less', () => {
        const m = inbound(bsuidify(value('text-message')));
        assert.equal(m.messageType, 'text');
        assert.equal(m.text, 'Does it come in another color?');
        assert.equal(m.payload, '');
        assert.equal(m.wordless, null);
        assert.equal(m.media, null);
        assert.equal(m.needsTranscript, false);
        assert.equal(m.isStoryMention, false);
        assert.equal(m.entrySource, null);
        assert.equal(m.contextMessageId, null);
        assert.equal(m.metaMessageId, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=');
        assert.equal(m.timestamp, 1749416383);
    });

    it('the catalog "Message business" button: text, with the quoted message as context', () => {
        const m = inbound(bsuidify(value('text-message-business-button')));
        assert.equal(m.text, 'Is this still available?');
        assert.equal(m.contextMessageId, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGA9wcm9kdWN0X2lucXVpcnkA');
    });

    it('interactive list reply: the row title as text, the row id as payload', () => {
        const m = inbound(bsuidify(value('interactive-list-reply')));
        assert.equal(m.messageType, 'interactive.list_reply');
        assert.equal(m.text, 'Priority Mail Express');
        assert.equal(m.payload, 'priority_express');
        assert.equal(m.wordless, null);
        assert.equal(m.contextMessageId, 'wamid.HBgLMTQxMjU1NTA4MjkVAgASGBQzQUNCNjk5RDUwNUZGMUZEM0VBRAA=');
    });

    it('interactive button reply: the button title as text, the button id as payload', () => {
        const m = inbound(bsuidify(value('interactive-button-reply')));
        assert.equal(m.messageType, 'interactive.button_reply');
        assert.equal(m.text, 'Cancel');
        assert.equal(m.payload, 'cancel-button');
    });

    it('a template quick-reply button: its text and payload', () => {
        const m = inbound(bsuidify(value('button-template-reply')));
        assert.equal(m.messageType, 'button');
        assert.equal(m.text, 'Unsubscribe');
        assert.equal(m.payload, 'Unsubscribe');
        assert.equal(m.wordless, null);
    });

    it('a voice note: media to download, transcript to come, not word-less', () => {
        const m = inbound(bsuidify(value('audio-voice')));
        assert.equal(m.messageType, 'audio');
        assert.deepEqual(m.media, { kind: 'audio', id: '1908647269898587', mime: 'audio/ogg; codecs=opus', voice: true });
        assert.equal(m.needsTranscript, true);
        assert.equal(m.text, '');
        assert.equal(m.wordless, null);
    });

    it('an audio file that is not a voice note carries no voice flag', () => {
        const v = bsuidify(value('audio-voice'));
        delete v.messages[0].audio.voice;
        const m = inbound(v);
        assert.equal(m.media?.voice, undefined);
        assert.equal(m.needsTranscript, true);
    });

    it('an image with a caption: the caption is the words, the media is kept, not word-less', () => {
        const m = inbound(bsuidify(value('image')));
        assert.equal(m.text, 'Taj Mahal');
        assert.equal(m.wordless, null);
        assert.deepEqual(m.media, { kind: 'image', id: '1003383421387256', mime: 'image/jpeg', caption: 'Taj Mahal' });
    });

    it('an image WITHOUT a caption (a variant: Meta samples only the captioned one) is a word-less image', () => {
        const v = bsuidify(value('image'));
        delete v.messages[0].image.caption;
        const m = inbound(v);
        assert.equal(m.text, '');
        assert.equal(m.wordless?.kind, 'image');
        assert.equal(m.wordless?.placeholder, '[photo]');
        assert.equal(m.wordless?.ack, 'media');
        assert.equal(m.media?.id, '1003383421387256');
        assert.equal(m.media?.caption, undefined);
    });

    it('video: caption as text; without a caption it is a word-less video', () => {
        const withCaption = inbound(bsuidify(value('video')));
        assert.equal(withCaption.text, 'Timelapse of growth');
        assert.equal(withCaption.media?.kind, 'video');
        assert.equal(withCaption.media?.mime, 'video/mp4');
        const v = bsuidify(value('video'));
        delete v.messages[0].video.caption;
        assert.equal(inbound(v).wordless?.kind, 'video');
    });

    it('document: caption and filename kept; without a caption it is a word-less file', () => {
        const withCaption = inbound(bsuidify(value('document')));
        assert.equal(withCaption.text, 'my receipt');
        assert.deepEqual(withCaption.media, { kind: 'document', id: '622684793477189', mime: 'application/pdf', caption: 'my receipt', filename: 'receipt.pdf' });
        const v = bsuidify(value('document'));
        delete v.messages[0].document.caption;
        const bare = inbound(v);
        assert.equal(bare.wordless?.kind, 'file');
        assert.equal(bare.media?.filename, 'receipt.pdf');
    });

    it('sticker: word-less, and a sticker is a like (no acknowledgement)', () => {
        const m = inbound(bsuidify(value('sticker')));
        assert.equal(m.text, '');
        assert.equal(m.wordless?.kind, 'sticker');
        assert.equal(m.wordless?.ack, null);
        assert.equal(m.media?.kind, 'sticker');
        assert.equal(m.media?.mime, 'image/webp');
    });

    it('location and contacts: word-less, as the generic attachment kind', () => {
        for (const name of ['location', 'contacts']) {
            const m = inbound(bsuidify(value(name)));
            assert.equal(m.messageType, name);
            assert.equal(m.text, '', name);
            assert.equal(m.wordless?.kind, 'attachment', name);
            assert.equal(m.wordless?.ack, 'media', name);
            assert.equal(m.media, null, name);
        }
    });

    it('a media message with no id degrades instead of vanishing: stored word-less, nothing to download or transcribe', () => {
        const img = bsuidify(value('image'));
        delete img.messages[0].image.id;
        delete img.messages[0].image.caption;
        const m = inbound(img);
        assert.equal(m.media, null);
        assert.equal(m.wordless?.kind, 'image');
        const audio = bsuidify(value('audio-voice'));
        delete audio.messages[0].audio.id;
        const a = inbound(audio);
        assert.equal(a.needsTranscript, false);
        assert.equal(a.wordless?.kind, 'audio');
    });

    it('is a valid NormalizedDm: the pipeline\'s own prompt-text rule reads it', () => {
        // dmPromptText(dm) = text || payload || wordless placeholder: what is stored and what the model is shown.
        assert.equal(dmPromptText(inbound(bsuidify(value('text-message')))), 'Does it come in another color?');
        assert.equal(dmPromptText(inbound(bsuidify(value('interactive-list-reply')))), 'Priority Mail Express');
        assert.equal(dmPromptText(inbound(bsuidify(value('sticker')))), '[sticker]');
        assert.equal(dmPromptText(inbound(bsuidify(value('location')))), '[attachment]');
        // A bare button with only a payload falls back to the payload.
        const v = bsuidify(value('button-template-reply'));
        delete v.messages[0].button.text;
        assert.equal(dmPromptText(inbound(v)), 'Unsubscribe');
    });
});

describe('ignored messages', () => {
    it('a reaction is stored but never answered, and says so', () => {
        for (const name of ['reaction', 'reaction-removed']) {
            const m = ignoredOf(bsuidify(value(name)));
            assert.equal(m.reason, 'reaction', name);
            assert.equal(m.store, true, name);
            assert.equal(m.noReplyReason, null, name);
            assert.equal(m.senderId, BSUID, name);
            assert.equal(m.messageType, 'reaction', name);
        }
    });

    it('an unsupported message is stored with no_reply_reason unsupported_type and Meta\'s error code', () => {
        const m = ignoredOf(bsuidify(value('unsupported')));
        assert.equal(m.reason, 'unsupported');
        assert.equal(m.store, true);
        assert.equal(m.noReplyReason, 'unsupported_type');
        assert.equal(m.errorCode, 131051);
        assert.equal(m.messageType, 'unsupported');
        assert.equal(m.senderId, BSUID);
    });

    it('an unavailable message (error 131060, the same shape as 131051) is just as unsupported', () => {
        const v = bsuidify(value('unsupported'));
        v.messages[0].errors[0].code = 131060;
        const m = ignoredOf(v);
        assert.equal(m.reason, 'unsupported');
        assert.equal(m.errorCode, 131060);
    });

    it('any other message carrying errors[] is Ignored{error}, stored, not answered', () => {
        const v = bsuidify(value('text-message'));
        v.messages[0].errors = [{ code: 131000, title: 'something' }];
        const m = ignoredOf(v);
        assert.equal(m.reason, 'error');
        assert.equal(m.store, true);
        assert.equal(m.noReplyReason, 'unsupported_type');
        assert.equal(m.errorCode, 131000);
    });

    it('a group message is ignored whoever sent it, with or without a BSUID, and not stored', () => {
        for (const v of [value('text-group'), bsuidify(value('text-group'))]) {
            const m = ignoredOf(v);
            assert.equal(m.reason, 'group');
            assert.equal(m.store, false);
        }
    });

    it('interactive types the agent does not read (a catalog product) and orders are unsupported, stored', () => {
        for (const name of ['interactive-product', 'order']) {
            const m = ignoredOf(bsuidify(value(name)));
            assert.equal(m.reason, 'unsupported', name);
            assert.equal(m.store, true, name);
            assert.equal(m.noReplyReason, 'unsupported_type', name);
        }
    });

    it('edits and revokes are changes to an earlier message, not new content: ignored, not stored', () => {
        for (const name of ['edit', 'revoke']) {
            const m = ignoredOf(bsuidify(value(name)));
            assert.equal(m.reason, 'edit_or_revoke', name);
            assert.equal(m.store, false, name);
        }
    });

    it('request_welcome (removed by Meta, review L2; no official sample, so built from a text fixture) is ignored and not stored', () => {
        const v = bsuidify(value('text-message'));
        v.messages[0].type = 'request_welcome';
        delete v.messages[0].text;
        const m = ignoredOf(v);
        assert.equal(m.reason, 'request_welcome');
        assert.equal(m.store, false);
        assert.equal(m.noReplyReason, null);
    });

    it('an unknown future type is unsupported rather than a crash', () => {
        const v = bsuidify(value('text-message'));
        v.messages[0].type = 'hologram';
        const m = ignoredOf(v);
        assert.equal(m.reason, 'unsupported');
        assert.equal(m.store, true);
        assert.equal(m.messageType, 'hologram');
    });

    it('malformed entries are Ignored{malformed}, not stored: no id, an empty body, a reply with neither title nor id', () => {
        const noId = bsuidify(value('text-message'));
        delete noId.messages[0].id;
        assert.equal(ignoredOf(noId).reason, 'malformed');

        const emptyBody = bsuidify(value('text-message'));
        emptyBody.messages[0].text.body = '   ';
        assert.equal(ignoredOf(emptyBody).reason, 'malformed');

        const noText = bsuidify(value('text-message'));
        delete noText.messages[0].text;
        assert.equal(ignoredOf(noText).reason, 'malformed');

        const emptyReply = bsuidify(value('interactive-button-reply'));
        emptyReply.messages[0].interactive.button_reply = {};
        assert.equal(ignoredOf(emptyReply).reason, 'malformed');

        const emptyButton = bsuidify(value('button-template-reply'));
        emptyButton.messages[0].button = {};
        assert.equal(ignoredOf(emptyButton).reason, 'malformed');
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// System messages: BSUID re-keys
// ---------------------------------------------------------------------------------------------------------------------

describe('system messages', () => {
    it('user_changed_number: re-key from previous_user_id to user_id, with the NEW phone (not the old `from`)', () => {
        const e = systemOf(value('system-user-changed-number'));
        assert.equal(e.systemType, 'user_changed_number');
        assert.deepEqual(e.rekey, { from: 'US.10230984751029384756', to: 'US.13491208655302741918' });
        assert.equal(e.userId, 'US.13491208655302741918');
        assert.equal(e.phone, '12195555358', 'system.wa_id is the new number; messages[].from (16505551234) is the old one');
        assert.equal(e.parentUserId, 'US.ENT.506847293015824');
        assert.equal(e.body, 'User Sheena Nelson changed from 16505551234 to 12195555358');
        assert.equal(e.metaMessageId, 'wamid.HBgLMTk4MzU1NTE5NzQVAgASGAoxMTgyMDg2MjY3AA==');
        assert.equal(e.phoneNumberId, '106540352242922');
        assert.equal(e.timestamp, 1750269342);
    });

    it('user_changed_user_id: the same re-key, no phone (Meta\'s own sample has neither `from` nor `wa_id`)', () => {
        const e = systemOf(value('system-user-changed-user-id'));
        assert.equal(e.systemType, 'user_changed_user_id');
        assert.deepEqual(e.rekey, { from: 'US.10230984751029384756', to: 'US.13491208655302741918' });
        assert.equal(e.phone, null);
    });

    it('needs no `contacts` and no from_user_id: a system event is keyed by system.user_id alone', () => {
        const v = value('system-user-changed-user-id');
        assert.equal(v.contacts, undefined);
        assert.equal(v.messages[0].from_user_id, undefined);
        assert.equal(systemOf(v).userId, 'US.13491208655302741918');
    });

    it('without previous_user_id (Meta omits it when unavailable) there is nothing to re-key from: rekey is null', () => {
        const v = value('system-user-changed-user-id');
        delete v.messages[0].system.previous_user_id;
        const e = systemOf(v);
        assert.equal(e.rekey, null);
        assert.equal(e.userId, 'US.13491208655302741918');
    });

    it('a "change" to the same id re-keys nothing', () => {
        const v = value('system-user-changed-user-id');
        v.messages[0].system.previous_user_id = v.messages[0].system.user_id;
        assert.equal(systemOf(v).rekey, null);
    });

    it('without a user_id it is Ignored{no_user_id}', () => {
        const v = value('system-user-changed-user-id');
        delete v.messages[0].system.user_id;
        assert.equal(ignoredOf(v).reason, 'no_user_id');
    });

    it('a system type this app does not know is ignored, not stored', () => {
        const v = value('system-user-changed-user-id');
        v.messages[0].system.type = 'customer_identity_changed';
        const m = ignoredOf(v);
        assert.equal(m.reason, 'unsupported');
        assert.equal(m.store, false);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Click to WhatsApp
// ---------------------------------------------------------------------------------------------------------------------

describe('Click to WhatsApp referral', () => {
    it('becomes an entry source with the ad id, the click id and the headline', () => {
        const m = inbound(bsuidify(value('text-ctwa-referral')));
        assert.deepEqual(m.entrySource, {
            kind: 'ctwa',
            ad_id: '120226305854810726',
            ctwa_clid: 'Aff-n8ZTODiE79d22KtAwQKj9e_mIEOOj27vDVwFjN80dp4_0NiNhEgpGo0AHemvuSoifXaytfTzcchptiErTKCqTrJ5nW1h7IHYeYymGb5K5J5iTROpBhWAGaIAeUzHL50',
            headline: 'Chat with us',
        });
        assert.equal(m.text, 'Can I get more info about this?');
    });

    it('omits ctwa_clid for a WhatsApp Status ad placement (Meta omits it entirely)', () => {
        const v = bsuidify(value('text-ctwa-referral'));
        delete v.messages[0].referral.ctwa_clid;
        const source = inbound(v).entrySource!;
        assert.equal(source.kind, 'ctwa');
        assert.equal('ctwa_clid' in source, false);
        assert.equal(source.ad_id, '120226305854810726');
    });

    it('a referral on a non-text message counts too', () => {
        const v = bsuidify(value('image'));
        v.messages[0].referral = { source_type: 'ad', source_id: '999', headline: 'Look' };
        assert.deepEqual(inbound(v).entrySource, { kind: 'ctwa', ad_id: '999', headline: 'Look' });
    });

    it('no referral, no entry source', () => {
        assert.equal(inbound(bsuidify(value('text-message'))).entrySource, null);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------------------------------------------------

function onlyStatus(name: string): NonNullable<ReturnType<typeof normalizeWhatsAppStatus>> {
    const result = normalizeWhatsAppChange(value(name));
    assert.equal(result.statuses.length, 1);
    return result.statuses[0]!;
}

describe('statuses', () => {
    it('sent with conversation and pricing', () => {
        const s = onlyStatus('status-sent-pricing');
        assert.deepEqual(s, {
            wamid: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=',
            status: 'sent',
            rawStatus: 'sent',
            timestamp: 1750030073,
            phoneNumberId: '106540352242922',
            recipientUserId: null,
            recipientPhone: '16505551234',
            pricing: { billable: true, category: 'marketing', type: 'regular' },
            conversation: { id: '72b14d6bd5407799e66f64d1b338e567', expiresAt: 1750116480, originType: 'marketing' },
        });
    });

    it('sent in the v24.0 shape: no pricing, no conversation, no errors', () => {
        const s = onlyStatus('status-sent-minimal');
        assert.equal(s.status, 'sent');
        assert.equal('pricing' in s, false);
        assert.equal('conversation' in s, false);
        assert.equal('errors' in s, false);
    });

    it('delivered (the older CBP-model sample): pricing without a type', () => {
        const s = onlyStatus('status-delivered');
        assert.equal(s.status, 'delivered');
        assert.deepEqual(s.pricing, { billable: true, category: 'service', type: null });
        assert.deepEqual(s.conversation, { id: '6ceb9d929c9bdc4f90e967a32f8639b4', expiresAt: null, originType: 'service' });
        assert.equal(s.timestamp, 1750263773);
    });

    it('failed: the errors with code, title and details; no recipient BSUID for a send to a phone', () => {
        const s = onlyStatus('status-failed');
        assert.equal(s.status, 'failed');
        assert.equal(s.wamid, 'wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI0QUQ2MjA4NEYyRkExNjMyREUA');
        assert.deepEqual(s.errors, [{
            code: 131049,
            title: 'This message was not delivered to maintain healthy ecosystem engagement.',
            details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        }]);
        assert.equal(s.recipientUserId, null);
        assert.equal(s.recipientPhone, '16505551234');
    });

    it('BSUID delivered, sent to a phone: recipient_user_id and the phone (Meta\'s BSUID sample)', () => {
        const s = onlyStatus('bsuid-status-delivered-with-phone');
        assert.equal(s.recipientUserId, 'US.13491208655302741918');
        assert.equal(s.recipientPhone, '16505551234');
        assert.deepEqual(s.pricing, { billable: true, category: 'marketing', type: 'regular' });
    });

    it('BSUID delivered, sent to a BSUID with no phone shareable: the BSUID, and NO recipientPhone key', () => {
        const s = onlyStatus('bsuid-status-delivered-no-phone');
        assert.equal(s.recipientUserId, 'US.13491208655302741918');
        assert.equal('recipientPhone' in s, false);
    });

    it('BSUID failed, sent to a phone: no recipient_user_id, no contacts; the phone and the errors', () => {
        const s = onlyStatus('bsuid-status-failed');
        assert.equal(s.status, 'failed');
        assert.equal(s.recipientUserId, null);
        assert.equal(s.recipientPhone, '16505551234');
        assert.equal(s.errors?.[0]?.code, 131049);
    });

    it('takes the recipient BSUID from contacts[] when recipient_user_id is absent', () => {
        const v = value('bsuid-status-delivered-no-phone');
        delete v.statuses[0].recipient_user_id;
        const s = normalizeWhatsAppChange(v).statuses[0]!;
        assert.equal(s.recipientUserId, 'US.13491208655302741918');
    });

    it('read, played (variants of the delivered fixture: Meta publishes no read or played sample)', () => {
        for (const status of ['read', 'played'] as const) {
            const v = value('bsuid-status-delivered-with-phone');
            v.statuses[0].status = status;
            const s = normalizeWhatsAppChange(v).statuses[0]!;
            assert.equal(s.status, status);
            assert.equal(s.rawStatus, status);
        }
    });

    it('a status name Meta has not documented is "unknown", with the raw value kept for the log', () => {
        const v = value('status-sent-minimal');
        v.statuses[0].status = 'deleted';
        const s = normalizeWhatsAppChange(v).statuses[0]!;
        assert.equal(s.status, 'unknown');
        assert.equal(s.rawStatus, 'deleted');
    });

    it('a group recipient\'s recipient_id is a group id, not a phone', () => {
        const v = value('status-sent-minimal');
        v.statuses[0].recipient_id = 'HBgLGROUPID';
        v.statuses[0].recipient_type = 'group';
        const s = normalizeWhatsAppChange(v).statuses[0]!;
        assert.equal('recipientPhone' in s, false);
    });

    it('a status with no id is dropped: nothing to match a message by', () => {
        const v = value('status-sent-minimal');
        delete v.statuses[0].id;
        assert.deepEqual(normalizeWhatsAppChange(v), EMPTY);
    });

    it('normalizeWhatsAppStatus alone: not an object, or no id, is null', () => {
        assert.equal(normalizeWhatsAppStatus({}, [], null), null);
        assert.equal(normalizeWhatsAppStatus({}, [], { status: 'sent' }), null);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Value-level errors and robustness
// ---------------------------------------------------------------------------------------------------------------------

describe('value-level errors', () => {
    it('are surfaced, with no message and no status attached', () => {
        const result = normalizeWhatsAppChange(value('value-errors'));
        assert.deepEqual(result, {
            messages: [],
            statuses: [],
            errors: [{
                code: 130429,
                title: 'Rate limit hit',
                details: 'Message failed to send because there were too many messages sent from this phone number in a short period of time',
            }],
        });
    });
});

describe('garbage in, nothing thrown', () => {
    it('normalizeWhatsAppChange answers an empty change for anything that is not a value object', () => {
        for (const bad of [undefined, null, 0, 'x', true, [], [1, 2], () => {}]) {
            assert.deepEqual(normalizeWhatsAppChange(bad), EMPTY, String(bad));
        }
        assert.deepEqual(normalizeWhatsAppChange({}), EMPTY);
        assert.deepEqual(normalizeWhatsAppChange({ messages: 'x', statuses: 7, contacts: {}, errors: 'no' }), EMPTY);
        assert.deepEqual(normalizeWhatsAppChange({ messages: [null, 3, 'a', []], statuses: [null, 3, 'a'] }).statuses, []);
    });

    it('normalizeWhatsAppMessage never throws, whatever it is handed', () => {
        for (const bad of [undefined, null, 5, 'x', [], {}, { id: 5 }, { id: 'wamid.x', type: 5, from_user_id: 7 }]) {
            const m = normalizeWhatsAppMessage(undefined, undefined, bad);
            assert.equal(m.kind, 'ignored');
        }
        const m = normalizeWhatsAppMessage('meta', 'contacts', { id: 'wamid.x', from_user_id: 'US.X', type: 'text', text: { body: 'hi' } });
        assert.equal(m.kind, 'message');
    });

    it('survives every fixture with every scalar knocked out, one at a time', () => {
        // A cheap fuzz: for each fixture, delete each leaf key in turn and require no exception.
        let runs = 0;
        const leaves = (node: any, path: (string | number)[] = []): (string | number)[][] =>
            node && typeof node === 'object'
                ? Object.keys(node).flatMap((k) => leaves(node[k], [...path, Array.isArray(node) ? Number(k) : k]))
                : [path];
        for (const name of FIXTURE_NAMES) {
            const original = bsuidify(change(name).value);
            for (const path of leaves(original)) {
                const copy = structuredClone(original);
                let parent: any = copy;
                for (const key of path.slice(0, -1)) parent = parent[key];
                delete parent[path[path.length - 1]!];
                normalizeWhatsAppChange(copy);
                runs++;
            }
        }
        assert.ok(runs > 500, `only ${runs} mutations ran`);
    });
});
