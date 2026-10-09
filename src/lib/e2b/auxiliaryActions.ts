import { E2BBrowserError } from "./errors.js";

export function auxiliaryBrowserRequest(action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (action === "observe") {
    return {
      action,
      includeScreenshot: args.includeScreenshot === true,
      includeForms: args.includeForms !== false,
      includePageContent: args.includePageContent === true,
      includeLinks: args.includeLinks === true,
    };
  }
  if (action === "act") {
    if (!args.step || typeof args.step !== "object" || Array.isArray(args.step)) {
      throw new E2BBrowserError("act requires one bounded browser step");
    }
    return { action, step: args.step };
  }
  if (action === "extract") {
    if (!args.schema || typeof args.schema !== "object" || Array.isArray(args.schema)) {
      throw new E2BBrowserError("extract requires a bounded object schema");
    }
    return { action, schema: args.schema };
  }
  if (action === "desktop_click") {
    const x = Number(args.x);
    const y = Number(args.y);
    const screenshotHash = args.screenshotHash;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1440 || y > 900) {
      throw new E2BBrowserError("desktop_click requires coordinates inside the 1440x900 browser viewport");
    }
    if (args.visualFallback !== true || typeof screenshotHash !== "string" || !/^[a-f0-9]{32}$/i.test(screenshotHash)) {
      throw new E2BBrowserError("desktop_click requires a fresh screenshotHash and visualFallback=true");
    }
    return {
      action,
      x,
      y,
      screenshotHash,
      visualFallback: true,
      button: args.button === "right" || args.button === "middle" ? args.button : "left",
      double: args.double === true,
    };
  }
  if (action === "desktop_type") {
    if (typeof args.text !== "string" || args.text.length > 8_000) throw new E2BBrowserError("desktop_type text must be at most 8000 characters");
    return { action, text: args.text, delayMs: Math.max(0, Math.min(250, Number(args.delayMs ?? 0))) };
  }
  if (action === "desktop_press") {
    const key = args.key ?? args.keys ?? "Enter";
    if (typeof key !== "string" || !key.trim() || key.length > 100) throw new E2BBrowserError("desktop_press requires a key of at most 100 characters");
    return { action, key };
  }
  if (action === "clipboard_write") {
    if (typeof args.text !== "string" || args.text.length > 8_000) throw new E2BBrowserError("clipboard_write text must be at most 8000 characters");
    return { action, text: args.text };
  }
  return { action };
}
