import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Request,
  UseGuards,
} from '@nestjs/common'
import { DirectReimbursementService } from './direct-reimbursement.service'
import { CreateDirectReimbursementDto } from './dto/create-direct-reimbursement.dto'
import { RegisterDirectReimbursementPaymentDto } from './dto/register-payment.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { AuditLogService } from '../audit-log/audit-log.service'

@Controller('direct-reimbursement')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DirectReimbursementController {
  constructor(
    private readonly service: DirectReimbursementService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  async create(@Body() dto: CreateDirectReimbursementDto, @Request() req: any) {
    const coordinatorId = req.user._id || req.user.sub
    dto.clientId = dto.clientId || req.user?.clientId
    const result = await this.service.create(dto, String(coordinatorId))
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'create_reembolso_directo',
      module: 'reembolso-directo',
      entityId: String(result._id),
      clientId: req.user.clientId,
    })
    return result
  }

  @Get('client/:clientId')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  findAllByClient(@Param('clientId') clientId: string) {
    return this.service.findAllByClient(clientId)
  }

  @Get('pending-payments/client/:clientId')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
  findPendingPayments(@Param('clientId') clientId: string) {
    return this.service.findPendingPayments(clientId)
  }

  @Get('my/client/:clientId')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  findMyExpedients(@Param('clientId') clientId: string, @Request() req: any) {
    const coordinatorId = req.user._id || req.user.sub
    return this.service.findByCoordinator(String(coordinatorId), clientId)
  }

  @Get(':id')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  findOne(@Param('id') id: string) {
    return this.service.findOne(id)
  }

  @Patch(':id/add-expense')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  addExpense(@Param('id') id: string, @Body() body: { expenseId: string }) {
    return this.service.addExpense(id, body.expenseId)
  }

  @Patch(':id/remove-expense')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  removeExpense(@Param('id') id: string, @Body() body: { expenseId: string }) {
    return this.service.removeExpense(id, body.expenseId)
  }

  @Patch(':id/coordinator-approve')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  async coordinatorApprove(@Param('id') id: string, @Request() req: any) {
    const coordinatorId = req.user._id || req.user.sub
    const result = await this.service.coordinatorApprove(id, String(coordinatorId))
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'coordinator_approve_reembolso_directo',
      module: 'reembolso-directo',
      entityId: id,
      clientId: req.user.clientId,
    })
    return result
  }

  @Patch(':id/accounting-approve')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
  async accountingApprove(@Param('id') id: string, @Request() req: any) {
    const approvedBy = req.user._id || req.user.sub
    const result = await this.service.accountingApprove(id, String(approvedBy))
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'accounting_approve_reembolso_directo',
      module: 'reembolso-directo',
      entityId: id,
      clientId: req.user.clientId,
    })
    return result
  }

  @Patch(':id/accounting-reject')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
  async accountingReject(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Request() req: any
  ) {
    const rejectedBy = req.user._id || req.user.sub
    const result = await this.service.accountingReject(id, String(rejectedBy), body.reason)
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'accounting_reject_reembolso_directo',
      module: 'reembolso-directo',
      entityId: id,
      details: body.reason,
      clientId: req.user.clientId,
    })
    return result
  }

  @Patch(':id/register-payment')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
  async registerPayment(
    @Param('id') id: string,
    @Body() dto: RegisterDirectReimbursementPaymentDto,
    @Request() req: any
  ) {
    const paidBy = req.user._id || req.user.sub
    const result = await this.service.registerPayment(id, dto, String(paidBy))
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'pay_reembolso_directo',
      module: 'reembolso-directo',
      entityId: id,
      clientId: req.user.clientId,
    })
    return result
  }

  @Patch(':id/close')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
  async close(@Param('id') id: string, @Request() req: any) {
    const closedBy = req.user._id || req.user.sub
    const result = await this.service.close(id, String(closedBy))
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'close_reembolso_directo',
      module: 'reembolso-directo',
      entityId: id,
      clientId: req.user.clientId,
    })
    return result
  }

  @Patch(':id/overrun-justification')
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  addOverrunJustification(
    @Param('id') id: string,
    @Body() body: { justification: string },
    @Request() req: any
  ) {
    const coordinatorId = req.user._id || req.user.sub
    return this.service.addOverrunJustification(id, body.justification, String(coordinatorId))
  }
}
