export type TregCategory =
  | "enrichment_person"
  | "enrichment_company"
  | "seo"
  | "social_intel"
  | "ads_intel"
  | "web_data"
  | "other";

export interface TregEndpointHit {
  id: string;
  title: string;
  provider: string;
  category: TregCategory;
  priceUsd?: number;
  priceUnit?: "call" | "result" | "row" | "unknown";
  successRate?: number;
  latencyMs?: number;
  requiresOwnAccount?: boolean;
  requiresByok?: boolean;
}

export interface TregEvidenceItem {
  field: string;
  value: string | number | boolean | null;
  confidence: number;
  sourceEndpoint: string;
  sourceProvider: string;
  observedAt: string;
  rawRef?: string;
}

export interface TregEvidenceBundle {
  query: string;
  intent: string;
  items: TregEvidenceItem[];
  endpointsUsed: string[];
  totalCostUsd: number;
  warnings: string[];
  incomplete: boolean;
  generatedAt: string;
}

export interface TregCallReceipt {
  callId: string;
  endpointId: string;
  userId: number;
  missionId?: string;
  costUsd: number;
  ok: boolean;
  statusCode?: number;
  durationMs: number;
  at: number;
  error?: string;
  organizationId?: string;
  missionEvidenceRecorded?: boolean;
}

export interface TregSpendSnapshot {
  userId: number;
  dayKey: string;
  spentUsd: number;
  reservedUsd: number;
  missionSpent: Record<string, number>;
  missionReserved: Record<string, number>;
  rateWindowKey?: string;
  rateWindowCalls?: number;
}

export interface TregSpendReservation {
  id: string;
  userId: number;
  dayKey: string;
  estimateUsd: number;
  missionId?: string;
  rateWindowKey: string;
}

export interface TregOAuthConnection {
  id: string;
  provider?: string;
  name?: string;
  status?: string;
  scopes?: string[];
}
