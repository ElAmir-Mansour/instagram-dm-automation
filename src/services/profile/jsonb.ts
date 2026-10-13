/**
 * What a settings row and a stored profile go through, and the probe that finds what a view fails to replace.
 *
 *   throughJsonb   `value` as the database stores and returns it: serialised, its keys reordered the way jsonb does.
 *   scramble       `settings` with every owned path overwritten by junk: the row a profile edit has left behind.
 *
 * They began in `testSupport.ts`, for the lens-law and golden tests. The backfill's decisions depend on them now (it
 * holds the laws against a live tenant's rows, and against the form its profile would be stored in), so they live
 * here, in a module production code may import; `testSupport.ts` re-exports them and every test import still works.
 * Pure: no database, no settings module.
 */

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

export function getAt(root: unknown, path: string): unknown {
    let at: unknown = root;
    for (const key of path.split('.')) {
        if (!isObj(at) || !(key in at)) return undefined;
        at = at[key];
    }
    return at;
}

export function hasAt(root: unknown, path: string): boolean {
    let at: unknown = root;
    for (const key of path.split('.')) {
        if (!isObj(at) || !(key in at)) return false;
        at = at[key];
    }
    return true;
}

export function setAt(root: unknown, path: string, value: unknown): void {
    const keys = path.split('.');
    let at = root as Loose;
    for (const key of keys.slice(0, -1)) at = at[key] as Loose;
    at[keys.at(-1)!] = value;
}

/** Junk of the same kind as `value`, so the scrambled object is still the shape a reader expects. */
function junkFor(value: unknown, path: string): unknown {
    if (typeof value === 'number') return 7;
    if (Array.isArray(value)) return [`JUNK:${path}`];
    return `JUNK:${path}`;
}

/**
 * `settings` with each of `paths` that it holds overwritten by junk: the row a profile edit has left
 * behind. A path the object does not have is left out, not added: a stale row is the same row with
 * stale values, not a row of a different shape.
 */
export function scramble<T extends object>(settings: T, paths: readonly string[]): T {
    const out = structuredClone(settings);
    for (const path of paths) if (hasAt(out, path)) setAt(out, path, junkFor(getAt(out, path), path));
    return out;
}

/**
 * `value` as Postgres hands a jsonb column back: object keys sorted by length, then by their bytes (arrays
 * keep their order). A profile read from `creator_profiles` has been through this, so a reader that only
 * works on the key order it was written in is wrong in production and right in every test that skips it.
 */
export function jsonbReorder<T>(value: T): T {
    if (Array.isArray(value)) return value.map(jsonbReorder) as T;
    if (!isObj(value)) return value;
    const bytes = (k: string): Buffer => Buffer.from(k, 'utf8');
    const keys = Object.keys(value).sort((a, b) => bytes(a).length - bytes(b).length || Buffer.compare(bytes(a), bytes(b)));
    return Object.fromEntries(keys.map((k) => [k, jsonbReorder(value[k])])) as T;
}

/** `value` as the database stores and returns it: serialised, and its keys reordered the way jsonb does. */
export const throughJsonb = <T>(value: T): T => jsonbReorder(JSON.parse(JSON.stringify(value)) as T);
