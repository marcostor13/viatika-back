import { Test, TestingModule } from '@nestjs/testing'
import { ProjectController } from './project.controller'
import { ProjectService } from './project.service'
import { AuditLogService } from '../audit-log/audit-log.service'
import { CategoryGroupService } from '../category-group/category-group.service'

describe('ProjectController', () => {
  let controller: ProjectController

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectController],
      providers: [
        { provide: ProjectService, useValue: {} },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: CategoryGroupService, useValue: {} },
      ],
    }).compile()
    controller = module.get<ProjectController>(ProjectController)
  })

  it('should be defined', () => {
    expect(controller).toBeDefined()
  })
})
