// STUB — replaced by the generation agent
//
// The real module ports every check in aicourse-captions/scripts/check-carousels.mts
// (STUDIO.md §6), reading the CTA lines and digit rule from the tenant's settings (§10.3).
// This stub accepts everything so the server core compiles on its own.
import type { StudioSettings } from '../../db/rows.js';
import type { Carousel } from './carouselTypes.js';

/** One message per problem; an empty list when the carousel is valid. */
export function validateCarousel(_c: Carousel, _shotNames: ReadonlySet<string>, _settings?: StudioSettings): string[] {
    return [];
}
