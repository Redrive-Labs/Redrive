export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md items-center px-5 py-10 sm:px-8">
      <section className="w-full border border-[var(--line)] bg-[var(--paper-bright)] p-6 sm:p-8">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center bg-[var(--accent)] text-sm font-bold text-[var(--paper-bright)]">
            R
          </span>
          <div>
            <p className="text-sm font-bold tracking-tight">Redrive</p>
            <p className="mono-type text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">
              Operator access
            </p>
          </div>
        </div>
        <h1 className="display-type text-4xl leading-none">Sign in to Redrive.</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          Enter the operator token configured for this deployment.
        </p>
        <form action="/api/operator/login" className="mt-7 grid gap-4" method="post">
          <label className="grid gap-1.5 text-sm font-semibold" htmlFor="operator-token">
            Operator token
            <input
              autoComplete="current-password"
              className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3.5 text-sm font-normal focus:border-[var(--accent)] focus:outline-none"
              id="operator-token"
              name="token"
              required
              type="password"
            />
          </label>
          <button
            className="min-h-11 bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--paper-bright)] hover:bg-[var(--accent-deep)]"
            type="submit"
          >
            Continue
          </button>
        </form>
      </section>
    </main>
  );
}
