/**
 * "An ad was rejected" (`ad_rejected`) and "An ad has issues" (`ad_issues`): the two alerts the Settings card has always offered, raised by
 * the hourly structure sync (`sync.ts` `syncStructure`), the only code that reads each ad's delivery state (`effective_status`, with
 * `issues_info` and `ad_review_feedback`) from Meta. Nothing else writes DISAPPROVED or WITH_ISSUES: `ops.ts` writes `effective_status`
 * only for ARCHIVED and DELETED.
 *
 * ## The rule (owner-approved 2026-10-26)
 * - Only a CHANGE seen on a row that already existed. A move INTO `DISAPPROVED` raises `ad_rejected`, one into `WITH_ISSUES` raises
 *   `ad_issues`. A previous state of null counts as a change: an ad the app made has no state until its first sync.
 * - A row the sync meets for the first time never alerts. So the first import of an account full of old rejected ads is silent. The price:
 *   an ad made in Meta's Ads Manager and rejected before its first sync is not announced.
 * - Nothing is announced when an ad stays in the state it was announced for, or leaves it (a fixed ad is not news): the alert is about the
 *   moment Meta's verdict changed, not about what is true now. The rule template "Ad rejected → tell me" (Ads → Rules) is the other way to
 *   hear about an ad that is rejected right now, and sends its own kind (`rule_acted`).
 *
 * ## The flow
 * `mirror.ts` `upsertObjects` reports what it saw of each ad as it wrote it (`AdSighting`: the state before, from the same statement),
 * `adStatusAlertFor` decides (pure), `raiseAdStatusAlerts` hands each alert to the alert channel (`notify.ts` `notifyAds`: once a day per
 * kind and ad, the ad's Meta id being the object key, to the tenant's own Telegram and email and a copy to the platform admin). It runs
 * AFTER the sync's transactions have ended, never inside one: no network call is made while a database transaction is open.
 *
 * Alerting is best effort and NEVER throws: the new state is already stored, and a failed alert must not fail the sync that found it.
 * (The cost of that: a change whose alert failed is not announced again, because the stored row no longer differs from Meta's answer.
 * `ads.alert_failed` is logged at error level, and `ads_alerts` records each channel's outcome.)
 */
import { describeError, log } from '../../utils/log.js';
import { reviewReasons, type AdSighting } from './mirror.js';
import { notifyAds, type AdsAlert } from './notify.js';
import { readAdsSettings, readHealth } from './settings.js';

/** Meta's `effective_status` of an ad it has refused to run. */
export const REJECTED_STATUS = 'DISAPPROVED';
/** Meta's `effective_status` of an ad that runs, or tried to, with a problem it names. */
export const ISSUES_STATUS = 'WITH_ISSUES';

/** What `notifyAds` is given for these two kinds: the ad's Meta id and name, and Meta's own reasons. */
export type AdStatusAlert = Extract<AdsAlert, { kind: 'ad_rejected' | 'ad_issues' }>;

/** Meta's reasons joined as the alert shows them, or null when Meta gave none. At most six (`reviewReasons`). */
export function reasonText(review: AdSighting['review']): string | null {
    const reasons = reviewReasons(review);
    return reasons.length > 0 ? reasons.join('; ') : null;
}

/**
 * The alert one ad's sighting calls for, or null. Pure.
 *
 * Null for an ad the sync met for the first time, for a state that did not change (including null staying null), and for any state but the
 * two: moving out of DISAPPROVED or WITH_ISSUES, or into ACTIVE, PAUSED, IN_PROCESS and the rest, is not announced.
 */
export function adStatusAlertFor(s: AdSighting): AdStatusAlert | null {
    if (!s.existed) return null;
    if (s.previousStatus === s.effectiveStatus) return null;
    if (s.effectiveStatus !== REJECTED_STATUS && s.effectiveStatus !== ISSUES_STATUS) return null;
    return {
        kind: s.effectiveStatus === REJECTED_STATUS ? 'ad_rejected' : 'ad_issues',
        adId: s.metaId,
        adName: s.name,
        reason: reasonText(s.review),
    };
}

// ─── Delivery ───────────────────────────────────────────────────────────────────────────────

/** Where one alert goes. Tests swap in a recorder (`setAdStatusAlertSink`). `now` is the sync's clock, which names the day the alert belongs to. */
export type AdStatusAlertSink = (creatorId: string, alert: AdStatusAlert, now: Date) => Promise<void>;

/** The ads alert channel, addressed with what the tenant's stored settings and last health check say (the ad account and its UTC offset). */
const notifySink: AdStatusAlertSink = async (creatorId, alert, now) => {
    const [{ settings }, health] = await Promise.all([readAdsSettings(creatorId), readHealth(creatorId)]);
    await notifyAds(alert, {
        creatorId, adAccountId: settings.adAccountId ?? null, accountName: health.account?.name ?? null, offsetHours: health.account?.timezoneOffsetHours ?? 0,
    }, { now, objectKey: alert.adId });
};

let alertSink: AdStatusAlertSink = notifySink;

/** Tests swap in a recorder; null puts the ads alert channel back. */
export function setAdStatusAlertSink(sink: AdStatusAlertSink | null): void {
    alertSink = sink ?? notifySink;
}

/**
 * Raise the alerts these sightings call for, one at a time, in the order the sync saw the ads. An alert that cannot be handed over is logged
 * (`ads.alert_failed`) and the next one still goes. Returns how many were handed to the alert channel. Costs nothing when there is nothing
 * to say: no statement is run and no setting is read. NEVER throws, so the sync can call it from a `finally`.
 */
export async function raiseAdStatusAlerts(creatorId: string, sightings: readonly AdSighting[], now: Date = new Date()): Promise<number> {
    let raised = 0;
    for (const sighting of sightings) {
        try {
            const alert = adStatusAlertFor(sighting);
            if (!alert) continue;
            await alertSink(creatorId, alert, now);
            raised += 1;
            log('info', 'ads.ad_status_alert', { creator_id: creatorId, kind: alert.kind, ad_id: alert.adId, from: sighting.previousStatus, to: sighting.effectiveStatus });
        } catch (err) {
            log('error', 'ads.alert_failed', { creator_id: creatorId, ad_id: sighting.metaId, ...describeError(err) });
        }
    }
    return raised;
}
