import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import {
  WalletEntry,
  WalletEntryDocument,
  WalletEntryOrigin,
  WalletEntryType,
} from './entities/wallet-entry.entity'
import { CreateWalletEntryDto } from './dto/create-wallet-entry.dto'

/** Entrada para crear un saldo desde otros servicios (depósito, sobrante, etc.). */
export interface CreateWalletEntryInput {
  userId: string | Types.ObjectId
  clientId: string | Types.ObjectId
  projectId?: string | Types.ObjectId | null
  type: WalletEntryType
  origin: WalletEntryOrigin
  amount: number
  sourceReportId?: string | Types.ObjectId | null
  sourceAdvanceId?: string | Types.ObjectId | null
  sourceCodigo?: string
  operationNumber?: string
  operationDate?: string
  depositDate?: string
  receiptUrl?: string
  titular?: string
  scannedAmount?: number
  note?: string
  createdBy: string | Types.ObjectId
}

/** Destino que consume saldos de la Bolsa (determina las reglas RN-1/RN-2/RN-7). */
export interface ConsumeContext {
  userId: string | Types.ObjectId
  clientId: string | Types.ObjectId
  targetType: WalletEntryType
  projectId?: string | Types.ObjectId | null
}

const toId = (v: unknown): Types.ObjectId | undefined =>
  v === undefined || v === null || v === ''
    ? undefined
    : new Types.ObjectId(String(v))

@Injectable()
export class BolsaService {
  constructor(
    @InjectModel(WalletEntry.name)
    private readonly walletModel: Model<WalletEntryDocument>
  ) {}

  /**
   * Crea una entrada de saldo en la Bolsa de un colaborador. Punto único por el
   * que todo dinero entra a la Bolsa (depósito de Contabilidad, sobrante de una
   * rendición o carga manual).
   */
  async createEntry(input: CreateWalletEntryInput): Promise<WalletEntryDocument> {
    const entry = new this.walletModel({
      userId: toId(input.userId),
      clientId: toId(input.clientId),
      projectId: toId(input.projectId),
      type: input.type,
      origin: input.origin,
      amount: input.amount,
      remainingAmount: input.amount,
      status: 'available',
      sourceReportId: toId(input.sourceReportId),
      sourceAdvanceId: toId(input.sourceAdvanceId),
      sourceCodigo: input.sourceCodigo,
      operationNumber: input.operationNumber,
      operationDate: input.operationDate,
      depositDate: input.depositDate,
      receiptUrl: input.receiptUrl,
      titular: input.titular,
      scannedAmount: input.scannedAmount,
      note: input.note,
      createdBy: toId(input.createdBy),
    })
    return entry.save()
  }

  /** Carga manual de un saldo previo (marcha blanca / BOLSA-11). */
  async createManual(
    dto: CreateWalletEntryDto,
    clientId: string,
    createdBy: string
  ): Promise<WalletEntryDocument> {
    return this.createEntry({
      userId: dto.userId,
      clientId: dto.clientId || clientId,
      projectId: dto.projectId,
      type: dto.type,
      origin: dto.origin || 'carga_manual',
      amount: dto.amount,
      sourceReportId: dto.sourceReportId,
      sourceAdvanceId: dto.sourceAdvanceId,
      sourceCodigo: dto.sourceCodigo,
      operationNumber: dto.operationNumber,
      operationDate: dto.operationDate,
      depositDate: dto.depositDate,
      receiptUrl: dto.receiptUrl,
      titular: dto.titular,
      note: dto.note,
      createdBy,
    })
  }

