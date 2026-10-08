type AuthEmailKind = "verification" | "password-reset" | "organization-invitation";

type AuthEmailInput = { email: string; name: string; url: string; organizationName?: string };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function logoUrl(): string {
  const configuredOrigin = process.env.CHUSKY_WEB_ORIGIN?.trim();
  if (!configuredOrigin) return "";
  try {
    const origin = new URL(configuredOrigin).origin;
    return `${origin}/brand/chusky-logo.png`;
  } catch {
    return "";
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@", 2);
  if (!domain) return "redacted";
  return `${local.slice(0, 1)}***@${domain}`;
}

function subjectFor(kind: AuthEmailKind): string {
  if (kind === "verification") return "Verify your Chusky email";
  if (kind === "password-reset") return "Reset your Chusky password";
  return "Invitation to a Chusky workspace";
}

function bodyFor(kind: AuthEmailKind, url: string, name: string, organizationName?: string): string {
  if (kind === "organization-invitation") {
    return [
      `Hi ${name || "there"},`,
      "",
      `You have been invited to join ${organizationName || "a Chusky workspace"}.`,
      "Review and accept the invitation using this link:",
      url,
      "",
      "If you were not expecting this invitation, you can ignore this email.",
    ].join("\n");
  }
  const action = kind === "verification" ? "verify your email" : kind === "password-reset" ? "reset your password" : "join the Chusky workspace";
  return [
    `Hi ${name || "there"},`,
    "",
    `Use the link below to ${action}:`,
    url,
    "",
    "If you did not request this, you can safely ignore this email.",
  ].join("\n");
}

function contentFor(kind: AuthEmailKind, name: string, organizationName?: string): { eyebrow: string; title: string; description: string; action: string; note: string } {
  if (kind === "verification") return {
    eyebrow: "Welcome to Chusky",
    title: "Verify your email",
    description: "One quick step and your private Chusky workspace will be ready.",
    action: "Verify my email",
    note: "This verification link expires for your security. If you did not create a Chusky account, you can safely ignore this email.",
  };
  if (kind === "password-reset") return {
    eyebrow: "Account security",
    title: "Reset your password",
    description: "We received a request to choose a new password for your Chusky account.",
    action: "Choose a new password",
    note: "This link is one-time and expires for your security. If you did not request a password reset, no action is needed.",
  };
  return {
    eyebrow: "Workspace invitation",
    title: `Join ${organizationName || "a Chusky workspace"}`,
    description: `${name || "Someone"} invited you to collaborate in Chusky.`,
    action: "View invitation",
    note: "If you were not expecting this invitation, you can safely ignore this email.",
  };
}

export function renderAuthEmail(kind: AuthEmailKind, input: AuthEmailInput): string {
  const content = contentFor(kind, input.name, input.organizationName);
  const safeName = escapeHtml(input.name || "there");
  const safeDescription = escapeHtml(content.description);
  const safeTitle = escapeHtml(content.title);
  const safeEyebrow = escapeHtml(content.eyebrow);
  const safeAction = escapeHtml(content.action);
  const safeNote = escapeHtml(content.note);
  const safeUrl = escapeHtml(input.url);
  const image = logoUrl();
  const logo = image
    ? `<img src="${escapeHtml(image)}" width="72" height="72" alt="Chusky" style="display:block;width:72px;height:72px;object-fit:contain;border:0;outline:none;text-decoration:none;" />`
    : `<span style="font-family:Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:-1px;color:#111827;">chusky<span style="color:#6b7280;">.</span></span>`;

  return `<!doctype html>
<html lang="en" dir="ltr">
  <head><meta name="x-apple-disable-message-reformatting" /><meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no" /><title>${safeTitle}</title></head>
  <body style="margin:0;background:#f4f6f8;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e5e7eb;">
          <tr><td style="padding:32px 32px 24px;border-bottom:1px solid #eef0f2;">${logo}</td></tr>
          <tr><td style="padding:36px 32px 40px;">
            <p style="margin:0 0 12px;color:#6b7280;font-size:12px;line-height:18px;letter-spacing:1.6px;text-transform:uppercase;">${safeEyebrow}</p>
            <h1 style="margin:0;color:#111827;font-size:32px;line-height:38px;letter-spacing:-0.8px;font-weight:700;">${safeTitle}</h1>
            <p style="margin:20px 0 0;color:#374151;font-size:16px;line-height:26px;">Hi ${safeName},<br />${safeDescription}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 26px;"><tr><td style="border-radius:999px;background:#111827;">
              <a href="${safeUrl}" style="display:inline-block;padding:14px 24px;border-radius:999px;color:#ffffff;font-size:14px;line-height:20px;font-weight:700;text-decoration:none;">${safeAction}</a>
            </td></tr></table>
            <p style="margin:0;color:#6b7280;font-size:13px;line-height:21px;">If the button does not work, copy and paste this link into your browser:</p>
            <p style="margin:8px 0 0;word-break:break-all;color:#4b5563;font-size:12px;line-height:19px;">${safeUrl}</p>
            <p style="margin:28px 0 0;padding-top:22px;border-top:1px solid #eef0f2;color:#6b7280;font-size:12px;line-height:19px;">${safeNote}</p>
          </td></tr>
          <tr><td style="padding:20px 32px;background:#fafafa;color:#9ca3af;font-size:11px;line-height:18px;">Private by default · Built for your work<br />© Chusky AI</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export async function sendAuthEmail(kind: AuthEmailKind, input: AuthEmailInput): Promise<void> {
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
    body: JSON.stringify({
      from,
      to: [input.email],
      subject: subjectFor(kind),
      html: renderAuthEmail(kind, input),
      text: bodyFor(kind, input.url, input.name, input.organizationName),
    }),
  });
  if (!response.ok) throw new Error(`Auth email provider returned HTTP ${response.status}`);
}
