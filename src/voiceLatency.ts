/**
 * Bound optional voice-context reads so a slow enrichment provider cannot
 * delay the first spoken response. The underlying read is read-only and may
 * finish later; its late result is intentionally ignored for this turn.
 */
export async function withLatencyBudget<T>(work: Promise<T>, fallback: T, budgetMs: number): Promise<T> {
  const budget = Math.max(1, Math.floor(Number.isFinite(budgetMs) ? budgetMs : 1));
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const safeWork = work.catch((error) => {
    if (settled) return fallback;
    throw error;
  });
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      settled = true;
      resolve(fallback);
    }, budget);
  });
  try {
    const result = await Promise.race([safeWork, timeout]);
    settled = true;
    return result;
  } catch {
    settled = true;
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
