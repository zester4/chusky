import assert from "node:assert/strict";
import test from "node:test";
import { renderAuthEmail } from "../src/auth-email.js";

test("renders a branded verification email with a safe fallback URL", () => {
  const html = renderAuthEmail("verification", {
    email: "owner@example.com",
    name: "Morgan",
    url: "https://chusky-web.vercel.app/verify-email/success?token=abc&next=/app",
  });

  assert.match(html, /Verify your email/);
  assert.match(html, /Verify my email/);
  assert.match(html, /chusky/);
  assert.match(html, /token=abc&amp;next=\/app/);
  assert.doesNotMatch(html, /<script/i);
});

test("escapes invitation content before placing it in HTML", () => {
  const html = renderAuthEmail("organization-invitation", {
    email: "owner@example.com",
    name: "<Morgan>",
    organizationName: "A & B <workspace>",
    url: "https://example.com/invite?id=\"quoted\"",
  });

  assert.match(html, /Hi &lt;Morgan&gt;/);
  assert.match(html, /Join A &amp; B &lt;workspace&gt;/);
  assert.match(html, /id=&quot;quoted&quot;/);
  assert.doesNotMatch(html, /<Morgan>|<workspace>/);
});
