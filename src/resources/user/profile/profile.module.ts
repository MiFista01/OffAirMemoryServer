import { Module } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserProfile } from './entities/profile.entity';

/**
 * Profile resource module for managing user profile data.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserProfile])],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
