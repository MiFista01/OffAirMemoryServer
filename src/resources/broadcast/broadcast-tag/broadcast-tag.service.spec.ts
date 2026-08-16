import { Test, TestingModule } from '@nestjs/testing';
import { BroadcastTagService } from './broadcast-tag.service';

describe('BroadcastTagService', () => {
  let service: BroadcastTagService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BroadcastTagService],
    }).compile();

    service = module.get<BroadcastTagService>(BroadcastTagService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
