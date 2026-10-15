/** A request-scoped opening. It has no tools, history, memory, or credentials in its prompt. */
export interface TurnOpening {
  ready: Promise<void>;
  text?: string;
  cost: number;
  close(): void;
}

export function openingFallback(text: string): string {
  if (/\b(?:email|e-mail|inbox|gmail)\b/i.test(text)) return "I'll check the relevant email information first, then work through your request.";
  if (/\b(?:calendar|schedule|appointment|availability)\b/i.test(text)) return "I'll check the relevant calendar details first, then work through your request.";
  if (/\b(?:project|code|repository|repo)\b/i.test(text)) return "I'll inspect the relevant project context first, then work through your request.";
  if (/\b(?:summari[sz]e|summary|recap)\b/i.test(text)) return "I'll review the relevant material and pull together the key points.";
  return "I'll review your request and the relevant context, then work through the next steps.";
}

export function needsTurnOpening(text: string): boolean {
  return Boolean(text.trim()) && !/^(?:hi|hey|hello|thanks|thank you|ok|okay|yes|no|good (?:morning|afternoon|evening))[\s!?.…]*$/i.test(text.trim());
}

/** Start generation immediately; callers start expensive preparation without awaiting ready.
 * Exactly one whole sentence is published. Timeouts abort the provider and use
 * a local, truthful fallback. Closing suppresses late output after any terminal state.
 */
export function startTurnOpening(input: {
  text: string;
  deadlineMs: number;
  signal?: AbortSignal;
  generate(signal: AbortSignal): Promise<{ text?: string; cost?: number }>;
  publish(text: string, signal: AbortSignal): void | Promise<void>;
  observe?(event: { outcome: "generated" | "fallback" | "cancelled" | "delivery_failed"; elapsedMs: number }): void;
}): TurnOpening {
  const started = performance.now();
  const controller = new AbortController();
  let closed = false;
  let finish: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const close = () => { closed = true; controller.abort(); finish(); };
  const opening: TurnOpening = { ready: Promise.resolve(), cost: 0, close };
  const abort = () => close();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) close();
  opening.ready = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (closed) return;
      const generation = Promise.resolve().then(() => input.generate(controller.signal)).then(
        (value) => ({ kind: "generated" as const, value }),
        () => ({ kind: "fallback" as const }),
      );
      const timeout = new Promise<{ kind: "fallback" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "fallback" }), Math.max(1, input.deadlineMs));
      });
      const result = await Promise.race([generation, timeout, stopped.then(() => ({ kind: "cancelled" as const }))]);
      if (closed || input.signal?.aborted || result.kind === "cancelled") return;
      controller.abort();
      const candidate = result.kind === "generated" ? result.value.text?.trim() : undefined;
      // Never render reasoning, markup, tool syntax, links, or truncated prose.
      const safe = candidate && candidate.length <= 400 && !/[<>\n]|https?:|CHUCK_|COMPOSIO_|```/i.test(candidate)
        && /[.!?。！؟]$/.test(candidate);
      const text = safe ? candidate : openingFallback(input.text);
      if (result.kind === "generated" && Number.isFinite(result.value.cost) && (result.value.cost ?? 0) > 0) opening.cost = result.value.cost!;
      const outcome = safe ? "generated" : "fallback";
      const delivery = new AbortController();
      const deliveryTimer = setTimeout(() => delivery.abort(), 1500);
      const onClose = () => delivery.abort();
      void stopped.then(onClose);
      try {
        const delivered = await Promise.race([
          Promise.resolve().then(() => input.publish(text, delivery.signal)).then(() => true),
          new Promise<false>((resolve) => delivery.signal.addEventListener("abort", () => resolve(false), { once: true })),
          stopped.then(() => false),
        ]);
        if (delivered && !closed && !delivery.signal.aborted) opening.text = text;
        if (!closed) input.observe?.({ outcome: delivered ? outcome : "delivery_failed", elapsedMs: performance.now() - started });
      } finally {
        clearTimeout(deliveryTimer);
        delivery.abort();
      }
    } catch {
      input.observe?.({ outcome: "delivery_failed", elapsedMs: performance.now() - started });
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  })();
  return opening;
}
