import test from "node:test";
import assert from "node:assert/strict";
import { telegramCardFallbackHtml, telegramCardFallbackKeyboard, telegramCardRichHtml } from "../src/telegramCards.js";

test("Telegram cards render safe Rich Message buttons and a compatible fallback", () => {
  const card = {
    title: "Approval <required>",
    body: ["Review & choose an action."],
    detail: "CHUCK_DEPLOY",
    buttons: [[
      { text: "Approve", callbackData: "appr:approve:apr_123", style: "success" as const },
      { text: "Deny", callbackData: "appr:deny:apr_123", style: "danger" as const },
    ]],
  };
  const rich = telegramCardRichHtml(card);
  assert.match(rich, /<h3>Approval &lt;required&gt;<\/h3>/);
  assert.match(rich, /<tg-button-row>/);
  assert.match(rich, /type=\"callback_data\" style=\"success\" data=\"appr:approve:apr_123\"/);
  assert.match(telegramCardFallbackHtml(card), /Approval &lt;required&gt;/);
  assert.deepEqual(telegramCardFallbackKeyboard(card)?.inline_keyboard, [[
    { text: "Approve", callback_data: "appr:approve:apr_123" },
    { text: "Deny", callback_data: "appr:deny:apr_123" },
  ]]);
});

test("Telegram cards reject ambiguous button targets", () => {
  assert.throws(() => telegramCardRichHtml({ title: "Bad", body: [], buttons: [[{ text: "Bad", callbackData: "x", url: "https://example.com" }]] }));
});
