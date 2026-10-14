/**
 * The funnel's three statements, run against a REAL Postgres on the fixture world of `dmFunnelTestFixtures.ts`, and the result compared with
 * the numbers worked out by hand there. This is the test that says "the numbers match SQL": `dmFunnel.test.ts` proves the counting from fact
 * rows, this proves the statements produce those facts (the cohort, the stages the replies remember, the prefetch grouping, the tenant
 * filter, the reply-time pairing).
 *
 * Skipped unless `DM_FUNNEL_TEST_DATABASE_URL` names a database that `npm run migrate` has been applied to AND that is on this machine
 * (localhost, 127.0.0.1 or ::1: a hostname anywhere else is refused, so a pasted production URL cannot be used by mistake). Every row is
 * inserted inside one transaction that is ROLLED BACK, so nothing stays even in a scratch database.
 *
 *   DM_FUNNEL_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/scratch npm test
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';
import {
    buildDmFunnel, DM_FUNNEL_CLICKS_SQL, DM_FUNNEL_CONVERSATIONS_SQL, DM_FUNNEL_REPLY_SQL,
    type ClickFact, type ConversationFact, type DmFunnelWindow, type ReplyFact,
} from './dmFunnel.js';
import { EXPECTED_30, EXPECTED_90 } from './dmFunnelTestFixtures.js';

const URL_ENV = process.env.DM_FUNNEL_TEST_DATABASE_URL;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function skipReason(): string | false {
    if (!URL_ENV) return 'set DM_FUNNEL_TEST_DATABASE_URL to a local, migrated Postgres to run the funnel SQL against fixture rows';
    let host = '';
    try { host = new URL(URL_ENV).hostname; } catch { return 'DM_FUNNEL_TEST_DATABASE_URL is not a URL'; }
    return LOCAL_HOSTS.has(host) ? false : `DM_FUNNEL_TEST_DATABASE_URL points at ${host}: this test only runs against a database on this machine`;
}

const SEC = 1000;
const HOUR = 3600 * SEC;
const DAY = 24 * HOUR;

describe('the DM funnel statements on a real Postgres', { skip: skipReason() }, () => {
    it('answer, for the fixture world, the numbers worked out by hand: 30 days and 90 days, tenant A only', async () => {
        const client = new pg.Client({ connectionString: URL_ENV });
        await client.connect();
        try {
            await client.query('BEGIN');
            const now = Date.now();
            const ago = (ms: number): Date => new Date(now - ms);
            const A = randomUUID();
            const B = randomUUID();
            await client.query('INSERT INTO creators (id, name) VALUES ($1, $2), ($3, $4)', [A, 'Funnel test A', B, 'Funnel test B']);

            let seq = 0;
            interface ConvOver {
                stage?: string; qualifier_turns?: number; offers_linked?: string[]; last_link_at?: Date | null; followups_sent?: number;
                handoff_at?: Date | null; handoff_reason?: string | null; opted_out_at?: Date | null;
            }
            const conv = async (tenant: string, over: ConvOver = {}): Promise<string> => {
                const id = randomUUID();
                await client.query(
                    `INSERT INTO conversations (id, creator_id, instagram_user_id, stage, qualifier_turns, offers_linked, last_link_at, followups_sent,
                                                handoff_at, handoff_reason, opted_out_at, last_message_at)
                     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, NOW())`,
                    [id, tenant, `igsid-${++seq}`, over.stage ?? 'new', over.qualifier_turns ?? 0, over.offers_linked ?? [], over.last_link_at ?? null,
                        over.followups_sent ?? 0, over.handoff_at ?? null, over.handoff_reason ?? null, over.opted_out_at ?? null]
                );
                return id;
            };
            const msg = async (tenant: string, conversation: string, direction: 'inbound' | 'outbound', sender: string, at: Date, aiMeta: object | null = null): Promise<void> => {
                await client.query(
                    `INSERT INTO messages (conversation_id, creator_id, direction, text, sender, ai_meta, created_at) VALUES ($1, $2, $3, 'x', $4, $5::jsonb, $6)`,
                    [conversation, tenant, direction, sender, aiMeta === null ? null : JSON.stringify(aiMeta), at]
                );
            };
            /** A customer message at `back` before now and, `ms` later, the bot's answer to it. */
            const exchange = async (tenant: string, conversation: string, back: number, ms: number, aiMeta: object | null): Promise<void> => {
                await msg(tenant, conversation, 'inbound', 'customer', ago(back));
                await msg(tenant, conversation, 'outbound', 'ai', ago(back - ms), aiMeta);
            };
            const link = async (tenant: string, conversation: string, visits: Array<{ prefetch: boolean; n: number }>): Promise<void> => {
                const code = `lnk${String(++seq).padStart(7, '0')}`;
                await client.query('INSERT INTO tracked_links (code, creator_id, conversation_id, offer_id, target_url) VALUES ($1, $2, $3, $4, $5)',
                    [code, tenant, conversation, 'agentic', 'https://example.test/offer?ref=ABC']);
                for (const visit of visits) {
                    for (let i = 0; i < visit.n; i++) {
                        await client.query('INSERT INTO link_clicks (code, clicked_at, is_prefetch, ua_class) VALUES ($1, NOW(), $2, $3)', [code, visit.prefetch, visit.prefetch ? 'preview' : 'ios']);
                    }
                }
            };
            const sent = { offers_linked: ['agentic'], last_link_at: ago(HOUR) };

            const c1 = await conv(A, { stage: 'new' });
            await msg(A, c1, 'inbound', 'customer', ago(2 * DAY));

            const c2 = await conv(A, { stage: 'qualify', qualifier_turns: 1 });
            await exchange(A, c2, 3 * DAY, 6 * SEC, null);

            const c3 = await conv(A, { stage: 'recommend' });
            await exchange(A, c3, 4 * DAY, 10 * SEC, { stage: 'recommend', intent: 'price' });

            const c4 = await conv(A, { stage: 'link', ...sent });
            await msg(A, c4, 'inbound', 'customer', ago(5 * DAY));
            await msg(A, c4, 'outbound', 'operator', ago(5 * DAY - 30 * SEC));
            await msg(A, c4, 'outbound', 'ai', ago(5 * DAY - 60 * SEC), { stage: 'link' });
            await link(A, c4, []);

            const c5 = await conv(A, { stage: 'follow_up', followups_sent: 1, ...sent });
            await exchange(A, c5, 6 * DAY, 8 * SEC, { stage: 'link' });
            await msg(A, c5, 'inbound', 'customer', ago(6 * DAY - HOUR));
            await msg(A, c5, 'outbound', 'ai', ago(6 * DAY - 2 * HOUR), { kind: 'followup', engine: 'kit', stage: 'follow_up' });
            await link(A, c5, [{ prefetch: true, n: 2 }]);

            const c6 = await conv(A, { stage: 'link', ...sent });
            await exchange(A, c6, 7 * DAY, 20 * SEC, { stage: 'link' });
            await link(A, c6, [{ prefetch: false, n: 1 }, { prefetch: true, n: 1 }]);

            const c7 = await conv(A, { stage: 'handoff', handoff_at: ago(8 * DAY), handoff_reason: 'refund' });
            await exchange(A, c7, 8 * DAY, 2 * SEC, { stage: 'handoff', handoff_reason: 'refund' });

            const c8 = await conv(A, { stage: 'handoff', handoff_at: ago(9 * DAY - 2 * HOUR), handoff_reason: 'complaint' });
            await exchange(A, c8, 9 * DAY, 3 * SEC, { stage: 'recommend' });
            await exchange(A, c8, 9 * DAY - HOUR, 9 * SEC, { stage: 'objection' });
            await exchange(A, c8, 9 * DAY - 2 * HOUR, 11 * SEC, { stage: 'handoff' });

            const c9 = await conv(A, { stage: 'closed', opted_out_at: ago(10 * DAY) });
            await exchange(A, c9, 10 * DAY, 12 * SEC, { stage: 'closed', intent: 'opt_out' });

            const c10 = await conv(A, { stage: 'link', ...sent });
            await exchange(A, c10, 11 * DAY, 14 * SEC, { stage: 'link' });
            await link(A, c10, [{ prefetch: false, n: 3 }]);

            const c11 = await conv(A, { stage: 'new' });
            await msg(A, c11, 'outbound', 'automation', ago(5 * DAY));

            const c12 = await conv(A, { stage: 'link', ...sent });
            await exchange(A, c12, 40 * DAY, 100 * SEC, { stage: 'link' });
            await exchange(A, c12, 3 * DAY, 16 * SEC, { stage: 'link' });
            await link(A, c12, [{ prefetch: false, n: 1 }]);

            const other = await conv(B, { stage: 'link', ...sent });
            await exchange(B, other, 2 * DAY, 1 * SEC, { stage: 'link' });
            await link(B, other, [{ prefetch: false, n: 1 }]);

            const funnelOf = async (tenant: string, days: DmFunnelWindow) => {
                const since = new Date(now - days * DAY);
                // One after the other: a single client runs one statement at a time.
                const conversations = await client.query<ConversationFact>(DM_FUNNEL_CONVERSATIONS_SQL, [tenant, since]);
                const clicks = await client.query<ClickFact>(DM_FUNNEL_CLICKS_SQL, [tenant, since]);
                const reply = await client.query<ReplyFact>(DM_FUNNEL_REPLY_SQL, [tenant, since]);
                const { since: _ignored, ...funnel } = buildDmFunnel(conversations.rows, clicks.rows, reply.rows[0] ?? null, { days, now });
                return funnel;
            };

            assert.deepEqual(await funnelOf(A, 30), EXPECTED_30, '30 days');
            assert.deepEqual(await funnelOf(A, 90), EXPECTED_90, '90 days');

            // Tenant B sees only its own conversation: one, linked, clicked, answered in a second.
            const b = await funnelOf(B, 30);
            assert.equal(b.conversations, 1);
            assert.deepEqual(b.steps.map((s) => s.count), [1, 1, 1, 1, 1]);
            assert.deepEqual(b.reply, { sample: 1, median_ms: 1000, p90_ms: 1000 });

            // A tenant with nothing: zeros, and no division by zero.
            const none = await funnelOf(randomUUID(), 30);
            assert.equal(none.conversations, 0);
            assert.deepEqual(none.rates.link, { count: 0, of: 0, pct: null });
            assert.deepEqual(none.reply, { sample: 0, median_ms: null, p90_ms: null });
        } finally {
            await client.query('ROLLBACK').catch(() => undefined);
            await client.end();
        }
    });
});
