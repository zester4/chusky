import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(projectRoot, ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

export const BASE = process.env.CAMOFOX_BASE_URL?.trim();
export const ACCESS_KEY = process.env.CAMOFOX_ACCESS_KEY?.trim();
export const NOVNC_BASE = process.env.CAMOFOX_NOVNC_URL?.trim();

if (!BASE) {
  throw new Error("Missing CAMOFOX_BASE_URL. Set it in the project .env file.");
}

if (!ACCESS_KEY) {
  throw new Error("Missing CAMOFOX_ACCESS_KEY. Set it in the project .env file.");
}