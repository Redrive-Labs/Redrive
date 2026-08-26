"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ErrorResponse {
  error?: string;
}

export function IncidentForm() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/incidents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: formData.get("provider"),
          externalDeliveryId: formData.get("externalDeliveryId"),
          repositoryId: formData.get("repositoryId"),
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | ErrorResponse
        | null;

      if (!response.ok) {
        setError(result?.error ?? "The incident could not be recorded.");
        return;
      }

      form.reset();
      router.refresh();
    } catch {
      setError("The incident could not be recorded. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      action="/api/incidents"
      className="grid gap-4"
      method="post"
      onSubmit={handleSubmit}
      aria-describedby={error ? "incident-form-error" : undefined}
    >
      <div className="grid gap-1.5">
        <label
          className="text-sm font-semibold tracking-tight text-[var(--ink)]"
          htmlFor="provider"
        >
          Provider label
        </label>
        <input
          className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3.5 text-sm text-[var(--ink)] transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
          id="provider"
          name="provider"
          placeholder="development"
          required
        />
      </div>

      <div className="grid gap-1.5">
        <label
          className="text-sm font-semibold tracking-tight text-[var(--ink)]"
          htmlFor="externalDeliveryId"
        >
          External delivery identifier
        </label>
        <input
          className="mono-type min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3.5 text-sm text-[var(--ink)] transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
          id="externalDeliveryId"
          name="externalDeliveryId"
          placeholder="delivery-001"
          required
        />
      </div>

      <div className="grid gap-1.5">
        <label
          className="text-sm font-semibold tracking-tight text-[var(--ink)]"
          htmlFor="repositoryId"
        >
          Repository identifier
        </label>
        <input
          className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3.5 text-sm text-[var(--ink)] transition-colors placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
          id="repositoryId"
          name="repositoryId"
          placeholder="owner/receiver"
          required
        />
      </div>

      {error ? (
        <p
          className="border border-[#d89d89] bg-[var(--accent-wash)] px-3 py-2 text-sm text-[var(--accent-deep)]"
          id="incident-form-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <button
        className="inline-flex min-h-11 items-center justify-center bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--paper-bright)] transition-colors hover:bg-[var(--accent-deep)] disabled:cursor-wait disabled:opacity-60"
        disabled={isSubmitting}
        type="submit"
      >
        {isSubmitting ? "Recording…" : "Record incident"}
      </button>
    </form>
  );
}
