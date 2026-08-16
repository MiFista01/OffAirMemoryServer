import { Injectable } from '@nestjs/common';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { UserProfile } from './entities/profile.entity';
import { DefaultCRUDService } from 'src/abstracts/defaultCRUD';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class ProfileService extends DefaultCRUDService<
  UserProfile,
  CreateProfileDto,
  UpdateProfileDto
> {
  constructor(
    @InjectRepository(UserProfile)
    private profileRep: Repository<UserProfile>,
  ) {
    super(profileRep);
  }

  findUserByProfileId(profileId: number) {
    return this.profileRep.findOne({
      where: { id: profileId },
      relations: ['user'],
    });
  }

}
