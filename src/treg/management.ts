import { isIP } from "node:net";

/**
 * Explicit customer-facing Treg management routes. This registry intentionally
 * excludes Treg platform-admin/auth endpoints and operations that return a
 * one-time credential or accept secret material from the model.
 */
export const TREG_ADMIN_READ_ACTIONS = [
  "orgs.list", "orgs.get", "orgs.members", "orgs.invites", "orgs.projects", "orgs.agents",
  "orgs.api_keys", "orgs.api_key_spend", "orgs.api_key_events", "orgs.budgets", "orgs.deny_rules",
  "orgs.pins", "orgs.settings", "orgs.usage", "orgs.usage_by_tag", "orgs.usage_spend",
  "orgs.balance", "orgs.provider_resources", "orgs.tag_keys", "orgs.cli_deny",
  "account.activity", "account.billing", "account.billing_history", "account.calls", "account.call",
  "account.call_result", "account.runs", "account.usage", "account.invites", "account.connections",
  "account.secrets", "account.tools", "account.tool", "account.bundles", "account.bundle",
  "account.skill_samples", "account.health", "account.oauth_providers", "account.own_hub_tools",
  "account.hub_tool", "account.hub_tool_earnings", "account.hub_tool_health", "account.hub_run",
  "catalog.platforms", "catalog.provider", "catalog.find", "account.meta", "account.referrals",
  "account.bundle_by_name", "orgs.agents_observed", "orgs.agent_connection",
  "catalog.platform", "catalog.search", "catalog.endpoint", "account.feedback",
  "account.connection_resources",
] as const;

export const TREG_ADMIN_WRITE_ACTIONS = [
  "orgs.create", "orgs.rename", "orgs.delete", "orgs.leave", "orgs.invite_create", "orgs.invite_revoke",
  "orgs.invite_accept", "orgs.member_remove", "orgs.member_role", "orgs.member_access", "orgs.member_cap",
  "orgs.budget_default_set", "orgs.budget_set", "orgs.budget_delete", "orgs.deny_create", "orgs.deny_delete",
  "orgs.pin_set", "orgs.pin_clear", "orgs.project_create", "orgs.project_delete", "orgs.settings_update",
  "orgs.api_key_rename", "orgs.api_key_disable", "orgs.api_key_enable", "orgs.api_key_hide", "orgs.api_key_revoke",
  "orgs.agent_revoke", "account.connection_rename", "account.connection_revoke", "account.secret_delete",
  "account.tool_delete", "account.bundle_update", "account.bundle_delete", "account.billing_topup",
  "account.billing_autotopup", "account.health_run", "account.feedback_submit", "account.hub_tool_retire",
  "account.hub_tool_price", "account.tool_create", "account.tool_update", "account.skill_register",
  "account.hub_tool_publish", "account.hub_tool_update", "account.hub_run_start", "account.billing_portal",
  "account.review_submit", "account.referral_code",
  "account.connection_resource_set",
] as const;

export type TregAdminAction = typeof TREG_ADMIN_READ_ACTIONS[number] | typeof TREG_ADMIN_WRITE_ACTIONS[number];
export type TregAdminVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TregAdminRoute {
  method: TregAdminVerb;
  path: string;
  orgScoped?: boolean;
  pathFields?: Record<string, "id" | "memberId" | "projectId" | "dimension" | "value">;
  queryFields?: readonly string[];
  requiredQuery?: readonly string[];
  bodyFields?: readonly string[];
  requiredBody?: readonly string[];
}

