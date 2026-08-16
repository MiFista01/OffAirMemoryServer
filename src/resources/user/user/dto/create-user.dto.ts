import { PasswordStrength } from '@validators';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { Match } from '@validators';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
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
  @IsEmail()
  @IsNotEmpty()
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
