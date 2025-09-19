import {
  Controller,
  Post,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Get,
  Req,
  Body,
  Param,
  Patch,
  Delete,
} from '@nestjs/common'
import { UserService } from './user.service'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { CreateUserDto } from './dto/create-user.dto'
import { Types } from 'mongoose'
import { UpdateUserDto } from './dto/update-user.dto'
@Controller('user')
export class UserController {
  constructor(private userService: UserService) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Post()
  async create(@Body() createdUserDto: CreateUserDto) {
    return await this.userService.create(createdUserDto)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Get(':clientId')
  async findAll(@Param('clientId') clientId: string) {
    return await this.userService.findAll(new Types.ObjectId(clientId))
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Get(':id/:clientId')
  async findOne(@Param('id') id: string, @Param('clientId') clientId: string) {
    return await this.userService.findOne(id)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Param('clientId') clientId: string,
    @Body() updateUserDto: UpdateUserDto
  ) {
    return await this.userService.update(id, updateUserDto)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return await this.userService.delete(id)
  }
}
