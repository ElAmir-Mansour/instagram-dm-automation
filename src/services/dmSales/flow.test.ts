/**
 * The sales flow's rules (`flow.ts`): the code decides the stage, the model only proposes one.
 *
 * Every row of the tables is a thing a model can say that the flow must not simply believe: a stage it cannot be in (`link` with no link
 * sent), a way back (`link` to `qualify`), a way out of a hand-off or a "no", a third qualifying question, a sale to a person who asked to
 * be left alone. The mutation that matters is the one that lets the proposal through: it is caught by the rows that name a stage the
 * model proposed and the table refuses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    abuseDecision, decideTurn, handoffDecision, loopDecision, MAX_ABUSE_STRIKES, nextStage, optOutDecision, QUALIFIER_CORRECTION, unchangedDecision,
} from './flow.js';
import { MAX_QUALIFIER_TURNS, type Intent, type NextAction, type SalesReply, type Stage } from './types.js';

/** A model's answer, as coercion hands it over: everything given, the rest the quiet defaults. */
const answer = (over: Partial<SalesReply> = {}): SalesReply => ({
    text: 'ok', quick_replies: [], intent: 'info', stage: 'new', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', ...over,
});

const FACTS = { qualifierTurns: 0, abuseStrikes: 0 };

describe('nextStage: a plain reply moves a conversation only where the flow allows', () => {
    // [what, from, the model's proposal, the intent, expected]
    const rows: [string, Stage, Stage, Intent, Stage][] = [
        ['a first message stays new', 'new', 'new', 'greeting', 'new'],
        ['new may move to qualify', 'new', 'qualify', 'info', 'qualify'],
        ['new may move straight to recommend (they asked about the plan)', 'new', 'recommend', 'price', 'recommend'],
        ['qualify moves on to recommend', 'qualify', 'recommend', 'level_fit', 'recommend'],
        ['qualify does not go back to new', 'qualify', 'new', 'info', 'qualify'],
        ['recommend does not go back to qualify in a plain reply', 'recommend', 'qualify', 'info', 'recommend'],
        ['recommend does not go back to new', 'recommend', 'new', 'info', 'recommend'],
        ['link is never reached by a plain reply: no link was sent', 'recommend', 'link', 'info', 'recommend'],
        ['link is not reached from new either', 'new', 'link', 'ready_to_buy', 'new'],
        ['once a link is sent, a plain reply cannot undo it', 'link', 'qualify', 'info', 'link'],
        ['once a link is sent, "new" is not a way back', 'link', 'new', 'greeting', 'link'],
        ['follow_up belongs to the follow-up job, never to a model', 'link', 'follow_up', 'info', 'link'],
        ['follow_up is not proposable from new either', 'new', 'follow_up', 'info', 'new'],
        ['handoff is entered by the action, not by naming the stage', 'new', 'handoff', 'info', 'new'],
        ['closed is entered by the action, not by naming the stage', 'recommend', 'closed', 'info', 'recommend'],
        ['an objection intent is the objection stage, whatever the model named', 'recommend', 'recommend', 'objection_price', 'objection'],
        ['an objection after a link is still an objection', 'link', 'link', 'objection_trust', 'objection'],
        ['after an objection, the model may go back to recommending', 'objection', 'recommend', 'info', 'recommend'],
        ['after an objection the conversation stays in it until the model moves it', 'objection', 'objection', 'info', 'objection'],
        ['a conversation the owner resumed after a hand-off starts afresh', 'handoff', 'recommend', 'info', 'recommend'],
        ['a resumed conversation is not "link" because the model says so', 'handoff', 'link', 'info', 'new'],
        ['a closed conversation stays closed for an ordinary question', 'closed', 'recommend', 'info', 'closed'],
        ['a closed conversation stays closed for a question about the price', 'closed', 'recommend', 'price', 'closed'],
        ['a closed conversation reopens when they say they want to buy', 'closed', 'recommend', 'ready_to_buy', 'recommend'],
    ];
    for (const [what, from, proposed, intent, expected] of rows) {
        it(`${what} (${from} + ${proposed} → ${expected})`, () => {
            assert.equal(nextStage(from, answer({ stage: proposed, intent }), FACTS), expected);
        });
    }
});

