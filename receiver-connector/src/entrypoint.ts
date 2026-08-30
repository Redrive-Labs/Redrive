import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { CENTRAL_TRANSPORT_INTEGRATION_PENDING_MESSAGE } from "./transport.js";

export async function main(): Promise<never> {
  throw new Error(CENTRAL_TRANSPORT_INTEGRATION_PENDING_MESSAGE);
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
