import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class CreateProfileDto {
  @ApiProperty({
    description: 'User ID',
    example: 1,
    required: true,
    type: Number,
  })
  @IsNumber()
  @IsNotEmpty()
  userId: number;

  @ApiProperty({
    description: 'Nickname',
    example: 'John Doe',
    required: true,
    type: String,
  })
  @IsString()
  @IsNotEmpty()
  nickname: string;
}