const routes: Record<TregAdminAction, TregAdminRoute> = {
  "orgs.list": { method: "GET", path: "/orgs" },
  "orgs.get": { method: "GET", path: "/orgs/{orgId}", orgScoped: true },
  "orgs.members": { method: "GET", path: "/orgs/{orgId}/members", orgScoped: true },
  "orgs.invites": { method: "GET", path: "/orgs/{orgId}/invites", orgScoped: true },
  "orgs.projects": { method: "GET", path: "/orgs/{orgId}/projects", orgScoped: true },
  "orgs.agents": { method: "GET", path: "/orgs/{orgId}/agents", orgScoped: true },
  "orgs.agents_observed": { method: "GET", path: "/orgs/{orgId}/agents/observed", orgScoped: true },
  "orgs.agent_connection": { method: "GET", path: "/orgs/{orgId}/agents/{memberId}/connection", orgScoped: true, pathFields: { memberId: "memberId" }, queryFields: ["api_key_id"] },
  "orgs.api_keys": { method: "GET", path: "/orgs/{orgId}/api-keys", orgScoped: true, queryFields: ["include_hidden"] },
  "orgs.api_key_spend": { method: "GET", path: "/orgs/{orgId}/api-keys/spend", orgScoped: true },
  "orgs.api_key_events": { method: "GET", path: "/orgs/{orgId}/api-keys/{id}/events", orgScoped: true, pathFields: { id: "id" } },
  "orgs.budgets": { method: "GET", path: "/orgs/{orgId}/budgets", orgScoped: true, queryFields: ["dim"] },
  "orgs.deny_rules": { method: "GET", path: "/orgs/{orgId}/deny", orgScoped: true },
  "orgs.pins": { method: "GET", path: "/orgs/{orgId}/pins", orgScoped: true },
  "orgs.settings": { method: "GET", path: "/orgs/{orgId}/settings", orgScoped: true },
  "orgs.usage": { method: "GET", path: "/orgs/{orgId}/usage", orgScoped: true, queryFields: ["days"] },
  "orgs.usage_by_tag": { method: "GET", path: "/orgs/{orgId}/usage/by-tag", orgScoped: true, queryFields: ["key", "days"] },
  "orgs.usage_spend": { method: "GET", path: "/orgs/{orgId}/usage/spend", orgScoped: true, queryFields: ["from", "to", "group", "key", "provider", "stack"] },
  "orgs.balance": { method: "GET", path: "/orgs/{orgId}/balance", orgScoped: true, queryFields: ["limit", "offset"] },
  "orgs.provider_resources": { method: "GET", path: "/orgs/{orgId}/provider-resources", orgScoped: true, queryFields: ["provider", "kind", "include_deleted", "source"] },
  "orgs.tag_keys": { method: "GET", path: "/orgs/{orgId}/tag-keys", orgScoped: true },
  "orgs.cli_deny": { method: "GET", path: "/orgs/{orgId}/policy/cli-deny", orgScoped: true },
  "catalog.platforms": { method: "GET", path: "/catalog/platforms" },
  "catalog.platform": { method: "GET", path: "/catalog/platforms/{id}", pathFields: { id: "id" }, queryFields: ["include_hidden"] },
  "catalog.provider": { method: "GET", path: "/catalog/providers/{id}", pathFields: { id: "id" } },
  "catalog.find": { method: "GET", path: "/catalog/find", queryFields: ["q", "platform"], requiredQuery: ["q"] },
  "catalog.search": { method: "GET", path: "/catalog/search", queryFields: ["q", "limit", "added_within_days", "sort", "engine"], requiredQuery: ["q"] },
  "catalog.endpoint": { method: "GET", path: "/catalog/endpoints/{id}", pathFields: { id: "id" } },
  "account.meta": { method: "GET", path: "/meta" },
  "account.activity": { method: "GET", path: "/activity", queryFields: ["limit", "before"] },
  "account.billing": { method: "GET", path: "/billing" },
  "account.billing_history": { method: "GET", path: "/billing/history", queryFields: ["limit"] },
  "account.calls": { method: "GET", path: "/calls", queryFields: ["limit", "days", "before_id", "api_key_id"] },
  "account.call": { method: "GET", path: "/calls/{id}", pathFields: { id: "id" } },
  "account.call_result": { method: "GET", path: "/calls/{id}/result", pathFields: { id: "id" } },
  "account.runs": { method: "GET", path: "/runs", queryFields: ["limit", "api_key_id"] },
  "account.usage": { method: "GET", path: "/usage/me" },
  "account.invites": { method: "GET", path: "/invites/mine" },
  "account.connections": { method: "GET", path: "/connections" },
  "account.secrets": { method: "GET", path: "/secrets" },
  "account.tools": { method: "GET", path: "/tools" },
  "account.tool": { method: "GET", path: "/tools/by-name/{id}", pathFields: { id: "id" } },
  "account.bundles": { method: "GET", path: "/bundles" },
  "account.bundle": { method: "GET", path: "/bundles/{id}", pathFields: { id: "id" } },
  "account.bundle_by_name": { method: "GET", path: "/bundles/by-name/{id}", pathFields: { id: "id" } },
  "account.skill_samples": { method: "GET", path: "/skills/samples" },
  "account.health": { method: "GET", path: "/health" },
  "account.oauth_providers": { method: "GET", path: "/oauth/providers" },
  "account.referrals": { method: "GET", path: "/referrals" },
  "account.own_hub_tools": { method: "GET", path: "/hub/tools/mine" },
  "account.hub_tool": { method: "GET", path: "/hub/tools/{id}", pathFields: { id: "id" } },
  "account.hub_tool_earnings": { method: "GET", path: "/hub/tools/{id}/earnings", pathFields: { id: "id" }, queryFields: ["days", "format"] },
  "account.hub_tool_health": { method: "GET", path: "/hub/tools/{id}/health", pathFields: { id: "id" } },
  "account.hub_run": { method: "GET", path: "/hub/runs/{id}", pathFields: { id: "id" } },

  "orgs.create": { method: "POST", path: "/orgs", bodyFields: ["name"], requiredBody: ["name"] },
  "orgs.rename": { method: "PATCH", path: "/orgs/{orgId}", orgScoped: true, bodyFields: ["name", "slug"] },
  "orgs.delete": { method: "DELETE", path: "/orgs/{orgId}", orgScoped: true, queryFields: ["confirm"] },
  "orgs.leave": { method: "POST", path: "/orgs/{orgId}/leave", orgScoped: true },
  "orgs.invite_create": { method: "POST", path: "/orgs/{orgId}/invites", orgScoped: true, bodyFields: ["email", "role", "expires_days", "tool_access", "project_access", "local_run_enabled", "landing"], requiredBody: ["email"] },
  "orgs.invite_revoke": { method: "DELETE", path: "/orgs/{orgId}/invites/{id}", orgScoped: true, pathFields: { id: "id" } },
  "orgs.invite_accept": { method: "POST", path: "/invites/{id}/accept", pathFields: { id: "id" } },
  "orgs.member_remove": { method: "DELETE", path: "/orgs/{orgId}/members/{memberId}", orgScoped: true, pathFields: { memberId: "memberId" } },
  "orgs.member_role": { method: "PATCH", path: "/orgs/{orgId}/members/{memberId}", orgScoped: true, pathFields: { memberId: "memberId" }, bodyFields: ["role"], requiredBody: ["role"] },
  "orgs.member_access": { method: "PATCH", path: "/orgs/{orgId}/members/{memberId}/access", orgScoped: true, pathFields: { memberId: "memberId" }, bodyFields: ["tool_access", "project_access", "local_run_enabled"] },
  "orgs.member_cap": { method: "PATCH", path: "/orgs/{orgId}/members/{memberId}/cap", orgScoped: true, pathFields: { memberId: "memberId" }, bodyFields: ["daily_call_cap"] },
  "orgs.budget_default_set": { method: "PUT", path: "/orgs/{orgId}/budgets/{dimension}", orgScoped: true, pathFields: { dimension: "dimension" }, bodyFields: ["daily_cap_micro", "monthly_cap_micro", "calls_per_day", "status", "note"] },
  "orgs.budget_set": { method: "PUT", path: "/orgs/{orgId}/budgets/{dimension}/{value}", orgScoped: true, pathFields: { dimension: "dimension", value: "value" }, bodyFields: ["daily_cap_micro", "monthly_cap_micro", "calls_per_day", "status", "note"] },
  "orgs.budget_delete": { method: "DELETE", path: "/orgs/{orgId}/budgets/{dimension}/{value}", orgScoped: true, pathFields: { dimension: "dimension", value: "value" } },
  "orgs.deny_create": { method: "POST", path: "/orgs/{orgId}/deny", orgScoped: true, bodyFields: ["host", "path_prefix", "method", "user_id", "project_id", "note"] },
  "orgs.deny_delete": { method: "DELETE", path: "/orgs/{orgId}/deny/{id}", orgScoped: true, pathFields: { id: "id" } },
  "orgs.pin_set": { method: "POST", path: "/orgs/{orgId}/pins", orgScoped: true, bodyFields: ["capability", "provider"], requiredBody: ["capability", "provider"] },
  "orgs.pin_clear": { method: "DELETE", path: "/orgs/{orgId}/pins", orgScoped: true, queryFields: ["capability"] },
  "orgs.project_create": { method: "POST", path: "/orgs/{orgId}/projects", orgScoped: true, bodyFields: ["name"], requiredBody: ["name"] },
  "orgs.project_delete": { method: "DELETE", path: "/orgs/{orgId}/projects/{projectId}", orgScoped: true, pathFields: { projectId: "projectId" } },
  "orgs.settings_update": { method: "PATCH", path: "/orgs/{orgId}/settings", orgScoped: true, bodyFields: ["daily_cap_micro", "platform_overflow", "archive", "budget_dims", "primary_dim"] },
  "orgs.api_key_rename": { method: "PATCH", path: "/orgs/{orgId}/api-keys/{id}", orgScoped: true, pathFields: { id: "id" }, bodyFields: ["name"], requiredBody: ["name"] },
  "orgs.api_key_disable": { method: "POST", path: "/orgs/{orgId}/api-keys/{id}/disable", orgScoped: true, pathFields: { id: "id" } },
  "orgs.api_key_enable": { method: "POST", path: "/orgs/{orgId}/api-keys/{id}/enable", orgScoped: true, pathFields: { id: "id" } },
  "orgs.api_key_hide": { method: "POST", path: "/orgs/{orgId}/api-keys/{id}/hide", orgScoped: true, pathFields: { id: "id" } },
  "orgs.api_key_revoke": { method: "POST", path: "/orgs/{orgId}/api-keys/{id}/revoke", orgScoped: true, pathFields: { id: "id" } },
  "orgs.agent_revoke": { method: "DELETE", path: "/orgs/{orgId}/agents/{memberId}", orgScoped: true, pathFields: { memberId: "memberId" } },
  "account.connection_rename": { method: "PATCH", path: "/connections/{id}", pathFields: { id: "id" }, bodyFields: ["name"], requiredBody: ["name"] },
  "account.connection_revoke": { method: "DELETE", path: "/connections/{id}", pathFields: { id: "id" } },
  "account.secret_delete": { method: "DELETE", path: "/secrets/{id}", pathFields: { id: "id" } },
  "account.tool_delete": { method: "DELETE", path: "/tools/{id}", pathFields: { id: "id" } },
  "account.bundle_update": { method: "PATCH", path: "/bundles/{id}", pathFields: { id: "id" }, bodyFields: ["recipe"], requiredBody: ["recipe"] },
  "account.bundle_delete": { method: "DELETE", path: "/bundles/{id}", pathFields: { id: "id" } },
  "account.billing_topup": { method: "POST", path: "/billing/topup", bodyFields: ["amount_usd", "checkout_source"] },
  "account.billing_autotopup": { method: "POST", path: "/billing/autotopup", bodyFields: ["enabled", "threshold_usd", "amount_usd", "monthly_cap_usd", "per_hour", "setup_url", "consent"], requiredBody: ["enabled"] },
  "account.health_run": { method: "POST", path: "/health/run", queryFields: ["all_orgs"] },
  "account.feedback_submit": { method: "POST", path: "/feedback", bodyFields: ["category", "message", "call_ids", "endpoint_id"], requiredBody: ["category", "message"] },
  "account.feedback": { method: "GET", path: "/feedback/{id}", pathFields: { id: "id" } },
  "account.connection_resources": { method: "GET", path: "/connections/{id}/resources", pathFields: { id: "id" } },
  "account.connection_resource_set": { method: "POST", path: "/connections/{id}/resource", pathFields: { id: "id" }, bodyFields: ["resource_ref", "resource_name"], requiredBody: ["resource_ref"] },
  "account.hub_tool_retire": { method: "DELETE", path: "/hub/tools/{id}", pathFields: { id: "id" } },
  "account.hub_tool_price": { method: "PATCH", path: "/hub/tools/{id}", pathFields: { id: "id" }, bodyFields: ["price_usd", "listed", "public_log"] },
  "account.tool_create": { method: "POST", path: "/tools", bodyFields: ["name", "base_url", "project"], requiredBody: ["name", "base_url"] },
  "account.tool_update": { method: "PATCH", path: "/tools/{id}", pathFields: { id: "id" }, bodyFields: ["name", "project"] },
  "account.skill_register": { method: "POST", path: "/skills", bodyFields: ["name", "recipe"], requiredBody: ["name"] },
  "account.hub_tool_publish": { method: "POST", path: "/hub/tools", bodyFields: ["manifest", "script", "check", "readme", "data"], requiredBody: ["manifest", "check", "readme"] },
  "account.hub_tool_update": { method: "PUT", path: "/hub/tools/{id}", pathFields: { id: "id" }, bodyFields: ["manifest", "script", "check", "readme", "data"], requiredBody: ["manifest", "check", "readme"] },
  "account.hub_run_start": { method: "POST", path: "/hub/run", bodyFields: ["manifest", "script", "check", "readme", "data", "inputs"], requiredBody: ["manifest", "check", "readme"] },
  "account.billing_portal": { method: "POST", path: "/billing/portal" },
  "account.review_submit": { method: "POST", path: "/reviews", bodyFields: ["call_id", "usefulness", "reason"], requiredBody: ["call_id", "usefulness"] },
  "account.referral_code": { method: "POST", path: "/referrals/code" },
};

