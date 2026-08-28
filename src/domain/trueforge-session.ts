export const TRUEFORGE_SESSION_BINDING_STATES = [
  "CREATING",
  "CREATION_UNCERTAIN",
  "ACTIVE",
  "LOST",
] as const;

export type TrueForgeSessionBindingState =
  (typeof TRUEFORGE_SESSION_BINDING_STATES)[number];

export interface TrueForgeSessionBinding {
  incidentId: string;
  state: TrueForgeSessionBindingState;
  trueForgeSessionId: string | null;
  creationToken: string | null;
  coordinatorSpecVersion: string;
  createdAt: string;
  updatedAt: string;
}
