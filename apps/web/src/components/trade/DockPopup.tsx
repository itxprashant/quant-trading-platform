"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Tiny icon that opens a dense panel. Used for the leaderboard (viewport
 * corner) and policy votes (left sidebar).
 */
export function DockPopup({
  label,
  icon,
  badge,
  placement = "top",
  openSignal,
  children,
  className,
}: {
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  placement?: "top" | "end";
  /** Changing to a new truthy value opens the panel (new vote, etc.). */
  openSignal?: string | null;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "relative grid size-8 place-items-center rounded-md border text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          open
            ? "border-accent/40 bg-accent-subtle text-accent"
            : "border-border bg-surface hover:border-border-strong hover:text-text",
        )}
      >
        {icon}
        {badge}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={cn(
            "absolute z-50 w-[min(360px,calc(100vw-1.5rem))]",
            placement === "top" && "bottom-[calc(100%+8px)] left-0",
            placement === "end" && "bottom-0 left-[calc(100%+8px)]",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
