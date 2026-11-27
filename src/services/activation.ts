/**
 * Activation events (U3, WA-9; docs/specs/007-company-shell §7.5): the two moments that say a workspace is really being used by the people
 * it was made for, written without any route having to remember to.
 *
 *   assistant_tested   the FIRST successful `POST /settings/ai/test` of the workspace (the owner tried the assistant before trusting it)
 *   staff_first_reply  the FIRST successful `POST /conversations/:id/messages` by each person (a member answered a customer from the Inbox)
 *
 * They go in `onboarding_events` (v34: no CHECK on `event`, PII-free by construction, `props` always `{}`), and feed the go-live card's
 * activation block (`goLive.ts`).
 *
 * **A tap, not a hook in the route.** `activationTap` is middleware mounted once; it watches the response and, when it was a 2xx for one of
 * those two requests, records the event AFTER the response has been sent (`res.on('finish')`). So it can never delay or fail the request
 * it observes, never throws (a failed insert is logged and nothing else), and a refused or failed request records nothing. A platform
 * admin acting as the workspace, and a shared-password session (no user), are not staff: they record nothing.
 *
 * **Once is one statement.** `INSERT … SELECT … WHERE NOT EXISTS`: two requests racing both pass the check, and the worst case is a second row
 * of an event that is only ever read as "has one" or counted by distinct person.
 */
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../config/db.js';
import { describeError, log } from '../utils/log.js';

export type ActivationEvent = 'assistant_tested' | 'staff_first_reply';

/** The requests that count, by what the router sees (`req.path` is relative to the mount: `/settings/ai/test`). */
const TAPS: ReadonlyArray<{ method: string; path: RegExp; event: ActivationEvent; perUser: boolean }> = [
    { method: 'POST', path: /^\/settings\/ai\/test\/?$/, event: 'assistant_tested', perUser: false },
    { method: 'POST', path: /^\/conversations\/[^/]+\/messages\/?$/, event: 'staff_first_reply', perUser: true },
];

/** Which event, if any, this request is. Pure. */
export function activationFor(method: string, path: string): { event: ActivationEvent; perUser: boolean } | null {
    const hit = TAPS.find((t) => t.method === method.toUpperCase() && t.path.test(path));
    return hit ? { event: hit.event, perUser: hit.perUser } : null;
}

/**
 * Record `event` for the workspace once (once per person when `perUser`). Never throws. `actor` is always the tenant: these are things the
 * workspace's people did.
 */
export async function recordOnce(creatorId: string, userId: string | null, event: ActivationEvent, perUser: boolean): Promise<void> {
    try {
        await pool.query(
            `INSERT INTO onboarding_events (creator_id, user_id, actor, event, step, props)
             SELECT $1::uuid, $2::uuid, 'tenant', $3::text, NULL, '{}'::jsonb
              WHERE NOT EXISTS (SELECT 1 FROM onboarding_events WHERE creator_id = $1::uuid AND event = $3::text
                                   AND ($4::boolean IS FALSE OR user_id IS NOT DISTINCT FROM $2::uuid))`,
            [creatorId, userId, event, perUser]
        );
    } catch (err) {
        log('warn', 'activation.record_failed', { activation_event: event, tenant_id: creatorId, ...describeError(err) });
    }
}

export function activationTap(req: Request, res: Response, next: NextFunction): void {
    try {
        const tap = activationFor(req.method, req.path);
        const session = req.session;
        if (tap && session?.tenantId && session.userId && session.role !== 'platform_admin') {
            const { tenantId, userId } = session;
            res.on('finish', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) void recordOnce(tenantId, userId, tap.event, tap.perUser);
            });
        }
    } catch (err) {
        log('warn', 'activation.tap_failed', describeError(err));
    }
    next();
}
