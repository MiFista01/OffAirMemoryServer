import { Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { ProfileService } from '../profile/profile.service';
import { UserAuthService } from '../auth/auth.service';

@Injectable()
export class UserService extends DefaultCRUDService<User, any, UpdateUserDto> {
  constructor(
    @InjectRepository(User)
    private readonly userRep: Repository<User>,
    private readonly profile: ProfileService,
    private readonly userAuth: UserAuthService,
  ) {
    super(userRep);
  }

  /** Registration (not DefaultCRUD.create — different signature / side effects). */
  async register(createUserDto: CreateUserDto) {
    return this.userRep.manager.transaction(async (manager) => {
      const user = await super.create({}, manager);
      await this.profile.create(
        {
          userId: user.id,
          nickname: createUserDto.username,
        },
        manager,
      );
      await this.userAuth.create(
        {
          userId: user.id,
          username: createUserDto.username,
          email: createUserDto.email,
          password: createUserDto.password,
        },
        manager,
      );
      return user;
    });
  }
}
