import { describe, expect, it } from "vitest";
import {
  CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME,
  CONNECTION_RECEIVER_INVESTIGATION_SKILL_NAME,
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
  CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV,
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
    REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME: "redrive-receiver",
    REDRIVE_RECEIVER_MCP_TOKEN: "receiver-token",
  } as const;

  it("configures role-separated connection-backed provider and receiver resources", () => {
    const spec = getConnectionRecoveryCoordinatorAgentSpec(environment);

    expect(CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION).toBe("m2.7-v1");
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
      {
        name: "redrive-receiver",
        enableTools: ["get_business_state"],
        preload: true,
      },
    ]);
    expect(spec.skills).toEqual([
      { name: CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME },
      { name: CONNECTION_RECEIVER_INVESTIGATION_SKILL_NAME },
    ]);
    expect(spec.instructions).toContain("connection_id and delivery_id");
    expect(spec.instructions).toContain("connection_id and delivery_guid");
    expect(spec.instructions).toContain(
      "independently authenticated evidence boundaries with deterministic fail-closed tool correlation",
    );
    expect(spec.instructions).toContain("LIVE VALIDATION REQUIRED");
    expect(JSON.stringify(spec)).not.toContain("hook_id");
    expect(JSON.stringify(spec)).not.toContain("repository_id");
    expect(JSON.stringify(spec)).not.toContain("connection-token");
    expect(JSON.stringify(spec)).not.toContain("receiver-token");
  });

  it("requires the model, both MCP server names, and both connection tokens", () => {
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "connection-github",
      REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
    })).toThrow(RecoveryCoordinatorConfigurationError);
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
      REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
    })).toThrow(`${CONNECTION_TRUEFORGE_GITHUB_MCP_ENV} must contain a non-empty`);
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
      REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "connection-github",
    })).toThrow("REDRIVE_GITHUB_CONNECTION_MCP_TOKEN must contain a non-empty");

    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      NODE_ENV: "test",
      REDRIVE_TRUEFORGE_MODEL: "configured-model",
      REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "connection-github",
      REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "connection-token",
    })).toThrow(`${CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV} must contain a non-empty`);

    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      ...environment,
      REDRIVE_RECEIVER_MCP_TOKEN: undefined,
    })).toThrow("REDRIVE_RECEIVER_MCP_TOKEN must contain a non-empty");
  });

  it("rejects shared MCP resource names and bearer credentials", () => {
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      ...environment,
      REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME: "redrive-github",
    })).toThrow("server names must be distinct");
    expect(() => getConnectionRecoveryCoordinatorAgentSpec({
      ...environment,
      REDRIVE_RECEIVER_MCP_TOKEN: "connection-token",
    })).toThrow("bearer credentials must be distinct");
  });

  it.each([
    [CONNECTION_TRUEFORGE_GITHUB_MCP_ENV, "redrive-github "],
    [CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV, " redrive-receiver"],
    ["REDRIVE_GITHUB_CONNECTION_MCP_TOKEN", "connection-token "],
    ["REDRIVE_RECEIVER_MCP_TOKEN", " receiver-token"],
  ] as const)("rejects whitespace-bearing %s", (key, value) => {
    expect(() =>
      getConnectionRecoveryCoordinatorAgentSpec({
        ...environment,
        [key]: value,
      }),
    ).toThrow(`${key} must contain a non-empty`);
  });

  it("compares only validated canonical MCP names and tokens", () => {
    expect(() =>
      getConnectionRecoveryCoordinatorAgentSpec({
        ...environment,
        REDRIVE_RECEIVER_MCP_TOKEN: "connection-token ",
      }),
    ).toThrow("REDRIVE_RECEIVER_MCP_TOKEN must contain a non-empty");
    expect(() =>
      getConnectionRecoveryCoordinatorAgentSpec({
        ...environment,
        REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME: "redrive-github ",
      }),
    ).toThrow(
      `${CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV} must contain a non-empty`,
    );
  });
});
