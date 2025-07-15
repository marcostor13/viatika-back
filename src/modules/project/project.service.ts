import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Project, ProjectDocument } from './entities/project.entity';

@Injectable()
export class ProjectService {

  constructor(
    @InjectModel(Project.name) private projectModel: Model<ProjectDocument>
  ) { }

  async create(createProjectDto: CreateProjectDto) {
    const clientId = new Types.ObjectId(createProjectDto.clientId);
    const project = await this.projectModel.create({ ...createProjectDto, clientId });
    return project;
  }

  async findAll(clientId: string) {
    const projects = await this.projectModel.find({ clientId: new Types.ObjectId(clientId) }).populate('clientId').exec();
    return projects.map(project => ({
      _id: project._id,
      name: project.name,
      client: project.clientId
    }));
  }

  async findOne(id: string) {
    const project = await this.projectModel.findOne({ _id: new Types.ObjectId(id) }).populate('clientId').exec();
    if (!project) {
      throw new NotFoundException('Proyecto no encontrado');
    }
    return {
      _id: project._id,
      name: project.name,
      client: project.clientId
    };
  }

  async update(id: string, updateProjectDto: UpdateProjectDto) {
    const project = await this.projectModel.findOneAndUpdate({ _id: new Types.ObjectId(id) }, updateProjectDto, { new: true }).exec();
    if (!project) {
      throw new NotFoundException('Proyecto no encontrado');
    }
    return {
      _id: project._id,
      name: project.name,
      client: project.clientId
    };
  }

  remove(id: string) {
    return this.projectModel.findByIdAndDelete(id).exec();
  }
}
