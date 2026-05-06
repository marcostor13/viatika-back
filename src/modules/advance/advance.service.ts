import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import {
  Advance,
  AdvanceDocument,
  ADVANCE_THRESHOLDS,
} from './entities/advance.entity'
import {
  CreateAdvanceDto,
  CreateAdvanceLineDto,
} from './dto/create-advance.dto'
import { ApproveAdvanceDto, RejectAdvanceDto } from './dto/approve-advance.dto'
import { PayAdvanceDto } from './dto/pay-advance.dto'
import { ExpenseReportService } from '../expense-report/expense-report.service'
import { ROLES } from '../auth/enums/roles.enum'
import { ProjectService } from '../project/project.service'
import { CategoryService } from '../category/category.service'
import { UserService } from '../user/user.service'
import { EmailService } from '../email/email.service'

@Injectable()
export class AdvanceService {
  private readonly logger = new Logger(AdvanceService.name)

  constructor(
    @InjectModel(Advance.name)
    private readonly advanceModel: Model<AdvanceDocument>,
    private readonly expenseReportService: ExpenseReportService,
    private readonly projectService: ProjectService,
    private readonly categoryService: CategoryService,
    private readonly userService: UserService,
    private readonly emailService: EmailService
  ) {}

  async create(dto: CreateAdvanceDto): Promise<Advance> {
    if (!dto.clientId) throw new BadRequestException('clientId es requerido')
    if (!dto.userId) throw new BadRequestException('userId es requerido')

    if (this.isViaticoSolicitudPartial(dto)) {
      throw new BadRequestException(
        'Solicitud de viáticos incompleta: lugar, fecha inicio, fecha fin, centro de costo y al menos una línea de detalle son obligatorios.'
      )
    }

    if (this.isViaticoSolicitud(dto)) {
      return this.createViaticoSolicitud(dto)
    }

    return this.createSimpleAdvance(dto)
  }

  /** Total fila = (importe + GLP/día) × días × cantidad de personas (redondeo a 2 decimales). */
  private computeExpectedLineTotal(line: CreateAdvanceLineDto): number {
    const raw = (line.importe + line.glpPerDay) * line.days * line.peopleCount
    return Math.round(raw * 100) / 100
  }

  private startOfDay(d: Date): Date {
    const x = new Date(d)
    x.setHours(0, 0, 0, 0)
    return x
  }

  private isViaticoSolicitud(dto: CreateAdvanceDto): boolean {
    return !!(
      dto.place?.trim() &&
      dto.startDate &&
      dto.endDate &&
      dto.projectId &&
      dto.lines?.length
    )
  }

  private isViaticoSolicitudPartial(dto: CreateAdvanceDto): boolean {
    const any =
      !!dto.place?.trim() ||
      !!dto.startDate ||
      !!dto.endDate ||
      !!dto.projectId ||
      (dto.lines?.length ?? 0) > 0
    if (!any) return false
    return !this.isViaticoSolicitud(dto)
  }

  private async createSimpleAdvance(dto: CreateAdvanceDto): Promise<Advance> {
    const requiredLevels = dto.amount > ADVANCE_THRESHOLDS.L1_MAX ? 2 : 1

    const advance = await this.advanceModel.create({
      userId: new Types.ObjectId(dto.userId),
      clientId: new Types.ObjectId(dto.clientId),
      expenseReportId: dto.expenseReportId
        ? new Types.ObjectId(dto.expenseReportId)
        : undefined,
      amount: dto.amount,
      description: dto.description,
      status: 'pending_l1',
      approvalLevel: 0,
      requiredLevels,
      approvalHistory: [],
    })

    if (dto.expenseReportId) {
      await this.expenseReportService.addAdvanceToReport(
        dto.expenseReportId,
        (advance as any)._id.toString()
      )
    }

    return advance
  }

