/**
 * The Graph calls behind the Growth screen's "Add keyword ask" (src/services/facebookAsk.ts).
 *
 * Meta documents `POST /{page-post-id}` with `message` as the way to edit a Page post (Page Post
 * reference, "Updating"; the Page token needs pages_manage_posts) and `POST /{post-id}/comments`
 * for a Page comment (pages_manage_engagement). The Video node documents no update at all, so the
 * object edited is the post — `<page>_<post>`, which is exactly what `post_insights.media_id`
 * holds. Every call goes through metaHttp/withRetry like the rest of the Graph traffic.
 */
import { metaHttp, withRetry } from './http.js';
import { GRAPH_BASE, metaFailure } from './instagram.js';

const auth = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });

/** The post's text as it is on Facebook now, not as the last sync stored it. */
export async function getFacebookPostMessage(postId: string, accessToken: string): Promise<string> {
    try {
        const response = await withRetry(
            () => metaHttp.get(`${GRAPH_BASE}/${postId}`, { params: { fields: 'message' }, headers: auth(accessToken) }),
            { label: 'getFacebookPostMessage' }
        );
        const message = response.data?.message;
        return typeof message === 'string' ? message : '';
    } catch (error: any) {
        throw metaFailure('Facebook Post Read Failed', error);
    }
}

/**
 * Replaces the post's text. Setting a value is idempotent — a retry writes the same text again —
 * so the ordinary retry rules apply; nothing is created.
 */
export async function updateFacebookPostMessage(postId: string, message: string, accessToken: string): Promise<void> {
    try {
        await withRetry(
            () => metaHttp.post(`${GRAPH_BASE}/${postId}`, { message }, { headers: auth(accessToken) }),
            { label: 'updateFacebookPostMessage' }
        );
    } catch (error: any) {
        throw metaFailure('Facebook Post Edit Failed', error);
    }
}

/** The texts of the post's first 100 top-level comments, to see whether the ask is already there. */
export async function listFacebookPostCommentTexts(postId: string, accessToken: string): Promise<string[]> {
    try {
        const response = await withRetry(
            () => metaHttp.get(`${GRAPH_BASE}/${postId}/comments`, {
                params: { fields: 'message', filter: 'toplevel', limit: 100 },
                headers: auth(accessToken),
            }),
            { label: 'listFacebookPostCommentTexts' }
        );
        const data: unknown[] = Array.isArray(response.data?.data) ? response.data.data : [];
        return data.map((c: any) => (typeof c?.message === 'string' ? c.message : ''));
    } catch (error: any) {
        throw metaFailure('Facebook Comments Read Failed', error);
    }
}

/** Comments as the Page. That creates something public, so it is never retried when it may have landed. */
export async function commentOnFacebookPost(postId: string, message: string, accessToken: string): Promise<{ id?: string }> {
    try {
        const response = await withRetry(
            () => metaHttp.post(`${GRAPH_BASE}/${postId}/comments`, { message }, { headers: auth(accessToken) }),
            { label: 'commentOnFacebookPost', creates: true }
        );
        return response.data ?? {};
    } catch (error: any) {
        throw metaFailure('Facebook Comment Failed', error);
    }
}
