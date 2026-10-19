/**
 * The sales system prompt (docs/DM_SALES_PLAN.md §3): pure, and pinned by goldens. Nothing calls it yet (S6 does).
 *
 * Order, static parts first so that the prefix of one tenant's prompt is the same on every turn and can be cached:
 *
 *   persona (`ai_agents.system_prompt`, as the owner wrote it) → who the bot answers for → voice (the profile's guide, the emoji
 *   level) → the offers with a link, each as a block of data → the offers without one → the profile's general FAQ → the knowledge
 *   base (`ai_agents.knowledge_base`) → hours and the hand-off rule → the fixed rules (from the language kit) → this conversation's
 *   own facts, last.
 *
 * What the model is NOT shown: a link (it is told an offer has one, and the system sends it), and a price the bot may not say
 * (`price.ts`). It cannot copy what it never saw, and `guard.ts` catches what it makes up instead.
 *
 * The same pass that writes the prompt writes `claims`, the facts the guard checks the reply against: every word a person typed that
 * the model was shown, and the prices it was allowed to see. They are built from one traversal of the same data, so what the model was
 * shown and what the guard lets through cannot drift apart.
 *
 * The owner's `dmSystemInstruction` and its golden are not touched: this is a separate prompt for a separate path, behind `sales_mode`.
 */
import type { ProfileContext } from '../profile/context.js';
import { type SalesKit, kitFor } from '../profile/kits.js';
import type { Offer } from '../profile/types.js';
import type { ClaimFacts } from './guard.js';
import { type LivePrice, livePrice } from './price.js';
import { MAX_QUALIFIER_TURNS, type SalesFacts } from './types.js';

/** What of the profile's `dm` context the prompt reads, so a test can hand it a context cut from a profile. */
export type SalesContext = Pick<ProfileContext<'dm'>, 'language' | 'who' | 'names' | 'offers' | 'faq' | 'handoff' | 'hours' | 'voice' | 'voice_guide' | 'links'>;

export interface SalesPromptInput {
    /** `ai_agents.system_prompt`, verbatim. */
    persona: string;
    /** `ai_agents.knowledge_base`. */
    knowledge: string | null;
    ctx: SalesContext;
    /** The tenant's IANA timezone (`identity.timezone`): the hours are in it, and "valid until" is the end of that day in it. Empty reads as UTC. */
    timezone: string;
    /** The moment the prompt is for. A parameter so the prompt is a function of its arguments, and a price expires on a date and not on a deploy. */
    now: Date;
}

/** One offer as the rest of the sales turn needs it (`coerce.ts` takes `{ id, hasLink }`). */
export interface SalesOfferInfo {
    id: string;
    name: string;
    hasLink: boolean;
    /** Whether the price is one the bot may say today. */
    priceLive: boolean;
}

export interface SalesPrompt {
    /** The whole prompt: `prefix`, and the conversation's facts after it when they were given. */
    system: string;
    /** Everything but the conversation's facts. Identical on every turn of one tenant (until the prices' dates or the data change): the cacheable part. */
    prefix: string;
    /** What `guard.ts` checks the reply against. */
    claims: ClaimFacts;
    /** The primary offer first, then the others in the profile's order. */
    offers: SalesOfferInfo[];
}

/**
 * The links the model may repeat (`ClaimFacts.allowedLinks`): the creator's own site and social links, as the profile has them. Never an
 * offer's address, which the model is not shown and the server inserts itself, and never the handle, which is a name and not an address.
 */
export function ownLinks(links: SalesContext['links']): string[] {
    return [...new Set([links.site, ...Object.values(links.links)].map((l) => (l ?? '').trim()).filter(Boolean))];
}

/** An offer's address is something to send. */
const hasLink = (offer: Offer): boolean => /^https?:\/\/\S+$/i.test(offer.url.trim());

/** How the creator is called to a customer: their name in the language of the conversation, else the other one, else the brand, else the kit's phrase. */
export function creatorName(ctx: Pick<SalesContext, 'language' | 'names'>, kit: SalesKit = kitFor(ctx.language).sales): string {
    const { ar, en } = ctx.names.display_name;
    const [own, other] = ctx.language.code === 'ar' ? [ar, en] : [en, ar];
    return own.trim() || other.trim() || ctx.names.brand_name.trim() || kit.ownerFallback;
}

