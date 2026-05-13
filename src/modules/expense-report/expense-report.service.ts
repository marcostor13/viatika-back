import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { CreateExpenseReportDto } from './dto/create-expense-report.dto'
import { UpdateExpenseReportDto } from './dto/update-expense-report.dto'
import {
  ExpenseReport,
  ExpenseReportDocument,
} from './entities/expense-report.entity'
import { EmailService } from '../email/email.service'
import { NotificationsService } from '../notifications/notifications.service'
import { UserService } from '../user/user.service'
import { CreateAffidavitDto } from './dto/create-affidavit.dto'
import { RegisterReimbursementPaymentDto } from './dto/register-reimbursement-payment.dto'
import { AdvanceService } from '../advance/advance.service'
import { ROLES } from '../auth/enums/roles.enum'

@Injectable()
export class ExpenseReportService {
  constructor(
    @InjectModel(ExpenseReport.name)
    private readonly expenseReportModel: Model<ExpenseReportDocument>,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
    private readonly userService: UserService,
    @Inject(forwardRef(() => AdvanceService))
    private readonly advanceService: AdvanceService
  ) {}

  private validatePaymentReceipt(
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
    const extAllowed = allowedExtensions.some(ext =>
      normalizedName.endsWith(ext)
    )
    if (!mimeAllowed && !extAllowed) {
      return {
        ok: false,
        reason: 'Formato inválido. Solo se permite PDF, JPG o PNG.',
      }
    }
    if (typeof sizeBytes === 'number' && sizeBytes > 10 * 1024 * 1024) {
      return { ok: false, reason: 'El comprobante excede 10MB.' }
    }
    return { ok: true }
  }

  private normalizeExpenseReportClientId(clientId: unknown): string {
    if (!clientId) return ''
    if (clientId instanceof Types.ObjectId) return clientId.toHexString()
    if (typeof clientId === 'object' && clientId !== null && '_id' in clientId) {
      return String((clientId as { _id: unknown })._id)
    }
    return String(clientId)
  }

  private async validateBeforeSubmit(reportId: string): Promise<void> {
    const report = await this.expenseReportModel
      .findById(reportId)
      .populate('expenseIds')
      .select('expenseIds')
      .lean()
      .exec()

    if (!report) {
      throw new NotFoundException(`Expense report with ID ${reportId} not found`)
    }

    const expenses = Array.isArray(report.expenseIds) ? report.expenseIds : []
    if (expenses.length === 0) {
      throw new BadRequestException(
        'Debe registrar al menos un gasto antes de enviar la rendición.'
      )
    }

    const hasRejected = expenses.some(
      (e: any) => String(e?.status || '').toLowerCase() === 'rejected'
    )
    if (hasRejected) {
      throw new BadRequestException(
        'No puede enviar la rendición mientras existan comprobantes rechazados sin corregir.'
      )
    }

  }

  private async validateBeforeFinalApproval(reportId: string): Promise<void> {
    const report = await this.expenseReportModel
      .findById(reportId)
      .populate('expenseIds')
      .select('expenseIds')
      .lean()
      .exec()

    if (!report) {
      throw new NotFoundException(`Expense report with ID ${reportId} not found`)
    }

    const expenses = Array.isArray(report.expenseIds) ? report.expenseIds : []
    if (expenses.length === 0) {
      throw new BadRequestException(
        'No se puede aprobar una rendición sin comprobantes registrados.'
      )
    }

    const hasNonApproved = expenses.some(
      (e: any) => String(e?.status || '').toLowerCase() !== 'approved'
    )
    if (hasNonApproved) {
      throw new BadRequestException(
        'Apruebe todos los gastos individuales para habilitar la aprobación final.'
      )
    }
  }

  async create(
    createExpenseReportDto: CreateExpenseReportDto,
    createdBy: string,
    isCollaborator = false
  ) {
    const report = new this.expenseReportModel({
      ...createExpenseReportDto,
      userId: new Types.ObjectId(createExpenseReportDto.userId),
      clientId: new Types.ObjectId(createExpenseReportDto.clientId),
      createdBy: new Types.ObjectId(createdBy),
      projectId: createExpenseReportDto.projectId
        ? new Types.ObjectId(createExpenseReportDto.projectId)
        : undefined,
      status: isCollaborator ? 'solicited' : 'open',
      expenseIds: [],
    })
    const savedReport = await report.save()

    console.log(
      `[ExpenseReportService] Created report: ${savedReport._id}. isCollaborator: ${isCollaborator}`
    )

    // Notificar a administradores si un colaborador crea una rendición
    if (isCollaborator) {
      try {
        const admins = await this.userService.findAdminsByClient(
          String(savedReport.clientId)
        )
        console.log(
          `[ExpenseReportService] Admins found: ${admins.length} for client ${savedReport.clientId}`
        )

        const user = await this.userService.findOne(createdBy)
        const creatorName = user.name || 'Un colaborador'

        for (const admin of admins) {
          console.log(`[ExpenseReportService] Notifying admin: ${admin.email}`)
          await this.notificationsService.create({
            userId: String(admin._id),
            title: 'Nueva Rendición Solicitada',
            message: `${creatorName} ha creado una nueva solicitud de rendición: "${savedReport.title}"`,
            type: 'info',
            actionUrl: `/mis-rendiciones/${savedReport._id}/detalle`,
          })
        }
      } catch (error) {
        console.error(
          'Error enviando notificaciones a administradores (create)',
          error
        )
      }
    }

    return savedReport
  }

