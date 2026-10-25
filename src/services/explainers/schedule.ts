/**
 * Schedule: a ready explainer becomes posts (FR-027, US5), the way an infographic does (infographics.ts `scheduleInfographic`), through the same
 * `insertVideoPost` that the Monteur's approve and the composer write rows with, so they publish through the same sweep:
 *
 *   Instagram and Facebook   one row, `both` (or the one that is on): the VERTICAL video with its cover, and `captions.meta`
 *   YouTube                  the HORIZONTAL video when the render is longer than 3 minutes, otherwise the vertical one as a Short; `captions.youtube`
 *                            (its title and description), `{ title, language }`. A long video gets no thumbnail of ours: the cover is a vertical frame, and
 *                            YouTube picks its own for a horizontal video. A Short gets the cover.
 *   TikTok                   the vertical video as an inbox draft (`{ mode: 'inbox' }`): the creator posts it from the TikTok app; `captions.tiktok`
 *
 * One `group_id` for all of them, and each platform has its own caption. When the track the sound used requires credit, its credit line goes at the end of every
 * caption (FR-025). The time is the next free slot (the Monteur's `post_at`, in the tenant's zone, as infographics take it), a time the owner names, or now.
 *
 * Which platforms: spec.md lists them (Instagram and Facebook, YouTube, TikTok) and names no setting for them. Instagram, Facebook and YouTube follow the
 * brand's `infographic.platforms`, the one setting that already says where this owner's videos are posted; TikTok has no entry there and is an inbox draft that
 * the owner posts by hand anyway, so it is always made. A platform that is not connected is not checked here: its row fails in Posts, saying so, and does not
 * keep the others off (the infographics' rule).
 *
 * Refused (409): an explainer that is not `ready`, a render that is older than the edits (its video is not the script's), and sound that is music when the track
 * is no longer in the library (its credit line cannot be written).
 */
import crypto from 'crypto';
import type { ExplainerRow, ScheduledPostRow } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { metaPlatformFor, insertVideoPost } from '../monteur/clips.js';
import { lockTenantPublishing, StudioError, withTransaction, isPlainObject } from '../studio/common.js';
import { getStudioSettings } from '../studio/settings.js';
import { nextFreeSlots } from '../studio/slots.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { validateTikTokInboxOptions } from '../tiktokPublish.js';
import { ExplainerError } from './errors.js';
import { trackOf } from './payloads.js';
import { type ExplainerView, explainerIdOf, loadView } from './explainers.js';
import { transitionExplainer } from './state.js';
import { lockExplainer } from './store.js';

/** Longer than this, YouTube gets the horizontal video; at most this, the vertical one as a Short (FR-027). */
export const YOUTUBE_SHORT_MAX_SECONDS = 180;
/** The posting slots looked through for the next free one. */
const SLOT_LOOKAHEAD = 30;
/** Each platform's caption limit: Instagram and TikTok 2,200, YouTube's description 5,000. */
const CAPTION_LIMIT = { meta: 2200, youtube: 5000, tiktok: 2200 } as const;

export interface ExplainerScheduleOutcome {
    explainer: ExplainerView;
    scheduled_time: string;
    rows: ScheduledPostRow[];
    /** Captions that were cut to fit a platform's limit with the credit line on the end: the body is cut, never the credit. */
    trimmed: ('meta' | 'youtube' | 'tiktok')[];
}

/**
 * A caption with the credit line at its end, within the platform's limit. The credit is the licence's condition and goes in whole; when the two do not fit, the
 * caption's body is cut (at a word) and ends with an ellipsis.
 */
export function withCredit(caption: string, credit: string | null, max: number): { text: string; trimmed: boolean } {
    const body = caption.trim();
    if (!credit?.trim()) return { text: body, trimmed: false };
    const line = credit.trim();
    const joined = body ? `${body}\n\n${line}` : line;
    if ([...joined].length <= max) return { text: joined, trimmed: false };
    const room = max - [...line].length - 2 - 1;
    if (room <= 0) return { text: [...line].slice(0, max).join(''), trimmed: true };
    let cut = [...body].slice(0, room).join('');
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
    return { text: `${cut.trimEnd()}…\n\n${line}`, trimmed: true };
}

/** `now`, `next` (the default), or a date and time. A time that is not one is a 400 with the schedule code. */
export function parseWhen(raw: unknown): { kind: 'now' | 'next' | 'at'; at?: Date } {
    if (raw === undefined || raw === null || raw === 'next') return { kind: 'next' };
    if (raw === 'now') return { kind: 'now' };
    const at = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
    if (Number.isNaN(at.getTime())) throw new StudioError(400, 'when must be "next", "now", or a date and time, e.g. 2026-10-14T16:00:00Z.', undefined, 'INVALID_SCHEDULE_TIME');
    return { kind: 'at', at };
}

