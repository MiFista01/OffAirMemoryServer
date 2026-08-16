import {
  IsBooleanString,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for validating positive numeric parameters
 */
export class ParamsNumbDto {
  @ApiProperty({
    description: 'Positive value from URL params',
    example: 1,
    required: true,
    type: Number,
  })
  @IsNotEmpty({ message: 'Value is required' })
  @Transform(({ value }) => {
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return parseInt(value, 10);
    }
    return value;
  })
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'Value must be a number' },
  )
  @IsPositive({ message: 'Value must be a positive number' })
  value: number;

  constructor(data: any) {
    this.value = data;
  }
}

/**
 * DTO for validating integer parameters (including negative values)
 */
export class ParamsIntDto {
  @ApiProperty({
    description: 'Integer value from URL params',
    example: 1,
    required: true,
    type: Number,
  })
  @IsNotEmpty({ message: 'Value is required' })
  @Transform(({ value }) => parseInt(value))
  @IsInt({ message: 'Value must be an integer' })
  value: number;

  constructor(data: any) {
    this.value = data;
  }
}

/**
 * DTO for validating string parameters
 */
export class ParamsStrDto {
  @ApiProperty({
    description: 'String value from URL params',
    example: 'string',
    required: true,
    type: String,
  })
  @IsNotEmpty({ message: 'Value is required' })
  @IsString({ message: 'Value must be a string' })
  value: string;

  constructor(data: any) {
    this.value = data;
  }
}

/**
 * DTO for validating boolean parameters
 */
export class ParamsBooleanDto {
  @ApiProperty({
    description: 'Boolean value from URL params',
    example: true,
    required: true,
    type: Boolean,
  })
  @IsNotEmpty({ message: 'Value is required' })
  @IsBooleanString({ message: 'Value must be a boolean string' })
  @Transform(({ value }) => value === 'true')
  value: boolean;

  constructor(data: any) {
    this.value = data;
  }
}

/**
 * DTO for validating UUID parameters
 */
export class ParamsUuidDto {
  @ApiProperty({
    description: 'UUID value from URL params',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: true,
    type: String,
  })
  @IsNotEmpty({ message: 'Value is required' })
  @IsUUID(4, { message: 'Value must be a valid UUID' })
  value: string;

  constructor(data: any) {
    this.value = data;
  }
}

/**
 * DTO for validating date parameters
 */
export class ParamsDateDto {
  @ApiProperty({
    description: 'Date value from URL params',
    example: '2021-01-01',
    required: true,
    type: String,
  })
  @IsNotEmpty({ message: 'Value is required' })
  @IsDateString({}, { message: 'Value must be a valid date' })
  value: string;

  constructor(data: any) {
    this.value = data;
  }
}
