/**
 * The comment -> DM bridge (`bridge.ts`, docs/DM_SALES_PLAN.md §10, S10).
 *
 * The pure rules (which id a private reply went to, the window, which offer a campaign sells, where a turn starts) are tables; the two
 * statements are driven against a `pool.query` that answers on the SQL it is handed, because what matters about them is their SHAPE and what
 * is made of their rows: one that dropped `creator_id` would join one tenant's DM to another tenant's comment, and one that filtered the
 * window in SQL would leave the window's edge untestable.
 *
 * The end-to-end behaviour (a comment whose bridge write fails is still SENT and still answered publicly; a DM from a commenter starts at
 * `recommend`; `sales_mode = 'off'` is unchanged) is in `comments.test.ts`, `turn.test.ts` and `messaging.test.ts`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import {
    BRIDGE_WINDOW_DAYS, BRIDGE_WINDOW_MS, bridgeFacts, commentSource, firstKeyword, inBridgeWindow, offerForCampaign, openingStage, recipientIdOf,
    recordPrivateReplyRecipient, type BridgeOffer, type CommentSource,
} from './bridge.js';

let original: typeof pool.query;
let asked: { sql: string; params: any[] }[];
let logged: { level: string; event: string; [k: string]: unknown }[];
let restoreSink: () => void;

/** `pool.query` answering each statement from `answer`, which sees the SQL (whitespace collapsed). */
const answering = (answer: (sql: string) => { rows?: any[]; rowCount?: number } | Error): void => {
    (pool as any).query = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        asked.push({ sql: flat, params });
        const result = answer(flat);
        if (result instanceof Error) throw result;
        const { rows = [], rowCount } = result;
        return { rows, rowCount: rowCount ?? rows.length };
    };
};

beforeEach(() => {
    original = pool.query;
    asked = [];
    logged = [];
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => { setLogSink(previous); };
});
afterEach(() => {
    (pool as any).query = original;
    restoreSink();
});

const events = (name: string) => logged.filter((l) => l.event === name);

// ─── Pure ────────────────────────────────────────────────────────────────────────────────────

describe('recipientIdOf', () => {
    it('is the id Meta names, trimmed', () => {
        assert.equal(recipientIdOf({ recipient_id: '17841400000000001', message_id: 'm_1' }), '17841400000000001');
        assert.equal(recipientIdOf({ recipient_id: '  17841400000000001 ' }), '17841400000000001');
    });

    it('is null when the response names none: the reply that landed on a retry, an empty answer, a number (it would have lost digits), or nothing', () => {
        assert.equal(recipientIdOf({ delivered: true, landed_before_retry: true }), null);
        assert.equal(recipientIdOf({}), null);
        assert.equal(recipientIdOf({ recipient_id: '' }), null);
        assert.equal(recipientIdOf({ recipient_id: '   ' }), null);
        assert.equal(recipientIdOf({ recipient_id: 17841400000000001 }), null);
        assert.equal(recipientIdOf({ recipient_id: null }), null);
        assert.equal(recipientIdOf('17841400000000001'), null);
        assert.equal(recipientIdOf(null), null);
        assert.equal(recipientIdOf(undefined), null);
    });

    it('is null for an id wider than the column', () => {
        assert.equal(recipientIdOf({ recipient_id: '1'.repeat(255) }), '1'.repeat(255));
        assert.equal(recipientIdOf({ recipient_id: '1'.repeat(256) }), null);
    });
});

describe('inBridgeWindow: the window is 7 days, Meta\'s private-reply horizon', () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);

    it('is seven days, to the millisecond', () => {
        assert.equal(BRIDGE_WINDOW_DAYS, 7);
        assert.equal(BRIDGE_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
    });

    it('the boundary: a reply sent exactly seven days ago still counts; one millisecond older does not; one millisecond newer does', () => {
        assert.equal(inBridgeWindow(ago(BRIDGE_WINDOW_MS), now), true);
        assert.equal(inBridgeWindow(ago(BRIDGE_WINDOW_MS + 1), now), false);
        assert.equal(inBridgeWindow(ago(BRIDGE_WINDOW_MS - 1), now), true);
    });

    it('a reply from a minute ago, from nothing ago, and from the future (a database clock a little ahead) all count', () => {
        assert.equal(inBridgeWindow(ago(60_000), now), true);
        assert.equal(inBridgeWindow(ago(0), now), true);
        assert.equal(inBridgeWindow(ago(-5_000), now), true);
    });

    it('takes a Date, an ISO string or epoch milliseconds, and an unreadable time is out', () => {
        assert.equal(inBridgeWindow(ago(1000).toISOString(), now), true);
        assert.equal(inBridgeWindow(ago(1000).getTime(), now), true);
        assert.equal(inBridgeWindow(ago(BRIDGE_WINDOW_MS + 1).toISOString(), now), false);
        assert.equal(inBridgeWindow('not a date', now), false);
    });
});

