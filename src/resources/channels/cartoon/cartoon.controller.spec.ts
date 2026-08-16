import { Test, TestingModule } from '@nestjs/testing';
import { CartoonController } from './cartoon.controller';
import { CartoonService } from './cartoon.service';

describe('CartoonController', () => {
  let controller: CartoonController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CartoonController],
      providers: [CartoonService],
    }).compile();

    controller = module.get<CartoonController>(CartoonController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
