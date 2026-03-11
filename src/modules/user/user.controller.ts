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
import { ParseObjectIdPipe } from './pipes/parse-objectid.pipe'

@Controller('user')
export class UserController {
  constructor(private userService: UserService) { }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN)
  @Get()
  async findAllWithClient() {
    return await this.userService.findAllWithClient()
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Post()
  async create(@Body() createdUserDto: CreateUserDto) {
    return await this.userService.create(createdUserDto)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Get(':clientId')
  async findAll(@Param('clientId', ParseObjectIdPipe) clientId: Types.ObjectId) {
    return await this.userService.findAll(clientId)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Get(':id/:clientId')
  async findOne(@Param('id', ParseObjectIdPipe) id: Types.ObjectId, @Param('clientId', ParseObjectIdPipe) clientId: Types.ObjectId) {
    return await this.userService.findOne(id.toString())
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Patch(':id')
  async update(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Param('clientId') clientId: string,
    @Body() updateUserDto: UpdateUserDto
  ) {
    return await this.userService.update(id.toString(), updateUserDto)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Delete(':id')
  async delete(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return await this.userService.delete(id.toString())
  }
}
