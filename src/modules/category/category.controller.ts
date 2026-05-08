import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  Request,
} from '@nestjs/common'
import { CategoryService } from './category.service'
import { CreateCategoryDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { ROLES } from '../auth/enums/roles.enum'
import { Roles } from '../auth/decorators/roles.decorador'
import { AuthGuard } from '@nestjs/passport'
import { AuditLogService } from '../audit-log/audit-log.service'

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
@Controller('category')
export class CategoryController {
  constructor(
    private readonly categoryService: CategoryService,
    private readonly auditLogService: AuditLogService
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  async create(@Body() createCategoryDto: CreateCategoryDto, @Request() req: any) {
    const result = await this.categoryService.create(createCategoryDto)
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'create_category',
      module: 'categorias',
      entityId: (result as any)?._id?.toString(),
      details: createCategoryDto.name,
      clientId: req.user.clientId,
    })
    return result
  }

  @Get(':clientId/flat')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  findAllFlat(@Param('clientId') clientId: string) {
    return this.categoryService.findAllFlat(clientId)
  }

  @Get('flat/:clientId')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  findAllFlatLegacy(@Param('clientId') clientId: string) {
    return this.categoryService.findAllFlat(clientId)
  }

  @Get(':clientId')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  findAll(
    @Param('clientId') clientId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string
  ) {
    return this.categoryService.findAll(clientId, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
    })
  }

  @Get(':id/:clientId')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  findOne(@Param('id') id: string, @Param('clientId') clientId: string) {
    return this.categoryService.findOne(id, clientId)
  }

  @Get('key/:key/:clientId')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  findByKey(@Param('key') key: string, @Param('clientId') clientId: string) {
    return this.categoryService.findByKey(key, clientId)
  }

  @Patch(':id/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async update(
    @Param('id') id: string,
    @Param('clientId') clientId: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
    @Request() req: any
  ) {
    const before = await this.categoryService.findOne(id, clientId).catch(() => null)
    const result = await this.categoryService.update(id, updateCategoryDto, clientId)
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'update_category',
      module: 'categorias',
      entityId: id,
      details: JSON.stringify({ before: { limit: (before as any)?.limit }, after: { limit: updateCategoryDto.limit } }),
      clientId: req.user.clientId,
    })
    return result
  }

  @Delete(':id/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async remove(
    @Param('id') id: string,
    @Param('clientId') clientId: string,
    @Request() req: any
  ) {
    const result = await this.categoryService.remove(id, clientId)
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'delete_category',
      module: 'categorias',
      entityId: id,
      clientId: req.user.clientId,
    })
    return result
  }
}
