import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthDto } from './dto/auth.dto';
import { UserAuthService } from 'src/resources/user/auth/auth.service';
import * as argon2 from 'argon2';
import { TooledJwtService } from 'src/jwt/jwt.service';
import { ProfileService } from 'src/resources/user/profile/profile.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly tooledJwt: TooledJwtService,
    private readonly userAuth: UserAuthService,
    private readonly profileService: ProfileService,
  ) {}

  async Login(authDto: AuthDto): Promise<string> {
    const userAuth = await this.userAuth.findOne(
      {
        or: [{ username: authDto.user }, { email: authDto.user }],
      },
      ['user'],
    );
    if (!userAuth) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (!(await argon2.verify(userAuth.password, authDto.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const profile = await this.profileService.findOne({
      userId: userAuth.userId,
    });
    if (!profile) {
      throw new UnauthorizedException('Profile not found');
    }
    if (profile.ban) {
      throw new UnauthorizedException('User is banned');
    }

    await this.userAuth.update(userAuth.id, { lastLogin: new Date() });

    return this.tooledJwt.createToken({
      userId: userAuth.userId,
    });
  }
}
