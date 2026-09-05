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

export type CapabilityWorkerName = "lucas" | "maya" | "leo" | "sofia" | "dexter" | "elena" | "chusky";

export const CAPABILITY_MEMORY_ACCESS_MATRIX: Record<CapabilityWorkerName, MemoryCategory[]> = {
  lucas: ["project", "procedural", "asset"],
  maya: ["business", "relationship", "procedural"],
  leo: ["business", "asset", "profile"],
  sofia: ["relationship", "business"],
  dexter: ["project"], // Private user memory excluded by default
  elena: ["project", "procedural", "episodic"],
  chusky: ["profile", "relationship", "business", "project", "episodic", "procedural", "negative", "asset"],
};
