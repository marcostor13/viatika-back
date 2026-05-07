import {
  Injectable,
  Inject,
  forwardRef,
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
import { ResubmitAdvanceDto } from './dto/resubmit-advance.dto'
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
    @Inject(forwardRef(() => ExpenseReportService))
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

  /** Fecha inicio del viaje es hoy o mañana (zona horaria del servidor). */
  private isViaticoTravelStartUrgent(start?: Date): boolean {
    if (!start) return false
    const s = this.startOfDay(new Date(start))
    const t = this.startOfDay(new Date())
    const tomorrow = new Date(t)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return (
      s.getTime() === t.getTime() || s.getTime() === tomorrow.getTime()
    )
  }

  private isValidPaymentReceipt(
    mimeType?: string,
    fileName?: string,
    sizeBytes?: number
  ): { ok: boolean; reason?: string } {
    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png']
    const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png']
    const normalizedMime = (mimeType ?? '').toLowerCase().trim()
    const normalizedName = (fileName ?? '').toLowerCase().trim()

    const mimeAllowed = normalizedMime
      ? allowedMimes.includes(normalizedMime)
      : false
    const extAllowed = allowedExtensions.some(ext => normalizedName.endsWith(ext))
    if (!mimeAllowed && !extAllowed) {
      return {
        ok: false,
        reason: 'Formato inválido. Solo se permite PDF, JPG o PNG.',
      }
    }
    if (typeof sizeBytes === 'number' && sizeBytes > 10 * 1024 * 1024) {
      return {
        ok: false,
        reason: 'El comprobante excede 10MB.',
      }
    }
    return { ok: true }
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

  /** Validación compartida: nueva solicitud y reenvío tras rechazo (Fase 3). */
  private async validateViaticoBusinessRulesAndLines(
    dto: {
      place: string
      startDate: string
      endDate: string
      projectId: string
      lines: CreateAdvanceLineDto[]
      observations?: string
      amount: number
    },
    clientId: string
  ): Promise<{
    lineDocs: {
      categoryId: Types.ObjectId
      importe: number
      peopleCount: number
      glpPerDay: number
      days: number
      lineTotal: number
    }[]
    roundedSum: number
    description: string
    requiredLevels: number
  }> {
    const start = this.startOfDay(new Date(dto.startDate))
    const end = this.startOfDay(new Date(dto.endDate))
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

    await this.projectService.findOne(dto.projectId, clientId)

    const lineDocs: {
      categoryId: Types.ObjectId
      importe: number
      peopleCount: number
      glpPerDay: number
      days: number
      lineTotal: number
    }[] = []

    let sum = 0
    for (const line of dto.lines) {
      const cat = await this.categoryService.findOne(line.categoryId, clientId)
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

    const metaDesc = `Viático: ${dto.place.trim()} (${dto.startDate.slice(0, 10)} → ${dto.endDate.slice(0, 10)})`
    const description = dto.observations?.trim()
      ? `${metaDesc} | ${dto.observations.trim()}`
      : metaDesc

    const requiredLevels =
      roundedSum > ADVANCE_THRESHOLDS.L1_MAX ? 2 : 1

    return { lineDocs, roundedSum, description, requiredLevels }
  }

  private async createViaticoSolicitud(dto: CreateAdvanceDto): Promise<Advance> {
    const profile = await this.userService.findTransactionalProfile(dto.userId!)
    if (!profile?.signature?.trim()) {
      throw new ForbiddenException(
        'Debe registrar su firma digital en el perfil antes de solicitar viáticos.'
      )
    }

    const { lineDocs, roundedSum, description, requiredLevels } =
      await this.validateViaticoBusinessRulesAndLines(
        {
          place: dto.place!,
          startDate: dto.startDate!,
          endDate: dto.endDate!,
          projectId: dto.projectId!,
          lines: dto.lines!,
          observations: dto.observations,
          amount: dto.amount,
        },
        dto.clientId!
      )

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
      solicitudVersion: 1,
      budgetCommitmentRecorded: false,
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
      `Colaborador: ${collaborator?.name ?? ''}`,
      `Lugar: ${advance.place}`,
      `Fechas: ${startStr} al ${endStr}`,
      `Centro de costo: ${projectLabel}${clientLabel ? ` (${clientLabel})` : ''}`,
      `Monto total: S/ ${totalFormatted}`,
    ].join('\n')

    const platformUrl =
      process.env.HOST ||
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      'http://localhost:4200'
    const manualResendUrl = `/advance/${advanceId}/resend-coordinator-email`

    const setNotif = async (payload: {
      recipientUserId?: Types.ObjectId
      status: 'sent' | 'failed' | 'skipped'
      errorMessage?: string
      manualResendUrl?: string
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
              manualResendUrl: payload.manualResendUrl,
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
        manualResendUrl,
      })
    }
  }

  async resendCoordinatorNotification(
    advanceId: string,
    clientId: string
  ): Promise<Advance> {
    const advance = await this.findOne(advanceId)
    if (!advance.clientId || advance.clientId.toString() !== clientId) {
      throw new ForbiddenException(
        'No tiene permisos para reenviar esta notificación.'
      )
    }

    await this.notifyCoordinatorViatico(
      advance as AdvanceDocument,
      advance.userId.toString(),
      clientId
    )
    return this.findOne(advanceId)
  }

  private async notifyCollaboratorViaticoRejected(
    advance: AdvanceDocument,
    rejectionReason: string
  ): Promise<void> {
    const uid = advance.userId.toString()
    const collab = await this.userService.findEmailNameClient(uid)
    if (!collab?.email) return
    const profile =
      await this.userService.findCollaboratorViaticoNotifyProfile(uid)
    let projectLabel = 'Centro de costo'
    if (advance.projectId) {
      try {
        const p = await this.projectService.findOne(
          advance.projectId.toString(),
          advance.clientId.toString()
        )
        projectLabel = `[${p.code} - ${p.name}]`
      } catch {
        /* ignore */
      }
    }
    const platformUrl =
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      'https://app.viatica.tecdidata.com'
    await this.emailService.sendViaticoRechazoColaborador(collab.email, {
      collaboratorName: profile?.name ?? collab.name,
      projectLabel,
      rejectionReason,
      platformUrl,
    })
  }

  private buildViaticoAccountingDetailBody(
    advance: AdvanceDocument,
    collaboratorMeta: { name: string; dni?: string; employeeCode?: string },
    approverName: string,
    approvedAt: Date
  ): string {
    const project = advance.projectId as unknown
    let cc = '—'
    if (project && typeof project === 'object' && project !== null) {
      const pr = project as { code?: string; name?: string }
      if (pr.code !== undefined || pr.name !== undefined) {
        cc = `[${pr.code ?? '—'} - ${pr.name ?? '—'}]`
      }
    }
    const start =
      advance.startDate instanceof Date
        ? advance.startDate.toISOString().slice(0, 10)
        : advance.startDate
          ? String(advance.startDate).slice(0, 10)
          : '—'
    const end =
      advance.endDate instanceof Date
        ? advance.endDate.toISOString().slice(0, 10)
        : advance.endDate
          ? String(advance.endDate).slice(0, 10)
          : '—'
    const lines = advance.lines ?? []
    const breakdown: string[] = []
    for (const row of lines) {
      const cat = (row as { categoryId?: unknown }).categoryId
      const catName =
        cat && typeof cat === 'object' && cat !== null && 'name' in cat
          ? String((cat as { name?: string }).name)
          : 'Categoría'
      breakdown.push(`  • ${catName}: S/ ${Number(row.lineTotal).toFixed(2)}`)
    }
    const apprDate = approvedAt.toISOString().slice(0, 16).replace('T', ' ')
    return [
      `SOLICITANTE`,
      `  Nombre: ${collaboratorMeta.name}`,
      `  Documento: ${collaboratorMeta.dni ?? '—'}`,
      `  Área: —`,
      `  Cargo / código: ${collaboratorMeta.employeeCode ?? '—'}`,
      ``,
      `APROBADOR`,
      `  Nombre: ${approverName}`,
      `  Fecha y hora: ${apprDate}`,
      ``,
      `DETALLE`,
      `  Centro de costo: ${cc}`,
      `  Lugar: ${advance.place ?? '—'}`,
      `  Fechas viaje: ${start} al ${end}`,
      `  Monto total aprobado: S/ ${Number(advance.amount).toFixed(2)}`,
      ``,
      `Desglose por categoría:`,
      breakdown.join('\n') || '  (sin líneas)',
      ``,
      `Compromiso presupuestal: S/ ${Number(advance.amount).toFixed(2)} registrados en compromiso del centro de costo (hasta registro de pago en tesorería).`,
    ].join('\n')
  }

  private async notifyAccountingViaticoApproved(
    advance: AdvanceDocument
  ): Promise<void> {
    const recipients =
      await this.userService.findViaticoAccountingNotifyRecipients(
        advance.clientId.toString()
      )
    if (!recipients.length) {
      this.logger.warn(
        `Aprobación viático ${advance._id}: sin destinatarios contabilidad/tesorería`
      )
      return
    }

    const populated = await this.advanceModel
      .findById(advance._id)
      .populate('projectId')
      .populate({ path: 'lines.categoryId', select: 'name key' })
      .exec()
    const doc = (populated ?? advance) as AdvanceDocument

    const collabId = advance.userId.toString()
    const collabProfile =
      await this.userService.findCollaboratorViaticoNotifyProfile(collabId)
    const lastAppr = [...doc.approvalHistory]
      .reverse()
      .find(h => h.action === 'approved')
    let approverName = '—'
    if (lastAppr?.approvedBy) {
      const ap = await this.userService.findEmailNameClient(lastAppr.approvedBy)
      approverName = ap?.name ?? lastAppr.approvedBy
    }

    const urgent = this.isViaticoTravelStartUrgent(doc.startDate)
    const platformUrl =
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      'https://app.viatica.tecdidata.com'

    const detailBody = this.buildViaticoAccountingDetailBody(
      doc,
      {
        name: collabProfile?.name ?? 'Colaborador',
        dni: collabProfile?.dni,
        employeeCode: collabProfile?.employeeCode,
      },
      approverName,
      lastAppr?.date ?? new Date()
    )

    const emailTitle = urgent
      ? 'Solicitud aprobada — inicio de viaje próximo'
      : 'Solicitud de viáticos aprobada'

    for (const r of recipients) {
      try {
        await this.emailService.sendViaticoAprobacionContabilidad(r.email, {
          recipientName: r.name,
          urgent,
          urgentBanner:
            'URGENTE: la fecha de inicio del viaje es hoy o mañana. Priorizar gestión de desembolso.',
          emailTitle,
          detailBody,
          platformUrl,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`Correo contabilidad viático a ${r.email}: ${msg}`)
      }
    }
  }

  /** Fase 3: compromiso en centro de costo + correo a contabilidad/tesorería. */
  private async onViaticoAdvanceFullyApproved(
    saved: AdvanceDocument
  ): Promise<void> {
    if (saved.projectId && !saved.budgetCommitmentRecorded) {
      try {
        await this.projectService.adjustCommittedAdvanceTotal(
          saved.projectId.toString(),
          saved.clientId.toString(),
          saved.amount
        )
        await this.advanceModel.updateOne(
          { _id: saved._id },
          { $set: { budgetCommitmentRecorded: true } }
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`Compromiso presupuestal viático ${saved._id}: ${msg}`)
      }
    }

    try {
      await this.notifyAccountingViaticoApproved(saved)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Notificación contabilidad viático ${saved._id}: ${msg}`)
    }
  }

  private async notifyViaticoPaymentRegistered(
    advance: AdvanceDocument
  ): Promise<void> {
    const collabId = advance.userId.toString()
    const collab = await this.userService.findEmailNameClient(collabId)
    if (!collab?.email) return

    const profile =
      await this.userService.findTransactionalProfile(collabId)
    const coordinatorId = profile?.coordinatorId?.toString?.()
    const coordinator = coordinatorId
      ? await this.userService.findEmailNameClient(coordinatorId)
      : null

    let projectLabel = 'Centro de costo'
    if (advance.projectId) {
      try {
        const p = await this.projectService.findOne(
          advance.projectId.toString(),
          advance.clientId.toString()
        )
        projectLabel = `[${p.code} - ${p.name}]`
      } catch {
        /* ignore label fallback */
      }
    }

    const platformUrl =
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      'https://app.viatica.tecdidata.com'

    const transferDate = advance.paymentInfo?.transferDate
      ? new Date(advance.paymentInfo.transferDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)

    const baseData = {
      collaboratorName: collab.name,
      coordinatorName: coordinator?.name,
      projectLabel,
      amountFormatted: Number(advance.amount).toFixed(2),
      transferDate,
      reference: advance.paymentInfo?.reference || '—',
      paymentMethod: advance.paymentInfo?.method || 'transferencia_bancaria',
      paymentReceiptUrl: advance.paymentInfo?.paymentReceiptUrl || '',
      paymentReceiptFileName:
        advance.paymentInfo?.paymentReceiptFileName || 'comprobante-pago-viaticos.pdf',
      platformUrl,
    }

    await this.emailService.sendViaticoPagoRealizado(collab.email, {
      recipientName: collab.name,
      ...baseData,
    })

    if (coordinator?.email) {
      await this.emailService.sendViaticoPagoRealizado(coordinator.email, {
        recipientName: coordinator.name,
        ...baseData,
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

  /** Comprobantes de pago de viático para «Mis documentos» (Fase 6). */
  async findPaymentReceiptsForCollaborator(userId: string, clientId: string) {
    return this.advanceModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
        status: { $in: ['paid', 'settled', 'returned'] },
        'paymentInfo.paymentReceiptUrl': { $exists: true, $nin: [null, ''] },
      })
      .select('paymentInfo description expenseReportId createdAt')
      .populate('expenseReportId', 'title')
      .sort({ createdAt: -1 })
      .lean()
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

    const saved = await advance.save()
    if (saved.status === 'approved') {
      await this.onViaticoAdvanceFullyApproved(saved as AdvanceDocument)
    }
    return saved
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

    const saved = await advance.save()
    await this.onViaticoAdvanceFullyApproved(saved as AdvanceDocument)
    return saved
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

    const saved = await advance.save()
    this.notifyCollaboratorViaticoRejected(
      saved as AdvanceDocument,
      dto.rejectionReason
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Correo rechazo viático colaborador: ${msg}`)
    })
    return saved
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

    const receiptValidation = this.isValidPaymentReceipt(
      dto.paymentReceiptMimeType,
      dto.paymentReceiptFileName,
      dto.paymentReceiptSizeBytes
    )
    if (!receiptValidation.ok) {
      throw new BadRequestException(receiptValidation.reason)
    }

    if (advance.budgetCommitmentRecorded && advance.projectId) {
      try {
        await this.projectService.adjustCommittedAdvanceTotal(
          advance.projectId.toString(),
          advance.clientId.toString(),
          -advance.amount
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`Libera compromiso viático ${advance._id}: ${msg}`)
      }
      advance.budgetCommitmentRecorded = false
    }

    advance.paymentInfo = {
      method: dto.method,
      bankName: dto.bankName,
      accountNumber: dto.accountNumber,
      cci: dto.cci,
      transferDate: new Date(dto.transferDate),
      reference: dto.reference,
      paymentReceiptUrl: dto.paymentReceiptUrl,
      paymentReceiptFileName: dto.paymentReceiptFileName,
      paymentReceiptMimeType: dto.paymentReceiptMimeType,
      paymentReceiptSizeBytes: dto.paymentReceiptSizeBytes,
    }
    advance.status = 'paid'
    const saved = await advance.save()
    this.notifyViaticoPaymentRegistered(saved as AdvanceDocument).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`Correo pago viático ${saved._id}: ${msg}`)
      }
    )
    return saved
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

  /**
   * Fase 6 — Al aprobar la rendición: liquida en bloque los anticipos pagados vinculados,
   * guarda el settlement en la rendición y avisa a contabilidad si corresponde reembolso al colaborador.
   */
  async liquidateExpenseReport(reportId: string): Promise<void> {
    const report = await this.expenseReportService.findOneWithAdvances(reportId)
    if (!report || report.status !== 'approved') {
      return
    }

    const oid = new Types.ObjectId(reportId)
    const rawAdvanceIds = Array.isArray(report.advanceIds)
      ? report.advanceIds
      : []
    const idList = rawAdvanceIds.map((x: unknown) => new Types.ObjectId(String(x)))

    const linkedAdvances = await this.advanceModel
      .find({
        clientId: report.clientId,
        $or: [{ _id: { $in: idList } }, { expenseReportId: oid }],
      })
      .exec()

    const byId = new Map<string, AdvanceDocument>()
    for (const a of linkedAdvances) {
      byId.set(String(a._id), a as AdvanceDocument)
    }
    const advances = [...byId.values()]

    const expenses = (report.expenseIds as any[]) || []
    const expenseTotal = expenses.reduce((sum, e) => {
      if (String(e?.status || '').toLowerCase() !== 'approved') return sum
      return sum + (Number(e.total) || 0)
    }, 0)

    const paidAdvances = advances.filter(a => a.status === 'paid')
    const settledAdvances = advances.filter(a => a.status === 'settled')

    if (paidAdvances.length === 0 && settledAdvances.length === 0) {
      return
    }

    let advanceTotal = 0
    if (paidAdvances.length > 0) {
      advanceTotal = paidAdvances.reduce(
        (s, a) => s + (Number(a.amount) || 0),
        0
      )
    } else {
      advanceTotal = settledAdvances.reduce(
        (s, a) => s + (Number(a.amount) || 0),
        0
      )
    }

    const difference = advanceTotal - expenseTotal
    let type: 'reembolso' | 'devolucion' | 'equilibrado'
    if (Math.abs(difference) < 0.01) {
      type = 'equilibrado'
    } else if (difference > 0) {
      type = 'devolucion'
    } else {
      type = 'reembolso'
    }

    const settledAt = new Date()
    const settlementPayload = {
      expenseTotal,
      advanceAmount: advanceTotal,
      difference,
      type,
      settledAt,
    }

    const reportSettlement = {
      advanceTotal,
      expenseTotal,
      difference,
      type,
      settledAt,
    }

    if (paidAdvances.length > 0) {
      for (const adv of paidAdvances) {
        adv.status = 'settled'
        adv.settlement = settlementPayload
        await adv.save()
      }
    }

    await this.expenseReportService.updateSettlement(reportId, reportSettlement)

    const doc = report as any
    const alreadyNotified = !!doc.reimbursementAccountingNotifiedAt
    const alreadyPaidReimbursement = !!doc.reimbursementPaymentInfo

    if (
      type === 'reembolso' &&
      Math.abs(difference) >= 0.01 &&
      !alreadyNotified &&
      !alreadyPaidReimbursement
    ) {
      try {
        await this.notifyAccountingReembolsoPending(
          reportId,
          report,
          Math.abs(difference)
        )
        await this.expenseReportService.markReimbursementAccountingNotified(
          reportId
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`Notificación reembolso contabilidad ${reportId}: ${msg}`)
      }
    }
  }

  private async notifyAccountingReembolsoPending(
    reportId: string,
    report: any,
    amountReimburse: number
  ): Promise<void> {
    const clientId = String(report.clientId)
    const recipients =
      await this.userService.findViaticoAccountingNotifyRecipients(clientId)

    const owner = report.userId as { name?: string; email?: string }
    const collaboratorName = owner?.name || 'Colaborador'

    const platformUrl =
      process.env.APP_PUBLIC_URL ||
      process.env.FRONTEND_URL ||
      'https://app.viatica.tecdidata.com'

    const detailUrl = `${platformUrl.replace(/\/$/, '')}/mis-rendiciones/${reportId}/detalle`

    const amountFormatted = amountReimburse.toFixed(2)
    const reportTitle = report.title || 'Rendición'
    const reportLabel = `${reportTitle} · ${reportId}`

    for (const r of recipients) {
      if (!r.email?.trim()) continue
      await this.emailService.sendRendicionReembolsoContabilidad(r.email, {
        recipientName: r.name || 'Estimado/a',
        reportLabel,
        reportTitle,
        collaboratorName,
        amountFormatted,
        detailUrl,
      })
    }
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

  // ─── FASE 7 — Sub-flujo de devolución de saldo ────────────────────────────

  /** Inicia el registro de devolución luego de settle() cuando type='devolucion'. */
  async initiateReturnTracking(id: string): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)
    if (advance.status !== 'settled') {
      throw new BadRequestException('Solo se puede iniciar devolución desde estado liquidado')
    }
    if (!advance.settlement || advance.settlement.type !== 'devolucion') {
      throw new BadRequestException('Este anticipo no tiene saldo a devolver')
    }
    const dueDate = this.addBusinessDays(new Date(), 10)
    const returnRecord = {
      status: 'pending' as const,
      amountDue: advance.settlement.difference,
      dueDate,
      isOverdue: false,
      remindersSent: 0,
    }
    await this.advanceModel.findByIdAndUpdate(id, { $set: { returnRecord } })
    const collaborator = await this.userService.findEmailNameClient(advance.userId.toString())
    if (collaborator?.email) {
      this.emailService.sendDevolucionPendiente(collaborator.email, {
        recipientName: collaborator.name,
        amountDue: advance.settlement.difference.toFixed(2),
        dueDate: dueDate.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        advanceId: id,
      }).catch(err => this.logger.error(`Email devolución pendiente: ${err?.message}`))
    }
    return (await this.advanceModel.findById(id))!
  }

  /** Colaborador carga el comprobante de depósito (Fase 7.3). */
  async uploadReturnProof(
    id: string,
    proof: {
      depositDate: Date
      amountReturned: number
      bankOrigin: string
      operationNumber: string
      fileUrl: string
      fileKey?: string
      note?: string
    }
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)
    const rr = (advance as any).returnRecord
    if (!rr || rr.status !== 'pending') {
      throw new BadRequestException('El anticipo no tiene una devolución pendiente de comprobante')
    }
    if (proof.amountReturned < rr.amountDue) {
      throw new BadRequestException(
        `El monto devuelto (${proof.amountReturned}) es menor al monto adeudado (${rr.amountDue})`
      )
    }
    const updatedRr = {
      ...rr,
      status: 'proof_uploaded' as const,
      proof: { ...proof, uploadedAt: new Date() },
    }
    await this.advanceModel.findByIdAndUpdate(id, { $set: { returnRecord: updatedRr } })
    return (await this.advanceModel.findById(id))!
  }

  /** Contabilidad valida o rechaza el comprobante (Fase 7.4). */
  async validateReturn(
    id: string,
    approved: boolean,
    validatedBy: string,
    rejectionReason?: string
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)
    const rr = (advance as any).returnRecord
    if (!rr || rr.status !== 'proof_uploaded') {
      throw new BadRequestException('No hay comprobante pendiente de validación')
    }
    if (!approved && (!rejectionReason || rejectionReason.trim().length < 50)) {
      throw new BadRequestException('El motivo de rechazo debe tener al menos 50 caracteres')
    }
    const validation = { validatedBy, validatedAt: new Date(), approved, rejectionReason }
    const newStatus = approved ? 'validated' : 'rejected'
    const updatedRr = { ...rr, status: newStatus, validation }
    const updates: any = { returnRecord: updatedRr }
    if (approved) {
      updates.status = 'returned'
      updates.returnedAmount = rr.proof?.amountReturned ?? rr.amountDue
    }
    await this.advanceModel.findByIdAndUpdate(id, { $set: updates })
    const collaborator = await this.userService.findEmailNameClient(advance.userId.toString())
    if (collaborator?.email) {
      const sendFn = approved
        ? this.emailService.sendDevolucionValidada.bind(this.emailService)
        : this.emailService.sendDevolucionRechazada.bind(this.emailService)
      sendFn(collaborator.email, {
        recipientName: collaborator.name,
        amountDue: rr.amountDue.toFixed(2),
        rejectionReason,
        advanceId: id,
      }).catch((err: any) => this.logger.error(`Email validación devolución: ${err?.message}`))
    }
    return (await this.advanceModel.findById(id))!
  }

  /** Devuelve anticipos con devoluciones pendientes del cliente (para vista de contabilidad). */
  async findPendingReturns(clientId: string): Promise<Advance[]> {
    return this.advanceModel
      .find({
        clientId: new Types.ObjectId(clientId),
        'returnRecord.status': { $in: ['pending', 'proof_uploaded', 'rejected'] },
      })
      .populate('userId', 'name email')
      .exec() as Promise<Advance[]>
  }

  /** Marca devoluciones vencidas (llamado desde cron o manualmente). */
  async markOverdueReturns(): Promise<number> {
    const now = new Date()
    const result = await this.advanceModel.updateMany(
      {
        'returnRecord.status': 'pending',
        'returnRecord.dueDate': { $lt: now },
        'returnRecord.isOverdue': false,
      },
      { $set: { 'returnRecord.isOverdue': true } }
    )
    return (result as any).modifiedCount ?? 0
  }

  private addBusinessDays(date: Date, days: number): Date {
    const result = new Date(date)
    let added = 0
    while (added < days) {
      result.setDate(result.getDate() + 1)
      const dow = result.getDay()
      if (dow !== 0 && dow !== 6) added++
    }
    return result
  }

  /**
   * Fase 3 — colaborador corrige y reenvía; conserva historial y aumenta versión.
   */
  async resubmitRejected(
    id: string,
    dto: ResubmitAdvanceDto,
    actingUserId: string,
    clientId: string
  ): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'rejected') {
      throw new BadRequestException(
        'Solo pueden reenviarse solicitudes en estado rechazado.'
      )
    }

    if (advance.userId.toString() !== actingUserId) {
      throw new ForbiddenException(
        'Solo el colaborador solicitante puede corregir y reenviar esta solicitud.'
      )
    }

    if (advance.clientId.toString() !== clientId) {
      throw new ForbiddenException(
        'La solicitud no pertenece a su organización.'
      )
    }

    const profile =
      await this.userService.findTransactionalProfile(actingUserId)
    if (!profile?.signature?.trim()) {
      throw new ForbiddenException(
        'Debe registrar su firma digital en el perfil antes de reenviar viáticos.'
      )
    }

    const { lineDocs, roundedSum, description, requiredLevels } =
      await this.validateViaticoBusinessRulesAndLines(
        {
          place: dto.place,
          startDate: dto.startDate,
          endDate: dto.endDate,
          projectId: dto.projectId,
          lines: dto.lines,
          observations: dto.observations,
          amount: dto.amount,
        },
        clientId
      )

    advance.place = dto.place.trim()
    advance.startDate = new Date(dto.startDate)
    advance.endDate = new Date(dto.endDate)
    advance.projectId = new Types.ObjectId(dto.projectId)
    advance.lines = lineDocs
    advance.observations = dto.observations?.trim()
    advance.amount = roundedSum
    advance.description = description
    advance.status = 'pending_l1'
    advance.approvalLevel = 0
    advance.requiredLevels = requiredLevels
    advance.rejectedBy = undefined
    advance.rejectionReason = undefined
    advance.budgetCommitmentRecorded = false
    advance.solicitudVersion = (advance.solicitudVersion || 1) + 1

    advance.approvalHistory.push({
      level: 0,
      approvedBy: actingUserId,
      action: 'resubmitted',
      notes: 'Solicitud corregida y reenviada tras rechazo',
      date: new Date(),
    })

    await advance.save()

    await this.notifyCoordinatorViatico(
      advance as AdvanceDocument,
      actingUserId,
      clientId
    )

    const refreshed = await this.advanceModel
      .findById(advance._id)
      .populate('projectId')
      .populate({
        path: 'lines.categoryId',
        select: 'name key limit isActive',
      })
      .exec()

    return refreshed as Advance
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
