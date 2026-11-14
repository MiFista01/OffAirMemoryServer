process.env.TZ = 'UTC';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ClassSerializerInterceptor,
  HttpStatus,
  ValidationPipe,
} from '@nestjs/common';
import helmet from 'helmet';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import cookieParser from 'cookie-parser';
import { DocumentBuilder } from '@nestjs/swagger';
import { SwaggerModule } from '@nestjs/swagger';
import { NextFunction, Request, Response, static as expressStatic } from 'express';
import compression from 'compression';
import { existsSync } from 'fs';
import { join } from 'path';
import { BusinessValidationService } from '@utils';
import {
  corsOriginsFromEnv,
  isDeployEnv,
  startEnvCheck,
} from '@constants';
import session from 'express-session';
import { FfmpegService } from './resources/stream/ffmpeg.service';

process.on('unhandledRejection', (reason) => {
  // Encode/HLS fire-and-forget must not kill Nest (Node may exit on unhandled).
  console.error(
    '[unhandledRejection]',
    reason instanceof Error ? reason.stack ?? reason.message : reason,
  );
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack ?? err.message);
});

const SENSITIVE_FIELD_RE = /password|passwd|secret|token|authorization|cookie/i;

function sanitizeValidationValue(property: string, value: unknown): unknown {
  if (SENSITIVE_FIELD_RE.test(property)) {
    return '[redacted]';
  }
  return value;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);
  const businessLogic: BusinessValidationService = app.get(
    BusinessValidationService,
  );
  const configService = app.get(ConfigService);
  const deploy = isDeployEnv(configService.get<string>('PROJECT_STATUS'));

  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  for (const env of startEnvCheck) {
    businessLogic.assertExists(config.get<string>(env), `${env} is required`);
  }
  if (deploy) {
    businessLogic.assertExists(
      configService.get<string>('SESSION_SECRET'),
      'SESSION_SECRET is required',
    );
  }

  // HLS files when nginx is off
  const nginxOn = config.get<string>('NGINX_ON', 'false') === 'true';
  if (!nginxOn) {
    const streamRoot = config.getOrThrow<string>('STREAM_ROOT').trim();
    const ffmpeg = app.get(FfmpegService);
    console.log(`[stream] static → ${streamRoot} at /stream`);
    app.use(
      '/stream',
      (req: Request, res: Response, next: NextFunction) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Accept-Ranges', 'bytes');
        // Viewer is pulling .m3u8/.ts → do not kill encode on idle TTL
        // Dual-slot paths: /{channel}/a/seg.ts — touch channel root.
        const parts = req.path.split('/').filter(Boolean);
        const folder = parts[0];
        if (folder) ffmpeg.touchByFolder(folder);
        // During seek/wipe the playlist is missing → 503.
        // Slot preparing: check channel/a or channel/b.
        const slotFolder =
          parts.length >= 2 && (parts[1] === 'a' || parts[1] === 'b')
            ? `${folder}/${parts[1]}`
            : folder;
        if (slotFolder && ffmpeg.isFolderPreparing(slotFolder)) {
          const playlistPath = join(
            streamRoot,
            ...slotFolder.split('/'),
            'playlist.m3u8',
          );
          if (!existsSync(playlistPath)) {
            res.setHeader('Retry-After', '2');
            res.status(503).type('text/plain').send('HLS preparing');
            return;
          }
        }
        next();
      },
      expressStatic(streamRoot, {
        fallthrough: true,
        index: false,
        etag: false,
        lastModified: false,
      }),
      (_req: Request, res: Response) => {
        if (!res.headersSent) {
          res.status(404).type('text/plain').send('HLS not ready');
        }
      },
    );
  }

  app.use(
    compression({
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        if (req.url?.includes('/stream/')) return false;
        return compression.filter(req, res);
      },
      level: 6,
      threshold: 1024,
    }),
  );

  // Swagger only outside deploy/production
  if (!deploy) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Off-Air Memory API')
      .setDescription(
        'Backend for Off-Air Memory: channels, cartoons, episodes, media scan, broadcast tags, and daily TV schedule',
      )
      .setVersion('1.0')
      .addTag('off-air-memory')
      .build();
    const documentFactory = () =>
      SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, documentFactory);
  }

  app.setGlobalPrefix(configService.get<string>('API_NAME', 'api'));

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:', 'http:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          objectSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );
  app.use(['/static', '/media', '/stream'], (req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Accept-Ranges', 'bytes');
    if (req.path.startsWith('/stream') || req.url.includes('/stream')) {
      res.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      res.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
    next();
  });

  // deploy: FRONT_URL (+ comma-separated). develop: reflect Origin (local DX).
  const corsOrigins = corsOriginsFromEnv(
    configService.get<string>('FRONT_URL'),
  );
  app.enableCors({
    origin: deploy ? corsOrigins : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    maxAge: 86400,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      stopAtFirstError: false,
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY, // 422
      exceptionFactory: (errors) => {
        const logDetails = !deploy;
        if (logDetails) {
          console.log('=== VALIDATION ERRORS ===');
        }

        let childCounter = 0;

        const logErrors = (
          errs: any[],
          path: string = '',
          isRoot: boolean = true,
          parentWasLogged: boolean = false,
        ): void => {
          if (!logDetails) {
            return;
          }
          errs.forEach((error, index) => {
            const currentPath = path
              ? `${path}.${error.property}`
              : error.property;

            const targetName = error.target?.constructor?.name;
            const isDto =
              targetName && targetName.toLowerCase().endsWith('dto');
            if (isDto) {
              const label =
                !isRoot && !parentWasLogged
                  ? `Child ${++childCounter}`
                  : `Error ${index + 1}`;

              console.log(`\n[${label}]`);
              console.log('Property:', currentPath);
              console.log(
                'Value:',
                sanitizeValidationValue(currentPath, error.value),
              );
              console.log('Value type:', typeof error.value);
              console.log(
                'Constraints:',
                error.constraints || 'No constraints',
              );
              console.log(
                'Target:',
                error.target?.constructor?.name || 'Unknown',
              );
            }

            if (error.children && error.children.length > 0) {
              logErrors(error.children, currentPath, false, isDto);
            }
          });
        };

        logErrors(errors);
        if (logDetails) {
          console.log('=== END VALIDATION ERRORS ===');
        }

        const collectErrors = (errs: any[], path: string = ''): any[] => {
          const result: any[] = [];

          for (const error of errs) {
            const currentPath = path
              ? `${path}.${error.property}`
              : error.property;

            if (error.children && error.children.length > 0) {
              result.push(...collectErrors(error.children, currentPath));
            } else if (error.constraints) {
              const entry: Record<string, unknown> = {
                property: currentPath,
                constraints: error.constraints,
                messages: Object.values(error.constraints),
              };
              // Never send raw values in deploy; in develop redact secrets only.
              if (!deploy) {
                entry.value = sanitizeValidationValue(
                  currentPath,
                  error.value,
                );
              }
              result.push(entry);
            }
          }

          return result;
        };

        const allErrors = collectErrors(errors);

        const errorMessages = allErrors
          .map((err) => (err.messages as string[]).join(', '))
          .join('; ');

        return new BadRequestException({
          message: errorMessages || 'Validation failed',
          errors: allErrors,
        });
      },
    }),
  );

  app.use(cookieParser());

  app.use(
    session({
      secret:
        configService.get<string>('SESSION_SECRET') ||
        (deploy ? '' : 'marsel-dev-only'),
      resave: false,
      saveUninitialized: false,
    }),
  );

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  global.mainDir = __dirname;
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on 0.0.0.0:${port}`);
}
bootstrap();
