import { describe, expect, it } from "vitest";
import {
  getConnectionRecoveryCoordinatorAgentSpec,
  getRecoveryCoordinatorAgentSpec,
  GITHUB_WEBHOOK_DELIVERY_TOOL,
  PROVIDER_INVESTIGATION_SKILL_NAME,
  RecoveryCoordinatorConfigurationError,
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
  CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME,
  RECOVERY_COORDINATOR_SPEC_VERSION,
} from "@/agents/recovery-coordinator";

describe("Recovery Coordinator v2 spec", () => {
  const environment = {
    NODE_ENV: "test",
    REDRIVE_TRUEFORGE_MODEL: "configured-model",
    REDRIVE_TRUEFORGE_GITHUB_MCP_NAME: "legacy-github",
    REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "redrive-github",
    REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
  } as const;

  it("retains the configured model and attaches only provider investigation resources", () => {
    const spec = getRecoveryCoordinatorAgentSpec(environment);

    expect(RECOVERY_COORDINATOR_SPEC_VERSION).toBe("m2.5-v2");
    expect(spec.model).toEqual({ name: "configured-model" });
    expect(spec.config).toEqual({
      dynamicSubAgents: { enabled: true },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    });
    expect(spec.mcpServers).toEqual([
      {
        name: "legacy-github",
        enableTools: [GITHUB_WEBHOOK_DELIVERY_TOOL],
        preload: true,
      },
    ]);
    expect(spec.skills).toEqual([{ name: PROVIDER_INVESTIGATION_SKILL_NAME }]);
    expect(spec.instructions).toContain("exactly one dynamic subagent");
    expect(spec.instructions).toContain("do not perform that lookup yourself");
    expect(JSON.stringify(spec)).not.toContain("canonical");
  });


  it("provides a separate connection-backed spec without legacy selectors", () => {
    const spec = getConnectionRecoveryCoordinatorAgentSpec(environment);

    expect(CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION).toBe("m2.6b-v1");
    expect(spec.mcpServers).toEqual([
      {
        name: "redrive-github",
        enableTools: [GITHUB_WEBHOOK_DELIVERY_TOOL],
        preload: true,
      },
    ]);
    expect(spec.instructions).toContain("connection_id and delivery_id");
    expect(spec.skills).toEqual([{ name: CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME }]);
    expect(JSON.stringify(spec)).not.toContain("hook_id");
    expect(JSON.stringify(spec)).not.toContain("repository_id");
    expect(JSON.stringify(spec)).not.toContain("REDRIVE_GITHUB_HOOK");
  });

  it("rejects a shared legacy and connection MCP resource", () => {
    expect(() =>
      getConnectionRecoveryCoordinatorAgentSpec({
        ...environment,
        REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "legacy-github",
      }),
    ).toThrow(RecoveryCoordinatorConfigurationError);
  });

  it("requires the configured TrueForge MCP server names", () => {
    expect(() =>
      getRecoveryCoordinatorAgentSpec({
        NODE_ENV: "test",
        REDRIVE_TRUEFORGE_MODEL: "configured-model",
      }),
    ).toThrow(RecoveryCoordinatorConfigurationError);
    expect(() =>
      getConnectionRecoveryCoordinatorAgentSpec({
        NODE_ENV: "test",
        REDRIVE_TRUEFORGE_MODEL: "configured-model",
      }),
    ).toThrow(RecoveryCoordinatorConfigurationError);
    expect(() =>
      getConnectionRecoveryCoordinatorAgentSpec({
        NODE_ENV: "test",
        REDRIVE_TRUEFORGE_MODEL: "configured-model",
        REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "connection-github",
      }),
    ).toThrow(RecoveryCoordinatorConfigurationError);
  });
});
