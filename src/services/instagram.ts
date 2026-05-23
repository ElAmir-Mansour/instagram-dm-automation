import axios from 'axios';

const API_VERSION = 'v21.0';

/**
 * Sends a Direct Message to a user as a Private Reply to their comment.
 *
 * - Instagram: uses /me/messages  (token resolves to the IG-linked page)
 * - Facebook:  uses /{pageId}/messages  (required for FB Page tokens per 2025 Meta docs)
 *
 * Limit: 1 private reply per comment, must be sent within 7 days.
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
 */
export async function sendPrivateReply(
    commentId: string,
    message: string,
    accessToken: string,
    pageId?: string            // Pass Facebook Page ID for FB comments; omit for Instagram
) {
    // Facebook requires /{page-id}/messages; Instagram works with /me/messages
    const endpoint = pageId ? pageId : 'me';
    const url = `https://graph.facebook.com/${API_VERSION}/${endpoint}/messages`;

    try {
        const response = await axios.post(url, {
            recipient: { comment_id: commentId },
            message: { text: message },
            messaging_type: 'RESPONSE'
        }, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error: any) {
        const metaError = error.response?.data?.error;
        throw new Error(
            `Private Reply Failed [${endpoint}]: ${metaError?.message || error.message} (Code: ${metaError?.code || 'N/A'})`
        );
    }
}

/**
 * Posts a public comment reply visible to everyone on the post.
 * 
 * Commonly used to reply with something like "Check your DMs! 📩"
 * so other users can see there's an active promotion.
 * 
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-comment/replies
 */
export async function sendPublicReply(commentId: string, message: string, accessToken: string) {
    const url = `https://graph.facebook.com/${API_VERSION}/${commentId}/replies`;

    try {
        const response = await axios.post(url, {
            message: message
        }, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error: any) {
        const metaError = error.response?.data?.error;
        throw new Error(
            `Public Reply Failed: ${metaError?.message || error.message} (Code: ${metaError?.code || 'N/A'})`
        );
    }
}

/**
 * Sends a standard Direct Message (DM) to an Instagram User ID (IGSID).
 * Supports text, quick replies, and templates (carousels).
 * 
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/reference/send-api
 */
export async function sendDirectMessage(
    recipientId: string,
    messagePayload: any,
    accessToken: string,
    pageId?: string            // Pass Facebook Page ID for FB DMs; omit for Instagram
) {
    const endpoint = pageId ? pageId : 'me';
    const url = `https://graph.facebook.com/${API_VERSION}/${endpoint}/messages`;

    try {
        const response = await axios.post(url, {
            recipient: { id: recipientId },
            message: messagePayload
        }, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error: any) {
        const metaError = error.response?.data?.error;
        throw new Error(
            `DM Send Failed: ${metaError?.message || error.message} (Code: ${metaError?.code || 'N/A'})`
        );
    }
}

