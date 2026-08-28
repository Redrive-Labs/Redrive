import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { GITHUB_WEBHOOK_DELIVERY_TOOL } from "@/server/github-mcp";

export { GITHUB_WEBHOOK_DELIVERY_TOOL };

export const RECOVERY_COORDINATOR_SPEC_VERSION = "m2.5-v2" as const;
export const LEGACY_RECOVERY_COORDINATOR_SPEC_VERSION = "m2.5-v1" as const;
export const PROVIDER_INVESTIGATION_SKILL_NAME =
  "redrive-provider-investigation" as const;

export class RecoveryCoordinatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCoordinatorConfigurationError";
  }
}

/**
 * The Coordinator is deliberately inline and versioned with Redrive. The v2
 * resources are the least-privilege provider-investigation boundary; incident
 * identity is supplied per turn rather than embedded in this reusable spec.
 */
export function getRecoveryCoordinatorAgentSpec(
  environment: NodeJS.ProcessEnv = process.env,
): TrueForgeApi.AgentSpec {
  const modelName = environment.REDRIVE_TRUEFORGE_MODEL?.trim();
  if (!modelName) {
    throw new RecoveryCoordinatorConfigurationError(
      "REDRIVE_TRUEFORGE_MODEL must be configured with the TrueForge model/resource name before creating a Coordinator session.",
    );
  }

  const githubMcpName = environment.REDRIVE_TRUEFORGE_GITHUB_MCP_NAME?.trim();
  if (!githubMcpName) {
    throw new RecoveryCoordinatorConfigurationError(
      "REDRIVE_TRUEFORGE_GITHUB_MCP_NAME must name a configured TrueForge GitHub MCP server before creating a Coordinator session.",
    );
  }

  return {
    model: {
      // This is the configured TrueForge resource name, not a provider-specific
      // model identifier owned or interpreted by Redrive.
      name: modelName,
    },
    instructions: [
      "You coordinate Redrive recovery for one webhook incident.",
      "Establish machine-observed evidence before proposing or taking action; never invent unavailable facts.",
      "Provider truth and receiver truth are independent and must be investigated independently.",
      "For a provider investigation, create exactly one dynamic subagent named provider-investigator.",
      "Give provider-investigator a self-contained provider-only task using the exact incident identities supplied in the turn.",
      "provider-investigator must perform the GitHub lookup with get_webhook_delivery; do not perform that lookup yourself.",
      "Do not infer receiver state, redeliver a delivery, or use any write or consequential tool.",
      "Report uncertainty rather than inventing facts. A tool response, not agent prose, is the provider measurement.",
      "Never deploy or redeliver without later explicit authorization.",
    ].join("\n"),
    config: {
      dynamicSubAgents: {
        enabled: true,
      },
      // Skills require a sandbox. File downloads and receiver execution are
      // deliberately not enabled for this provider-only turn.
      sandbox: {
        enabled: true,
        fileDownloads: false,
      },
      // Provider evidence must remain in the correlated tool.response. The
      // TrueForge default offloads large MCP results to a sandbox preview,
      // which is not an authoritative GitHub delivery representation.
      contextManagement: {
        largeToolResponse: {
          enabled: false,
        },
      },
    },
    mcpServers: [
      {
        name: githubMcpName,
        enableTools: [GITHUB_WEBHOOK_DELIVERY_TOOL],
        preload: true
      },
    ],
    skills: [{ name: PROVIDER_INVESTIGATION_SKILL_NAME }],
  } satisfies TrueForgeApi.AgentSpec;
}
