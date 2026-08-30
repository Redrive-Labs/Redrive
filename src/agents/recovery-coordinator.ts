import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { GITHUB_WEBHOOK_DELIVERY_TOOL } from "@/server/github/github-mcp";
import { RECEIVER_MCP_BUSINESS_STATE_TOOL } from "@/server/receiver/receiver-mcp-server";

export { GITHUB_WEBHOOK_DELIVERY_TOOL };

/** Semantic Coordinator spec for the M2.7 provider and receiver investigation. */
export const CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION = "m2.7-v1" as const;
export const CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME =
  "redrive-connection-provider-investigation" as const;
export const CONNECTION_RECEIVER_INVESTIGATION_SKILL_NAME =
  "redrive-connection-receiver-investigation" as const;
/** M2.7 TrueForge MCP resource backed by Redrive's strict GitHub route. */
export const CONNECTION_TRUEFORGE_GITHUB_MCP_ENV =
  "REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME" as const;
/** M2.7 TrueForge MCP resource backed by Redrive's strict receiver route. */
export const CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV =
  "REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME" as const;

export class RecoveryCoordinatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCoordinatorConfigurationError";
  }
}

function readStrictMcpConfiguration(
  environment: NodeJS.ProcessEnv,
  key: string,
  description: string,
): string {
  const value = environment[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new RecoveryCoordinatorConfigurationError(
      `${key} must contain a non-empty ${description} without leading or trailing whitespace.`,
    );
  }
  return value;
}

/**
 * The Coordinator is deliberately inline and versioned with Redrive. Its
 * provider resource is the least-privilege connection-backed boundary; incident
 * identity is supplied per turn rather than embedded in this reusable spec.
 */
export function getConnectionRecoveryCoordinatorAgentSpec(
  environment: NodeJS.ProcessEnv = process.env,
): TrueForgeApi.AgentSpec {
  const modelName = environment.REDRIVE_TRUEFORGE_MODEL?.trim();
  if (!modelName) {
    throw new RecoveryCoordinatorConfigurationError(
      "REDRIVE_TRUEFORGE_MODEL must be configured with the TrueForge model/resource name before creating a connection Coordinator session.",
    );
  }

  const githubMcpName = readStrictMcpConfiguration(
    environment,
    CONNECTION_TRUEFORGE_GITHUB_MCP_ENV,
    "MCP resource name",
  );
  const connectionMcpToken = readStrictMcpConfiguration(
    environment,
    "REDRIVE_GITHUB_CONNECTION_MCP_TOKEN",
    "bearer credential",
  );
  const receiverMcpName = readStrictMcpConfiguration(
    environment,
    CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV,
    "MCP resource name",
  );
  const receiverMcpToken = readStrictMcpConfiguration(
    environment,
    "REDRIVE_RECEIVER_MCP_TOKEN",
    "bearer credential",
  );
  if (githubMcpName === receiverMcpName) {
    throw new RecoveryCoordinatorConfigurationError(
      "The connection-backed GitHub and Receiver MCP server names must be distinct.",
    );
  }
  if (connectionMcpToken === receiverMcpToken) {
    throw new RecoveryCoordinatorConfigurationError(
      "The connection-backed GitHub and Receiver MCP bearer credentials must be distinct.",
    );
  }

  return {
    model: { name: modelName },
    instructions: [
      "You coordinate two role-separated, read-only connection-backed Redrive investigations.",
      "These are independently authenticated evidence boundaries with deterministic fail-closed tool correlation.",
      "Establish machine-observed evidence independently for each turn; never invent unavailable facts or use evidence from the other boundary.",
      "For the provider turn, create exactly one dynamic subagent named provider-investigator.",
      "The provider subagent receives only the exact connection_id and delivery_id supplied in that turn.",
      `The provider subagent, and only that subagent, must call ${GITHUB_WEBHOOK_DELIVERY_TOOL} on the configured GitHub MCP server with exactly connection_id and delivery_id.`,
      "The provider subagent must not call the Receiver MCP or use receiver evidence.",
      "For the receiver turn, create exactly one dynamic subagent named receiver-investigator.",
      "The receiver subagent receives only the exact connection_id and delivery_guid supplied in that turn.",
      `The receiver subagent, and only that subagent, must call ${RECEIVER_MCP_BUSINESS_STATE_TOOL} on the configured Receiver MCP server with exactly connection_id and delivery_guid.`,
      "The receiver subagent must not call the GitHub MCP or use provider evidence.",
      "The provider turn must not infer receiver state. The receiver turn must not infer provider state.",
      "Only the correlated machine tool.response from the intended read-only MCP boundary is evidence; agent prose is never evidence.",
      "Per-child tool visibility is LIVE VALIDATION REQUIRED; this static AgentSpec does not establish per-dynamic-subagent MCP resource filtering.",
      "Do not call health, repair, deploy, approval, redelivery, or any write or consequential tool.",
    ].join("\n"),
    config: {
      dynamicSubAgents: { enabled: true },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    },
    mcpServers: [
      {
        name: githubMcpName,
        enableTools: [GITHUB_WEBHOOK_DELIVERY_TOOL],
        preload: true,
      },
      {
        name: receiverMcpName,
        enableTools: [RECEIVER_MCP_BUSINESS_STATE_TOOL],
        preload: true,
      },
    ],
    skills: [
      { name: CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME },
      { name: CONNECTION_RECEIVER_INVESTIGATION_SKILL_NAME },
    ],
  } satisfies TrueForgeApi.AgentSpec;
}

export const getConnectionBackedRecoveryCoordinatorAgentSpec =
  getConnectionRecoveryCoordinatorAgentSpec;
