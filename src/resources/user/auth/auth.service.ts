import { Injectable } from '@nestjs/common';
import { CreateUserAuthDto } from './dto/create-user-auth.dto';
import { UpdateUserAuthDto } from './dto/update-user-auth.dto';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { UserAuth } from './entities/auth.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class UserAuthService extends DefaultCRUDService<
  UserAuth,
  CreateUserAuthDto,
  UpdateUserAuthDto
> {
  constructor(
    @InjectRepository(UserAuth)
    private readonly userAuthRepository: Repository<UserAuth>,
  ) {
    super(userAuthRepository);
  }
}
