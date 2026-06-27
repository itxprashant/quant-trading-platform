import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Gauge,
  Layers,
  LineChart,
  Radio,
  Settings2,
  ShieldCheck,
  Trophy,
  TrendingUp,
} from "lucide-react";
import { TopBar } from "@/components/TopBar";

const TICKER = [
  { sym: "AER", px: "1,184.50", chg: "+2.41%", up: true },
  { sym: "NRC", px: "642.18", chg: "+5.07%", up: true },
  { sym: "ORB", px: "2,910.00", chg: "-1.18%", up: false },
  { sym: "VOL", px: "88.42", chg: "+0.94%", up: true },
  { sym: "CBT", px: "417.65", chg: "-3.22%", up: false },
  { sym: "QSI", px: "73.10", chg: "+1.55%", up: true },
  { sym: "HLX", px: "1,002.30", chg: "+4.10%", up: true },
  { sym: "ZPE", px: "55.77", chg: "-2.64%", up: false },
];

function TickerTape() {
  const row = [...TICKER, ...TICKER];
  return (
    <div className="lp-ticker border-y border-border bg-surface backdrop-blur-xl">
      <div className="lp-ticker-track py-2.5">
        {row.map((t, i) => (
          <span
            key={i}
            className="mx-5 inline-flex items-center gap-2 text-sm tabular-nums"
          >
            <span className="font-semibold tracking-tight">{t.sym}</span>
            <span className="mono text-muted">{t.px}</span>
            <span className={t.up ? "mono text-up" : "mono text-down"}>
              {t.chg}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Static "trading terminal" mock used as hero imagery (product screenshot). */
function TerminalMock() {
  const bids = [
    { p: "1,184.50", q: 42, w: 100 },
    { p: "1,184.25", q: 31, w: 74 },
    { p: "1,184.00", q: 18, w: 46 },
  ];
  const asks = [
    { p: "1,184.75", q: 25, w: 60 },
    { p: "1,185.00", q: 37, w: 88 },
    { p: "1,185.25", q: 14, w: 38 },
  ];
  const board = [
    { r: 1, n: "delta_one", v: "+48,210" },
    { r: 2, n: "mm_kappa", v: "+39,884" },
    { r: 3, n: "you", v: "+31,507", me: true },
  ];
  return (
    <div className="rounded-xl border border-border bg-surface p-3 shadow-[0_24px_80px_-20px_rgba(6,182,212,0.25)] backdrop-blur-xl">
      {/* header */}
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight">AER</span>
          <span className="text-xs text-muted">Aerium</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="mono text-sm font-semibold tabular-nums">1,184.50</span>
          <span className="mono text-xs text-up">+2.41%</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-up/30 bg-up-subtle px-1.5 py-0.5 text-[10px] font-medium text-up">
            <span className="size-1.5 rounded-full bg-up motion-safe:animate-pulse" />
            LIVE
          </span>
        </div>
      </div>

      {/* chart */}
      <div className="relative h-28 overflow-hidden rounded-lg border border-border bg-bg/40">
        <svg
          viewBox="0 0 300 110"
          preserveAspectRatio="none"
          className="h-full w-full"
          aria-hidden
        >
          <defs>
            <linearGradient id="lp-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0,82 L30,76 L60,84 L90,60 L120,66 L150,44 L180,52 L210,30 L240,38 L270,18 L300,24 L300,110 L0,110 Z"
            fill="url(#lp-area)"
          />
          <path
            d="M0,82 L30,76 L60,84 L90,60 L120,66 L150,44 L180,52 L210,30 L240,38 L270,18 L300,24"
            fill="none"
            stroke="#22d3ee"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* book + board */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-bg/40 p-2">
          <div className="px-1 pb-1.5 text-[10px] uppercase tracking-wide text-faint">
            Order book
          </div>
          {asks.map((a) => (
            <div key={a.p} className="relative grid grid-cols-2 px-1 py-[3px] text-xs">
              <span
                className="absolute inset-y-0 left-0 bg-down-subtle"
                style={{ width: `${a.w}%`, opacity: 0.5 }}
              />
              <span className="relative z-10 mono text-muted">{a.q}</span>
              <span className="relative z-10 mono text-right text-down">{a.p}</span>
            </div>
          ))}
          {bids.map((b) => (
            <div key={b.p} className="relative grid grid-cols-2 px-1 py-[3px] text-xs">
              <span
                className="absolute inset-y-0 right-0 bg-up-subtle"
                style={{ width: `${b.w}%`, opacity: 0.5 }}
              />
              <span className="relative z-10 mono text-up">{b.p}</span>
              <span className="relative z-10 mono text-right text-muted">{b.q}</span>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-border bg-bg/40 p-2">
          <div className="px-1 pb-1.5 text-[10px] uppercase tracking-wide text-faint">
            Leaderboard
          </div>
          {board.map((e) => (
            <div
              key={e.r}
              className={
                "flex items-center justify-between rounded px-1 py-[5px] text-xs " +
                (e.me ? "bg-accent-subtle/50" : "")
              }
            >
              <span className="flex items-center gap-2">
                <span className="mono w-4 text-center text-faint">{e.r}</span>
                <span className={e.me ? "font-semibold text-accent" : ""}>{e.n}</span>
              </span>
              <span className="mono text-up">{e.v}</span>
            </div>
          ))}
          <div className="mt-1.5 border-t border-border px-1 pt-1.5 text-[10px] text-faint">
            312 traders · scoring live
          </div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="relative mx-auto max-w-6xl px-4 pt-16 pb-12 sm:pt-24">
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
        <div>
          <span
            className="lp-reveal inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-subtle px-3 py-1 text-xs font-medium text-accent"
            style={{ animationDelay: "40ms" }}
          >
            <Radio className="size-3.5" />
            Competitive quant trading, in real time
          </span>

          <h1
            className="lp-reveal mt-6 text-[clamp(2.6rem,7vw,5rem)] font-semibold leading-[0.98] tracking-tight"
            style={{ animationDelay: "120ms" }}
          >
            Trade the move.
            <br />
            <span className="text-accent">Own the board.</span>
          </h1>

          <p
            className="lp-reveal mt-6 max-w-xl text-base leading-relaxed text-muted sm:text-lg"
            style={{ animationDelay: "200ms" }}
          >
            Quanta runs live market-making duels and directional PnL races on
            synthetic instruments. Read the book, fade the noise, hunt
            mispricings, and climb a leaderboard that updates on every fill.
          </p>

          <div
            className="lp-reveal mt-8 flex flex-wrap items-center gap-3"
            style={{ animationDelay: "280ms" }}
          >
            <Link
              href="/challenges"
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
            >
              Browse challenges
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="#how"
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface-2 px-5 text-sm font-medium text-text transition-colors hover:border-accent/40"
            >
              How it works
            </Link>
          </div>

          <dl className="lp-reveal mt-10 flex gap-8" style={{ animationDelay: "360ms" }}>
            {[
              { k: "Sub-second", v: "fills + book" },
              { k: "2", v: "contest formats" },
              { k: "Live", v: "leaderboard" },
            ].map((s) => (
              <div key={s.k}>
                <dt className="mono text-xl font-semibold tabular-nums">{s.k}</dt>
                <dd className="text-xs text-faint">{s.v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="lp-reveal" style={{ animationDelay: "240ms" }}>
          <TerminalMock />
        </div>
      </div>
    </section>
  );
}

function Formats() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <div className="max-w-2xl">
        <h2 className="text-[clamp(1.8rem,4vw,2.6rem)] font-semibold tracking-tight">
          Two ways to compete
        </h2>
        <p className="mt-3 text-muted">
          Every event picks a discipline. Organizers tune the symbols, limits,
          and scoring; you bring the edge.
        </p>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-6 backdrop-blur-xl transition-colors hover:border-accent/40">
          <span className="grid size-10 place-items-center rounded-lg border border-info/30 bg-info/10 text-info">
            <Layers className="size-5" />
          </span>
          <h3 className="mt-4 text-lg font-semibold">Market making</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Quote both sides, capture the spread, and manage inventory while bots
            and humans hit your orders. Scored on spread capture, quote uptime,
            and risk.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-muted">
            {["Two-sided quoting", "Inventory + risk limits", "Spread-capture scoring"].map(
              (f) => (
                <li key={f} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-info" />
                  {f}
                </li>
              ),
            )}
          </ul>
        </div>

        <div className="rounded-xl border border-border bg-surface p-6 backdrop-blur-xl transition-colors hover:border-accent/40">
          <span className="grid size-10 place-items-center rounded-lg border border-accent/30 bg-accent-subtle text-accent">
            <TrendingUp className="size-5" />
          </span>
          <h3 className="mt-4 text-lg font-semibold">Directional</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Take a view and trade it. Parse the news feed for signal versus noise,
            time your entries, and let realized PnL decide the ranking.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-muted">
            {["Signal vs noise feed", "Long / short freely", "Pure PnL leaderboard"].map(
              (f) => (
                <li key={f} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-accent" />
                  {f}
                </li>
              ),
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    { n: "01", t: "Enroll", d: "Pick a live or scheduled event and join with one click. You start with a fresh cash balance." },
    { n: "02", t: "Trade live", d: "Place limit and market orders against a real matching engine, bots, and other competitors." },
    { n: "03", t: "Get scored", d: "A worker recomputes PnL and market-making metrics continuously from your positions." },
    { n: "04", t: "Climb", d: "Watch your rank move on every fill. Hold your edge to the close to take the board." },
  ];
  return (
    <section id="how" className="border-y border-border bg-surface/60 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-[clamp(1.8rem,4vw,2.6rem)] font-semibold tracking-tight">
          How a challenge runs
        </h2>
        <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s) => (
            <div key={s.n} className="bg-bg p-6">
              <div className="mono text-3xl font-semibold text-accent tabular-nums">
                {s.n}
              </div>
              <h3 className="mt-3 font-semibold">{s.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Features() {
  const items = [
    {
      icon: Gauge,
      t: "Real matching engine",
      d: "Price-time priority order books with sub-second fills, per-challenge isolation, and a single authoritative writer.",
      wide: true,
    },
    { icon: Trophy, t: "Live leaderboard", d: "Rankings recompute continuously and stream to every client." },
    { icon: Bot, t: "Liquidity bots", d: "Market makers and noise traders keep markets alive to trade against." },
    { icon: LineChart, t: "Charts + depth", d: "Candles, line, and a live order-book ladder built for speed." },
    { icon: ShieldCheck, t: "Risk + rate limits", d: "Position caps, order throttles, and margin rules keep it fair." },
    {
      icon: Settings2,
      t: "Organizer console",
      d: "Spin up an event in minutes: symbols, limits, scoring, schedule, and live price + news controls.",
      wide: true,
    },
  ];
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <div className="max-w-2xl">
        <h2 className="text-[clamp(1.8rem,4vw,2.6rem)] font-semibold tracking-tight">
          Built like a real exchange
        </h2>
        <p className="mt-3 text-muted">
          The same primitives a trading desk relies on, packaged for a timed
          contest.
        </p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ icon: Icon, t, d, wide }) => (
          <div
            key={t}
            className={
              "rounded-xl border border-border bg-surface p-5 backdrop-blur-xl transition-colors hover:border-accent/40 " +
              (wide ? "sm:col-span-2 lg:col-span-2" : "")
            }
          >
            <span className="grid size-9 place-items-center rounded-lg border border-border bg-surface-2 text-accent">
              <Icon className="size-4.5" />
            </span>
            <h3 className="mt-3 font-semibold">{t}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-border">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 50% 120%, rgba(34,211,238,0.22) 0%, transparent 60%)",
        }}
        aria-hidden
      />
      <div className="relative mx-auto max-w-3xl px-4 py-24 text-center">
        <h2 className="text-[clamp(2rem,5vw,3.4rem)] font-semibold leading-tight tracking-tight">
          Ready to make markets?
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-muted">
          Join a live challenge or warm up on a scheduled one. Bring the edge,
          the board does the rest.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/challenges"
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
          >
            Browse live challenges
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/login"
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-surface-2 px-5 text-sm font-medium text-text transition-colors hover:border-accent/40"
          >
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-md border border-accent/30 bg-accent-subtle text-accent">
            <TrendingUp className="size-3.5" />
          </span>
          <span className="font-semibold text-text">Quanta</span>
          <span className="text-faint">· competitive quant trading</span>
        </div>
        <nav className="flex items-center gap-5">
          <Link href="/challenges" className="hover:text-accent">
            Challenges
          </Link>
          <Link href="/login" className="hover:text-accent">
            Sign in
          </Link>
          <a
            href="https://github.com/itxprashant/quant-trading-platform"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-accent"
          >
            GitHub <ArrowUpRight className="size-3.5" />
          </a>
        </nav>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main id="main">
        <Hero />
        <TickerTape />
        <Formats />
        <HowItWorks />
        <Features />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
