# Quantstorm Design System

Register: **product**, with a more expressive public overview page.
Visual direction: **exchange workbench**.

## Theme

A competitor on a laptop in a dim event hall spends hours scanning price,
inventory, and rank, then makes decisions in short bursts. Dark, opaque warm
graphite surfaces reduce glare; quiet separators and stable layouts keep the
market readable. Vermilion marks actions without competing with buy/sell colors.

This replaces the previous cyan-glass theme. Do not add backdrop glows,
decorative blur, neon borders, or gradient text.

## Color

The source of truth is the Tailwind v4 `@theme` in
`apps/web/src/app/globals.css`. Colors use OKLCH with warm-tinted neutrals.

| Token           | Value                   | Role                       |
| --------------- | ----------------------- | -------------------------- |
| `bg`            | `oklch(0.155 0.006 65)` | Canvas, inputs             |
| `surface`       | `oklch(0.19 0.006 65)`  | Opaque panels              |
| `surface-2`     | `oklch(0.225 0.006 65)` | Toolbar, hover             |
| `surface-3`     | `oklch(0.265 0.006 65)` | Selected neutral           |
| `border`        | `oklch(0.3 0.008 65)`   | Panel boundaries           |
| `border-strong` | `oklch(0.41 0.008 65)`  | Controls, emphasis         |
| `text`          | `oklch(0.945 0.009 80)` | Warm ivory primary         |
| `muted`         | `oklch(0.72 0.01 75)`   | Supporting text            |
| `faint`         | `oklch(0.62 0.01 75)`   | Tertiary text              |
| `accent`        | `oklch(0.745 0.165 40)` | Vermilion action/selection |
| `up`            | `oklch(0.78 0.115 164)` | Buy, gain                  |
| `down`          | `oklch(0.74 0.145 20)`  | Sell, loss                 |
| `warning`       | `oklch(0.82 0.12 85)`   | Paused, warning            |
| `info`          | `oklch(0.77 0.08 245)`  | Scheduled, informational   |

Accent fills have dark foreground text. Selected controls use subtle tinted
backgrounds. Financial signals always include signs or side labels, not color
alone. The chart library uses RGB fallbacks because it cannot parse OKLCH.

## Typography

Retain Geist Sans for its compact, instrument-panel clarity and Geist Mono for
prices, quantities, times, and ranks. All financial values use tabular numerals.
Body: 14px. Controls: 12-14px. Panel headings: 12px. Data: 12-14px.
Page headings: 24-48px, depending on density. Landing display text alone uses a
fluid 52-96px scale with tight tracking. No display fonts in controls.

## Layout

- Shared opaque top navigation with a geometric Q mark and mobile menu.
- Overview: asymmetric introduction and clearly labeled illustrative terminal;
  ruled workspace explanations and two market-discipline diagrams.
- Arena: searchable, filterable event rows with real counts, dates, and status;
  format guidance lives beside the list, not inside every event.
- Trading: three columns on desktop. Left: instrument list and compact
  rankings. Center: depth, portfolio, and ticket share one row; the chart sits
  below and the trader can hide it; then orders, options (series table with a
  docked ticket and book), bonds and ETFs, bank, and votes. Right: the news
  feed, which stays fixed while the center column scrolls. Event timers sit in
  the top bar. New headlines and the premium auction appear as corner cards.
  Below 1280px the news moves into the center column; below 1024px the
  sidebars stack.
- Authentication: split introduction and form, stacked on small screens.
- Organizer: filterable operations table; configuration and live controls are
  separate groups, with a persistent save action.
- Mobile tables scroll inside their own wrappers. Containers use `min-w-0`.

## Components

- Panels: opaque surface, 1px border, 8px corners. No nested decorative cards.
- Primary buttons: solid vermilion; secondary neutral; buy/sell semantic tints.
- Inputs: canvas fill, visible full border, native select affordance.
- Corners: 4px chips, 6px controls, 8px panels, 10px larger containers.
- Rows: subtle hover surface, stable numeric columns, full-width separators.
- Status: compact rectangular badge with explicit text, optional static dot.
- Errors: concise explanation and retry action; no fabricated market data.
- Empty states: explain the next useful action. Loading uses stable skeletons.

## Motion And Access

Use 150-200ms color transitions; real-time value flashes last 400ms. No decorative
loops or page-load choreography. Reduced-motion disables animations and
transitions. Keyboard focus remains visible, selected toggles expose
`aria-pressed`, and menus expose expansion state. Public preview data is explicitly
illustrative. Auth and API behavior are independent of presentation.
