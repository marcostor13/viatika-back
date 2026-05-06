import { Injectable, NotFoundException } from '@nestjs/common'
import { CreateProjectDto } from './dto/create-project.dto'
import { UpdateProjectDto } from './dto/update-project.dto'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Project, ProjectDocument } from './entities/project.entity'

@Injectable()
export class ProjectService {
  constructor(
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>
  ) {}

  private generateCode(name: string): string {
    return name
      .toUpperCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20)
  }

  private toResponse(project: ProjectDocument) {
    return {
      _id: project._id,
      name: project.name,
      code: project.code,
      isActive: project.isActive,
      client: project.clientId,
      committedAdvanceTotal: project.committedAdvanceTotal ?? 0,
    }
  }

  /** Delta positivo al aprobar; negativo al registrar pago (Fase 3). */
  async adjustCommittedAdvanceTotal(
    projectId: string,
    clientId: string,
    delta: number
  ): Promise<void> {
    if (!delta) return
    const clientIdObject = new Types.ObjectId(clientId)
    const updated = await this.projectModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(projectId),
          clientId: clientIdObject,
        },
        { $inc: { committedAdvanceTotal: delta } },
        { new: true }
      )
      .exec()
    if (!updated) {
      throw new NotFoundException('Proyecto no encontrado')
    }
    const total = updated.committedAdvanceTotal ?? 0
    if (total < 0) {
      updated.committedAdvanceTotal = 0
      await updated.save()
    }
  }

  async create(createProjectDto: CreateProjectDto) {
    const clientId = new Types.ObjectId(createProjectDto.clientId)
    const code = createProjectDto.code?.trim() || this.generateCode(createProjectDto.name)
    const project = await this.projectModel.create({
      ...createProjectDto,
      code,
      clientId,
    })
    return this.toResponse(project)
  }

  async findAll(clientId: string) {
    const clientIdObject = new Types.ObjectId(clientId)
    const projects = await this.projectModel
      .find({ clientId: clientIdObject })
      .populate('clientId')
      .exec()
    return projects.map((p) => this.toResponse(p))
  }

  async findOne(id: string, clientId: string) {
    const clientIdObject = new Types.ObjectId(clientId)
    const project = await this.projectModel
      .findOne({ _id: new Types.ObjectId(id), clientId: clientIdObject })
      .populate('clientId')
      .exec()
    if (!project) {
      throw new NotFoundException('Proyecto no encontrado')
    }
    return this.toResponse(project)
  }

  async update(
    id: string,
    updateProjectDto: UpdateProjectDto,
    clientId: string
  ) {
    const clientIdObject = new Types.ObjectId(clientId)
    const project = await this.projectModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(id), clientId: clientIdObject },
        updateProjectDto,
        { new: true }
      )
      .populate('clientId')
      .exec()

    if (!project) {
      throw new NotFoundException('Proyecto no encontrado')
    }

    return this.toResponse(project)
  }

  async remove(id: string, clientId: string) {
    const clientIdObject = new Types.ObjectId(clientId)
    const result = await this.projectModel
      .findOneAndDelete({
        _id: new Types.ObjectId(id),
        clientId: clientIdObject,
      })
      .exec()
    if (!result) {
      throw new NotFoundException('Proyecto no encontrado')
    }
    return result
  }
}
