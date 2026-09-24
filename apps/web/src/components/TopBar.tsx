"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, LogOut, Menu, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export function Brand() {
  return (
    <Link
      href="/"
      aria-label="Quantstorm home"
      className="flex shrink-0 items-center gap-2.5"
    >
      <svg
        viewBox="0 0 32 32"
        fill="none"
        className="size-8 text-accent"
        aria-hidden="true"
      >
        <path d="M6 6H23V23H6V6Z" stroke="currentColor" strokeWidth="3" />
        <path
          d="M17 17L29 29M11 11H18V18H11Z"
          stroke="currentColor"
          strokeWidth="3"
        />
      </svg>
      <span className="text-[21px] font-semibold tracking-[-0.06em]">
        quantstorm<span className="text-accent">.</span>
      </span>
    </Link>
  );
}

export function TopBar({
  center,
  fluid = false,
  className,
}: {
  /** Inline between nav and account from 1440px; its own scrollable row below. */
  center?: ReactNode;
  /** Span the full viewport instead of the 1600px content column. */
  fluid?: boolean;
  className?: string;
}) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Sticky page regions offset themselves by `var(--topbar-h)`.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const sync = () =>
      root.style.setProperty("--topbar-h", `${el.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--topbar-h");
    };
  }, []);
  const links = [
    { href: "/challenges", label: "Arena" },
    ...(user?.role === "admin"
      ? [{ href: "/admin", label: "Event control" }]
      : []),
  ];

  return (
    <header
      ref={ref}
      className={cn(
        "sticky top-0 z-30 border-b border-border bg-bg",
        className,
      )}
    >
      <div
        className={cn(
          "mx-auto flex min-h-17 flex-wrap items-center justify-between gap-x-4 px-4 sm:px-8",
          !fluid && "max-w-[1600px]",
        )}
      >
        <div className="flex shrink-0 items-center gap-10">
          <Brand />
          <nav
            aria-label="Main navigation"
            className="hidden items-center gap-6 md:flex"
          >
            <Link
              href="/"
              aria-current={pathname === "/" ? "page" : undefined}
              className={cn(
                "py-5 text-xs transition-colors hover:text-text",
                pathname === "/" ? "text-text" : "text-muted",
              )}
            >
              Overview
            </Link>
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={
                  pathname.startsWith(link.href) ? "page" : undefined
                }
                className={cn(
                  "flex items-center gap-2 py-5 text-xs transition-colors hover:text-text",
                  pathname.startsWith(link.href) ? "text-accent" : "text-muted",
                )}
              >
                {link.label}
                {pathname.startsWith(link.href) && (
                  <span className="size-1 rounded-full bg-accent" />
                )}
              </Link>
            ))}
          </nav>
        </div>
        {center && (
          <div className="flex min-w-0 flex-1 justify-center overflow-x-auto scrollbar-hide empty:hidden max-[1439px]:order-last max-[1439px]:basis-full max-[1439px]:justify-start max-[1439px]:border-t max-[1439px]:border-border max-[1439px]:py-2">
            {center}
          </div>
        )}
        <div className="flex min-w-0 items-center gap-3">
          {user ? (
            <>
              <div className="hidden min-w-0 text-right sm:block">
                <div className="max-w-36 truncate text-xs font-medium">
                  {user.displayName}
                </div>
                <div className="mt-0.5 text-[10px] capitalize text-muted">
                  {user.role} account
                </div>
              </div>
              <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-[10px] font-semibold text-muted">
                {user.displayName.slice(0, 2).toUpperCase()}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 px-2"
                aria-label="Log out"
                onClick={() => {
                  logout();
                  router.push("/");
                }}
              >
                <LogOut className="size-4" />
              </Button>
            </>
          ) : (
            <Link href="/login" className="action-link min-h-9 px-3 sm:px-4">
              Sign in <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          )}
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setMenuOpen(!menuOpen)}
            className="grid size-11 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 md:hidden"
          >
            {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      {menuOpen && (
        <nav
          id="mobile-navigation"
          aria-label="Mobile navigation"
          className="flex flex-wrap gap-2 border-t border-border px-4 py-3 md:hidden"
        >
          {[{ href: "/", label: "Overview" }, ...links].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-4 py-3 text-sm text-muted hover:bg-surface-2 hover:text-text"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