describe('firstKeyword', () => {
    it('is the first of the campaign\'s trigger keywords, whichever comma the owner typed', () => {
        assert.equal(firstKeyword('plan'), 'plan');
        assert.equal(firstKeyword('plan, price, link'), 'plan');
        assert.equal(firstKeyword('سعر، رابط'), 'سعر');
        assert.equal(firstKeyword(' , plan'), 'plan');
        assert.equal(firstKeyword(''), '');
    });
});

describe('offerForCampaign', () => {
    const AGENTS = 'https://www.learn.example/lessons/agents-intro/?ref=ABC123';
    const offers: BridgeOffer[] = [
        { id: 'agents', url: AGENTS, campaign: { keywords: ['agents', 'ادوات'] } },
        { id: 'csharp', url: 'https://www.learn.example/lessons/csharp-basics/?ref=ABC123', campaign: { keywords: ['c#', 'سي شارب'] } },
        { id: 'dm-only', url: '', campaign: { keywords: ['consult'] } },
    ];
    const campaign = (triggerKeywords: string, dmTemplate: string) => ({ triggerKeywords, dmTemplate });

    it('finds the offer whose address is in the campaign\'s text: the link was certainly sent', () => {
        assert.deepEqual(offerForCampaign(campaign('anything', `اهلا {username} ${AGENTS}`), offers), { offerId: 'agents', via: 'url' });
    });

    it('reads the address through the punctuation a sentence puts after it, a different scheme, a leading www and a closing slash', () => {
        assert.deepEqual(offerForCampaign(campaign('x', `الرابط: ${AGENTS}.`), offers), { offerId: 'agents', via: 'url' });
        assert.deepEqual(offerForCampaign(campaign('x', `الرابط (${AGENTS})،`), offers), { offerId: 'agents', via: 'url' });
        assert.deepEqual(offerForCampaign(campaign('x', `http://learn.example/lessons/agents-intro/?ref=ABC123`), offers), { offerId: 'agents', via: 'url' });
    });

    it('an address that merely STARTS like an offer\'s is not that offer: another path or another affiliate code is another address', () => {
        assert.equal(offerForCampaign(campaign('x', 'https://www.learn.example/lessons/agents-intro-2/?ref=ABC123'), offers), null);
        assert.equal(offerForCampaign(campaign('x', 'https://www.learn.example/lessons/agents-intro/?ref=SOMEONEELSE'), offers), null);
    });

    it('falls back to the keyword the offer carries, in the owner\'s spelling or not (Arabic is normalised)', () => {
        assert.deepEqual(offerForCampaign(campaign('Agents, price', 'اهلا بك'), offers), { offerId: 'agents', via: 'keyword' });
        assert.deepEqual(offerForCampaign(campaign('أدوات', 'اهلا بك'), offers), { offerId: 'agents', via: 'keyword' });
        assert.deepEqual(offerForCampaign(campaign('سي شارب', 'no link here'), offers), { offerId: 'csharp', via: 'keyword' });
    });

    it('is a guess, and a guess is null: two offers\' addresses in one text, one keyword on two offers, or no match at all', () => {
        const both = `${AGENTS} and https://www.learn.example/lessons/csharp-basics/?ref=ABC123`;
        assert.equal(offerForCampaign(campaign('agents', both), offers), null, 'two addresses: not narrowed by a keyword either');
        const shared: BridgeOffer[] = [
            { id: 'a', url: 'https://a.example/x', campaign: { keywords: ['plan'] } },
            { id: 'b', url: 'https://b.example/y', campaign: { keywords: ['Plan'] } },
        ];
        assert.equal(offerForCampaign(campaign('plan', 'hello'), shared), null);
        assert.equal(offerForCampaign(campaign('unrelated', 'hello'), offers), null);
        assert.equal(offerForCampaign(campaign('', 'hello'), offers), null);
        assert.equal(offerForCampaign(campaign('plan', 'hello'), []), null);
    });

    it('an offer with no address cannot have been sent by its address, but its keyword still names it', () => {
        assert.deepEqual(offerForCampaign(campaign('consult', 'book a call'), offers), { offerId: 'dm-only', via: 'keyword' });
        assert.equal(offerForCampaign(campaign('x', 'a text with no address at all'), [{ id: 'dm-only', url: '' }]), null);
    });
});

