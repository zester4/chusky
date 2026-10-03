import test from "node:test";
import assert from "node:assert/strict";
import { planFormSubmission } from "../src/lib/e2b/formPlanner.js";

test("form planner maps arbitrary labels to native fields, dropdowns, and checkboxes", () => {
  const plan = planFormSubmission([{
    formId: "signup",
    controls: [
      { id: "first", role: "textbox", name: "Legal first name", required: true, disabled: false },
      { id: "country", role: "combobox", name: "Business headquarters", required: true, disabled: false, options: [{ label: "Ghana", value: "gh", disabled: false, selected: false }] },
      { id: "terms", role: "checkbox", name: "I agree to the Terms", required: true, disabled: false, checked: false },
    ],
    submitControls: [{ role: "button", name: "Create account", disabled: false }],
  }], [
    { label: "first name", value: "Ada" },
    { label: "country", value: "Ghana" },
    { label: "terms and conditions", checked: true },
  ]);
  assert.deepEqual(plan.controls.map((item) => [item.action, item.name]), [["fill", "Legal first name"], ["select_option", "Business headquarters"], ["check", "I agree to the Terms"]]);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.submit?.name, "Create account");
});

test("form planner reports missing fields without inventing selectors", () => {
  const plan = planFormSubmission([{ formId: "f", controls: [], submitControls: [] }], [{ label: "Unknown field", value: "x" }]);
  assert.deepEqual(plan.missing, ["Unknown field"]);
  assert.equal(plan.controls.length, 0);
});
