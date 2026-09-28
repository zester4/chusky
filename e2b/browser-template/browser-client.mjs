const body = Buffer.from(process.env.CHUSKY_E2B_REQUEST_B64 || "", "base64url").toString("utf8");
let lastError;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:8765/command", { method: "POST", headers: { "content-type": "application/json" }, body });
    console.log(await response.text());
    if (!response.ok) process.exitCode = 1;
    process.exit();
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
console.log(JSON.stringify({ ok: false, error: `E2B browser daemon unavailable: ${String(lastError?.message || lastError).slice(0, 300)}` }));
process.exitCode = 1;
