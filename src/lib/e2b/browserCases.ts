export const browserBenchmarkCases = [
  { id: "form-native-controls", tags: ["form", "select", "checkbox"], goal: "Fill text fields, choose a native option, check consent, and verify submission." },
  { id: "form-custom-combobox", tags: ["form", "combobox", "keyboard"], goal: "Use a searchable custom combobox and verify the selected visible option." },
  { id: "dynamic-validation", tags: ["form", "validation", "repair"], goal: "Recover from a server-side validation error without duplicating submission." },
  { id: "multi-tab-download", tags: ["tabs", "download", "verification"], goal: "Open a new tab, download an owner-approved file, and verify the file receipt." },
  { id: "iframe-and-shadow", tags: ["iframe", "shadow-dom"], goal: "Find and interact with a control inside an iframe or shadow-root component." },
  { id: "canvas-drag", tags: ["canvas", "visual"], goal: "Use a fresh screenshot and guarded drag coordinates, then verify the visual result." },
  { id: "challenge-handoff", tags: ["captcha", "handoff"], goal: "Pause at a human-only challenge and resume the same session after verification." },
  { id: "long-running-recovery", tags: ["checkpoint", "crash", "resume"], goal: "Resume a multi-step browser task after a worker or browser restart." },
  { id: "structured-extraction", tags: ["extract", "schema"], goal: "Extract explicitly requested fields with bounded schema evidence." },
  { id: "dynamic-redesign", tags: ["self-healing", "observe", "act"], goal: "Recover when the target DOM changes between observation and action." },
] as const;
