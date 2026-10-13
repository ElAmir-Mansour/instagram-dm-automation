# DESIGN.md: AutoReply Pro · أوتوريبلاي برو

Read this before changing any pixel, or any sentence a user sees.
- **Source of truth.** Every colour in §2 is a copy of `dashboard/css/tokens.css`. If the two disagree,
  tokens.css wins and `src/dashboard/design-md.test.ts` fails.
- **Languages.** Arabic leads; English is a peer.
- **Previews.** Open `preview.html` (light) and `preview-dark.html` (dark) from the repo root. They load
  `dashboard/css/tokens.css` by relative path and read every swatch live, so they cannot drift.
- **What is shipped and what is next.** Sections say so where it matters: the logo is **frozen** (§4, Mark) and the
  display face is **planned** (§3). Everything else here describes what the code does today.

## 1. Visual Theme & Atmosphere

- **What it is.** A managed growth studio for Arabic creators, course sellers and small shops:
  - comment→DM campaigns
  - Carousel Studio
  - the Monteur (reels cut from long videos)
  - animated Infographics
  - Growth
  - publishing to Instagram, Facebook, TikTok (drafts) and YouTube Shorts
- **Material.** Other people's content: Arabic comments, reels, slides. The chrome recedes. The content and
  *one highlighted word* lead.
- **Name of the look:** حبر وهيل · Ink & Cardamom.
  - Neutrals are olive-tinted ink.
  - A single cardamom accent is used the way a highlighter is used: on the word that triggers, on the action that
    matters, on what is selected.
  - The story behind it: every comment is a guest, and a guest is answered.
- **Themes.** Dark is the default and the identity: an editing suite, where reels are reviewed. Light is a full
  peer: paper, ink actions, a cardamom highlighter.
- **Mood words:** calm, precise, Arabic-native, crafted, honest.
- **Never:** neon, gamer, glossy SaaS, Apple, Meta.
- **History.** This replaced an Apple-HIG blue palette (2026-09-21), which replaced a terracotta direction, which
  replaced a Tailwind-indigo default. The structure survived all three: surface roles, the fill/label split,
  logical properties, RTL by default.

## 2. Color Palette & Roles

How to read the tables:
- One token per row. `=` in the light column means "the same as dark".
- Hex is shown in capitals for reading; the test compares case-insensitively.
- A translucent value is only a colour once composited over the canvas, so the guard measures it that way.

### Neutrals
| token | dark | light | role |
|---|---|---|---|
| `--surface-page` | `#111210` | `#F4F4EE` | canvas; the contrast worst case |
| `--surface-ambient` | radial `#111210 → #0F100E 48% → #0B0C0A` | radial `#FFFFFF → #FAFAF6 48% → #F4F4EE` | `body::before` only; the stop that touches text equals the page |
| `--surface-sunken` | `#0B0C0A` | `#EAEAE2` | inputs, wells, inbound bubble |
| `--surface-solid` | `#1E1F1B` | `#FFFFFF` | opaque: grid cards, media frames, `<option>` |
| `--surface-raised` | `rgba(36,38,32,0.66)` | `rgba(255,255,255,0.74)` | glass card (composites to solid) |
| `--surface-overlay` | `rgba(44,46,39,0.84)` | `rgba(255,255,255,0.9)` | modal |
| `--surface-chrome` | `rgba(30,31,27,0.86)` | `rgba(255,255,255,0.86)` | sidebar + top bar, one recipe |
| `--surface-glass` | `rgba(255,255,255,0.08)` | `rgba(24,26,16,0.05)` | tint: chips, pills, switch tracks |
| `--surface-glass-hover` | `rgba(255,255,255,0.11)` | `rgba(24,26,16,0.075)` | tint on hover |
| `--surface-scrim` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.28)` | modal backdrop, never text |
| `--border-subtle` | `rgba(255,255,255,0.12)` | `rgba(24,26,16,0.08)` | hairlines |
| `--border-strong` | `rgba(255,255,255,0.2)` | `rgba(24,26,16,0.14)` | hairlines that must read |
| `--text-strong` | `#F2F3EC` | `#181913` | headings, values |
| `--text-default` | `#D2D4CA` | `#393B32` | body |
| `--text-muted` | `#A8AB9E` | `#5E6155` | hints, timestamps, table heads (≥ 5.05:1 dark / 4.76:1 light, glass tint included) |

