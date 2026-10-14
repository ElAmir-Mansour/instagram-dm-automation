/**
 * The link a sales reply carries (docs/DM_SALES_PLAN.md §3, §9): the one place that decides what URL a customer is sent for an offer.
 *
 * It is a tracked link (S7, `src/services/links.ts`): `https://<our domain>/r/<code>`, one code per (conversation, offer), which answers 302 to
 * the offer's own address byte for byte (so any tracking or affiliate parameter on it survives) and counts the visit. That is how the funnel
 * learns "link sent" and "clicked", which Meta reports neither of. The domain is `app.public_base_url` (the saved setting, then
 * `PUBLIC_BASE_URL`), never a request's Host header: a DM is not a request.
 *
 * **It never costs a customer their link.** If the tracked link cannot be made (the public address is not set, the offer's address is not one
 * a link may point to, the database is behind or down), the offer's own address is sent as it is, and the failure is logged
 * `dm.tracked_link_failed`: an untracked link still sells, a reply that promised a link and carried none does not. Sending the same offer again
 * in the same conversation gives the same code (`createTrackedLink`'s own rule), so a repeated link is one row.
 *
 * The model never writes a link: `guard.ts` takes out any it does. `linkFor` is the only source of one.
 */
import { describeError, log } from '../../utils/log.js';
import { getPublicBaseUrl } from '../appSettings.js';
import { createTrackedLink } from '../links.js';
import type { Offer } from '../profile/types.js';

/** Who the link is for: what a tracked link is recorded against. */
export interface LinkConversation {
    id: string;
    creatorId: string;
}

/** The address to send for `offer` in `conversation`: its tracked link, else (and only if that cannot be made) the offer's own `url`, trimmed. */
export async function linkFor(offer: Pick<Offer, 'id' | 'url'>, conversation: LinkConversation): Promise<string> {
    const target = offer.url.trim();
    try {
        const base = await getPublicBaseUrl(null);
        if (!base) {
            log('warn', 'dm.tracked_link_failed', {
                creator_id: conversation.creatorId, conversation_id: conversation.id, offer_id: offer.id, reason: 'no_public_base_url',
                effect: 'the offer\'s own address was sent, untracked',
            });
            return target;
        }
        const code = await createTrackedLink(conversation.creatorId, offer.id, target, conversation.id);
        return `${base}/r/${code}`;
    } catch (err) {
        log('warn', 'dm.tracked_link_failed', {
            creator_id: conversation.creatorId, conversation_id: conversation.id, offer_id: offer.id, ...describeError(err),
            effect: 'the offer\'s own address was sent, untracked',
        });
        return target;
    }
}
