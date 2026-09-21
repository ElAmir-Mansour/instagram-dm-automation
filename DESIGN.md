# AutoReply Pro — design language

**Audience:** whoever changes the interface next, including me.
**Status:** adopted 2026-09-21, replacing the palette and type pairing this project shipped with.

---

## 0. What this product is, before any colour

A Saudi business owner opens this at 8pm because someone commented on a reel and they do not
want to lose the sale. The material of the product is **what people wrote, in Arabic**.

That single sentence decides almost everything below. It is worth stating because the design
this replaced had decided something else.

---

## 1. The central decision: a desk, not a control room

What this looked like before: near-black blue-tinted surfaces, translucent "glass" panels,
coloured glow beneath raised cards, and an indigo-to-violet gradient on the primary button.

That is the visual language of **monitoring machines** — a NOC, a trading terminal, a status
wall. It is a coherent aesthetic and it is the wrong one, because nobody here is watching
machines. They are reading a message a person sent them and deciding what to say back.

So: **a desk with a lamp on it.** Paper and ink in light mode, a warm pool of light in dark
mode. Warm neutrals, not cold slate. Crisp edges, not pillows. Elevation that says "this is
on top of that", not "this is special".

The test for any new component: *would this look at home on a desk, or on a wall of screens?*

---

## 2. Typography — one family, because mixed script is the norm here

`--font-ui` · **IBM Plex Sans Arabic** → `--font-latin` · **IBM Plex Sans** → `--font-mono` ·
**IBM Plex Mono**

**Why not Cairo + Inter**, which this shipped with and which is the default pairing every
Arabic dashboard reaches for: both are good faces and together they are a mismatch. Cairo is
geometric-humanist with tall, open Arabic forms; Inter is a neo-grotesque tuned for small
screen sizes. Their x-heights and weight axes do not agree.

In a Latin-first product that is a subtle flaw. Here it is structural, because **mixed script
is the normal case, not the exception** — every campaign keyword list contains both
(`ذكاء, ذكاء اصطناعي, agentic, ai`), every inbox thread has handles in it, every id is Latin.
Two faces that disagree means every one of those lines sits at two slightly different optical
weights.

The three Plex members are one family designed together, so the Arabic leads and the Latin
follows it at matching weight and proportion. The whole interface speaks in one voice instead
of three borrowed ones.

**Rules**
- The Arabic member is the **primary**, not a fallback. It comes first in `--font-ui`.
- Never name a face directly in a component. Use `--font-ui` / `--font-latin` / `--font-mono`.
  The one exception is `charts.js`, because Chart.js takes a family *name* and cannot read a
  CSS variable — it is commented there.
- Latin runs inside Arabic text (`@handles`, ids, URLs) get `--font-latin` and their own
  `lang`, so the browser shapes each script with the right member.
- Ids, tokens and connection strings get `--font-mono`. Never body copy.

---

## 3. Colour — three roles, and one of them is not ours

### The primary action is terracotta, and the first attempt at this was wrong

It was `#4f46e5`: **Tailwind's default Indigo-600**. That is the single most recognisable "an
AI generated this" colour on the web, and it is the main reason this product looked like a
template rather than like itself.

The first replacement was teal, and **it was incoherent** — worth recording, because the
mistake is instructive. The neutrals had just been made warm on purpose (hue 34-40). Teal
sits at hue 176. Those are near-complementary: the accent fought the ground it sat on, which
is exactly what "the colours look weird" means when someone says it without a hex value.

Terracotta (hue ~15) agrees with the warm neutrals instead of arguing with them. It reads as
earthy and deliberate rather than technological, which suits a tool for reading what people
wrote. And it stays clear of both Instagram pink and Facebook blue, so a primary button never
competes with the platform chip beside it in the same row — **indigo did**, sitting between
them on the hue wheel.

### The alarms had to move out of its way

Terracotta lands between the two alarm colours. As shipped they were 18 and 22 degrees away
from it, and two solid buttons that close together are genuinely hard to tell apart at a
glance. "Delete" must never be mistakable for "Publish".

