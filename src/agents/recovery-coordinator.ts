import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export const RECOVERY_COORDINATOR_SPEC_VERSION = "m2.5-v1" as const;

export class RecoveryCoordinatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCoordinatorConfigurationError";
  }
}

/**
 * The Coordinator is deliberately inline and versioned with Redrive. It
 * establishes the safety posture for later investigation work without
 * embedding incident facts, secrets, or provider-specific tools.
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
      "Delegate specialized investigation when requested, and reconcile the resulting evidence explicitly.",
      "Never deploy or redeliver without later explicit authorization.",
    ].join("\n"),
  } satisfies TrueForgeApi.AgentSpec;
}
