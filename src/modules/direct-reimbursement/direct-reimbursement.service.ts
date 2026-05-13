import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import {
  DirectReimbursement,
  DirectReimbursementDocument,
} from './entities/direct-reimbursement.entity'
import { CreateDirectReimbursementDto } from './dto/create-direct-reimbursement.dto'
import { RegisterDirectReimbursementPaymentDto } from './dto/register-payment.dto'
import { EmailService } from '../email/email.service'
import { UserService } from '../user/user.service'
import { NotificationsService } from '../notifications/notifications.service'

export const OVERRUN_TOLERANCE = 0.20

@Injectable()
export class DirectReimbursementService {
  constructor(
    @InjectModel(DirectReimbursement.name)
    private readonly model: Model<DirectReimbursementDocument>,
    private readonly emailService: EmailService,
    private readonly userService: UserService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async generateCode(clientId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `RD-${year}-`
    const last = await this.model
      .findOne({ clientId: new Types.ObjectId(clientId), code: { $regex: `^${prefix}` } })
      .sort({ code: -1 })
      .lean()
      .exec()
    let seq = 1
    if (last?.code) {
      const parts = last.code.split('-')
      seq = (parseInt(parts[parts.length - 1], 10) || 0) + 1
    }
    return `${prefix}${String(seq).padStart(4, '0')}`
  }

  async create(
    dto: CreateDirectReimbursementDto,
    coordinatorId: string
  ): Promise<DirectReimbursementDocument> {
    if (dto.justification.trim().length < 20) {
      throw new BadRequestException('La justificacion debe tener al menos 20 caracteres')
    }
    const code = await this.generateCode(dto.clientId)
    const doc = await this.model.create({
      code,
      collaboratorId: new Types.ObjectId(dto.collaboratorId),
      coordinatorId: new Types.ObjectId(coordinatorId),
      clientId: new Types.ObjectId(dto.clientId),
      justification: dto.justification.trim(),
      estimatedAmount: dto.estimatedAmount,
      status: 'open',
      expenseIds: [],
    })
    const collaborator = await this.userService.findEmailNameClient(dto.collaboratorId)
    if (collaborator?.email) {
      this.emailService.sendReembolsoDirectoAbierto(collaborator.email, {
        recipientName: collaborator.name,
        code,
        estimatedAmount: dto.estimatedAmount,
        justification: dto.justification,
      }).catch(() => {})
    }

    // Notify Contabilidad of the new direct reimbursement request
    const recipients = await this.userService.findAccountingRecipientsWithIds(dto.clientId)
    const amountFormatted = Number(dto.estimatedAmount).toFixed(2)
    for (const r of recipients) {
      this.notificationsService.create({
        userId: r._id,
        title: 'Nueva solicitud de reembolso directo',
        message: `${collaborator?.name ?? 'Un colaborador'} solicitó un reembolso directo (${code}) por S/ ${amountFormatted}. Revisa la sección de Pagos.`,
        type: 'info',
        actionUrl: '/tesoreria',
        metadata: { directReimbursementId: String(doc._id), code, event: 'direct_reimbursement_created' },
      }).catch(() => {})
      if (r.email) {
        this.emailService.sendReembolsoDirectoNuevoContabilidad(r.email, {
          recipientName: r.name,
          collaboratorName: collaborator?.name ?? 'Colaborador',
          code,
          estimatedAmount: dto.estimatedAmount,
          justification: dto.justification,
        }).catch(() => {})
      }
    }

    return doc
  }

  async addExpense(id: string, expenseId: string): Promise<DirectReimbursementDocument> {
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.status !== 'open' && doc.status !== 'expenses_loaded') {
      throw new BadRequestException('Solo se pueden agregar gastos cuando el expediente está abierto o en carga')
    }
    const updated = await this.model
      .findByIdAndUpdate(
        id,
        {
          $addToSet: { expenseIds: new Types.ObjectId(expenseId) },
          $set: { status: 'expenses_loaded' },
        },
        { new: true }
      )
      .exec()
    return updated!
  }

