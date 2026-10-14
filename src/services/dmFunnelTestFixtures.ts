/**
 * Tests only: the numbers the DM funnel must produce for one fixture world, worked out BY HAND from the rows of that world.
 * Imported by `dmFunnel.test.ts` (which feeds `buildDmFunnel` the facts the statements would answer) and by `dmFunnel.sql.test.ts` (which
 * inserts the raw rows into a real Postgres and runs the real statements), so the two meet in the same numbers. Production code never reads it.
 *
 * The world, one line per conversation (tenant A unless said; "wrote" is the customer's FIRST message, days before the test's now):
 *
 *   c1   wrote 2 d     stage new, never answered
 *   c2   wrote 3 d     stage qualify, one qualifying question; the bot answered in 6 s (a reply from before ai_meta: no meta)
 *   c3   wrote 4 d     stage recommend; answered in 10 s
 *   c4   wrote 5 d     stage link, link sent, nobody clicked; the OWNER answered by hand after 30 s (not the bot's time)
 *   c5   wrote 6 d     stage follow_up, link sent, nudged once; two clicks, BOTH previews (a crawler), so not clicked; answered in 8 s; a second
 *                      message an hour later met only the nudge, which is no reply
 *   c6   wrote 7 d     stage link, link sent; one person's click and one preview, so clicked; answered in 20 s
 *   c7   wrote 8 d     stage handoff (refund), never recommended anything; answered in 2 s
 *   c8   wrote 9 d     stage handoff (complaint) after recommend and objection (only the replies' ai_meta remember them); answered in 3, 9 and 11 s
 *   c9   wrote 10 d    stage closed, opted out; answered in 12 s
 *   c10  wrote 11 d    stage link, link sent, three clicks by a person on its one link, so ONE conversation clicked; answered in 14 s
 *   c11  no message from the customer (a private reply the bot wrote first): not a conversation of the funnel
 *   c12  wrote 40 d    stage link, link sent, one click; wrote again 3 d ago and was answered in 16 s (its first message, 100 s)
 *   B    tenant B's conversation: link sent, a click, answered in 1 s. It must change nothing of tenant A's numbers.
 *
 * Over 30 days the cohort is c1 to c10 (c12 began 40 days ago). Worked out:
 *
 *   linked        c4, c5, c6, c10                        = 4
 *   recommended   those four, c3, and c8 (the replies remember recommend and objection)        = 6
 *   qualified     those six and c2                       = 7
 *   clicked       c6 and c10 (c5 had previews only, c4 none)          = 2
 *   outcomes      follow_up c5 = 1; handoff c7, c8 = 2; closed c9 = 1; opted out c9 = 1; complaints c8 = 1
 *   rates         link 4/6 = 67%, click 2/4 = 50%, handoff 2/10 = 20%, opt-out 1/10 = 10%
 *   visits        a person: c6 1 + c10 3 = 4; previews: c5 2 + c6 1 = 3   (c12's click is outside the cohort; B's is another tenant's)
 *   answered      customer messages in the window that the bot answered next, in ms:
 *                 c2 6000, c3 10000, c5 8000, c6 20000, c7 2000, c8 3000 + 9000 + 11000, c9 12000, c10 14000, c12 16000 (its recent message)
 *                 sorted 2000 3000 6000 8000 9000 10000 11000 12000 14000 16000 20000: n = 11, median the 6th = 10000, p90 at 0.9 x 10 = 9 -> 16000
 *
 * Over 90 days c12 joins the cohort (11 conversations): linked 5, recommended 7, qualified 8, clicked 3 (c12 too), visits by a person 5.
 * Its first message (answered in 100000) is now in the window too: n = 12, median (10000 + 11000) / 2 = 10500, p90 at 0.9 x 11 = 9.9 ->
 * 16000 + 0.9 x (20000 - 16000) = 19600. Percentages: 8/11 = 73, 7/11 = 64, 5/11 = 45, 3/11 = 27, link 5/7 = 71, click 3/5 = 60,
 * handoff 2/11 = 18, opt-out 1/11 = 9.
 */
import type { DmFunnel } from './dmFunnel.js';

type Expected = Omit<DmFunnel, 'since'>;

export const EXPECTED_30: Expected = {
    days: 30,
    conversations: 10,
    steps: [
        { id: 'conversations', count: 10, pct: 100 },
        { id: 'qualified', count: 7, pct: 70 },
        { id: 'recommended', count: 6, pct: 60 },
        { id: 'link_sent', count: 4, pct: 40 },
        { id: 'clicked', count: 2, pct: 20 },
    ],
    outcomes: { follow_up: 1, handoff: 2, closed: 1, opted_out: 1, complaints: 1 },
    rates: {
        link: { count: 4, of: 6, pct: 67 },
        click: { count: 2, of: 4, pct: 50 },
        handoff: { count: 2, of: 10, pct: 20 },
        opt_out: { count: 1, of: 10, pct: 10 },
    },
    clicks: { people: 2, human: 4, preview: 3 },
    reply: { sample: 11, median_ms: 10000, p90_ms: 16000 },
};

export const EXPECTED_90: Expected = {
    days: 90,
    conversations: 11,
    steps: [
        { id: 'conversations', count: 11, pct: 100 },
        { id: 'qualified', count: 8, pct: 73 },
        { id: 'recommended', count: 7, pct: 64 },
        { id: 'link_sent', count: 5, pct: 45 },
        { id: 'clicked', count: 3, pct: 27 },
    ],
    outcomes: { follow_up: 1, handoff: 2, closed: 1, opted_out: 1, complaints: 1 },
    rates: {
        link: { count: 5, of: 7, pct: 71 },
        click: { count: 3, of: 5, pct: 60 },
        handoff: { count: 2, of: 11, pct: 18 },
        opt_out: { count: 1, of: 11, pct: 9 },
    },
    clicks: { people: 3, human: 5, preview: 3 },
    reply: { sample: 12, median_ms: 10500, p90_ms: 19600 },
};
