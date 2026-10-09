import Kernel from "@onkernel/sdk";
import { config } from "../../config.js";

export function kernelBrowserEnabled(): boolean {
  if (!["e2b", "kernel"].includes(config.browserProvider)) throw new Error("BROWSER_PROVIDER must be e2b or kernel");
  if (config.browserProvider === "kernel" && !config.kernelApiKey) throw new Error("Kernel browser requires KERNEL_API_KEY");
  return config.browserProvider === "kernel";
}

export function kernelConfigurationStatus(): "disabled" | "configured" | "misconfigured" {
  if (config.browserProvider === "e2b") return "disabled";
  if (config.browserProvider !== "kernel") return "misconfigured";
  try { kernelTimeoutSeconds(); } catch { return "misconfigured"; }
  return config.kernelApiKey && config.e2bEnabled && config.e2bApiKey && config.e2bBrowserTemplate
    && Number.isFinite(config.kernelCaptchaWaitMs) && config.kernelCaptchaWaitMs >= 0 && config.kernelCaptchaWaitMs <= 30_000
    ? "configured" : "misconfigured";
}

export function kernelClient() {
  // Browser creation and actions must never be replayed after an ambiguous timeout.
  return new Kernel({ apiKey: config.kernelApiKey, maxRetries: 0, timeout: config.e2bRequestTimeoutMs });
}

export function kernelTimeoutSeconds(): number {
  const value = config.kernelBrowserTimeoutSeconds;
  if (!Number.isInteger(value) || value < 60 || value > 259200) throw new Error("KERNEL_BROWSER_TIMEOUT_SECONDS must be 60-259200");
  return value;
}

export function kernelLiveViewUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Kernel live view is unavailable");
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*(?:onkernel\.com|kernel\.sh)$/i.test(url.hostname) || url.username || url.password) throw new Error("Kernel returned an invalid live view URL");
  return url.toString();
}
