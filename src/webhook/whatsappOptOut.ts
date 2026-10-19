/**
 * A WhatsApp contact asking to be left alone (WhatsApp agent W7 wired in: docs/specs/001-whatsapp-agent T044, review C2; the module it calls is `services/consent.ts`).
 *
 * `whatsappInbound.ts` asks `matchStopMessage` of the words of every message a LISTED tester sends, after the row is stored and before any gate decides whether the
 * agent answers (an opt-out is honoured in every mode, `off` included, and while a person has the thread). When the WHOLE message is a stop phrase, THIS decides
 * and the sales turn is never run for it: one path, so one message cannot be an opt-out twice (two confirmations, two stamps).
 *
 * ## It agrees with Instagram, because Instagram's turn is the rule
 *
 * Instagram and Messenger have always opted a person out inside the sales turn (`dmSales/turn.ts`: the prefilter's `opt_out` -> `optOutDecision`, `flow.ts`), and what that
 * writes is the contract here too:
 *
 *   the thread is CLOSED     `stage = 'closed'`, `last_intent = 'opt_out'`, and the BOT IS PAUSED (`is_bot_active = false`)
 *   the opt-out is stamped   `conversations.opted_out_at`
 *   ONE line is sent         the confirmation; then silence
 *
 * What W7 adds on top, for WhatsApp: the consent history (`contact_consents`: `withdrawn` for service, updates and marketing, with the wording and the source) and the
 * cancellation of the contact's pending `dm.followup` jobs, all in ONE transaction with the thread's close (`withdrawAll` with `closeThread`), so a withdrawal never lands
 * without the pause (or the pause without the withdrawal). The stage, the intent and the pause are NOT written twice in two dialects: `closeThread` takes them from
 * `optOutDecision`, the same decision Instagram's turn makes, and a test fails if that stops being so.
 *
 * ## What happens when an opted-out contact writes again (the Instagram rule)
 *
 *   - the thread is paused, so the message is STORED and concluded `bot_paused`: the agent does not answer it, and the owner sees it ("Needs you": a paused thread whose
 *     last message is the customer's). The owner may answer by hand, or switch the bot back on from the inbox
 *   - switching it back on does NOT clear `opted_out_at`: it is what every follow-up checks (`followup.ts` `opted_out`, `followupJob.ts`), so nothing is ever SENT to the
 *     contact unprompted again; the bot answers only what they write, and the stage stays `closed` so it does not pitch (`staysClosed` in `flow.ts`)
 *   - a second stop phrase is recorded (the consent history is append-only) and answered with NOTHING: `conversationsNewlyOptedOut` is 0, and the confirmation is for the
 *     first time only. It is concluded `opted_out`
 *
 * ## The confirmation
 *
 * `confirmationText(lang)`, in the language of the phrase, through `sendWhatsAppReply` (a free reply inside the window the stop message just opened; the sender writes the
 * outbound row). It goes only when (a) this is the first opt-out of the thread, and (b) the agent may speak at all right now (`confirm`: the agent is not off, the connection is
 * active, nobody has taken the thread over): an owner who switched the agent off must not be answered by it, and a person who has the thread sees the stop for himself.
 * **A confirmation that cannot be sent never undoes the opt-out**: it is logged and nothing is retried (a send that may have landed must not be repeated, and a lost
 * confirmation is a lesser harm than a lost opt-out).
 */
import { sendWhatsAppReply } from '../services/channels/send.js';
import { confirmationText, withdrawAll, type ConsentLang, type WithdrawAllInput, type WithdrawAllOutcome } from '../services/consent.js';
import { optOutDecision } from '../services/dmSales/flow.js';
import type { Intent } from '../services/dmSales/types.js';
import { describeError, log } from '../utils/log.js';

/**
 * What an opt-out does to the thread, taken from the decision Instagram's turn makes for "stop" (`optOutDecision`): the stage it moves to. The intent is the one `INTENT_OF`
 * in `turn.ts` writes as `last_intent` for the prefilter's `opt_out`. The pause is implied: Instagram's `conclude` pauses the bot for exactly `decision.optOut`.
 */