  async createAutoFromViatico(advance: {
    _id: unknown
    userId: Types.ObjectId
    clientId: Types.ObjectId
    projectId?: Types.ObjectId
    description?: string
    place?: string
    amount: number
    startDate?: Date
    endDate?: Date
  }): Promise<ExpenseReportDocument> {
    const title = advance.description?.trim() || advance.place?.trim() || 'Viático'
    const report = new this.expenseReportModel({
      title,
      userId: advance.userId,
      clientId: advance.clientId,
      createdBy: advance.userId,
      projectId: advance.projectId ?? undefined,
      location: advance.place ?? undefined,
      budget: advance.amount,
      startDate: advance.startDate ?? undefined,
      endDate: advance.endDate ?? undefined,
      status: 'open',
      expenseIds: [],
      advanceIds: [advance._id],
    })
    return report.save()
  }

  async findAllByClient(clientId: string) {
    return await this.expenseReportModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('userId', 'name email signature')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findAllByUser(userId: string, clientId: string) {
    return await this.expenseReportModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
      })
      .populate('expenseIds', 'total')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findOne(id: string) {
    const report = await this.expenseReportModel
      .findById(id)
      .populate('userId', 'name email signature')
      .populate({ path: 'expenseIds', populate: [{ path: 'categoryId', select: 'name' }, { path: 'proyectId', select: 'name' }] })
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('projectId', 'name')
      .exec()

    if (!report) {
      throw new NotFoundException(`Expense report with ID ${id} not found`)
    }
    return report
  }

