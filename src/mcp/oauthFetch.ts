import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const OAUTH_REQUEST_TIMEOUT_MS = 20_000;

interface McpResponseLike {
  status: number;
  statusText?: string;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Keep OAuth responses in the SDK's runtime realm. Some instrumented/polyfilled
 * fetch implementations return Response-like objects that fail `instanceof
 * Response`, which makes the MCP SDK stringify them as `[object Response]`.
 */
export function createMcpOAuthFetch(fetchImpl: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response: unknown = await fetchImpl(url, { ...init, signal });
    if (response instanceof Response) return response;

    if (!response || typeof response !== "object") {
      throw new Error("MCP OAuth endpoint returned an invalid HTTP response.");
    }
    const responseLike = response as McpResponseLike;

    if (!Number.isInteger(responseLike.status) || responseLike.status < 200 || responseLike.status > 599 || typeof responseLike.arrayBuffer !== "function") {
      throw new Error("MCP OAuth endpoint returned an invalid HTTP response.");
    }
    const body = [204, 205, 304].includes(responseLike.status) ? null : await responseLike.arrayBuffer();
    return new Response(body, {
      status: responseLike.status,
      statusText: responseLike.statusText,
      headers: new Headers(responseLike.headers),
    });
  };
}
