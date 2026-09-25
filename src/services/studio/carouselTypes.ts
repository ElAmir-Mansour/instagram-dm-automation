// Copied verbatim from aicourse-captions/src/carousel/types.ts (the design's schema, STUDIO.md §1).
// Keep the two in sync: the budgets below are the templates' hard limits. Two Studio
// differences:
//   - semantic: `ShotRef.name` keys the draft's `shots` map (`m-<momentId>`), not the static shot
//     library the comment below mentions;
//   - structural, and additive: `SlideMeta.altText` (GROWTH.md §4). The templates never render
//     it, so the renderer's copy of this file does not need it; a carousel carrying it renders
//     exactly as before.

/**
 * The contract between the carousel copy (`posts/*.ts`) and the slide templates.
 *
 * One `Carousel` renders twice:
 *   - `ig`: 1080×1350 (4:5), Instagram's tallest feed ratio, also used for Facebook.
 *   - `tt`: 1080×1920 (9:16) for TikTok photo mode, with its UI safe zones kept clear.
 *
 * Slides hold copy only. Layout, colour and type live in the templates, so a carousel is
 * edited here and re-rendered, never restyled per post.
 *
 * Text budgets (Arabic characters, spaces included) keep every slide inside its frame.
 * They're limits, not targets: shorter reads better on a phone.
 */

export type Format = "ig" | "tt";

/** A still from the course recordings, by name. See `public/shots/manifest.json`. */
export type ShotRef = {
  name: string;
  /** Overrides the manifest's default framing, 1 = the whole frame. */
  zoom?: number;
  /** The point of the source frame to centre on, 0..1. */
  focusX?: number;
  focusY?: number;
};

/**
 * What every slide may carry beside its copy. Not rendered: it travels with the slide to the
 * scheduled post, where Instagram takes it as the image's `alt_text`.
 */
export type SlideMeta = {
  /**
   * ≤ 200 (`ALT_TEXT_BUDGET`; Instagram itself takes up to 1000). What the slide shows and says,
   * for screen readers and Instagram search.
   */
  altText?: string;
};

export type Slide = SlideMeta & (
  /** Slide 1. Stops the scroll: one promise, one highlighted phrase. */
  | {
      kind: "cover";
      /** Small label above the title, e.g. the tool or lesson. ≤ 24. */
      kicker?: string;
      /** ≤ 34. The main hook. */
      title: string;
      /** Words inside `title` to paint in the accent colour. Must appear in `title` verbatim. */
      highlight?: string;
      /** ≤ 70. One line under the title. */
      subtitle?: string;
      shot?: ShotRef;
    }
  /** One idea, explained. The workhorse slide. */
  | {
      kind: "point";
      /** Shown as a big numeral badge when the carousel is a numbered list. */
      n?: number;
      /** ≤ 40. */
      title: string;
      /** ≤ 150. */
      body?: string;
      shot?: ShotRef;
      /** ≤ 70. A short pro tip in a callout. */
      tip?: string;
    }
  /** 3–5 short items under one heading. */
  | {
      kind: "list";
      /** ≤ 36. */
      title: string;
      /** 3–5 items. `text` ≤ 36, `sub` ≤ 60, `icon` = one emoji. */
      items: { icon?: string; text: string; sub?: string }[];
    }
  /** Old way against new way. `left` is the weak side, `right` the strong one. */
  | {
      kind: "compare";
      /** ≤ 36. */
      title?: string;
      /** `label` ≤ 16, 2–4 items of ≤ 30 each, same count on both sides. */
      left: { label: string; items: string[] };
      right: { label: string; items: string[] };
    }
  /** A how-to sequence. */
  | {
      kind: "steps";
      /** ≤ 36. */
      title: string;
      /** 3–4 steps. `title` ≤ 28, `body` ≤ 70. */
      steps: { title: string; body?: string }[];
    }
  /** A copy-paste prompt. The slide people save. */
  | {
      kind: "prompt";
      /** ≤ 36. */
      title: string;
      /** ≤ 20, e.g. "انسخ البرومبت". */
      label?: string;
      /** ≤ 320. Arabic, English or mixed. Keep [placeholders] in square brackets. */
      prompt: string;
      /** ≤ 70. */
      note?: string;
    }
  /** One big number or short phrase. */
  | {
      kind: "stat";
      /** ≤ 8, e.g. "٢٠ دقيقة" is too long, "٢٠" with label "دقيقة بدل أسبوع" is right. */
      value: string;
      /** ≤ 40. */
      label: string;
      /** ≤ 120. */
      body?: string;
    }
  /** Proof: a real screen from the course, big. */
  | {
      kind: "shot";
      /** ≤ 40. */
      title: string;
      shot: ShotRef;
      /** ≤ 90. */
      caption?: string;
    }
  /**
   * Last slide. Rendered per platform:
   *   ig: "اكتب «keyword» في التعليقات" pill, because a comment triggers the DM automation.
   *   tt: TikTok can't auto-DM, so the Udemy search line and course URL instead.
   */
  | {
      kind: "cta";
      /** ≤ 40. The payoff line above the ask, e.g. "شرحته خطوة بخطوة في الكورس". */
      promise?: string;
    }
);

export type Carousel = {
  /** PascalCase, unique. Used in composition ids and output paths. */
  id: string;
  /** One hex colour, `#RRGGBB`. */
  accent: string;
  /** Instagram comment keyword that fires the DM. One word. */
  keyword: string;
  /** 6–10 slides. First is `cover`, last is `cta`. Instagram's limit is 10. */
  slides: Slide[];
  captions: {
    /** Full Instagram/Facebook caption, hashtags included. Uses `keyword`. */
    instagram: string;
    /** TikTok photo-post title. ≤ 90 UTF-16 units (an emoji counts 2). */
    tiktokTitle: string;
    /** TikTok description. No keyword ask: TikTok can't auto-reply. */
    tiktok: string;
  };
};