  async removeExpense(id: string, expenseId: string): Promise<DirectReimbursementDocument> {
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.status !== 'open' && doc.status !== 'expenses_loaded') {
      throw new BadRequestException('No se puede eliminar gastos en este estado')
    }
    const updated = await this.model
      .findByIdAndUpdate(
        id,
        { $pull: { expenseIds: new Types.ObjectId(expenseId) } },
        { new: true }
      )
      .exec()
    return updated!
  }

  /** Coordinador aprueba los gastos cargados y envía a Contabilidad. */
  async coordinatorApprove(id: string, coordinatorId: string): Promise<DirectReimbursementDocument> {
    const doc = await this.model.findById(id).populate('expenseIds').exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.status !== 'expenses_loaded') {
      throw new BadRequestException('Solo se puede aprobar desde el estado expenses_loaded')
    }
    if (doc.coordinatorId.toString() !== coordinatorId) {
      throw new ForbiddenException('Solo el coordinador responsable puede aprobar este expediente')
    }
    const expenses = (doc.expenseIds as any[]) || []
    if (expenses.length === 0) {
      throw new BadRequestException('Debe haber al menos un gasto cargado')
    }
    const totalLoaded = expenses.reduce((sum: number, e: any) => sum + (Number(e.total) || 0), 0)
    const maxAllowed = doc.estimatedAmount * (1 + OVERRUN_TOLERANCE)
    if (totalLoaded > maxAllowed && !doc.overrunJustification) {
      throw new BadRequestException(
        `El total cargado (${totalLoaded}) supera el límite de tolerancia (${maxAllowed.toFixed(2)}). Se requiere justificación de sobreejecución.`
      )
    }
    const updated = await this.model
      .findByIdAndUpdate(id, { $set: { status: 'coordinator_approved', approvedBy: coordinatorId, approvedAt: new Date() } }, { new: true })
      .exec()
    return updated!
  }

  /** Contabilidad aprueba para pago. */
  async accountingApprove(id: string, approvedBy: string): Promise<DirectReimbursementDocument> {
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.status !== 'coordinator_approved') {
      throw new BadRequestException('Solo se puede aprobar desde el estado coordinator_approved')
    }
    const updated = await this.model
      .findByIdAndUpdate(id, { $set: { status: 'accounting_approved', approvedBy, approvedAt: new Date() } }, { new: true })
      .exec()
    return updated!
  }

  /** Contabilidad rechaza con motivo (mín 50 caracteres). */
  async accountingReject(id: string, rejectedBy: string, reason: string): Promise<DirectReimbursementDocument> {
    if (reason.trim().length < 50) {
      throw new BadRequestException('El motivo de rechazo debe tener al menos 50 caracteres')
    }
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.status !== 'coordinator_approved') {
      throw new BadRequestException('Solo se puede rechazar desde el estado coordinator_approved')
    }
    const updated = await this.model
      .findByIdAndUpdate(
        id,
        { $set: { status: 'rejected', rejectionReason: reason.trim() } },
        { new: true }
      )
      .exec()
    return updated!
  }

  /** Contabilidad registra el pago. */
  async registerPayment(
    id: string,
    dto: RegisterDirectReimbursementPaymentDto,
    paidBy: string
  ): Promise<DirectReimbursementDocument> {
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    const payableStatuses = ['open', 'expenses_loaded', 'coordinator_approved', 'accounting_approved']
    if (!payableStatuses.includes(doc.status)) {
      throw new BadRequestException('No se puede registrar el pago en el estado actual')
    }
    const now = new Date()
    const updated = await this.model
      .findByIdAndUpdate(
        id,
        {
          $set: {
            status: 'paid',
            paidAt: now,
            paymentInfo: {
              transferDate: new Date(dto.transferDate),
              amount: dto.amount,
              operationNumber: dto.operationNumber,
              receiptUrl: dto.receiptUrl,
              receiptFileName: dto.receiptFileName,
              paidBy,
              paidAt: now,
            },
          },
        },
        { new: true }
      )
      .exec()
    const collaborator = await this.userService.findEmailNameClient(doc.collaboratorId.toString())
    if (collaborator?.email) {
      this.emailService.sendReembolsoDirectoPagado(collaborator.email, {
        recipientName: collaborator.name,
        code: doc.code,
        amount: dto.amount,
        receiptUrl: dto.receiptUrl,
      }).catch(() => {})
    }
    return updated!
  }

  /** Cierra definitivamente el expediente. */
  async close(id: string, closedBy: string): Promise<DirectReimbursementDocument> {
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.status !== 'paid') {
      throw new BadRequestException('Solo se puede cerrar un expediente ya pagado')
    }
    const updated = await this.model
      .findByIdAndUpdate(id, { $set: { status: 'closed', closedAt: new Date(), closedBy } }, { new: true })
      .exec()
    return updated!
  }

  async findOne(id: string): Promise<DirectReimbursementDocument> {
    const doc = await this.model
      .findById(id)
      .populate('collaboratorId', 'name email')
      .populate('coordinatorId', 'name email')
      .populate('expenseIds')
      .exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    return doc
  }

  async findAllByClient(clientId: string): Promise<DirectReimbursementDocument[]> {
    return this.model
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('collaboratorId', 'name email')
      .populate('coordinatorId', 'name email')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findByCoordinator(coordinatorId: string, clientId: string): Promise<DirectReimbursementDocument[]> {
    return this.model
      .find({
        coordinatorId: new Types.ObjectId(coordinatorId),
        clientId: new Types.ObjectId(clientId),
      })
      .populate('collaboratorId', 'name email')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findPendingPayments(clientId: string): Promise<DirectReimbursementDocument[]> {
    return this.model
      .find({
        clientId: new Types.ObjectId(clientId),
        status: { $in: ['open', 'expenses_loaded', 'coordinator_approved', 'accounting_approved'] },
      })
      .populate('collaboratorId', 'name email')
      .populate('coordinatorId', 'name email')
      .sort({ createdAt: -1 })
      .exec()
  }

  /** Agrega la justificación de sobreejecución cuando se supera la tolerancia. */
  async addOverrunJustification(id: string, justification: string, coordinatorId: string): Promise<DirectReimbursementDocument> {
    if (justification.trim().length < 100) {
      throw new BadRequestException('La justificación de sobreejecución debe tener al menos 100 caracteres')
    }
    const doc = await this.model.findById(id).exec()
    if (!doc) throw new NotFoundException(`Reembolso directo ${id} no encontrado`)
    if (doc.coordinatorId.toString() !== coordinatorId) {
      throw new ForbiddenException('Solo el coordinador responsable puede agregar la justificación')
    }
    const updated = await this.model
      .findByIdAndUpdate(id, { $set: { overrunJustification: justification.trim() } }, { new: true })
      .exec()
    return updated!
  }
}