### Brand: fill and label are different tokens
Three tokens, three jobs: the **fill** (`--accent`), the **label on the fill** (`--text-on-accent`), and the **label
on the highlighter** (`--accent-text` over `--accent-soft`). Never swap them. In dark the fill is bright, so the
label on it is ink. In light the fill is ink, so the label on it is white, and cardamom appears only as the
highlighter, with a deep olive as its label.

| token | dark | light | role |
|---|---|---|---|
| `--accent` | `#BCDE70` | `#1A1C15` | primary FILL, focus outline, active marker |
| `--accent-hover` | `#C9E683` | `#2A2D23` | primary hover |
| `--accent-active` | `#A8CA5C` | `#0E0F0B` | primary press |
| `--text-on-accent` | `#141610` | `#FFFFFF` | label on the fill (12.0:1 dark, 17.2:1 light) |
| `--accent-text` | `#C9E683` | `#3E5208` | links, active labels, eyebrow, `.kw` label (7.9:1 on the light page) |
| `--accent-soft` | `rgba(188,222,112,0.16)` | `rgba(170,204,72,0.3)` | the highlighter: keyword, selected, nav indicator |
| `--accent-ring` | `rgba(188,222,112,0.4)` | `rgba(130,165,40,0.45)` | focus halo, ambient glow |
| `--gradient-brand` | `linear-gradient(180deg, #C9E683, #BCDE70 60%, #AFD263)` | `linear-gradient(180deg, #2A2D23, #1A1C15 60%, #121310)` | primary button, outbound bubble, current step |
| `--gradient-brand-soft` | `linear-gradient(180deg, rgba(188,222,112,0.16), rgba(168,202,92,0.05))` | `linear-gradient(180deg, rgba(170,204,72,0.18), rgba(170,204,72,0.05))` | soft panels |

### Status (fill vs `-text`)
The four status colours are unchanged by the palette. A fill is for a dot, a bar or a border; the `-text` is the
label. Cardamom is never a status.

| token | dark | light | role |
|---|---|---|---|
| `--success` | `#34C759` | `=` | fill |
| `--success-soft` | `rgba(52,199,89,0.16)` | `rgba(52,199,89,0.14)` | tint |
| `--success-text` | `#30DB5B` | `#1C712F` | label (the tightest light pair, 4.76:1) |
| `--danger` | `#FF3B30` | `=` | fill |
| `--danger-soft` | `rgba(255,59,48,0.16)` | `rgba(255,59,48,0.12)` | tint |
| `--danger-text` | `#FF938C` | `#C40013` | label |
| `--warning` | `#FF9F0A` | `=` | fill |
| `--warning-soft` | `rgba(255,159,10,0.16)` | `=` | tint |
| `--warning-text` | `#FFB340` | `#B32E00` | label |
| `--info` | `#5E5CE6` | `=` | fill |
| `--info-soft` | `rgba(94,92,230,0.18)` | `rgba(94,92,230,0.1)` | tint |
| `--info-text` | `#A3A1FF` | `#4C4ACC` | label |

`--border-info`, `--border-warning`, `--border-danger` and `--border-success` are the tone at 30%
(`color-mix`), one per tone, for every callout, error strip and alarm edge. They are derived, so they have no row.

### Platform colours: data, never decoration
Instagram and Facebook say which network a row belongs to. TikTok and YouTube are tints only, labelled with
`--text-strong`. Solid platform colours appear only in `.platform-bar-*`, and `check:contrast` enforces that.

