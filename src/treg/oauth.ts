import type { TregGateway } from "./gateway.js";

/**
 * Optional v2 OAuth facade. Treg owns provider tokens; Chusky stores only a
 * short-lived owner-scoped state hash and safe connection metadata.
 */
export class TregOAuth {
  constructor(private readonly gateway: TregGateway) {}

  providers(organizationId?: string): Promise<unknown> {
    return this.gateway.oauthProviders(organizationId);
  }

  start(provider: string, organizationId?: string) {
    return this.gateway.oauthStart(provider, organizationId);
  }

  status(state: string, organizationId?: string) {
    return this.gateway.oauthStatus(state, organizationId);
  }

  connections(organizationId?: string) {
    return this.gateway.oauthConnections(organizationId);
  }

  revoke(secretId: string, organizationId?: string) {
    return this.gateway.oauthRevoke(secretId, organizationId);
  }
}
