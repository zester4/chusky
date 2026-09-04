import { randomUUID } from "node:crypto";
import { safeDaytonaPath } from "./lib/daytona/index.js";

export const MAX_GENERATED_IMAGES = 10;

export function normalizeImageCount(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === "") return 1;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_IMAGES) {
    throw new Error(`count must be an integer from 1 to ${MAX_GENERATED_IMAGES}`);
  }
  return count;
}

export function resolveImageWorkspacePath(value: unknown, index: number, total: number, extension: string): string {
  const requested = value === undefined || value === null || String(value).trim() === ""
    ? `generated/images/${randomUUID()}.${extension}`
    : safeDaytonaPath(value, "workspacePath");
  if (total <= 1) return requested;
  const dot = requested.lastIndexOf(".");
  const suffix = `-${index + 1}`;
  return dot > 0 ? `${requested.slice(0, dot)}${suffix}${requested.slice(dot)}` : `${requested}${suffix}`;
}
