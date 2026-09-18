import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SKILLS_ROOT = path.resolve(process.cwd(), ".chusky", "skills");
const MAX_SKILLS = 200;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_CHARS = 24_000;
const STOP_WORDS = new Set(["a", "an", "and", "are", "can", "create", "for", "how", "i", "in", "is", "it", "make", "of", "on", "the", "to", "use", "with"]);

export type SkillManifest = {
  name: string;
  description: string;
  directory: string;
  skillPath: string;
  body: string;
  bodyExcerpt: string;
  bytes: number;
  updatedAt: number;
};

export type SkillSearchResult = {
  name: string;
  description: string;
  path: string;
  score: number;
  files: number;
};

export type SkillFile = {
  path: string;
  bytes: number;
  binary: boolean;
};

export type SkillFileContent = SkillFile & {
  name: string;
  content?: string;
  truncated: boolean;
};

export type SkillBinding = {
  /** Skills that define the worker's default operating method. */
  primary: string[];
  /** Skills added when the worker's objective needs adjacent guidance. */
  supporting: string[];
  /** Bounded nested references that must accompany a named skill. */
  requiredReferences?: Record<string, string[]>;
};

/**
 * Product skills that must be routable without relying on fuzzy catalogue
 * search. The trigger list is intentionally small and business-oriented: it
 * selects operating guidance, never permissions or tools.
 */
const ROUTED_SKILLS: Array<{ name: string; triggers: string[] }> = [
  { name: "attention-pulse", triggers: ["attention pulse", "standing order", "open loop", "proactive", "overdue loop", "next action", "digest"] },
  { name: "composio-routing", triggers: ["composio", "connected app", "toolkit", "hubspot", "salesforce", "stripe", "shopify", "zendesk", "intercom"] },
  { name: "onboarding-pro", triggers: ["onboarding", "implementation", "activate customer", "customer setup"] },
  { name: "retention-pro", triggers: ["retention", "renewal", "churn", "churn risk", "customer health"] },
  { name: "billing-ops-pro", triggers: ["billing", "invoice", "collections", "payment", "subscription", "stripe"] },
  { name: "support-desk-pro", triggers: ["support", "ticket", "zendesk", "intercom", "incident", "customer issue"] },
  { name: "launch-pro", triggers: ["launch", "go to market", "release campaign", "product launch"] },
  { name: "hiring-pipeline-pro", triggers: ["hiring", "recruiting", "candidate", "interview", "job opening"] },
  { name: "expansion-pro", triggers: ["expansion", "upsell", "cross-sell", "account growth", "renewal expansion"] },
];

function normalizedQuery(query: string): string {
  return String(query ?? "").toLowerCase().replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Return deterministic business skill names for the current request. */
export function routedSkillNames(query: string): string[] {
  const text = normalizedQuery(query);
  if (!text) return [];
  return ROUTED_SKILLS.filter(({ name, triggers }) => text.includes(name) || triggers.some((trigger) => text.includes(trigger))).map(({ name }) => name);
}

/**
 * Load deterministic business routing first, then the existing bounded fuzzy
 * discovery fallback. This is used for the supervisor system prompt; workers
 * continue to use their explicit SkillBinding.
 */
export async function routedSkillContext(query: string, root = DEFAULT_SKILLS_ROOT): Promise<string> {
  const names = routedSkillNames(query);
  return skillContextForBinding({ primary: names, supporting: [] }, query, root);
}

type CatalogCache = { signature: string; skills: SkillManifest[] };
const cache = new Map<string, CatalogCache>();

function safeSkillName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) throw new Error("Skill name is invalid");
  return name;
}

function safeRelativePath(value: unknown): string {
  const raw = String(value ?? "SKILL.md").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.includes("\0")) throw new Error("Skill file path must be relative to the skill directory");
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Skill file path cannot contain empty, '.' or '..' segments");
  return segments.join("/");
}

