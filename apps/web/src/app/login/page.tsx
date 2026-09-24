"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Brand } from "@/components/TopBar";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Input";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password, email, displayName || undefined);

      // Normalize before navigating: browsers treat backslashes and // as URL hosts.
      let next = "/challenges";
      const requested = params.get("next");
      if (
        requested?.startsWith("/") &&
        !requested.startsWith("//") &&
        !/[\\\u0000-\u0020]/.test(requested)
      ) {
        const destination = new URL(requested, window.location.origin);
        if (
          destination.origin === window.location.origin &&
          !destination.pathname.startsWith("//")
        ) {
          next = `${destination.pathname}${destination.search}${destination.hash}`;
        }
      }
      router.push(next);
    } catch (err) {
      if (err instanceof ApiError) {
        const code = (err.body as { error?: string })?.error;
        setError(
          code === "invalid_credentials"
            ? "Incorrect username or password. Try again."
            : code === "username_taken"
              ? "That username is taken. Choose another."
              : code === "validation_error"
                ? "Check your username, email and password."
                : "Something went wrong. Try again.",
        );
      } else {
        setError(
          "Couldn't reach the server. Check your connection and try again.",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-dvh bg-bg">
      <header className="flex min-h-20 items-center justify-between gap-4 border-b border-border px-5 sm:px-10">
        <Brand />
        <Link
          href="/challenges"
          className="flex min-h-11 items-center gap-2 text-xs text-muted transition-colors hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Browse events
        </Link>
      </header>
      <main
        id="main"
        className="mx-auto grid max-w-[1600px] lg:min-h-[calc(100dvh-80px)] lg:grid-cols-[1.1fr_1fr]"
      >
        <section
          aria-labelledby="welcome-heading"
          className="flex flex-col justify-between border-b border-border bg-surface px-6 py-9 sm:px-12 lg:border-b-0 lg:border-r lg:px-16 lg:py-14"
        >
          <div>
            <p className="mono text-xs uppercase tracking-[0.16em] text-muted">
              The Quantstorm exchange
            </p>
            <h2
              id="welcome-heading"
              className="mt-7 text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl lg:mt-14 lg:text-6xl"
            >
              Every decision.
              <br />
              <span className="text-muted">On the record.</span>
            </h2>
            <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted">
              A market to read. A position to take. A field to compete against.
              Your next session starts here.
            </p>
          </div>

          <figure className="my-12 hidden max-w-lg lg:block">
            <div className="mono mb-4 flex justify-between text-[10px] uppercase tracking-wider">
              <span className="text-up">Bid / Buy side</span>
              <span className="text-down">Ask / Sell side</span>
            </div>
            <svg
              viewBox="0 0 480 160"
              fill="none"
              className="w-full"
              aria-hidden="true"
            >
              {[20, 60, 100, 140].map((y) => (
                <path key={y} d={`M0 ${y}H480`} className="stroke-border" />
              ))}
              {[80, 160, 240, 320, 400].map((x) => (
                <path key={x} d={`M${x} 0V160`} className="stroke-border" />
              ))}
              <path
                d="M0 25H36V42H76V56H115V76H150V91H181V110H210V134H230"
                className="stroke-up"
                strokeWidth="2"
              />
              <path
                d="M250 134H270V111H302V92H331V74H366V54H402V39H444V20H480"
                className="stroke-down"
                strokeWidth="2"
              />
              <path
                d="M240 0V160"
                className="stroke-muted"
                strokeDasharray="3 5"
              />
            </svg>
            <figcaption className="mono mt-4 flex justify-between border-t border-border pt-3 text-[10px] uppercase tracking-wider text-faint">
              <span>Market depth / Schematic</span>
              <span>Not live data</span>
            </figcaption>
          </figure>
          <p className="mono mt-7 text-[10px] uppercase tracking-wider text-muted">
            Synthetic markets. Real decisions.
          </p>
        </section>

        <section
          aria-labelledby="login-heading"
          className="flex items-center px-6 py-10 sm:px-12 lg:px-16 lg:py-14"
        >
          <div className="mx-auto w-full max-w-md">
            <p className="mono mb-3 text-xs uppercase tracking-wider text-muted">
              Trader access
            </p>
            <h1
              id="login-heading"
              className="text-3xl font-semibold tracking-tight"
            >
              {mode === "login" ? "Back to the desk." : "Take your place."}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {mode === "login"
                ? "Sign in to join a challenge or pick up your session."
                : "Create an account to enter the arena and join a challenge."}
            </p>

            <form
              onSubmit={submit}
              aria-busy={loading}
              aria-describedby={error ? "auth-error" : undefined}
              className="mt-8"
            >
              <fieldset disabled={loading} className="min-w-0 space-y-5">
                <legend className="sr-only">
                  {mode === "login" ? "Sign in" : "Create account"} details
                </legend>
                <Field label="Username">
                  <Input
                    name="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    className="h-11"
                    minLength={mode === "register" ? 3 : undefined}
                    maxLength={mode === "register" ? 32 : undefined}
                    aria-describedby={
                      mode === "register" ? "username-hint" : undefined
                    }
                  />
                  {mode === "register" && (
                    <span
                      id="username-hint"
                      className="block text-xs leading-relaxed text-muted"
                    >
                      3 to 32 characters. Letters, numbers, dots, dashes or
                      underscores.
                    </span>
                  )}
                </Field>
                {mode === "register" && (
                  <>
                    <Field label="Email">
                      <Input
                        name="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="email"
                        maxLength={254}
                        required
                        className="h-11"
                      />
                    </Field>
                    <Field
                      label="Display name"
                      hint="Optional. Shown on the leaderboard."
                    >
                      <Input
                        name="displayName"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        autoComplete="nickname"
                        maxLength={64}
                        className="h-11"
                      />
                    </Field>
                  </>
                )}
                <Field label="Password">
                  <Input
                    name="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={
                      mode === "login" ? "current-password" : "new-password"
                    }
                    required
                    className="h-11"
                    minLength={mode === "register" ? 8 : undefined}
                    maxLength={mode === "register" ? 128 : undefined}
                    aria-describedby={
                      mode === "register" ? "password-hint" : undefined
                    }
                  />
                  {mode === "register" && (
                    <span
                      id="password-hint"
                      className="block text-xs text-muted"
                    >
                      Use 8 to 128 characters.
                    </span>
                  )}
                </Field>
                {error && (
                  <div
                    id="auth-error"
                    role="alert"
                    className="rounded-sm border border-down bg-surface px-3 py-3 text-sm leading-relaxed text-down"
                  >
                    {error}
                  </div>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full justify-between"
                  loading={loading}
                >
                  {loading
                    ? mode === "login"
                      ? "Signing in..."
                      : "Creating account..."
                    : mode === "login"
                      ? "Sign in"
                      : "Create account"}
                  {!loading && (
                    <ArrowRight aria-hidden="true" className="size-4" />
                  )}
                </Button>
              </fieldset>
              <span role="status" className="sr-only">
                {loading ? "Submitting your details. Please wait." : ""}
              </span>
            </form>

            <div className="mt-7 flex flex-wrap items-center gap-x-2 border-t border-border pt-5 text-sm">
              <span className="text-muted">
                {mode === "login"
                  ? "New to Quantstorm?"
                  : "Already have an account?"}
              </span>
              <button
                type="button"
                disabled={loading}
                className="min-h-11 font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
              >
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main id="main" className="grid min-h-dvh place-items-center bg-bg">
          <p role="status" className="mono text-sm text-muted">
            Loading trader access...
          </p>
        </main>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
