export function prepareVaultSetupDelivery(value: unknown): {
  privateLink: { url: string; expiresAt: number; label: string };
  modelResult: { setupLinkIssued: true; expiresAt: number; message: string };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vault broker did not return a valid private setup link");
  }
  const result = value as Record<string, unknown>;
  const rawUrl = typeof result.setupUrl === "string" ? result.setupUrl : "";
  const expiresAt = result.expiresAt;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Vault broker did not return a valid private setup link");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || !/^\/setup\/[^/]+$/.test(url.pathname)
    || !url.searchParams.get("token")
    || typeof expiresAt !== "number"
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw new Error("Vault broker did not return a valid private setup link");
  }
  return {
    privateLink: { url: url.toString(), expiresAt, label: "Open your private website setup form" },
    modelResult: {
      setupLinkIssued: true,
      expiresAt,
      message: "The private setup link was sent directly to you. Open it to save the login; do not share the link.",
    },
  };
}
