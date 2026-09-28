import { Test, TestingModule } from '@nestjs/testing';
import { AirHistoryService } from './air-history.service';

describe('AirHistoryService', () => {
  let service: AirHistoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AirHistoryService],
    }).compile();

    service = module.get<AirHistoryService>(AirHistoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