/** The primary offer first, the rest in the order the profile has them. */
function ordered(offers: readonly Offer[]): Offer[] {
    return [...offers.filter((o) => o.primary), ...offers.filter((o) => !o.primary)];
}

/** `prefix` as lines under `heading`. */
const section = (heading: string, lines: readonly string[]): string => [heading, ...lines].join('\n');

interface Collected {
    /** What a person typed and the model was shown, for the guard. */
    texts: string[];
    prices: LivePrice[];
}

/** One offer's block of data, and what the guard may learn from it. */
function offerBlock(offer: Offer, kit: SalesKit, now: Date, timezone: string, into: Collected): string {
    const l = kit.offer;
    const sales = offer.sales;
    const lines: string[] = [`${l.id(offer.id)} ${offer.name}${offer.primary ? ` ${l.primary}` : ''}`];
    into.texts.push(offer.name);
    lines.push(`- ${l.link}`);

    const price = livePrice(offer, now, timezone);
    if (price) {
        lines.push(`- ${l.priceLive(price.text, price.validUntil)}`);
        into.prices.push(price);
        into.texts.push(price.text);
    } else {
        lines.push(`- ${l.priceNone}`);
    }
    const add = (label: string, value: string): void => {
        const text = value.trim();
        if (!text) return;
        lines.push(`- ${label}: ${text}`);
        into.texts.push(text);
    };
    const addList = (label: string, items: readonly string[]): void => {
        const kept = items.map((i) => i.trim()).filter(Boolean);
        if (kept.length === 0) return;
        lines.push(`- ${label}:`, ...kept.map((i) => `  - ${i}`));
        into.texts.push(...kept);
    };
    if (sales) {
        add(l.priceNote, sales.price_note);
        add(l.forWhom, sales.for_whom);
        if (sales.level !== 'any') add(l.level, l.levels[sales.level]);
        addList(l.outcomes, sales.outcomes);
    }
    addList(l.facts, offer.facts);
    addList(l.includes, offer.bullets);
    if (sales) {
        if (sales.faqs.length > 0) {
            lines.push(`- ${l.faqs}:`);
            for (const f of sales.faqs) {
                lines.push(`  Q: ${f.q.trim()}`, `  A: ${f.a.trim()}`);
                into.texts.push(f.q, f.a);
            }
        }
        if (sales.objections.length > 0) {
            for (const o of sales.objections) {
                lines.push(`- ${l.objection}: «${o.objection.trim()}»`, `  ${l.answer}: ${o.answer.trim()}`);
                into.texts.push(o.objection, o.answer);
            }
        }
        if (sales.proof.length > 0) {
            lines.push(`- ${l.proof}:`);
            for (const p of sales.proof) {
                lines.push(`  - [${l.proofKinds[p.kind]}] ${p.text.trim()} (${l.source}: ${p.source.trim()})`);
                into.texts.push(p.text, p.source);
            }
        }
    }
    return lines.join('\n');
}

/** "Sunday, Monday" for the days in the hours, in the week's own order (0 is Sunday). */
const dayNames = (days: readonly number[], names: readonly string[], separator: string): string =>
    [...new Set(days)].sort((a, b) => a - b).map((d) => names[d]).filter((n): n is string => Boolean(n)).join(separator);

/**
 * The conversation's own facts, as the last block of the prompt. Kept out of `prefix` so that a turn's prefix is the same as the last
 * one's. Stages are written as the schema writes them, in every language.
 */
export function salesFactsBlock(ctx: Pick<SalesContext, 'language' | 'offers'>, facts: SalesFacts): string {
    const kit = kitFor(ctx.language).sales;
    const c = kit.conversation;
    const nameOf = (id: string | null): string | null => (id ? ctx.offers.find((o) => o.id === id)?.name ?? id : null);
    const lines = [kit.headers.conversation, c.stage(facts.stage), c.qualifiers(facts.qualifierTurns, MAX_QUALIFIER_TURNS)];
    lines.push(facts.linkSentFor.length > 0 ? c.linkSent(facts.linkSentFor.map((id) => nameOf(id) ?? id).join(', ')) : c.linkNotSent);
    if (facts.channel) lines.push(c.channel[facts.channel]);
    if (facts.comment) lines.push(c.comment(facts.comment.keyword, nameOf(facts.comment.offerId)));
    if (facts.tapped) lines.push(c.tapped(facts.tapped.intent));
    if (facts.variant?.opening) lines.push(c.variantOpening(facts.variant.opening));
    if (facts.variant?.cta) lines.push(c.variantCta(facts.variant.cta));
    return lines.join('\n');
}