| token | dark | light | role |
|---|---|---|---|
| `--brand-instagram` | `#E1306C` | `=` | data fill only |
| `--brand-instagram-soft` | `rgba(225,48,108,0.14)` | `=` | badge tint |
| `--brand-instagram-text` | `#FF75A6` | `#B5185C` | badge label |
| `--brand-facebook` | `#1877F2` | `=` | data fill only |
| `--brand-facebook-soft` | `rgba(24,119,242,0.14)` | `=` | badge tint |
| `--brand-facebook-text` | `#6FA8FF` | `#0A58CA` | badge label |
| `--brand-tiktok` | `#25F4EE` | `=` | tint source only |
| `--brand-tiktok-soft` | `rgba(37,244,238,0.16)` | `=` | badge tint; label is `--text-strong` |
| `--brand-youtube-soft` | `rgba(255,0,51,0.14)` | `=` | badge tint; label is `--text-strong` |
| `--brand-on-solid` | `#FFFFFF` | `=` | label on a solid platform fill (data viz only) |

### Charts
Read by `dashboard/js/charts.js` through `getComputedStyle`, so charts follow the theme. A chart's accent series
falls back to `currentColor`, never to a hex.

| token | dark | light | role |
|---|---|---|---|
| `--chart-grid` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.07)` | grid lines |
| `--chart-tick` | `#A3A698` | `#66695C` | axis labels and the select chevron |
| `--chart-positive` | `#2DD4A7` | `#248A3D` | up |
| `--chart-negative` | `#F87171` | `#D70015` | down |

### The logo mark: FROZEN
Three pinned tokens, the same in both themes and **independent of the palette**. The dashboard's mark
(`.logo-mark`, `.login-mark`) paints them and nothing else does. Frozen until TikTok accepts the app, then the
ر mark from §4.

| token | dark | light | role |
|---|---|---|---|
| `--mark-tile` | `#0071E3` | `=` | the tile; also `public/favicon.svg`'s fill |
| `--mark-tile-lit` | `linear-gradient(180deg, #0A7CF0, #0071E3 60%, #0064CC)` | `=` | the lit tile the dashboard has always drawn |
| `--mark-glyph` | `#FFFFFF` | `=` | the zap |

### Measured (the guard's arithmetic: glass composited down to the canvas)
`npm run check:contrast` reports these; the design-md test fails if this section stops matching its output.
- **Worst text pair:** 5.05:1 dark (`--text-muted` on `--surface-glass-hover` over `--surface-raised`) and 4.76:1
  light (`--success-text` on `--surface-glass-hover` over `--surface-page`). 220 text pairs are measured.
- **The accent as a fill:** `--text-on-accent` on `--accent`, `--accent-hover`, `--accent-active` and on every stop
  of `--gradient-brand`, at 4.5:1. Dark ink on the fill is 12.0:1; light white on ink is 17.2:1.
- **The accent as a shape, vs the grounds it sits on (3:1):** 10.9:1 dark, 15.6:1 light, at the tightest. The
  focus outline against the page is 12.4:1 dark and 15.6:1 light.
- **`--accent-text` on `--accent-soft` over a card:** 8.03:1 dark, 7.16:1 light.
- **Hue (≥ 25° apart, enforced):** the accent is 78.5° dark and 77.1° light, against danger 3.2°, warning 36.5° and
  success 135.1°.

