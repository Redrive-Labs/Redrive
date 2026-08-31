"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLatestRequestOrchestrator,
  createConnectionBoundIncidentController,
  createIncidentFromDelivery,
  fetchFailedDeliveries,
  incidentCockpitHref,
  type FailedDelivery,
} from "./incident-investigation-client";
import { FailedDeliveryList } from "./failed-delivery-list";

interface RepositoryChoice {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

interface WebhookChoice {
  id: string;
  name: string;
  targetDisplay: string;
  active: boolean;
  events: string[];
}

interface Connection {
  id: string;
  provider: "github";
  githubInstallationId: string;
  repositoryId: string;
  repositoryFullName: string;
  webhookId: string;
  webhookTargetDisplay: string;
  state: "READY";
  account?: { login: string; type: string };
}

type ReceiverState =
  | "WAITING_FOR_RECEIVER"
  | "VERIFYING"
  | "READY"
  | "UNHEALTHY";

interface ReceiverConnectionStatus {
  id: string;
  applicationConnectionId: string;
  state: ReceiverState;
  enrollmentExpiresAt: string | null;
  enrollmentConsumedAt: string | null;
  connectorId: string | null;
  protocolVersion: "1" | null;
  capabilities: string[] | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  lastHealthStatus: "HEALTHY" | "UNHEALTHY" | null;
  lastHealthAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReceiverStatus {
  receiverConnection: ReceiverConnectionStatus | null;
  githubReady: boolean;
  receiverReady: boolean;
  recoveryReady: boolean;
}

interface EnrollmentResponse {
  receiverConnection: ReceiverConnectionStatus;
  enrollmentToken: string;
  enrollmentExpiresAt: string;
}

interface ApiError {
  error?: string;
}

async function readJson<T>(response: Response): Promise<T | ApiError | null> {
  return (await response.json().catch(() => null)) as T | ApiError | null;
}

function errorMessage(value: unknown): string {
  return value !== null && typeof value === "object" && "error" in value &&
    typeof value.error === "string"
    ? value.error
    : "The GitHub connection request failed.";
}

function isReceiverStatus(value: unknown): value is ReceiverStatus {
  return (
    value !== null &&
    typeof value === "object" &&
    "receiverConnection" in value &&
    "githubReady" in value &&
    "receiverReady" in value &&
    "recoveryReady" in value
  );
}

function receiverStateLabel(state: ReceiverState | null): string {
  switch (state) {
    case "WAITING_FOR_RECEIVER":
      return "WAITING";
    case "VERIFYING":
      return "VERIFYING";
    case "READY":
      return "READY";
    case "UNHEALTHY":
      return "UNHEALTHY";
    default:
      return "NOT ENROLLED";
  }
}

export function GithubConnectionFlow() {
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepositoryChoice[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookChoice[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [receiverStatuses, setReceiverStatuses] = useState<Record<string, ReceiverStatus>>({});
  const [repositoryId, setRepositoryId] = useState("");
  const [webhookId, setWebhookId] = useState("");
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrollmentAction, setEnrollmentAction] = useState<"ISSUE" | "REISSUE" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<Connection | null>(null);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  // Deliberately memory-only. The raw token is not persisted or derivable from
  // a status response after a refresh.
  const [enrollmentToken, setEnrollmentToken] = useState<string | null>(null);
  const [enrollmentExpiresAt, setEnrollmentExpiresAt] = useState<string | null>(null);
  const [failedDeliveries, setFailedDeliveries] = useState<FailedDelivery[]>([]);
  const [deliveriesConnectionId, setDeliveriesConnectionId] = useState<string | null>(null);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [creatingIncidentFor, setCreatingIncidentFor] = useState<string | null>(null);
  const incidentCreationController = useRef(
    createConnectionBoundIncidentController({
      create: (connectionId, deliveryId) => createIncidentFromDelivery(connectionId, deliveryId),
      navigate: (incidentId) => window.location.assign(incidentCockpitHref(incidentId)),
      setError: setDeliveriesError,
      setPending: setCreatingIncidentFor,
    }),
  );
  const deliveryRequestOrchestrator = useRef(
    createLatestRequestOrchestrator<FailedDelivery[]>((connectionId, signal) =>
      fetchFailedDeliveries(connectionId, fetch, signal),
    ),
  );
  const webhookRequestGeneration = useRef(0);
  const activeWebhookSelection = useRef<{ installationId: string | null; repositoryId: string }>({
    installationId: null,
    repositoryId: "",
  });

  function activateConnection(connectionId: string | null): void {
    incidentCreationController.current.activate(connectionId);
    setActiveConnectionId(connectionId);
  }

  const activeReceiverState =
    activeConnectionId === null
      ? null
      : receiverStatuses[activeConnectionId]?.receiverConnection?.state ?? null;

  const fetchReceiverStatus = useCallback(async (connectionId: string): Promise<ReceiverStatus> => {
    const response = await fetch(
      `/api/integrations/github/connections/${encodeURIComponent(connectionId)}/receiver`,
      { cache: "no-store" },
    );
    const result = await readJson<ReceiverStatus>(response);
    if (!response.ok) throw new Error(errorMessage(result));
    if (!isReceiverStatus(result)) throw new Error("Receiver status response was invalid.");
    return result;
  }, []);

  const refreshReceiverStatus = useCallback(async (connectionId: string): Promise<ReceiverStatus> => {
    const status = await fetchReceiverStatus(connectionId);
    setReceiverStatuses((current) => ({ ...current, [connectionId]: status }));
    return status;
  }, [fetchReceiverStatus]);

  const loadConnections = useCallback(async () => {
    const response = await fetch("/api/integrations/github/connections", {
      cache: "no-store",
    });
    const result = await readJson<{ connections: Connection[] }>(response);
    if (!response.ok) throw new Error(errorMessage(result));
    if (result === null || !("connections" in result) || !Array.isArray(result.connections)) {
      throw new Error("Connection response was invalid.");
    }
    const nextConnections = result.connections;
    setConnections(nextConnections);
    setConnected((current) => current ?? nextConnections[0] ?? null);
    setActiveConnectionId((current) => {
      const next = current ?? nextConnections[0]?.id ?? null;
      incidentCreationController.current.activate(next);
      return next;
    });

    const statuses = await Promise.all(
      nextConnections.map(async (connection) => {
        try {
          return [connection.id, await fetchReceiverStatus(connection.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    setReceiverStatuses((current) => {
      const next = { ...current };
      for (const status of statuses) {
        if (status !== null) next[status[0]] = status[1];
      }
      return next;
    });
  }, [fetchReceiverStatus]);

  const loadRepositories = useCallback(async (nextInstallationId: string) => {
    setLoadingRepositories(true);
    setError(null);
    try {
      const query = new URLSearchParams({ installationId: nextInstallationId });
      const response = await fetch(`/api/integrations/github/repositories?${query}`, {
        cache: "no-store",
      });
      const result = await readJson<{ repositories: RepositoryChoice[] }>(response);
      if (!response.ok) throw new Error(errorMessage(result));
      if (result === null || !("repositories" in result)) throw new Error("Repository response was invalid.");
      setRepositories(result.repositories);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Repositories could not be loaded.");
    } finally {
      setLoadingRepositories(false);
    }
  }, []);

  useEffect(() => {
    const nextInstallationId = new URLSearchParams(window.location.search).get(
      "githubInstallationId",
    );
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      void loadConnections().catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "Connections could not be loaded.");
        }
      });
      if (nextInstallationId !== null && nextInstallationId.length > 0) {
        webhookRequestGeneration.current += 1;
        activeWebhookSelection.current = { installationId: nextInstallationId, repositoryId: "" };
        setInstallationId(nextInstallationId);
        void loadRepositories(nextInstallationId);
      }
    });
    return () => {
      disposed = true;
    };
  }, [loadConnections, loadRepositories]);

  useEffect(() => {
    if (activeConnectionId === null || activeReceiverState === null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const status = await fetchReceiverStatus(activeConnectionId);
        if (disposed) return;
        setReceiverStatuses((current) => ({ ...current, [activeConnectionId]: status }));
        const state = status.receiverConnection?.state ?? null;
        if (state !== "READY" && state !== "UNHEALTHY" && state !== null) {
          timer = setTimeout(() => void poll(), 1500);
        }
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "Receiver status could not be loaded.");
          timer = setTimeout(() => void poll(), 2000);
        }
      }
    };

    timer = setTimeout(() => void poll(), 900);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [activeConnectionId, activeReceiverState, fetchReceiverStatus]);