So `--danger` went cooler (to hue ~347) and `--warning` yellower (to ~43) until both cleared
**25 degrees**. That threshold is a judgement rather than a standard: it is where these three
read as distinct in side-by-side rows in this product.

`scripts/check-contrast.mjs` now enforces it. Without that, the widening would be quietly
undone by the next colour tweak and nobody would notice, because **each colour still passes
contrast on its own**. Saturation difference helps as well (the accent is muted at ~56 where
the alarms are vivid at ~85) and is reported but not enforced, being the weaker signal.

### The three roles

| role | token | means |
|---|---|---|
| **Act** | `--accent` | the one thing to do on this screen |
| **Attention** | `--warning` | someone is waiting; nothing is broken yet |
| **Platform** | `--brand-instagram`, `--brand-facebook` | **data, never decoration** |

The platform colours are Meta's, not ours. They exist to say *which network this row belongs
to* and they must never be used to style a button, a heading or a surface.

**Asked and answered: no, the product cannot just use Facebook blue.** Two reasons, and the
second is the one that would bite first.

*Policy.* A third party may not "imply an endorsement or partnership of any kind" with Meta's
brands without written permission, and their assets may not be "modified in any way, such as
by changing the design or color". Wearing their blue as our own is exactly that, and this app
is heading for App Review, where Meta looks at the app and its branding.

*Product, which is measurable.* This dashboard shows Facebook and Instagram **side by side**.
An accent at Facebook blue's hue is **0 degrees** from `--brand-facebook`, so `.btn-primary`
and `.badge-facebook` become the same colour: "Publish" reads as a platform tag, Instagram
rows read as "the other one", and the interface takes a side between two platforms it treats
equally. It is the indigo trap again, except indigo merely sat *between* the two platform hues
where Facebook blue *is* one of them.

There is also nothing to adopt on the system-design side: Meta publishes brand *guidelines*,
not a component library. Unlike Polaris, Carbon or Primer there is no public Meta design
system for third parties to build on.

`check-contrast.mjs` enforces the separation, so this is a rule the build holds rather than a
paragraph someone has to remember.

### Neutrals are warm

The old ramp was blue-tinted (`#08080d` → `#171722`, text `#c6cedb`). Warm graphite instead.
Beyond the desk metaphor there is a practical reason: Arabic has more stroke contrast and more
fine detail per line than Latin at the same size, and a warm ground is measurably kinder to it
than a cold one.

### No gradient

The indigo→violet 135° gradient is gone and is not coming back. A primary action does not need
a rainbow to look primary. `--gradient-brand` still exists, but it is now **one hue with depth**
— the same teal, lit from the top edge.

---

## 4. Form

- **Radii** `3 / 6 / 9 / 13 / 18`. Tightened from `6 / 10 / 14 / 18 / 24`, which is the default
  soft-rounded shape of a generated dashboard; past 14px a data table starts reading as a set
  of pills rather than a document.
- **Elevation** is three neutral shadows. `--elev-glow` used to be tinted with the accent,
  which said "special" about components that were merely present. Warm neutral now.
- **No glassmorphism.** `--surface-glass` survives as a 3.5% overlay for hover states, which is
  what it is actually for. It is not a panel treatment.

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
4. 432 tests and 16 page modules is verified work a rewrite discards.

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
| `check:contrast` | any text/surface pair below WCAG AA (4.5:1) in either theme, **and** any two semantic colours drifting within 25° of hue |
| `check:icons` | a directional icon that does not mirror in RTL, or a clock that does |
| `check:i18n` | an English string with no Arabic translation, rendering English inside an RTL page |
| `check:assets` | a dashboard change shipping without a cache-version bump, on the shell **or** on the public pages that pin the same stylesheet |

The tightest real contrast pair currently measures **5.01:1**. There is little headroom, which
is exactly why it is checked rather than asserted.
