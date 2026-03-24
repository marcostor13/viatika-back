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
import { UpdateUserDto, UpdatePermissionsDto } from './dto/update-user.dto'
import { ParseObjectIdPipe } from './pipes/parse-objectid.pipe'
import { AuditLogService } from '../audit-log/audit-log.service'

@Controller('user')
export class UserController {
  constructor(
    private userService: UserService,
    private auditLogService: AuditLogService,
  ) { }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN)
  @Get()
  async findAllWithClient() {
    return await this.userService.findAllWithClient()
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Post()
  async create(@Body() createdUserDto: CreateUserDto, @Request() req: any) {
    const result = await this.userService.create(createdUserDto)
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'create_user',
      module: 'usuarios',
      entityId: (result as any)?._id?.toString(),
      details: createdUserDto.email,
      clientId: req.user.clientId,
    })
    return result
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Get('client/:clientId')
  async findAll(@Param('clientId', ParseObjectIdPipe) clientId: Types.ObjectId) {
    return await this.userService.findAll(clientId)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Get('details/:id')
  async findOne(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return await this.userService.findOne(id.toString())
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Patch(':id')
  async update(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() updateUserDto: UpdateUserDto
  ) {
    return await this.userService.update(id.toString(), updateUserDto)
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Patch(':id/permissions')
  async updatePermissions(
    @Param('id', ParseObjectIdPipe) id: Types.ObjectId,
    @Body() permissionsDto: UpdatePermissionsDto,
    @Request() req: any,
  ) {
    const result = await this.userService.update(id.toString(), { permissions: permissionsDto })
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'update_permissions',
      module: 'usuarios',
      entityId: id.toString(),
      details: JSON.stringify(permissionsDto),
      clientId: req.user.clientId,
    })
    return result
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @Delete(':id')
  async delete(@Param('id', ParseObjectIdPipe) id: Types.ObjectId) {
    return await this.userService.delete(id.toString())
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch('profile/signature')
  async updateSignature(
    @Body() body: { signature: string },
    @Request() req: any
  ) {
    const userId = req.user._id || req.user.sub
    const result = await this.userService.update(userId, { signature: body.signature })
    this.auditLogService.log({
      userId: userId,
      userName: req.user.name || req.user.email,
      action: 'update_signature',
      module: 'usuarios',
      entityId: userId,
      details: 'El usuario actualizó su firma digital',
      clientId: req.user.clientId,
    })
    return result
  }
}
