import fs from "node:fs/promises";

const body = Buffer.from(process.env.CHUSKY_E2B_REQUEST_B64 || "", "base64url").toString("utf8");
let lastError;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:8765/command", { method: "POST", headers: { "content-type": "application/json" }, body });
    const text = await response.text();
    if (process.env.CHUSKY_E2B_RESPONSE_FILE) {
      await fs.writeFile(process.env.CHUSKY_E2B_RESPONSE_FILE, text, { mode: 0o600 });
      console.log(JSON.stringify({ ok: true, responseFile: process.env.CHUSKY_E2B_RESPONSE_FILE }));
    } else console.log(text);
    if (!response.ok) process.exitCode = 1;
    process.exit();
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
console.log(JSON.stringify({ ok: false, error: `E2B browser daemon unavailable: ${String(lastError?.message || lastError).slice(0, 300)}` }));
process.exitCode = 1;
