import { Global, Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import { winstonLoggerTuner } from '@constants';
import * as winston from 'winston';
const onlyTag = (tag: string) =>
  winston.format((info) => (info.tag === tag ? info : false))();
const onlyUntaggedOrApp = winston.format((info) => {
  const tag = info.tag;
  return tag === undefined || tag === 'App' ? info : false;
})();

/**
 * Logger module for centralized logging configuration and Winston integration
 *
 * Provides logging functionality including Winston logger configuration with
 * multiple file transports, tag-based log filtering, timestamp formatting,
 * log rotation with size and file limits, and global module registration
 * for application-wide logging access with customizable log levels and
 * metadata handling.
 *
 * @see {@link WinstonModule} for logger configuration
 * @see {@link winstonLoggerTuner} for transport configuration
 * @see winston for logging library integration
 */
@Global()
@Module({
  imports: [
    WinstonModule.forRoot({
      transports: [
        ...(process.env.PROJECT_STATUS !== 'deploy'
          ? [
              new winston.transports.Console({
                format: winston.format.combine(
                  winston.format((info) => {
                    const tag = info.tag;
                    if (tag === undefined || tag === 'App') {
                      return false;
                    }
                    return info;
                  })(),
                  winston.format.colorize(),
                  winston.format.simple(),
                ),
              }),
            ]
          : []),
        ...winstonLoggerTuner.map((logTuner) => {
          return new winston.transports.File({
            filename: `logs/${logTuner.filename}.log`,
            level: logTuner.level,
            format: winston.format.combine(
              logTuner.tagTrigger
                ? onlyTag(logTuner.tagTrigger)
                : onlyUntaggedOrApp,
              winston.format.timestamp({ format: 'MM/DD/YYYY, h:mm:ss A' }),
              winston.format.json(),
              winston.format.printf((info) => {
                const {
                  tag,
                  timestamp,
                  level,
                  message,
                  msg,
                  duration_ms,
                  logName,
                  ...other
                } = info;
                const metaExists = Object.keys(other).length > 0;
                return `[${logName ? logName : logTuner.logName}] ${process.pid} ${timestamp} LOG[${level}]: ${message} ${msg ? `- ${msg}` : ''} ${duration_ms ? `- Duration: ${duration_ms}ms` : ''} ${logTuner.useMeta && metaExists ? JSON.stringify(other) : ''}`;
              }),
            ),
            maxsize: 5242880,
            maxFiles: 5,
            tailable: true,
          });
        }),
      ],
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule {}
