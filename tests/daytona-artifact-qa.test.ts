import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { artifactVisualQaScript } from "../src/lib/daytona/artifactQa.js";

// Execute the emitted Python; fake only OS tool discovery/processes.
function runQa(scenario: string, type: "pdf" | "docx" = "pdf") {
  const script = artifactVisualQaScript(type, "source.pdf");
  const harness = [
    "import os, tempfile, subprocess",
    "from unittest.mock import patch",
    "installed=False",
    "calls=[]",
    "def which(name):",
    "    return name if installed or scenario not in ('setup', 'setup-failed') else None",
    "def run(args, **kwargs):",
    "    calls.append(args)",
    "    if args[0] in ('apt-get', 'sudo'): raise AssertionError('QA must never install packages')",
    "    if args[0] in ('libreoffice', 'soffice'):",
    "        if scenario != 'conversion-failed':",
    "            with open(os.path.join(args[args.index('--outdir')+1], 'source.pdf'), 'wb') as f: f.write(b'%PDF-test')",
    "    elif args[0] == 'pdfinfo':",
    "        return subprocess.CompletedProcess(args, 1 if scenario == 'bad-pdf' else 0, stdout='Pages: 0\\n' if scenario == 'empty' else 'Pages: 3\\n')",
    "    elif args[0] == 'pdftoppm':",
    "        if scenario == 'partial' and args[args.index('-f')+1] == '2': return subprocess.CompletedProcess(args, 1)",
    "        with open(args[-1] + '.png', 'wb') as f: f.write(b'\\x89PNG\\r\\n\\x1a\\n' + bytes(120))",
    "    return subprocess.CompletedProcess(args, 0)",
    "original_cwd=os.getcwd()",
    "with tempfile.TemporaryDirectory() as root:",
    "    os.chdir(root)",
    "    with open('source.pdf', 'wb') as f: f.write(b'%PDF-1.4\\n' + bytes(150) + b'%%EOF')",
    "    with patch('shutil.which', which), patch('subprocess.run', run), patch('os.geteuid', lambda: 0, create=True):",
    "        try: exec(script)",
    "        finally:",
    "            os.chdir(original_cwd)",
    "            print('RENDER_CALLS=' + str(sum(c[0] == 'pdftoppm' for c in calls)))",
  ].join("\n");
  return spawnSync(process.platform === "win32" ? "python" : "python3", ["-c",
    "scenario=" + JSON.stringify(scenario) + "\nscript=" + JSON.stringify(script) + "\n" + harness,
  ], { encoding: "utf8" });
}

test("emitted QA renders every parsed PDF page", () => {
  const result = runQa("valid");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rendered all 3 page\(s\)/);
  assert.match(result.stdout, /RENDER_CALLS=3/);
});

for (const scenario of ["bad-pdf", "empty", "partial"]) {
  test("QA fails closed for " + scenario, () => {
    const result = runQa(scenario);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout, /visual QA passed/);
  });
}

test("missing DOCX dependencies request isolated rendering without attempting installation", () => {
  const result = runQa("setup", "docx");
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /CHUSKY_RENDERER_UNAVAILABLE/);
  assert.match(result.stdout, /RENDER_CALLS=0/);
});

test("successful Office exit without a converted PDF fails validation", () => {
  const result = runQa("conversion-failed", "docx");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /conversion failed/);
});
