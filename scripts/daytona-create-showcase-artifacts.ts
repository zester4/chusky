import { mkdirSync, writeFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore } from "../src/store.js";

const sections = [
  {
    heading: "A computer for the work between words",
    body: "Chusky gives an agent a private Daytona workspace where it can install dependencies, shape interfaces, run commands, inspect a desktop, and return a working artifact. The result is not only an answer. It is a place where the answer can become real.",
    bullets: [
      "Private owner-scoped workspace with durable files and projects",
      "Bounded terminal, PTY, code, Git, and language-server workflows",
      "Native desktop control for local applications and visual inspection",
      "Signed previews for apps that are ready for a human to open",
    ],
  },
  {
    heading: "The loop from intent to artifact",
    body: "A good agent loop is visible from the first brief to the final handoff. Chusky keeps the work inspectable: it verifies what it runs, preserves the useful state, and gives the owner a direct way to open the result.",
    table: [
      ["Stage", "What Chusky does", "Evidence"],
      ["Understand", "Turns a brief into bounded work", "Scoped objective and plan"],
      ["Build", "Uses the Daytona computer and runtime", "Files, commands, and logs"],
      ["Inspect", "Checks structure and visual output", "QA result and screenshot"],
      ["Hand back", "Registers the finished deliverable", "Artifact receipt or preview URL"],
    ],
  },
  {
    heading: "Capabilities that compound",
    body: "The computer is useful because its capabilities work together. A generated report can be inspected, a project can be started behind a signed URL, and a follow-up can resume from the same durable workspace instead of beginning again.",
    table: [
      ["Capability", "Designed for", "Boundary"],
      ["Workspace", "Code, files, packages, and projects", "Private to the owner"],
      ["Computer Use", "Desktop applications and local GUI work", "Not ordinary web browsing"],
      ["App Preview", "A human testing a running application", "Signed and time-limited"],
      ["Artifacts", "PDF, DOCX, PPTX, and XLSX delivery", "Generated and QA checked"],
    ],
  },
  {
    heading: "A calmer handoff",
    body: "The best handoff is specific enough to trust. It names what was made, shows where it can be opened, and keeps uncertainty visible. That is why Chusky treats verification and delivery as part of the work rather than a final afterthought.",
    bullets: [
      "A preview link is returned only after the app server answers",
      "Documents pass structural checks before they are registered",
      "Visual QA evidence stays attached to the artifact workflow",
      "Destructive, external, and permission-changing actions remain gated",
    ],
  },
];

const style = {
  pageSize: "A4",
  margin: 0.72,
  preset: "brand",
  fontFamily: "serif",
  fontName: "Times-Roman",
  fontBold: "Times-Bold",
  fontItalic: "Times-Italic",
  monoFont: "Courier",
  primary: "C34F36",
  accent: "E7BB73",
  text: "272522",
  muted: "77736D",
  fontSize: 10.5,
  header: "CHUSKY / AGENT COMPUTER",
  footer: "Chusky - Editorial field guide",
  includePageNumbers: true,
  author: "Chusky",
};

const brand = { companyName: "Chusky", tagline: "An agent with a place to work." };

async function main(): Promise<void> {
  if (!process.env.DAYTONA_LIVE_TEST) throw new Error("Set DAYTONA_LIVE_TEST=1 for live artifact creation.");
  if (!config.daytonaApiKey) throw new Error("DAYTONA_API_KEY is required.");
  await initStore({ memoryOnly: true });
  const engine = new DaytonaEngine();
  const userId = 920_000_000 + randomInt(79_999_999);
  const nonce = randomUUID().slice(0, 8);
  const outDir = "output/daytona-showcase";
  mkdirSync(outDir, { recursive: true });
  let created = false;
  try {
    await engine.workspace(userId, "create");
    created = true;
    const pdf = await engine.createPdf(userId, {
      title: "Chusky Agent Computer",
      name: `chusky-agent-computer-${nonce}.pdf`,
      path: `artifacts/chusky-agent-computer-${nonce}.pdf`,
      sections,
      brand,
      style,
    });
    const docx = await engine.createDocument(userId, {
      title: "Chusky Agent Computer",
      name: `chusky-agent-computer-${nonce}.docx`,
      path: `artifacts/chusky-agent-computer-${nonce}.docx`,
      sections,
      brand,
      style,
    });
    for (const [artifact, localName] of [[pdf, "chusky-agent-computer.pdf"], [docx, "chusky-agent-computer.docx"]] as const) {
      const delivery = await engine.streamArtifact(userId, artifact.id);
      const chunks: Buffer[] = [];
      for await (const chunk of delivery.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      writeFileSync(`${outDir}/${localName}`, Buffer.concat(chunks));
    }
    console.log(JSON.stringify({ status: "passed", pdf: { id: pdf.id, path: `${outDir}/chusky-agent-computer.pdf`, size: pdf.size }, docx: { id: docx.id, path: `${outDir}/chusky-agent-computer.docx`, size: docx.size }, pageCount: pdf.pageCount }));
  } finally {
    if (created) await engine.workspace(userId, "delete").catch(() => undefined);
  }
}

void main();
