import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

/**
 * Tipo/origen funcional del saldo. Determina las reglas de consumo:
 * - `viaticos`  → RN-1: solo se puede usar dentro del mismo `projectId`.
 * - `directa`   → RN-2: combinable entre distintos proyectos.
 * - `caja_chica`→ arrastre del fondo de caja chica (caso Susan).
 * RN-7 (confirmado por el cliente): un saldo de viáticos puede usarse en una
 * rendición directa y viceversa **dentro del mismo proyecto**.
 */
export type WalletEntryType = 'viaticos' | 'directa' | 'caja_chica'

/** Estado del saldo dentro de la Bolsa. */
export type WalletEntryStatus = 'available' | 'consumed' | 'returned'

/** Cómo nació la entrada de la Bolsa (trazabilidad/auditoría). */
export type WalletEntryOrigin = 'deposito' | 'saldo_sobrante' | 'carga_manual'

export interface WalletEntryDocument extends Document {
  userId: Types.ObjectId
  clientId: Types.ObjectId
  projectId?: Types.ObjectId
  type: WalletEntryType
  origin: WalletEntryOrigin
  amount: number
  remainingAmount: number
  status: WalletEntryStatus
  sourceReportId?: Types.ObjectId
  sourceAdvanceId?: Types.ObjectId
  sourceCodigo?: string
  operationNumber?: string
  operationDate?: string
  depositDate?: string
  receiptUrl?: string
  titular?: string
  scannedAmount?: number
  note?: string
  consumedByReportId?: Types.ObjectId
  consumedByAdvanceId?: Types.ObjectId
  consumedAt?: Date
  returnedAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

/**
 * Bolsa = saldo global por colaborador. Cada documento es UN saldo individual
 * (no un agregado), lo que permite trazabilidad por saldo (RN-6) y consumo
 * desde múltiples fuentes al crear una rendición/solicitud.
 */
@Schema({ timestamps: true })
export class WalletEntry {
  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  userId: Types.ObjectId

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId

  /**
   * Proyecto del saldo. Obligatorio para saldos de viáticos (RN-1). Null/ausente
   * para rendiciones directas que combinan proyectos (RN-2).
   */
  @Prop({ required: false, type: Types.ObjectId, ref: 'Project' })
  projectId?: Types.ObjectId

  @Prop({ required: true })
  type: WalletEntryType

  @Prop({ required: true })
  origin: WalletEntryOrigin

  /** Monto original con el que entró el saldo a la Bolsa. */
  @Prop({ required: true })
  amount: number

  /** Saldo vivo disponible para consumir (init = amount; 0 al consumirse del todo). */
  @Prop({ required: true })
  remainingAmount: number

  @Prop({ default: 'available' })
  status: WalletEntryStatus

  // ---- Trazabilidad de origen (RN-6) ----

  /** Rendición de la que proviene este saldo (su sobrante). */
  @Prop({ required: false, type: Types.ObjectId, ref: 'ExpenseReport' })
  sourceReportId?: Types.ObjectId

  /** Anticipo/viático del que proviene este saldo, si aplica. */
  @Prop({ required: false, type: Types.ObjectId, ref: 'Advance' })
  sourceAdvanceId?: Types.ObjectId

  /** Código RD-XXXX de la rendición de origen (se muestra en reportes/consulta). */
  @Prop({ required: false })
  sourceCodigo?: string

  /** Nº de transferencia/operación del depósito que originó el saldo. */
  @Prop({ required: false })
  operationNumber?: string

  @Prop({ required: false })
  operationDate?: string

  @Prop({ required: false })
  depositDate?: string

  @Prop({ required: false })
  receiptUrl?: string

  @Prop({ required: false })
  titular?: string

  /** Monto leído por OCR del comprobante (informativo). */
  @Prop({ required: false })
  scannedAmount?: number

  @Prop({ required: false })
  note?: string

  // ---- Consumo ----

  /** Rendición directa / caja chica que consumió este saldo. */
  @Prop({ required: false, type: Types.ObjectId, ref: 'ExpenseReport' })
  consumedByReportId?: Types.ObjectId

  /** Solicitud de viáticos que consumió este saldo. */
  @Prop({ required: false, type: Types.ObjectId, ref: 'Advance' })
  consumedByAdvanceId?: Types.ObjectId

  @Prop({ required: false, type: Date })
  consumedAt?: Date

  /** Fecha en que el saldo se devolvió a la empresa (en vez de reutilizarse). */
  @Prop({ required: false, type: Date })
  returnedAt?: Date

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  createdBy: Types.ObjectId
}

export const WalletEntrySchema = SchemaFactory.createForClass(WalletEntry)

// Consulta principal: saldos disponibles por colaborador, aislados por cliente.
WalletEntrySchema.index({ clientId: 1, userId: 1, status: 1 })
// Filtro por proyecto (RN-1) al ofrecer saldos consumibles.
WalletEntrySchema.index({ clientId: 1, userId: 1, projectId: 1, status: 1 })
// Idempotencia (BOLSA-4): un único saldo sobrante por rendición de origen.
WalletEntrySchema.index(
  { sourceReportId: 1 },
  { unique: true, partialFilterExpression: { origin: 'saldo_sobrante' } }
)
