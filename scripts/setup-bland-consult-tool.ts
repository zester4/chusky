import "dotenv/config";
import { provisionBlandConsultTool } from "../src/calls/blandTool.js";

try {
  const existingId = process.env.BLAND_CONSULT_TOOL_ID?.trim() ?? "";
  if (existingId) {
    if (!/^TL-[A-Za-z0-9_-]{6,128}$/.test(existingId)) throw new Error("BLAND_CONSULT_TOOL_ID is not a valid Bland TL-* ID");
    console.log(`BLAND_CONSULT_TOOL_ID is already set to ${existingId}; not creating a duplicate tool.`);
    process.exit(0);
  }
  const toolId = await provisionBlandConsultTool({
    apiKey: process.env.BLAND_API_KEY ?? "",
    webhookUrl: process.env.BLAND_WEBHOOK_URL ?? "",
    secret: process.env.BLAND_CONSULT_TOOL_SECRET ?? "",
  });
  console.log(`Bland Chusky consultation tool created: ${toolId}`);
  console.log("Set BLAND_CONSULT_TOOL_ID to this value in the Chusky service. The tool secret is not printed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Bland tool setup failed");
  process.exitCode = 1;
}
