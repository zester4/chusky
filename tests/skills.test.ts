import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearSkillCatalogCache, listSkillFiles, readSkillFile, relevantSkillContext, routedSkillNames, searchSkills, skillContextForBinding } from "../src/skills/catalog.js";
import { WORKER_CAPABILITIES } from "../src/subagents/capabilities.js";
import { WORKER_SKILL_BINDINGS } from "../src/subagents/skillBindings.js";
import { getSkillCoverage } from "../src/subagents/skillCoverage.js";

test("routes sold business skills deterministically before fuzzy discovery", () => {
  assert.deepEqual(routedSkillNames("Review overdue Stripe billing and hand off the churn-risk account"), ["composio-routing", "retention-pro", "billing-ops-pro"]);
});

test("routes core engineering and growth skills deterministically", () => {
  const eng = routedSkillNames("Implement a Next.js feature with TDD and code review");
  assert.ok(eng.includes("fullstack-dev"));
  assert.ok(eng.includes("tdd"));
  assert.ok(eng.includes("code-review"));
  const growth = routedSkillNames("Run an SEO audit and plan cold email lead magnets");
  assert.ok(growth.includes("seo-audit"));
  assert.ok(growth.includes("cold-email"));
  assert.ok(growth.includes("lead-magnets"));
  const meet = routedSkillNames("Join the Zoom sales meeting and handle objections");
  assert.ok(meet.includes("meeting-pro"));
});

test("skillBindings preloads expanded library skills", () => {
  assert.ok(WORKER_SKILL_BINDINGS.leo.primary.includes("video-editing"));
  assert.ok(!WORKER_SKILL_BINDINGS.leo.primary.includes("openrouter-video-editing"));
  assert.ok(WORKER_SKILL_BINDINGS.lucas.supporting.includes("senior-fullstack"));
  assert.ok(WORKER_SKILL_BINDINGS.lucas.supporting.includes("tdd"));
  assert.ok(WORKER_SKILL_BINDINGS.maya.supporting.includes("seo-audit"));
  assert.ok(WORKER_SKILL_BINDINGS.aria.primary.includes("onboarding-pro"));
  assert.ok(WORKER_SKILL_BINDINGS.aria.primary.includes("retention-pro"));
  assert.ok(WORKER_SKILL_BINDINGS.lucas.supporting.includes("ui-ux-pro-max"));
  assert.ok(WORKER_SKILL_BINDINGS.lucas.supporting.includes("pdf-generation"));
  assert.ok(WORKER_SKILL_BINDINGS.ivy.supporting.includes("hiring-pipeline-pro"));
  assert.ok(WORKER_SKILL_BINDINGS.kai.supporting.includes("xlsx-generation"));
});

test("skill coverage reports invalid bindings and distinguishes routing from preloads", async () => {
  const report = await getSkillCoverage();
  assert.deepEqual(report.invalidBindings, []);

  const byName = new Map(report.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("hiring-pipeline-pro")?.status, "bound-and-routed");
  assert.ok(byName.get("ui-ux-pro-max")?.workers.includes("lucas"));
  assert.equal(byName.get("composio-routing")?.status, "routed-only");
  assert.equal(byName.get("building-games")?.status, "dynamic-only");
});

test("runtime worker manifests use the expanded shared skill bindings", () => {
  const workers = ["lucas", "maya", "leo", "sofia", "dexter", "elena", "nora", "ivy", "quinn", "aria", "kai"] as const;
  for (const worker of workers) assert.equal(WORKER_CAPABILITIES[worker].skills, WORKER_SKILL_BINDINGS[worker]);
});

test("loads Aria's onboarding and retention references for a customer-success objective", async () => {
  const context = await skillContextForBinding(WORKER_SKILL_BINDINGS.aria, "Recover an onboarding milestone and review churn risk");
  assert.match(context, /Reference: references\/01-client-onboarding\.md/);
  assert.match(context, /Reference: references\/01-health\.md/);
  assert.match(context, /Blockers become open loops/);
  assert.match(context, /Do not average away a single red signal/);
});

test("loads Quinn's expansion and billing references for a revenue objective", async () => {
  const context = await skillContextForBinding(WORKER_SKILL_BINDINGS.quinn, "Review expansion readiness and overdue invoices");
  assert.match(context, /Reference: references\/01-readiness\.md/);
  assert.match(context, /Reference: references\/01-invoices\.md/);
  assert.match(context, /If blocked, route to retention\/onboarding first/);
  assert.match(context, /Prefer source system of truth/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chusky-skills-"));
  await mkdir(path.join(root, "spreadsheets", "references"), { recursive: true });
  await mkdir(path.join(root, "spreadsheets", "assets"), { recursive: true });
  await writeFile(path.join(root, "spreadsheets", "SKILL.md"), "---\nname: spreadsheets\ndescription: >\n  Create professional Excel workbooks with formulas and charts.\n  Keep tables readable and avoid overlapping content.\n---\n\nUse wrapped cells and verify every sheet.\nSee `references/formatting.md` for column sizing.\n", "utf8");
  await writeFile(path.join(root, "spreadsheets", "references", "formatting.md"), "Set explicit widths and wrap long labels.", "utf8");
  await writeFile(path.join(root, "spreadsheets", "assets", "template.png"), Buffer.from([137, 80, 78, 71]));
  return root;
}

test("searches skill metadata and loads matching guidance", async () => {
  const root = await fixture();
  try {
    const matches = await searchSkills("professional Excel workbook", 5, root);
    assert.equal(matches[0]?.name, "spreadsheets");
    assert.match(matches[0]?.description ?? "", /Keep tables readable/);
    const context = await relevantSkillContext("create a workbook", root);
    assert.match(context, /wrapped cells/);
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("lists nested resources and reads only files inside the skill", async () => {
  const root = await fixture();
  try {
    const files = await listSkillFiles("spreadsheets", 20, root);
    assert.deepEqual(files.map((file) => file.path), ["assets/template.png", "references/formatting.md", "SKILL.md"]);
    const reference = await readSkillFile("spreadsheets", "references/formatting.md", 100, root);
    assert.equal(reference.content, "Set explicit widths and wrap long labels.");
    await assert.rejects(() => readSkillFile("spreadsheets", "../SKILL.md", 100, root), /cannot contain/);
    const binary = await readSkillFile("spreadsheets", "assets/template.png", 100, root);
    assert.equal(binary.binary, true);
    assert.equal(binary.content, undefined);
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("loads explicitly bound skills and required references before objective fallback", async () => {
  const root = await fixture();
  try {
    const context = await skillContextForBinding({
      primary: ["spreadsheets"],
      supporting: [],
      requiredReferences: { spreadsheets: ["references/formatting.md"] },
    }, "unrelated query", root);
    assert.match(context, /### spreadsheets \(primary\)/);
    assert.match(context, /Reference: references\/formatting\.md/);
    assert.match(context, /Set explicit widths/);
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("lists broad skill questions and returns the real directory path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chusky-skills-broad-"));
  try {
    await mkdir(path.join(root, "video-editing"), { recursive: true });
    await writeFile(path.join(root, "video-editing", "SKILL.md"), "---\nname: openrouter-video-editing\ndescription: Generate and edit videos.\n---\n\nUse the video workflow.", "utf8");
    const matches = await searchSkills("What skills do you have?", 20, root);
    assert.equal(matches[0]?.name, "openrouter-video-editing");
    assert.equal(matches[0]?.path, ".chusky/skills/video-editing/SKILL.md");
  } finally {
    clearSkillCatalogCache();
    await rm(root, { recursive: true, force: true });
  }
});
