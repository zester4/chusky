export interface WebNotificationEvent {
  userId: number;
  eventId: string;
  threadId: string;
  runId: string;
}

type Listener = (event: WebNotificationEvent) => void;
const listeners = new Map<number, Set<Listener>>();

/** Best-effort live fan-out; durable trigger state remains the replay source. */
export function publishWebNotification(event: WebNotificationEvent): void {
  for (const listener of listeners.get(event.userId) ?? []) {
    try { listener(event); } catch { /* A disconnected browser must not affect the workflow. */ }
  }
}

export function subscribeWebNotifications(userId: number, listener: Listener): () => void {
  const current = listeners.get(userId) ?? new Set<Listener>();
  current.add(listener);
  listeners.set(userId, current);
  return () => {
    current.delete(listener);
    if (!current.size) listeners.delete(userId);
  };
}
