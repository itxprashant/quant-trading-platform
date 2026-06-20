"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, LogOut, Shield } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold">
      <span className="grid size-7 place-items-center rounded-md bg-accent text-accent-fg">
        <Activity className="size-4" />
      </span>
      <span className="text-[15px] tracking-tight">Quanta</span>
    </Link>
  );
}

export function TopBar({ center, className }: { center?: ReactNode; className?: string }) {
  const { user, logout } = useAuth();
  const router = useRouter();

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-bg/80 px-4 backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center gap-6">
        <Brand />
        <nav className="hidden items-center gap-1 text-sm text-muted md:flex">
          <Link href="/" className="rounded-md px-2.5 py-1.5 hover:bg-surface-2 hover:text-text">
            Challenges
          </Link>
          {user?.role === "admin" && (
            <Link
              href="/admin"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 hover:bg-surface-2 hover:text-text"
            >
              <Shield className="size-3.5" /> Admin
            </Link>
          )}
        </nav>
      </div>

      {center && <div className="flex flex-1 justify-center">{center}</div>}

      <div className="flex items-center gap-3">
        {user ? (
          <>
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium leading-tight">{user.displayName}</div>
              <div className="text-xs capitalize text-faint leading-tight">{user.role}</div>
            </div>
            <span className="grid size-8 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
              {user.displayName.slice(0, 2).toUpperCase()}
            </span>
            <Button
              variant="ghost"
              size="sm"
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
          <Button size="sm" onClick={() => router.push("/login")}>
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
