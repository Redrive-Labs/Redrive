import { describe, expect, it } from "vitest";
import {
  getRecoveryCoordinatorAgentSpec,
  GITHUB_WEBHOOK_DELIVERY_TOOL,
  PROVIDER_INVESTIGATION_SKILL_NAME,
  RecoveryCoordinatorConfigurationError,
  RECOVERY_COORDINATOR_SPEC_VERSION,
} from "@/agents/recovery-coordinator";

describe("Recovery Coordinator v2 spec", () => {
  const environment = {
    NODE_ENV: "test",
    REDRIVE_TRUEFORGE_MODEL: "configured-model",
    REDRIVE_TRUEFORGE_GITHUB_MCP_NAME: "redrive-github",
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
        name: "redrive-github",
        enableTools: [GITHUB_WEBHOOK_DELIVERY_TOOL],
      },
    ]);
    expect(spec.skills).toEqual([{ name: PROVIDER_INVESTIGATION_SKILL_NAME }]);
    expect(spec.instructions).toContain("exactly one dynamic subagent");
    expect(spec.instructions).toContain("do not perform that lookup yourself");
    expect(JSON.stringify(spec)).not.toContain("canonical");
  });

  it("requires the configured TrueForge MCP server name", () => {
    expect(() =>
      getRecoveryCoordinatorAgentSpec({
        NODE_ENV: "test",
        REDRIVE_TRUEFORGE_MODEL: "configured-model",
      }),
    ).toThrow(RecoveryCoordinatorConfigurationError);
  });
});