function parseFrontmatter(content: string, file: string): { name: string; description: string; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Skill '${file}' is missing YAML frontmatter`);
  const values = new Map<string, string>();
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Only top-level YAML keys are relevant to the skill manifest. Indented
    // lines belong to a block scalar or nested metadata and must not become
    // accidental manifest fields.
    if (!line || /^\s/.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const block = value.match(/^([>|])[-+]?$/);
    if (block) {
      const continuation: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        index += 1;
        continuation.push(next.trim());
      }
      value = block[1] === ">" ? continuation.join(" ").replace(/\s+/g, " ").trim() : continuation.join("\n").trim();
    }
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key) values.set(key, value);
  }
  const name = safeSkillName(values.get("name"));
  const description = values.get("description")?.trim();
  if (!description || description.length > 2000) throw new Error(`Skill '${name}' needs a description of 1-2000 characters`);
  return { name, description, body: content.slice(match[0].length) };
}

function isBinary(bytes: Buffer, relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf|docx|pptx|xlsx|zip|mp[34]|wav|ogg|woff2?|ttf)$/.test(lower)) return true;
  return bytes.subarray(0, Math.min(bytes.length, 4096)).includes(0);
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function skillDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries.slice(0, MAX_SKILLS)) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const info = await lstat(directory);
    if (info.isSymbolicLink()) continue;
    directories.push(directory);
  }
  return directories;
}

async function loadCatalog(root = DEFAULT_SKILLS_ROOT): Promise<SkillManifest[]> {
  const resolvedRoot = path.resolve(root);
  let directories: string[];
  try { directories = await skillDirectories(resolvedRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(directories.map(async (directory) => {
    const skillPath = path.join(directory, "SKILL.md");
    try {
      const info = await lstat(skillPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKILL_FILE_BYTES) return undefined;
      return { directory, skillPath, size: info.size, updatedAt: info.mtimeMs };
    } catch { return undefined; }
  }));
  const signature = files.filter(Boolean).map((file) => `${file!.skillPath}:${file!.size}:${file!.updatedAt}`).join("|");
  const previous = cache.get(resolvedRoot);
  if (previous?.signature === signature) return previous.skills;
  const skills: SkillManifest[] = [];
  for (const file of files) {
    if (!file) continue;
    try {
      const content = await readFile(file.skillPath, "utf8");
      const parsed = parseFrontmatter(content, path.basename(file.directory));
      skills.push({ name: parsed.name, description: parsed.description, directory: file.directory, skillPath: file.skillPath, body: content, bodyExcerpt: content.slice(0, 6000), bytes: file.size, updatedAt: file.updatedAt });
    } catch {
      // An invalid installed skill is omitted from automatic selection. The
      // explicit read tool reports a useful error when the user names it.
    }
  }
  cache.set(resolvedRoot, { signature, skills });
  return skills;
}

function terms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).filter((term) => term.length > 1 && !STOP_WORDS.has(term)))];
}

export async function searchSkills(query: string, limit = 5, root = DEFAULT_SKILLS_ROOT): Promise<SkillSearchResult[]> {
  const skills = await loadCatalog(root);
  const phrase = String(query ?? "").toLowerCase().trim();
  // A broad skills question should list the catalogue instead of requiring
  // every skill description to contain the literal word "skills".
  const broadQuery = /^(?:(?:what|which|show|list|tell me about)\s+)?(?:available\s+)?skills?\s*(?:do you have|are available|list)?[?!.]*$/i.test(phrase)
    || /^(?:what|which)\s+capabilities\s+do\s+you\s+have[?!.]*$/i.test(phrase);
  const requested = broadQuery ? [] : terms(query);
  const scored = skills.map((skill) => {
    const name = skill.name.toLowerCase();
    const description = skill.description.toLowerCase();
    const excerpt = skill.bodyExcerpt.toLowerCase();
    let score = phrase && description.includes(phrase) ? 8 : 0;
    for (const term of requested) {
      if (name.includes(term)) score += 8;
      if (description.includes(term)) score += 4;
      if (excerpt.includes(term)) score += 1;
    }
    return { skill, score };
  }).filter(({ score }) => !requested.length || score > 0).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  const boundedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 5), 20));
  return scored.slice(0, boundedLimit).map(({ skill, score }) => ({ name: skill.name, description: skill.description, path: `.chusky/skills/${path.basename(skill.directory)}/SKILL.md`, score, files: 0 }));
}

async function getSkill(name: string, root: string): Promise<SkillManifest> {
  const requested = safeSkillName(name);
  const skill = (await loadCatalog(root)).find((candidate) => candidate.name === requested || path.basename(candidate.directory) === requested);
  if (!skill) throw new Error(`Skill '${requested}' was not found in the trusted project skills directory`);
  return skill;
}

export async function listSkillFiles(name: string, maxFiles = 100, root = DEFAULT_SKILLS_ROOT): Promise<SkillFile[]> {
  const skill = await getSkill(name, root);
  const bounded = Math.max(1, Math.min(Math.floor(Number(maxFiles) || 100), 200));
  const result: SkillFile[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || result.length >= bounded) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= bounded) break;
      const candidate = path.join(directory, entry.name);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(candidate, depth + 1);
      else if (info.isFile() && info.size <= MAX_SKILL_FILE_BYTES) {
        const relative = path.relative(skill.directory, candidate).replace(/\\/g, "/");
        const bytes = await readFile(candidate);
        result.push({ path: relative, bytes: info.size, binary: isBinary(bytes, relative) });
      }
    }
  };
  await visit(skill.directory, 0);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readSkillFile(name: string, requestedPath = "SKILL.md", maxChars = 12_000, root = DEFAULT_SKILLS_ROOT): Promise<SkillFileContent> {
  const skill = await getSkill(name, root);
  const relative = safeRelativePath(requestedPath);
  const candidate = path.resolve(skill.directory, ...relative.split("/"));
  if (!inside(skill.directory, candidate)) throw new Error("Skill file path escapes the skill directory");
  const info = await lstat(candidate).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Skill file '${relative}' was not found or is not a regular file`);
  if (info.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill file '${relative}' exceeds the ${MAX_SKILL_FILE_BYTES}-byte read limit`);
  const bytes = await readFile(candidate);
  const binary = isBinary(bytes, relative);
  if (binary) return { name: skill.name, path: relative, bytes: info.size, binary: true, truncated: false };
  const max = Math.max(1, Math.min(Math.floor(Number(maxChars) || 12_000), MAX_SKILL_FILE_BYTES));
  const content = bytes.toString("utf8");
  return { name: skill.name, path: relative, bytes: info.size, binary: false, content: content.slice(0, max), truncated: content.length > max };
}

export async function relevantSkillContext(query: string, root = DEFAULT_SKILLS_ROOT): Promise<string> {
  const matches = await searchSkills(query, 3, root);
  if (!matches.length) return "";
  const skills = await loadCatalog(root);
  let remaining = MAX_CONTEXT_CHARS;
  const blocks: string[] = [];
  for (const match of matches) {
    const skill = skills.find((candidate) => candidate.name === match.name);
    if (!skill || remaining <= 0) continue;
    const content = skill.body.slice(0, Math.min(12_000, remaining));
    blocks.push(`### ${skill.name}\n${content}`);
    remaining -= content.length;
  }
  return blocks.join("\n\n");
}

