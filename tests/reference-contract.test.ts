import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".chusky/skills");

async function readReference(skill: string, file: string) {
  return readFile(path.join(root, skill, "references", file), "utf8");
}

test("updated skill entrypoints keep every referenced playbook resolvable", async () => {
  const skills = [
    "browser-pro",
    "composio-routing",
    "computer-pro",
    "deal-closer-pro",
    "decision-pro",
    "expansion-pro",
    "launch-pro",
    "lead-intel-pro",
    "lead-magnets",
    "meeting-pro",
    "memory-pro",
    "mission-pro",
  ];

  for (const skill of skills) {
    const entrypoint = await readFile(path.join(root, skill, "SKILL.md"), "utf8");
    const references = [...entrypoint.matchAll(/references\/([\w.-]+\.md)/g)].map((match) => match[1]);
    assert.ok(references.length > 0, `${skill} should name its references`);
    for (const reference of new Set(references)) {
      await access(path.join(root, skill, "references", reference));
    }
  }
});

test("meeting modes inherit one shared live runtime contract", async () => {
  const files = (await readdir(path.join(root, "meeting-pro", "references"))).filter(
    (file) => file.endsWith(".md") && file !== "00-live-runtime-contract.md",
  );
  assert.equal(files.length, 13);
  const shared = await readReference("meeting-pro", "00-live-runtime-contract.md");
  assert.match(shared, /Jev's route bundle/);
  assert.match(shared, /proposed, discussed, agreed, approved, rejected, and completed/);
  assert.match(shared, /drafting\s+follow-up is separate from sending it/i);
  for (const file of files) {
    const content = await readReference("meeting-pro", file);
    assert.match(content, /00-live-runtime-contract\.md/, `${file} must inherit the shared contract`);
  }
});

test("memory and mission references preserve durable-state boundaries", async () => {
  const scope = await readReference("memory-pro", "scope-matrix.md");
  assert.doesNotMatch(scope, /It should become global memory automatically/);
  assert.match(scope, /Promotion from meeting\/call\/conversation scope requires/);

  const memory = await readReference("memory-pro", "save-and-retrieve.md");
  assert.match(memory, /canonical store confirms it/);
  assert.match(memory, /vector results are projections/);

  const mission = await readReference("mission-pro", "04-tools-and-stack.md");
  assert.match(mission, /reuse a verified route/i);
  assert.match(mission, /provider read-back/);
});

test("reference guidance treats benchmarks and external data as evidence", async () => {
  const benchmarks = await readReference("lead-magnets", "benchmarks.md");
  assert.match(benchmarks, /directional hypotheses/);
  assert.match(benchmarks, /Do not invent testimonials/);

  const treg = await readReference("lead-intel-pro", "05-treg-tooling.md");
  assert.match(treg, /Jev may provide the Treg route/);
  assert.match(treg, /runtime's exact tool schema/);
});
