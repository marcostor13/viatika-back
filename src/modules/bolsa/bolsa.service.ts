import { Injectable, NotFoundException } from '@nestjs/common'
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