describe('nextStage: the action decides, whatever stage the model named', () => {
    const rows: [string, Stage, NextAction, number, Stage][] = [
        ['send_link is the link stage', 'new', 'send_link', 0, 'link'],
        ['send_link from an objection is the link stage', 'objection', 'send_link', 0, 'link'],
        ['recommend is the recommend stage', 'qualify', 'recommend', 1, 'recommend'],
        ['a first qualifying question is qualify', 'new', 'ask_qualifier', 0, 'qualify'],
        ['a second qualifying question is still qualify', 'qualify', 'ask_qualifier', 1, 'qualify'],
        ['a third is recommend: the questions are used up', 'qualify', 'ask_qualifier', MAX_QUALIFIER_TURNS, 'recommend'],
        ['handoff is the handoff stage from anywhere', 'link', 'handoff', 0, 'handoff'],
        ['close is the closed stage from anywhere', 'recommend', 'close', 0, 'closed'],
    ];
    for (const [what, from, action, qualifierTurns, expected] of rows) {
        it(`${what}`, () => {
            // The model proposed `new` every time: the answer is the action's.
            assert.equal(nextStage(from, answer({ stage: 'new', next_action: action }), { qualifierTurns }), expected);
        });
    }

    it('an opt-out is closed even when the action was a plain reply', () => {
        assert.equal(nextStage('recommend', answer({ intent: 'opt_out', next_action: 'reply' }), FACTS), 'closed');
    });

    it('a closed conversation is not sold to: send_link and recommend do not move it unless they said they want to buy', () => {
        assert.equal(nextStage('closed', answer({ intent: 'info', next_action: 'send_link' }), FACTS), 'closed');
        assert.equal(nextStage('closed', answer({ intent: 'info', next_action: 'recommend' }), FACTS), 'closed');
        assert.equal(nextStage('closed', answer({ intent: 'ready_to_buy', next_action: 'send_link' }), FACTS), 'link');
    });
});

describe('decideTurn: what happens to the reply', () => {
    it('a plain reply is sent as it is, in the stage the flow allows', () => {
        const d = decideTurn('new', answer({ stage: 'qualify', intent: 'info' }), FACTS);
        assert.deepEqual([d.effect, d.stage, d.action, d.qualifierTurns, d.correction], ['reply', 'qualify', 'reply', 0, null]);
        assert.deepEqual(d.overrides, []);
    });

    it('a qualifying question counts, and a recommendation and a link do not', () => {
        assert.equal(decideTurn('new', answer({ next_action: 'ask_qualifier' }), FACTS).qualifierTurns, 1);
        assert.equal(decideTurn('qualify', answer({ next_action: 'ask_qualifier' }), { qualifierTurns: 1, abuseStrikes: 0 }).qualifierTurns, 2);
        assert.equal(decideTurn('qualify', answer({ next_action: 'recommend', offer_id: 'a' }), { qualifierTurns: 1, abuseStrikes: 0 }).qualifierTurns, 1);
        assert.equal(decideTurn('qualify', answer({ next_action: 'send_link', offer_id: 'a' }), { qualifierTurns: 1, abuseStrikes: 0 }).qualifierTurns, 1);
    });

    it('a link is a link only if the action says so: send_link is the one action that makes the server add one', () => {
        assert.equal(decideTurn('recommend', answer({ next_action: 'send_link', offer_id: 'a', intent: 'ready_to_buy' }), FACTS).action, 'send_link');
        assert.equal(decideTurn('recommend', answer({ next_action: 'recommend', offer_id: 'a' }), FACTS).action, 'recommend');
        assert.equal(decideTurn('recommend', answer({ next_action: 'reply', stage: 'link' }), FACTS).action, 'reply');
    });

    it('a third qualifying question is asked again once, with the correction', () => {
        const d = decideTurn('qualify', answer({ next_action: 'ask_qualifier', stage: 'qualify' }), { qualifierTurns: MAX_QUALIFIER_TURNS, abuseStrikes: 0 });
        assert.equal(d.correction, QUALIFIER_CORRECTION);
        assert.ok(d.overrides.includes('qualifier_cap'));
        assert.match(QUALIFIER_CORRECTION, /do not ask another/);
    });

    it('and a model that still asks is recorded as recommending: the conversation is out of questions, and the stage says so', () => {
        const d = decideTurn('qualify', answer({ next_action: 'ask_qualifier', stage: 'qualify' }), { qualifierTurns: MAX_QUALIFIER_TURNS, abuseStrikes: 0, final: true });
        assert.equal(d.correction, null);
        assert.deepEqual([d.effect, d.stage, d.action, d.qualifierTurns], ['reply', 'recommend', 'reply', MAX_QUALIFIER_TURNS]);
        assert.ok(d.overrides.includes('qualifier_cap_kept'));
    });

    it('a hand-off is the hand-off line and a paused bot, whatever the model wrote', () => {
        const d = decideTurn('recommend', answer({ next_action: 'handoff', handoff_reason: 'refund', stage: 'recommend', text: 'Here is a discount!' }), FACTS);
        assert.deepEqual([d.effect, d.stage, d.action, d.handoffReason], ['handoff', 'handoff', 'handoff', 'refund']);
    });

    it('a hand-off that names no reason is "unsure", never none', () => {
        assert.equal(decideTurn('new', answer({ next_action: 'handoff', handoff_reason: 'none' }), FACTS).handoffReason, 'unsure');
    });

    it('an opt-out is told once, recorded, and closes the conversation', () => {
        const d = decideTurn('link', answer({ intent: 'opt_out', next_action: 'close' }), FACTS);
        assert.deepEqual([d.effect, d.stage, d.optOut], ['close', 'closed', true]);
        assert.equal(decideTurn('link', answer({ intent: 'opt_out', next_action: 'reply' }), FACTS).optOut, true, 'even when the action said reply');
    });

    it('a polite close that is not an opt-out keeps the model\'s words and does not pause the bot', () => {
        const d = decideTurn('recommend', answer({ intent: 'info', next_action: 'close' }), FACTS);
        assert.deepEqual([d.effect, d.stage, d.optOut], ['close', 'closed', false]);
    });

    it('nothing is sold to a closed conversation: a question, a recommendation or a link becomes a plain reply, noted', () => {
        for (const action of ['ask_qualifier', 'recommend', 'send_link'] as const) {
            const d = decideTurn('closed', answer({ intent: 'info', next_action: action, offer_id: 'a' }), FACTS);
            assert.deepEqual([d.effect, d.action, d.stage], ['reply', 'reply', 'closed'], action);
            assert.ok(d.overrides.includes('closed_no_sales'), action);
        }
    });

    it('unless THEY say they want to buy: then the link goes', () => {
        const d = decideTurn('closed', answer({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'a' }), FACTS);
        assert.deepEqual([d.effect, d.action, d.stage], ['reply', 'send_link', 'link']);
    });

    it('records what the code overruled: the stage the model named and the stage it got', () => {
        const d = decideTurn('link', answer({ stage: 'qualify', intent: 'info' }), FACTS);
        assert.equal(d.stage, 'link');
        assert.ok(d.overrides.includes('stage:qualify->link'));
    });
});