const readActions = new Set<string>(TREG_ADMIN_READ_ACTIONS);
const writeActions = new Set<string>(TREG_ADMIN_WRITE_ACTIONS);
export function isTregAdminReadAction(action: string): boolean { return readActions.has(action); }
export function isTregAdminWriteAction(action: string): boolean { return writeActions.has(action); }

function cleanSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[/?#\\\u0000-\u001f]/.test(value)) {
    throw new Error(`${field} must be a non-empty identifier of at most 200 characters`);
  }
  return encodeURIComponent(value.trim());
}

function assertSafeValue(value: unknown, path: string, depth = 0): void {
  if (depth > 6) throw new Error("Treg management input is nested too deeply");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) throw new Error(`${path} contains an invalid number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 4_000) throw new Error(`${path} exceeds 4000 characters`);
    if (/\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:sk|pk|rk|ghp|gho|xox[baprs])_[A-Za-z0-9_-]{16,}/i.test(value)) {
      throw new Error(`${path} appears to contain credential material; Treg secrets must be entered through its secure connection flow`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error(`${path} contains too many items`);
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 40) throw new Error(`${path} contains too many fields`);
    for (const [key, item] of entries) {
      if (/(?:^|[_-])(?:secret|token|password|authorization|credential|api[_-]?key)(?:$|[_-])/i.test(key)) {
        throw new Error(`${path}.${key} may contain sensitive credentials and is not accepted`);
      }
      assertSafeValue(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${path} must contain JSON values only`);
}

