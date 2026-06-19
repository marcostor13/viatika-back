import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Saldo, SaldoContext, SaldoDocument, SaldoType } from './entities/saldo.entity'
import { CreatePagoSaldoDto } from './dto/create-pago-saldo.dto'
import { NotificationsService } from '../notifications/notifications.service'

/** Tipos de saldo elegibles según el contexto de consumo. */
const ELIGIBLE_TYPES: Record<SaldoContext, SaldoType[]> = {
  rendicion_directa: ['rendicion_directa', 'pago'],
  viatico: ['rendicion'],
}

@Injectable()
export class SaldoService {
  private readonly logger = new Logger(SaldoService.name)

  constructor(
    @InjectModel(Saldo.name)
    private readonly saldoModel: Model<SaldoDocument>,
    private readonly notificationsService: NotificationsService
  ) {}

  /** Pago directo de Contabilidad → Saldo tipo `pago` (sin centro de costo). */
  async createFromPago(
    dto: CreatePagoSaldoDto,
    createdBy: string,
    clientId: string
  ): Promise<SaldoDocument> {
    const saldo = await this.saldoModel.create({
      clientId: new Types.ObjectId(clientId),
      userId: new Types.ObjectId(dto.userId),
      type: 'pago',
      amount: dto.amount,
      status: 'available',
      concepto: dto.concepto?.trim() || undefined,
      deposit: {
        amount: dto.amount,
        scannedAmount: dto.scannedAmount,
        receiptUrl: dto.receiptUrl,
        receiptFileName: dto.receiptFileName,
        receiptMimeType: dto.receiptMimeType,
        receiptSizeBytes: dto.receiptSizeBytes,
        depositDate: dto.depositDate,
        operationNumber: dto.operationNumber,
        operationDate: dto.operationDate,
        operationTime: dto.operationTime,
        titular: dto.titular,
        createdBy: new Types.ObjectId(createdBy),
        createdAt: new Date(),
      },
      createdBy: new Types.ObjectId(createdBy),
    })

    try {
      await this.notificationsService.create({
        userId: String(dto.userId),
        title: 'Nuevo saldo disponible',
        message: `Contabilidad registró un pago de S/ ${dto.amount.toFixed(2)} a tu favor. Ya está disponible en tu Saldo.`,
        type: 'info',
        actionUrl: '/saldo',
      })
    } catch (error) {
      this.logger.error('Error notificando saldo de pago', error)
    }

    return saldo
  }

  /**
   * Crea un Saldo a partir del remanente positivo de una rendición liquidada.
   * Idempotente: si ya existe un saldo con ese `sourceReportId`, no duplica.
   */
  async createFromRemnant(input: {
    userId: Types.ObjectId | string
    clientId: Types.ObjectId | string
    projectId?: Types.ObjectId | string | null
    sourceReportId: Types.ObjectId | string
    amount: number
    type: Extract<SaldoType, 'rendicion' | 'rendicion_directa'>
    createdBy?: Types.ObjectId | string
  }): Promise<SaldoDocument | null> {
    if (!input.amount || input.amount <= 0.01) return null

    const sourceReportId = new Types.ObjectId(String(input.sourceReportId))
    const existing = await this.saldoModel.findOne({ sourceReportId }).exec()
    if (existing) return existing

    const userId = new Types.ObjectId(String(input.userId))
    const saldo = await this.saldoModel.create({
      clientId: new Types.ObjectId(String(input.clientId)),
      userId,
      type: input.type,
      amount: input.amount,
      status: 'available',
      projectId: input.projectId
        ? new Types.ObjectId(String(input.projectId))
        : undefined,
      sourceReportId,
      createdBy: input.createdBy
        ? new Types.ObjectId(String(input.createdBy))
        : userId,
    })

    try {
      await this.notificationsService.create({
        userId: String(userId),
        title: 'Nuevo saldo disponible',
        message: `Quedó un saldo de S/ ${input.amount.toFixed(2)} a tu favor tras liquidar una rendición. Ya está disponible en tu Saldo.`,
        type: 'info',
        actionUrl: '/saldo',
      })
    } catch (error) {
      this.logger.error('Error notificando saldo de remanente', error)
    }

    return saldo
  }

