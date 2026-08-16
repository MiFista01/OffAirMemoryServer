import { CommonSearchDto } from '@dtos';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SearchUserDto extends CommonSearchDto {
  @ApiProperty({
    description: 'User ID',
    example: 1,
    required: false,
    type: Number,
  })
  @IsNumber()
  @IsOptional()
  id?: number;

  @ApiProperty({
    description: 'Nickname from user profile',
    example: 'John Doe',
    required: false,
    type: String,
  })
  @IsString()
  @IsOptional()
  nickname?: string;
}
