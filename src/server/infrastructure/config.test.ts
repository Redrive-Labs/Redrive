import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveRedriveUrl,
  getDefaultSecretDirectory,
  getRequiredRedrivePublicUrl,
  getServerConfig,
  ServerConfigurationError,
  validateRedrivePublicUrl,
} from "@/server/infrastructure/config";

describe("Redrive public URL configuration", () => {
  it("normalizes trailing slashes and derives all paths from the configured URL", () => {
    const publicUrl = validateRedrivePublicUrl("https://redrive.example/base///");
    expect(publicUrl).toBe("https://redrive.example/base");
    expect(deriveRedriveUrl(publicUrl, "/api/integrations/github/callback"))
      .toBe("https://redrive.example/base/api/integrations/github/callback");
  });

  it.each(["not-a-url", "/relative", "https://user:pass@example.com", "https://example.com?a=1", "https://example.com/#fragment", "http://public.example"]) (
    "rejects unsafe public URL %s",
    (value) => {
      expect(() => validateRedrivePublicUrl(value)).toThrow(ServerConfigurationError);
    },
  );

  it.each(["http://localhost:3000", "http://127.0.0.1:3000/", "http://[::1]:3000"]) (
    "allows loopback HTTP URL %s",
    (value) => {
      expect(validateRedrivePublicUrl(value)).toMatch(/^http:\/\//);
    },
  );

  it("requires the explicit public URL only at integration boundaries", () => {
    expect(getServerConfig({} as NodeJS.ProcessEnv).publicUrl).toBeNull();
    expect(() => getRequiredRedrivePublicUrl({} as NodeJS.ProcessEnv)).toThrow(
      "REDRIVE_PUBLIC_URL is required",
    );
    expect(
      getRequiredRedrivePublicUrl({ REDRIVE_PUBLIC_URL: "https://redrive.example/" } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://redrive.example");
  });

  it("resolves the default secret directory beneath the supplied process home", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "redrive-config-test-"));
    try {
      const home = path.join(root, "home");
      mkdirSync(home, { mode: 0o700 });
      if (process.platform !== "win32") chmodSync(home, 0o700);

      expect(getDefaultSecretDirectory(home)).toBe(
        path.join(home, ".redrive", "secrets"),
      );
      expect(
        getServerConfig({} as NodeJS.ProcessEnv, home).secretDir,
      ).toBe(path.join(home, ".redrive", "secrets"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the process home is group/other-writable", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(path.join(os.tmpdir(), "redrive-config-test-"));
    try {
      chmodSync(root, 0o775);
      expect(() => getDefaultSecretDirectory(root)).toThrow(
        "home directory is writable by group or other users",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit secret directory override unchanged", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "redrive-config-test-"));
    try {
      const explicitDirectory = path.join(root, "explicit-secrets");
      expect(
        getServerConfig(
          { REDRIVE_SECRET_DIR: explicitDirectory } as unknown as NodeJS.ProcessEnv,
        )
          .secretDir,
      ).toBe(path.resolve(explicitDirectory));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
