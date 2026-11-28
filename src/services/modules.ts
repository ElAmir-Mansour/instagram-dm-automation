/**
 * Modules per workspace (U3, docs/specs/007-company-shell, contract §1): which parts of the product a workspace has.
 *
 * A workspace is a company's inbox, or a creator's whole studio, or something in between. What it has is one JSON document in
 * `app_settings`, `tenant.modules.<tenant>` = `{ v: 1, on: [...], preset, metaConnect }`, written by the platform admin only. Two modules
 * are not in the document: `ads` and `explainers` are VIEWS of the switches they always had (`ads.enabled.<t>`, `explainers.enabled.<t>`), so
 * nothing that reads those switches today can disagree with this.
 *
 * The rules, in the order they bite:
 *   1. **No document reads as everything on** (a workspace that predates modules). So does a document that cannot be read, which is logged
 *      (`modules.doc_unreadable`): nobody loses a screen because of a bad row.
 *   2. **The platform owner's workspace has every available module on and cannot be narrowed** (`OWNER_ALL_MODULES`). Whatever a document says,
 *      its reading is all on; `ads` and `explainers` keep following their own switches, as they always did.
 *   3. **A module whose requirement is off is off** (`requires`, resolved to a fixed point), so a half-switched pair never shows a screen that
 *      cannot work.
 *   4. **Off means hidden AND refused, never deleted.** `requireModule` answers 404 `MODULE_OFF` for the routes of an off module; the data stays,
 *      and switching it on again brings everything back. Background work (the drain, the publisher, the sweeps, the webhooks) is NOT gated: turning
 *      a module off is an admin act on a workspace that never used it. The one exception is Muse, through `readMuseSettings`.
 *
 * Reads are cached per instance for `MODULES_CACHE_MS` (three statements per workspace per window), and `saveModules` drops the entry, so another
 * warm instance may still answer the old way for up to 30 seconds after a change (contract §14.1 R1).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describeError, log } from '../utils/log.js';
import {
    getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES, type SettingExec,
} from './appSettings.js';
import { parseCeiling, type AdsCeiling } from './ads/settings.js';
import { sendError, type ErrorCode, type ErrorParams } from './errorCodes.js';
import { withTransaction, type Exec } from './studio/common.js';
import { getPlatformOwnerId, getTenantId } from './tenant.js';

// ─── The model ───────────────────────────────────────────────────────────────────────────────

export const MODULE_IDS = [
    'inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results', 'growth', 'studio', 'explainers', 'ads',
    'tiktok', 'youtube', 'whatsapp', 'muse', 'knowledge',
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export type ModulePreset = 'company' | 'creator' | 'custom';
export type MetaConnectMode = 'self' | 'operator';

export interface ModuleDef {
    id: ModuleId;
    /** Where its state lives: the document, or the switch it is a view of. */
    store: 'doc' | 'ads.enabled' | 'explainers.enabled';
    requires: readonly ModuleId[];
    /** False: cannot be switched on yet (the knowledge base, phase C). */
    available: boolean;
    /** Only the platform owner's workspace can have it (Explainers run on the owner's Mac and his image allowance). */
    ownerOnly?: true;
}

/** §1.1, in `MODULE_IDS` order. */
export const MODULES: readonly ModuleDef[] = Object.freeze([
    { id: 'inbox', store: 'doc', requires: [], available: true },
    { id: 'keyword_replies', store: 'doc', requires: [], available: true },
    { id: 'dm_assistant', store: 'doc', requires: ['inbox'], available: true },
    { id: 'scheduler', store: 'doc', requires: [], available: true },
    { id: 'results', store: 'doc', requires: [], available: true },
    { id: 'growth', store: 'doc', requires: [], available: true },
    { id: 'studio', store: 'doc', requires: [], available: true },
    { id: 'explainers', store: 'explainers.enabled', requires: ['studio'], available: true, ownerOnly: true },
    { id: 'ads', store: 'ads.enabled', requires: [], available: true },
    { id: 'tiktok', store: 'doc', requires: ['scheduler'], available: true },
    { id: 'youtube', store: 'doc', requires: ['scheduler'], available: true },
    { id: 'whatsapp', store: 'doc', requires: ['inbox'], available: true },
    { id: 'muse', store: 'doc', requires: ['dm_assistant'], available: true },
    { id: 'knowledge', store: 'doc', requires: [], available: false },
] satisfies ModuleDef[]);