  /** Bolsa de un colaborador: todos sus saldos + total disponible. */
  async findByUser(userId: string, clientId: string) {
    const entries = await this.walletModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
      })
      .populate('projectId', 'name')
      .populate('sourceReportId', 'codigo')
      .sort({ createdAt: -1 })
      .lean()
      .exec()

    const available = entries.filter((e) => e.status === 'available')
    const totalAvailable = available.reduce(
      (sum, e) => sum + (Number(e.remainingAmount) || 0),
      0
    )

    return {
      userId,
      clientId,
      totalAvailable,
      availableCount: available.length,
      entries,
    }
  }

  /**
   * Saldos disponibles consumibles por un colaborador para crear una
   * rendición/solicitud. Si se pasa `projectId`, aplica RN-1: solo saldos del
   * mismo proyecto o sin proyecto (directas multi-proyecto, RN-2). RN-7: no se
   * filtra por `type` dentro del mismo proyecto.
   */
  async getAvailableEntries(
    userId: string,
    clientId: string,
    opts?: { projectId?: string }
  ): Promise<WalletEntryDocument[]> {
    const filter: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
      clientId: new Types.ObjectId(clientId),
      status: 'available',
      remainingAmount: { $gt: 0 },
    }
    if (opts?.projectId) {
      filter.$or = [
        { projectId: new Types.ObjectId(opts.projectId) },
        { projectId: { $exists: false } },
        { projectId: null },
      ]
    }
    return this.walletModel.find(filter).sort({ createdAt: 1 }).exec()
  }

  /**
   * Regla de consumo de un saldo según el destino (RN-1/RN-2/RN-7):
   * - destino `directa` (RN-2): combina cualquier proyecto → siempre permitido.
   * - destino `viaticos`/`caja_chica` (RN-1): solo saldos del mismo proyecto, o sin
   *   proyecto (saldos de directa multi-proyecto). RN-7: NO se filtra por tipo de
   *   origen dentro del mismo proyecto (un saldo de viáticos puede usarse en directa
   *   y viceversa).
   */
  private canConsume(
    entry: WalletEntryDocument,
    targetType: WalletEntryType,
    projectId?: string | Types.ObjectId | null
  ): boolean {
    if (targetType === 'directa') return true
    if (!entry.projectId) return true
    return String(entry.projectId) === String(projectId ?? '')
  }

  /** Saldos disponibles que un colaborador puede consumir para un destino dado. */
  async getConsumableEntries(
    userId: string,
    clientId: string,
    ctx: { targetType: WalletEntryType; projectId?: string }
  ): Promise<WalletEntryDocument[]> {
    const available = await this.getAvailableEntries(userId, clientId)
    return available.filter((e) =>
      this.canConsume(e, ctx.targetType, ctx.projectId)
    )
  }

  /**
   * Valida y suma los saldos seleccionados SIN marcarlos (para fijar el presupuesto
   * de la rendición antes de guardarla). Lanza si alguno no pertenece al colaborador,
   * no está disponible o incumple la regla de proyecto.
   */
  async previewConsume(
    entryIds: string[],
    ctx: ConsumeContext
  ): Promise<{ total: number; entries: WalletEntryDocument[] }> {
    const ids = [...new Set(entryIds)].map((x) => new Types.ObjectId(String(x)))
    const entries = await this.walletModel.find({ _id: { $in: ids } }).exec()
    if (entries.length !== ids.length) {
      throw new BadRequestException('Uno o más saldos seleccionados no existen.')
    }
    let total = 0
    for (const e of entries) {
      if (
        String(e.userId) !== String(ctx.userId) ||
        String(e.clientId) !== String(ctx.clientId)
      ) {
        throw new ForbiddenException(
          'Un saldo seleccionado no pertenece al colaborador.'
        )
      }
      if (e.status !== 'available' || Number(e.remainingAmount) < 0.01) {
        throw new BadRequestException(
          `El saldo ${e.sourceCodigo ?? ''} ya no está disponible.`.trim()
        )
      }
      if (!this.canConsume(e, ctx.targetType, ctx.projectId)) {
        throw new BadRequestException(
          `Este saldo no puede ser utilizado porque el proyecto no corresponde${
            e.sourceCodigo ? ` (${e.sourceCodigo})` : ''
          }.`
        )
      }
      total += Number(e.remainingAmount)
    }
    return { total, entries }
  }

  /**
   * Marca como consumidos (consumo total) los saldos tras crear la rendición/solicitud.
   * El guard `status: 'available'` evita doble-gasto por concurrencia.
   */
  async markConsumed(
    entryIds: string[],
    by: { reportId?: string | Types.ObjectId; advanceId?: string | Types.ObjectId }
  ): Promise<void> {
    const ids = [...new Set(entryIds)].map((x) => new Types.ObjectId(String(x)))
    if (!ids.length) return
    const set: Record<string, unknown> = {
      status: 'consumed',
      remainingAmount: 0,
      consumedAt: new Date(),
    }
    if (by.reportId) set.consumedByReportId = new Types.ObjectId(String(by.reportId))
    if (by.advanceId)
      set.consumedByAdvanceId = new Types.ObjectId(String(by.advanceId))
    await this.walletModel
      .updateMany({ _id: { $in: ids }, status: 'available' }, { $set: set })
      .exec()
  }

  /** Detalle de un saldo de la Bolsa. */
  async findOne(id: string) {
    const entry = await this.walletModel
      .findById(id)
      .populate('projectId', 'name')
      .populate('sourceReportId', 'codigo')
      .lean()
      .exec()
    if (!entry) {
      throw new NotFoundException('Saldo no encontrado en la Bolsa')
    }
    return entry
  }
}
