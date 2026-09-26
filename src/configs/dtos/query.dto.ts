import { StreamProfile } from '@app-types';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class QueryArrayDto<T> {
  @ApiProperty({
    description: 'Array value from query',
    example: ['1', '2', '3'],
    required: true,
    type: [String],
  })
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === 'string') {
      return value.split(',').map((item) => item.trim());
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  @IsOptional()
  value: T[];

  constructor(data: any) {
    this.value = data;
  }
}

export class QueryBooleanDto {
  @ApiProperty({
    description: 'Boolean value from query',
    example: true,
    required: true,
    type: Boolean,
  })
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsBoolean({ message: 'Value must be a boolean' })
  @IsOptional()
  value: boolean;

  constructor(data: any) {
    this.value = data;
  }
}

export class QueryStrDto {
  @ApiProperty({
    description: 'String value from query',
    example: 'string',
    required: true,
    type: String,
  })
  @IsString({ message: 'Value must be a string' })
  @IsOptional()
  value: string;

  constructor(data: any) {
    this.value = data;
  }
}

export class QueryNumbDto {
  @ApiProperty({
    description: 'Number value from query',
    example: 1,
    required: true,
    type: Number,
  })
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    const num = Number(value);
    return isNaN(num) ? value : num;
  })
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Value must be a number' },
  )
  @IsOptional()
  value: number;

  constructor(data: any) {
    this.value = data;
  }
}

export class QueryStreamProfileDto {
  @ApiPropertyOptional({
    description: 'HLS quality profile',
    enum: StreamProfile,
    example: StreamProfile.P720,
  })
  @IsOptional()
  @IsEnum(StreamProfile, { message: 'Value must be a valid StreamProfile' })
  value: StreamProfile;

  constructor(data: any) {
    this.value = data;
  }
}