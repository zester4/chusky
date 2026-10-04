export interface DurableSmokeScopeOperations {
  hasNeonRows(userId: number): Promise<boolean>;
  hasRedisSessionKeys(userId: number): Promise<boolean>;
  acquireReservation(userId: number, token: string): Promise<boolean>;
  releaseReservation(userId: number, token: string): Promise<void>;
}

/** Reserve an unused synthetic owner scope before a live durability smoke. */
export async function reserveDurableSmokeScope(
  userId: number,
  token: string,
  operations: DurableSmokeScopeOperations,
): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(userId) || userId < 8_000_000_000_000_000) {
    throw new Error("Durable-state smoke requires a high-range synthetic owner ID.");
  }
  if (!token || token.length > 200) throw new Error("Durable-state smoke reservation token is invalid.");

  const [hasNeonRows, hasRedisSessionKeys] = await Promise.all([
    operations.hasNeonRows(userId),
    operations.hasRedisSessionKeys(userId),
  ]);
  if (hasNeonRows || hasRedisSessionKeys) {
    throw new Error("Synthetic owner scope is not empty; refusing the live durability smoke.");
  }
  if (!await operations.acquireReservation(userId, token)) {
    throw new Error("Synthetic owner scope is already reserved; refusing the live durability smoke.");
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await operations.releaseReservation(userId, token);
  };
}
