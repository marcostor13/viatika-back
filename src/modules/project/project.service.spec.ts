import { Test, TestingModule } from '@nestjs/testing';
import { ProyectService } from './project.service';

describe('ProyectService', () => {
  let service: ProyectService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProyectService],
    }).compile();

    service = module.get<ProyectService>(ProyectService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
