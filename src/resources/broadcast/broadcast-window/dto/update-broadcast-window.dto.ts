import { PartialType } from '@nestjs/swagger';
import { CreateBroadcastWindowDto } from './create-broadcast-window.dto';

export class UpdateBroadcastWindowDto extends PartialType(
  CreateBroadcastWindowDto,
) {}
