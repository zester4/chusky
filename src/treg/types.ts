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
  /** Upstream provider method declared by Treg's endpoint metadata. */
  method?: string;
  priceUsd?: number;
  /** Treg's catalog `cost.type`; keep it separate from the billing unit. */
  priceType?: "per_call" | "per_success" | "per_result" | "unknown";
  /** May be absent on old catalog rows. */
  priceUnit?: "call" | "result" | "row" | "target" | "domain" | "keyword" | "unknown";
  /** True means `priceUsd` is a reference/minimum, not a safe upper bound. */
  priceVaries?: boolean;
  /** Catalog reference amount when pricing varies; never use it as an estimate. */
  priceReferenceUsd?: number;
  successRate?: number;
  latencyMs?: number;
  requiresOwnAccount?: boolean;
  requiresByok?: boolean;
  strictQuery?: boolean;
  inputFields?: string[];
  siblings?: string[];
}

export interface TregPlatformOption {
  id: string;
  title: string;
  provider: string;
  priceUsd?: number;
  successRate?: number;
  latencyMs?: number;
  lastOkAt?: string;
  endpointId?: string;
  requiresOwnAccount?: boolean;
}

export interface TregOwnTool {
  name: string;
  baseUrl?: string;
  host?: string;
  bindings?: string[];
}

export interface TregEvidenceItem {
  field: string;
  value: string | number | boolean | null;
  /** Provider-supplied score only; Chusky never invents a confidence value. */
  providerScore?: number;
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
  callId?: string;
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
  idempotencyKey?: string;
  replayed?: boolean;
  servedVia?: string;
  servedBy?: string;
  upstreamFailed?: string;
  routeTried?: string[];
  ignoredFilters?: string[];
  pending?: boolean;
  costIsEstimate?: boolean;
}

export interface TregPersonSearchResult {
  fullName?: string;
  title?: string;
  company?: string;
  domain?: string;
  linkedinUrl?: string;
  location?: string;
  email?: string;
  emailVerificationStatus?: string;
  emailVerified?: boolean;
  sourceUrls?: string[];
  providerScore?: number;
}

export interface TregCompanySearchResult {
  name?: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  location?: string;
  description?: string;
  sourceUrls?: string[];
  providerScore?: number;
}

export interface TregCompanyJobResult {
  signalType: "hiring";
  companyName?: string;
  companyDomain?: string;
  title?: string;
  location?: string;
  postedAt?: string;
  jobUrl?: string;
  sourceUrls?: string[];
  description?: string;
  providerScore?: number;
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
