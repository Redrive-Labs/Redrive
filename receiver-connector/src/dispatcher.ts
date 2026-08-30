import { ObservationError } from "./errors.js";
import {
  parseCapabilityResult,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  type BusinessStateInput,
  type BusinessStateResult,
  type CapabilityJob,
  type CapabilityResult,
  type HealthInput,
  type HealthResult,
} from "./model.js";
import type { BusinessStateAdapter } from "./business-state.js";
import type { HealthAdapter } from "./health.js";

export interface CapabilityAdapters {
  readonly businessState: BusinessStateAdapter;
  readonly health: HealthAdapter;
}

export type CapabilityDispatcher = (job: CapabilityJob) => Promise<CapabilityResult>;

export function createCapabilityDispatcher(
  adapters: CapabilityAdapters,
): CapabilityDispatcher {
  return async (job: CapabilityJob): Promise<CapabilityResult> => {
    switch (job.capability) {
      case RECEIVER_CAPABILITY_BUSINESS_STATE: {
        const result: BusinessStateResult = await adapters.businessState.observe(
          job.input as BusinessStateInput,
        );
        return parseCapabilityResult(job.capability, job.input, result);
      }
      case RECEIVER_CAPABILITY_HEALTH: {
        const result: HealthResult = await adapters.health.observe(
          job.input as HealthInput,
        );
        return parseCapabilityResult(job.capability, job.input, result);
      }
      default:
        throw new ObservationError(
          "UNSUPPORTED_CAPABILITY",
          "The connector does not support this capability.",
          false,
        );
    }
  };
}

export async function dispatchCapabilityJob(
  job: CapabilityJob,
  adapters: CapabilityAdapters,
): Promise<CapabilityResult> {
  return createCapabilityDispatcher(adapters)(job);
}
