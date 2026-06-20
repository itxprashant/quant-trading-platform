# DESIGN.md — Quanta Design System

> Concrete design tokens and rules. The web app mirrors these as CSS variables
> and a Tailwind v4 `@theme`. Register: product. Theme: dark-first.

## Theme decision

Scene: "a competitor at a desk during a timed, high-stakes challenge, scanning
the order book and PnL and making fast decisions over a multi-hour session,
sometimes in a dim hall." This forces a **dark** terminal-grade theme, lower
ambient glare, numbers that pop without vibrating.

Color strategy: **Restrained** base (tinted neutrals + one accent) with a few
**Committed** moments (the active selection rail, the primary CTA, the focused
chart). Up/down is a separate semantic vocabulary, intentionally not neon.

## Color (OKLCH)

Neutrals are tinted toward the brand hue (iris, ~280deg) so the UI never reads as
flat gray-black. Never `#000`/`#fff`.

### Dark (default)

```
--bg:            oklch(0.155 0.012 280);  /* app background */
--surface:       oklch(0.190 0.013 280);  /* panels, cards */
--surface-2:     oklch(0.230 0.014 280);  /* raised / hover */
--surface-3:     oklch(0.270 0.015 280);  /* popovers, inputs */
--border:        oklch(0.300 0.014 280);  /* hairlines */
--border-strong: oklch(0.380 0.016 280);  /* emphasized dividers */
--text:          oklch(0.960 0.005 280);  /* primary text */
--text-muted:    oklch(0.730 0.012 280);  /* secondary */
--text-faint:    oklch(0.560 0.012 280);  /* tertiary, axis labels */

--accent:        oklch(0.640 0.185 285);  /* iris — primary action/selection */
--accent-hover:  oklch(0.690 0.185 285);
--accent-fg:     oklch(0.985 0.010 285);  /* text on accent */
--accent-subtle: oklch(0.300 0.070 285);  /* accent-tinted background */

--up:            oklch(0.760 0.140 168);  /* gains — refined teal-green */
--up-subtle:     oklch(0.300 0.060 168);
--down:          oklch(0.670 0.165 22);   /* losses — warm rose, not neon */
--down-subtle:   oklch(0.300 0.080 22);
--warning:       oklch(0.800 0.130 75);   /* amber */
--info:          oklch(0.700 0.120 235);  /* blue */
```

### Light (secondary, for admin/marketing on bright screens)

```
--bg:            oklch(0.985 0.004 285);
--surface:       oklch(1.000 0 0);
--surface-2:     oklch(0.970 0.005 285);
--border:        oklch(0.910 0.006 285);
--text:          oklch(0.230 0.020 285);
--text-muted:    oklch(0.480 0.018 285);
--accent:        oklch(0.560 0.190 285);
--up:            oklch(0.560 0.130 168);
--down:          oklch(0.560 0.180 22);
```

Usage rules:
- Accent only for primary actions, current selection, focus rings, active nav.
  Never as decoration or on inactive states.
- Up/down used for signed numbers, the buy/sell sides of the book, deltas. Always
  pair color with a sign (+/-) or side label so it survives color-blindness.
- Inactive/disabled states drop chroma toward neutral; never full-saturation.

## Typography

- **UI sans:** Inter (variable), via `next/font`. Fallback: system-ui stack.
- **Numeric/mono:** Geist Mono (or JetBrains Mono) for all prices, sizes, PnL,
  order book, leaderboard figures. Always `font-variant-numeric: tabular-nums`.
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
--radius-sm: 4px;   /* inputs, chips */
--radius-md: 6px;   /* buttons, small cards */
--radius-lg: 10px;  /* panels */
--radius-xl: 14px;  /* modals, feature cards */
```

Do not pill everything. Pills only for status badges.

## Elevation

Dark UI leans on border + a one-step background lift over heavy shadows.

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

- **Button:** solid accent (primary), subtle surface-2 (secondary), ghost
  (tertiary). Buy = `--up` tinted, Sell = `--down` tinted, with full borders, not
  side-stripes.
- **Panel:** `--surface`, 1px `--border`, `--radius-lg`, 16px padding, a compact
  header row (label + optional control).
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
