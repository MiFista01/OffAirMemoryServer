import { BroadcastWindowKind } from '@constants';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class CreateBroadcastWindowDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  tagId: number;

  @ApiProperty({ example: '10-20', description: 'MM-DD' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{2}-\d{2}$/)
  startMd: string;

  @ApiProperty({ example: '11-02', description: 'MM-DD' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{2}-\d{2}$/)
  endMd: string;

  @ApiPropertyOptional({
    example: BroadcastWindowKind.BOOST,
    enum: BroadcastWindowKind,
  })
  @IsOptional()
  @IsEnum(BroadcastWindowKind)
  kind?: BroadcastWindowKind;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsNumber()
  multiplier?: number;
}
