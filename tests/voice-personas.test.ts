import test from "node:test";
import assert from "node:assert/strict";
import { applyVoicePersonaToProfile, getVoicePersona, listVoicePersonas } from "../src/calls/personas.js";
import { normalizeVoiceCallProfile, voiceProfileInstructions } from "../src/calls/voiceProfile.js";

test("the voice persona catalogue contains the supported personal and business roles", () => {
  const personas = listVoicePersonas();
  assert.ok(personas.length >= 8);
  assert.ok(personas.some((persona) => persona.category === "personal"));
  assert.ok(personas.some((persona) => persona.category === "business"));
  assert.deepEqual(new Set(personas.map((persona) => persona.id)).size, personas.length);
  for (const persona of personas) {
    assert.equal(persona.version, 1);
    assert.ok(persona.name);
    assert.ok(persona.description);
    assert.ok(persona.guardrails.length > 0);
    assert.ok(persona.capabilities.length > 0);
    assert.equal(persona.toolPolicy.version, 1);
  }
});

test("applying a persona preserves owner context and marks the profile origin", () => {
  const result = applyVoicePersonaToProfile({
    identity: "Maya",
    organization: "Example Co",
    contactName: "Collins",
    facts: ["The caller requested a morning appointment."],
    toolPolicy: { enabled: true, allowedToolkits: ["googlecalendar"], allowedConnectionIds: ["acct_1"], allowExternalWrites: false, version: 1 },
  }, "appointment_coordinator");

  assert.equal(result.personaId, "appointment_coordinator");
  assert.equal(result.personaVersion, 1);
  assert.equal(result.identity, "Maya");
  assert.equal(result.organization, "Example Co");
  assert.deepEqual(result.facts, ["The caller requested a morning appointment."]);
  assert.equal(result.mode, "scheduling");
  assert.equal(result.tone, "professional");
  assert.deepEqual(result.toolPolicy, { enabled: true, allowedToolkits: ["googlecalendar"], allowedConnectionIds: ["acct_1"], allowExternalWrites: false, version: 1 });
});

test("persona application is safe for legacy profiles and its guardrails reach the voice prompt", () => {
  const persona = getVoicePersona("healthcare_assistant");
  assert.ok(persona);
  const profile = normalizeVoiceCallProfile(applyVoicePersonaToProfile({ identity: "Chusky", facts: [] }, persona.id));
  const prompt = voiceProfileInstructions(profile, "outbound", "Check in with the contact");
  assert.equal(profile.personaId, "healthcare_assistant");
  assert.match(prompt, /Do not diagnose, prescribe, change a dose/i);
  assert.match(prompt, /Treat a caller's statement as a reported fact/i);
  assert.doesNotMatch(prompt, /licensed professional named Healthcare Assistant/i);
});