const DEF = new Map<ModuleId, ModuleDef>(MODULES.map((m) => [m.id, m]));

/** The modules a workspace holds in its document: everything that is available and not a view. */
const DOC_MODULES: readonly ModuleId[] = MODULES.filter((m) => m.store === 'doc' && m.available).map((m) => m.id);

const COMPANY: readonly ModuleId[] = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];
/** §1.1's two preset columns. `ads` and `explainers` are in neither: Ads is opt-in with a ceiling, Explainers is the owner's alone. */
export const MODULE_PRESETS: Readonly<Record<'company' | 'creator', readonly ModuleId[]>> = Object.freeze({
    company: COMPANY,
    creator: [...COMPANY, 'growth', 'studio', 'tiktok', 'youtube', 'whatsapp', 'muse'] as ModuleId[],
});

export interface ModulesDoc {
    v: 1;
    on: ModuleId[];
    preset: ModulePreset;
    metaConnect: MetaConnectMode;
}

export interface ModulesView {
    /** Every module that is on for the workspace, `ads` and `explainers` included, in `MODULE_IDS` order. */
    on: ModuleId[];
    /** The platform owner's own workspace: everything on, read-only. */
    owner: boolean;
    /** A document is stored. False: legacy (everything on). */
    stored: boolean;
    preset: ModulePreset | null;
    metaConnect: MetaConnectMode;
}

export interface ModulesInput {
    preset?: ModulePreset;
    on?: ModuleId[];
    metaConnect?: MetaConnectMode;
    adsCeiling?: { maxDailyBudget: number; monthlyCap: number } | null;
}

export const MODULES_CACHE_MS = 30_000;

const isModuleId = (value: unknown): value is ModuleId => typeof value === 'string' && DEF.has(value as ModuleId);
const isPreset = (value: unknown): value is ModulePreset => value === 'company' || value === 'creator' || value === 'custom';
const isConnectMode = (value: unknown): value is MetaConnectMode => value === 'self' || value === 'operator';
const inOrder = (ids: Iterable<ModuleId>): ModuleId[] => { const set = new Set(ids); return MODULE_IDS.filter((id) => set.has(id)); };

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────

/** `tenant.modules.<t>` as stored. Null: nothing stored. 'unreadable': stored, but not a document this build understands (logged by the caller). Pure. */
export function parseModulesDoc(raw: string | null): ModulesDoc | null | 'unreadable' {
    if (raw === null || raw === '') return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return 'unreadable'; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const o = parsed as Record<string, unknown>;
    if (o['v'] !== 1 || !Array.isArray(o['on'])) return 'unreadable';
    const known: ModuleId[] = [];
    for (const entry of o['on']) {
        if (typeof entry !== 'string') continue;
        if (!isModuleId(entry)) { log('warn', 'modules.doc_unknown_id', { module: entry.slice(0, 40) }); continue; }
        // `ads` and `explainers` are views of their own switches and `knowledge` cannot be on: a document never grants them.
        if (DOC_MODULES.includes(entry)) known.push(entry);
    }
    return {
        v: 1,
        on: inOrder(known),
        preset: isPreset(o['preset']) ? o['preset'] : 'custom',
        metaConnect: isConnectMode(o['metaConnect']) ? o['metaConnect'] : 'operator',
    };
}

/** Drop every module whose requirement is off, until nothing changes. Pure. */
export function resolveRequires(on: Iterable<ModuleId>): ModuleId[] {
    const set = new Set(on);
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of [...set]) {
            if (DEF.get(id)!.requires.some((needed) => !set.has(needed))) { set.delete(id); changed = true; }
        }
    }
    return inOrder(set);
}

/** The view from what was read. Pure: `doc` null is legacy, `ads` and `explainers` are the two switches. */
export function viewFrom(doc: ModulesDoc | null, switches: { ads: boolean; explainers: boolean }, owner: boolean): ModulesView {
    const on = new Set<ModuleId>(doc ? doc.on : DOC_MODULES);
    if (owner) for (const id of DOC_MODULES) on.add(id);
    if (switches.ads) on.add('ads');
    if (switches.explainers) on.add('explainers');
    return {
        on: resolveRequires(on),
        owner,
        stored: doc !== null,
        preset: doc?.preset ?? null,
        // The owner connects through the operator's own token: his card never offers Reconnect, whatever a stray document says.
        metaConnect: owner ? 'operator' : doc?.metaConnect ?? 'operator',
    };
}

