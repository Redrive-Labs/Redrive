export const INCIDENT_WORKFLOW_EVENT_TYPES = [
  "PROVIDER_INVESTIGATION_STARTED",
  "PROVIDER_INVESTIGATOR_STARTED",
  "PROVIDER_EVIDENCE_CAPTURED",
  "PROVIDER_EVIDENCE_REOBSERVED",
  "PROVIDER_OBSERVATION_CONFLICT",
  "PROVIDER_INVESTIGATION_FAILED",
] as const;

export type IncidentWorkflowEventType =
  (typeof INCIDENT_WORKFLOW_EVENT_TYPES)[number];

/**
 * Workflow details are intentionally scalar. Provider payloads and model
 * transcripts do not belong in this durable provenance projection.
 */
export type IncidentWorkflowEventDetails = Readonly<
  Record<string, string | number | boolean | null>
>;

export interface IncidentWorkflowEvent {
  id: string;
  incidentId: string;
  eventType: IncidentWorkflowEventType;
  trueForgeSessionId: string | null;
  turnId: string | null;
  providerInvestigatorThreadId: string | null;
  trueForgeEventId: string | null;
  toolCallId: string | null;
  occurredAt: string;
  details: Record<string, unknown>;
}
