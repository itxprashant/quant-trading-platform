"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { AdminGuard } from "@/components/AdminGuard";
import { ChallengeForm } from "@/components/admin/ChallengeForm";

export default function NewChallengePage() {
  return (
    <AdminGuard>
      <div className="min-h-dvh">
        <TopBar />
        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
          <Link
            href="/admin"
            className="mb-6 inline-flex items-center gap-1 rounded-sm text-xs text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronLeft className="size-3.5" /> Event register
          </Link>
          <header className="mb-6 border-b border-border pb-6">
            <p className="mono mb-2 text-[11px] uppercase tracking-[0.16em] text-muted">
              Event setup
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              New challenge
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted">
              Define the market, set trading limits, and choose how participants
              are scored. Start the session from the event register when you are
              ready.
            </p>
          </header>
          <ChallengeForm />
        </main>
      </div>
    </AdminGuard>
  );
}
