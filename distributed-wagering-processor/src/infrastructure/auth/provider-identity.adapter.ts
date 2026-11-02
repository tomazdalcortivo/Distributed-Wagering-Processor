import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  AuthenticatedProviderPrincipal,
  ProviderIdentityPort,
} from '../../application/ports/provider-identity.port';

/**
 * Extension point implementation for Section 2 (Authentication).
 *
 * Supports two modes controlled by `AUTH_MODE`:
 * - `"noop"` (default): pass-through adapter for local evaluation/tests, extracting optional
 *   provider identity headers while keeping the architectural port & guard explicit.
 * - `"oidc-jwt"`: validates Bearer token structure and extracts standard OIDC claims
 *   (`sub`, `scope`, `client_id` / `provider_id`) issued by an external IdP (Keycloak / Zitadel).
 */
@Injectable()
export class ConfigurableProviderIdentityAdapter implements ProviderIdentityPort {
  private readonly mode = process.env.AUTH_MODE ?? 'noop';

  async authenticateRequest(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedProviderPrincipal> {
    if (this.mode === 'noop') {
      const providerHeader = this.readHeader(headers, 'x-provider-id');
      return {
        subject: providerHeader ?? 'anonymous-provider',
        providerId: providerHeader,
        scopes: ['wagering:write', 'wagering:read', 'wallets:write', 'wallets:read'],
        claims: { mode: 'noop' },
      };
    }

    const authHeader = this.readHeader(headers, 'authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid OIDC Bearer token');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
      throw new UnauthorizedException('Malformed JWT access token');
    }

    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
        throw new UnauthorizedException('OIDC access token has expired');
      }

      const scopes =
        typeof payload.scope === 'string' ? payload.scope.split(' ') : [];

      return {
        subject: String(payload.sub ?? 'unknown'),
        providerId:
          typeof payload.provider_id === 'string'
            ? payload.provider_id
            : typeof payload.azp === 'string'
              ? payload.azp
              : undefined,
        scopes,
        claims: payload,
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Failed to parse OIDC access token claims');
    }
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  }
}
