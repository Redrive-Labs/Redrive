import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { GITHUB_WEBHOOK_DELIVERY_TOOL } from "@/server/github-mcp";

export { GITHUB_WEBHOOK_DELIVERY_TOOL };

/** Semantic Coordinator spec for connection-backed provider investigation. */
export const CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION = "m2.6b-v1" as const;
export const CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME =
  "redrive-connection-provider-investigation" as const;
/** M2.6B TrueForge MCP resource backed by Redrive's strict connection route. */
export const CONNECTION_TRUEFORGE_GITHUB_MCP_ENV =
  "REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME" as const;

export class RecoveryCoordinatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCoordinatorConfigurationError";
  }
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

  const githubMcpName = environment[CONNECTION_TRUEFORGE_GITHUB_MCP_ENV]?.trim();
  if (!githubMcpName) {
    throw new RecoveryCoordinatorConfigurationError(
      `${CONNECTION_TRUEFORGE_GITHUB_MCP_ENV} must name a configured connection-backed TrueForge GitHub MCP server before creating a Coordinator session.`,
    );
  }
  const connectionMcpToken = environment.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;
  if (!connectionMcpToken) {
    throw new RecoveryCoordinatorConfigurationError(
      "REDRIVE_GITHUB_CONNECTION_MCP_TOKEN must be configured for the connection-backed GitHub MCP before creating a Coordinator session.",
    );
  }

  return {
    model: { name: modelName },
    instructions: [
      "You coordinate one connection-backed Redrive provider investigation.",
      "Establish machine-observed provider evidence before proposing or taking action; never invent unavailable facts.",
      "For the provider investigation, create exactly one dynamic subagent named provider-investigator.",
      "Give that subagent a self-contained provider-only task with only the exact connection_id and delivery_id supplied in the turn.",
      `The subagent, and only that subagent, must call ${GITHUB_WEBHOOK_DELIVERY_TOOL} on the configured GitHub MCP server with exactly connection_id and delivery_id.`,
      "Do not infer receiver state, redeliver a delivery, or use any write or consequential tool.",
      "The machine tool.response is authoritative provider evidence; agent prose is never evidence.",
      "Never deploy or redeliver without later explicit authorization.",
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
    ],
    skills: [{ name: CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME }],
  } satisfies TrueForgeApi.AgentSpec;
}

export const getConnectionBackedRecoveryCoordinatorAgentSpec =
  getConnectionRecoveryCoordinatorAgentSpec;
