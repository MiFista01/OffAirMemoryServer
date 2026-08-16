import { IsEmail, IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PasswordStrength } from '@validators';

export class CreateUserAuthDto {
  @ApiProperty({
    description: 'User ID',
    example: 1,
    required: true,
    type: Number,
  })
  @IsNumber()
  userId: number;

  @ApiProperty({
    description: 'Username',
    example: 'John Doe',
    required: true,
    type: String,
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'Email',
    example: 'john.doe@example.com',
    required: true,
    type: String,
  })
  @IsString()
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Password',
    example: 'password',
    required: true,
    type: String,
  })
  @IsString()
  @IsNotEmpty()
  @PasswordStrength()
  password: string;
}
