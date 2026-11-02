import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PROVIDER_IDENTITY_PORT,
  ProviderIdentityPort,
} from '../../../application/ports/provider-identity.port';

export const IS_PUBLIC_ENDPOINT_KEY = 'isPublicEndpoint';
export const Public = () => SetMetadata(IS_PUBLIC_ENDPOINT_KEY, true);

/**
 * HTTP Authentication Guard (Section 2).
 *
 * - Skips endpoints marked with `@Public()` (`/health/live`, `/health/ready`, `/metrics`).
 * - Delegates provider authentication to `ProviderIdentityPort` (Keycloak / Zitadel OIDC or NoOp extension point).
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ENDPOINT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      providerPrincipal?: unknown;
    }>();

    const principal = await this.identityPort.authenticateRequest(
      request.headers ?? {},
    );
    request.providerPrincipal = principal;
    return true;
  }
}
