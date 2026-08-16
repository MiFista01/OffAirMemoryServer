import { SetMetadata } from '@nestjs/common';

/**
 * Public decorator for bypassing authentication on specific endpoints
 *
 * Provides authentication bypass functionality including metadata-based
 * public route configuration, selective endpoint access control, and
 * integration with authentication guards for public API access.
 *
 * @see {@link AuthGuard} guard which work in pair with this decorator
 */
export const Public = () => SetMetadata('isPublic', true);
