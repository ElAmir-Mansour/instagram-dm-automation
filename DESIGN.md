# AutoReply Pro — design language

**Audience:** whoever changes the interface next, including me.
**Status:** adopted 2026-09-21. Apple HIG / macOS glassmorphism, replacing a warm terracotta
direction, which replaced a Tailwind-indigo default.

---

## 0. What this product is, before any colour

A Saudi business owner opens this at 8pm because someone commented on a reel and they do not
want to lose the sale. The material of the product is **what people wrote, in Arabic**.

That sentence still decides the things colour cannot: that Arabic leads, that RTL is the
default rather than a mode, and that nothing decorative earns space.

---

## 1. The aesthetic: a macOS window

Translucent surfaces over a soft canvas, depth carried by blur and diffuse shadow rather than
by borders and hard edges, and motion that settles instead of snapping. Content scrolls softly
behind the chrome.

Three roles, and getting them mixed up is the main way this design breaks:

| role | token | when |
|---|---|---|
| **Glass** | `--surface-raised`, `--surface-overlay` | anything that FLOATS over content: cards, the sidebar, the top bar, modals, toasts |
| **Solid** | `--surface-solid` | anything that must render predictably: native `<option>` popups, image and media frames |
| **Tint** | `--surface-glass`, `--surface-glass-hover` | small inline fills: pills, chips, switch tracks, hover rows, incoming chat bubbles |

`--surface-raised` and `--surface-overlay` are **translucent**. They have no real colour until
composited over the canvas. Anything needing an opaque background must use `--surface-solid`,
which exists for exactly that. Getting this wrong is not subtle: pointing a no-blur component
at a translucent token gives a see-through panel with nothing behind it.

**Two places glass is wrong on purpose.** A native `<option>` is drawn by the OS popup and
cannot be translucent or blurred, so a glass value there renders differently on every
platform. And a chat bubble is a tint, not glass — blurring the messages behind every bubble
is both wrong and expensive while scrolling.

---

## 2. Typography: the system font, and no webfont at all

```
-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'SF Arabic',
system-ui, 'Segoe UI', Roboto, 'Noto Sans Arabic', 'Geeza Pro', Tahoma, sans-serif
```

HIG's own answer to typography is *use the system font*, so this loads **nothing**. The Google
Fonts request is gone, which removes a third-party round trip from the critical path as well
as roughly 100KB.

**Arabic coverage is functional here, not aesthetic**, so the stack is longer than the brief's.
On Apple platforms `-apple-system` resolves to SF, which includes SF Arabic and is the
authentic choice. Elsewhere it falls through to each platform's UI face and then to named
Arabic faces present by default. Glyph fallback is per character, so an Arabic run always
lands on something designed for it rather than on a Latin face with no Arabic at all.

---

## 3. Colour: fills and labels are different tokens

`--accent` is **#0071E3** — Apple's system blue. Used for button fills, active states and the
focus ring.

**`--accent-text` is a different colour, and that is the single most important thing on this
page.** #0071E3 as *text* on the dark glass surface measures **3.38:1** — below AA. White on
#0071E3 measures **4.70:1** and passes. Apple ships separate "accessible" variants for exactly
this reason, and every `-text` token here is one.

The same split applies to every status colour. `--success`, `--warning` and `--danger` are
Apple's system fills (#34C759, #FF9F0A, #FF3B30). As *text* on the tinted grounds they measure
between **2.00:1 and 3.46:1** — three of them outright failures. Their `-text` variants are
Apple's accessible values, stepped one further where even those fell short.

Two values in the brief were changed, and only these two:

- **`--text-muted` is #6E6E73 / #636366, not #86868B.** The brief's value measures 3.33:1 on
  the canvas and 3.53:1 on glass — below AA for normal text, and it carries form hints, table
  headers, empty states and every timestamp. #86868B survives as `--text-muted-large`, for
  large text only.
- **The hover tint is 0.075 / 0.11**, not a straight doubling of the fill. The brief's fill
  alphas (0.05 light, 0.08 dark) are used exactly as given; the hover step is the one number
  that is mine, and it was chosen so Apple's own published text colours clear AA on it.

### Platform colours

Instagram pink and Facebook blue are **data, never decoration** — they say which network a row
belongs to. `--accent` is now within 4° of Facebook blue, which is fine and is checked
structurally rather than by hue: a platform colour may be a **solid** fill only in data
visualisation (`.platform-bar-*`). On any control it must go through `-soft` as a tint with
`-text` as the label, which is how `.badge-facebook` and `.platform-tag.fb` already work — and
they also carry the literal letters "FB", so a solid blue button and a faint blue tint are
distinguishable whatever their hue.

This also keeps us the right side of Meta's platform terms, which forbid a third party from
implying "an endorsement or partnership of any kind".

---

## 4. Geometry, depth and motion

- **Radii** `6 / 8 / 12 / 16 / 20`, pill for chips. Buttons and inputs at 8, inner panels at
  12, outer windows and modals at 16–20. Larger than the previous 3/6/9/13/18, because the
  radius is part of what makes a window read as a window.
- **Depth is diffuse, never harsh.** `--elev-2` is
  `0 4px 24px -1px rgba(0,0,0,0.06), 0 2px 6px -1px rgba(0,0,0,0.04)`; modals carry
  `0 16px 48px rgba(0,0,0,0.14)`. Dark mode leans on a hairline border instead, because shadow
  does almost nothing against a dark canvas.
- **Blur** is tokenised: `--blur-glass` 20px, `--blur-elevated` 28px, `--blur-chrome` 24px,
  each with `saturate(180%)`. No component hardcodes a blur radius.
