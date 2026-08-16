import {
  Controller,
  Get,
  Body,
  Patch,
  NotFoundException,
} from '@nestjs/common';
import { UserAuthService } from './auth.service';
import { UpdateUserAuthDto } from './dto/update-user-auth.dto';
import { Cache, InvalidCache, ParamDto, ShouldLog } from '@decorators';
import { ParamsNumbDto } from '@dtos';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { userAuthSwaggerBodyUpdate } from '@swagger';

@ApiTags('User auth')
@Controller('user-auth')
export class UserAuthController {
  constructor(private readonly userAuthService: UserAuthService) {}

  // @Get(':userId')
  // @Cache({ key: 'user-auth:findOne:{userId}', ttl: 300, includeUser: true })
  // @ApiOperation({ summary: 'Find one user auth by user id' })
  // async findOne(@ParamDto(ParamsNumbDto, 'userId') userId: number) {
  //   const auth = await this.userAuthService.findOne({ userId: userId });
  //   if (!auth) {
  //     throw new NotFoundException('User auth not found');
  //   }
  //   const { password, ...userAuth } = auth;
  //   return userAuth;
  // }

  // @Patch(':userId')
  // @ShouldLog()
  // @InvalidCache(['user:*', 'user-auth:*'], true)
  // @ApiOperation({ summary: 'Update user auth by user id' })
  // @ApiBody({
  //   description: 'Data for update user auth',
  //   type: UpdateUserAuthDto,
  //   examples: { ...userAuthSwaggerBodyUpdate },
  // })
  // update(
  //   @ParamDto(ParamsNumbDto, 'userId') userId: number,
  //   @Body() updateUserAuthDto: UpdateUserAuthDto,
  // ) {
  //   return this.userAuthService.update(userId, updateUserAuthDto);
  // }
}
