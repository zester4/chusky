const LOAD_STATES = ["domcontentloaded", "load", "networkidle"];
const CONDITION_FIELDS = ["urlIncludes", "urlExcludes", "titleIncludes", "titleExcludes", "textIncludes", "textExcludes"];
const clean = (value, max = 300) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function conditionText(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 300 || !value.trim()) throw new Error(`${field} must be 1-300 characters`);
  return value.trim();
}

export function normalizeBrowserWaitConditions(request = {}) {
  const timeoutMs = request.timeoutSeconds !== undefined
    ? Number(request.timeoutSeconds) * 1_000
    : Number(request.timeoutMs ?? 1_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Browser wait timeout must be positive");
  const conditions = { timeoutMs: Math.max(50, Math.min(30_000, Math.round(timeoutMs))) };
  if (request.loadState !== undefined) {
    if (!LOAD_STATES.includes(String(request.loadState))) throw new Error("loadState is not supported");
    conditions.loadState = String(request.loadState);
  }
  for (const field of CONDITION_FIELDS) {
    const value = conditionText(request[field], field);
    if (value !== undefined) conditions[field] = value;
  }
  return conditions;
}

export function matchBrowserWaitConditions(snapshot = {}, conditions = {}) {
  const url = String(snapshot.url ?? "");
  const title = String(snapshot.title ?? "");
  const text = String(snapshot.text ?? "");
  const titleLower = title.toLowerCase();
  const textLower = text.toLowerCase();
  const missing = [];
  if (conditions.urlIncludes && !url.includes(conditions.urlIncludes)) missing.push("urlIncludes");
  if (conditions.urlExcludes && url.includes(conditions.urlExcludes)) missing.push("urlExcludes");
  if (conditions.titleIncludes && !titleLower.includes(String(conditions.titleIncludes).toLowerCase())) missing.push("titleIncludes");
  if (conditions.titleExcludes && titleLower.includes(String(conditions.titleExcludes).toLowerCase())) missing.push("titleExcludes");
  if (conditions.textIncludes && !textLower.includes(String(conditions.textIncludes).toLowerCase())) missing.push("textIncludes");
  if (conditions.textExcludes && textLower.includes(String(conditions.textExcludes).toLowerCase())) missing.push("textExcludes");
  if (conditions.loadState && snapshot.loadState !== conditions.loadState) missing.push("loadState");
  return { passed: missing.length === 0, missing };
}

/**
 * Wait for browser state, not an arbitrary delay. `visible` is supplied by the
 * Playwright adapter so this module remains independent of locator strategy.
 */
export async function waitForBrowserConditions(page, request = {}, { visible } = {}) {
  const conditions = normalizeBrowserWaitConditions(request);
  const startedAt = Date.now();
  let loadStateSatisfied = !conditions.loadState;
  if (conditions.loadState) {
    await page.waitForLoadState(conditions.loadState, { timeout: conditions.timeoutMs });
    loadStateSatisfied = true;
  }
  const hasContentCondition = CONDITION_FIELDS.some((field) => conditions[field] !== undefined);
  const hasVisibleCondition = typeof visible === "function";
  if (!hasContentCondition && !hasVisibleCondition) {
    if (!conditions.loadState) await page.waitForTimeout(conditions.timeoutMs);
    return { conditioned: false, waitedMs: Date.now() - startedAt };
  }
  const deadline = startedAt + conditions.timeoutMs;
  let missing = [];
  while (Date.now() <= deadline) {
    let visibleSatisfied = true;
    if (hasVisibleCondition) visibleSatisfied = await visible().catch(() => false);
    let text = "";
    if (conditions.textIncludes || conditions.textExcludes) {
      text = await page.locator("body").innerText({ timeout: Math.min(1_000, Math.max(50, deadline - Date.now())) }).catch(async () => page.locator("body").textContent({ timeout: 500 }).catch(() => ""));
    }
    const result = matchBrowserWaitConditions({ url: page.url(), title: await page.title().catch(() => ""), text, loadState: loadStateSatisfied ? conditions.loadState : undefined }, conditions);
    missing = [...result.missing, ...(visibleSatisfied ? [] : ["visible"])]
      .filter((value, index, values) => values.indexOf(value) === index);
    if (missing.length === 0) return {
      conditioned: true,
      waitedMs: Date.now() - startedAt,
      matched: [...CONDITION_FIELDS.filter((field) => conditions[field] !== undefined), ...(conditions.loadState ? ["loadState"] : []), ...(hasVisibleCondition ? ["visible"] : [])],
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(250, remaining));
  }
  throw new Error(`Timed out waiting for browser conditions: ${missing.join(", ") || "target"}`);
}
