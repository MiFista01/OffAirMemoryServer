process.env.TZ = 'UTC';
import { NestFactory, Reflector } from '@nestjs/core';
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
import { NextFunction, Request, Response } from 'express';
import compression from 'compression';
import { BusinessValidationService } from '@utils';
import { startEnvCheck } from '@constants';
import session from 'express-session';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);
  const businessLogic: BusinessValidationService = app.get(
    BusinessValidationService,
  );
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  for (const env of startEnvCheck) {
    businessLogic.assertExists(config.get<string>(env), `${env} is required`);
  }

  app.use(
    compression({
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      },
      level: 6,
      threshold: 1024,
    }),
  );
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

  const configService = app.get(ConfigService);
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
  app.use(['/static', '/media'], (req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Accept-Ranges', 'bytes');
    res.header('Cache-Control', 'public, max-age=31536000, immutable');
    next();
  });
  app.enableCors({
    origin: true,
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
        console.log('=== VALIDATION ERRORS ===');

        const hasConstraintsInChildren = (err: any): boolean => {
          if (err.constraints) return true;
          if (err.children) {
            return err.children.some((child: any) =>
              hasConstraintsInChildren(child),
            );
          }
          return false;
        };

        let childCounter = 0;

        const logErrors = (
          errs: any[],
          path: string = '',
          isRoot: boolean = true,
          parentWasLogged: boolean = false,
        ): void => {
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
              console.log('Value:', error.value);
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
        console.log('=== END VALIDATION ERRORS ===');

        const collectErrors = (errs: any[], path: string = ''): any[] => {
          const result: any[] = [];

          for (const error of errs) {
            const currentPath = path
              ? `${path}.${error.property}`
              : error.property;

            if (error.children && error.children.length > 0) {
              result.push(...collectErrors(error.children, currentPath));
            } else if (error.constraints) {
              result.push({
                property: currentPath,
                value: error.value,
                constraints: error.constraints,
                messages: Object.values(error.constraints),
              });
            }
          }

          return result;
        };

        const allErrors = collectErrors(errors);

        const errorMessages = allErrors
          .map((err) => err.messages.join(', '))
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
      secret: configService.get<string>('SESSION_SECRET') ?? 'marsel',
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