describe('openingStage: a bridge starts a conversation, and never moves one that is going', () => {
    const source: CommentSource = { campaignId: 'camp-1', triggerKeywords: 'plan', dmTemplate: 'hi' };
    const fresh = { stage: 'new' as const, qualifierTurns: 0, offersLinked: [] as string[] };

    it('a fresh conversation with a source starts at recommend', () => {
        assert.equal(openingStage(fresh, source), 'recommend');
    });

    it('a fresh conversation with none starts at new, as it always did', () => {
        assert.equal(openingStage(fresh, null), 'new');
    });

    it('a conversation that has begun keeps its stage, source or not: a question asked, a link sent by the bot, or any stage past new', () => {
        assert.equal(openingStage({ ...fresh, qualifierTurns: 1 }, source), 'new');
        assert.equal(openingStage({ ...fresh, offersLinked: ['plan'] }, source), 'new');
        for (const stage of ['qualify', 'recommend', 'objection', 'link', 'follow_up', 'handoff', 'closed'] as const) {
            assert.equal(openingStage({ ...fresh, stage }, source), stage, stage);
        }
    });
});

describe('bridgeFacts', () => {
    const offers: BridgeOffer[] = [{ id: 'plan', url: 'https://samifit.example/plan', campaign: { keywords: ['plan'] } }];

    it('names the comment and the offer, and says the link was sent when the campaign\'s text holds the offer\'s address', () => {
        const facts = bridgeFacts({ campaignId: 'c', triggerKeywords: 'plan, خطة', dmTemplate: 'Here: https://samifit.example/plan' }, offers);
        assert.deepEqual(facts, { comment: { keyword: 'plan', offerId: 'plan' }, linkSentFor: ['plan'] });
    });

    it('an offer found only by keyword is named, but the link is not claimed as sent: the text might not hold it', () => {
        const facts = bridgeFacts({ campaignId: 'c', triggerKeywords: 'plan', dmTemplate: 'Thanks for commenting' }, offers);
        assert.deepEqual(facts, { comment: { keyword: 'plan', offerId: 'plan' }, linkSentFor: [] });
    });

    it('a campaign that matches no offer is still a comment', () => {
        const facts = bridgeFacts({ campaignId: 'c', triggerKeywords: 'giveaway', dmTemplate: 'Thanks' }, offers);
        assert.deepEqual(facts, { comment: { keyword: 'giveaway', offerId: null }, linkSentFor: [] });
    });
});

// ─── The comment path's statement ────────────────────────────────────────────────────────────

describe('recordPrivateReplyRecipient', () => {
    const rec = { interactionId: 'int-1', creatorId: 'creator-1', campaignId: 'camp-1', commenterId: '17841400000000001', platform: 'instagram' as const };

    it('writes the id the reply went to, and the campaign whose text went, on the interaction: ONE statement, by primary key and tenant', async () => {
        answering(() => ({ rowCount: 1 }));
        const wrote = await recordPrivateReplyRecipient({ recipient_id: '17841400000000001', message_id: 'm_1' }, rec);

        assert.equal(wrote, true);
        assert.equal(asked.length, 1);
        assert.equal(asked[0]!.sql, 'UPDATE interactions SET recipient_id = $1, campaign_id = $2 WHERE id = $3 AND creator_id = $4');
        assert.deepEqual(asked[0]!.params, ['17841400000000001', 'camp-1', 'int-1', 'creator-1']);
    });

    it('logs the id the reply went to beside the commenter\'s own (A1), once', async () => {
        answering(() => ({ rowCount: 1 }));
        await recordPrivateReplyRecipient({ recipient_id: 'IGSID-9' }, { ...rec, commenterId: 'IGSID-9' });
        await recordPrivateReplyRecipient({ recipient_id: 'IGSID-9' }, { ...rec, commenterId: 'some-other-id' });
        const lines = events('comment.bridge_recorded');
        assert.equal(lines.length, 2);
        assert.deepEqual([lines[0]!.recipient_id, lines[0]!.commenter_id, lines[0]!.same_id], ['IGSID-9', 'IGSID-9', true]);
        assert.deepEqual([lines[1]!.recipient_id, lines[1]!.commenter_id, lines[1]!.same_id], ['IGSID-9', 'some-other-id', false]);
        assert.equal(lines[0]!.interaction_id, 'int-1');
        assert.equal(lines[0]!.campaign_id, 'camp-1');
    });

    it('a response with no recipient (the reply landed on a retry) writes nothing and says so quietly; any other answer with none says so loudly', async () => {
        answering(() => ({ rowCount: 1 }));
        assert.equal(await recordPrivateReplyRecipient({ delivered: true, landed_before_retry: true }, rec), false);
        assert.equal(await recordPrivateReplyRecipient({ message_id: 'm_1' }, rec), false);
        assert.equal(await recordPrivateReplyRecipient(undefined, rec), false);
        assert.equal(asked.length, 0, 'no statement');
        const lines = events('comment.bridge_no_recipient');
        assert.deepEqual(lines.map((l) => [l.level, l.landed_before_retry]), [['info', true], ['warn', false], ['warn', false]]);
    });

    it('a database that refuses the write throws, and it is the caller\'s try/catch that keeps the comment as it was', async () => {
        answering(() => new Error('column "recipient_id" of relation "interactions" does not exist'));
        await assert.rejects(recordPrivateReplyRecipient({ recipient_id: 'x1' }, rec), /recipient_id/);
    });
});

