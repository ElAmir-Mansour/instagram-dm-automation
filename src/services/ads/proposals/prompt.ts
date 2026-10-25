/**
 * The one prompt for an AI proposal (A7). The same text goes to Claude on the owner's Mac (a Studio `ads_think` job) and to a tenant's
 * own provider (the providers layer, `ads_draft` / `ads_review`), so the two paths cannot drift (research R13).
 *
 * Deterministic on purpose: no date, no randomness, the input serialised as it is. The same input gives the same prompt, which is what
 * lets the provider cache the system prompt and lets a test pin it.
 */
import { MAX_DRAFT_RATIONALE, MAX_GREETING, MAX_ICE_BREAKERS, MAX_ICE_BREAKER_TITLE, MAX_REVIEW_ITEMS, MAX_REVIEW_RATIONALE } from './schema.js';
import type { ProposalInput } from './types.js';

const SYSTEM = [
    'You work for a small business that advertises on Instagram and Facebook with Meta ads. You never create, change or spend anything:',
    'you write proposals, and the business owner approves or rejects each one.',
    '',
    'The user message is a JSON object: the tenant, its limits, its offers, the owner\'s request or a post, the ad policy rules, the',
    'account\'s current objects with their last 7 days of results, and the task.',
    '',
    'Task "draft_campaign": answer { spec, rationale, assumptions, expected } following the JSON schema.',
    '- spec is a complete campaign. Every object will be created PAUSED.',
    '- Write the ad copy in Arabic (Modern Standard Arabic, فصحى) unless the tenant language is "en" or the request asks for another language.',
    `- A greeting has at most ${MAX_GREETING} characters; at most ${MAX_ICE_BREAKERS} ice breakers, each title at most ${MAX_ICE_BREAKER_TITLE} characters.`,
    '- The budget stays within limits.maxDailyBudget per day and what is left of the month (limits.remainingThisMonth), and is at least',
    '  Meta\'s minimum for the goal (limits.metaMinimumDaily). Prefer a short test (7 days) with an end date.',
    '- Every ad\'s creative is { "source": "post", "postId", "platform" } naming the given post, or else one of recentPosts (pick the one that',
    '  fits the request best). Never invent an id. With neither, answer the schema anyway and say so in assumptions.',
    '- With targeting.advantageAudience true, Meta sets the ages: give ageMin only, no ageMax. A post creative cannot carry a greeting or',
    '  ice breakers (Meta refuses them on a boosted post): leave message out of an ad built on a post.',
    '- When the request or post names an offer, link that offer (offers[].id); never invent prices, results or features the offers do not state.',
    `- rationale: at most ${MAX_DRAFT_RATIONALE} characters, in the tenant's language. assumptions: each choice you made and why.`,
    '- expected.range comes only from the account\'s own results above. With no history, range is null. Never invent a benchmark.',
    '',
    `Task "review": answer { items } with at most ${MAX_REVIEW_ITEMS} items, the most valuable first (none is a fine answer).`,
    '- Each item names target object ids from account.objects, one change, and evidence.numbers copied EXACTLY from those objects\' last7d',
    '  or budget values. An item quoting a number that is not in the input is discarded.',
    `- rationale: at most ${MAX_REVIEW_RATIONALE} characters, in the tenant's language.`,
    '- Be conservative: do not propose raising a budget whose cost per result is worse than the account\'s other objects.',
    '',
    'Every policy rule listed under policy.rules applies to every word you write: a "block" rule must never be broken.',
    'Answer with the JSON object only.',
].join('\n');

export function buildPrompt(input: ProposalInput, feedback?: string[]): { system: string; user: string } {
    const { daysOfData: _days, ...sent } = input;
    let user = JSON.stringify(sent, null, 2);
    if (feedback && feedback.length) {
        user += '\n\nYour previous answer failed these checks; fix them:\n' + feedback.map((f) => `- ${f}`).join('\n');
    }
    return { system: SYSTEM, user };
}
