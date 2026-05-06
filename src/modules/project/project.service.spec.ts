import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ProjectService } from './project.service'
import { Project } from './entities/project.entity'

const clientId = new Types.ObjectId().toString()
const projectId = new Types.ObjectId().toString()

const mockProject = {
  _id: new Types.ObjectId(projectId),
  name: 'Test Project',
  clientId: { _id: new Types.ObjectId(clientId), name: 'Test Client' },
}

const makeQuery = (resolvedValue: any) => ({
  populate: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(resolvedValue),
})

const mockProjectModel = {
  create: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findOneAndDelete: jest.fn(),
}

describe('ProjectService', () => {
  let service: ProjectService

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectService,
        { provide: getModelToken(Project.name), useValue: mockProjectModel },
      ],
    }).compile()
    service = module.get<ProjectService>(ProjectService)
  })

  describe('create', () => {
    it('creates a project with clientId as ObjectId', async () => {
      mockProjectModel.create.mockResolvedValue(mockProject)
      const result = await service.create({ name: 'Test Project', clientId })
      expect(mockProjectModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Project',
          clientId: expect.any(Types.ObjectId),
        })
      )
      expect(result).toEqual({
        _id: mockProject._id,
        name: mockProject.name,
        code: undefined,
        isActive: undefined,
        client: mockProject.clientId,
      })
    })
  })

  describe('findAll', () => {
    it('returns mapped list of projects for a client', async () => {
      mockProjectModel.find.mockReturnValue(makeQuery([mockProject]))
      const result = await service.findAll(clientId)
      expect(mockProjectModel.find).toHaveBeenCalledWith({
        clientId: expect.any(Types.ObjectId),
      })
      expect(result).toEqual([
        {
          _id: mockProject._id,
          name: mockProject.name,
          client: mockProject.clientId,
        },
      ])
    })

    it('returns empty array when no projects exist', async () => {
      mockProjectModel.find.mockReturnValue(makeQuery([]))
      const result = await service.findAll(clientId)
      expect(result).toEqual([])
    })
  })

  describe('findOne', () => {
    it('returns the project when found', async () => {
      mockProjectModel.findOne.mockReturnValue(makeQuery(mockProject))
      const result = await service.findOne(projectId, clientId)
      expect(result).toEqual({
        _id: mockProject._id,
        name: mockProject.name,
        client: mockProject.clientId,
      })
    })

    it('throws NotFoundException when project does not exist', async () => {
      mockProjectModel.findOne.mockReturnValue(makeQuery(null))
      await expect(service.findOne(projectId, clientId)).rejects.toThrow(
        NotFoundException
      )
    })
  })

  describe('update', () => {
    it('returns updated project', async () => {
      const updated = { ...mockProject, name: 'Updated' }
      mockProjectModel.findOneAndUpdate.mockReturnValue(makeQuery(updated))
      const result = await service.update(
        projectId,
        { name: 'Updated' },
        clientId
      )
      expect(result).toEqual({
        _id: updated._id,
        name: 'Updated',
        client: updated.clientId,
      })
    })

    it('throws NotFoundException when project not found for update', async () => {
      mockProjectModel.findOneAndUpdate.mockReturnValue(makeQuery(null))
      await expect(
        service.update(projectId, { name: 'X' }, clientId)
      ).rejects.toThrow(NotFoundException)
    })
  })

  describe('remove', () => {
    it('returns deleted project', async () => {
      mockProjectModel.findOneAndDelete.mockReturnValue(makeQuery(mockProject))
      const result = await service.remove(projectId, clientId)
      expect(result).toEqual(mockProject)
    })

    it('throws NotFoundException when project not found for delete', async () => {
      mockProjectModel.findOneAndDelete.mockReturnValue(makeQuery(null))
      await expect(service.remove(projectId, clientId)).rejects.toThrow(
        NotFoundException
      )
    })
  })
})
