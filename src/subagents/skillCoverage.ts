import { listInstalledSkillIdentifiers, listRoutedSkillNames, type SkillBinding } from "../skills/catalog.js";
import { WORKER_SKILL_BINDINGS } from "./skillBindings.js";
import type { CapabilityWorkerName } from "../memory/types.js";

export type SkillCoverageStatus = "bound-and-routed" | "bound" | "routed-only" | "dynamic-only";

export type SkillCoverageEntry = {
  name: string;
  status: SkillCoverageStatus;
  workers: Array<Exclude<CapabilityWorkerName, "chusky">>;
};

export type SkillCoverageReport = {
  entries: SkillCoverageEntry[];
  invalidBindings: Array<{ worker: string; skill: string }>;
};

function bindingNames(binding: SkillBinding): string[] {
  return [...new Set([...binding.primary, ...binding.supporting].map((name) => name.trim()).filter(Boolean))];
}

/**
 * Classify installed skills without treating every skill directory as a
 * permission or a required preload. Dynamic-only skills remain searchable at
 * runtime, while invalid static bindings become visible in tests and audits.
 */
export async function getSkillCoverage(root?: string): Promise<SkillCoverageReport> {
  const installed = await listInstalledSkillIdentifiers(root);
  const routed = new Set(listRoutedSkillNames());
  const workers = Object.keys(WORKER_SKILL_BINDINGS) as Array<Exclude<CapabilityWorkerName, "chusky">>;
  const workerBySkill = new Map<string, Array<Exclude<CapabilityWorkerName, "chusky">>>();
  const invalidBindings: Array<{ worker: string; skill: string }> = [];

  for (const worker of workers) {
    for (const skill of bindingNames(WORKER_SKILL_BINDINGS[worker])) {
      const identifier = installed.find((candidate) => candidate.name === skill || candidate.directory === skill);
      if (!identifier) {
        invalidBindings.push({ worker, skill });
        continue;
      }
      const owners = workerBySkill.get(identifier.directory) ?? [];
      owners.push(worker);
      workerBySkill.set(identifier.directory, owners);
    }
  }

  const entries = installed.map(({ name, directory }) => {
    const owners = workerBySkill.get(directory) ?? [];
    const isRouted = routed.has(directory) || routed.has(name);
    const status: SkillCoverageStatus = owners.length && isRouted
      ? "bound-and-routed"
      : owners.length
        ? "bound"
        : isRouted
          ? "routed-only"
          : "dynamic-only";
    return { name: directory, status, workers: owners };
  });

  return { entries, invalidBindings };
}
