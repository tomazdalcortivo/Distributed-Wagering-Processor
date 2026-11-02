export interface AuthenticatedProviderPrincipal {
  subject: string;
  providerId?: string;
  scopes: string[];
  claims: Record<string, unknown>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

/**
 * Extension point for external Identity Provider integration (Keycloak / Zitadel OIDC)
 * as specified in Section 2 of the challenge.
 */
export interface ProviderIdentityPort {
  authenticateRequest(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedProviderPrincipal>;
}
