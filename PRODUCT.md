# PRODUCT.md — Quanta

> Product context for the impeccable design workflow. Register: **product**.

## Product Purpose

Quanta is a platform for running competitive quantitative trading challenges:
market-making contests, directional PnL races, and admin-configurable formats.
Organizers spin up events; hundreds to thousands of participants trade synthetic
instruments in real time and are ranked on a live leaderboard. The product must
feel like a serious trading terminal, not a toy: fast, dense, legible under
pressure, and trustworthy with money-shaped numbers.

## Register

`register: product`

Design **serves** the task. The interface should disappear into focused trading.
Earned familiarity over novelty: a competitor who knows TradingView or a broker
terminal should feel at home within seconds.

## Users

- **Competitor (primary).** A student or quant-curious participant in a timed
  event. Often on a laptop, sometimes a second monitor, in a noisy hall or a
  dim room during a multi-hour session. State of mind: focused, time-pressured,
  competitive. Glances constantly at price, their position, PnL, and rank.
  Acts in bursts: read the book, place/cancel orders, re-read.
- **Organizer / Admin (secondary).** Runs the event. Creates and configures
  challenges (symbols, limits, scoring, schedule), starts/pauses/ends them,
  monitors participants, intervenes on prices. Wants control and confidence,
  not surprises.

## Success

- A competitor can read the market and act (place or cancel an order) in under
  two seconds, without hunting for controls.
- Real-time updates (price, book, fills, PnL, rank) feel instantaneous and never
  jump or flicker distractingly.
- An organizer can stand up a new challenge and take it live in a few minutes.
- Nothing about the interface reads as "AI generated" or as a generic SaaS
  template. It reads as a purpose-built trading product.

## Brand & Tone

Precise, calm, confident. Numbers are the heroes. Copy is terse and functional
(buttons say what they do; errors say what happened and what to do). No hype, no
exclamation marks, no emoji in the UI.

## Anti-references (what to avoid)

- The trading cliché: pure black background with neon lime-green / fire-red
  candles and glowing borders. Garish, fatiguing, and generic.
- Crypto-bro aesthetics: gradients-on-everything, glassmorphism, 3D coins.
- Generic SaaS: cream background, rounded-everything, identical icon+heading+text
  card grids, a hero metric with a gradient number.
- Bloomberg's literal amber-on-black density without modern legibility.

## Strategic Principles

1. **Data first, chrome last.** Maximize signal (prices, depth, PnL, rank);
   minimize decorative surface.
2. **Stable layout.** Real-time values update in place; the grid never reflows on
   a tick. Numbers are tabular and right-aligned.
3. **Direction without garishness.** Up/down is communicated with restrained,
   accessible semantic colors plus sign and motion, never neon.
4. **Density is a feature.** Order books, ladders, and leaderboards can be dense
   when the user needs them; whitespace is used for grouping, not padding theater.
5. **One accent, used with intent.** A single distinctive accent marks primary
   actions and the current selection. Semantic up/down is its own vocabulary.

## Anchor References

- **Linear** — product craft, restraint, keyboard-first speed, state coverage.
- **TradingView** — chart legibility and information density done well.
- **Stripe Dashboard** — trustworthy numbers, calm hierarchy, clear tables.
