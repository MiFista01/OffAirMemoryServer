import { SetMetadata } from '@nestjs/common';
import { LoggingInterceptor } from '@interceptors';

/**
 * Logging decorator for enabling request logging on specific endpoints
 *
 * Provides logging functionality including metadata-based logging control,
 * selective endpoint logging configuration, and integration with
 * logging interceptors for request/response tracking and monitoring.
 *
 * @see {@link LoggingInterceptor} interceptor which work in pair with this decorator
 */
export const ShouldLog = () => SetMetadata('shouldLog', true);
