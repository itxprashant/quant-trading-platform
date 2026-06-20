"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { Challenge } from "@qtp/shared";
import { get, post } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { AdminGuard } from "@/components/AdminGuard";
import { ChallengeForm } from "@/components/admin/ChallengeForm";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";

function LiveControls({ challenge }: { challenge: Challenge }) {
  const [symbol, setSymbol] = useState(challenge.config.symbols[0]?.symbol ?? "");
  const [target, setTarget] = useState("100");
  const [speed, setSpeed] = useState("5");
  const [price, setPrice] = useState("100");
  const [msg, setMsg] = useState<string | null>(null);

  async function drift() {
    await post(`/api/admin/${challenge.id}/drift`, {
      symbol,
      target: Number(target),
      speed: Number(speed),
    });
    setMsg(`Drifting ${symbol} → ${target}`);
  }
  async function setHard() {
    await post(`/api/admin/${challenge.id}/price`, { symbol, price: Number(price) });
    setMsg(`Set ${symbol} = ${price}`);
  }

  return (
    <Panel>
      <PanelHeader title="Live price controls" />
      <div className="space-y-4 p-4">
        <Field label="Symbol">
          <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {challenge.config.symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.symbol}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label="Drift target">
            <Input type="number" step="0.01" value={target} onChange={(e) => setTarget(e.target.value)} className="mono" />
          </Field>
          <Field label="Speed (1-10)">
            <Input type="number" min={1} max={10} value={speed} onChange={(e) => setSpeed(e.target.value)} className="mono" />
          </Field>
          <Button variant="secondary" onClick={drift}>Drift</Button>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Hard set price">
            <Input type="number" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="mono" />
          </Field>
          <Button variant="secondary" onClick={setHard}>Set</Button>
        </div>
        {msg && <p className="text-xs text-up">{msg}</p>}
      </div>
    </Panel>
  );
}

function EditInner() {
  const { id } = useParams<{ id: string }>();
  const [challenge, setChallenge] = useState<Challenge | null>(null);

  useEffect(() => {
    get<Challenge>(`/api/challenges/${id}`).then(setChallenge).catch(() => {});
  }, [id]);

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/admin" className="mb-4 flex items-center gap-1 text-sm text-muted hover:text-text">
          <ChevronLeft className="size-4" /> Admin
        </Link>
        {!challenge ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64" />
          </div>
        ) : (
          <>
            <h1 className="mb-6 text-xl font-semibold tracking-tight">{challenge.name}</h1>
            {(challenge.status === "live" || challenge.status === "paused") && (
              <div className="mb-4">
                <LiveControls challenge={challenge} />
              </div>
            )}
            <ChallengeForm existing={challenge} />
          </>
        )}
      </main>
    </div>
  );
}

export default function EditChallengePage() {
  return (
    <AdminGuard>
      <EditInner />
    </AdminGuard>
  );
}
