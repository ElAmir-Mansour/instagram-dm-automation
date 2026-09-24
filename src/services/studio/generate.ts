// STUB — replaced by the generation agent
//
// The signatures are STUDIO.md §7's, exactly; the server core (drafts.ts) is written against
// them and its tests mock this module. Every function throws until the real one lands.
import type { DraftCampaign, DraftInput, LessonRow, Moment, ShotSpec, StudioSettings } from '../../db/rows.js';
import type { Carousel, Slide } from './carouselTypes.js';

/** §7, plus v1.1's `settings`. `palette` is `settings.brand.palette`. */
export type GenContext = {
    recentTopics: string[];
    recentAccents: string[];
    activeKeywords: string[];
    palette: string[];
    settings: StudioSettings;
};

export type Proposal = DraftInput & { title: string; rationale: string };

type Sources = { lesson: LessonRow; moments: Moment[] }[];

export async function generateDraft(
    _input: DraftInput,
    _sources: Sources,
    _ctx: GenContext
): Promise<{ carousel: Carousel; shots: Record<string, ShotSpec>; campaign: DraftCampaign }> {
    throw new Error('generateDraft is not implemented');
}

export async function rewriteSlide(
    _carousel: Carousel,
    _index: number,
    _instruction: string | undefined,
    _sources: Sources,
    _ctx: GenContext
): Promise<Slide> {
    throw new Error('rewriteSlide is not implemented');
}

export async function planWeek(_count: number, _lessons: LessonRow[], _ctx: GenContext): Promise<Proposal[]> {
    throw new Error('planWeek is not implemented');
}
