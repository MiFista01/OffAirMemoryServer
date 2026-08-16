import { Test, TestingModule } from '@nestjs/testing';
import { CartoonService } from './cartoon.service';

describe('CartoonService', () => {
  let service: CartoonService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CartoonService],
    }).compile();

    service = module.get<CartoonService>(CartoonService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
