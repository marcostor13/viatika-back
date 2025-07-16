import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common'
import { ProjectService } from './project.service'
import { CreateProjectDto } from './dto/create-project.dto'
import { UpdateProjectDto } from './dto/update-project.dto'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard } from '../auth/guards/roles.guard'

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
@Controller('project')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  create(@Body() createProjectDto: CreateProjectDto) {
    return this.projectService.create(createProjectDto)
  }

  @Get(':clientId')
  findAll(@Param('clientId') clientId: string) {
    return this.projectService.findAll(clientId)
  }

  @Get(':id/:clientId')
  findOne(@Param('id') id: string, @Param('clientId') clientId: string) {
    return this.projectService.findOne(id, clientId)
  }

  @Patch(':id/:clientId')
  update(
    @Param('id') id: string,
    @Param('clientId') clientId: string,
    @Body() updateProjectDto: UpdateProjectDto
  ) {
    return this.projectService.update(id, updateProjectDto, clientId)
  }

  @Delete(':id/:clientId')
  remove(@Param('id') id: string, @Param('clientId') clientId: string) {
    return this.projectService.remove(id, clientId)
  }
}
