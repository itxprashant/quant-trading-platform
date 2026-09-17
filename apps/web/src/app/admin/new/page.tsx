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
        <main className="mx-auto max-w-3xl px-4 py-8">
          <Link href="/admin" className="mb-4 flex items-center gap-1 text-sm text-muted hover:text-text">
            <ChevronLeft className="size-4" /> Admin
          </Link>
          <h1 className="mb-6 text-xl font-semibold tracking-tight">New challenge</h1>
          <ChallengeForm />
        </main>
      </div>
    </AdminGuard>
  );
}
