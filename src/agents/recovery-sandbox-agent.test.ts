import { describe, expect, it } from "vitest";
import {
  getRecoverySandboxAgentSpec,
  REDRIVE_RECOVERY_SKILL_NAME,
  REDRIVE_RECOVERY_SPEC_VERSION,
  RecoverySandboxConfigurationError,
} from "@/agents/recovery-sandbox-agent";

describe("recovery sandbox AgentSpec", () => {
  it("enables only the Daytona sandbox and contains no MCP resources", () => {
    const spec = getRecoverySandboxAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
    });

    expect(REDRIVE_RECOVERY_SPEC_VERSION).toBe("recovery-v1");
    expect(spec.model).toEqual({ name: "configured-model" });
    expect(spec.config).toEqual({
      dynamicSubAgents: { enabled: false },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    });
    expect(spec.mcpServers).toEqual([]);
    expect(spec.skills).toEqual([{ name: REDRIVE_RECOVERY_SKILL_NAME }]);
    expect(JSON.stringify(spec)).not.toContain("REDRIVE_GITHUB_CONNECTION_MCP_TOKEN");
    expect(spec.instructions).toContain("reconstructed sandbox request");
  });

  it("requires the configured TrueForge model", () => {
    expect(() => getRecoverySandboxAgentSpec({ NODE_ENV: "test" })).toThrow(
      RecoverySandboxConfigurationError,
    );
  });
});
