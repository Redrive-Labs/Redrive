import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { ConcreteRedriveHttpTransport } from "./http-transport.js";
import {
  createReceiverConnectorRuntime,
  type ReceiverConnectorRuntime,
} from "./runtime.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const shutdown = new AbortController();
  const onShutdown = (): void => shutdown.abort();
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);

  let runtime: ReceiverConnectorRuntime | undefined;
  try {
    const transport = new ConcreteRedriveHttpTransport({
      redriveUrl: config.redriveUrl,
      signal: shutdown.signal,
    });
    runtime = createReceiverConnectorRuntime({ config, transport });
    await runtime.worker.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", onShutdown);
    process.removeListener("SIGTERM", onShutdown);
    await runtime?.close();
  }
}

const invokedFile = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedFile === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Receiver connector could not start.",
    );
    process.exitCode = 1;
  });
}
