"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brand } from "@/components/TopBar";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const { login, register } = useAuth();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password, displayName || undefined);
      router.push(next);
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { error?: string })?.error;
        setError(
          code === "invalid_credentials"
            ? "Incorrect username or password."
            : code === "username_taken"
              ? "That username is taken."
              : "Something went wrong. Try again.",
        );
      } else {
        setError("Couldn't reach the server.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        <Panel className="p-6">
          <h1 className="text-lg font-semibold">
            {mode === "login" ? "Sign in" : "Create account"}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {mode === "login"
              ? "Enter your competitor credentials."
              : "Register to join a challenge."}
          </p>

          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            {mode === "register" && (
              <Field label="Display name" hint="Shown on the leaderboard (optional).">
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </Field>
            )}
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
              />
            </Field>

            {error && (
              <div className="rounded-md border border-down/30 bg-down-subtle px-3 py-2 text-sm text-down">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" loading={loading}>
              {mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <button
            className="mt-4 w-full text-center text-sm text-muted hover:text-text"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login"
              ? "Need an account? Register"
              : "Have an account? Sign in"}
          </button>
        </Panel>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
