/**
 * Duplicate (A5; contracts/meta-graph.md "Duplicate"): the `POST /{id}/copies` parameters. Pure; `actions.ts` `requestDuplicate` enqueues
 * the call as an `ads_ops` write like archive and delete. A copy is ALWAYS created PAUSED: duplicating never starts spending.
 */

/**
 * PAUSED, deep or shallow, with ` · copy AR·<key>` added to every name so the copy is findable and reads as a copy. An ad has no children:
 * the caller sends `deep: false` for one.
 */
export function copyParams(key: string, deep: boolean): Record<string, unknown> {
    return {
        deep_copy: deep,
        status_option: 'PAUSED',
        rename_options: { rename_strategy: deep ? 'DEEP_RENAME' : 'ONLY_TOP_LEVEL_RENAME', rename_suffix: ` · copy AR·${key}` },
    };
}