  private async createViaticoSolicitud(dto: CreateAdvanceDto): Promise<Advance> {
    const profile = await this.userService.findTransactionalProfile(dto.userId!)
    if (!profile?.signature?.trim()) {
      throw new ForbiddenException(
        'Debe registrar su firma digital en el perfil antes de solicitar viáticos.'
      )
    }

    const start = this.startOfDay(new Date(dto.startDate!))
    const end = this.startOfDay(new Date(dto.endDate!))
    if (end < start) {
      throw new BadRequestException(
        'La fecha fin debe ser mayor o igual a la fecha inicio.'
      )
    }

    const today = this.startOfDay(new Date())
    if (start < today) {
      const obs = dto.observations?.trim() ?? ''
      if (obs.length < 10) {
        throw new BadRequestException(
          'Las fechas de inicio en el pasado requieren observaciones con al menos 10 caracteres.'
        )
      }
    }

    await this.projectService.findOne(dto.projectId!, dto.clientId!)

    const lineDocs: {
      categoryId: Types.ObjectId
      importe: number
      peopleCount: number
      glpPerDay: number
      days: number
      lineTotal: number
    }[] = []

    let sum = 0
    for (const line of dto.lines!) {
      const cat = await this.categoryService.findOne(line.categoryId, dto.clientId!)
      if (!cat.isActive) {
        throw new BadRequestException(
          `La categoría "${cat.name}" está inactiva y no puede usarse en la solicitud.`
        )
      }
      const expected = this.computeExpectedLineTotal(line)
      if (Math.abs(line.lineTotal - expected) > 0.02) {
        throw new BadRequestException(
          `Total de línea inconsistente. Esperado S/ ${expected.toFixed(2)}, recibido S/ ${line.lineTotal.toFixed(2)}.`
        )
      }
      sum += line.lineTotal
      lineDocs.push({
        categoryId: new Types.ObjectId(line.categoryId),
        importe: line.importe,
        peopleCount: line.peopleCount,
        glpPerDay: line.glpPerDay,
        days: line.days,
        lineTotal: line.lineTotal,
      })
    }

    const roundedSum = Math.round(sum * 100) / 100
    if (Math.abs(roundedSum - dto.amount) > 0.02) {
      throw new BadRequestException(
        `El monto total (S/ ${dto.amount}) debe coincidir con la suma de líneas (S/ ${roundedSum}).`
      )
    }

    const metaDesc = `Viático: ${dto.place!.trim()} (${dto.startDate!.slice(0, 10)} → ${dto.endDate!.slice(0, 10)})`
    const description = dto.observations?.trim()
      ? `${metaDesc} | ${dto.observations.trim()}`
      : metaDesc

    const requiredLevels =
      roundedSum > ADVANCE_THRESHOLDS.L1_MAX ? 2 : 1

    const advance = await this.advanceModel.create({
      userId: new Types.ObjectId(dto.userId),
      clientId: new Types.ObjectId(dto.clientId),
      expenseReportId: dto.expenseReportId
        ? new Types.ObjectId(dto.expenseReportId)
        : undefined,
      projectId: new Types.ObjectId(dto.projectId!),
      place: dto.place!.trim(),
      startDate: new Date(dto.startDate!),
      endDate: new Date(dto.endDate!),
      lines: lineDocs,
      observations: dto.observations?.trim(),
      amount: roundedSum,
      description,
      status: 'pending_l1',
      approvalLevel: 0,
      requiredLevels,
      approvalHistory: [],
    })

    if (dto.expenseReportId) {
      await this.expenseReportService.addAdvanceToReport(
        dto.expenseReportId,
        (advance as any)._id.toString()
      )
    }

    await this.notifyCoordinatorViatico(
      advance as AdvanceDocument,
      dto.userId!,
      dto.clientId!
    )

    const refreshed = await this.advanceModel
      .findById((advance as any)._id)
      .populate('projectId')
      .populate({
        path: 'lines.categoryId',
        select: 'name key limit isActive',
      })
      .exec()

    return refreshed as Advance
  }

