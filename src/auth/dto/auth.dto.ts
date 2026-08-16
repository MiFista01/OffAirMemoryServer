import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class AuthDto {
  @ApiProperty({
    description: 'Username or Email',
    example: 'user or example@example.com',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  user: string;

  @ApiProperty({
    description: 'Password',
    example: 'password',
    required: true,
    type: String,
  })
  @IsNotEmpty()
  @IsString()
  @MinLength(5, { message: 'Invalid credentials' })
  password: string;
}
