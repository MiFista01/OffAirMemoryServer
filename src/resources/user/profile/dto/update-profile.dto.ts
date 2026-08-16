import { PartialType } from '@nestjs/mapped-types';
import { CreateProfileDto } from './create-profile.dto';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateProfileDto extends PartialType(CreateProfileDto) {
  @ApiProperty({
    description: 'Avatar',
    example: 'https://example.com/avatar.png',
    required: false,
    type: String,
  })
  @IsString()
  @IsOptional()
  avatar?: string;

  @ApiProperty({
    description: 'Ban',
    example: true,
    required: false,
    type: Boolean,
  })
  @IsBoolean()
  @IsOptional()
  ban?: boolean;
}