### Usage
- Cardamom covers ≤ 5% of any screen.
- It is never a section background or a page field.
- It is never paired with forest green (Linktree's identity is lime on forest green).
- One primary (filled) action per view.

## 3. Typography Rules

**Faces (shipped)**
- `--font-ui` / `--font-latin` / `--font-mono`: the system stacks in tokens.css, for all UI and body text.
  Nothing is downloaded. An Arabic run falls through per glyph to the platform's Arabic face.

**Display face (planned, PR L3; not in tokens.css yet)**
- `--font-display: 'Alexandria', var(--font-ui)`: one self-hosted woff2 at weight 600.
  - **Subset:** Arabic (U+0600–06FF, U+0750–077F, U+FB50–FDFF, U+FE70–FEFF), plus U+0020–007E, U+00A0–00FF and
    U+2000–206F.
  - **OpenType features kept:** init/medi/fina/isol/rlig/liga/ccmp/mark/mkmk/kern.
  - **Loading:** ≤ 48 KB, `font-display: swap`, preloaded on `/` only.
  - **Where it will be declared:** `@font-face` in the SHARED SITE CHROME CSS block and in styles.css, not in
    tokens.css.
  - **Use for:** public h1/h2, the wordmark, `.figures`/`.tally` numbers, the dashboard page title (`--fs-500`), stat
    values (`--fs-600`), `--fs-700`, and the login title.
  - **Never use for:** body, labels, buttons, inputs, tables, chat bubbles, or legal text.

**Scale**
- Dashboard `--fs-100…700`: 12 / 14 / 16 / 18 / 22 / 28 / 36.
- Public (`--lp-*`, in landing.html):
  - `--lp-display` 36→60
  - `--lp-h2` 28→46
  - `--lp-h3` 18→22
  - `--lp-lede` 17→21
  - UI 14
  - micro 12 (the floor)
- Arabic body is 17px on public pages (Latin 16).

**Weights:** 400 / 500 / 600 / 700. Public display is 600 in Arabic and 500 in Latin. Public pages use
`font-synthesis-weight: none`.

**Line-height, never `normal`**

| Context | Arabic | Latin (`:lang(en)`) |
|---|---|---|
| `--lh-tight` / `--lh-normal` / `--lh-loose` | 1.45 / 1.75 / 2 | 1.3 / 1.55 / 1.7 |
| Public display | 1.30 | 1.05 |
| Public heads | 1.35 | 1.15 |
| Public body | 1.75 | 1.6 |
| Public UI | 1.5 | — |

**Arabic**
- Letter-spacing is always 0: in Arabic it widens the gaps between words.
- No italics: `em` becomes semibold.
- No `text-transform`.
- Tashkeel only where meaning needs it.
- Latin tracking is allowed only on `.doc[lang=en]` display text (−0.022em) and on `html[lang=en]` micro-labels.

**Numerals.** Latin digits everywhere (`ar-u-nu-latn-ca-gregory`). `tabular-nums` on stats and times. Arabic-Indic
digits only where check:i18n's allow-list permits.

**Punctuation.** Arabic ، ؛ ؟ and « ». English “ ”.

**Bidi**
- Every Latin run inside Arabic is wrapped in `<bdi lang="en" dir="ltr">`: brand and API names, ratios (`9:16`), file
  types (GIF, MP4), handles, times (`13:00`).
- Arabic inside English is `<bdi lang="ar" dir="rtl" class="ar">`.
- User content gets `dir="auto"`.
- An email address stays bare (one LTR run).

**Glossary (one spelling each)**

| Arabic | Means |
|---|---|
| إنستجرام | Instagram |
| فيسبوك | Facebook |
| تيك توك | TikTok |
| يوتيوب | YouTube |
| ريلز | reels |
| كاروسيل | carousel |
| المونتير | the Monteur |
| الإنفوجرافيك | Infographics |
| استوديو الكاروسيل | Carousel Studio |
| النمو | Growth |
| حملة | campaign |
| كلمة مفتاحية | keyword |
| رسالة خاصة | private message / DM |
| ردّ علني | public reply |
| لوحة التحكم | dashboard |
| «العامل» | the worker |
| مسودّات تيك توك | TikTok drafts |

## 4. Component Stylings

States, in order: rest · hover · active · focus-visible · selected · disabled · busy · invalid.

### Focus (global)
- `outline: 2px solid var(--accent)`, offset 2–3px, plus `box-shadow: 0 0 0 var(--ring) var(--accent-ring)`.
- The outline stays even with the shadow, because forced-colors mode drops shadows.
- **Selected is not focus:** selected is `inset 0 0 0 2px var(--accent)`. A focused, selected control shows both.

### Button `.btn`
- **Base:** min-height 44, radius 8, padding 12/24, 14px semibold (16px on public pages), explicit line-height.
- **primary:**
  - Rest: `--gradient-brand` with `--text-on-accent`, `--elev-glow`.
  - Hover: the accent-hover → accent → accent-active gradient, `translateY(-1px)`. The lit top and middle are the
    resting gradient's; the foot is deeper.
  - Active: `--accent-active`, `scale(.97)`, no shadow.
  - Disabled: opacity .5, no shadow.
- **secondary:** `--surface-glass`, `--text-strong`, 1px `--border-subtle`. Hover: glass-hover with `--border-strong`.
- **ghost:** text only; glass-hover on hover.
- **danger:** `--danger-soft` with `--danger-text` and `--border-danger`. Its focus ring is red, not cardamom.
- **busy:** the label stays legible (`--opacity-busy` .75), with a spinner.

### Input `.field/.field-textarea/.select`
- **Rest:** `--surface-sunken`, 1px `--border-subtle`, radius 8, padding 12, min-height 44, `--text-strong` at 14px.
  Placeholder `--text-muted`.
- **Focus:** border `--accent` plus the ring.
- **Invalid:** `aria-invalid`, border `--danger`, and a 32% danger ring.
- **Disabled:** `--opacity-disabled` .45.
- Textareas use `--lh-loose`.

### Card
- Outer radius 16, inner radius 12.
- Cards in any scrolling grid are solid (`--surface-solid`). Raised glass is only for a lone panel.
- Public `.card`: `--surface-raised` with `--lp-elev-card`; the block that uses it sets the padding.

### Chip / badge / pill
- Pill radius, 12px, padding 4/12 (4/8 on a badge). Badges are semibold.
- `.chip`: glass-hover with border-subtle.
- `.chip-accent`: `--accent-soft`, `--accent-text`, and a 30% accent border.
- Badges: the tone's soft tint with its `-text` colour.

### Keyword highlight `.kw` (the signature)
- `--accent-soft` background, `inset 0 0 0 1px var(--accent-ring)`, `--accent-text`, radius 8, padding .1em .3em,
  semibold.
- Only on the matched keyword, or on the one word that matters in a block.

### Eyebrow
- Pill with `--accent-soft`, an accent-ring inset and `--accent-text`; 14px semibold; a 6px dot in
  `currentColor`.
- Never letter-spaced small caps.

### Nav, dashboard
- Items 44px, 14px medium, `--text-default`.
- Hover: glass-hover.
- Active: `.nav-indicator` is `--accent-soft` plus a 2px inline-start `--accent` bar; the label turns
  `--text-strong`.

### Nav, public
- Sticky `.topbar`: `--surface-raised` with `blur(var(--blur-chrome))`. This is the only blur on public pages.
- Links 14px medium.
- `aria-current`: an `--accent-soft` pill with accent-ring.
- `.langswitch` is a pill; pressed is `--accent-soft` with `--accent-text`.

### DM bubble
- **Inbound:** `--surface-sunken`, `--border-subtle`, `--text-strong`; radius 12, start-start corner 6.
- **Outbound:** `--gradient-brand` with `--text-on-accent`, start-end corner 6. In dark, the outgoing message is a
  cardamom bubble with ink text.
- 14px, `--lh-loose`, `max-width: min(68ch,78%)`, `unicode-bidi: plaintext`.
- Time: 12px tabular, `currentColor` at 78%. Pending: opacity .55.
- **Public hero bubble:** `--accent` fill, radius 16, end-end corner 8.

### Platform badge
- `.badge-instagram` / `-facebook`: soft tint with `-text`. TikTok and YouTube: soft tint with `--text-strong`.
- `.platform-tag`: radius 6, the letters IG / FB.
- Never solid.
- Footer logos are `currentColor` glyphs and never mirror.

### Mark

**In use today, and frozen: Lucide's `zap` on a blue tile.**
- It is the dashboard's `.logo-mark` (sidebar, 38px) and `.login-mark` (login card, 62px), and `public/favicon.svg`.
- The tile paints `--mark-tile` / `--mark-tile-lit`, the glyph `--mark-glyph`, all pinned in tokens.css (§2). The
  favicon uses the literal `#0071E3` and white, because CSS variables don't reach a favicon.
- **Why frozen:** the app is in TikTok's review with this logo. Nothing in the palette may recolour it, so
  `src/dashboard/design-md.test.ts` pins the three tokens, the favicon's checksum and the manifest's icon list.
- **Browser chrome is not the logo, and was treated in two ways.** The `<meta name="theme-color">` tags in the HTML
  follow `--surface-page` (the test checks them). `public/site.webmanifest` was left byte-identical, `theme_color`
  (`#0071e3`) and `background_color` included, to be safe; both move with the logo at the switch below.
- The public pages have no mark tile: their wordmark is text.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="AutoReply Pro">
  <rect width="64" height="64" rx="14" fill="#0071e3"/>
  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" transform="translate(9.2 9.2) scale(1.9)" fill="#ffffff" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
</svg>
```

**Next, after TikTok accepts the app: the ر mark.** A ر whose tail ends in a reply arrowhead. Never mirrored; centre it
optically in preview.html.

```svg
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AutoReply Pro">
  <rect width="64" height="64" rx="15" fill="var(--mark-tile)"/>
  <g fill="none" stroke="var(--mark-glyph)" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M38 14c1.6 10.5 1 19.5-4.5 25.5-4.2 4.6-10 6.8-16.5 7"/>  <!-- the ر -->
    <path d="M24.5 38.5 16.5 46.5l8.5 7.5"/>                             <!-- its reply arrowhead -->
  </g>
</svg>
```

- **Tokens at the switch:** `--mark-tile` / `--mark-glyph` become `#BCDE70` / `#141610` in dark and `#1A1C15` /
  `#BCDE70` in light, and `--mark-tile-lit` goes (the new tile is flat). The pin in the test is then edited on
  purpose, in the same PR.
- **The switch is one PR:** the three tokens, the two markup spots in `dashboard/index.html`, `public/favicon.svg`
  (literal hex, with an inner `@media (prefers-color-scheme: light)` swap) and `public/site.webmanifest` (`icons`,
  `theme_color` to the new page colour, `background_color`).
- **Google:** don't change the logo on Google's OAuth consent screen until the YouTube audit is done; it re-triggers
  brand verification.
- **Wordmark:** the mark plus «أوتوريبلاي برو» in `--font-display` 600 once L3 ships (the system face until then), with
  "AutoReply Pro" beneath it at 12px regular `--text-muted`.
- **Clear space:** ¼ of the mark. **Minimum size:** 20px.

### Other patterns
Callouts, empty states, step marks, meters, media frames, wells and tint panels use the `Pattern:` blocks in
styles.css. Extend those; never make a one-off.

## 5. Layout Principles

**Direction.** RTL is the default, not a mode. Use logical properties only; the few physical exceptions are marked
in styles.css.

**Spacing.** 4px base: `--space-1…8` = 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. If a number you need is missing, the scale
is wrong; extend the scale.

**Radius**

| Radius | Use |
|---|---|
| 6 | tags, focus corners |
| 8 | buttons, inputs, media frames |
| 12 | wells, rows, inner panels |
| 16–20 | cards, modals |
| pill | chips, pills |
| 30 | the phone mock only |

**Public pages**
- Columns: landing 70rem, pricing 64rem, legal 52rem.
- Gutter `clamp(16px,2.5vw,32px)`.
- `--lp-band` (64→112px) is the only gap between sections.
- Measures:
  - prose ≤ 62ch
  - lede ≤ 46ch
  - h1 ≤ 19ch
  - h2 ≤ 22ch
- Hero: copy at the reading start, the artifact at the reading end; two columns from 62rem.

**Dashboard.** Sidebar 268, header 76, measure 68ch, tap target 44.

**Bilingual pages**
- One file, with two `<article class="doc" data-doc-lang>` siblings.
- The same section ids in both, suffixed `-ar` / `-en`.
- The SHARED SITE CHROME (CSS, navbar, footer) is byte-identical on all six public pages; only `aria-current`
  differs. `src/services/publicPagesChrome.test.ts` enforces it.

**Icons.** The Lucide subset.
- Mirror only directional icons (check:icons).
- Logos and the mark never mirror.
- No emoji as icons.

## 6. Depth & Elevation

| role | tokens | where |
|---|---|---|
| Glass | `--surface-raised/-overlay/-chrome` + `--blur-glass` 20 / `--blur-elevated` 28 / `--blur-chrome` 24, `saturate(180%)` | only what floats over scrolling content: sidebar, top bar, modals, toasts, the public sticky bar |
| Solid | `--surface-solid` | grid cards, media, `<option>`, anything that must render predictably |
| Tint | `--surface-glass/-hover` | chips, pills, hover rows, inbound bubbles |

**Elevation**
- `--elev-1/2/3/glow`: black and diffuse. Dark leans on hairlines, light on shadow.
- Public `--lp-elev-card/-lifted`: a top-edge lift, a ring, and three falling layers, tinted to the neutrals:
  `hsl(78 30% 2%)` in dark, `hsl(78 18% 36%)` in light.
- `--lp-elev-btn`, tinted:
  - dark: `hsl(78 40% 8% / .40), hsl(78 40% 8% / .30)`
  - light: `hsl(78 30% 20% / .22, .16)`

**Ambient**
- One radial glow from `--accent-ring` (`--lp-glow` .8 dark / .35 light, so its peak alpha is .32 / .16), plus a
  monochrome grain.
- Both are placed with `inset-inline-start`, because gradients don't mirror.
- The glow never sits behind blocks of body text. Where it does reach a headline (the closing call to action), the
  landing page's colour ledger records the contrast at the glow's peak.

**Motion**
- Easing: `--ease-standard` `cubic-bezier(.16,1,.3,1)`, `--ease-exit` `(.4,0,1,1)`.
- Durations: 120 / 200 / 320ms. On public pages, press is 90ms and hover 160ms.
- One scroll-reveal moment per page.
- Everything collapses to 1ms under `prefers-reduced-motion`.

**Stacking (z):** header 10 · drawer 50 · modal 100 · toast 200 · skip link 300.

## 7. Do's and Don'ts

### Owner rules: no exceptions
- **No women or girls.** Never a photo, illustration, avatar, emoji, stock image, or a female persona or name in a
  mock. Use male or neutral names (سالم / Salem) or handles.
- **No Clario.** Never name Clario or ClarioDR anywhere public.
- **Arabic marketing copy is فصحى.** Dialect appears only inside quoted user speech «…» (with `dir="auto"`), or
  when showing a tenant's own chosen register.
- **Legal pages stay put.** `/terms`, `/privacy` and `/data-deletion` keep their URLs. Brand work never edits their
  body text; it touches only the chrome and the CSS.
- **Describe the app exactly as it works.** Meta, TikTok and Google reviewers read these pages. No claim for a
  parked or planned path (see the truth table in §9).
- **Operator identity and contact.**
  - The operator's public identity (ElAmir Mansour and his three accounts) stays in the footer and the legal pages.
  - Contact goes through `{{WHATSAPP_URL}}` / `{{CONTACT_EMAIL}}`, never a literal. A test enforces this.
- **The logo does not change until TikTok accepts the app** (§4, Mark).

### Do
- Highlight one word per block with `.kw`.
- Use the ink/cardamom pair on the one primary action.
- Measure every new text/ground pair (`npm run check:contrast`).
- Write both languages in the same PR.
- Say what is NOT promised.

### Don't
- Blue anywhere in our chrome. (The frozen mark is the one exception, until the switch.)
- Colour literals in a `var(--x, #…)` fallback, or anywhere outside tokens.css. A fallback is a second palette.
- Platform colours as solid fills on controls.
- Cardamom as a background field or a status.
- Glass on grid cards.
- Letter-spacing on Arabic.
- `transition: all`.
- Emoji in chrome or marketing.
- "Pro", "Premium", "Powered by", "instant", "guaranteed".
- Invented metrics, testimonials, logo walls, ratings, or "trusted by".
- A price on the landing.
- A self-signup button.
- Presenting the Monteur or Infographics as available to client accounts before M8 ships.

## 8. Responsive Behavior

**Widths**
- Designed: 375 · 390 · 768 · 1024 · 1280 · 1440.
- 320 may wrap but never scroll sideways (`scrollWidth === clientWidth`).
- Breakpoints in use: 30rem, 40rem, 48rem, 52rem, 62rem. Reuse them; don't invent new ones.

**Navigation and layout**
- The top bar fits in one row at 375 in both languages (365/375 measured), so **no new nav items**. New
  destinations go in-page and in the footer's Product group.
- Below 62rem the hero is one column.
- The contact card is two columns from 52rem.
- The footer's Contact group takes a full row under 30rem.

**Media**
- Slide and reel rows scroll horizontally. They are a tab stop only while they actually scroll.
- Video:
  - a 9:16 box, at most 18rem wide on phones
  - `poster`, `preload="none"`, `playsinline muted`
  - never autoplay with sound, and no autoplay at all under reduced motion

**Dashboard.** Tables become `.log-cards` under 40rem, and the sidebar becomes a drawer.

## 9. Agent Prompt Guide

### Before you start
- Read this file and `dashboard/css/tokens.css`.
- For public pages, read the claim ledger in landing.html's header comment.
- For copy, check the truth table below.

### Truth table (2026-10-13)
| state | what |
|---|---|
| Live | Comment→DM campaigns on IG/FB (DM, an optional public reply, and a best-effort like). Scheduling to IG/FB (a queue, not minute-exact). TikTok to drafts (Direct Post is "Only me" until TikTok's audit). YouTube Shorts upload (public uploads on). Carousel Studio and the Monteur (a Mac worker; Monteur review mode by default). Growth (insights need Meta permissions). Multi-account with roles, activity log, CSV export. |
| Owner-only | Infographics (Claude on the owner's Mac). |
| Parked | AI DM replies. Treat the inbox send path the same; don't claim either. |
| Planned | Invite-link onboarding (~5 min); voice registers (فصحى/خليجي/مصري/شامي/English); the AI providers layer (any provider's key); Facebook Login for Business; Monteur and Infographics for clients (M8). |
| Not planned | Self-serve signup, online payment. |

### Asking for UI
Use this prompt: "On <page/section>, <goal>. Use tokens and existing classes only; name the pattern you extend; give
both languages; dark and light; 375 and 1280." Reject any answer that writes a hex value outside tokens.css.

### Producing UI
- Compose existing classes. Add a token before you write a magic number.
- Use logical properties, and `<bdi>` for every run in the other script.
- Preview in `preview*.html` and the Browser pane at 375 and 1280, in both themes and both languages.

### Voice
**Arabic (فصحى):** short declaratives, second person «أنت», concrete nouns over adjectives, and the limit stated in
the same paragraph as the feature.
- ✅ «تعتمد كل ريل قبل نشره.»
- ❌ «حلّ ذكي متكامل يضاعف تفاعلك فوراً!»

**English:** plain and specific, with no exclamation marks.
- ✅ "You approve every reel before it posts."
- ❌ "Supercharge your engagement with AI!"

### The guards
| check | stops |
|---|---|
| `check:contrast` | a text/ground pair under 4.5:1 in either theme (glass composited down to the canvas, the accent's highlighter stacks included); the label on the accent fill, on its hover and press steps and on every gradient stop under 4.5:1; the accent as a shape under 3:1 against its grounds; two semantic colours (including accent vs success) within 25° of hue; a platform colour used as a solid fill outside data visualisation |
| `check:icons` | a directional icon that does not mirror in RTL, or a clock that does |
| `check:i18n` | an English string with no Arabic translation, a placeholder mismatch, an Arabic-Indic digit outside its allow-list |
| `check:assets` | a dashboard change shipping without a cache-version bump, on the shell **or** on the public pages that pin the same stylesheet |
| `check:icon-subset` | `dashboard/js/icons.js` out of date with the icon names the dashboard uses |
| `design-md.test.ts` | a §2 value that differs from tokens.css; a colour token with no row; the frozen mark, favicon or manifest icons changing; the browser-chrome `theme-color` drifting from `--surface-page`; a colour literal creeping back into a legal page's fallbacks |

### Before the PR
Run:

`npm run typecheck && npm test && npm run check:contrast && npm run check:i18n && npm run check:icons && npm run check:icon-subset && BASE_REF=origin/main npm run check:assets`

Any change under `dashboard/` bumps `?v=` and `ASSET_VERSION` together, and the same `?v=` on every page in
`SHARED_ASSET_PAGES`.

### Legacy references
Code comments still cite the previous DESIGN.md numbering (the Apple-HIG document). Mapping:

| Old section | New section |
|---|---|
| §3 colour | §2 |
| §4 geometry, focus, motion | §4 / §6 |
| §5 RTL | §5 / §3 |
| §6 "deliberately absent" | §7 |
| §7 inventory | §4 |
| §8 guards | §9 |
