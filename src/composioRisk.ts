import type { ToolApprovalPolicy } from "./policy.js";

type ComposioRiskMetadata = { readOnly?: boolean; destructive?: boolean; requiresApproval?: boolean; risk?: string };
const metadataBySlug = new Map<string, ComposioRiskMetadata>();
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const boolean = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;

/** Register standard MCP/OpenAI annotations and provider risk extensions. */
export function registerComposioToolMetadata(tool: unknown): void {
  const root = object(tool);
  if (!root) return;
  const fn = object(root.function);
  const annotations = object(root.annotations) ?? object(fn?.annotations);
  const metadata = object(root.metadata) ?? object(fn?.metadata);
  const slug = String(fn?.name ?? root.name ?? "").trim();
  if (!slug) return;
  const readOnly = boolean(annotations?.readOnlyHint) ?? boolean(metadata?.readOnly) ?? boolean(metadata?.read_only) ?? boolean(root["x-read-only"]);
  const destructive = boolean(annotations?.destructiveHint) ?? boolean(metadata?.destructive) ?? boolean(metadata?.destructive_action) ?? boolean(root["x-destructive"]);
  const requiresApproval = boolean(metadata?.requiresApproval) ?? boolean(metadata?.requires_approval) ?? boolean(root["x-requires-approval"]);
  const risk = text(metadata?.risk) ?? text(root["x-chusky-risk"]);
  if (readOnly === undefined && destructive === undefined && requiresApproval === undefined && risk === undefined) return;
  metadataBySlug.set(slug.toUpperCase(), { readOnly, destructive, requiresApproval, risk });
}

export function clearComposioToolMetadata(): void { metadataBySlug.clear(); }

export function composioMetadataPolicy(slug: string): ToolApprovalPolicy | undefined {
  const metadata = metadataBySlug.get(slug.trim().toUpperCase());
  if (!metadata) return undefined;
  if (metadata.requiresApproval === true || metadata.destructive === true) return "approval_required";
  if (metadata.readOnly === true || ["read", "readonly", "read_only", "safe"].includes(metadata.risk ?? "")) return "private";
  if (["critical", "high", "write", "side_effect", "side_effecting"].includes(metadata.risk ?? "")) return "approval_required";
  // Neutral annotations such as readOnlyHint: false do not decide the policy.
  // Let the central classifier distinguish routine writes from high-impact
  // payments, deletions, permissions, and pushes.
  return undefined;
}
