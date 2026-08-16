import {
  Controller,
  Get,
  Body,
  Patch,
  Post,
  UploadedFiles,
} from '@nestjs/common';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  Cache,
  Cleaner,
  Files,
  InvalidCache,
  ParamDto,
  Public,
  QueryDto,
  ShouldLog,
} from '@decorators';
import { ParamsNumbDto, QueryBooleanDto } from '@dtos';
import { SearchProfileDto } from './dto/search.dto';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  profileSwaggerBodySearch,
  profileSwaggerBodyUpdateAvatar,
} from '@swagger';

@ApiTags('Profiles')
@Controller('profile')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Patch(':userId')
  @ApiBody({
    description: 'Upload avatar image',
    schema: { ...profileSwaggerBodyUpdateAvatar },
  })
  async update(
    @ParamDto(ParamsNumbDto, 'userId') userId: number,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {

  }

  @Post('search')
  async findAllBySearch(
    @Body() body: SearchProfileDto,
    @QueryDto(QueryBooleanDto, 'convertTo') convertTo: boolean,
  ) {
    
  }

  // @Get()
  // @Cache({ key: 'profile:findAll', ttl: 300 })
  // @ApiOperation({ summary: 'Find all profiles' })
  // async findAll() {
  //   return await this.profileService.findAll();
  // }

  // @Get(':userId')
  // @Cache({ key: 'profile:findOne:{userId}', ttl: 300, includeUser: true })
  // @ApiOperation({ summary: 'Find one profile by user id' })
  // async findOne(@ParamDto(ParamsNumbDto, 'userId') userId: number) {
  //   return await this.profileService.findOne({ userId });
  // }
}
