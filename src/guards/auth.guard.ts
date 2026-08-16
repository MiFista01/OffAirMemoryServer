import { tokenCookieName } from '@constants';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { parse } from 'cookie';
import { ProfileService } from 'src/resources/user/profile/profile.service';
import { UserAuthService } from 'src/resources/user/auth/auth.service';
import { TooledJwtService } from 'src/jwt/jwt.service';
import { DefaultLogMsg } from 'src/abstracts/defaultLogMsg';
import { Logger } from 'winston';
import { Socket } from 'socket.io';
import { UserService } from 'src/resources/user/user/user.service';
import { ReqWithUser } from '@app-types';
import { BusinessValidationService } from '@utils';

/**
 * Authentication guard for HTTP (and optional WebSocket) routes.
 */
@Injectable()
export class AuthGuard extends DefaultLogMsg implements CanActivate {
  protected readonly tag = 'Auth-Error';
  constructor(
    logger: Logger,
    private readonly jwt: JwtService,
    private readonly tooledJwt: TooledJwtService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly profile: ProfileService,
    private readonly userAuth: UserAuthService,
    private readonly user: UserService,
    private readonly businessLogic: BusinessValidationService,
  ) {
    super(logger);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublicMethod = this.reflector.get<boolean>(
      'isPublic',
      context.getHandler(),
    );
    const isPublicClass = this.reflector.get<boolean>(
      'isPublic',
      context.getClass(),
    );
    if (isPublicMethod || isPublicClass) {
      return true;
    }

    if (context.getType() === 'ws') {
      return this.validateWebSocket(context);
    }
    return this.validateHttp(context);
  }

  private async validateHttp(context: ExecutionContext): Promise<boolean> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest();
    const token: string = req.cookies?.[tokenCookieName];

    if (!token) {
      throw new UnauthorizedException('Token not found');
    }
    try {
      const payload: ReqWithUser['user'] = await this.jwt.verify(token, {
        secret: this.config.get<string>('JWT_KEY'),
      });
      if (await this.tooledJwt.isBlacklist(payload.uuid)) {
        this.logMessage(
          'warn',
          'Someone is using a blacklisted token in HTTP',
          {
            msg: this.reqMsg(ctx) + ' - UUID: ' + payload.uuid,
          },
        );
        throw new UnauthorizedException('Token is blacklisted');
      }
      const user = await this.user.findOne({ id: payload.userId });
      this.businessLogic.assertExists(user, 'User not found');
      req.user = payload;

      req.getProfile = async () => {
        if (!req.profile || req.profile.userId !== req.user.userId) {
          req.profile = await this.profile.findOne({ userId: req.user.userId });
        }
        return req.profile;
      };
      req.getAuth = async () => {
        if (!req.auth || req.auth.userId !== req.user.userId) {
          req.auth = await this.userAuth.findOne({ userId: req.user.userId });
        }
        return req.auth;
      };
      return true;
    } catch (error) {
      this.logMessage('error', 'Invalid token / auth failed', {
        error: String(error),
        msg: this.reqMsg(ctx),
      });
      throw new UnauthorizedException('Invalid token');
    }
  }

  private async validateWebSocket(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    const cookieHeader = client.handshake.headers.cookie;
    const parsedCookies = parse(cookieHeader as string);
    const token = parsedCookies[tokenCookieName];
    if (!token) {
      throw new UnauthorizedException('Token not found');
    }

    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>('JWT_KEY'),
      });
      if (await this.tooledJwt.isBlacklist(payload.uuid)) {
        this.logMessage(
          'warn',
          'Someone is using a blacklisted token in WebSocket',
          {
            msg: 'WebSocket - UUID: ' + payload.uuid,
          },
        );
        throw new UnauthorizedException('Token is blacklisted');
      }
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token WebSocket');
    }
  }
}