- **Motion** is `cubic-bezier(0.16, 1, 0.3, 1)` — a long decelerating tail, so a hover settles
  rather than snapping. Hover shifts a background tint or opacity; it does not jump.
- **Focus** is a soft glowing ring (`box-shadow: 0 0 0 4px var(--accent-ring)`) with the solid
  outline kept underneath, because `box-shadow` is dropped entirely in forced-colors mode and
  the affordance has to survive that.

---

## 5. RTL is the default, not a mode

- **Logical properties only.** 149 in the stylesheet, zero physical `margin-left` / `left:`.
  This is better than GitHub Primer, whose margin utilities are still `l`/`r`.
- **Icons mirror only when their meaning depends on reading direction.**
  [Material Design 3](https://m3.material.io/foundations/layout/bidirectionality-rtl) is the
  only published system with an enumerated rule. Arrows, chevrons, send, reply, log-in/out
  mirror. Clocks, circular refresh, media transport and checkmarks **must not** — a mirrored
  `rotate-cw` reads counter-clockwise. Enforced by `scripts/check-rtl-icons.mjs`.
- **Digits are Latin, deliberately.** `locale: 'ar-u-nu-latn-ca-gregory'`. CLDR defaults `ar-SA`
  to Arabic-Indic (`٠١٢٣`); we override because this is a business tool where numbers are
  compared, copied and pasted against Meta's own dashboards.
- **`dir="auto"` on every user-content node.** A customer's message can be in either script and
  we do not get to choose.

---

## 6. What is deliberately absent

Each of these was in the product or is the obvious thing to add, and each is excluded on
purpose:

- **Decorative status indicators.** A "System online" badge that is green whenever the page
  rendered is worse than nothing: it is a claim the interface cannot support.
- **Emoji in chrome.** Emoji in a customer's message is content. Emoji in a button label is a
  costume.
- **Congratulatory empty states.** An empty inbox is not an achievement. State what is true and
  what to do next.
- **Invented metrics.** If a number is not measured, it does not go on a card.
- **"Pro" / "Premium" / "Powered by" language.** The operator knows what they bought.

---

## 7. The component inventory, and why there is no React

The interface is vanilla JS with no build step. That is a live question — a component library
would hand over accessible modals and tables for free — so here is the actual position.

**What already exists**: ~380 component classes in `styles.css` and ~40 helpers on `UI`,
covering every role a dashboard needs:

| role | what is there |
|---|---|
| Surfaces | `.surface`, `.card-grid`, `.stat-card`, `.table-card`, `.ops-card`, `.panel-*` |
| Actions | `.btn` + primary/secondary/ghost/danger/sm/full, `.icon-btn`, `.segmented` |
| Overlays | `.modal-*` with focus trap, Escape, focus restore, dirty-field guard |
| Feedback | `.toast` (aria-live), `.alert-card`, `.inline-error`, `.error-panel`, `.warning-card` |
| Data | `.data-table`, `.log-cards` (the table's mobile form), `.pagination`, `.filter-bar` |
| State | `.skel-*` skeletons, `.spinner`, `.empty-state`, `.health-*` |
| Forms | `.field`, `.form-group`, `.switch`, `.select`, `.chip-select`, invalid marking |
| Messaging | `.message-bubble`, `.bubble-*`, `.thread-item`, `.msg-carousel`, `.typing-dots` |
| Helpers | `formatNumber`/`formatDate`/`relativeAge` via `Intl`, `captureFocus`/`restoreFocus`, `registerActions` delegation, `html` auto-escaping |

**The case against migrating**, in order of weight:

1. **All four CI guards are vanilla-specific.** `check:icons` greps `data-lucide`,
   `check:i18n` greps `t('…')` and `data-i18n`, `check:assets` exists precisely *because*
   there is no bundler to content-hash. A rewrite invalidates every one of them, and they
   were each added after a real failure.
2. **The expensive part is done.** Focus management, `aria-live`, optimistic updates, RTL on
   logical properties, the auto-escaping template — all built and tested. "Easier components"
   would buy components that already exist.
3. **No build step is why a deploy is 20 seconds** and why there is no build to break.
4. 449 tests and 16 page modules is verified work a rewrite discards.

**What would change the answer**: a second developer joining, or needing a library's
accessibility work for free. Not component convenience. If it ever happens, the honest
sequence is Preact via ESM (no bundler) before React with one.

**The rule in the meantime**: add to this inventory rather than inventing a one-off. A new
pattern that appears twice belongs in `styles.css` with a class, not copied between pages.

---

## 8. The guards

This document describes intent. Four CI checks enforce the parts that can be:

| check | stops |
|---|---|
| `check:contrast` | any text/surface pair below WCAG AA (4.5:1) in either theme, **compositing the full glass stack down to the opaque canvas**; any two semantic colours within 25° of hue; and any platform colour used as a solid fill outside data visualisation |
| `check:icons` | a directional icon that does not mirror in RTL, or a clock that does |
| `check:i18n` | an English string with no Arabic translation, rendering English inside an RTL page |
| `check:assets` | a dashboard change shipping without a cache-version bump, on the shell **or** on the public pages that pin the same stylesheet |

`check:contrast` measures **144 pairs** across both themes. The tightest is **4.67:1**. That
number is low on purpose: glass surfaces shift the ground under text, so the margin is thin
and this is checked rather than asserted.

One thing to know about the guard itself: it used to hold a flat list of "opaque" surfaces
plus one hardcoded glass parent, and that broke the moment the design went glassmorphic — it
composited the hover tint over `--surface-raised`'s *raw* rgba and reported failures that were
artefacts of its own arithmetic. It now models each surface as the stack a pixel actually
passes through.
