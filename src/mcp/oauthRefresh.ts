import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createMcpOAuthFetch } from "./oauthFetch.js";

export interface McpOAuthRefreshState {
  redirectUri: string;
  clientInformation: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
}

export interface McpOAuthRefreshResult {
  tokens: OAuthTokens;
  state: McpOAuthRefreshState;
}

function metadata(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: "Chusky",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  } as OAuthClientMetadata;
}

/** Refresh an MCP authorization-code token using the v1 SDK's OAuth flow. */
export async function refreshMcpOAuthToken(input: {
  serverUrl: string;
  scopes?: string[];
  state: McpOAuthRefreshState;
  tokens: OAuthTokens;
  fetchImpl?: typeof fetch;
}): Promise<McpOAuthRefreshResult> {
  if (!input.tokens.refresh_token) throw new Error("MCP OAuth refresh token is unavailable");
  const redirect = new URL(input.state.redirectUri);
  if (redirect.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname))) {
    throw new Error("Stored MCP OAuth redirect URI is invalid");
  }

  let nextTokens: OAuthTokens | undefined;
  let discoveryState = input.state.discoveryState;
  let redirectRequested = false;
  const provider: OAuthClientProvider = {
    redirectUrl: redirect.toString(),
    clientMetadata: metadata(redirect.toString()),
    state: () => "chusky-token-refresh",
    clientInformation: () => input.state.clientInformation,
    saveClientInformation: (next) => { input.state.clientInformation = next; },
    tokens: () => input.tokens,
    saveTokens: (next) => { nextTokens = next; },
    redirectToAuthorization: () => { redirectRequested = true; },
    saveCodeVerifier: () => undefined,
    codeVerifier: () => { throw new Error("MCP OAuth refresh unexpectedly requested an authorization code"); },
    discoveryState: () => discoveryState,
    saveDiscoveryState: (next) => { discoveryState = next; },
  };

  const boundedFetch = createMcpOAuthFetch(input.fetchImpl);
  const result = await auth(provider, {
    serverUrl: input.serverUrl,
    ...(input.scopes?.length ? { scope: input.scopes.join(" ") } : {}),
    fetchFn: boundedFetch,
  });
  if (result !== "AUTHORIZED" || redirectRequested || !nextTokens?.access_token) {
    throw new Error("MCP OAuth refresh could not be completed; reconnect this server.");
  }
  return {
    tokens: nextTokens,
    state: {
      redirectUri: redirect.toString(),
      clientInformation: input.state.clientInformation,
      ...(discoveryState ? { discoveryState } : {}),
    },
  };
}
