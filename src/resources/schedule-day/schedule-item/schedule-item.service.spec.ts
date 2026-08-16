import { Test, TestingModule } from '@nestjs/testing';
import { ScheduleItemService } from './schedule-item.service';

describe('ScheduleItemService', () => {
  let service: ScheduleItemService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ScheduleItemService],
    }).compile();

    service = module.get<ScheduleItemService>(ScheduleItemService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
