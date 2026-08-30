import {
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  type BusinessStateReadResult,
} from "@/domain/receiver-connector";

export const RECEIVER_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const RECEIVER_OBSERVATION_TOOL = "get_business_state" as const;

export interface ReceiverObservation {
  id: string;
  incidentId: string;
  applicationConnectionId: string;
  deliveryGuid: string;
  capability: typeof RECEIVER_CAPABILITY_BUSINESS_STATE;
  tool: typeof RECEIVER_OBSERVATION_TOOL;
  mcpServerName: string;
  mutationCount: number;
  businessState: BusinessStateReadResult["businessState"];
  observedAt: string;
  trueForgeSessionId: string;
  turnId: string;
  receiverInvestigatorThreadId: string;
  threadCreatedEventId: string;
  toolCallId: string;
  toolCallEventId: string;
  toolResponseEventId: string;
  toolResponseCreatedAt: string;
  createdAt: string;
}
