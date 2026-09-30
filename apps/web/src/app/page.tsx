import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Brand, TopBar } from "@/components/TopBar";

const LISTING =
  "https://unstop.com/hackathons/quantstorm-iit-guwahati-1733840";

export const metadata: Metadata = {
  title: "QuantStorm 2026 | Offline finals",
  description:
    "QuantStorm 2026 offline finals at Meluha, The Fern. A live market simulation for qualifiers from the 17 August trading round.",
};

const facts = [
  ["Date", "26 September 2026"],
  ["Venue", "Meluha, The Fern"],
  ["Round", "Offline market simulation"],
  ["Field", "Individual"],
  ["Prize pool", "₹2,50,000"],
] as const;

const rounds = [
  {
    id: "01",
    name: "Trading round",
    when: "17 August",
    where: "Online",
    state: "Closed",
    text: "An algorithmic two-player market game. One bot submission. Rank in this round decided who reached the finals.",
  },
  {
    id: "02",
    name: "Market simulation",
    when: "26 September",
    where: "Meluha, The Fern",
    state: "Today",
    text: "A live trading floor. Conditions change through the session. Speed, judgment, and adapting to the tape decide the result.",
  },
] as const;

const hosts = [
  ["Finance & Economics Club", "IIT Guwahati"],
  ["Quantitative & Algorithmic Trading Club", "IIT Delhi"],
  ["Quant Club", "IIT Bombay"],
] as const;

