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
import { CategoryService } from './category.service'
import { CreateCategoryDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { ROLES } from '../auth/enums/roles.enum'
import { Roles } from '../auth/decorators/roles.decorador'
import { AuthGuard } from '@nestjs/passport'


@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
@Controller('category')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) { }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  create(@Body() createCategoryDto: CreateCategoryDto) {
    return this.categoryService.create(createCategoryDto)
  }

  @Get(':clientId')
  findAll(@Param('clientId') clientId: string) {
    return this.categoryService.findAll(clientId)
  }

  @Get(':id/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  findOne(@Param('id') id: string, @Param('clientId') clientId: string) {
    return this.categoryService.findOne(id, clientId)
  }

  @Get('key/:key/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  findByKey(@Param('key') key: string, @Param('clientId') clientId: string) {
    return this.categoryService.findByKey(key, clientId)
  }

  @Patch(':id/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  update(
    @Param('id') id: string,
    @Param('clientId') clientId: string,
    @Body() updateCategoryDto: UpdateCategoryDto
  ) {
    return this.categoryService.update(id, updateCategoryDto, clientId)
  }

  @Delete(':id/:clientId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  remove(@Param('id') id: string, @Param('clientId') clientId: string) {
    return this.categoryService.remove(id, clientId)
  }
}
