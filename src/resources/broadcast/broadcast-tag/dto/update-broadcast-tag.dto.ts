import { PartialType } from '@nestjs/swagger';
import { CreateBroadcastTagDto } from './create-broadcast-tag.dto';

export class UpdateBroadcastTagDto extends PartialType(CreateBroadcastTagDto) {}
