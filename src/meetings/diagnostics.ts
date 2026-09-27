/** Return only bounded, content-free clues for an owner-private meeting failure. */
export function meetingAgentFailureDiagnostics(error: unknown): {
  errorType: string;
  failureReason: string;
  httpStatus?: number;
} {
  const errorType = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";
  const shaped = error && typeof error === "object" ? error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; status_code?: unknown };
  } : undefined;
  const message = error instanceof Error ? error.message : "";
  const matchedStatus = message.match(/^OpenRouter\s+(\d{3}):/i)?.[1];
  const rawStatus = shaped?.response?.status ?? shaped?.response?.status_code ?? shaped?.status ?? shaped?.statusCode ?? (matchedStatus ? Number(matchedStatus) : undefined);
  const httpStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
    ? rawStatus
    : undefined;

  let failureReason = "agent_runtime_error";
  if (httpStatus) failureReason = `http_${httpStatus}`;
  else if (/OpenRouter returned an empty stream/i.test(message)) failureReason = "model_empty_stream";
  else if (/OpenRouter returned an in-stream error|OpenRouter stream ended/i.test(message)) failureReason = "model_stream_error";
  else if (/No choices in OpenRouter response/i.test(message)) failureReason = "model_empty_response";
  else if (/Composio/i.test(message)) failureReason = "connected_app_runtime_error";
  else if (errorType === "AbortError") failureReason = "request_aborted";

  return { errorType, failureReason, ...(httpStatus ? { httpStatus } : {}) };
}
