# DESIGN.md — Quanta Design System

> Concrete design tokens and rules. The web app mirrors these as CSS variables
> and a Tailwind v4 `@theme`. Register: product. Theme: dark-first.
>
> Current system: **cyan-glass on near-black** (ported from `dashboard-ref`).
> A near-black `#050505` canvas under a fixed cyan/sky radial-glow gradient,
> translucent white "glass" surfaces (blur + hairline white borders), a single
> **cyan** accent, and Geist Sans/Mono.

## Theme decision

Scene: "a competitor at a desk during a timed, high-stakes challenge, scanning
the order book and PnL and making fast decisions over a multi-hour session,
sometimes in a dim hall." This forces a **dark** terminal-grade theme, lower
ambient glare, numbers that pop without vibrating.

Color strategy: a deep near-black canvas with a cyan/sky glow backdrop;
surfaces are translucent glass (frosted via `backdrop-blur`). A single cyan
accent marks primary actions, selection, focus, and active nav. Up/down is a
separate semantic vocabulary (emerald / red).

## Color

Canvas is near-black; surfaces are translucent white so panels read as frosted
glass over the glow backdrop. Borders are low-opacity white hairlines.

### Dark (default)

```
--bg:            #050505;                      /* app background (near-black) */
--surface:       rgba(255,255,255,0.04);       /* panels, cards (glass) */
--surface-2:     rgba(255,255,255,0.06);       /* raised / hover */
--surface-3:     rgba(255,255,255,0.09);       /* popovers, inputs */
--border:        rgba(255,255,255,0.10);       /* hairlines */
--border-strong: rgba(255,255,255,0.18);       /* emphasized dividers */
--text:          #ededed;                      /* primary text */
--text-muted:    #a1a1aa;                       /* secondary (zinc-400) */
--text-faint:    #71717a;                       /* tertiary, axis labels (zinc-500) */

--accent:        #22d3ee;   /* cyan-400 — primary action/selection/focus */
--accent-hover:  #67e8f9;   /* cyan-300 */
--accent-fg:     #050505;   /* text on solid accent */
--accent-subtle: rgba(34,211,238,0.12);  /* accent-tinted glass */

--up:            #34d399;                 /* gains — emerald-400 */
--up-subtle:     rgba(52,211,153,0.12);
--down:          #f87171;                 /* losses — red-400 */
--down-subtle:   rgba(248,113,113,0.12);
--warning:       #fbbf24;                 /* amber-400 */
--info:          #38bdf8;                 /* sky-400 */
```

### Backdrop

The body sits on `--bg` with a fixed cyan/sky radial-glow:

```
background-image:
  radial-gradient(circle at 50% 0%,  rgba(6,182,212,0.15) 0%, transparent 60%),
  radial-gradient(circle at 50% -20%, rgba(56,189,248,0.2) 0%, transparent 70%);
background-attachment: fixed;
```

Scrollbars are thin with a cyan hover thumb (`rgba(34,211,238,0.3)`).

Usage rules:
- Accent (cyan) only for primary actions, current selection, focus rings, active
  nav, and hover affordances. Never as bulk decoration.
- Up/down used for signed numbers, the buy/sell sides of the book, deltas. Always
  pair color with a sign (+/-) or side label so it survives color-blindness.
- Inactive/disabled states drop toward neutral glass; never full-saturation.

## Typography

- **UI sans:** Geist (variable), via `next/font`. Fallback: system-ui stack.
- **Numeric/mono:** Geist Mono for all prices, sizes, PnL, order book,
  leaderboard figures. Always `font-variant-numeric: tabular-nums`.
- Base size **14px**; scale ratio ~1.2.

```
--text-xs:   12px / 16px
--text-sm:   13px / 18px
--text-base: 14px / 20px
--text-md:   16px / 24px
--text-lg:   18px / 26px
--text-xl:   22px / 30px
--text-2xl:  28px / 36px   (page titles only)
```

Weights: 400 body, 500 labels/buttons, 600 headings/emphasis, 700 sparingly.
Money and large stat readouts: mono, 500-600, tabular.

## Spacing

4px base grid: `2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64`. Use rhythm, not
uniform padding. Panels: 16px internal; dense rows (book/ladder): 4-6px vertical.

## Radius

```
--radius-sm: 6px;   /* chips */
--radius-md: 8px;   /* small controls */
--radius-lg: 12px;  /* buttons, inputs */
--radius-xl: 16px;  /* panels, cards, modals */
```

Glass panels and cards are generously rounded (`rounded-xl`). Do not pill
everything. Pills only for status badges.

## Elevation

Glass UI leans on `backdrop-blur` + a hairline white border over heavy shadows.

```
--shadow-sm: 0 1px 2px oklch(0 0 0 / 0.30);
--shadow-md: 0 4px 12px oklch(0 0 0 / 0.35);
--shadow-pop: 0 8px 28px oklch(0 0 0 / 0.45);
```

## Motion

- Durations: 120ms (hover/press), 180ms (panel/menu), 220ms (overlay).
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` (ease-out-quart-ish). No bounce.
- **Value flash:** when a number updates, flash its background to `--up-subtle`
  or `--down-subtle` for 150ms, then fade. Never animate layout/position on tick.
- Respect `prefers-reduced-motion`: disable flashes and non-essential transitions.

## Components (vocabulary)

- **Button:** cyan-glass accent (primary: `--accent-subtle` fill, `--accent`
  text, cyan border), subtle surface-2 (secondary), ghost (tertiary). Buy =
  `--up` tinted, Sell = `--down` tinted, with full borders, not side-stripes.
- **Panel:** frosted glass — `--surface`, `backdrop-blur`, 1px `--border`,
  `--radius-xl`, 16px padding, a compact header row (label + optional control).
- **Order book row:** two-column ladder, depth bar as a low-opacity background
  fill behind the row (up/down subtle), price in mono.
- **Stat readout:** small uppercase `--text-faint` label + large mono value;
  signed values colored.
- **Table (leaderboard/orders):** dense rows, sticky header, zebra via subtle
  surface tint, rank emphasized.
- **Inputs:** `--surface-3`, 1px border, accent focus ring (2px).
- States required on every interactive element: default, hover, focus-visible,
  active, disabled, loading, error.

## Layout

- App shell: slim top bar (brand, challenge switcher, live clock, user menu) +
  optional left rail for nav on wide screens; content is a responsive grid.
- Trading view grid (desktop): chart (large) + portfolio/stats (right column);
  below, order book + trade ticket + open orders. Collapses to stacked sections
  on tablet/mobile. Real-time regions never reflow the grid.