/**
 * Load a worker's declared skills deterministically, then add a small amount
 * of objective-based discovery as a fallback. Explicit bindings are ordered
 * first and their required nested references are included inside the same
 * bounded context budget.
 */
export async function skillContextForBinding(binding: SkillBinding, query = "", root = DEFAULT_SKILLS_ROOT): Promise<string> {
  const primary = [...new Set(binding.primary.map((name) => name.trim()).filter(Boolean))];
  const supporting = [...new Set(binding.supporting.map((name) => name.trim()).filter((name) => name && !primary.includes(name)))];
  const explicit = [...primary, ...supporting];
  const fallback = query
    ? (await searchSkills(query, 3, root)).map((match) => match.name).filter((name) => !explicit.includes(name))
    : [];
  const selected = [...explicit, ...fallback];
  if (!selected.length) return "";

  const skills = await loadCatalog(root);
  const blocks: string[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (let index = 0; index < selected.length && remaining > 0; index += 1) {
    const name = selected[index];
    const skill = skills.find((candidate) => candidate.name === name || path.basename(candidate.directory) === name);
    if (!skill) continue;

    const remainingSkills = selected.length - index;
    const skillBudget = Math.min(6_500, Math.max(2_000, Math.floor(remaining / remainingSkills)));
    const referencePaths = binding.requiredReferences?.[skill.name] ?? binding.requiredReferences?.[path.basename(skill.directory)] ?? [];
    const referenceBlocks: string[] = [];
    let referenceBudget = Math.min(3_000, Math.floor(skillBudget * 0.45));
    for (const referencePath of referencePaths) {
      if (referenceBudget <= 0) break;
      try {
        const reference = await readSkillFile(skill.name, referencePath, referenceBudget, root);
        if (!reference.content) continue;
        const content = reference.content.slice(0, referenceBudget);
        referenceBlocks.push(`\nReference: ${reference.path}\n${content}`);
        referenceBudget -= content.length;
      } catch {
        // A missing optional reference must not prevent the worker from using
        // the primary skill or objective-based fallback context.
      }
    }

    const referenceText = referenceBlocks.join("\n");
    const bodyBudget = Math.max(1_000, skillBudget - referenceText.length);
    const role = primary.includes(skill.name) ? "primary" : "supporting";
    const block = `### ${skill.name} (${role})\n${skill.body.slice(0, bodyBudget)}${referenceText}`;
    blocks.push(block.slice(0, remaining));
    remaining -= Math.min(remaining, block.length);
  }
  return blocks.join("\n\n");
}

export function clearSkillCatalogCache(): void { cache.clear(); }
