import { Inject } from '@nestjs/common';
import { HttpArgumentsHost } from '@nestjs/common/interfaces';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { DBQueryFilter } from '@filters';

/**
 * Abstract base class for logging functionality in NestJS filters
 *
 * Provides common logging utilities including:
 * - Winston logger injection and configuration
 * - Request information extraction (method, URL, IP, User-Agent)
 * - HTTP response formatting with status codes
 * - Structured logging with customizable tags and metadata
 * - Error handling for logging operations
 *
 * @see {@link DBQueryFilter} for a complete implementation example
 */
export abstract class DefaultLogMsg {
  protected abstract readonly tag: string;

  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) protected readonly logger: Logger,
  ) {}
  protected reqMsg(context: HttpArgumentsHost) {
    try {
      const req = context.getRequest();
      const { method, url, ip, headers } = req;
      const userAgent = headers['user-agent'] || 'Unknown';
      return `${method} ${url} - IP: ${ip} - User-Agent: ${userAgent}`;
    } catch (error) {
      return 'Request not found';
    }
  }
  protected resMsg(
    context: HttpArgumentsHost,
    statusCode: number,
    other: Record<string, any> = {},
  ) {
    try {
      const res = context.getResponse();
      res.status(statusCode).json({
        ...other,
      });
    } catch (error) {
      return 'Response not found';
    }
  }

  protected logMessage(
    level: 'info' | 'warn' | 'error' | 'debug',
    message: string,
    meta: Record<string, any> = {},
    tag?: string,
  ) {
    this.logger?.[level](message, {
      tag: tag || this.tag,
      ...meta,
    });
  }
}
