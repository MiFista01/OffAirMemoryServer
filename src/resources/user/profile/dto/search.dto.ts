import { CommonSearchDto } from '@dtos';
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, ValidateIf } from 'class-validator';

export class SearchProfileDto extends CommonSearchDto {
  @ApiProperty({
    description: 'Profile ID',
    example: 1,
    required: false,
    type: Number,
  })
  @ValidateIf((o) => !o.ids)
  @IsNumber()
  @IsOptional()
  id?: number | number[];

  @ApiProperty({
    description: 'Profile IDs',
    example: [1, 2, 3],
    required: false,
    type: [Number],
  })
  @ValidateIf((o) => !o.id)
  @IsNumber({}, { each: true })
  @IsOptional()
  ids?: number[];

  @ApiProperty({
    description: 'Nickname',
    example: 'John Doe',
    required: false,
    type: String,
  })
  @IsString()
  @IsOptional()
  nickname?: string;
}