/** The sales prompt for one tenant, and the facts a reply to it is checked against. See the top of the file for what is in it and why. */
export function buildSalesPrompt(input: SalesPromptInput, facts?: SalesFacts): SalesPrompt {
    const { ctx, now, timezone } = input;
    const kit = kitFor(ctx.language).sales;
    const owner = creatorName(ctx, kit);
    const collected: Collected = { texts: [], prices: [] };
    const blocks: string[] = [];

    const persona = input.persona.trim();
    if (persona) {
        blocks.push(persona);
        collected.texts.push(persona);
    }
    const role = ctx.who.role.trim();
    const niche = ctx.who.niche.trim();
    blocks.push(kit.identity(owner, role, niche));
    collected.texts.push(owner, role, niche);

    // Voice: the guide verbatim, and how many emoji. `voice.address` is not used: the rule is neutral address unless the person's own words show it.
    // The guide is the DM's own (`dm.voice_guide`) when the owner typed one, else the profile's: `voice.guide` is tuned for posts ("one point per
    // slide", "the link is in the bio"), which a chat reply is not. A blank one counts as none, so the default prompt is the one it always was.
    const guide = ctx.voice_guide.trim() || ctx.voice.guide.trim();
    blocks.push(section(kit.headers.voice, [...(guide ? [guide] : []), kit.emoji[ctx.voice.emoji]]));
    if (guide) collected.texts.push(guide);

    // Offers: those with a link are what the bot sells; the rest it can only name.
    const all = ordered(ctx.offers);
    const linked = all.filter(hasLink);
    const unlinked = all.filter((o) => !hasLink(o));
    if (linked.length > 0) {
        blocks.push(section(kit.headers.offers, linked.map((o) => offerBlock(o, kit, now, timezone, collected))));
    } else {
        blocks.push(kit.noOffers(owner));
    }
    if (unlinked.length > 0) {
        blocks.push(section(kit.headers.otherOffers, unlinked.map((o) => kit.noLink(o.name, o.id, owner))));
        collected.texts.push(...unlinked.map((o) => o.name));
    }

    if (ctx.faq.length > 0) {
        blocks.push(section(kit.headers.faq, ctx.faq.flatMap((f) => [`Q: ${f.q.trim()}`, `A: ${f.a.trim()}`])));
        collected.texts.push(...ctx.faq.flatMap((f) => [f.q, f.a]));
    }

    const knowledge = (input.knowledge ?? '').trim();
    if (knowledge) {
        blocks.push(section(kit.headers.knowledge, [knowledge]));
        collected.texts.push(knowledge);
    }

    const hoursLines: string[] = [];
    if (ctx.hours) {
        const days = dayNames(ctx.hours.days, kit.hours.days, ctx.language.code === 'ar' ? '، ' : ', ');
        hoursLines.push(kit.hours.line(owner, days, ctx.hours.from, ctx.hours.to, timezone || 'UTC'));
    }
    if (ctx.handoff && ctx.handoff.when.trim()) hoursLines.push(kit.hours.handoff(ctx.handoff.when.trim()));
    if (hoursLines.length > 0) {
        blocks.push(section(kit.headers.hours, hoursLines));
        collected.texts.push(...hoursLines);
    }

    blocks.push(section(kit.headers.rules, kit.rules(owner).map((rule, i) => `${i + 1}. ${rule}`)));

    const prefix = blocks.join('\n\n');
    const system = facts ? `${prefix}\n\n${salesFactsBlock(ctx, facts)}` : prefix;
    return {
        system,
        prefix,
        claims: { texts: collected.texts.filter((t) => t.trim().length > 0), prices: collected.prices, allowedLinks: ownLinks(ctx.links) },
        offers: all.map((o) => ({ id: o.id, name: o.name, hasLink: hasLink(o), priceLive: livePrice(o, now, timezone) !== null })),
    };
}
