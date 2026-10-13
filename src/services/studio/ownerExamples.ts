/**
 * The owner's built-in carousels, as a row of his own (docs/onboarding/05 §2 "P9 · Studio writer", §4 step 5).
 *
 * The owner's `studio_settings.examples` is NULL, so he has always been written for from the three built-in carousels
 * (`examples.ts`, shown as "Reference carousels by another creator"). P9 stops every other tenant from being shown them, and
 * leaves the owner the built-ins until they are in his row: this is the step that puts them there (`scripts/copy-owner-examples.mts`),
 * marked `reference: true` so the prompt still calls them another creator's, byte for byte as before. After that the built-in
 * fallback is dead code and P14 removes it.
 *
 * Pure: the script reads and writes, this decides what to write and whether a row is already done.
 */
import type { ExampleCarousel } from './carouselTypes.js';
import { builtInExamples, exampleJson } from './examples.js';

/** The three built-ins the owner is shown today (`examplesFor` shows at most three, in this order). */
export function ownerExamples(): ExampleCarousel[] {
    return builtInExamples('ar').slice(0, 3).map((c) => ({ ...structuredClone(c), reference: true }));
}

export type OwnerExamplesPlan =
    /** The row has none of its own: write the three. */
    | { action: 'copy' }
    /** The row already holds exactly these three, marked as references: nothing to write. */
    | { action: 'done' }
    /** The row holds examples that are not these three: this one-off never overwrites a creator's own. */
    | { action: 'refuse'; reason: string };

/** Whether `current` is, example for example, what `ownerExamples()` writes (the key order a database keeps is not a difference). */
function isTheCopy(current: readonly ExampleCarousel[]): boolean {
    const wanted = ownerExamples();
    return current.length === wanted.length && current.every((c, i) => c?.reference === true && exampleJson(c) === exampleJson(wanted[i]!));
}

/** What to do for a row whose `examples` is `current` (null, or an empty list, is a row with none). */
export function planOwnerExamples(current: readonly ExampleCarousel[] | null): OwnerExamplesPlan {
    if (current === null || current.length === 0) return { action: 'copy' };
    if (isTheCopy(current)) return { action: 'done' };
    return {
        action: 'refuse',
        reason: `the row already holds ${current.length} example${current.length === 1 ? '' : 's'} that ${current.length === 1 ? 'is' : 'are'} not the three built-in carousels; this script never overwrites examples`,
    };
}