const keys = (creatorId: string) => ({
    doc: tenantSettingKey(TENANT_SETTING_PREFIXES.tenantModules, creatorId),
    ads: tenantSettingKey(TENANT_SETTING_PREFIXES.adsEnabled, creatorId),
    // Lower-cased like `explainers/switch.ts`, the one writer of this key.
    explainers: tenantSettingKey(TENANT_SETTING_PREFIXES.explainersEnabled, creatorId.toLowerCase()),
});

const cache = new Map<string, { at: number; view: ModulesView }>();
/** The document alone, per workspace (what the gate and the Muse read need: one statement, not three). */
const docCache = new Map<string, { at: number; doc: ModulesDoc | null }>();

/** Forget one workspace's cached answer, or all of them. */
export function invalidateModulesCache(creatorId?: string): void {
    if (creatorId === undefined) { cache.clear(); docCache.clear(); }
    else { cache.delete(creatorId); docCache.delete(creatorId); }
}

const isOwner = async (creatorId: string): Promise<boolean> => {
    const ownerId = await getPlatformOwnerId();
    return ownerId !== null && ownerId.toLowerCase() === creatorId.toLowerCase();
};

/** The stored document, or null for none (legacy) or one that cannot be read (logged). One statement, cached for `MODULES_CACHE_MS`. */
async function readDoc(creatorId: string): Promise<ModulesDoc | null> {
    const hit = docCache.get(creatorId);
    if (hit && Date.now() - hit.at < MODULES_CACHE_MS) return hit.doc;
    let doc = parseModulesDoc(await getSetting(keys(creatorId).doc));
    if (doc === 'unreadable') {
        log('warn', 'modules.doc_unreadable', { creator_id: creatorId });
        doc = null;
    }
    docCache.set(creatorId, { at: Date.now(), doc });
    return doc;
}

/**
 * What the workspace has. Three indexed reads (the document and the two switches, in parallel) plus the (cached) platform owner. A database that
 * cannot be read throws, as every other read does: it is the document being unreadable that is "everything on".
 */
export async function readModules(creatorId: string): Promise<ModulesView> {
    const hit = cache.get(creatorId);
    if (hit && Date.now() - hit.at < MODULES_CACHE_MS) return hit.view;
    const k = keys(creatorId);
    const [doc, ads, explainers, owner] = await Promise.all([readDoc(creatorId), getSetting(k.ads), getSetting(k.explainers), isOwner(creatorId)]);
    const view = viewFrom(doc, { ads: ads === 'true', explainers: explainers === 'true' }, owner);
    cache.set(creatorId, { at: Date.now(), view });
    return view;
}

/**
 * The modules a workspace has that live in its DOCUMENT (everything but `ads` and `explainers`, which are views of their own switches): what the gate,
 * the attention summary, the profile's next actions and Muse ask. Cheaper than `readModules`: ONE statement for a workspace with no document, which is every
 * workspace that predates modules, and the owner is asked only when there is a document for his rule (everything on, whatever it says) to overrule.
 */
export async function readDocModules(creatorId: string): Promise<ModuleId[]> {
    const full = cache.get(creatorId);
    if (full && Date.now() - full.at < MODULES_CACHE_MS) return full.view.on.filter((id) => DEF.get(id)!.store === 'doc');
    const doc = await readDoc(creatorId);
    if (!doc) return resolveRequires(DOC_MODULES);
    return resolveRequires((await isOwner(creatorId)) ? DOC_MODULES : doc.on);
}