export const OPT_OUT_THREAD: { stage: string; lastIntent: Intent } = (() => {
    const decision = optOutDecision({ qualifierTurns: 0, abuseStrikes: 0 });
    if (!decision.optOut) throw new Error('flow.ts no longer makes "stop" an opt-out: the WhatsApp opt-out has nothing to agree with.');
    return { stage: decision.stage, lastIntent: 'opt_out' };
})();

export interface WhatsAppStopInput {
    creatorId: string;
    conversationId: string;
    /** The contact's BSUID: the thread's key and the consent's contact. */
    senderId: string;
    /** What they wrote: kept as the `wording` of the consent rows. */
    text: string;
    /** The language of the phrase, which is the language of the confirmation. */
    lang: ConsentLang;
    /** The agent may speak now (not off, an active connection, a thread nobody took over): only then may the confirmation go. */
    confirm: boolean;
}

export type StopConfirmation =
    /** The confirmation went out. */
    | 'sent'
    /** A repeat: the contact was opted out already, so there is nothing to confirm a second time. */
    | 'not_needed'
    /** The agent may not speak right now (off, a refused connection, a thread a person has). */
    | 'not_allowed'
    /** The sender refused or failed. The opt-out stands. */
    | 'failed';

export interface WhatsAppStopResult {
    /** This stop is the one that opted the thread out (it was not opted out before). */
    newlyOptedOut: boolean;
    followupsCancelled: number;
    confirmation: StopConfirmation;
}

/** The decision, as the inbound handler takes it: injectable, so its tests need no consent store and no sender. A database failure THROWS: the job is retried and the opt-out is not lost. */
export type WhatsAppStopFn = (input: WhatsAppStopInput) => Promise<WhatsAppStopResult>;

export interface OptOutDeps {
    withdraw: (input: WithdrawAllInput) => Promise<WithdrawAllOutcome>;
    send: typeof sendWhatsAppReply;
}

const LIVE: OptOutDeps = { withdraw: withdrawAll, send: sendWhatsAppReply };

/** Opt a WhatsApp contact out. See the top of the file. Throws only when the withdrawal itself could not be written (nothing was sent then). */
export async function optOutWhatsAppContact(input: WhatsAppStopInput, deps: OptOutDeps = LIVE): Promise<WhatsAppStopResult> {
    const logBase = { creator_id: input.creatorId, conversation_id: input.conversationId };

    // One transaction: three withdrawn rows, the stamp, the pause and the closed stage, the follow-ups. A throw is before anything is sent.
    const outcome = await deps.withdraw({
        creatorId: input.creatorId,
        platform: 'whatsapp',
        contactRef: input.senderId,
        conversationId: input.conversationId,
        wording: input.text,
        closeThread: { stage: OPT_OUT_THREAD.stage, lastIntent: OPT_OUT_THREAD.lastIntent },
    });
    const newlyOptedOut = outcome.conversationsNewlyOptedOut > 0;

    let confirmation: StopConfirmation = 'not_needed';
    if (newlyOptedOut) {
        if (!input.confirm) {
            confirmation = 'not_allowed';
            log('info', 'wa.optout_confirmation_skipped', { ...logBase, reason: 'agent_cannot_speak' });
        } else {
            try {
                const sent = await deps.send({ creatorId: input.creatorId, conversationId: input.conversationId, kind: 'agent', body: { text: confirmationText(input.lang) } });
                if (sent.ok) {
                    confirmation = 'sent';
                } else {
                    confirmation = 'failed';
                    log('warn', 'wa.optout_confirmation_not_sent', { ...logBase, reason: sent.reason, attempted: sent.attempted, effect: 'the opt-out stands' });
                }
            } catch (err) {
                confirmation = 'failed';
                log('error', 'wa.optout_confirmation_not_sent', { ...logBase, ...describeError(err), effect: 'the opt-out stands' });
            }
        }
    }
    log('info', 'wa.opted_out', { ...logBase, newly: newlyOptedOut, confirmation, followups_cancelled: outcome.followupsCancelled });
    return { newlyOptedOut, followupsCancelled: outcome.followupsCancelled, confirmation };
}
