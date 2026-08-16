import { Test, TestingModule } from '@nestjs/testing';
import { BroadcastTagController } from './broadcast-tag.controller';
import { BroadcastTagService } from './broadcast-tag.service';

describe('BroadcastTagController', () => {
  let controller: BroadcastTagController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BroadcastTagController],
      providers: [BroadcastTagService],
    }).compile();

    controller = module.get<BroadcastTagController>(BroadcastTagController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
