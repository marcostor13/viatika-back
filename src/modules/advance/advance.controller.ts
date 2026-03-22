import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Request,
  UseGuards,
  Query,
} from '@nestjs/common'
import { AdvanceService } from './advance.service'
import { CreateAdvanceDto } from './dto/create-advance.dto'
import { ApproveAdvanceDto, RejectAdvanceDto } from './dto/approve-advance.dto'
import { PayAdvanceDto } from './dto/pay-advance.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { AuditLogService } from '../audit-log/audit-log.service'

@Controller('advance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdvanceController {
  constructor(
    private readonly advanceService: AdvanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Colaborador solicita un anticipo */
  @Post()
  @Roles(ROLES.COLABORADOR, ROLES.ADMIN, ROLES.SUPER_ADMIN)
  create(@Body() dto: CreateAdvanceDto, @Request() req) {
    dto.userId = req.user?.sub || req.user?._id
    dto.clientId = dto.clientId || req.user?.clientId
    return this.advanceService.create(dto)
  }

  /** Mis anticipos (colaborador) */
  @Get('my/:userId/client/:clientId')
  @Roles(ROLES.COLABORADOR, ROLES.ADMIN, ROLES.SUPER_ADMIN)
  findMy(@Param('userId') userId: string, @Param('clientId') clientId: string) {
    return this.advanceService.findMyAdvances(userId, clientId)
  }

  /** Todos los anticipos del cliente (Admin/Tesorero) */
  @Get('client/:clientId')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  findAll(@Param('clientId') clientId: string) {
    return this.advanceService.findAllByClient(clientId)
  }

  /** Anticipos pendientes de acción (Admin/Tesorero) */
  @Get('pending/client/:clientId')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  findPending(@Param('clientId') clientId: string) {
    return this.advanceService.findPending(clientId)
  }

  /** Estadísticas para dashboard Tesorería */
  @Get('stats/client/:clientId')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  getStats(@Param('clientId') clientId: string) {
    return this.advanceService.getStats(clientId)
  }

  /** Detalle de un anticipo */
  @Get(':id')
  @Roles(ROLES.COLABORADOR, ROLES.ADMIN, ROLES.SUPER_ADMIN)
  findOne(@Param('id') id: string) {
    return this.advanceService.findOne(id)
  }

  /** Aprobación nivel 1 (Admin/SuperAdmin o usuario con permiso canApproveL1) */
  @Patch(':id/approve-l1')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  async approveL1(@Param('id') id: string, @Body() dto: ApproveAdvanceDto, @Request() req) {
    dto.approvedBy = req.user?.sub || req.user?._id
    const userRole = req.user?.roles?.[0] || req.user?.role
    const result = await this.advanceService.approveL1(id, dto, userRole, req.user?.permissions)
    this.auditLogService.log({ userId: req.user._id || req.user.sub, userName: req.user.name || req.user.email, action: 'approve_advance_l1', module: 'tesoreria', entityId: id, clientId: req.user.clientId })
    return result
  }

  /** Aprobación nivel 2 (SuperAdmin o usuario con permiso canApproveL2) */
  @Patch(':id/approve-l2')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  async approveL2(@Param('id') id: string, @Body() dto: ApproveAdvanceDto, @Request() req) {
    dto.approvedBy = req.user?.sub || req.user?._id
    const userRole = req.user?.roles?.[0] || req.user?.role
    const result = await this.advanceService.approveL2(id, dto, userRole, req.user?.permissions)
    this.auditLogService.log({ userId: req.user._id || req.user.sub, userName: req.user.name || req.user.email, action: 'approve_advance_l2', module: 'tesoreria', entityId: id, clientId: req.user.clientId })
    return result
  }

  /** Rechazo (Admin/SuperAdmin o usuario con permiso de aprobación) */
  @Patch(':id/reject')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  async reject(@Param('id') id: string, @Body() dto: RejectAdvanceDto, @Request() req) {
    dto.rejectedBy = req.user?.sub || req.user?._id
    const userRole = req.user?.roles?.[0] || req.user?.role
    const result = await this.advanceService.reject(id, dto, userRole, req.user?.permissions)
    this.auditLogService.log({ userId: req.user._id || req.user.sub, userName: req.user.name || req.user.email, action: 'reject_advance', module: 'tesoreria', entityId: id, details: dto.rejectionReason, clientId: req.user.clientId })
    return result
  }

  /** Registro de pago / transferencia (SuperAdmin o usuario con canApproveL2) */
  @Patch(':id/register-payment')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  async registerPayment(@Param('id') id: string, @Body() dto: PayAdvanceDto, @Request() req) {
    const userRole = req.user?.roles?.[0] || req.user?.role
    const result = await this.advanceService.registerPayment(id, dto, userRole, req.user?.permissions)
    this.auditLogService.log({ userId: req.user._id || req.user.sub, userName: req.user.name || req.user.email, action: 'pay_advance', module: 'tesoreria', entityId: id, clientId: req.user.clientId })
    return result
  }

  /** Liquidación: compara anticipo vs gastos reales */
  @Patch(':id/settle')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  async settle(@Param('id') id: string, @Request() req) {
    const result = await this.advanceService.settle(id)
    this.auditLogService.log({ userId: req.user._id || req.user.sub, userName: req.user.name || req.user.email, action: 'settle_advance', module: 'tesoreria', entityId: id, clientId: req.user.clientId })
    return result
  }

  /** Registrar devolución de saldo */
  @Patch(':id/return')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  registerReturn(@Param('id') id: string, @Body() body: { returnedAmount: number }) {
    return this.advanceService.registerReturn(id, body.returnedAmount)
  }
}
