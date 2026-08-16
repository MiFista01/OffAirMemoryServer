import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateBroadcastTagDto {
  @ApiProperty({ example: 'halloween' })
  @IsString()
  @IsNotEmpty()
  slug: string;

  @ApiProperty({ example: 'Halloween' })
  @IsString()
  @IsNotEmpty()
  name: string;
}
