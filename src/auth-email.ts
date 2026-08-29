type AuthEmailKind = "verification" | "password-reset";

function maskEmail(email: string): string {
  const [local, domain] = email.split("@", 2);
  if (!domain) return "redacted";
  return `${local.slice(0, 1)}***@${domain}`;
}

function subjectFor(kind: AuthEmailKind): string {
  return kind === "verification" ? "Verify your Chusky email" : "Reset your Chusky password";
}

function bodyFor(kind: AuthEmailKind, url: string, name: string): string {
  const action = kind === "verification" ? "verify your email" : "reset your password";
  return [
    `Hi ${name || "there"},`,
    "",
    `Use the link below to ${action} for Chusky:`,
    url,
    "",
    "If you did not request this, you can safely ignore this email.",
  ].join("\n");
}

export async function sendAuthEmail(kind: AuthEmailKind, input: { email: string; name: string; url: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    if (process.env.NODE_ENV === "production") throw new Error("Auth email delivery is not configured");
    console.warn(`[auth] ${kind} email delivery is not configured for ${maskEmail(input.email)}; request accepted for local development`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [input.email], subject: subjectFor(kind), text: bodyFor(kind, input.url, input.name) }),
  });
  if (!response.ok) throw new Error(`Auth email provider returned HTTP ${response.status}`);
}