export async function isModuleOn(creatorId: string, id: ModuleId): Promise<boolean> {
    // `ads` and `explainers` are their switches, which the document does not hold.
    if (DEF.get(id)!.store !== 'doc') return (await readModules(creatorId)).on.includes(id);
    return (await readDocModules(creatorId)).includes(id);
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────

export class ModulesError extends Error {
    constructor(readonly status: 400 | 409, readonly code: ErrorCode, readonly params: ErrorParams, message: string) {
        super(message);
        this.name = 'ModulesError';
    }
}

type Plan =
    | { ok: true; doc: ModulesDoc; ads: boolean; ceiling: AdsCeiling | null }
    | { ok: false; status: 400 | 409; code: ErrorCode; params: Record<string, string> };

const refuse = (status: 400 | 409, code: ErrorCode, params: Record<string, string> = {}): Plan => ({ ok: false, status, code, params });

/**
 * Validate an input and expand it into the document to store (pure). A preset fills `on`; requirements are CHECKED, never added, so the admin sees
 * what a choice needs instead of getting more than they asked for. With neither a preset nor `on`, the company preset, and `metaConnect` defaults to
 * `self` (a new workspace connects its own Meta). `ctx.hasCeiling`: the workspace already has an ads ceiling stored.
 */
export function planModules(input: unknown, ctx: { owner: boolean; hasCeiling: boolean }): Plan {
    if (ctx.owner) return refuse(409, 'OWNER_ALL_MODULES');
    const body = input === undefined || input === null ? {} : input;
    if (typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'MODULE_UNKNOWN', { module: 'modules' });
    const o = body as Record<string, unknown>;

    let preset: ModulePreset;
    if (o['preset'] === undefined || o['preset'] === null) preset = o['on'] === undefined ? 'company' : 'custom';
    else if (isPreset(o['preset'])) preset = o['preset'];
    else return refuse(400, 'MODULE_UNKNOWN', { module: String(o['preset']).slice(0, 40) });

    let wanted: ModuleId[];
    if (o['on'] === undefined || o['on'] === null) {
        wanted = preset === 'custom' ? [] : [...MODULE_PRESETS[preset]];
    } else if (Array.isArray(o['on'])) {
        wanted = [];
        for (const entry of o['on']) {
            if (!isModuleId(entry)) return refuse(400, 'MODULE_UNKNOWN', { module: String(entry).slice(0, 40) });
            if (!DEF.get(entry)!.available) return refuse(400, 'MODULE_NOT_AVAILABLE', { module: entry });
            wanted.push(entry);
        }
    } else return refuse(400, 'MODULE_UNKNOWN', { module: 'on' });

    const set = new Set(wanted);
    for (const id of MODULE_IDS) {
        if (!set.has(id)) continue;
        const needs = DEF.get(id)!.requires.find((r) => !set.has(r));
        if (needs) return refuse(400, 'MODULE_NEEDS', { module: id, needs });
    }
    // The owner's workspace was refused above, so a non-owner's workspace never gets Explainers.
    if (set.has('explainers')) return refuse(409, 'EXPLAINERS_OWNER_ONLY', { module: 'explainers' });

    let ceiling: AdsCeiling | null = null;
    if (o['adsCeiling'] !== undefined && o['adsCeiling'] !== null) {
        ceiling = parseCeiling(o['adsCeiling']);
        if (!ceiling) return refuse(409, 'CEILING_REQUIRED', { module: 'ads' });
    }
    if (set.has('ads') && !ceiling && !ctx.hasCeiling) return refuse(409, 'CEILING_REQUIRED', { module: 'ads' });

    const rawConnect = o['metaConnect'];
    if (rawConnect !== undefined && rawConnect !== null && !isConnectMode(rawConnect)) return refuse(400, 'MODULE_UNKNOWN', { module: 'metaConnect' });
    const metaConnect: MetaConnectMode = isConnectMode(rawConnect) ? rawConnect : 'self';

    return {
        ok: true,
        doc: { v: 1, on: inOrder(wanted.filter((id) => DOC_MODULES.includes(id))), preset, metaConnect },
        ads: set.has('ads'),
        ceiling,
    };
}

/**
 * What a create body's `modules` means for a NEW workspace (contract §3.1, §1.4): absent, or naming neither a preset nor a list, is the company preset, and the
 * workspace connects its own Meta (`metaConnect: 'self'`) unless it says otherwise. Anything that is not an object is passed on as it is, for `planModules`
 * to refuse. Pure.
 */
export function modulesForNewWorkspace(raw: unknown): unknown {
    if (raw === undefined || raw === null) return { preset: 'company', metaConnect: 'self' };
    if (typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const input = { ...(raw as Record<string, unknown>) };
    if (input['preset'] === undefined && input['on'] === undefined) input['preset'] = 'company';
    if (input['metaConnect'] === undefined) input['metaConnect'] = 'self';
    return input;
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
    OWNER_ALL_MODULES: 'This is the platform owner\'s own workspace: it has every module and cannot be narrowed.',
    MODULE_UNKNOWN: 'That is not a module.',
    MODULE_NOT_AVAILABLE: 'That module cannot be switched on yet.',
    MODULE_NEEDS: 'That module needs another module that is not switched on.',
    EXPLAINERS_OWNER_ONLY: 'Explainers are only for the platform owner in this version, so no other workspace can be switched on.',
    CEILING_REQUIRED: 'Set this workspace\'s ads ceiling (max daily budget and monthly cap) before switching ads on.',
};

/** The English sentence a refusal carries (`error` / `message`; the dashboard shows its own translation of `code`). */
export const modulesRefusalMessage = (code: ErrorCode): string => MESSAGES[code] ?? 'That change is not allowed.';

/** Send what `planModules` or `saveModules` refused with. */
export function sendModulesRefusal(res: Response, err: ModulesError): void {
    sendError(res, err.status, err.code, err.params, err.message);
}

/** What `planModules` refused, as an error. */
export function refusalError(plan: Extract<Plan, { ok: false }>): ModulesError {
    return new ModulesError(plan.status, plan.code, plan.params, modulesRefusalMessage(plan.code));
}

/**
 * Store a workspace's modules, in ONE transaction (or the caller's, when `exec` is given): the document, then for `ads` the ceiling (when one is
 * given) and the `ads.enabled` switch. Omitted fields keep what the workspace has now; an input with neither a preset nor `on` changes only what
 * it names. Never writes `explainers` (the owner-only switch on Settings → Platform) and never touches the owner's workspace.
 *
 * Returns the view the write produced (computed, not re-read, so it is right even inside a caller's open transaction).
 */
export async function saveModules(
    creatorId: string, input: unknown, actor: { userId: string | null }, exec?: Exec
): Promise<ModulesView> {
    const k = keys(creatorId);
    const [raw, ads, explainers, owner] = await Promise.all([getSetting(k.doc), getSetting(k.ads), getSetting(k.explainers), isOwner(creatorId)]);
    const parsed = parseModulesDoc(raw);
    const stored = parsed === 'unreadable' ? null : parsed;
    const switches = { ads: ads === 'true', explainers: explainers === 'true' };
    const current = viewFrom(stored, switches, owner);
    const storedCeiling = await readStoredCeiling(creatorId);

    let merged: unknown = input;
    if (!owner && input && typeof input === 'object' && !Array.isArray(input)) {
        const o = input as Record<string, unknown>;
        const named = o['preset'] !== undefined && o['preset'] !== null || o['on'] !== undefined && o['on'] !== null;
        merged = named ? o : { ...o, preset: current.preset ?? 'custom', on: current.on.filter((id) => id !== 'explainers') };
        if (o['metaConnect'] === undefined || o['metaConnect'] === null) (merged as Record<string, unknown>)['metaConnect'] = current.metaConnect;
    }
    const plan = planModules(merged, { owner, hasCeiling: storedCeiling !== null });
    if (!plan.ok) throw refusalError(plan);

    const write = async (tx: SettingExec): Promise<void> => {
        await setSetting(k.doc, JSON.stringify(plan.doc), actor.userId, tx);
        if (plan.ads) {
            if (plan.ceiling) await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsCeiling, creatorId), JSON.stringify(plan.ceiling), actor.userId, tx);
            await setSetting(k.ads, 'true', actor.userId, tx);
        } else {
            await setSetting(k.ads, null, actor.userId, tx);
        }
    };
    if (exec) await write(exec); else await withTransaction(write);
    invalidateModulesCache(creatorId);
    return viewFrom(plan.doc, { ads: plan.ads, explainers: switches.explainers }, false);
}

