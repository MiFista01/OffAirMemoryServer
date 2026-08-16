import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  UnauthorizedException,
  Req,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthDto } from './dto/auth.dto';
import { Request, Response } from 'express';
import { cookiesDays, dayMs, tokenCookieName } from '@constants';
import { Public } from '@decorators';
import { TooledJwtService } from 'src/jwt/jwt.service';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { authSwaggerBody } from '@swagger';
import { ReqWithUser } from '@app-types';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tooledJwt: TooledJwtService,
  ) {}

  @Get('check-user')
  @ApiOperation({ summary: 'Check user and refresh token cookie' })
  checkUser(@Req() req: ReqWithUser, @Res() res: Response) {
    if (!req.user) {
      throw new UnauthorizedException();
    }
    const remainingTime = Math.floor((req.user.exp * 1000 - Date.now()) / 1000);

    const token = this.tooledJwt.updateToken(
      {
        uuid: req.user.uuid,
      },
      {
        userId: req.user.userId,
      },
      remainingTime,
    );
    res.cookie(tokenCookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.PROJECT_STATUS === 'deploy',
      maxAge: dayMs * cookiesDays,
      path: '/',
    });

    res.status(202).json({
      message: 'User checked',
      status: 202,
      data: {
        userId: req.user.userId,
        uuid: req.user.uuid,
      },
    });
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Login user' })
  @ApiBody({
    description: 'Username or email and password',
    type: AuthDto,
    examples: { ...authSwaggerBody },
  })
  async login(@Body() authDto: AuthDto, @Res() res: Response) {
    const token = await this.authService.Login(authDto);
    if (!token) {
      throw new UnauthorizedException();
    }

    res.cookie(tokenCookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.PROJECT_STATUS === 'deploy',
      maxAge: dayMs * cookiesDays,
      path: '/',
    });
    res.status(202).json({
      message: 'Login successful',
      status: 202,
    });
  }

  @Get('logout')
  @ApiOperation({ summary: 'Logout user' })
  async logout(@Res() res: Response, @Req() req: Request & { user: any }) {
    res.clearCookie(tokenCookieName);
    await this.tooledJwt.addToBlacklist(req.user.uuid);

    res.status(202).json({
      message: 'Logout successful',
      status: 202,
    });
  }
}
