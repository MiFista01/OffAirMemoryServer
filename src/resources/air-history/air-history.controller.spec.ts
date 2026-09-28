import { Test, TestingModule } from '@nestjs/testing';
import { AirHistoryController } from './air-history.controller';
import { AirHistoryService } from './air-history.service';

describe('AirHistoryController', () => {
  let controller: AirHistoryController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AirHistoryController],
      providers: [AirHistoryService],
    }).compile();

    controller = module.get<AirHistoryController>(AirHistoryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
