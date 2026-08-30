import {
  createBusinessStateAdapter,
  type BusinessStateAdapter,
  type BusinessStateQueryClient,
} from "./business-state.js";
import type { ConnectorConfig } from "./config.js";
import { createCapabilityDispatcher } from "./dispatcher.js";
import { createHealthAdapter, type HealthAdapter } from "./health.js";
import type { IdentityGenerator } from "./identity.js";
import type { RedriveTransport } from "./transport.js";
import {
  ReceiverConnectorWorker,
  type ReceiverConnectorWorkerOptions,
} from "./worker.js";

export interface ReceiverConnectorRuntimeOptions {
  readonly config: ConnectorConfig;
  readonly transport: RedriveTransport;
  readonly identityGenerator?: IdentityGenerator;
  readonly databaseClient?: BusinessStateQueryClient;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: ReceiverConnectorWorkerOptions["sleep"];
}

export interface ReceiverConnectorRuntime {
  readonly worker: ReceiverConnectorWorker;
  readonly businessState: BusinessStateAdapter;
  readonly health: HealthAdapter;
  close(): Promise<void>;
}

export function createReceiverConnectorRuntime(
  options: ReceiverConnectorRuntimeOptions,
): ReceiverConnectorRuntime {
  const businessState = createBusinessStateAdapter({
    databaseUrl: options.config.observerDatabaseUrl,
    client: options.databaseClient,
  });
  const health = createHealthAdapter({
    healthUrl: options.config.receiverHealthUrl,
    fetchImpl: options.fetchImpl,
  });
  const worker = new ReceiverConnectorWorker({
    config: options.config,
    transport: options.transport,
    dispatcher: createCapabilityDispatcher({ businessState, health }),
    identityGenerator: options.identityGenerator,
    sleep: options.sleep,
  });
  return {
    worker,
    businessState,
    health,
    close: () => businessState.close(),
  };
}
