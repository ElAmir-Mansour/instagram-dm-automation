/**
 * The narrow Graph interface the A5 builder code (creatives, targeting search, duplicate) is written against, so it can be tested with a
 * stub. In the app it is `adsGraph()`: `ads/graph.ts` underneath, so every call is on the pinned version, paced against the ad account and
 * classified (a throttle is thrown at once, never retried). Paths are relative to the version root (`act_123/adimages`, `123/copies`).
 */
import type { GraphParams } from './graph.js';
import { adsDelete, adsGet, adsPost } from './graph.js';

export interface AdsGraph {
    /** A read (1 point). */
    get(path: string, params: Record<string, string>, label: string): Promise<any>;
    /** A write whose whole answer is needed (`adimages` answers `{ images }`, not `{ id }`): 3 points. */
    post(path: string, params: GraphParams, label: string): Promise<any>;
    /** A create that answers `{ id }`: resent only when the request never went out. */
    create(path: string, params: GraphParams, label: string): Promise<string>;
    /** `DELETE /{id}`. */
    del(path: string, label: string): Promise<void>;
}

/** The tenant, its ad account (digits, or `act_<digits>`) and its ads token. */
export interface AdsCallContext {
    tenantId: string;
    adAccountId: string;
    token: string;
}

/** `act_<digits>` whichever way the id was stored. */
export function actPath(adAccountId: string): string {
    return adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
}

/** The app's client behind the interface: paced and classified by `ads/graph.ts`. */
export function adsGraph(ctx: AdsCallContext): AdsGraph {
    const opts = (label: string, creates = false) => ({ label, creates, creatorId: ctx.tenantId, adAccountId: ctx.adAccountId.replace(/^act_/, '') });
    return {
        get: async (path, params, label) => (await adsGet(path, params, ctx.token, opts(label))).data,
        post: async (path, params, label) => (await adsPost(path, params, ctx.token, opts(label, true))).data,
        create: async (path, params, label) => {
            const res = await adsPost(path, params, ctx.token, opts(label, true));
            const id = res.data?.id;
            if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`${label}: Meta answered without an id.`);
            return String(id);
        },
        del: async (path, label) => { await adsDelete(path, ctx.token, opts(label)); },
    };
}