/** The workspace's stored ads ceiling, or null: one read of `ads.ceiling.<t>`, parsed by the Ads settings' own `parseCeiling`. */
export async function readStoredCeiling(creatorId: string): Promise<AdsCeiling | null> {
    const key = tenantSettingKey(TENANT_SETTING_PREFIXES.adsCeiling, creatorId);
    const raw = await getSetting(key);
    if (!raw) return null;
    try { return parseCeiling(JSON.parse(raw)); } catch { return null; }
}

// ─── The gate ────────────────────────────────────────────────────────────────────────────────

/** A mounted gate: an Express handler that says which module it guards, so a test can read the mount off the router's stack. */
export type ModuleGuard = RequestHandler & { readonly moduleId: ModuleId };

export interface RequireModuleOptions {
    /** GET paths (relative to the mount) that stay open when the module is off. */
    exceptGet?: readonly string[];
    /** Path prefixes (relative to the mount), any method, that stay open: a sub-router with a gate of its own. */
    exceptPrefix?: readonly string[];
}

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * 404 `MODULE_OFF { module }` unless the session's workspace has the module. Mounted with `router.use(prefix, guard)` right after `resolveTenant`
 * (`MODULE_API_PREFIXES`), so the workspace is `getTenantId(req)` and nothing in the request can choose another.
 */