describe('decideTurn and abuse: one calm line, then the bot is done', () => {
    it('the first insult gets one calm line, the stage where it was, and a strike', () => {
        const d = decideTurn('recommend', answer({ intent: 'abuse', next_action: 'reply' }), FACTS);
        assert.deepEqual([d.effect, d.stage, d.abuseStrikes, d.handoffReason], ['calm', 'recommend', 1, 'none']);
    });

    it('the second pauses the bot and says nothing: no hand-off message, no sales', () => {
        const d = decideTurn('recommend', answer({ intent: 'abuse', next_action: 'reply' }), { qualifierTurns: 0, abuseStrikes: 1 });
        assert.deepEqual([d.effect, d.stage, d.abuseStrikes, d.handoffReason, d.action], ['pause', 'closed', MAX_ABUSE_STRIKES, 'abuse', 'close']);
    });

    it('a model that says handoff with the reason "abuse" is the same as the intent', () => {
        const d = decideTurn('new', answer({ intent: 'other', next_action: 'handoff', handoff_reason: 'abuse' }), FACTS);
        assert.equal(d.effect, 'calm');
    });

    it('the prefilter\'s insult goes through the same rule', () => {
        assert.equal(abuseDecision('new', FACTS).effect, 'calm');
        assert.equal(abuseDecision('new', { qualifierTurns: 0, abuseStrikes: 1 }).effect, 'pause');
        assert.equal(abuseDecision('handoff', FACTS).stage, 'new', 'a resumed conversation is a fresh one');
    });
});

describe('the decisions the prefilter and the guards make', () => {
    it('a hand-off pauses at the handoff stage with its reason, and carries an opt-out when the message also said stop', () => {
        const d = handoffDecision('refund', { qualifierTurns: 1, abuseStrikes: 0 });
        assert.deepEqual([d.effect, d.stage, d.action, d.handoffReason, d.optOut, d.qualifierTurns], ['handoff', 'handoff', 'handoff', 'refund', false, 1]);
        assert.equal(handoffDecision('complaint', FACTS, true).optOut, true);
    });

    it('an opt-out closes the conversation and says so once', () => {
        const d = optOutDecision(FACTS);
        assert.deepEqual([d.effect, d.stage, d.optOut, d.handoffReason], ['close', 'closed', true, 'none']);
    });

    it('a loop pauses the bot at the handoff stage and sends nothing', () => {
        const d = loopDecision(FACTS);
        assert.deepEqual([d.effect, d.stage, d.handoffReason, d.overrides], ['pause', 'handoff', 'unsure', ['reply_cap']]);
    });

    it('a reply the legacy path wrote moves nothing: the stage, the counts and the strikes stay', () => {
        const d = unchangedDecision('qualify', { qualifierTurns: 1, abuseStrikes: 1 }, ['model_failed']);
        assert.deepEqual([d.effect, d.stage, d.action, d.qualifierTurns, d.abuseStrikes, d.overrides], ['reply', 'qualify', 'reply', 1, 1, ['model_failed']]);
    });
});
