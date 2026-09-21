import { Chusky } from "@chusky/sdk";

export function createClient(): Chusky {
  const apiKey = process.env.CHUSKY_API_KEY;
  if (!apiKey) throw new Error("Set CHUSKY_API_KEY before running this example.");

  return new Chusky({
    apiKey,
    baseUrl: process.env.CHUSKY_BASE_URL,
    userId: process.env.CHUSKY_USER_ID ?? "example-user",
  });
}

export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing ${name}.`);
  return value;
}
