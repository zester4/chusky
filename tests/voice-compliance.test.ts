import test from "node:test";
import assert from "node:assert/strict";
import { complianceReadiness, normalizeEmergencyAddress, normalizeVoiceComplianceInput } from "../src/calls/compliance.js";

test("normalizes an emergency address and keeps verification pending", () => {
  const record = normalizeVoiceComplianceInput(42, {
    emergencyAddress: { name: " MedVault ", street: "1 Main St", city: "Accra", region: "Greater Accra", postalCode: "GA-100", countryCode: "gh" },
    regulatoryCountries: ["gh", "US", "gh"],
    retentionDays: 7,
  });
  assert.equal(record.emergencyAddress?.name, "MedVault");
  assert.equal(record.emergencyAddress?.countryCode, "GH");
  assert.deepEqual(record.regulatoryCountries, ["GH", "US"]);
  assert.equal(record.retentionDays, 7);
  assert.equal(record.emergencyAddressStatus, "pending_verification");
  assert.equal(record.regulatoryStatus, "pending_verification");
  assert.equal(complianceReadiness(record), "pending_verification");
});

test("preserves existing policy when a partial update omits it", () => {
  const first = normalizeVoiceComplianceInput(42, {
    emergencyAddress: { name: "MedVault", street: "1 Main St", city: "Accra", region: "Greater Accra", postalCode: "GA-100", countryCode: "GH" },
    regulatoryCountries: ["GH"],
    recordingConsentRequired: false,
    optOutEnabled: false,
    retentionDays: 1,
  });
  const second = normalizeVoiceComplianceInput(42, { regulatoryCountries: ["US"] }, first);
  assert.equal(second.recordingConsentRequired, false);
  assert.equal(second.optOutEnabled, false);
  assert.equal(second.retentionDays, 1);
  assert.equal(second.emergencyAddress?.countryCode, "GH");
  assert.deepEqual(second.regulatoryCountries, ["US"]);
});

test("rejects invalid retention and address data", () => {
  assert.throws(() => normalizeVoiceComplianceInput(42, { retentionDays: 2 }), /retentionDays/);
  assert.throws(() => normalizeEmergencyAddress({ name: "", street: "1 Main", city: "Accra", region: "GA", postalCode: "GA-100", countryCode: "GH" }), /name is required/);
  assert.throws(() => normalizeVoiceComplianceInput(42, { regulatoryCountries: ["GHA"] }), /two-letter/);
});

test("verified readiness requires both provider checks", () => {
  const record = normalizeVoiceComplianceInput(42, { emergencyAddress: { name: "MedVault", street: "1 Main", city: "Accra", region: "GA", postalCode: "GA-100", countryCode: "GH" }, regulatoryCountries: ["GH"] });
  assert.equal(complianceReadiness({ ...record, emergencyAddressStatus: "verified" }), "pending_verification");
  assert.equal(complianceReadiness({ ...record, emergencyAddressStatus: "verified", regulatoryStatus: "verified" }), "verified");
});

test("privacy edits preserve provider verification while address edits invalidate only address verification", () => {
  const first = normalizeVoiceComplianceInput(42, { emergencyAddress: { name: "MedVault", street: "1 Main", city: "Accra", region: "GA", postalCode: "GA-100", countryCode: "GH" }, regulatoryCountries: ["GH"] });
  const verified = { ...first, emergencyAddressStatus: "verified" as const, regulatoryStatus: "verified" as const };
  const privacyEdit = normalizeVoiceComplianceInput(42, { retentionDays: 1 }, verified);
  assert.equal(privacyEdit.emergencyAddressStatus, "verified");
  assert.equal(privacyEdit.regulatoryStatus, "verified");
  assert.equal(privacyEdit.version, verified.version + 1);
  const addressEdit = normalizeVoiceComplianceInput(42, { emergencyAddress: { ...verified.emergencyAddress!, street: "2 Main" } }, privacyEdit);
  assert.equal(addressEdit.emergencyAddressStatus, "pending_verification");
  assert.equal(addressEdit.regulatoryStatus, "verified");
});
