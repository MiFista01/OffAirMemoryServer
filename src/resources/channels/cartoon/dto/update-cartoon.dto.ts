import { PartialType } from '@nestjs/swagger';
import { CreateCartoonDto } from './create-cartoon.dto';

export class UpdateCartoonDto extends PartialType(CreateCartoonDto) {}
