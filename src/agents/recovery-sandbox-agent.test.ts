import { describe, expect, it } from "vitest";
import {
  getRecoverySandboxAgentSpec,
  REDRIVE_RECOVERY_SPEC_VERSION,
  RecoverySandboxConfigurationError,
} from "@/agents/recovery-sandbox-agent";

describe("recovery sandbox AgentSpec", () => {
  it("enables only the Daytona sandbox and contains no MCP resources", () => {
    const spec = getRecoverySandboxAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
    });

    expect(REDRIVE_RECOVERY_SPEC_VERSION).toBe("recovery-v7");
    expect(spec.model).toEqual({ name: "configured-model" });
    expect(spec.config).toEqual({
      dynamicSubAgents: { enabled: false },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    });
    expect(spec.mcpServers).toEqual([]);
    expect(spec.skills).toEqual([]);
    expect(JSON.stringify(spec)).not.toContain("REDRIVE_GITHUB_CONNECTION_MCP_TOKEN");
    expect(spec.instructions).toContain("reconstructed sandbox request");
    expect(spec.instructions).toContain("preCount=0, HTTP=500, and postCount=1");
    expect(spec.instructions).toContain("invalid authentication with zero mutation");
    expect(spec.instructions).toContain("PostgreSQL 15 is sufficient");
    expect(spec.instructions).toContain("do not add an external PostgreSQL package repository");
    expect(spec.instructions).toContain("do not inspect later repository commits or update documentation");
    expect(spec.instructions).toContain("schemaVersion redrive.recovery.v1");
    expect(spec.instructions).toContain("Never include a patch digest");
    expect(spec.instructions).toContain("Do not wrap the JSON in Markdown code fences");
    expect(spec.instructions).toContain("use the sandbox exec tool to read");
  });

  it("requires the configured TrueForge model", () => {
    expect(() => getRecoverySandboxAgentSpec({ NODE_ENV: "test" })).toThrow(
      RecoverySandboxConfigurationError,
    );
  });
});
