import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_TRANSCODED_BYTES = 25 * 1024 * 1024;

/**
 * Sendblue delivers native Apple voice notes as Opus-in-CAF. OpenRouter's STT
 * endpoint documents Ogg/Opus, but not CAF, so convert the container before
 * transcription without ever placing user media on a public filesystem path.
 */
export async function transcodeSendblueCafToOgg(input: Buffer, executable = "ffmpeg"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "chusky-sendblue-"));
  const source = join(dir, "voice-note.caf");
  const output = join(dir, "voice-note.ogg");
  try {
    await writeFile(source, input, { mode: 0o600 });
    await runFfmpeg(executable, source, output);
    const audio = await readFile(output);
    if (!audio.length || audio.length > MAX_TRANSCODED_BYTES) throw new Error("Converted iMessage voice note is empty or too large");
    return audio;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function sendblueCafTranscodeArgs(source: string, output: string): string[] {
  return ["-nostdin", "-v", "error", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "24k", output];
}

function runFfmpeg(executable: string, source: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, sendblueCafTranscodeArgs(source, output), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-1_000); });
    child.once("error", (error) => { clearTimeout(timeout); reject(new Error(`iMessage voice-note converter is unavailable: ${error.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`iMessage voice-note conversion failed${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
