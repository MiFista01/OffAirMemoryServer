import { ApiProperty } from '@nestjs/swagger';
import { PasswordStrength } from '@validators';
import { IsDate, IsString, IsOptional, IsNumber } from 'class-validator';
import { IsNotEmpty } from 'class-validator';

export class UpdateUserAuthDto {
  @ApiProperty({
    description: 'User ID',
    example: 1,
    required: false,
    type: Number,
  })
  @IsNumber()
  @IsOptional()
  userId?: number;

  @ApiProperty({
    description: 'Last Login',
    example: '2021-01-01',
    required: true,
    type: Date,
  })
  @IsDate()
  @IsNotEmpty()
  @IsOptional()
  lastLogin?: Date;

  @ApiProperty({
    description: 'Password',
    example: 'password',
    required: true,
    type: String,
  })
  @IsString()
  @PasswordStrength()
  @IsOptional()
  password?: string;
}