function validateTypedFields(action: string, body: Record<string, unknown>): void {
  const booleanFields = new Set(["enabled", "local_run_enabled", "setup_url", "consent", "platform_overflow", "archive", "listed", "public_log"]);
  const arrayFields = new Set(["tool_access", "project_access", "budget_dims", "call_ids"]);
  const numericFields = new Set(["amount_usd", "threshold_usd", "monthly_cap_usd", "daily_cap_micro", "monthly_cap_micro", "calls_per_day", "expires_days", "daily_call_cap", "per_hour", "price_usd"]);
  for (const [key, value] of Object.entries(body)) {
    if (booleanFields.has(key) && typeof value !== "boolean") throw new Error(`input.${key} must be a boolean`);
    if (numericFields.has(key) && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000)) {
      throw new Error(`input.${key} must be a non-negative finite number within the supported limit`);
    }
    if (arrayFields.has(key) && (!Array.isArray(value) || value.some((item) => typeof item !== "string" && !(key === "project_access" && typeof item === "number" && Number.isSafeInteger(item))))) {
      throw new Error(`input.${key} must be an array of valid identifiers`);
    }
  }
  for (const key of ["daily_cap_micro", "monthly_cap_micro", "calls_per_day", "expires_days", "daily_call_cap", "per_hour"]) {
    if (body[key] !== undefined && !Number.isSafeInteger(body[key])) throw new Error(`input.${key} must be an integer`);
  }
  for (const key of ["name", "slug", "email", "role", "host", "path_prefix", "method", "note", "primary_dim", "provider", "capability", "checkout_source", "category", "message", "endpoint_id", "usefulness"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") throw new Error(`input.${key} must be a string`);
  }
  for (const key of ["role"]) {
    if (body[key] !== undefined && !["owner", "admin", "member", "viewer"].includes(String(body[key]))) throw new Error(`input.${key} must be one of owner, admin, member, or viewer`);
  }
  if (body.category !== undefined && !["quality", "pricing", "friction", "other"].includes(String(body.category))) {
    throw new Error("input.category must be quality, pricing, friction, or other");
  }
  if (body.usefulness !== undefined && !["useful", "partly", "not_useful", "not_sure"].includes(String(body.usefulness))) {
    throw new Error("input.usefulness must be useful, partly, not_useful, or not_sure");
  }
  if (action === "account.billing_topup") {
    if (typeof body.amount_usd !== "number" || body.amount_usd <= 0 || body.amount_usd > 1_000_000) throw new Error("A Treg top-up requires a positive input.amount_usd within the supported amount limit");
  }
  if (action === "account.tool_create" && body.base_url !== undefined) {
    if (typeof body.base_url !== "string") throw new Error("input.base_url must be an HTTPS URL");
    let url: URL;
    try { url = new URL(body.base_url); } catch { throw new Error("input.base_url must be an HTTPS URL"); }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !hostname || !hostname.includes(".") || isIP(hostname) || /(^|\.)(localhost|local|internal|test|invalid)$/i.test(hostname)) {
      throw new Error("input.base_url must use a public HTTPS host without credentials or a fragment");
    }
  }
  if (["account.skill_register", "account.bundle_update"].includes(action) && body.recipe !== undefined && typeof body.recipe !== "string") {
    throw new Error("input.recipe must be text");
  }
  if (action === "account.billing_autotopup") {
    if (body.enabled === true && (body.consent !== true || typeof body.threshold_usd !== "number" || typeof body.amount_usd !== "number" || typeof body.monthly_cap_usd !== "number")) {
      throw new Error("Enabling auto top-up requires explicit consent and threshold, amount, and monthly cap values");
    }
    if (body.enabled === true && ((body.threshold_usd as number) <= 0 || (body.amount_usd as number) <= 0 || (body.monthly_cap_usd as number) < (body.amount_usd as number))) {
      throw new Error("Auto top-up threshold and amount must be positive, and the monthly cap must cover one top-up");
    }
  }
}

