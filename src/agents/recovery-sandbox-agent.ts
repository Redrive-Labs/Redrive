import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

export const REDRIVE_RECOVERY_SPEC_VERSION = "recovery-v7" as const;

const RECOVERY_SANDBOX_PROCEDURE = [
  "Run the entire recovery inside the Daytona sandbox. Never use production credentials or call provider, receiver, deployment, redelivery, or approval tools.",
  "Use the sandbox's signed Debian repositories for PostgreSQL. PostgreSQL 15 is sufficient when PostgreSQL 16 is unavailable; do not add an external PostgreSQL package repository or compile PostgreSQL from source.",
  "Install Node.js 22.12 or newer from the official binary when the sandbox version is older.",
  "Clone https://github.com/<repositoryFullName>.git, checkout originalRevision, and prove git rev-parse HEAD equals originalRevision and git status --short is empty before changing code.",
  "Reconstruct one signed local GitHub push request with the supplied deliveryGuid and a sandbox-only development secret. Prove preCount=0, HTTP=500, and postCount=1. Capture the actual failure evidence and do not send another failing request.",
  "Diagnose the minimum replay-safe repair from the failing revision and observed evidence. Do not use a canned patch, in-memory deduplication, or check-then-insert concurrency logic.",
  "Keep the repair time-bounded: do not inspect later repository commits or update documentation. Change only the source, migration, and tests required to prove the repair, then prioritize replay verification and the final artifact.",
  "Build and run relevant existing tests, then test sequential duplicate delivery, concurrent duplicate delivery, invalid authentication with zero mutation, and the business invariant.",
  "Apply the repair only inside the sandbox. Apply required migrations to the same sandbox database containing the reproduced row, and restart the repaired receiver without deleting that database.",
  "Send exactly one sandbox-local verification request using the same deliveryGuid. Prove verification preCount=1, HTTP is 2xx, and postCount=1, including the required downstream causal operation.",
  "Run npm test, npm run typecheck, npm run build, and git diff --check. Capture the PostgreSQL version and the complete git diff, including untracked files, as the patch.",
  "Return only one JSON object with exactly these top-level fields: schemaVersion, result, sourceRepositoryFullName, originalRevision, deliveryGuid, reproduction, verification, changedFiles, patch, validation, notes.",
  "The final response's first character must be { and its last character must be }. Do not wrap the JSON in Markdown code fences and do not add prose before or after it.",
  "Immediately before the final response, use the sandbox exec tool to read /home/trueforge/evidence/artifact.json, validate that it has the required exact keys, and return that file's exact JSON object.",
  "The JSON must use schemaVersion redrive.recovery.v1 and result REPAIR_VERIFIED; reproduction must contain only preCount=0, httpStatus=500, postCount=1; verification must contain only preCount=1, a 2xx httpStatus, postCount=1.",
  "changedFiles and patch must be non-empty. validation must contain only testsPassed=true, typecheckPassed=true, buildPassed=true, diffCheckPassed=true. notes must contain only a non-empty postgresVersion. Never include a patch digest.",
].join("\n");

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
      RECOVERY_SANDBOX_PROCEDURE,
      "Do not claim REPAIR_VERIFIED from prose, a happy-path response, or an unverified patch.",
    ].join("\n"),
    config: {
      dynamicSubAgents: { enabled: false },
      sandbox: { enabled: true, fileDownloads: false },
      contextManagement: { largeToolResponse: { enabled: false } },
    },
    mcpServers: [],
    skills: [],
  } satisfies TrueForgeApi.AgentSpec;
}
