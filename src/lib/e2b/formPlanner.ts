import type { E2BBrowserForm, E2BBrowserFormControl } from "./types.js";

export type RequestedFormField = {
  label: string;
  value?: string;
  checked?: boolean;
  action?: "fill" | "select_option" | "check" | "uncheck";
};

export type PlannedFormControl = {
  label: string;
  role: string;
  name: string;
  action: "fill" | "select_option" | "check" | "uncheck";
  value?: string;
  checked?: boolean;
  id?: string;
  frameIndex?: number;
  frameUrl?: string;
};

export type FormPlan = {
  formId: string;
  controls: PlannedFormControl[];
  missing: string[];
  validationErrors: Array<{ label: string; message: string }>;
  submit?: { role: string; name: string; id?: string; disabled: boolean };
};

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function score(requested: string, control: E2BBrowserFormControl): number {
  const wanted = normalize(requested);
  const name = normalize(control.name);
  if (!wanted || !name) return 0;
  if (wanted === name) return 100;
  if (name.includes(wanted) || wanted.includes(name)) return 80;
  const wantedTokens = new Set(wanted.split(" ").filter(Boolean));
  const matched = name.split(" ").filter((token) => wantedTokens.has(token)).length;
  if (matched) return 40 + Math.min(30, matched * 10);
  const semanticGroups = [["country", "headquarters", "location", "country"], ["first", "given", "forename"], ["last", "family", "surname"], ["email", "mail"], ["terms", "conditions", "agree", "consent"]];
  const semanticMatch = semanticGroups.some((group) => group.some((token) => wantedTokens.has(token)) && group.some((token) => name.split(" ").includes(token)));
  return semanticMatch ? 55 : 0;
}

function defaultAction(control: E2BBrowserFormControl, field: RequestedFormField): PlannedFormControl["action"] {
  if (field.action) return field.action;
  if (control.role === "checkbox" || control.role === "switch") return field.checked === false ? "uncheck" : "check";
  if (control.role === "radio") return "check";
  if (control.role === "combobox" || control.options?.length) return "select_option";
  return "fill";
}

export function planFormSubmission(forms: E2BBrowserForm[], fields: RequestedFormField[], formId?: string): FormPlan {
  const form = (formId ? forms.find((item) => item.formId === formId) : undefined) ?? forms.find((item) => item.controls.some((control) => fields.some((field) => score(field.label, control) > 0))) ?? forms[0];
  if (!form) return { formId: formId ?? "", controls: [], missing: fields.map((field) => field.label), validationErrors: [] };
  const used = new Set<number>();
  const controls: PlannedFormControl[] = [];
  const missing: string[] = [];
  for (const field of fields.slice(0, 100)) {
    const candidates = form.controls.map((control, index) => ({ control, index, score: score(field.label, control) }))
      .filter((candidate) => candidate.score > 0 && !used.has(candidate.index) && !candidate.control.disabled)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = candidates[0];
    if (!selected) { missing.push(field.label); continue; }
    used.add(selected.index);
    const control = selected.control;
    controls.push({ label: field.label, role: control.role, name: control.name, action: defaultAction(control, field), ...(field.value !== undefined ? { value: field.value } : {}), ...(field.checked !== undefined ? { checked: field.checked } : {}), ...(control.id ? { id: control.id } : {}), ...(control.frameIndex !== undefined ? { frameIndex: control.frameIndex } : {}), ...(control.frameUrl ? { frameUrl: control.frameUrl } : {}) });
  }
  const validationErrors = form.controls.filter((control) => control.invalid).map((control) => ({ label: control.name, message: control.validationMessage || "The field is invalid" }));
  const submit = form.submitControls.find((control) => !control.disabled);
  return { formId: form.formId, controls, missing, validationErrors, ...(submit ? { submit } : {}) };
}