// ─── The DM path's lookup ────────────────────────────────────────────────────────────────────

describe('commentSource', () => {
    const NOW = new Date('2026-10-14T12:00:00.000Z');
    const lookup = { conversationId: 'conv-1', creatorId: 'creator-1', senderId: '17841400000000001', platform: 'instagram' as const };
    const NONE = {
        current_source: null, interaction_id: null, recent_campaign: null, recipient_id: null, replied_at: null,
        recent_keywords: null, recent_template: null, current_keywords: null, current_template: null,
    };
    /** What the lookup statement returns for a private reply sent `agoMs` before NOW to this sender, for campaign `camp-1`. */
    const replied = (agoMs: number, over: Record<string, unknown> = {}) => ({
        ...NONE, interaction_id: 'int-1', recent_campaign: 'camp-1', recipient_id: '17841400000000001', replied_at: new Date(NOW.getTime() - agoMs),
        recent_keywords: 'plan, خطة', recent_template: 'Here: https://samifit.example/plan', ...over,
    });
    const arrange = (row: Record<string, unknown> | null, update: { rowCount?: number } | Error = { rowCount: 1 }) => answering((sql) => {
        if (/^UPDATE conversations SET source_campaign_id/.test(sql)) return update;
        return { rows: row ? [row] : [] };
    });
    const writes = () => asked.filter((a) => /^UPDATE conversations SET source_campaign_id/.test(a.sql));

    it('reads in ONE statement, scoped to the tenant on both tables it joins, to the sender, to SENT replies and to the conversation\'s network, newest first', async () => {
        arrange(null);
        await commentSource(lookup, NOW);

        assert.equal(asked.length, 1);
        const { sql, params } = asked[0]!;
        assert.deepEqual(params, ['conv-1', 'creator-1', '17841400000000001', 'instagram']);
        assert.match(sql, /WHERE c\.id = \$1 AND c\.creator_id = \$2$/);
        assert.match(sql, /i\.creator_id = \$2 AND i\.recipient_id = \$3 AND i\.status = 'SENT' AND i\.campaign_id IS NOT NULL AND i\.platform = \$4/);
        assert.match(sql, /ORDER BY i\.timestamp DESC, i\.id DESC LIMIT 1/);
        assert.doesNotMatch(sql, /NOW\(\)|INTERVAL/i, 'the window is the code\'s (inBridgeWindow), so its edge can be tested');
    });

    it('a private reply inside the window is the conversation\'s source: stored once, and the campaign comes back', async () => {
        arrange(replied(60 * 60 * 1000));
        const source = await commentSource(lookup, NOW);

        assert.deepEqual(source, { campaignId: 'camp-1', triggerKeywords: 'plan, خطة', dmTemplate: 'Here: https://samifit.example/plan' });
        assert.equal(writes().length, 1);
        assert.equal(writes()[0]!.sql, 'UPDATE conversations SET source_campaign_id = $2 WHERE id = $1 AND creator_id = $3');
        assert.deepEqual(writes()[0]!.params, ['conv-1', 'camp-1', 'creator-1']);
    });

    it('A1: a match logs the id the private reply went to beside the id the DM came from, once, with how long ago', async () => {
        arrange(replied(90 * 60 * 1000));
        await commentSource(lookup, NOW);

        const lines = events('dm.bridge_matched');
        assert.equal(lines.length, 1);
        assert.equal(lines[0]!.level, 'info');
        assert.deepEqual(
            [lines[0]!.sender_id, lines[0]!.recipient_id, lines[0]!.same_id, lines[0]!.campaign_id, lines[0]!.interaction_id, lines[0]!.age_minutes, lines[0]!.previous_campaign_id],
            ['17841400000000001', '17841400000000001', true, 'camp-1', 'int-1', 90, null]
        );
    });

    it('THE WINDOW\'S EDGE: a reply sent exactly 7 days ago is a source; one millisecond older is not, and nothing is stored for it', async () => {
        arrange(replied(BRIDGE_WINDOW_MS));
        assert.equal((await commentSource(lookup, NOW))?.campaignId, 'camp-1', 'on the edge');
        assert.equal(writes().length, 1);

        asked = [];
        arrange(replied(BRIDGE_WINDOW_MS + 1));
        assert.equal(await commentSource(lookup, NOW), null, 'a millisecond past it');
        assert.equal(writes().length, 0);

        asked = [];
        arrange(replied(BRIDGE_WINDOW_MS - 1));
        assert.equal((await commentSource(lookup, NOW))?.campaignId, 'camp-1', 'a millisecond inside it');
    });

    it('a reply outside the window does not displace the source the conversation already has, which still holds', async () => {
        arrange(replied(BRIDGE_WINDOW_MS + 60_000, { current_source: 'camp-0', current_keywords: 'old', current_template: 'old text' }));
        const source = await commentSource(lookup, NOW);
        assert.deepEqual(source, { campaignId: 'camp-0', triggerKeywords: 'old', dmTemplate: 'old text' });
        assert.equal(writes().length, 0);
        assert.equal(events('dm.bridge_matched').length, 0);
    });

    it('a conversation that already names this campaign is not written or logged again: a match is ONE event', async () => {
        arrange(replied(1000, { current_source: 'camp-1', current_keywords: 'plan, خطة', current_template: 't' }));
        const source = await commentSource(lookup, NOW);
        assert.equal(source?.campaignId, 'camp-1');
        assert.equal(writes().length, 0);
        assert.equal(events('dm.bridge_matched').length, 0);
    });

    it('a newer private reply from another campaign takes over, and the log says what it replaced', async () => {
        arrange(replied(1000, { recent_campaign: 'camp-2', recent_keywords: 'c#', current_source: 'camp-1', current_keywords: 'plan' }));
        const source = await commentSource(lookup, NOW);
        assert.equal(source?.campaignId, 'camp-2');
        assert.deepEqual(writes()[0]!.params, ['conv-1', 'camp-2', 'creator-1']);
        assert.equal(events('dm.bridge_matched')[0]!.previous_campaign_id, 'camp-1');
    });

    it('a sender nobody replied to privately, and a conversation with no source, is no source and writes nothing', async () => {
        arrange(NONE);
        assert.equal(await commentSource(lookup, NOW), null);
        assert.equal(writes().length, 0);
        assert.equal(logged.length, 0, 'and says nothing: most DMs are not answers to a comment');
    });

    it('a conversation that does not exist is no source', async () => {
        arrange(null);
        assert.equal(await commentSource(lookup, NOW), null);
    });

    it('a campaign that has been deleted since (no keywords to read) is no source, in the window or out of it', async () => {
        arrange(replied(1000, { recent_keywords: null, recent_template: null }));
        assert.equal(await commentSource(lookup, NOW), null);
        assert.equal(writes().length, 0);
    });

    it('asks for the conversation\'s own network: a Messenger sender is looked up among Facebook comments', async () => {
        arrange(null);
        await commentSource({ ...lookup, platform: 'facebook' }, NOW);
        assert.equal(asked[0]!.params[3], 'facebook');
    });

    it('NEVER THROWS: a database that is behind (v41 not applied) is no source, and one warning says the turn runs as it would have', async () => {
        arrange(null);
        answering(() => new Error('column i.recipient_id does not exist'));
        assert.equal(await commentSource(lookup, NOW), null);
        const lines = events('dm.bridge_failed');
        assert.equal(lines.length, 1);
        assert.deepEqual([lines[0]!.level, lines[0]!.stage], ['warn', 'lookup']);
    });

    it('a write that fails is logged and the source is still used for this turn: the context is true whether or not it was stored', async () => {
        arrange(replied(1000), new Error('deadlock detected'));
        const source = await commentSource(lookup, NOW);
        assert.equal(source?.campaignId, 'camp-1');
        const lines = events('dm.bridge_failed');
        assert.equal(lines.length, 1);
        assert.deepEqual([lines[0]!.level, lines[0]!.stage], ['warn', 'store']);
    });
});