  async function issueEnrollment(
    connectionId: string,
    action: "ISSUE" | "REISSUE",
  ): Promise<void> {
    setEnrollmentAction(action);
    setError(null);
    try {
      const response = await fetch(
        `/api/integrations/github/connections/${encodeURIComponent(connectionId)}/receiver-enrollment`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const result = await readJson<EnrollmentResponse>(response);
      if (
        !response.ok ||
        result === null ||
        !("enrollmentToken" in result) ||
        !("enrollmentExpiresAt" in result) ||
        !("receiverConnection" in result)
      ) {
        throw new Error(errorMessage(result));
      }
      setEnrollmentToken(result.enrollmentToken);
      setEnrollmentExpiresAt(result.enrollmentExpiresAt);
      setReceiverStatuses((current) => ({
        ...current,
        [connectionId]: {
          receiverConnection: result.receiverConnection,
          githubReady: true,
          receiverReady: result.receiverConnection.state === "READY",
          recoveryReady: result.receiverConnection.state === "READY",
        },
      }));
      activateConnection(connectionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Receiver enrollment could not be issued.");
    } finally {
      setEnrollmentAction(null);
    }
  }

  async function handleRepositoryChange(nextRepositoryId: string) {
    const requestGeneration = ++webhookRequestGeneration.current;
    const requestInstallationId = installationId;
    activeWebhookSelection.current = {
      installationId: requestInstallationId,
      repositoryId: nextRepositoryId,
    };
    const isCurrentRequest = () =>
      webhookRequestGeneration.current === requestGeneration &&
      activeWebhookSelection.current.installationId === requestInstallationId &&
      activeWebhookSelection.current.repositoryId === nextRepositoryId;

    setRepositoryId(nextRepositoryId);
    setWebhookId("");
    setWebhooks([]);
    if (requestInstallationId === null || nextRepositoryId.length === 0) {
      setLoadingWebhooks(false);
      return;
    }
    setLoadingWebhooks(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        installationId: requestInstallationId,
        repositoryId: nextRepositoryId,
      });
      const response = await fetch(`/api/integrations/github/webhooks?${query}`, {
        cache: "no-store",
      });
      const result = await readJson<{ webhooks: WebhookChoice[] }>(response);
      if (!response.ok) throw new Error(errorMessage(result));
      if (result === null || !("webhooks" in result)) throw new Error("Webhook response was invalid.");
      if (isCurrentRequest()) setWebhooks(result.webhooks);
    } catch (reason) {
      if (isCurrentRequest()) {
        setError(reason instanceof Error ? reason.message : "Webhooks could not be loaded.");
      }
    } finally {
      if (isCurrentRequest()) setLoadingWebhooks(false);
    }
  }

