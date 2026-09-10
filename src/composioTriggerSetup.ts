export const COMPOSIO_TRIGGER_EVENT = "composio.trigger.message";
export const COMPOSIO_TRIGGER_WEBHOOK_VERSION = "V3";

type TriggerSubscriptionClient = {
  setWebhookSubscription(input: {
    webhookUrl: string;
    enabledEvents: string[];
    version: "V3";
  }): Promise<{ id: string; webhookUrl: string; version: string; enabledEvents: string[] }>;
};

export type ComposioTriggerSetupStatus = {
  status: "ready" | "misconfigured";
  webhookUrl?: string;
  subscriptionId?: string;
  version?: string;
  error?: string;
};

/**
 * Reconcile Chusky's project-wide Composio subscription with the current v3.1
 * API.  The webhook payload itself is V3; `v3.1` is the REST API route used by
 * the SDK to configure it.
 */
export async function reconcileComposioTriggerSubscription(
  triggers: TriggerSubscriptionClient,
  webhookUrl: string,
): Promise<ComposioTriggerSetupStatus> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { status: "misconfigured", error: "COMPOSIO_WEBHOOK_URL must be an absolute HTTPS URL" };
  }
  if (parsed.protocol !== "https:") {
    return { status: "misconfigured", error: "COMPOSIO_WEBHOOK_URL must use HTTPS" };
  }

  const subscription = await triggers.setWebhookSubscription({
    webhookUrl: parsed.toString(),
    enabledEvents: [COMPOSIO_TRIGGER_EVENT],
    version: COMPOSIO_TRIGGER_WEBHOOK_VERSION,
  });
  if (subscription.version !== COMPOSIO_TRIGGER_WEBHOOK_VERSION) {
    return {
      status: "misconfigured",
      webhookUrl: subscription.webhookUrl,
      subscriptionId: subscription.id,
      version: subscription.version,
      error: `Composio returned webhook payload version ${subscription.version}, expected V3`,
    };
  }
  if (!subscription.enabledEvents.includes(COMPOSIO_TRIGGER_EVENT)) {
    return {
      status: "misconfigured",
      webhookUrl: subscription.webhookUrl,
      subscriptionId: subscription.id,
      version: subscription.version,
      error: "Composio trigger-message delivery is not enabled",
    };
  }
  return {
    status: "ready",
    webhookUrl: subscription.webhookUrl,
    subscriptionId: subscription.id,
    version: subscription.version,
  };
}
