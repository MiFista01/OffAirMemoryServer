import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { CartoonService } from './cartoon.service';
import { CreateCartoonDto } from './dto/create-cartoon.dto';
import { UpdateCartoonDto } from './dto/update-cartoon.dto';
import { ParamDto } from '@decorators';
import { ParamsNumbDto } from '@dtos';

@Controller('cartoon')
export class CartoonController {
  constructor(private readonly cartoonService: CartoonService) {}

  // @Post()
  // create(@Body() createCartoonDto: CreateCartoonDto) {
  //   return this.cartoonService.create(createCartoonDto);
  // }

  @Get()
  findAll() {
    return this.cartoonService.findAll();
  }

  @Get(':id')
  findOne(@ParamDto(ParamsNumbDto, 'id') id: number) {
    return this.cartoonService.findOne({ id });
  }

  // @Patch(':id')
  // update(
  //   @ParamDto(ParamsNumbDto, 'id') id: number,
  //   @Body() updateCartoonDto: UpdateCartoonDto
  // ) {
  //   return this.cartoonService.update({ id }, updateCartoonDto);
  // }

  // @Delete(':id')
  // remove(@ParamDto(ParamsNumbDto, 'id') id: number) {
  //   return this.cartoonService.remove({ id });
  // }
}
