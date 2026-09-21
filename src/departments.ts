import { createWorkPacket, listDepartmentSpaces, upsertDepartmentSpace } from "./contextGraph.js";
import type { DepartmentSpaceRecord, WorkPacketRecord } from "./store.js";

export const DEPARTMENT_CATALOG = [
  { slug: "sales", name: "Sales", worker: "quinn", objective: "Create qualified pipeline and move opportunities forward." },
  { slug: "support", name: "Customer Support", worker: "ivy", objective: "Resolve customer issues accurately and escalate safely." },
  { slug: "marketing", name: "Marketing", worker: "maya", objective: "Turn verified market insight into measurable demand." },
  { slug: "recruiting", name: "Recruiting", worker: "aria", objective: "Move candidates through a fair, evidence-based hiring process." },
  { slug: "finance-ops", name: "Finance Operations", worker: "kai", objective: "Reconcile financial operations and surface exceptions." },
  { slug: "executive-ops", name: "Executive Operations", worker: "elena", objective: "Keep leadership decisions, risks, and open loops moving." },
  { slug: "engineering", name: "Engineering", worker: "lucas", objective: "Ship and operate reliable software with evidence." },
] as const;

export type DepartmentSlug = (typeof DEPARTMENT_CATALOG)[number]["slug"];
export function getDepartment(slug: string) { return DEPARTMENT_CATALOG.find((item) => item.slug === slug); }
export function listDepartments() { return DEPARTMENT_CATALOG.map((item) => ({ ...item })); }

export async function provisionDepartment(userId: number, slug: string, overrides: Partial<Pick<DepartmentSpaceRecord, "name" | "mission" | "objectives" | "policies" | "approvedTools" | "escalationOwner" | "budget">> = {}): Promise<DepartmentSpaceRecord> {
  const department = getDepartment(slug); if (!department) throw new Error("Unknown department");
  return upsertDepartmentSpace(userId, {
    department: department.slug, name: overrides.name ?? department.name, mission: overrides.mission ?? department.objective,
    objectives: overrides.objectives ?? [department.objective], policies: overrides.policies ?? ["Use only approved tools and cite evidence.", "Escalate irreversible or high-impact actions to the owner."], approvedTools: overrides.approvedTools ?? [], escalationOwner: overrides.escalationOwner, contextNodeIds: [], activeMissionIds: [], decisionNodeIds: [], budget: overrides.budget,
  });
}

export async function createDepartmentHandoff(userId: number, input: Omit<WorkPacketRecord, "id" | "userId" | "status" | "createdAt" | "updatedAt">): Promise<WorkPacketRecord> {
  if (!getDepartment(input.department)) throw new Error("Unknown department");
  return createWorkPacket(userId, input);
}

export { listDepartmentSpaces };
