import { PartialType } from '@nestjs/swagger';
import { CreateAirHistoryDto } from './create-air-history.dto';

export class UpdateAirHistoryDto extends PartialType(CreateAirHistoryDto) {}
