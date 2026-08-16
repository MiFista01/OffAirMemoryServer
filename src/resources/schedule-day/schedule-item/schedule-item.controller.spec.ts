import { Test, TestingModule } from '@nestjs/testing';
import { ScheduleItemController } from './schedule-item.controller';
import { ScheduleItemService } from './schedule-item.service';

describe('ScheduleItemController', () => {
  let controller: ScheduleItemController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScheduleItemController],
      providers: [ScheduleItemService],
    }).compile();

    controller = module.get<ScheduleItemController>(ScheduleItemController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
