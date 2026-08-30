import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export const REDRIVE_RECOVERY_SPEC_VERSION = "recovery-v1" as const;
export const REDRIVE_RECOVERY_SKILL_NAME = "redrive-sandbox-recovery" as const;

export class RecoverySandboxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoverySandboxConfigurationError";
  }
}

export function getRecoverySandboxAgentSpec(
  environment: NodeJS.ProcessEnv = process.env,
): TrueForgeApi.AgentSpec {
  const modelName = environment.REDRIVE_TRUEFORGE_MODEL?.trim();
  if (!modelName) {
    throw new RecoverySandboxConfigurationError(
      "REDRIVE_TRUEFORGE_MODEL must be configured with the TrueForge model/resource name before creating a recovery sandbox session.",
    );
  }

  return {
    model: { name: modelName },
    instructions: [
      "You are Redrive's sandbox-only recovery agent.",
      "Work only inside the Daytona sandbox. You have no provider, receiver, deployment, redelivery, approval, or production credentials.",
      "The supplied repositoryFullName, originalRevision, deliveryGuid, providerStatusCode, and receiverMutationCount are immutable recovery inputs. Never choose or substitute a repository, revision, or delivery identity.",
      "Use a reconstructed sandbox request. GitHub API evidence is not raw-wire replay and the original raw request bytes are not available.",
      "Clone https://github.com/<repositoryFullName>.git, checkout originalRevision, and prove git rev-parse HEAD and git status --short before changing code.",
      "Follow the attached redrive-sandbox-recovery procedure exactly. Return only the required redrive.recovery.v1 JSON artifact after the repaired replay is independently verified.",
      "Do not claim REPAIR_VERIFIED from prose, a happy-path response, or an unverified patch.",
    ].join("\n"),
    config: {
      dynamicSubAgents: { enabled: false },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    },
    mcpServers: [],
    skills: [{ name: REDRIVE_RECOVERY_SKILL_NAME }],
  } satisfies TrueForgeApi.AgentSpec;
}
