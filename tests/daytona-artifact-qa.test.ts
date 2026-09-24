import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { artifactVisualQaScript } from "../src/lib/daytona/artifactQa.js";

// Execute the emitted Python; fake only OS tool discovery/processes.
function runQa(scenario: string, type: "pdf" | "docx" | "presentation" | "spreadsheet" = "pdf", expectedFormulaValues: Record<string, string | number | boolean> = {}) {
  const sourcePath = type === "spreadsheet" ? "source.xlsx" : "source.pdf";
  const script = artifactVisualQaScript(type, sourcePath, undefined, expectedFormulaValues);
  const harness = [
    "import os, tempfile, subprocess, zipfile",
    "from unittest.mock import patch",
    "installed=False",
    "calls=[]",
    "def which(name):",
    "    return name if installed or scenario not in ('setup', 'setup-failed') else None",
    "def run(args, **kwargs):",
    "    calls.append(args)",
    "    if args[0] in ('apt-get', 'sudo'): raise AssertionError('QA must never install packages')",
    "    if args[0] in ('libreoffice', 'soffice'):",
    "        if '--convert-to' in args and args[args.index('--convert-to')+1] == 'xlsx':",
    "            output=os.path.join(args[args.index('--outdir')+1], os.path.basename(args[-1]))",
    "            formula_type = ' t=\"e\"' if scenario == 'formula-error' else (' t=\"b\"' if scenario == 'formula-boolean' else '')",
    "            formula_value = '#VALUE!' if scenario == 'formula-error' else ('1' if scenario == 'formula-boolean' else ('99' if scenario == 'formula-mismatch' else '100'))",
    "            formula_xml = '<c r=\"C4\"' + formula_type + '><f>SUM(B4:B4)</f><v>' + formula_value + '</v></c>' if scenario.startswith('formula-') else ''",
    "            with zipfile.ZipFile(output, 'w') as book: book.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>' + formula_xml + '</sheetData></worksheet>')",
    "        elif scenario != 'conversion-failed':",
    "            with open(os.path.join(args[args.index('--outdir')+1], 'source.pdf'), 'wb') as f: f.write(b'%PDF-test')",
    "    elif args[0] == 'pdfinfo':",
    "        return subprocess.CompletedProcess(args, 1 if scenario == 'bad-pdf' else 0, stdout='Pages: 0\\n' if scenario == 'empty' else 'Pages: 3\\n')",
    "    elif args[0] == 'pdftoppm':",
    "        if scenario == 'partial' and args[args.index('-f')+1] == '2': return subprocess.CompletedProcess(args, 1)",
    "        if '-png' in args:",
    "            with open(args[-1] + '.png', 'wb') as f: f.write(b'\\x89PNG\\r\\n\\x1a\\n' + bytes(120))",
    "        else:",
    "            page=args[args.index('-f')+1]",
    "            pixels=bytes([0, 0]) if scenario == 'blank-page' and page == '2' else bytes([0, 255])",
    "            with open(args[-1] + '.pbm', 'wb') as f: f.write(b'P4\\n8 8\\n' + pixels)",
    "    elif args[0] == 'pdftotext':",
    "        page=args[args.index('-f')+1]",
    "        return subprocess.CompletedProcess(args, 0, stdout='' if scenario == 'blank-page' and page == '2' else 'text')",
    "    return subprocess.CompletedProcess(args, 0)",
    "original_cwd=os.getcwd()",
    "with tempfile.TemporaryDirectory() as root:",
    "    os.chdir(root)",
    "    with open('source.pdf', 'wb') as f: f.write(b'%PDF-1.4\\n' + bytes(150) + b'%%EOF')",
    "    with zipfile.ZipFile('source.xlsx', 'w') as book: book.writestr('xl/worksheets/sheet1.xml', '<worksheet/>')",
    "    with patch('shutil.which', which), patch('subprocess.run', run), patch('os.geteuid', lambda: 0, create=True):",
    "        try: exec(script)",
    "        finally:",
    "            os.chdir(original_cwd)",
    "            print('RENDER_CALLS=' + str(sum(c[0] == 'pdftoppm' and '-png' in c for c in calls)))",
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

test("semantic spreadsheet QA uses Poppler's supported monochrome invocation", () => {
  const script = artifactVisualQaScript("spreadsheet", "source.xlsx");
  assert.match(script, /'-mono', pdf, mono_prefix/);
  assert.doesNotMatch(script, /'-pbm'/);
  assert.match(script, /--convert-to', 'xlsx'/);
  assert.match(script, /formulaCellsRecalculated/);
  assert.match(script, /formulaValuesInspected/);
});

test("artifact QA checks generated titles against independently extracted rendered text", () => {
  const script = artifactVisualQaScript("docx", "source.docx", "Board brief");
  assert.match(script, /expected_text="Board brief"/);
  assert.match(script, /expectedTitleMatched/);
  assert.match(script, /Rendered content does not include the expected document title/);
});

test("spreadsheet QA inspects independent formula results and expected-value assertions", () => {
  const expected = { "sheet1.xml!C4": 100 };
  const passed = runQa("formula-success", "spreadsheet", expected);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /formulaCellsRecalculated":1/);
  assert.match(passed.stdout, /formulaExpectationsChecked":1/);
  for (const scenario of ["formula-mismatch", "formula-error"]) {
    const failed = runQa(scenario, "spreadsheet", expected);
    assert.equal(failed.status, 2, failed.stderr);
    assert.doesNotMatch(failed.stdout, /visual QA passed/);
  }
  const booleanResult = runQa("formula-boolean", "spreadsheet", { "sheet1.xml!C4": true });
  assert.equal(booleanResult.status, 0, booleanResult.stderr);
});

test("spreadsheet QA permits a successfully rendered empty print page", () => {
  const spreadsheet = runQa("blank-page", "spreadsheet");
  assert.equal(spreadsheet.status, 0, spreadsheet.stderr);
  assert.match(spreadsheet.stdout, /blank spreadsheet print pages=1/);
  const pdf = runQa("blank-page", "pdf");
  assert.equal(pdf.status, 2, pdf.stderr);
  assert.match(pdf.stderr, /page 2 renders blank/);
});

for (const scenario of ["bad-pdf", "empty", "partial"]) {
  test("QA fails closed for " + scenario, () => {
    const result = runQa(scenario);
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotMatch(result.stdout, /visual QA passed/);
  });
}

for (const type of ["docx", "presentation", "spreadsheet"] as const) {
  test(`missing ${type.toUpperCase()} dependencies request isolated rendering without attempting installation`, () => {
    const result = runQa("setup", type);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /CHUSKY_RENDERER_UNAVAILABLE/);
    assert.match(result.stderr, /libreoffice-(writer|calc|impress)/);
    assert.match(result.stdout, /RENDER_CALLS=0/);
  });
}

test("successful Office exit without a converted PDF fails validation", () => {
  const result = runQa("conversion-failed", "docx");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /conversion failed/);
});
