import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Crosshair,
  MoveUpRight,
} from "lucide-react";
import { Brand, TopBar } from "@/components/TopBar";

const candles: [number, number, number, number, number][] = [
  [18, 163, 192, 148, 204],
  [38, 158, 174, 150, 185],
  [58, 165, 190, 158, 207],
  [78, 171, 196, 163, 207],
  [98, 144, 180, 129, 191],
  [118, 134, 153, 119, 163],
  [138, 144, 163, 132, 173],
  [158, 118, 148, 104, 158],
  [178, 110, 128, 98, 139],
  [198, 122, 143, 112, 154],
  [218, 111, 136, 101, 149],
  [238, 86, 122, 76, 134],
  [258, 81, 101, 66, 112],
  [278, 88, 119, 78, 131],
  [298, 91, 109, 79, 119],
  [318, 69, 99, 57, 107],
  [338, 56, 78, 42, 90],
  [358, 61, 86, 49, 98],
  [378, 47, 74, 33, 83],
  [398, 40, 58, 28, 70],
  [418, 49, 71, 37, 82],
  [438, 38, 61, 24, 73],
];

function ExchangePreview() {
  return (
    <figure className="relative min-w-0 lg:-mr-3">
      <div className="mb-3 flex items-center justify-between text-[10px] text-muted">
        <span className="mono uppercase tracking-[0.14em]">
          Inside the exchange
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-accent" /> Interface preview
        </span>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-[0_28px_70px_-24px_rgba(0,0,0,0.65)]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Crosshair className="size-3.5 text-accent" />
            <span className="text-xs font-medium">Trading desk</span>
          </div>
          <span className="mono text-[10px] text-muted">SESSION / 001</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 pt-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">AER</span>
              <span className="text-xs text-muted">Aerium</span>
            </div>
            <p className="mono mt-1 text-[10px] text-faint">SYNTHETIC / SPOT</p>
          </div>
          <div className="text-right">
            <p className="mono text-2xl tracking-tight">1,184.50</p>
            <p className="mono text-[11px] text-up">+27.90 (+2.41%)</p>
          </div>
        </div>
        <div className="relative mt-5 px-4">
          <svg
            viewBox="0 0 510 265"
            className="h-auto w-full"
            role="img"
            aria-label="Illustrative candlestick chart showing Aerium rising during a session"
          >
            {[40, 95, 150, 205].map((y, i) => (
              <g key={y}>
                <path
                  d={`M0 ${y}H452`}
                  className="stroke-border"
                  strokeDasharray="2 5"
                />
                <text
                  x="462"
                  y={y + 3}
                  fill="currentColor"
                  className="mono text-[9px] text-faint"
                >
                  {(1190 - i * 15).toFixed(0)}
                </text>
              </g>
            ))}
            {candles.map(([x, top, bottom, high, low], i) => (
              <g
                key={x}
                className={i % 4 === 2 || i % 5 === 3 ? "text-down" : "text-up"}
              >
                <path d={`M${x} ${high}V${low}`} stroke="currentColor" />
                <rect
                  x={x - 4}
                  y={top}
                  width="8"
                  height={bottom - top}
                  fill="currentColor"
                  rx="0.8"
                />
                <rect
                  x={x - 4}
                  y={249 - (bottom - top) * 0.7}
                  width="8"
                  height={(bottom - top) * 0.7}
                  fill="currentColor"
                  opacity="0.23"
                />
              </g>
            ))}
            <path
              d="M0 50H452"
              className="stroke-accent"
              strokeDasharray="4 4"
              opacity="0.65"
            />
            <rect
              x="455"
              y="42"
              width="53"
              height="16"
              rx="2"
              className="fill-accent"
            />
            <text x="458" y="53" className="mono fill-accent-fg text-[8px]">
              1,184.50
            </text>
            <text
              x="12"
              y="263"
              fill="currentColor"
              className="mono text-[9px] text-faint"
            >
              09:30
            </text>
            <text
              x="207"
              y="263"
              fill="currentColor"
              className="mono text-[9px] text-faint"
            >
              10:00
            </text>
            <text
              x="416"
              y="263"
              fill="currentColor"
              className="mono text-[9px] text-faint"
            >
              10:30
            </text>
          </svg>
        </div>
        <div className="mt-4 grid grid-cols-2 divide-x divide-border border-t border-border">
          <div className="min-w-0 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[11px] text-muted">Market depth</h3>
              <span className="mono text-[9px] text-faint">QTY / PX</span>
            </div>
            {[
              ["1,184.75", "25", false],
              ["1,184.50", "42", true],
              ["1,184.25", "31", true],
            ].map(([price, qty, up], i) => (
              <div
                key={String(price)}
                className="relative mb-1 flex justify-between px-1.5 py-1 text-[10px] sm:text-xs"
              >
                <span
                  className={`absolute inset-y-0 right-0 ${up ? "bg-up-subtle" : "bg-down-subtle"}`}
                  style={{ width: `${60 + i * 15}%` }}
                />
                <span
                  className={`mono relative ${up ? "text-up" : "text-down"}`}
                >
                  {price}
                </span>
                <span className="mono relative text-muted">{qty}</span>
              </div>
            ))}
          </div>
          <div className="min-w-0 p-4">
            <h3 className="mb-3 text-[11px] text-muted">Session standings</h3>
            {[
              ["01", "delta_one", "+8.42%"],
              ["02", "mm_kappa", "+6.18%"],
              ["03", "you", "+5.73%"],
            ].map(([rank, name, pnl]) => (
              <div
                key={rank}
                className={`mb-1 flex items-center gap-2 py-1 text-[10px] sm:text-xs ${name === "you" ? "text-accent" : "text-muted"}`}
              >
                <span className="mono text-faint">{rank}</span>
                <span className="truncate">{name}</span>
                <span className="mono ml-auto text-up">{pnl}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border bg-surface-2 px-4 py-2 text-[9px] text-muted">
          <span className="mono">PRICE-TIME PRIORITY</span>
          <span>Synthetic instruments. Illustrated data.</span>
        </div>
      </div>
      <figcaption className="mt-4 flex items-center gap-2 text-xs text-muted">
        <span className="h-px w-6 bg-border-strong" />
        The book, the market, and your next move. One workspace.
      </figcaption>
    </figure>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main id="main">
        <section className="mx-auto max-w-[1440px] px-5 pb-14 pt-12 sm:px-10 lg:pb-20 lg:pt-18">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
            <div>
              <div className="mb-7 flex items-center gap-3">
                <span className="h-px w-8 bg-accent" />
                <p className="mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  The competitive trading exchange
                </p>
              </div>
              <h1 className="landing-title">
                Find your edge.
                <br />
                <span className="text-muted">Trade it.</span>
              </h1>
              <p className="mt-7 max-w-[380px] text-base leading-relaxed text-muted">
                A live market. A level playing field. Put your strategy to the
                test against traders, not a backtest.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/challenges" className="action-link">
                  Enter the arena <ArrowUpRight className="size-4" />
                </Link>
                <Link
                  href="#the-desk"
                  className="action-link action-link-secondary"
                >
                  Explore the desk <ArrowDown className="size-3.5" />
                </Link>
              </div>
              <p className="mt-6 text-xs text-faint">
                Synthetic capital. Real competition. No deposit required.
              </p>
              <div className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-5 text-[10px] text-muted">
                <span className="mono uppercase tracking-wider">
                  Built for the session
                </span>
                <span>Live order books</span>
                <span>Continuous rankings</span>
              </div>
            </div>
            <ExchangePreview />
          </div>
        </section>

        <section id="the-desk" className="border-y border-border bg-surface">
          <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-14 sm:px-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-24 lg:py-20">
            <div>
              <span className="mono text-xs text-accent">
                01 / THE WORKSPACE
              </span>
              <h2 className="landing-section-title mt-5">
                Less noise.
                <br />
                More signal.
              </h2>
              <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted">
                Everything you need to read the market and act. Nothing between
                the decision and the order.
              </p>
              <Link
                href="/challenges"
                className="mt-7 inline-flex min-h-11 items-center gap-3 text-sm font-medium hover:text-accent"
              >
                Find a challenge <ArrowRight className="size-4" />
              </Link>
            </div>
            <div className="divide-y divide-border border-y border-border">
              {[
                [
                  "Read the market",
                  "Live charts, two-sided depth, and a news feed. See the information that moves your next trade.",
                  "01",
                ],
                [
                  "Make your move",
                  "Market and limit orders against a price-time priority matching engine. Every order has its place.",
                  "02",
                ],
                [
                  "Know where you stand",
                  "Positions, exposure, and PnL alongside the live leaderboard. Keep your performance in perspective.",
                  "03",
                ],
              ].map(([title, text, number]) => (
                <div
                  key={title}
                  className="grid grid-cols-[32px_1fr] gap-4 py-6 sm:grid-cols-[32px_170px_1fr]"
                >
                  <span className="mono pt-1 text-[10px] text-faint">
                    {number}
                  </span>
                  <h3 className="text-base font-medium">{title}</h3>
                  <p className="col-start-2 max-w-md text-sm leading-relaxed text-muted sm:col-start-auto">
                    {text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1440px] px-5 py-16 sm:px-10 lg:py-24">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <h2 className="landing-section-title">
              Different markets.
              <br />
              Same conviction.
            </h2>
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              Choose your discipline. Each event brings its own instruments,
              rules, and way to win.
            </p>
          </div>
          <div className="mt-10 grid border-y border-border md:grid-cols-2">
            <article className="relative overflow-hidden py-8 md:border-r md:pr-10">
              <div className="mb-8 flex items-center justify-between">
                <span className="mono text-[10px] uppercase tracking-wider text-faint">
                  Discipline / 01
                </span>
                <span className="text-xs text-up">Two-sided thinking</span>
              </div>
              <svg
                viewBox="0 0 420 110"
                className="mb-8 h-28 w-full"
                aria-hidden="true"
              >
                <path
                  d="M0 90H420M210 0V110"
                  className="stroke-border"
                  strokeDasharray="3 5"
                />
                <path
                  d="M0 12H35V25H76V41H120V58H156V76H190V90H205"
                  fill="none"
                  className="stroke-up"
                  strokeWidth="2"
                />
                <path
                  d="M215 90H231V76H265V57H302V40H345V24H387V10H420"
                  fill="none"
                  className="stroke-down"
                  strokeWidth="2"
                />
              </svg>
              <h3 className="text-2xl font-medium tracking-tight">
                Make the market.
              </h3>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
                Quote both sides. Capture the spread. Balance your inventory as
                the market trades against you.
              </p>
              <div className="mt-6 flex flex-wrap gap-3 text-[10px] text-muted">
                <span className="rounded-sm border border-border px-2 py-1">
                  Market making
                </span>
                <span className="py-1">
                  Spread capture / Quote uptime / Risk
                </span>
              </div>
            </article>
            <article className="border-t border-border py-8 md:border-t-0 md:pl-10">
              <div className="mb-8 flex items-center justify-between">
                <span className="mono text-[10px] uppercase tracking-wider text-faint">
                  Discipline / 02
                </span>
                <span className="text-xs text-accent">A view worth taking</span>
              </div>
              <svg
                viewBox="0 0 420 110"
                className="mb-8 h-28 w-full"
                aria-hidden="true"
              >
                <path
                  d="M0 90H420M210 0V110"
                  className="stroke-border"
                  strokeDasharray="3 5"
                />
                <path
                  d="M0 86L25 77L46 85L72 60L98 69L119 55L142 64L166 33L190 41L215 55L239 40L263 47L289 20L313 28L337 13L361 26L388 9L420 15"
                  fill="none"
                  className="stroke-accent"
                  strokeWidth="2"
                />
              </svg>
              <h3 className="text-2xl font-medium tracking-tight">
                Trade your thesis.
              </h3>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
                Separate signal from noise. Build a position, time your exit,
                and let your profit and loss speak.
              </p>
              <div className="mt-6 flex flex-wrap gap-3 text-[10px] text-muted">
                <span className="rounded-sm border border-border px-2 py-1">
                  Directional
                </span>
                <span className="py-1">Price action / Positions / PnL</span>
              </div>
            </article>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 text-xs text-muted">
            <p>
              And evolving economies in New Eden, with options, auctions, and
              live events.
            </p>
            <Link
              href="/challenges"
              className="inline-flex min-h-11 items-center gap-2 text-text hover:text-accent"
            >
              Explore all events <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
        </section>

        <section className="border-y border-border bg-surface">
          <div className="mx-auto flex max-w-[1440px] flex-col justify-between gap-8 px-5 py-14 sm:px-10 lg:flex-row lg:items-center lg:py-18">
            <div className="flex items-start gap-5">
              <MoveUpRight className="mt-2 hidden size-12 text-accent sm:block" />
              <div>
                <h2 className="landing-section-title">
                  Your next move is live.
                </h2>
                <p className="mt-4 text-sm text-muted">
                  Find an event. Take a seat. See what your strategy can do.
                </p>
              </div>
            </div>
            <Link
              href="/challenges"
              className="action-link self-start lg:self-auto"
            >
              Browse challenges <ArrowUpRight className="size-4" />
            </Link>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-[1440px] flex-col justify-between gap-6 px-5 py-8 sm:flex-row sm:items-center sm:px-10">
        <div className="flex items-center gap-5">
          <Brand />
          <span className="text-xs text-faint">
            Synthetic markets. Real decisions.
          </span>
        </div>
        <nav aria-label="Footer" className="flex gap-6 text-xs text-muted">
          <Link href="/challenges" className="hover:text-text">
            Arena
          </Link>
          <Link href="/login" className="hover:text-text">
            Sign in
          </Link>
          <a
            href="https://github.com/itxprashant/quant-trading-platform"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-text"
          >
            GitHub <ArrowUpRight className="size-3" />
          </a>
        </nav>
      </footer>
    </div>
  );
}
