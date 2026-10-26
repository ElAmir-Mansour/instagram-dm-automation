/**
 * The Graph API version the operator scripts call: the app's own, so a script never reads Meta through a different version
 * than production does. `META_API_VERSION` overrides it here exactly as it does in the app (`resolveApiVersion` in
 * src/services/instagram.ts), and a value that does not look like `v26.0` is ignored with a warning, as the app ignores it.
 *
 * Why it matters: Meta does not fail on an old version. Once one stops being usable, calls are "defaulted to the next oldest,
 * usable version" with no error, so a script pinned to an old version slowly starts answering with different semantics than the
 * app it is diagnosing. Until 2026-10-26 `diagnose.mjs` and `exchange-token.mjs` were pinned to v21.0, which expires around
 * 2027-01-21, while the app had moved to v26.0.
 *
 * The default is repeated here because these scripts run on plain Node and cannot import the app's TypeScript; `graph.test.mjs`
 * fails when the two disagree.
 */
export const DEFAULT_GRAPH_VERSION = 'v26.0';
const VERSION_PATTERN = /^v\d+\.\d+$/;

/** The version to call: `META_API_VERSION` when it looks like one, else the app's default. */
export function graphVersion(env = process.env, warn = (message) => console.error(message)) {
    const override = env.META_API_VERSION?.trim();
    if (!override) return DEFAULT_GRAPH_VERSION;
    if (!VERSION_PATTERN.test(override)) {
        warn(`META_API_VERSION "${override}" does not look like v26.0; using ${DEFAULT_GRAPH_VERSION}, as the app does.`);
        return DEFAULT_GRAPH_VERSION;
    }
    return override;
}

/** `https://graph.facebook.com/<version>`, with no trailing slash. */
export function graphBase(env = process.env, warn) {
    return `https://graph.facebook.com/${graphVersion(env, warn)}`;
}