export function requireModule(id: ModuleId, opts: RequireModuleOptions = {}): ModuleGuard {
    const guard = async function moduleGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const path = trimSlash(req.path || '/');
            if ((req.method === 'GET' || req.method === 'HEAD') && opts.exceptGet?.includes(path)) { next(); return; }
            if (opts.exceptPrefix?.some((p) => path === p || path.startsWith(`${p}/`))) { next(); return; }
            if (await isModuleOn(getTenantId(req), id)) { next(); return; }
            sendError(res, 404, 'MODULE_OFF', { module: id }, 'This is not part of this workspace.');
        } catch (err) {
            log('error', 'modules.guard_failed', { module: id, ...describeError(err) });
            next(err);
        }
    };
    return Object.assign(guard, { moduleId: id });
}

/**
 * Every module's API prefixes, in mount order (§1.5). Not gated, by design: `/stats*`, `/interactions*`, `/upload`, `/uploads/:id`, `/profile`, `/meta`,
 * `/onboarding`, `/attention`, `/health/tenant`, the other `/settings/*`, and `/r/*`. `/ads` and `/studio/explainers*` keep their own gates
 * (404 `ADS_DISABLED` / `EXPLAINERS_DISABLED`, reading the same switches); the Studio's gate lets the second through so its own answer is the one sent.
 */
export const MODULE_API_PREFIXES: ReadonlyArray<{ module: ModuleId; prefix: string; exceptGet?: readonly string[]; exceptPrefix?: readonly string[] }> = Object.freeze([
    { module: 'keyword_replies', prefix: '/campaigns' },
    // `/posts/live` is a different prefix and stays open: the Keyword replies post picker reads it.
    { module: 'scheduler', prefix: '/posts/scheduled' },
    { module: 'inbox', prefix: '/conversations' },
    { module: 'dm_assistant', prefix: '/settings/ai' },
    { module: 'dm_assistant', prefix: '/settings/sales-followup' },
    { module: 'dm_assistant', prefix: '/settings/sales-variants' },
    { module: 'dm_assistant', prefix: '/dm/ice-breakers' },
    { module: 'dm_assistant', prefix: '/dm/funnel' },
    { module: 'muse', prefix: '/settings/ai/muse' },
    // `/app-settings` is the PLATFORM's TikTok / YouTube app (platform admin only, the same for every workspace): a platform admin acting as a
    // workspace without the module must still read and save it (Settings → Platform), so it is never the workspace's module to refuse.
    { module: 'tiktok', prefix: '/tiktok', exceptPrefix: ['/app-settings'] },
    { module: 'youtube', prefix: '/youtube', exceptPrefix: ['/app-settings'] },
    { module: 'whatsapp', prefix: '/whatsapp' },
    // The Scheduler reads the workspace's time zone from `GET /studio/settings` (`PostsPage.shareZone`).
    { module: 'studio', prefix: '/studio', exceptGet: ['/settings'], exceptPrefix: ['/explainers'] },
    { module: 'growth', prefix: '/growth' },
]);

/**
 * A post for TikTok or YouTube is refused when that module is off, even though the Scheduler is on: `POST /posts/scheduled` and
 * `PUT /posts/scheduled/:id` carry `platform` (and `also_tiktok`) in the body, which a path prefix cannot see. Mounted at `/posts/scheduled`.
 */
export const refuseOffPlatforms: RequestHandler = async (req, res, next) => {
    try {
        const path = trimSlash(req.path || '/');
        const writes = (req.method === 'POST' && path === '/') || (req.method === 'PUT' && /^\/[^/]+$/.test(path));
        if (!writes) { next(); return; }
        const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
        const needs: ModuleId[] = [];
        if (body['platform'] === 'tiktok' || body['also_tiktok'] === true) needs.push('tiktok');
        if (body['platform'] === 'youtube') needs.push('youtube');
        if (needs.length === 0) { next(); return; }
        const on = await readDocModules(getTenantId(req));
        const off = needs.find((id) => !on.includes(id));
        if (off) { sendError(res, 404, 'MODULE_OFF', { module: off }, 'This is not part of this workspace.'); return; }
        next();
    } catch (err) {
        log('error', 'modules.guard_failed', { module: 'platform', ...describeError(err) });
        next(err);
    }
};
