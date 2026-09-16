export type MemoryCategory =
  | "profile"      // Preferences, timezone, writing style
  | "relationship" // People, companies, sensitivities, interaction history
  | "business"     // Company facts, brand rules, operating preferences
  | "project"      // Goals, decisions, deadlines, open loops
  | "episodic"     // Meaningful completed events
  | "procedural"   // Approved workflows and playbooks
  | "negative"     // Do-not rules and anti-patterns
  | "asset";       // References to saved images, logos, documents, media

export type MemoryStatus = "active" | "superseded" | "deleted";

export interface MemoryRecord {
  id: string;
  ownerId: number;
  category: MemoryCategory;
  key: string;
  value: string;
  source: string;
  confidence: number; // 0.0 to 1.0
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  reviewAt?: number;
  status: MemoryStatus;
  supersedesId?: string;
  projectId?: string;
  personKey?: string;
}

export interface MemoryQueryOptions {
  category?: MemoryCategory | MemoryCategory[];
  projectId?: string;
  personKey?: string;
  query?: string;
  limit?: number;
  includeSuperseded?: boolean;
}

export type CapabilityWorkerName =
  | "lucas" | "maya" | "leo" | "sofia" | "dexter" | "elena" | "nora"
  | "ivy" | "quinn" | "aria" | "kai"
  | "chusky";

export const CAPABILITY_MEMORY_ACCESS_MATRIX: Record<CapabilityWorkerName, MemoryCategory[]> = {
  lucas: ["project", "procedural", "asset"],
  maya: ["business", "relationship", "procedural"],
  leo: ["business", "asset", "profile"],
  sofia: ["relationship", "business"],
  dexter: ["project"], // Private user memory excluded by default
  elena: ["project", "procedural", "episodic"],
  // Research may use project and business context, but never broad personal
  // history. Findings are evidence, not permanent memory by default.
  nora: ["project", "business", "procedural"],
  // Communications workers may triage business relationships and approved
  // operating playbooks, but never receive broad private history.
  ivy: ["business", "relationship", "procedural", "project"],
  // Revenue work needs relationship, business, project, and procedural facts;
  // it does not need personal profile or episodic private history.
  quinn: ["business", "relationship", "project", "procedural"],
  // Customer-success work is relationship-led and may create project follow-up.
  aria: ["business", "relationship", "project", "procedural", "episodic"],
  // Analytics receives business/project facts and procedural reporting rules,
  // but not personal or relationship memory by default.
  kai: ["business", "project", "procedural", "asset"],
  chusky: ["profile", "relationship", "business", "project", "episodic", "procedural", "negative", "asset"],
};
