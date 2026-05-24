import axios from 'axios';

export const API_VERSION = 'v21.0';

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
 * - Instagram: POST /{comment-id}/replies
 * - Facebook:  POST /{comment-id}/comments
 *
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-comment/replies
 * @see https://developers.facebook.com/docs/graph-api/reference/comment#Creating
 */
export async function sendPublicReply(
    commentId: string,
    message: string,
    accessToken: string,
    isFacebook = false         // Facebook uses /comments edge; Instagram uses /replies
) {
    const edge = isFacebook ? 'comments' : 'replies';
    const url = `https://graph.facebook.com/${API_VERSION}/${commentId}/${edge}`;

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

/**
 * Automatically likes a comment.
 * 
 * - Instagram & Facebook: POST /{comment-id}/likes
 * 
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-comment/likes
 */
export async function likeComment(
    commentId: string,
    accessToken: string
) {
    const url = `https://graph.facebook.com/${API_VERSION}/${commentId}/likes`;

    try {
        const response = await axios.post(url, {}, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error: any) {
        const metaError = error.response?.data?.error;
        throw new Error(
            `Comment Auto-Like Failed: ${metaError?.message || error.message} (Code: ${metaError?.code || 'N/A'})`
        );
    }
}

/**
 * Publishes a post to a Facebook Page feed.
 * Supports image, video, and text-only feed posts.
 */
export async function publishFacebookPost(
    pageId: string,
    type: 'image' | 'video' | 'reel' | 'story',
    caption: string,
    mediaUrl: string | null,
    accessToken: string
) {
    let url = `https://graph.facebook.com/${API_VERSION}/${pageId}/feed`;
    let payload: any = { message: caption };

    if (type === 'image' && mediaUrl) {
        url = `https://graph.facebook.com/${API_VERSION}/${pageId}/photos`;
        payload = { url: mediaUrl, caption: caption };
    } else if (type === 'video' && mediaUrl) {
        url = `https://graph.facebook.com/${API_VERSION}/${pageId}/videos`;
        payload = { file_url: mediaUrl, description: caption };
    }

    try {
        const response = await axios.post(url, payload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return response.data; // returns { id: "post_id" }
    } catch (error: any) {
        const metaError = error.response?.data?.error;
        throw new Error(
            `Facebook Publish Failed: ${metaError?.message || error.message} (Code: ${metaError?.code || 'N/A'})`
        );
    }
}

/**
 * Publishes a post to an Instagram Business account.
 * Handles the 2-step media container lifecycle (create container, check status, publish).
 */
export async function publishInstagramPost(
    instagramId: string,
    type: 'image' | 'video' | 'reel' | 'story',
    caption: string,
    mediaUrl: string,
    accessToken: string
) {
    const createUrl = `https://graph.facebook.com/${API_VERSION}/${instagramId}/media`;
    let createPayload: any = {};

    if (type === 'image') {
        createPayload = { image_url: mediaUrl, caption: caption };
    } else if (type === 'video' || type === 'reel') {
        createPayload = { media_type: 'REELS', video_url: mediaUrl, caption: caption };
    } else if (type === 'story') {
        const isVideo = mediaUrl.match(/\.(mp4|mov|avi|wmv)/i);
        if (isVideo) {
            createPayload = { media_type: 'STORIES', video_url: mediaUrl };
        } else {
            createPayload = { media_type: 'STORIES', image_url: mediaUrl };
        }
    }

    try {
        // Step 1: Create media container
        console.log(`[IG Publish] Step 1: Creating container for type ${type}...`);
        const createRes = await axios.post(createUrl, createPayload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        const containerId = createRes.data.id;
        console.log(`[IG Publish] Container created: ${containerId}`);

        // Check and poll status for all media containers (image, video, reel, story) to make sure processing is complete
        console.log(`[IG Publish] Polling status for container ${containerId}...`);
        let status = 'IN_PROGRESS';
        let retries = 15; // Max 15 retries * 5s = 75s
        let statusDetail = '';

        while (status === 'IN_PROGRESS' && retries > 0) {
            // Check status
            const statusRes = await axios.get(
                `https://graph.facebook.com/${API_VERSION}/${containerId}`,
                {
                    params: { fields: 'status_code,status', access_token: accessToken }
                }
            );
            status = statusRes.data.status_code;
            statusDetail = statusRes.data.status || '';
            console.log(`[IG Publish] Container status: ${status} (Detail: ${statusDetail}) (Retries left: ${retries})`);
            
            if (status === 'ERROR' || status === 'EXPIRED') {
                throw new Error(`Instagram media processing failed with status: ${status}. Detail: ${statusDetail}`);
            }

            if (status === 'FINISHED') {
                break;
            }

            retries--;
            if (retries > 0 && status === 'IN_PROGRESS') {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        if (status !== 'FINISHED') {
            throw new Error('Instagram media processing timed out.');
        }

        // Step 2: Publish container
        console.log(`[IG Publish] Step 2: Publishing container ${containerId}...`);
        const publishUrl = `https://graph.facebook.com/${API_VERSION}/${instagramId}/media_publish`;
        const publishRes = await axios.post(publishUrl, {
            creation_id: containerId
        }, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        console.log(`[IG Publish] Success! Published post ID: ${publishRes.data.id}`);
        return publishRes.data; // returns { id: "media_id" }
    } catch (error: any) {
        const metaError = error.response?.data?.error;
        throw new Error(
            `Instagram Publish Failed: ${metaError?.message || error.message} (Code: ${metaError?.code || 'N/A'})`
        );
    }
}

