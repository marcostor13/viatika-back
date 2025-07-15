import { Test, TestingModule } from '@nestjs/testing';
import { ProyectController } from './project.controller';
import { ProyectService } from './project.service';

describe('ProyectController', () => {
  let controller: ProyectController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProyectController],
      providers: [ProyectService],
    }).compile();

    controller = module.get<ProyectController>(ProyectController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