  async update(id: string, updateExpenseReportDto: UpdateExpenseReportDto) {
    const dto = updateExpenseReportDto
    const existing = await this.expenseReportModel
      .findById(id)
      .select('status')
      .lean()
      .exec()
    if (!existing) {
      throw new NotFoundException(`Expense report with ID ${id} not found`)
    }

    if (dto.status === 'reimbursed') {
      throw new BadRequestException(
        'El estado reembolsado se registra únicamente al cargar el comprobante de pago en tesorería.'
      )
    }

    if (
      dto.status === 'submitted' &&
      existing.status !== 'open' &&
      existing.status !== 'rejected'
    ) {
      throw new BadRequestException(
        'Solo se puede enviar una rendición en estado abierta o rechazada.'
      )
    }
    if (dto.status === 'submitted') {
      await this.validateBeforeSubmit(id)
    }
    if (dto.status === 'solicited' && existing.status !== 'rejected') {
      throw new BadRequestException(
        'Solo se puede re-enviar una solicitud en estado rechazada.'
      )
    }
    if (dto.status === 'open' && existing.status !== 'solicited') {
      throw new BadRequestException(
        'Solo se puede aprobar una solicitud en estado solicitada.'
      )
    }
    if (
      dto.status === 'rejected' &&
      existing.status !== 'submitted' &&
      existing.status !== 'solicited'
    ) {
      throw new BadRequestException(
        'Solo se pueden rechazar rendiciones enviadas o solicitadas.'
      )
    }
    if (dto.status === 'approved' && existing.status !== 'submitted') {
      throw new BadRequestException(
        'Solo se pueden aprobar rendiciones enviadas.'
      )
    }
    if (dto.status === 'approved') {
      await this.validateBeforeFinalApproval(id)
    }

    const $set: Record<string, unknown> = {}
    const $unset: Record<string, ''> = {}

    // Solo campos definidos: evita $set con undefined y no pisa expenseIds por error
    if (dto.title !== undefined) $set.title = dto.title
    if (dto.description !== undefined) $set.description = dto.description
    if (dto.budget !== undefined) $set.budget = dto.budget
    if (dto.status !== undefined) $set.status = dto.status
    if (dto.userId !== undefined) $set.userId = new Types.ObjectId(dto.userId)
    if (dto.clientId !== undefined)
      $set.clientId = new Types.ObjectId(dto.clientId)
    if (dto.projectId !== undefined) {
      $set.projectId = dto.projectId ? new Types.ObjectId(dto.projectId) : null
    }
    if (dto.expenseIds !== undefined && Array.isArray(dto.expenseIds)) {
      $set.expenseIds = dto.expenseIds.map(eId => new Types.ObjectId(eId))
    }

    if (dto.status === 'rejected') {
      const reason =
        typeof dto.rejectionReason === 'string'
          ? dto.rejectionReason.trim()
          : ''
      if (!reason) {
        throw new BadRequestException(
          'El motivo de rechazo es obligatorio para rechazar una rendición.'
        )
      }
      $set.rejectionReason = reason
    } else if (
      dto.rejectionReason !== undefined &&
      dto.status !== 'submitted'
    ) {
      $set.rejectionReason = dto.rejectionReason?.trim() || ''
    }

    if (dto.status === 'submitted' || dto.status === 'solicited') {
      $unset.rejectionReason = ''
    }

    const updatePayload: Record<string, unknown> = {}
    if (Object.keys($set).length > 0) updatePayload.$set = $set
    if (Object.keys($unset).length > 0) updatePayload.$unset = $unset

    if (Object.keys(updatePayload).length > 0) {
      const updated = await this.expenseReportModel
        .findByIdAndUpdate(id, updatePayload, { new: true })
        .exec()
      if (!updated) {
        throw new NotFoundException(`Expense report with ID ${id} not found`)
      }
    }

    // findByIdAndUpdate no hace populate: la UI necesita expenseIds como documentos
    const fullyUpdatedReport = await this.findOne(id)

    // Si la rendición solicitada fue editada sin cambio de estado, re-notificar admins
    if (existing.status === 'solicited' && dto.status === undefined) {
      try {
        const admins = await this.userService.findAdminsByClient(
          String(fullyUpdatedReport.clientId)
        )
        const user = await this.userService.findOne(
          String(fullyUpdatedReport.userId)
        )
        const creatorName = user.name || 'Un colaborador'
        for (const admin of admins) {
          await this.notificationsService.create({
            userId: String(admin._id),
            title: 'Solicitud de rendición actualizada',
            message: `${creatorName} ha actualizado su solicitud de rendición: "${fullyUpdatedReport.title}"`,
            type: 'info',
            actionUrl: `/mis-rendiciones/${id}/detalle`,
          })
        }
      } catch (error) {
        console.error('Error enviando notificaciones de rendición actualizada', error)
      }
    }

    // Si la rendición fue aprobada, enviar email y notificación
    if (dto.status === 'approved') {
      const owner = fullyUpdatedReport.userId as any
      if (owner && owner.email) {
        try {
          await this.emailService.sendRendicionFullyApprovedEmail(owner.email, {
            userName: owner.name || 'Colaborador',
            title: fullyUpdatedReport.title,
            budget: fullyUpdatedReport.budget,
            platformUrl: this.emailService.buildAppUrl(
              `/mis-rendiciones/${id}/detalle`
            ),
          })

          await this.notificationsService.create({
            userId: String(owner._id),
            title: 'Rendición Aprobada',
            message: `Tu rendición "${fullyUpdatedReport.title}" ha sido aprobada exitosamente y pasará a contabilidad.`,
            type: 'success',
            actionUrl: `/mis-rendiciones/${id}/detalle`,
          })
        } catch (error) {
          // Log pero no fallar el request de actualización
          console.error(
            'Error enviando notificaciones de rendición aprobada',
            error
          )
        }
      }

      try {
        await this.advanceService.liquidateExpenseReport(id)
      } catch (err) {
        console.error(
          `[ExpenseReportService] Liquidación post-aprobación ${id}:`,
          err
        )
      }
    }

    // Si la rendición fue enviada a aprobación (submitted), notificar a los administradores
    if (dto.status === 'submitted') {
      try {
        const admins = await this.userService.findAdminsByClient(
          String(fullyUpdatedReport.clientId)
        )
        const user = await this.userService.findOne(
          String(fullyUpdatedReport.userId)
        )
        const creatorName = user.name || 'Un colaborador'

        console.log(
          `[ExpenseReportService] Status changed to submitted. Notifying ${admins.length} admins.`
        )

        for (const admin of admins) {
          await this.notificationsService.create({
            userId: String(admin._id),
            title: 'Rendición Enviada',
            message: `${creatorName} ha enviado la rendición "${fullyUpdatedReport.title}" para tu revisión.`,
            type: 'warning',
            actionUrl: `/mis-rendiciones/${id}/detalle`,
          })
        }
      } catch (error) {
        console.error(
          'Error enviando notificaciones a administradores (update/submitted)',
          error
        )
      }
    }

    return fullyUpdatedReport
  }

  async remove(id: string) {
    const deleted = await this.expenseReportModel.findByIdAndDelete(id).exec()
    if (!deleted) {
      throw new NotFoundException(`Expense report with ID ${id} not found`)
    }
    return deleted
  }

