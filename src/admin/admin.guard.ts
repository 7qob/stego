import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService } from './admin.auth';

/**
 * Guards every admin API route.
 *
 * Both failure modes are 404, not 401 or 403. An unauthenticated caller
 * cannot tell an admin route from a route that does not exist, so probing for
 * one tells them nothing — and an instance with no admin password configured
 * looks exactly like a build without the feature.
 *
 * The CSRF check is the one exception that raises 403, because by then the
 * caller has already proved they hold a session.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!this.auth.isEnabled()) throw new NotFoundException();
    if (!this.auth.isAuthenticated(request)) throw new NotFoundException();

    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutating && !this.auth.csrfValid(request)) {
      throw new ForbiddenException('Missing or invalid CSRF token');
    }

    return true;
  }
}
