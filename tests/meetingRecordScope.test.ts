import test from "node:test";
import assert from "node:assert/strict";
import { filterMeetingRecordResult, isMeetingRecordLookupTool, meetingRecordLookupIsScoped } from "../src/meetings/representative.js";

test("meeting record lookup classification defaults every provider read to scoped", () => {
  const reads = [
    "HUBSPOT_GET_CONTACT", "HUBSPOT_SEARCH_CONTACTS", "SALESFORCE_GET_ACCOUNT", "STRIPE_LIST_INVOICES",
    "BAMBOOHR_GET_EMPLOYEE", "ZENDESK_SEARCH_TICKETS", "GMAIL_FETCH_EMAILS", "NOTION_QUERY_DATABASE",
    "STRIPE_LIST_CHARGES", "HUBSPOT_GET_COMPANY", "SHOPIFY_LIST_ORDERS", "GOOGLEDRIVE_FIND_FILE",
    "LINEAR_LIST_ISSUES", "AIRTABLE_LIST_RECORDS", "PIPEDRIVE_GET_PERSON", "ZOHO_SEARCH_LEADS",
    "INTERCOM_LIST_CONVERSATIONS", "SLACK_FIND_USERS",
  ];
  for (const slug of reads) assert.equal(isMeetingRecordLookupTool(slug), true, slug);
  assert.equal(isMeetingRecordLookupTool("GOOGLECALENDAR_LIST_EVENTS"), false);
  assert.equal(isMeetingRecordLookupTool("HUBSPOT_CREATE_NOTE"), false);
  assert.equal(isMeetingRecordLookupTool("HUBSPOT_GET_COMPANY", ["HUBSPOT_GET_COMPANY"]), false);
});

test("meeting record results are filtered to the verified participant before model exposure", () => {
  const result = filterMeetingRecordResult({ results: [
    { name: "Sarah Lee", email: "sarah@example.com", balance: 10 },
    { name: "Other Person", email: "other@example.com", balance: 99 },
  ] }, ["sarah@example.com"]);
  assert.deepEqual(result, { results: [{ name: "Sarah Lee", email: "sarah@example.com", balance: 10 }] });
});

test("a single record for someone else is removed before model exposure", () => {
  assert.deepEqual(
    filterMeetingRecordResult({ name: "Tom Ray", email: "tom@example.com", balance: 900 }, ["sarah@example.com"]),
    { records: [] },
  );
});

test("meeting record reads require a confirmed identity in an exact provider email filter", () => {
  assert.equal(meetingRecordLookupIsScoped("HUBSPOT_SEARCH_CONTACTS", { email: "sarah@example.com" }, "sarah@example.com", "confirmed"), true);
  assert.equal(meetingRecordLookupIsScoped("HUBSPOT_SEARCH_CONTACTS", { query: "sarah@example.com" }, "sarah@example.com", "confirmed"), false);
  assert.equal(meetingRecordLookupIsScoped("HUBSPOT_SEARCH_CONTACTS", { email: "sarah@example.com" }, "sarah@example.com", "calendar_matched"), false);
  assert.equal(meetingRecordLookupIsScoped("GOOGLEDRIVE_FIND_FILE", { query: "sarah@example.com" }, "sarah@example.com", "confirmed"), false);
});