export function buildTregAdminRequest(action: string, args: Record<string, unknown>): {
  method: TregAdminVerb;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
  orgId?: string;
  isRead: boolean;
} {
  const route = routes[action as TregAdminAction];
  if (!route) throw new Error(`Unsupported Treg management action: ${action}`);
  const isRead = readActions.has(action);
  if (!isRead && !writeActions.has(action)) throw new Error(`Unsupported Treg management action: ${action}`);

  const orgId = route.orgScoped ? cleanSegment(args.orgId, "orgId") : undefined;
  const rawOrgId = route.orgScoped && typeof args.orgId === "string" ? args.orgId.trim() : undefined;
  let path = route.path.replace("{orgId}", orgId ?? "");
  for (const [pathKey, argKey] of Object.entries(route.pathFields ?? {})) {
    path = path.replace(`{${pathKey}}`, cleanSegment(args[argKey], argKey));
  }
  if (/[{}]/.test(path)) throw new Error(`Treg management action ${action} is missing a required path identifier`);

  const rawQuery = args.query === undefined ? {} : args.query;
  if (!rawQuery || typeof rawQuery !== "object" || Array.isArray(rawQuery)) throw new Error("query must be an object");
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(rawQuery as Record<string, unknown>)) {
    if (!route.queryFields?.includes(key)) throw new Error(`Query field ${key} is not supported for Treg action ${action}`);
    if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) throw new Error(`query.${key} must be a string, number, or boolean`);
    assertSafeValue(value, `query.${key}`);
    if (["limit", "offset", "days"].includes(key) && (typeof value !== "number" || !Number.isInteger(value)
      || value < (key === "offset" ? 0 : 1) || value > (key === "limit" ? 1000 : 3650))) {
      throw new Error(`query.${key} must be a whole number within the supported range`);
    }
    if (["include_hidden", "include_deleted", "all_orgs", "confirm"].includes(key) && typeof value !== "boolean") {
      throw new Error(`query.${key} must be a boolean`);
    }
    if (action === "account.health_run" && key === "all_orgs" && value === true) {
      throw new Error("Cross-organization Treg health runs are not available through Chusky.");
    }
    query[key] = value;
  }
  for (const field of route.requiredQuery ?? []) {
    if (!(field in query) || query[field] === "") throw new Error(`Treg action ${action} requires query.${field}`);
  }

  const rawBody = args.input === undefined ? {} : args.input;
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) throw new Error("input must be an object");
  const body = rawBody as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (!route.bodyFields?.includes(key)) throw new Error(`Input field ${key} is not supported for Treg action ${action}`);
    assertSafeValue(value, `input.${key}`);
  }
  for (const field of route.requiredBody ?? []) {
    if (!(field in body) || body[field] === undefined || body[field] === null || (typeof body[field] === "string" && !body[field].trim())) {
      throw new Error(`Treg action ${action} requires input.${field}`);
    }
  }
  validateTypedFields(action, body);
  if ((route.bodyFields?.length ?? 0) > 0 && !Object.keys(body).length) {
    throw new Error(`Treg action ${action} requires at least one input field`);
  }
  if (action === "orgs.delete" && query.confirm !== true) throw new Error("Deleting a Treg organization requires query.confirm=true and exact owner approval");
  if (action === "orgs.deny_create" && !["host", "path_prefix", "method", "user_id", "project_id"].some((field) => body[field] !== undefined)) {
    throw new Error("A Treg deny rule needs at least one match field (host, path_prefix, method, user_id, or project_id)");
  }
  if ((route.bodyFields?.length ?? 0) === 0 && Object.keys(body).length) throw new Error(`Treg action ${action} does not accept input`);
  if (Buffer.byteLength(JSON.stringify({ query, body }), "utf8") > 16_384) throw new Error("Treg management request exceeds 16 KiB");
  return { method: route.method, path, ...(Object.keys(query).length ? { query } : {}), ...(Object.keys(body).length ? { body } : {}), ...(rawOrgId ? { orgId: rawOrgId } : {}), isRead };
}

export function sanitizeTregAdminResult(value: unknown): unknown {
  return sanitizeAdminValue(value, { nodes: 0, characters: 0 }, 0);
}

function sanitizeAdminValue(value: unknown, budget: { nodes: number; characters: number }, depth: number): unknown {
  budget.nodes += 1;
  if (budget.nodes > 5_000 || budget.characters >= 44_000) return "[response truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const remaining = Math.min(2_000, 44_000 - budget.characters);
    const safe = value.slice(0, remaining)
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|pk|rk|ghp|gho|xox[baprs])_[A-Za-z0-9_-]{16,}/gi, "[redacted credential]")
      .replace(/([?&](?:access_token|refresh_token|token|api_key|password|signature|sig)=)[^&#\s]+/gi, "$1[redacted]");
    budget.characters += safe.length;
    return safe;
  }
  if (depth >= 6) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeAdminValue(item, budget, depth + 1));
  if (typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/(?:secret|token|password|authorization|credential|api[_-]?key)/i.test(key))
    .slice(0, 80)
    .map(([key, item]) => [key.slice(0, 120), sanitizeAdminValue(item, budget, depth + 1)]));
}
