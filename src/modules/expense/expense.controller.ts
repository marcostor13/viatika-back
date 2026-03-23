import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Request,
  UseGuards,
  Logger,
  Query,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ExpenseActorContext, ExpenseService } from './expense.service'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { UpdateExpenseDto } from './dto/update-expense.dto'
import { ApprovalDto } from './dto/approval.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { AuditLogService } from '../audit-log/audit-log.service'

@Controller('expense')
export class ExpenseController {
  private readonly logger = new Logger(ExpenseController.name)

  constructor(
    private readonly expenseService: ExpenseService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private toActorContext(user: {
    _id?: string
    roles?: string[]
    clientId?: string
  }): ExpenseActorContext {
    return {
      userId: String(user?._id ?? ''),
      roleName: user?.roles?.[0] ?? '',
      clientId: user?.clientId,
    }
  }

  @Post('analyze-image')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async analyzeImage(@Body() body: CreateExpenseDto, @Request() req) {
    const clientId = body.clientId || req.user?.clientId
    if (!clientId) {
      throw new Error('No se pudo obtener la empresa del usuario ni del body')
    }
    body.clientId = clientId
    body.userId = req.user?.sub || req.user?._id || body.userId
    const result = await this.expenseService.analyzeImageWithUrl(body)
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'create_invoice',
      module: 'facturas',
      entityId: (result as any)?._id?.toString(),
      clientId,
    })
    return result
  }

  @Post('analize-pdf')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @UseInterceptors(FileInterceptor('file'))
  async analyzePdf(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateExpenseDto,
    @Request() req
  ) {
    const clientId = body.clientId || req.user?.clientId
    if (!clientId) {
      throw new Error('No se pudo obtener la empresa del usuario ni del body')
    }
    body.clientId = clientId
    body.userId = req.user?.sub || req.user?._id || body.userId
    const result = await this.expenseService.analyzePdf(body, file)
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'create_invoice',
      module: 'facturas',
      entityId: (result as any)?._id?.toString(),
      clientId,
    })
    return result
  }

  @Post('mobility-sheet')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async createMobilitySheet(@Body() body: CreateExpenseDto, @Request() req) {
    const clientId = body.clientId || req.user?.clientId
    if (!clientId) throw new Error('No se pudo obtener la empresa del usuario ni del body')
    body.clientId = clientId
    body.userId = req.user?.sub || req.user?._id || body.userId
    const result = await this.expenseService.createMobilitySheet(body)
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'create_mobility_sheet',
      module: 'facturas',
      entityId: (result as any)?._id?.toString(),
      clientId,
    })
    return result
  }

  @Post('other-expense')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async createOtherExpense(@Body() body: CreateExpenseDto, @Request() req) {
    const clientId = body.clientId || req.user?.clientId
    if (!clientId) throw new Error('No se pudo obtener la empresa del usuario ni del body')
    body.clientId = clientId
    body.userId = req.user?.sub || req.user?._id || body.userId
    const result = await this.expenseService.createOtherExpense(body)
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'create_other_expense',
      module: 'facturas',
      entityId: (result as any)?._id?.toString(),
      clientId,
    })
    return result
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  create(@Body() createExpenseDto: CreateExpenseDto, @Request() req) {
    const userId = req.user?.sub || req.user?._id || createExpenseDto.userId
    if (userId) {
      createExpenseDto.userId = userId
    }

    return this.expenseService.create(createExpenseDto)
  }

  /** Rutas estáticas antes de `:clientId` para no capturar `invoice` como clientId */
  @Get('test-sunat-credentials/:clientId')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async testSunatCredentials(@Param('clientId') clientId: string) {
    try {
      const token = await this.expenseService.generateTokenSunat(clientId)
      return {
        success: true,
        message: 'Credenciales SUNAT funcionando correctamente',
        token: {
          access_token: token.access_token ? 'PRESENTE' : 'AUSENTE',
          // token_type: token.token_type,
          // expires_in: token.expires_in,
        },
      }
    } catch (error) {
      return {
        success: false,
        message: 'Error en credenciales SUNAT',
        error: error.message,
        details: error.response?.data || 'Sin detalles adicionales',
      }
    }
  }

  @Get('invoice/:id/sunat-validation')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  getSunatValidation(@Param('id') id: string, @Request() req: { user: { _id?: string; roles?: string[]; clientId?: string } }) {
    return this.expenseService.getSunatValidationInfoForActor(
      id,
      this.toActorContext(req.user),
    )
  }

  @Get('invoice/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  findOne(@Param('id') id: string, @Request() req: { user: { _id?: string; roles?: string[]; clientId?: string } }) {
    return this.expenseService.findOneForActor(id, this.toActorContext(req.user))
  }

  @Get(':clientId')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  findAll(
    @Param('clientId') clientId: string,
    @Request() req,
    @Query() query: Record<string, unknown>,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc'
  ) {
    if (sortBy) query.sortBy = sortBy
    if (sortOrder) query.sortOrder = sortOrder

    return this.expenseService.findAll(clientId, query)
  }

  @Patch('invoice/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  update(
    @Param('id') id: string,
    @Body() updateExpenseDto: UpdateExpenseDto,
    @Request() req: { user: { _id?: string; roles?: string[]; clientId?: string } },
  ) {
    return this.expenseService.update(id, updateExpenseDto, this.toActorContext(req.user))
  }

  @Patch('invoice/:id/approve')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async approveInvoice(
    @Param('id') id: string,
    @Body() approvalDto: ApprovalDto,
    @Request() req
  ) {
    approvalDto.userId = req.user?._id || req.user?.sub
    const result = await this.expenseService.approveInvoice(id, approvalDto)
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'approve_invoice',
      module: 'facturas',
      entityId: id,
      clientId: req.user?.clientId,
    })
    return result
  }

  @Patch('invoice/:id/reject')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async rejectInvoice(
    @Param('id') id: string,
    @Body() approvalDto: ApprovalDto,
    @Request() req
  ) {
    approvalDto.userId = req.user?._id || req.user?.sub
    const result = await this.expenseService.rejectInvoice(id, approvalDto)
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'reject_invoice',
      module: 'facturas',
      entityId: id,
      details: approvalDto.reason,
      clientId: req.user?.clientId,
    })
    return result
  }

  @Delete('invoice/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async remove(@Param('id') id: string, @Request() req) {
    const result = await this.expenseService.remove(id, this.toActorContext(req.user))
    this.auditLogService.log({
      userId: req.user?._id || req.user?.sub,
      userName: req.user?.name || req.user?.email || 'Usuario',
      action: 'delete_invoice',
      module: 'facturas',
      entityId: id,
      clientId: req.user?.clientId,
    })
    return result
  }

  @Post('invoice/:id/validate-sunat')
  @Roles(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.COLABORADOR)
  @UseGuards(JwtAuthGuard, RolesGuard)
  async validateWithSunat(
    @Param('id') id: string,
    @Body()
    body: {
      rucEmisor: string
      serie: string
      correlativo: string
      fechaEmision: string
      montoTotal?: number
      clientId?: string
      tipoComprobante?: string
    },
    @Request() req: any
  ) {
    const clientId = body.clientId || req.user?.clientId
    if (!clientId) {
      throw new Error('No se pudo obtener la empresa del usuario ni del body')
    }
    return this.expenseService.validateWithSunatData(
      id,
      body,
      clientId,
      this.toActorContext(req.user),
    )
  }
}