  private async notifyCoordinatorViatico(
    advance: AdvanceDocument,
    collaboratorUserId: string,
    clientId: string
  ): Promise<void> {
    const advanceId = (advance as any)._id?.toString?.() ?? String(advance._id)

    const collaborator =
      await this.userService.findEmailNameClient(collaboratorUserId)

    const profile =
      await this.userService.findTransactionalProfile(collaboratorUserId)
    const coordId = profile?.coordinatorId

    const project = await this.projectService.findOne(
      advance.projectId!.toString(),
      clientId
    )

    const projectLabel = `[${project.code} - ${project.name}]`
    let clientLabel = ''
    const clientPop = project.client as unknown
    if (clientPop && typeof clientPop === 'object' && clientPop !== null) {
      const c = clientPop as { comercialName?: string; businessName?: string }
      clientLabel = String(c.comercialName || c.businessName || '')
    }

    const totalFormatted = Number(advance.amount).toFixed(2)
    const startStr =
      advance.startDate instanceof Date
        ? advance.startDate.toISOString().slice(0, 10)
        : String(advance.startDate).slice(0, 10)
    const endStr =
      advance.endDate instanceof Date
        ? advance.endDate.toISOString().slice(0, 10)
        : String(advance.endDate).slice(0, 10)

    const plainSummary = [
      `ID solicitud: ${advanceId}`,
      `Colaborador: ${collaborator?.name ?? ''}`,
      `Lugar: ${advance.place}`,
      `Fechas: ${startStr} al ${endStr}`,
      `Centro de costo: ${projectLabel}${clientLabel ? ` (${clientLabel})` : ''}`,
      `Monto total: S/ ${totalFormatted}`,
    ].join('\n')

    const platformUrl =
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      'https://app.viatica.tecdidata.com'

    const setNotif = async (payload: {
      recipientUserId?: Types.ObjectId
      status: 'sent' | 'failed' | 'skipped'
      errorMessage?: string
    }) => {
      await this.advanceModel.updateOne(
        { _id: (advance as any)._id },
        {
          $set: {
            coordinatorNotification: {
              recipientUserId: payload.recipientUserId,
              status: payload.status,
              sentAt: new Date(),
              errorMessage: payload.errorMessage,
            },
          },
        }
      )
    }

    if (!coordId) {
      await setNotif({
        status: 'skipped',
        errorMessage: 'Colaborador sin coordinador asignado',
      })
      return
    }

    const coordinator = await this.userService.findEmailNameClient(
      coordId.toString()
    )

    if (
      !coordinator ||
      !collaborator ||
      !coordinator.clientId.equals(collaborator.clientId)
    ) {
      await setNotif({
        recipientUserId: coordId,
        status: 'skipped',
        errorMessage: 'Coordinador inválido o no pertenece al mismo cliente',
      })
      return
    }

    try {
      await this.emailService.sendViaticoSolicitudToCoordinator(
        coordinator.email,
        {
          coordinatorName: coordinator.name,
          collaboratorName: collaborator.name,
          place: advance.place ?? '',
          startDate: startStr,
          endDate: endStr,
          totalFormatted,
          projectLabel,
          plainSummary,
          platformUrl,
        }
      )
      await setNotif({ recipientUserId: coordId, status: 'sent' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al enviar correo'
      this.logger.error(`Fallo notificación viático ${advanceId}: ${msg}`)
      await setNotif({
        recipientUserId: coordId,
        status: 'failed',
        errorMessage: msg,
      })
    }
  }

  async findAllByClient(clientId: string) {
    return this.advanceModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('userId', 'name email')
      .populate('expenseReportId', 'title status')
      .populate('projectId', 'code name isActive clientId')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findMyAdvances(userId: string, clientId: string) {
    return this.advanceModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
      })
      .populate('expenseReportId', 'title status')
      .populate('projectId', 'code name isActive clientId')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findPending(clientId: string) {
    return this.advanceModel
      .find({
        clientId: new Types.ObjectId(clientId),
        status: { $in: ['pending_l1', 'pending_l2', 'approved'] },
      })
      .populate('userId', 'name email bankAccount')
      .populate('expenseReportId', 'title status')
      .populate('projectId', 'code name isActive clientId')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findOne(id: string) {
    const advance = await this.advanceModel
      .findById(id)
      .populate('userId', 'name email bankAccount')
      .populate('expenseReportId', 'title status budget')
      .populate('projectId')
      .populate({
        path: 'lines.categoryId',
        select: 'name key limit isActive',
      })
      .exec()
    if (!advance)
      throw new NotFoundException(`Anticipo con ID ${id} no encontrado`)
    return advance
  }

  async approveL1(
    id: string,
    dto: ApproveAdvanceDto,
    userRole: string,
    userPermissions?: any
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'pending_l1') {
      throw new BadRequestException(
        `El anticipo no está en estado de aprobación nivel 1 (estado actual: ${advance.status})`
      )
    }

    const canApproveL1 =
      [ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(userRole as ROLES) ||
      userPermissions?.canApproveL1 === true
    if (!canApproveL1)
      throw new ForbiddenException('No tienes permiso para aprobar en nivel 1')

    advance.approvalHistory.push({
      level: 1,
      approvedBy: dto.approvedBy || 'sistema',
      action: 'approved',
      notes: dto.notes,
      date: new Date(),
    })
    advance.approvalLevel = 1

    if (advance.requiredLevels === 1) {
      advance.status = 'approved'
    } else {
      advance.status = 'pending_l2'
    }

    return advance.save()
  }

  async approveL2(
    id: string,
    dto: ApproveAdvanceDto,
    userRole: string,
    userPermissions?: any
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'pending_l2') {
      throw new BadRequestException(
        `El anticipo no está en estado de aprobación nivel 2 (estado actual: ${advance.status})`
      )
    }

    const canApproveL2 =
      userRole === ROLES.SUPER_ADMIN || userPermissions?.canApproveL2 === true
    if (!canApproveL2)
      throw new ForbiddenException('No tienes permiso para aprobar en nivel 2')

    advance.approvalHistory.push({
      level: 2,
      approvedBy: dto.approvedBy || 'sistema',
      action: 'approved',
      notes: dto.notes,
      date: new Date(),
    })
    advance.approvalLevel = 2
    advance.status = 'approved'

    return advance.save()
  }

  async reject(
    id: string,
    dto: RejectAdvanceDto,
    userRole: string,
    userPermissions?: any
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    const rejectableStatuses = ['pending_l1', 'pending_l2']
    if (!rejectableStatuses.includes(advance.status)) {
      throw new BadRequestException(
        `No se puede rechazar un anticipo en estado "${advance.status}"`
      )
    }

    const canReject =
      [ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(userRole as ROLES) ||
      userPermissions?.canApproveL1 === true ||
      userPermissions?.canApproveL2 === true
    if (!canReject)
      throw new ForbiddenException('No tienes permiso para rechazar anticipos')

    advance.approvalHistory.push({
      level: advance.status === 'pending_l2' ? 2 : 1,
      approvedBy: dto.rejectedBy || 'sistema',
      action: 'rejected',
      notes: dto.rejectionReason,
      date: new Date(),
    })
    advance.status = 'rejected'
    advance.rejectedBy = dto.rejectedBy
    advance.rejectionReason = dto.rejectionReason

    return advance.save()
  }

  async registerPayment(
    id: string,
    dto: PayAdvanceDto,
    userRole: string,
    userPermissions?: any
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'approved') {
      throw new BadRequestException(
        `Solo se puede registrar pago de anticipos aprobados (estado actual: ${advance.status})`
      )
    }

    const canPay =
      userRole === ROLES.SUPER_ADMIN || userPermissions?.canApproveL2 === true
    if (!canPay)
      throw new ForbiddenException('No tienes permiso para registrar pagos')

    advance.paymentInfo = {
      method: dto.method,
      bankName: dto.bankName,
      accountNumber: dto.accountNumber,
      cci: dto.cci,
      transferDate: new Date(dto.transferDate),
      reference: dto.reference,
    }
    advance.status = 'paid'

    return advance.save()
  }

  async settle(id: string): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'paid') {
      throw new BadRequestException(
        `Solo se puede liquidar anticipos pagados (estado actual: ${advance.status})`
      )
    }

    let expenseTotal = 0
    if (advance.expenseReportId) {
      try {
        const report = await this.expenseReportService.findOneWithAdvances(
          advance.expenseReportId.toString()
        )
        expenseTotal = (report.expenseIds as any[]).reduce(
          (sum, e) => sum + (e.total || 0),
          0
        )
      } catch (err) {
        this.logger.warn(
          'No se pudo obtener la rendición para calcular liquidación'
        )
      }
    }

    const advanceAmount = advance.amount
    const difference = advanceAmount - expenseTotal
    let type: 'reembolso' | 'devolucion' | 'equilibrado'

    if (Math.abs(difference) < 0.01) {
      type = 'equilibrado'
    } else if (difference > 0) {
      type = 'devolucion' // employee must return excess
    } else {
      type = 'reembolso' // company must reimburse employee
    }

    const settlement = {
      expenseTotal,
      advanceAmount,
      difference,
      type,
      settledAt: new Date(),
    }

    advance.settlement = settlement
    advance.status = 'settled'

    if (advance.expenseReportId) {
      await this.expenseReportService.updateSettlement(
        advance.expenseReportId.toString(),
        {
          advanceTotal: advanceAmount,
          expenseTotal,
          difference,
          type,
          settledAt: new Date(),
        }
      )
    }

    return advance.save()
  }