export default function LandingPage() {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main id="main">
        <section className="mx-auto max-w-[1440px] px-5 pb-14 pt-12 sm:px-10 lg:pb-20 lg:pt-18">
          <div className="grid items-start gap-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
            <div>
              <div className="mb-7 flex items-center gap-3">
                <span className="h-px w-8 bg-accent" />
                <p className="mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  QuantStorm 2026 · Offline finals
                </p>
              </div>
              <h1 className="landing-title">
                The New Eden
                <br />
                <span className="text-muted">Exchange.</span>
              </h1>
              <p className="mt-7 max-w-md text-base leading-relaxed text-muted">
                The live market for QuantStorm finalists. A national
                quant-finance competition, now a trading session: read what
                changes, decide under pressure, and finish on the board.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/login" className="action-link">
                  Sign in <ArrowUpRight className="size-4" />
                </Link>
                <Link href="/challenges" className="action-link action-link-secondary">
                  Open the desk <ArrowUpRight className="size-4" />
                </Link>
              </div>
              <p className="mt-6 max-w-md text-xs leading-relaxed text-faint">
                Undergraduate qualifiers. Individual. Synthetic capital on this
                desk — the account you were issued is the one that trades.
              </p>
            </div>

            <dl className="overflow-hidden rounded-lg border border-border-strong bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-xs font-medium">Finals</span>
                <span className="mono text-[10px] uppercase tracking-wider text-accent">
                  26 Sep
                </span>
              </div>
              {facts.map(([label, value]) => (
                <div
                  key={label}
                  className="grid grid-cols-[7.5rem_1fr] gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="text-sm">{value}</dd>
                </div>
              ))}
              <div className="bg-surface-2 px-4 py-3 text-[11px] leading-relaxed text-muted">
                Listed by IIT Guwahati on{" "}
                <a
                  href={LISTING}
                  target="_blank"
                  rel="noreferrer"
                  className="text-text underline decoration-border-strong underline-offset-2 hover:text-accent"
                >
                  Unstop
                </a>
                . Title sponsors Jane Street and Optiver. Associate sponsor
                Qube Research &amp; Technologies.
              </div>
            </dl>
          </div>
        </section>

        <section className="border-y border-border bg-surface">
          <div className="mx-auto max-w-[1440px] px-5 py-14 sm:px-10 lg:py-20">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <span className="mono text-xs text-accent">01 / THE ROUNDS</span>
                <h2 className="landing-section-title mt-5">
                  Two rounds.
                  <br />
                  One field.
                </h2>
              </div>
              <p className="max-w-sm text-sm leading-relaxed text-muted">
                2,118 registered for the online round. This desk is the offline
                final.
              </p>
            </div>
            <div className="mt-10 grid border-y border-border md:grid-cols-2">
              {rounds.map((round) => (
                <article
                  key={round.id}
                  className="py-8 md:border-r md:pr-10 md:last:border-r-0 md:last:pr-0 md:last:pl-10"
                >
                  <div className="mb-6 flex items-center justify-between gap-3">
                    <span className="mono text-[10px] uppercase tracking-wider text-faint">
                      Round / {round.id}
                    </span>
                    <span
                      className={
                        round.state === "Today"
                          ? "text-xs text-accent"
                          : "text-xs text-muted"
                      }
                    >
                      {round.state}
                    </span>
                  </div>
                  <h3 className="text-2xl font-medium tracking-tight">
                    {round.name}
                  </h3>
                  <p className="mono mt-2 text-[11px] text-muted">
                    {round.when} · {round.where}
                  </p>
                  <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
                    {round.text}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1440px] px-5 py-16 sm:px-10 lg:py-24">
          <span className="mono text-xs text-accent">02 / TODAY&apos;S SESSION</span>
          <h2 className="landing-section-title mt-5">
            A market that
            <br />
            keeps moving.
          </h2>
          <div className="mt-10 divide-y divide-border border-y border-border">
            {[
              [
                "The book",
                "Trade a live order book. Prices, depth, and your inventory update as the session runs.",
              ],
              [
                "The tape",
                "Headlines arrive through the day. Some move the market. Some do not. The difference is yours to read.",
              ],
              [
                "The close",
                "The session ends on a clock. Rankings are the settlement of what you held and the cash you kept.",
              ],
            ].map(([title, text], i) => (
              <div
                key={title}
                className="grid gap-2 py-6 sm:grid-cols-[8rem_1fr] sm:gap-8"
              >
                <span className="mono text-[10px] text-faint">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-base font-medium">{title}</h3>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
                    {text}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-y border-border bg-surface">
          <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-14 sm:px-10 lg:grid-cols-[0.7fr_1.3fr] lg:py-18">
            <div>
              <span className="mono text-xs text-accent">03 / THE HOSTS</span>
              <h2 className="mt-5 text-2xl font-medium tracking-tight">
                Run together.
              </h2>
              <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">
                QuantStorm 2026 is joint. The offline round is on the IIT
                Bombay campus.
              </p>
            </div>
            <ul className="divide-y divide-border border-y border-border">
              {hosts.map(([club, campus]) => (
                <li
                  key={campus}
                  className="flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:justify-between"
                >
                  <span className="text-sm">{club}</span>
                  <span className="mono text-[11px] text-muted">{campus}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto flex max-w-[1440px] flex-col justify-between gap-8 px-5 py-14 sm:px-10 lg:flex-row lg:items-center lg:py-18">
          <div>
            <h2 className="landing-section-title">Take your seat.</h2>
            <p className="mt-4 max-w-md text-sm text-muted">
              Sign in, open the New Eden Exchange, and trade the session.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/login" className="action-link">
              Sign in <ArrowUpRight className="size-4" />
            </Link>
            <a
              href={LISTING}
              target="_blank"
              rel="noreferrer"
              className="action-link action-link-secondary"
            >
              Event listing <ArrowUpRight className="size-4" />
            </a>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-[1440px] flex-col justify-between gap-6 border-t border-border px-5 py-8 sm:flex-row sm:items-center sm:px-10">
        <div className="flex items-center gap-5">
          <Brand />
          <span className="text-xs text-faint">
            QuantStorm 2026 · IIT Bombay
          </span>
        </div>
        <nav aria-label="Footer" className="flex gap-6 text-xs text-muted">
          <Link href="/challenges" className="hover:text-text">
            Desk
          </Link>
          <Link href="/login" className="hover:text-text">
            Sign in
          </Link>
          <a
            href={LISTING}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-text"
          >
            Unstop <ArrowUpRight className="size-3" />
          </a>
        </nav>
      </footer>
    </div>
  );
}
