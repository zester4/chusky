import type { E2BBrowserForm, E2BBrowserNode } from "./types.js";

export type BrowserExtractionSchema = {
  type?: "object";
  properties?: Record<string, { type?: string; description?: string; label?: string; role?: string }>;
  required?: string[];
};

export type BrowserExtractionInput = {
  nodes?: E2BBrowserNode[];
  forms?: E2BBrowserForm[];
  pageContent?: string;
};

function normalize(value: unknown): string { return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function findControl(input: BrowserExtractionInput, label: string, role?: string) {
  const wanted = normalize(label);
  for (const form of input.forms ?? []) {
    const control = form.controls.find((item) => normalize(item.name) === wanted || normalize(item.name).includes(wanted) || wanted.includes(normalize(item.name)) && normalize(item.name));
    if (control && (!role || control.role === role)) return control;
  }
  return undefined;
}

/** Extracts only bounded, explicitly requested fields; never returns arbitrary page dumps. */
export function extractBrowserSchema(input: BrowserExtractionInput, schema: BrowserExtractionSchema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(schema.properties ?? {}).slice(0, 100)) {
    const label = definition.label || key;
    const control = findControl(input, label, definition.role);
    if (control) {
      if (control.role === "checkbox" || control.role === "radio" || control.role === "switch") result[key] = control.checked === true;
      else if (control.selectedText !== undefined) result[key] = control.selectedText;
      else if (control.valuePresent !== undefined) result[key] = control.valuePresent;
      else result[key] = { present: true, name: control.name, role: control.role };
      continue;
    }
    const text = String(input.pageContent ?? "");
    const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => normalize(item).includes(normalize(label)));
    if (line) result[key] = line.slice(0, 500);
  }
  return result;
}