  async function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (installationId === null || repositoryId.length === 0 || webhookId.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations/github/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId, repositoryId, webhookId }),
      });
      const result = await readJson<{ connection: Connection }>(response);
      if (!response.ok || result === null || !("connection" in result)) {
        throw new Error(errorMessage(result));
      }
      const connection = result.connection;
      setConnected(connection);
      activateConnection(connection.id);
      setFailedDeliveries([]);
      setDeliveriesConnectionId(null);
      setDeliveriesError(null);
      setCreatingIncidentFor(null);
      setEnrollmentToken(null);
      setEnrollmentExpiresAt(null);
      await loadConnections();
      // A newly persisted GitHub connection is the first point at which the
      // receiver invitation should be issued. Existing connections retain
      // their receiver state and can be explicitly reissued below.
      if (response.status === 201) {
        await issueEnrollment(connection.id, "ISSUE");
      } else {
        await refreshReceiverStatus(connection.id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The connection could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function selectConnection(connection: Connection): void {
    setConnected(connection);
    activateConnection(connection.id);
    setEnrollmentToken(null);
    setEnrollmentExpiresAt(null);
    setError(null);
    setFailedDeliveries([]);
    setDeliveriesConnectionId(null);
    setDeliveriesError(null);
    setCreatingIncidentFor(null);
  }

  const activeConnection =
    (activeConnectionId === null
      ? connected
      : connections.find((connection) => connection.id === activeConnectionId)) ?? connected;
  const activeStatus = activeConnectionId === null
    ? null
    : receiverStatuses[activeConnectionId] ?? null;
  const receiverConnection = activeStatus?.receiverConnection ?? null;
  const githubReady = activeStatus?.githubReady ?? activeConnection?.state === "READY";
  const recoveryReady = activeStatus?.recoveryReady ?? false;

  useEffect(() => {
    const requestOrchestrator = deliveryRequestOrchestrator.current;
    const connectionId = activeConnectionId;
    if (connectionId === null || !githubReady || !recoveryReady) {
      requestOrchestrator.invalidate();
      return;
    }

    let disposed = false;
    const loadDeliveries = async () => {
      try {
        const result = await requestOrchestrator.run(connectionId);
        if (!disposed && result.current && result.value !== undefined) {
          setFailedDeliveries(result.value);
          setDeliveriesConnectionId(connectionId);
        }
      } catch (reason: unknown) {
        if (disposed || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setDeliveriesError(reason instanceof Error ? reason.message : "Failed deliveries could not be loaded.");
      } finally {
        if (!disposed) setDeliveriesLoading(false);
      }
    };
    queueMicrotask(() => {
      if (disposed) return;
      setDeliveriesLoading(true);
      setDeliveriesError(null);
      setFailedDeliveries([]);
      setDeliveriesConnectionId(null);
      void loadDeliveries();
    });

    return () => {
      disposed = true;
      requestOrchestrator.invalidate();
    };
  }, [activeConnectionId, githubReady, recoveryReady]);

  async function handleDeliverySelection(deliveryId: string): Promise<void> {
    if (activeConnectionId === null) return;
    const connectionId = activeConnectionId;
    await incidentCreationController.current.open(connectionId, deliveryId);
  }

  return (
    <section className="border-b border-[var(--line)] py-10" id="github-connection">
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-14">
        <div>
          <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--accent-deep)]">
            Application connection
          </p>
          <h2 className="display-type mt-2 text-4xl leading-none">Connect GitHub</h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-[var(--muted)]">
            Redrive creates a private, read-only-content GitHub App for this deployment.
            It protects an existing repository webhook; it does not receive webhook events.
          </p>
        </div>

        <div className="grid gap-5">
          <form action="/api/integrations/github/app-manifest" className="grid gap-3 border border-[var(--line)] bg-[var(--paper-bright)] p-4" method="post">
            <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-target-type">
              GitHub account target
              <select className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-target-type" name="targetType" defaultValue="personal" onChange={(event) => {
                const organization = document.getElementById("github-organization-login");
                if (organization instanceof HTMLInputElement) organization.hidden = event.target.value !== "organization";
              }}>
                <option value="personal">Personal account</option>
                <option value="organization">GitHub organization</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-organization-login">
              Organization login
              <input className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-organization-login" name="ownerLogin" placeholder="acme" hidden />
            </label>
            <button className="min-h-11 bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--paper-bright)] hover:bg-[var(--accent-deep)]" type="submit">
              Create GitHub App
            </button>
          </form>

          {installationId !== null ? (
            <form className="grid gap-3 border border-[var(--line)] bg-[var(--paper-bright)] p-4" onSubmit={handleConnect}>
              <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Installation verified</p>
              <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-repository">
                Repository
                <select className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-repository" value={repositoryId} onChange={(event) => void handleRepositoryChange(event.target.value)}>
                  <option value="">{loadingRepositories ? "Loading repositories…" : "Choose a repository"}</option>
                  {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-webhook">
                Existing webhook
                <select className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-webhook" value={webhookId} onChange={(event) => setWebhookId(event.target.value)} disabled={repositoryId.length === 0 || loadingWebhooks}>
                  <option value="">{loadingWebhooks ? "Loading webhooks…" : "Choose a webhook"}</option>
                  {webhooks.map((webhook) => <option key={webhook.id} value={webhook.id}>{webhook.targetDisplay}</option>)}
                </select>
              </label>
              <button className="min-h-11 bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--paper-bright)] disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || webhookId.length === 0} type="submit">
                {saving ? "Saving connection…" : "Save connection"}
              </button>
            </form>
          ) : null}

          {error ? <p className="border border-[#d89d89] bg-[var(--accent-wash)] px-3 py-2 text-sm text-[var(--accent-deep)]" role="alert">{error}</p> : null}
        </div>
      </div>

      {activeConnection ? (
        <div className="mt-8 border-t border-[var(--line)] pt-7" data-testid="receiver-onboarding">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Recovery readiness</p>
              <h3 className="display-type mt-2 text-3xl leading-none">{activeConnection.repositoryFullName}</h3>
            </div>
            <span className="mono-type border border-[var(--line)] px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              {activeConnection.account?.login ?? "GitHub"}
            </span>
          </div>

          <div className="mt-6 grid gap-px border border-[var(--line)] bg-[var(--line)] sm:grid-cols-3">
            <div className="bg-[var(--paper-bright)] p-4">
              <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">GitHub</p>
              <p className="mt-2 text-lg font-semibold">{githubReady ? "READY" : "NOT READY"}</p>
            </div>
            <div className="bg-[var(--paper-bright)] p-4">
              <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">Receiver</p>
              <p className="mt-2 text-lg font-semibold">{receiverStateLabel(receiverConnection?.state ?? null)}</p>
            </div>
            <div className="bg-[var(--paper-bright)] p-4">
              <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">Application</p>
              <p className="mt-2 text-lg font-semibold">{recoveryReady ? "RECOVERY READY" : "NOT READY"}</p>
            </div>
          </div>

          {receiverConnection?.state === "WAITING_FOR_RECEIVER" && enrollmentToken !== null ? (
            <div className="mt-5 border border-[var(--accent)] bg-[var(--accent-wash)] p-4">
              <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--accent-deep)]">One-time enrollment token</p>
              <p className="mt-2 text-sm leading-6">Copy this token into the connector command below. It is shown only from the issuance response and only for this browser session.</p>
              <code className="mt-3 block max-w-full overflow-x-auto border border-[var(--line)] bg-[var(--paper-bright)] p-3 text-xs leading-5 text-[var(--ink)]">{enrollmentToken}</code>
              <p className="mt-4 text-sm leading-6">From the Redrive repository, run the receiver connector with the copied token:</p>
              <pre className="mt-3 max-w-full overflow-x-auto border border-[var(--line)] bg-[var(--paper-bright)] p-3 text-xs leading-5 text-[var(--ink)]"><code>{[
                "cd receiver-connector",
                "npm ci",
                "export REDRIVE_URL=http://127.0.0.1:3001",
                "export REDRIVE_ENROLLMENT_TOKEN=<one-time-token-from-redrive>",
                "export REDRIVE_OBSERVER_DATABASE_URL=postgresql://receiver:receiver_dev_password@127.0.0.1:5434/receiver",
                "export REDRIVE_RECEIVER_HEALTH_URL=http://127.0.0.1:3000/health",
                'export REDRIVE_CONNECTOR_STATE_DIR="$PWD/.local/state"',
                "npm run receiver-connector",
              ].join("\n")}</code></pre>
              <p className="mt-3 text-xs text-[var(--muted)]">
                Refreshing will not recover the token.
                {enrollmentExpiresAt ? ` Expires ${new Date(enrollmentExpiresAt).toLocaleString()}.` : ""}
              </p>
            </div>
          ) : null}

          {receiverConnection === null ? (
            <p className="mt-5 text-sm leading-6 text-[var(--muted)]">GitHub is connected. Issue a receiver enrollment to continue.</p>
          ) : receiverConnection.state === "WAITING_FOR_RECEIVER" && enrollmentToken === null ? (
            <p className="mt-5 text-sm leading-6 text-[var(--muted)]">Waiting for the receiver connector. The token from an earlier session is not recoverable.</p>
          ) : receiverConnection.state === "VERIFYING" ? (
            <p className="mt-5 text-sm leading-6 text-[var(--muted)]">The connector is enrolled. Redrive is verifying its health capability.</p>
          ) : receiverConnection.state === "READY" ? (
            <p className="mt-5 text-sm leading-6 text-[var(--muted)]">Receiver health succeeded. The application is ready for recovery work.</p>
          ) : receiverConnection.state === "UNHEALTHY" ? (
            <p className="mt-5 text-sm leading-6 text-[var(--accent-deep)]">The receiver reported unhealthy. Recovery remains blocked until health succeeds.</p>
          ) : null}

          {receiverConnection === null || receiverConnection.state === "WAITING_FOR_RECEIVER" ? (
            <button
              className="mt-5 min-h-10 border border-[var(--ink)] px-4 text-sm font-semibold hover:bg-[var(--ink)] hover:text-[var(--paper-bright)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={enrollmentAction !== null}
              onClick={() => void issueEnrollment(activeConnection.id, receiverConnection === null ? "ISSUE" : "REISSUE")}
              type="button"
            >
              {enrollmentAction === "ISSUE" ? "Issuing enrollment…" : enrollmentAction === "REISSUE" ? "Reissuing enrollment…" : receiverConnection === null ? "Issue enrollment" : "Reissue enrollment"}
            </button>
          ) : null}

          {recoveryReady ? (
            <section className="mt-8 border-t border-[var(--line)] pt-6" aria-labelledby="failed-deliveries-title">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">Failed deliveries</p>
                  <h4 className="display-type mt-1 text-2xl leading-none" id="failed-deliveries-title">Choose a delivery to investigate.</h4>
                </div>
                <span className="mono-type text-xs text-[var(--muted)]">GitHub MCP</span>
              </div>
              {deliveriesLoading ? <p className="mt-4 text-sm text-[var(--muted)]" role="status">Loading failed deliveries…</p> : null}
              {deliveriesError ? <p className="mt-4 text-sm text-[var(--accent-deep)]" role="alert">{deliveriesError}</p> : null}
              {deliveriesConnectionId === activeConnectionId && !deliveriesLoading && deliveriesError === null && failedDeliveries.length === 0 ? (
                <p className="mt-4 text-sm text-[var(--muted)]">No failed deliveries are available for this connection.</p>
              ) : null}
              {deliveriesConnectionId === activeConnectionId && !deliveriesLoading && deliveriesError === null && failedDeliveries.length > 0 ? (
                <FailedDeliveryList
                  creatingIncidentFor={creatingIncidentFor}
                  deliveries={failedDeliveries}
                  onSelect={(deliveryId) => void handleDeliverySelection(deliveryId)}
                />
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {connections.length > 0 ? (
        <div className="mt-8 border-t border-[var(--line)] pt-6">
          <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Durable connections</p>
          <ul className="mt-3 grid gap-2">
            {connections.map((connection) => {
              const status = receiverStatuses[connection.id];
              const isActive = activeConnectionId === connection.id;
              return (
                <li className={`flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] py-3 text-sm ${isActive ? "bg-[var(--accent-wash)]" : ""}`} key={connection.id}>
                  <button className="min-w-0 text-left hover:text-[var(--accent-deep)]" onClick={() => selectConnection(connection)} type="button">
                    <strong>{connection.account?.login ?? "GitHub"}</strong> · {connection.repositoryFullName}
                  </button>
                  <span className="mono-type text-xs text-[var(--muted)]">
                    GitHub {connection.state} · Receiver {receiverStateLabel(status?.receiverConnection?.state ?? null)} · {status?.recoveryReady ? "RECOVERY READY" : "NOT READY"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