  async addExpenseToReport(reportId: string, expenseId: string) {
    return await this.expenseReportModel
      .findByIdAndUpdate(
        reportId,
        { $push: { expenseIds: new Types.ObjectId(expenseId) } },
        { new: true }
      )
      .exec()
  }

  async removeExpenseFromReport(
    reportId: string,
    expenseId: string
  ): Promise<void> {
    await this.expenseReportModel
      .findByIdAndUpdate(reportId, {
        $pull: { expenseIds: new Types.ObjectId(expenseId) },
      })
      .exec()
  }

  async addAdvanceToReport(reportId: string, advanceId: string) {
    return await this.expenseReportModel
      .findByIdAndUpdate(
        reportId,
        { $addToSet: { advanceIds: new Types.ObjectId(advanceId) } },
        { new: true }
      )
      .exec()
  }

  async updateSettlement(reportId: string, settlement: any) {
    return await this.expenseReportModel
      .findByIdAndUpdate(reportId, { $set: { settlement } }, { new: true })
      .exec()
  }

  async setApprovedBy(reportId: string, userId: string) {
    await this.expenseReportModel
      .findByIdAndUpdate(reportId, {
        $set: { approvedBy: new Types.ObjectId(userId) },
      })
      .exec()
  }

  async registerAffidavit(
    reportId: string,
    dto: CreateAffidavitDto,
    generatedBy: string
  ) {
    const report = await this.findOne(reportId)
    if (!report) {
      throw new NotFoundException(`Expense report with ID ${reportId} not found`)
    }
    if (report.status !== 'closed') {
      throw new BadRequestException(
        'La declaración jurada solo puede generarse cuando la rendición está cerrada.'
      )
    }

    const reportExpenses = (report.expenseIds || []).map((e: any) => String(e._id))
    const missing = dto.expenseIds.filter(id => !reportExpenses.includes(String(id)))
    if (missing.length > 0) {
      throw new BadRequestException(
        'Los comprobantes seleccionados no pertenecen a esta rendición.'
      )
    }

    await this.expenseReportModel.findByIdAndUpdate(reportId, {
      $push: {
        affidavits: {
          type: dto.type,
          expenseIds: dto.expenseIds.map(id => new Types.ObjectId(id)),
          generatedBy: new Types.ObjectId(generatedBy),
          generatedAt: new Date(),
        },
      },
    })

    return {
      reportId,
      type: dto.type,
      expenseIds: dto.expenseIds,
      generatedBy,
      generatedAt: new Date().toISOString(),
    }
  }

  async markReimbursementAccountingNotified(reportId: string): Promise<void> {
    await this.expenseReportModel.findByIdAndUpdate(reportId, {
      $set: { reimbursementAccountingNotifiedAt: new Date() },
    })
  }

  async findPendingReimbursementsByClient(clientId: string) {
    return this.expenseReportModel
      .find({
        clientId: new Types.ObjectId(clientId),
        status: 'approved',
        'settlement.type': 'reembolso',
        $or: [
          { reimbursementPaymentInfo: { $exists: false } },
          { reimbursementPaymentInfo: null },
        ],
      })
      .populate('userId', 'name email')
      .sort({ updatedAt: -1 })
      .lean()
      .exec()
  }

