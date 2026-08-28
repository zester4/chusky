import { Daytona } from "@daytona/sdk";
import { config } from "../../config.js";
import { DaytonaDisabledError } from "./errors.js";

let client: Daytona | undefined;

export function getDaytonaClient(): Daytona {
  if (!config.daytonaApiKey) throw new DaytonaDisabledError();
  if (!client) {
    client = new Daytona({
      apiKey: config.daytonaApiKey,
      apiUrl: config.daytonaApiUrl,
      ...(config.daytonaTarget ? { target: config.daytonaTarget } : {}),
    });
  }
  return client;
}
