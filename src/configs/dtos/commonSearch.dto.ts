import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNumber, IsOptional } from 'class-validator';

export class CommonSearchDto {
  @ApiProperty({
    description: 'Relations in @Entity',
    example: '["user", "profile"] // start from @Entity keys',
    minLength: 3,
    maxLength: 50,
    required: false,
    type: [String],
  })
  @IsArray()
  @IsOptional()
  relations?: string[];

  @ApiProperty({
    description: 'Select fields in @Entity',
    example: '["user", "profile"] //start from @Entity keys',
    minLength: 3,
    maxLength: 50,
    required: false,
    type: [String],
  })
  @IsArray()
  @IsOptional()
  selects?: string[];

  @ApiProperty({
    description: 'Page number',
    example: 1,
    minLength: 1,
    required: false,
    type: Number,
  })
  @IsNumber()
  @IsOptional()
  page?: number;

  @ApiProperty({
    description: 'Limit items by one page',
    example: 10,
    minLength: 1,
    maxLength: 50,
    required: false,
    type: Number,
  })
  @IsNumber()
  @IsOptional()
  limit?: number;
}
