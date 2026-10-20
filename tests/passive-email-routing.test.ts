import assert from "node:assert/strict";
import test from "node:test";
import { isPassiveEmailReadRequest, isPassiveEmailReadToolSlug } from "../src/agent.js";

test("email inbox questions are classified as passive reads", () => {
  assert.equal(isPassiveEmailReadRequest("What have I missed in my email?"), true);
  assert.equal(isPassiveEmailReadRequest("Summarize my unread Gmail messages"), true);
  assert.equal(isPassiveEmailReadRequest("Find the latest email from Twilio"), true);
});

test("email writes and mixed workflows are not classified as passive reads", () => {
  assert.equal(isPassiveEmailReadRequest("Reply to the Twilio email"), false);
  assert.equal(isPassiveEmailReadRequest("Read my email and put the deadline on my calendar"), false);
  assert.equal(isPassiveEmailReadRequest("Remember this email for later"), false);
  assert.equal(isPassiveEmailReadRequest("Which Gmail accounts are connected?"), false);
});

test("only read-shaped Gmail and Outlook actions pass the passive email action test", () => {
  assert.equal(isPassiveEmailReadToolSlug("GMAIL_FETCH_EMAILS"), true);
  assert.equal(isPassiveEmailReadToolSlug("GMAIL_LIST_THREADS"), true);
  assert.equal(isPassiveEmailReadToolSlug("OUTLOOK_SEARCH_MESSAGES"), true);
  assert.equal(isPassiveEmailReadToolSlug("GMAIL_SEND_EMAIL"), false);
  assert.equal(isPassiveEmailReadToolSlug("GMAIL_CREATE_DRAFT"), false);
  assert.equal(isPassiveEmailReadToolSlug("CHUCK_SEARCH_MEMORY"), false);
});
