import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDirectory = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(srcDirectory),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
