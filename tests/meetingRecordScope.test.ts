import test from "node:test";
import assert from "node:assert/strict";
import { filterMeetingRecordResult, isMeetingRecordLookupTool } from "../src/meetings/representative.js";

test("meeting record lookup classification is narrow and read-only", () => {
  assert.equal(isMeetingRecordLookupTool("HUBSPOT_SEARCH_CONTACTS"), true);
  assert.equal(isMeetingRecordLookupTool("HUBSPOT_CREATE_NOTE"), false);
  assert.equal(isMeetingRecordLookupTool("GMAIL_SEARCH_EMAILS"), false);
});

test("meeting record results are filtered to the verified participant before model exposure", () => {
  const result = filterMeetingRecordResult({ results: [
    { name: "Sarah Lee", email: "sarah@example.com", balance: 10 },
    { name: "Other Person", email: "other@example.com", balance: 99 },
  ] }, ["sarah@example.com"]);
  assert.deepEqual(result, { results: [{ name: "Sarah Lee", email: "sarah@example.com", balance: 10 }] });
});
