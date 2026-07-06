import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'
import { AccountingEntriesStatus, AsientoTipo, CuadreError } from './accounting-entries.types'

/**
 * Archivo de asientos contables de una rendición, generado en segundo plano
 * y persistido en S3. Una entrada por (reportId, tipo); se sobreescribe en
 * cada regeneración. Mientras `status = 'processing'` conserva el último
 * `s3Key` listo (si existe) para que siga siendo descargable.
 */
export interface AccountingEntriesFileDocument extends Document {
  reportId: Types.ObjectId
  clientId: Types.ObjectId
  tipo: AsientoTipo
  status: AccountingEntriesStatus
  /** Hash de invalidación del último archivo generado con éxito. */
  fingerprint?: string
  filename?: string
  /** Key del objeto en S3 (bucket configurado en AWS_S3_BUCKET_NAME). */
  s3Key?: string
  asientosCount: number
  cuadreErrors: CuadreError[]
  /** Avisos de configuración (ej. categoría sin cuenta 9X) detectados al generar. */
  warnings?: string[]
  errorMessage?: string
  requestedBy?: string
  startedAt?: Date
  completedAt?: Date
}

@Schema({ timestamps: true })
export class AccountingEntriesFile {
  @Prop({ required: true, type: Types.ObjectId, ref: 'ExpenseReport', index: true })
  reportId: Types.ObjectId

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId

  @Prop({ required: true })
  tipo: AsientoTipo

  @Prop({ required: true, default: 'processing' })
  status: AccountingEntriesStatus

  @Prop()
  fingerprint?: string

  @Prop()
  filename?: string

  @Prop()
  s3Key?: string

  @Prop({ required: true, default: 0 })
  asientosCount: number

  @Prop({ type: Array, default: [] })
  cuadreErrors: CuadreError[]

  @Prop({ type: [String], default: [] })
  warnings?: string[]

  @Prop()
  errorMessage?: string

  @Prop()
  requestedBy?: string

  @Prop()
  startedAt?: Date

  @Prop()
  completedAt?: Date
}

export const AccountingEntriesFileSchema = SchemaFactory.createForClass(
  AccountingEntriesFile
)

// Una entrada por (rendición, tipo). Se actualiza in-place en cada generación.
AccountingEntriesFileSchema.index({ reportId: 1, tipo: 1 }, { unique: true })
