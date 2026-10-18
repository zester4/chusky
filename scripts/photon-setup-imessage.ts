import "dotenv/config";

type PhotonModule = { Photon: new (options: Record<string, unknown>) => { projects: any } };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running the Photon iMessage setup.`);
  return value;
}

function importPhoton(): Promise<PhotonModule> {
  const importer = new Function("name", "return import(name)") as (name: string) => Promise<PhotonModule>;
  return importer("@photon-ai/api");
}

async function main(): Promise<void> {
  const photonModule = await importPhoton();
  const projectId = required("PHOTON_PROJECT_ID");
  const apiKey = required("PHOTON_API_KEY");
  const sender = required("PHOTON_TEST_SENDER");
  const idempotencyKey = required("PHOTON_SETUP_KEY");
  const apiOrigin = (process.env.PHOTON_API_ORIGIN?.trim() || "https://api.photon.codes").replace(/\/$/, "");

  const photon = new photonModule.Photon({
    baseUrl: apiOrigin,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 30_000,
    retry: { maxAttempts: 3, maximumRetryAfterMs: 60_000 },
  });

  const assignment = await photon.projects.platforms.imessage.assignments.create({
    path: { id: projectId },
    headers: { idempotencyKey },
    body: { handle: sender },
  });
  console.log(JSON.stringify({
    projectId,
    platform: "imessage",
    testSender: sender,
    assignedPhoneNumber: assignment.assignedPhoneNumber,
    assignmentId: assignment.assignmentId,
    next: "Set PHOTON_AGENT_HANDLE to assignedPhoneNumber, then run npm run photon:imessage:smoke.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Photon iMessage assignment failed.");
  process.exitCode = 1;
});
