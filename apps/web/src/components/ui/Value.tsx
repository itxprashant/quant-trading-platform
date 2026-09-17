"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/** A numeric value that briefly flashes up/down when it changes. */
export function FlashValue({
  value,
  className,
  format,
}: {
  value: number;
  className?: string;
  format: (n: number) => string;
}) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<"" | "flash-up" | "flash-down">("");

  useEffect(() => {
    if (value > prev.current) setFlash("flash-up");
    else if (value < prev.current) setFlash("flash-down");
    prev.current = value;
    const t = setTimeout(() => setFlash(""), 500);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <span className={cn("mono rounded-sm px-1", flash, className)}>
      {format(value)}
    </span>
  );
}
