import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore } from "../src/store.js";

const brand = {
  companyName: "Chusky",
  tagline: "A computer for the work between words.",
};

const style = {
  preset: "executive",
  primary: "123B5D",
  accent: "0F766E",
  secondary: "2563EB",
  background: "F7FAFC",
  surface: "E6FFFA",
  text: "102A43",
  muted: "52606D",
  fontFace: "Aptos",
  headingFontFace: "Aptos Display",
  footer: "Chusky | Hospital operations partnership",
  includeSlideNumbers: true,
};

const heroImage = "C:/Users/mseyy/.codex/generated_images/01a10477-7a93-7653-b90c-c023f0d536ff/exec-46999442-800b-4735-bc4d-8966b7689f32.png";
const accessImage = "C:/Users/mseyy/.codex/generated_images/01a10477-7a93-7653-b90c-c023f0d536ff/exec-dfff9b7c-063f-4d56-b5a4-94c77c6f6496.png";
const operationsImage = "C:/Users/mseyy/.codex/generated_images/01a10477-7a93-7653-b90c-c023f0d536ff/exec-f81ab446-b85b-45f7-9494-52c0c60f0029.png";

const slides = [
  {
    title: "A calmer operating layer for modern care",
    eyebrow: "CHUSKY FOR HOSPITALS",
    body: "An agent with a private computer, a durable workspace, and the practical reach to turn operational intent into verified work.",
    layout: "background",
    backgroundImagePath: "workspace/hospital-command-center.png",
    backgroundImageAltText: "Hospital operations team reviewing a connected workflow display",
    overlayColor: "102A43",
    overlayOpacity: 64,
    textColor: "FFFFFF",
    accent: "0F766E",
    notes: "Opening: position Chusky as an operational layer that helps hospital teams move from intent to verified work.",
  },
  {
    title: "Hospital teams carry too much coordination work",
    body: "The pressure is rarely one isolated task. It is the handoff between systems, people, documents, and decisions that consumes attention every day.",
    layout: "metrics",
    metrics: [
      { label: "Access", value: "Faster answers", detail: "Guide requests to the right next step" },
      { label: "Operations", value: "Less chasing", detail: "Keep work moving across teams" },
      { label: "Leadership", value: "Clearer view", detail: "Turn activity into useful evidence" },
    ],
  },
  {
    title: "One agent across the operational surface",
    body: "Chusky can help teams handle the connective work that sits around care delivery, while keeping the work visible and organized.",
    layout: "table",
    table: {
      headers: ["Area", "How Chusky helps", "Result"],
      rows: [
        ["Patient access", "Prepare answers, route requests, and assemble next steps", "A clearer path to help"],
        ["Care operations", "Coordinate follow-ups, documents, and handoffs", "Fewer loose ends"],
        ["Administration", "Create reports, briefs, and structured updates", "More time for judgment"],
        ["Leadership", "Summarize signals and surface what needs attention", "A better operating picture"],
      ],
    },
  },
  {
    title: "Patient access becomes easier to navigate",
    body: "A hospital can give people a more coherent front door by connecting questions to the right information, team, or next action.",
    layout: "background",
    backgroundImagePath: "workspace/patient-access.png",
    backgroundImageAltText: "Hospital care navigator helping a patient at a welcoming reception desk",
    overlayColor: "102A43",
    overlayOpacity: 58,
    textColor: "FFFFFF",
    bullets: [
      "Turn plain-language requests into a clear intake path",
      "Prepare appointment, service, and follow-up information",
      "Create consistent handoff notes for the receiving team",
      "Keep status visible so people know what happens next",
    ],
    quote: "The experience feels joined up because the work behind it stays joined up.",
  },
  {
    title: "Operations teams get a computer that can do the work",
    body: "Chusky works inside a private Daytona workspace where it can create files, run code, build applications, inspect outputs, and return a usable result.",
    layout: "background",
    backgroundImagePath: "workspace/operations-team.png",
    backgroundImageAltText: "Hospital operations team reviewing a care coordination plan",
    overlayColor: "102A43",
    overlayOpacity: 62,
    textColor: "FFFFFF",
    bullets: [
      "Create a structured operational brief and deliver it",
      "Build, verify, and open a signed internal tool preview",
      "Turn recurring reporting into a repeatable workflow",
      "Package cross-team context into a clear handoff",
    ],
  },
  {
    title: "The value compounds across the workday",
    body: "The same operating layer can support access, administration, and leadership without forcing every team to start from a blank page.",
    layout: "chart",
    chart: {
      categories: ["Access", "Coordination", "Documents", "Visibility"],
      series: [
        { name: "Workflows supported", values: [4, 6, 5, 3] },
        { name: "Handoff points connected", values: [3, 5, 4, 4] },
      ],
    },
    notes: "Illustrative operating model, not measured hospital performance. Use this slide to discuss where a pilot would create the most leverage.",
  },
  {
    title: "From request to verified result",
    body: "Chusky keeps the path from intent to handoff inspectable, so teams can see what happened and pick up the next step.",
    layout: "timeline",
    table: [
      ["01", "Understand", "Frame the request and identify the work"],
      ["02", "Build", "Use the private computer and connected workspace"],
      ["03", "Check", "Validate the output and inspect the result"],
      ["04", "Handoff", "Return the document, preview, or next action"],
    ],
  },
  {
    title: "A practical first 30 days",
    eyebrow: "PILOT SHAPE",
    body: "Start with a small set of visible workflows, learn where coordination costs the most, and expand from evidence.",
    layout: "table",
    table: {
      headers: ["Window", "Focus", "Evidence to review"],
      rows: [
        ["Week 1", "Choose two high-friction workflows", "Baseline steps, owners, and handoffs"],
        ["Week 2", "Build the first operating patterns", "Working artifacts and preview results"],
        ["Week 3", "Run with a small team", "Observed friction and recovery paths"],
        ["Week 4", "Review and decide what to scale", "Adoption signals and next workflow"],
      ],
    },
    notes: "This is a proposed pilot structure. The hospital selects the workflows and success measures.",
  },
  {
    title: "Leadership sees the work, not just the promise",
    body: "Every workflow can produce a concise record of the request, the work completed, the artifact returned, and the next decision.",
    layout: "metrics",
    metrics: [
      { label: "Work in motion", value: "Live view", detail: "See what is active and waiting" },
      { label: "Output quality", value: "Verified", detail: "Review executable and visual evidence" },
      { label: "Scale", value: "Repeatable", detail: "Turn a successful pattern into a playbook" },
    ],
  },
  {
    title: "A partnership built around useful work",
    body: "Chusky gives hospital teams a practical way to move from an operational question to a clear, reviewable result. The first step is choosing the work that should feel lighter.",
    layout: "closing",
    quote: "Start with the handoff everyone feels.",
    notes: "Close by asking the hospital team to name one workflow where coordination, documentation, or follow-through creates avoidable drag.",
  },
];

