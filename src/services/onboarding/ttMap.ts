/**
 * What a connected TikTok account gives the draft engine (docs/onboarding/03 §1, "TikTok"; P33). Pure: reading the stored connection is in
 * `draftSources.ts`; this is the step from the profile fields to the one source a draft is made from.
 *
 * Where the fields come from: `user.info.profile`, a scope the app asks for only when the operator has said the TikTok portal approved it
 * (`tiktok.profile_scope_enabled`, default off). Connect then reads `username`, `bio_description`, `profile_deep_link` and `is_verified` and
 * keeps them with the connection (`platform_connections.profile`, v44) beside the display name that `user.info.basic` always gave.
 * @see https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
 *
 * Not here, on purpose:
 *   - follower, following, likes and video counts. They belong to `user.info.stats`, a third scope this app does not request, so TikTok
 *     would not return them. The draft's `followers` stays Instagram's.
 *   - the avatar. The owner's rule on images: a profile picture is never read.
 *
 * Nothing connected, or connected with the scope off (every connection today), is not a failure: it is a source that was not there.
 */
import type { DraftSource } from './fence.js';

/** The pieces of a TikTok connection the draft reads (a structural type: this module imports nothing that talks to TikTok). */
export interface TikTokProfileData {
    /** `user.info.basic`: always read at connect time. */
    displayName: string | null;
    /** The three below come with `user.info.profile`. */
    username: string | null;
    bio: string | null;
    profileLink: string | null;
    verified: boolean | null;
    /** When the fields were read (ISO), so an old bio is known to be old. Null when unknown. */
    fetchedAt: string | null;
}

/** A TikTok profile link is `https://www.tiktok.com/@name`: anything else in `profile_deep_link` is not shown to a model as a link. */
const TIKTOK_PROFILE_LINK = /^https:\/\/(?:www\.|vm\.)?tiktok\.com\/[^\s]{1,200}$/i;

/** The profile link when it is TikTok's own and well formed, else null. A model repeats a URL only if a source holds it, so a hostile one is never offered. */
export function safeProfileLink(link: string | null): string | null {
    const trimmed = link?.trim() ?? '';
    return TIKTOK_PROFILE_LINK.test(trimmed) ? trimmed : null;
}

/** Whether there is anything from `user.info.profile` to read: a bio, a username or a link. A display name alone is not a source. */
export function hasProfileText(profile: Pick<TikTokProfileData, 'username' | 'bio' | 'profileLink'>): boolean {
    return Boolean(profile.bio?.trim() || profile.username?.trim() || safeProfileLink(profile.profileLink));
}

/**
 * The source a TikTok profile gives: `tt_about`, one block of the display name, the `@username`, the bio, the profile link and, only when
 * TikTok says so, that the account is verified. Not cleaned here: `prepareSources` does that for the whole list.
 * Empty when `user.info.profile` gave nothing to read.
 */
export function tiktokSources(profile: TikTokProfileData): DraftSource[] {
    if (!hasProfileText(profile)) return [];
    const lines: string[] = [];
    if (profile.displayName?.trim()) lines.push(profile.displayName.trim());
    if (profile.username?.trim()) lines.push(`@${profile.username.trim().replace(/^@/, '')}`);
    if (profile.bio?.trim()) lines.push(profile.bio.trim());
    const link = safeProfileLink(profile.profileLink);
    if (link) lines.push(link);
    if (profile.verified === true) lines.push('TikTok shows this account as verified.');
    return [{ id: 'tt_about', kind: 'tt_bio', text: lines.join('\n') }];
}