  async findMyDocuments(userId: string, clientId: string) {
    const reimbursementRows = await this.expenseReportModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
        reimbursementPaymentInfo: { $exists: true, $ne: null },
      })
      .select(
        'title reimbursementPaymentInfo reimbursedAt settlement.difference'
      )
      .sort({ reimbursedAt: -1 })
      .lean()
      .exec()

    const viaticoRows =
      await this.advanceService.findPaymentReceiptsForCollaborator(
        userId,
        clientId
      )

    const reimbursementDocs = reimbursementRows.map(r => ({
      kind: 'reembolso_rendicion' as const,
      expenseReportId: String(r._id),
      title: r.title || 'Rendición',
      receiptUrl: r.reimbursementPaymentInfo?.paymentReceiptUrl || '',
      receiptFileName:
        r.reimbursementPaymentInfo?.paymentReceiptFileName ||
        'comprobante-reembolso.pdf',
      date:
        r.reimbursedAt?.toISOString?.() ||
        r.reimbursementPaymentInfo?.transferDate ||
        '',
      amountFormatted:
        r.settlement?.difference != null
          ? Math.abs(Number(r.settlement.difference)).toFixed(2)
          : undefined,
      detailUrl: `${this.emailService.buildAppUrl(`/mis-rendiciones/${String(r._id)}/detalle`)}`,
    }))

    const viaticoDocs = (viaticoRows as any[]).map(row => {
      const rep = row.expenseReportId
      const reportTitle =
        typeof rep === 'object' && rep?.title ? rep.title : 'Viáticos'
      return {
        kind: 'viatico_pago' as const,
        advanceId: String(row._id),
        title: row.description || reportTitle,
        receiptUrl: row.paymentInfo?.paymentReceiptUrl || '',
        receiptFileName:
          row.paymentInfo?.paymentReceiptFileName ||
          'comprobante-pago-viaticos.pdf',
        date:
          row.paymentInfo?.transferDate?.toISOString?.() ||
          row.createdAt?.toString?.() ||
          '',
        expenseReportId:
          typeof rep === 'object' && rep?._id
            ? String(rep._id)
            : rep
              ? String(rep)
              : undefined,
      }
    })

    return {
      items: [...reimbursementDocs, ...viaticoDocs].sort((a, b) =>
        String(b.date).localeCompare(String(a.date))
      ),
    }
  }

  async registerReimbursementPayment(
    reportId: string,
    dto: RegisterReimbursementPaymentDto,
    userRole: string,
    userPermissions?: { canApproveL2?: boolean },
    tenantCtx?: { requestClientId: string; isSuperAdmin: boolean }
  ) {
    const canPay =
      userRole === ROLES.SUPER_ADMIN || userPermissions?.canApproveL2 === true
    if (!canPay) {
      throw new ForbiddenException(
        'No tienes permiso para registrar pagos de reembolso.'
      )
    }

    const receiptValidation = this.validatePaymentReceipt(
      dto.paymentReceiptMimeType,
      dto.paymentReceiptFileName,
      dto.paymentReceiptSizeBytes
    )
    if (!receiptValidation.ok) {
      throw new BadRequestException(receiptValidation.reason)
    }

    const report = await this.expenseReportModel.findById(reportId).exec()
    if (!report) {
      throw new NotFoundException(`Expense report with ID ${reportId} not found`)
    }

    if (tenantCtx && !tenantCtx.isSuperAdmin) {
      const rid = this.normalizeExpenseReportClientId(report.clientId)
      if (
        !tenantCtx.requestClientId ||
        rid !== tenantCtx.requestClientId
      ) {
        throw new ForbiddenException(
          'La rendición no pertenece a su organización.'
        )
      }
    }

    if (report.status !== 'approved' && report.status !== 'closed') {
      throw new BadRequestException(
        'Solo se puede registrar el reembolso cuando la rendición está aprobada o cerrada.'
      )
    }
    if (report.settlement?.type !== 'reembolso') {
      throw new BadRequestException(
        'Esta rendición no tiene saldo a favor del colaborador que deba reembolsarse.'
      )
    }
    if (report.reimbursementPaymentInfo) {
      throw new BadRequestException('El reembolso de esta rendición ya fue registrado.')
    }

    report.reimbursementPaymentInfo = {
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
    report.reimbursedAt = new Date()
    if (report.status !== 'closed') {
      report.status = 'reimbursed'
    }
    await report.save()

    await this.notifyCollaboratorReimbursementPaid(reportId)

    return this.findOne(reportId)
  }

  private async notifyCollaboratorReimbursementPaid(reportId: string) {
    const report = await this.findOne(reportId)
    const owner = report.userId as any
    if (!owner?.email) return

    const profile = await this.userService.findTransactionalProfile(
      String(owner._id || owner.id)
    )
    const coordinatorId = profile?.coordinatorId?.toString?.()
    const coordinator = coordinatorId
      ? await this.userService.findEmailNameClient(coordinatorId)
      : null

    const diff = report.settlement?.difference ?? 0
    const amountFormatted = Math.abs(Number(diff)).toFixed(2)

    const platformUrl = this.emailService.buildAppUrl('/mis-documentos')

    const pi = report.reimbursementPaymentInfo
    const transferDate = pi?.transferDate
      ? new Date(pi.transferDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10)

    const baseData = {
      collaboratorName: owner.name || 'Colaborador',
      coordinatorName: coordinator?.name,
      reportTitle: report.title || 'Rendición',
      amountFormatted,
      transferDate,
      reference: pi?.reference || '—',
      paymentMethod: pi?.method || 'transferencia_bancaria',
      paymentReceiptUrl: pi?.paymentReceiptUrl || '',
      paymentReceiptFileName:
        pi?.paymentReceiptFileName || 'comprobante-reembolso.pdf',
      platformUrl,
    }

    try {
      await this.emailService.sendRendicionReembolsoPagado(owner.email, {
        recipientName: owner.name || 'Colaborador',
        ...baseData,
      })

      if (coordinator?.email) {
        await this.emailService.sendRendicionReembolsoPagado(coordinator.email, {
          recipientName: coordinator.name || 'Coordinador/a',
          ...baseData,
        })
      }

      await this.notificationsService.create({
        userId: String(owner._id || owner.id),
        title: 'Reembolso registrado',
        message: `Se registró el pago del reembolso por S/ ${amountFormatted} para "${report.title}".`,
        type: 'success',
        actionUrl: `/mis-documentos`,
      })
    } catch (err) {
      console.error(
        'Error enviando notificación de reembolso pagado',
        err
      )
    }
  }

  async findOneWithAdvances(id: string) {
    const report = await this.expenseReportModel
      .findById(id)
      .populate('userId', 'name email signature')
      .populate({ path: 'expenseIds', populate: [{ path: 'categoryId', select: 'name' }, { path: 'proyectId', select: 'name' }] })
      .populate('advanceIds')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('projectId', 'name')
      .exec()
    if (!report)
      throw new NotFoundException(`Expense report with ID ${id} not found`)
    return report
  }

  // ─── FASE 8 — Cierre Definitivo ──────────────────────────────────────────

  /** Valida todas las condiciones previas al cierre. Devuelve lista de errores (vacía = OK). */
  async validateClosureConditions(id: string): Promise<string[]> {
    const report = await this.expenseReportModel.findById(id).populate('expenseIds').exec()
    if (!report) throw new NotFoundException(`Rendición ${id} no encontrada`)
    const errors: string[] = []
    if (report.status === 'closed') {
      errors.push('La rendición ya está cerrada')
      return errors
    }
    if (report.status !== 'approved' && report.status !== 'reimbursed') {
      errors.push(`Estado actual "${report.status}" no permite cierre. Se requiere estado aprobado o reembolsado.`)
    }
    const expenses = (report.expenseIds as any[]) || []
    const hasPendingExpenses = expenses.some(
      e => e?.status === 'pending_review' || e?.status === 'pending_sunat'
    )
    if (hasPendingExpenses) {
      errors.push('Existen gastos en estado pendiente de revisión o validación SUNAT')
    }
    const returnRecord = (report as any).returnRecord
    if (returnRecord && returnRecord.status !== 'validated') {
      errors.push(`Devolución pendiente en estado: ${returnRecord.status}. Se requiere validación de Contabilidad.`)
    }
    return errors
  }

  /** Cierra definitivamente la rendición. Bloquea toda edición posterior. */
  async close(id: string, closedBy: string): Promise<ExpenseReportDocument> {
    const errors = await this.validateClosureConditions(id)
    if (errors.length > 0) {
      throw new BadRequestException(errors.join(' | '))
    }
    // Compute settlement before closing in case it was skipped at approval time
    // (liquidateExpenseReport requires status === 'approved', which is still true here)
    try {
      await this.advanceService.liquidateExpenseReport(id)
    } catch (err) {
      console.error(`[close] Pre-close liquidation error for ${id}:`, err)
    }
    const closureRecord = {
      closedAt: new Date(),
      closedBy,
      reopeningStatus: 'none' as const,
      documentHashes: [],
    }
    const updated = await this.expenseReportModel
      .findByIdAndUpdate(id, { $set: { status: 'closed', closureRecord } }, { new: true })
      .exec()
    if (!updated) throw new NotFoundException(`Rendición ${id} no encontrada`)
    const collaborator = await this.userService.findEmailNameClient(updated.userId.toString())
    const closedAtStr = closureRecord.closedAt.toLocaleDateString('es-PE')
    if (collaborator?.email) {
      this.emailService.sendRendicionCerrada(collaborator.email, {
        recipientName: collaborator.name,
        reportTitle: updated.title,
        closedAt: closedAtStr,
      }).catch(() => {})
    }

    const settlement = (updated as any).settlement
    const clientId = updated.clientId.toString()
    const platformUrl = this.emailService.buildAppUrl(`/mis-rendiciones/${id}/detalle`)

    if (settlement?.type === 'devolucion') {
      const amountFormatted = Math.abs(Number(settlement.difference)).toFixed(2)
      if (collaborator?.email) {
        this.emailService.sendRendicionDevolucionColaborador(collaborator.email, {
          recipientName: collaborator.name,
          reportTitle: updated.title,
          amountFormatted,
          closedAt: closedAtStr,
          platformUrl,
        }).catch(() => {})
      }
      if (collaborator) {
        this.notificationsService.create({
          userId: updated.userId.toString(),
          title: 'Devolución de saldo pendiente',
          message: `Tu rendición "${updated.title}" fue cerrada. Tienes un saldo de S/ ${amountFormatted} a devolver a la empresa. Por favor, adjunta el comprobante de depósito.`,
          type: 'warning',
          actionUrl: `/mis-rendiciones/${id}/detalle`,
        }).catch(() => {})
      }
    } else if (settlement?.type === 'reembolso') {
      const amountFormatted = Math.abs(Number(settlement.difference)).toFixed(2)
      const accountingUsers = await this.userService.findAccountingRecipientsWithIds(clientId)
      for (const u of accountingUsers) {
        this.emailService.sendRendicionReembolsoContabilidad(u.email, {
          recipientName: u.name,
          reportLabel: `${updated.title} · ${id}`,
          reportTitle: updated.title,
          collaboratorName: collaborator?.name || 'Colaborador',
          amountFormatted,
          detailUrl: platformUrl,
        }).catch(() => {})
        this.notificationsService.create({
          userId: u._id,
          title: 'Reembolso pendiente — Rendición cerrada',
          message: `La rendición "${updated.title}" fue cerrada. Hay un reembolso de S/ ${amountFormatted} pendiente de pago al colaborador ${collaborator?.name || ''}.`,
          type: 'info',
          actionUrl: `/mis-rendiciones/${id}/detalle`,
        }).catch(() => {})
      }
    }

    return updated
  }

  async registerReturnVoucher(
    id: string,
    dto: { depositDate: string; bankOrigin?: string; operationNumber?: string; fileUrl: string; fileName?: string },
    userId: string
  ): Promise<ExpenseReportDocument> {
    const report = await this.expenseReportModel
      .findById(id)
      .populate('expenseIds', 'total status')
      .exec()
    if (!report) throw new NotFoundException(`Rendición ${id} no encontrada`)
    if (report.status !== 'closed') {
      throw new BadRequestException('Solo se puede cargar el comprobante de devolución en una rendición cerrada.')
    }
    if ((report as any).returnVoucher) {
      throw new BadRequestException('Ya se ha cargado un comprobante de devolución para esta rendición.')
    }
    if (report.userId.toString() !== userId) {
      throw new ForbiddenException('Solo el colaborador dueño puede cargar el comprobante de devolución.')
    }

    // Compute live balance from linked advances — used for notification amount only, never blocks the upload
    const rawAdvanceIds = ((report as any).advanceIds ?? []).map((x: any) =>
      (x && typeof x === 'object' && '_id' in x) ? String((x as any)._id) : String(x)
    )
    const linkedAdvances = await this.advanceService.findByExpenseReportId(id, rawAdvanceIds)
    const activeAdvances = linkedAdvances.filter(a =>
      ['approved', 'paid', 'settled'].includes(a.status)
    )
    const expenses = (report.expenseIds as any[]) || []
    const expenseTotal = expenses.reduce((s, e) => s + (Number(e.total) || 0), 0)
    const advanceTotal = activeAdvances.length > 0
      ? activeAdvances.reduce((s, a) => s + (Number(a.amount) || 0), 0)
      : Number((report as any).budget ?? 0)
    const difference = advanceTotal - expenseTotal
    const notifySettlement = { advanceTotal, expenseTotal, difference, type: 'devolucion' as const, settledAt: new Date() }
    // Update settlement in DB only if not already set or the stored type conflicts with actual balance
    const existingSettlement = (report as any).settlement
    if (!existingSettlement || (difference > 0.01 && existingSettlement.type !== 'devolucion')) {
      await this.expenseReportModel.findByIdAndUpdate(id, { $set: { settlement: notifySettlement } }).exec()
    }

    const voucher = {
      url: dto.fileUrl,
      fileName: dto.fileName,
      depositDate: dto.depositDate,
      bankOrigin: dto.bankOrigin,
      operationNumber: dto.operationNumber,
      uploadedAt: new Date(),
    }
    await this.expenseReportModel.findByIdAndUpdate(id, { $set: { returnVoucher: voucher } }).exec()

    const amountFormatted = Math.abs(Number(notifySettlement.difference ?? 0)).toFixed(2)
    const clientId = report.clientId.toString()
    const platformUrl = this.emailService.buildAppUrl(`/mis-rendiciones/${id}/detalle`)
    const collaborator = await this.userService.findEmailNameClient(userId)
    const collaboratorName = collaborator?.name || 'Colaborador'

    if (collaborator?.email) {
      this.emailService.sendRendicionCerrada(collaborator.email, {
        recipientName: collaboratorName,
        reportTitle: report.title,
        closedAt: voucher.uploadedAt.toLocaleDateString('es-PE'),
      }).catch(() => {})
    }
    this.notificationsService.create({
      userId,
      title: 'Comprobante de devolución enviado',
      message: `Tu comprobante de devolución para la rendición "${report.title}" fue enviado correctamente. Contabilidad verificará el depósito.`,
      type: 'success',
      actionUrl: `/mis-rendiciones/${id}/detalle`,
    }).catch(() => {})

    const accountingUsers = await this.userService.findAccountingRecipientsWithIds(clientId)
    for (const u of accountingUsers) {
      this.emailService.sendRendicionDevolucionCargada(u.email, {
        recipientName: u.name,
        collaboratorName,
        reportTitle: report.title,
        amountFormatted,
        depositDate: dto.depositDate,
        bankOrigin: dto.bankOrigin,
        operationNumber: dto.operationNumber,
        platformUrl,
      }).catch(() => {})
      this.notificationsService.create({
        userId: u._id,
        title: 'Comprobante de devolución recibido',
        message: `${collaboratorName} adjuntó el comprobante de devolución de S/ ${amountFormatted} para la rendición "${report.title}". Por favor, verifica el depósito.`,
        type: 'info',
        actionUrl: `/mis-rendiciones/${id}/detalle`,
      }).catch(() => {})
    }

    return this.expenseReportModel.findById(id).exec() as Promise<ExpenseReportDocument>
  }

  /** Solicita reapertura (rol Gerencia/Admin). */
  async requestReopening(
    id: string,
    requestedBy: string,
    reason: string
  ): Promise<ExpenseReportDocument> {
    const report = await this.expenseReportModel.findById(id).exec()
    if (!report) throw new NotFoundException(`Rendición ${id} no encontrada`)
    if (report.status !== 'closed') {
      throw new BadRequestException('Solo se puede solicitar reapertura de rendiciones cerradas')
    }
    if (reason.trim().length < 200) {
      throw new BadRequestException('El motivo de reapertura debe tener al menos 200 caracteres')
    }
    const updatedClosure = {
      ...(report as any).closureRecord,
      reopeningStatus: 'requested' as const,
      reopeningRequestedBy: requestedBy,
      reopeningRequestedAt: new Date(),
      reopeningReason: reason,
    }
    const updated = await this.expenseReportModel
      .findByIdAndUpdate(id, { $set: { closureRecord: updatedClosure } }, { new: true })
      .exec()
    return updated!
  }

  /** Contabilidad aprueba o rechaza la reapertura. */
  async approveReopening(
    id: string,
    approvedBy: string,
    approve: boolean
  ): Promise<ExpenseReportDocument> {
    const report = await this.expenseReportModel.findById(id).exec()
    if (!report) throw new NotFoundException(`Rendición ${id} no encontrada`)
    const cr = (report as any).closureRecord
    if (!cr || cr.reopeningStatus !== 'requested') {
      throw new BadRequestException('No hay solicitud de reapertura pendiente')
    }
    const updates: any = {}
    if (approve) {
      updates.status = 'approved'
      updates.closureRecord = {
        ...cr,
        reopeningStatus: 'approved' as const,
        reopeningApprovedBy: approvedBy,
        reopeningApprovedAt: new Date(),
        reopenedAt: new Date(),
      }
    } else {
      updates.closureRecord = {
        ...cr,
        reopeningStatus: 'none' as const,
        reopeningApprovedBy: approvedBy,
        reopeningApprovedAt: new Date(),
      }
    }
    const updated = await this.expenseReportModel
      .findByIdAndUpdate(id, { $set: updates }, { new: true })
      .exec()
    return updated!
  }

  // ─── Cancel / Delete por colaborador ────────────────────────────────────────

  /** Cancela una rendición en estado 'solicited'. Solo el propietario puede cancelar. */
  async cancel(
    id: string,
    userId: string,
    reason?: string
  ): Promise<ExpenseReportDocument> {
    const report = await this.expenseReportModel.findById(id).lean().exec()
    if (!report) throw new NotFoundException(`Expense report with ID ${id} not found`)

    if (
      String(report.userId) !== String(userId) &&
      String(report.createdBy) !== String(userId)
    ) {
      throw new ForbiddenException('No tienes permiso para cancelar esta rendición')
    }
    if (report.status !== 'solicited') {
      throw new BadRequestException(
        'Solo se puede cancelar una rendición en estado solicitada.'
      )
    }

    const updated = await this.expenseReportModel
      .findByIdAndUpdate(id, { $set: { status: 'cancelled' } }, { new: true })
      .exec()
    if (!updated) throw new NotFoundException(`Expense report with ID ${id} not found`)

    try {
      const admins = await this.userService.findAdminsByClient(String(report.clientId))
      const user = await this.userService.findOne(userId)
      const collaboratorName = user.name || 'Un colaborador'

      for (const admin of admins) {
        if (admin.email) {
          await this.emailService.sendRendicionCancelada(admin.email, {
            adminName: admin.name || 'Administrador',
            collaboratorName,
            reportTitle: report.title,
            cancelReason: reason,
          })
        }
        await this.notificationsService.create({
          userId: String(admin._id),
          title: 'Rendición cancelada',
          message: `${collaboratorName} ha cancelado su solicitud de rendición: "${report.title}"`,
          type: 'warning',
          actionUrl: `/mis-rendiciones/${id}/detalle`,
        })
      }
    } catch (error) {
      console.error('Error enviando notificaciones de rendición cancelada', error)
    }

    return updated
  }

  /** Guard: lanza ForbiddenException si la rendición está cerrada. */
  async assertNotClosed(id: string): Promise<void> {
    const report = await this.expenseReportModel.findById(id).select('status closureRecord').exec()
    if (!report) throw new NotFoundException(`Rendición ${id} no encontrada`)
    if (report.status === 'closed') {
      throw new ForbiddenException('La rendición está cerrada y no permite modificaciones')
    }
  }
}