async function main(): Promise<void> {
  if (process.env.DAYTONA_LIVE_TEST !== "1") throw new Error("Set DAYTONA_LIVE_TEST=1 for live presentation creation.");
  if (!config.daytonaApiKey) throw new Error("DAYTONA_API_KEY is required.");
  await initStore({ memoryOnly: true });
  const engine = new DaytonaEngine();
  const userId = 930_000_000 + randomInt(69_999_999);
  const nonce = randomUUID().slice(0, 8);
  const outDir = "output/daytona-showcase";
  mkdirSync(outDir, { recursive: true });
  let created = false;
  try {
    await engine.workspace(userId, "create");
    created = true;
    const sandbox = await engine.getOrCreateWorkspace(userId);
    await sandbox.fs.uploadFile(readFileSync(heroImage), "workspace/hospital-command-center.png");
    await sandbox.fs.uploadFile(readFileSync(accessImage), "workspace/patient-access.png");
    await sandbox.fs.uploadFile(readFileSync(operationsImage), "workspace/operations-team.png");
    const artifact = await engine.createPresentation(userId, {
      title: "Chusky for Hospitals",
      name: `chusky-hospital-pitch-${nonce}.pptx`,
      path: `artifacts/chusky-hospital-pitch-${nonce}.pptx`,
      slides,
      brand,
      style,
    });
    const delivery = await engine.streamArtifact(userId, artifact.id);
    const chunks: Buffer[] = [];
    for await (const chunk of delivery.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const outputPath = `${outDir}/chusky-hospital-pitch-image-fixed-v3.pptx`;
    writeFileSync(outputPath, Buffer.concat(chunks));
    console.log(JSON.stringify({ status: "passed", artifactId: artifact.id, path: outputPath, size: artifact.size, slideCount: artifact.slideCount }));
  } finally {
    if (created) await engine.workspace(userId, "delete").catch(() => undefined);
  }
}

void main();
