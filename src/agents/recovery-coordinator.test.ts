import { describe, expect, it } from "vitest";
import {
  CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME,
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
  CONNECTION_TRUEFORGE_GITHUB_MCP_ENV,
  GITHUB_WEBHOOK_DELIVERY_TOOL,
  getConnectionRecoveryCoordinatorAgentSpec,
  RecoveryCoordinatorConfigurationError,
} from "@/agents/recovery-coordinator";

describe("connection-backed Recovery Coordinator spec", () => {
  const environment = {
    NODE_ENV: "test",
    REDRIVE_TRUEFORGE_MODEL: "configured-model",
    REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "redrive-github",
    REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
  } as const;

  it("configures only the connection-backed provider resources", () => {
    const spec = getConnectionRecoveryCoordinatorAgentSpec(environment);

    expect(CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION).toBe("m2.6b-v1");
    expect(spec.model).toEqual({ name: "configured-model" });
    expect(spec.config).toEqual({
      dynamicSubAgents: { enabled: true },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    });
    expect(spec.mcpServers).toEqual([
      {
        name: "redrive-github",
        enableTools: [GITHUB_WEBHOOK_DELIVERY_TOOL],
        preload: true,
      },
    ]);
    expect(spec.skills).toEqual([{ name: CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME }]);
    expect(spec.instructions).toContain("connection_id and delivery_id");
    expect(JSON.stringify(spec)).not.toContain("hook_id");
    expect(JSON.stringify(spec)).not.toContain("repository_id");
  });

  it("requires the model, MCP server name, and connection token", () => {
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "connection-github",
      REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
    })).toThrow(RecoveryCoordinatorConfigurationError);
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
      REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
    })).toThrow(`${CONNECTION_TRUEFORGE_GITHUB_MCP_ENV} must name`);
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
      REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "connection-github",
    })).toThrow("REDRIVE_GITHUB_CONNECTION_MCP_TOKEN must be configured");
  });
});
