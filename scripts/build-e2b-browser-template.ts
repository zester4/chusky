import "dotenv/config";
import { Template, defaultBuildLogger } from "e2b";
import { resolve } from "node:path";

const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) throw new Error("E2B_API_KEY is required to build the browser template");

const templateDir = resolve(process.cwd(), "e2b", "browser-template");
const name = process.env.E2B_BROWSER_TEMPLATE?.trim() || "chusky-browser-playwright";
const template = Template({ fileContextPath: templateDir }).fromDockerfile(resolve(templateDir, "Dockerfile"));

async function main() {
  const build = await Template.build(template, name, {
    apiKey,
    cpuCount: 2,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger({ minLevel: "info" }),
  });
  console.log(JSON.stringify({ name: build.name, templateId: build.templateId, buildId: build.buildId }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