  /** Todos los saldos disponibles del colaborador (página Saldo). */
  async findAvailableByUser(userId: string, clientId: string) {
    return this.saldoModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
        status: 'available',
      })
      .populate('projectId', 'name code')
      .populate('sourceReportId', 'codigo title')
      .sort({ createdAt: -1 })
      .lean()
      .exec()
  }

  /** Saldos elegibles para un contexto de consumo. */
  async findEligible(
    userId: string,
    clientId: string,
    context: SaldoContext,
    projectId?: string
  ) {
    const types = ELIGIBLE_TYPES[context]
    if (!types) {
      throw new BadRequestException(`Contexto de saldo inválido: ${context}`)
    }
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
      clientId: new Types.ObjectId(clientId),
      status: 'available',
      type: { $in: types },
    }
    if (context === 'viatico') {
      if (!projectId || !Types.ObjectId.isValid(projectId)) {
        // Sin centro de costo seleccionado no hay saldos elegibles.
        return []
      }
      filter.projectId = new Types.ObjectId(projectId)
    }
    return this.saldoModel
      .find(filter)
      .populate('projectId', 'name code')
      .populate('sourceReportId', 'codigo title')
      .sort({ createdAt: -1 })
      .lean()
      .exec()
  }

  /** Suma de saldos disponibles del colaborador (header). */
  async getTotalByUser(userId: string, clientId: string): Promise<number> {
    const rows = await this.saldoModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
        status: 'available',
      })
      .select('amount')
      .lean()
      .exec()
    return rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
  }

  /**
   * Consume (completo) los saldos indicados validando dueño, disponibilidad y
   * reglas de elegibilidad del contexto. Marca status `consumed` y enlaza el
   * documento consumidor. Devuelve la suma consumida.
   */
  async consume(
    saldoIds: string[],
    opts: {
      userId: string
      clientId: string
      context: SaldoContext
      projectId?: string
      reportId?: string
      advanceId?: string
    }
  ): Promise<number> {
    if (!Array.isArray(saldoIds) || saldoIds.length === 0) return 0

    const ids = saldoIds.map(id => {
      if (!Types.ObjectId.isValid(id)) {
        throw new BadRequestException(`Saldo inválido: ${id}`)
      }
      return new Types.ObjectId(id)
    })

    const saldos = await this.saldoModel
      .find({
        _id: { $in: ids },
        userId: new Types.ObjectId(opts.userId),
        clientId: new Types.ObjectId(opts.clientId),
      })
      .exec()

    if (saldos.length !== ids.length) {
      throw new BadRequestException(
        'Uno o más saldos no existen o no pertenecen al usuario.'
      )
    }

    const eligibleTypes = ELIGIBLE_TYPES[opts.context]
    for (const s of saldos) {
      if (s.status !== 'available') {
        throw new BadRequestException(
          `El saldo ${String(s._id)} ya fue consumido.`
        )
      }
      if (!eligibleTypes.includes(s.type)) {
        throw new BadRequestException(
          `El saldo de tipo "${s.type}" no es válido para este movimiento.`
        )
      }
      if (opts.context === 'viatico') {
        const sameProject =
          opts.projectId &&
          s.projectId &&
          String(s.projectId) === String(opts.projectId)
        if (!sameProject) {
          throw new BadRequestException(
            'Solo puedes usar saldos del mismo centro de costo.'
          )
        }
      }
    }

    const consumedAt = new Date()
    let total = 0
    for (const s of saldos) {
      s.status = 'consumed'
      s.consumedAt = consumedAt
      if (opts.reportId) {
        s.consumedByReportId = new Types.ObjectId(opts.reportId)
      }
      if (opts.advanceId) {
        s.consumedByAdvanceId = new Types.ObjectId(opts.advanceId)
      }
      await s.save()
      total += Number(s.amount) || 0
    }
    return total
  }

  /** Suma de los montos de los saldos indicados sin consumirlos (pre-cálculo). */
  async sumAmounts(
    saldoIds: string[],
    userId: string,
    clientId: string
  ): Promise<number> {
    if (!Array.isArray(saldoIds) || saldoIds.length === 0) return 0
    const ids = saldoIds
      .filter(id => Types.ObjectId.isValid(id))
      .map(id => new Types.ObjectId(id))
    const rows = await this.saldoModel
      .find({
        _id: { $in: ids },
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
        status: 'available',
      })
      .select('amount')
      .lean()
      .exec()
    return rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0)
  }
}
