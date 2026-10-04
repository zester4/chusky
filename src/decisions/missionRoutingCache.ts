export interface MissionRoutingCache {
  stepId: string;
  /** Prevent reuse when a step is replanned in place under the same ID. */
  objectiveHash: string;
  updatedAt: number;
  skillNames: string[];
  tregTools: string[];
  composioToolkits: string[];
  composioActions: string[];
  connectedAccounts: Array<{ toolkit: string; status?: string; alias?: string; id?: string }>;
}
