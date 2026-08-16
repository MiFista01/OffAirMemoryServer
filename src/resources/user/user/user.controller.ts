import { Controller, Post, Body, Get } from '@nestjs/common';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ParamDto, Public, QueryDto, ShouldLog } from '@decorators';
import { ParamsNumbDto, QueryArrayDto, QueryStrDto } from '@dtos';
import { SearchUserDto } from './dto/search.dto';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { userSwaggerBodySearch } from '@swagger';

@ApiTags('Users')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}
  @Post()
  @Public()
  @ShouldLog()
  @ApiOperation({ summary: 'Create user' })
  create(@Body() createUserDto: CreateUserDto) {
    return this.userService.register(createUserDto);
  }

  @Post('search')
  @Public()
  @ApiOperation({ summary: 'Find all users by search' })
  @ApiBody({
    description: 'Data for search users',
    type: SearchUserDto,
    examples: { ...userSwaggerBodySearch },
  })
  async findAllBySearch(@Body() body: SearchUserDto) {
    const { relations, page, limit, selects, nickname, ...search } = body;
    const relationsWithProfile = relations?.includes('profile')
      ? relations
      : [...(relations || []), 'profile'];

    const result = await this.userService.findAllBySearch(
      search,
      relationsWithProfile,
      { page: page || -1, limit: limit || -1 },
    );
    return result;
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Find one user by id' })
  async findOne(
    @ParamDto(ParamsNumbDto, 'id') id: number,
    @QueryDto(QueryArrayDto, 'relations', QueryStrDto) relations: string[],
  ) {
    const user = await this.userService.findOne({ id }, relations);
    return user;
  }
}