  async registerReturn(id: string, returnedAmount: number): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'settled' && advance.status !== 'paid') {
      throw new BadRequestException(
        `Solo se puede registrar devolución de anticipos pagados o liquidados`
      )
    }

    advance.returnedAmount = returnedAmount
    advance.status = 'returned'

    return advance.save()
  }

  async getStats(clientId: string) {
    const [pending_l1, pending_l2, approved, paid, settled] = await Promise.all(
      [
        this.advanceModel.countDocuments({
          clientId: new Types.ObjectId(clientId),
          status: 'pending_l1',
        }),
        this.advanceModel.countDocuments({
          clientId: new Types.ObjectId(clientId),
          status: 'pending_l2',
        }),
        this.advanceModel.countDocuments({
          clientId: new Types.ObjectId(clientId),
          status: 'approved',
        }),
        this.advanceModel.countDocuments({
          clientId: new Types.ObjectId(clientId),
          status: 'paid',
        }),
        this.advanceModel.countDocuments({
          clientId: new Types.ObjectId(clientId),
          status: 'settled',
        }),
      ]
    )

    const totalAmountResult = await this.advanceModel.aggregate([
      {
        $match: {
          clientId: new Types.ObjectId(clientId),
          status: { $in: ['approved', 'paid', 'settled'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])

    return {
      pending_l1,
      pending_l2,
      approved,
      paid,
      settled,
      totalApprovedAmount: totalAmountResult[0]?.total || 0,
    }
  }
}