/** The rows an explainer needs the schedule to know: what to post, from what, with which credit. Throws what stops a schedule. */
function readyToPost(row: ExplainerRow, settings: Pick<StudioSettings, 'explainer'>): { render: NonNullable<ExplainerRow['render']>; credit: string | null } {
    if (row.status !== 'ready' || !row.render) {
        throw new ExplainerError('EXPLAINER_BAD_STATE', `This explainer is ${row.status}; only a ready one can be scheduled.`, { status: row.status, to: 'schedule' });
    }
    if (row.render.version !== row.draft_version || row.render.sound_mode !== row.sound_mode) {
        throw new ExplainerError('EXPLAINER_RENDER_STALE', 'The video was rendered before your latest edits (the narration or the sound changed). Render it again, then schedule.');
    }
    const track = trackOf(row, settings);
    if (row.render.sound_mode === 'music' && !track) {
        throw new ExplainerError('EXPLAINER_NO_TRACK', 'The sound is music, but its track is not in the library, so its credit line cannot be added to the captions. Choose another track and render again, or switch to sound effects only.');
    }
    return { render: row.render, credit: track?.credit_required ? track.credit : null };
}

/**
 * POST /explainers/:id/schedule `{ when? }`: the posts, in one group, at the next free slot, a given time, or now. The explainer becomes `scheduled`, with the
 * time, the group and the rows it made.
 */
export async function scheduleExplainer(creatorId: string, rawId: unknown, body: unknown, now: number = Date.now()): Promise<ExplainerScheduleOutcome> {
    const id = explainerIdOf(rawId);
    const when = parseWhen(isPlainObject(body) ? body.when : undefined);
    const settings = await getStudioSettings(creatorId);
    const meta = metaPlatformFor(settings.infographic.platforms);
    const youtube = settings.infographic.platforms.includes('youtube');

    return withTransaction(async (client) => {
        await lockTenantPublishing(client, creatorId);
        const row = await lockExplainer(client, creatorId, id);
        if (!row) throw new ExplainerError('EXPLAINER_NOT_FOUND', 'No such explainer.');
        const { render, credit } = readyToPost(row, settings);
        const captions = row.draft?.captions;
        if (!captions) throw new ExplainerError('EXPLAINER_BAD_STATE', 'This explainer has no captions to post.', { status: row.status, to: 'schedule' });

        let at: Date;
        if (when.kind === 'now') at = new Date(now);
        else if (when.kind === 'at') at = when.at!;
        else {
            const free = await nextFreeSlots(creatorId, { timezone: settings.schedule.timezone, slots: settings.monteur.post_at }, SLOT_LOOKAHEAD, now, { exec: client });
            if (!free[0]) throw new StudioError(409, 'There is no free posting slot in the next weeks: choose a time.', undefined, 'NO_FREE_SLOT');
            at = new Date(free[0]);
        }

        const groupId = crypto.randomUUID();
        const rows: ScheduledPostRow[] = [];
        const trimmed: ExplainerScheduleOutcome['trimmed'] = [];
        const caption = (key: 'meta' | 'youtube' | 'tiktok', text: string): string => {
            const made = withCredit(text, credit, CAPTION_LIMIT[key]);
            if (made.trimmed) trimmed.push(key);
            return made.text;
        };
        if (meta) {
            rows.push(await insertVideoPost(client, {
                creatorId, platform: meta, caption: caption('meta', captions.meta), mediaUrl: render.vertical_url, coverUrl: render.cover_url, when: at, groupId, options: null,
            }));
        }
        if (youtube) {
            // Not checked against the connection: a YouTube that is not connected must not keep the post off Instagram and Facebook. Its row fails in Posts, saying so.
            const long = render.duration > YOUTUBE_SHORT_MAX_SECONDS;
            rows.push(await insertVideoPost(client, {
                creatorId, platform: 'youtube', caption: caption('youtube', captions.youtube.description), mediaUrl: long ? render.horizontal_url : render.vertical_url,
                coverUrl: long ? null : render.cover_url, when: at, groupId, options: { title: captions.youtube.title.trim() || row.title || row.topic, language: row.language },
            }));
        }
        const inbox = validateTikTokInboxOptions(null, 'video');
        if (!inbox.ok) throw new StudioError(400, inbox.error);
        rows.push(await insertVideoPost(client, {
            creatorId, platform: 'tiktok', caption: caption('tiktok', captions.tiktok), mediaUrl: render.vertical_url, coverUrl: null, when: at, groupId, options: inbox.options,
        }));

        const schedule = { scheduled_time: at.toISOString(), group_id: groupId, row_ids: rows.map((r) => r.id) };
        await transitionExplainer(client, id, ['ready'], 'scheduled', { schedule }, creatorId);
        log('info', 'explainer.scheduled', {
            explainer_id: id, rows: rows.length, platforms: rows.map((r) => r.platform), scheduled_time: schedule.scheduled_time, youtube_video: render.duration > YOUTUBE_SHORT_MAX_SECONDS ? 'horizontal' : 'vertical',
            credit: credit !== null, trimmed,
        });
        return { explainer: await loadView(client, creatorId, id), scheduled_time: schedule.scheduled_time, rows, trimmed };
    });
}
