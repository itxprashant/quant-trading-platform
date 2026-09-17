"use client";

import { useEffect } from "react";
import { useAuth } from "@/lib/auth";

export function Providers({ children }: { children: React.ReactNode }) {
  const hydrate = useAuth((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  return <>{children}</>;
}
