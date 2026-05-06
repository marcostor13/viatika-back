import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

export type ExpenseStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'sunat_valid'
  | 'sunat_valid_not_ours'
  | 'sunat_not_found'
  | 'sunat_error'

export type ExpenseType =
  | 'factura'
  | 'planilla_movilidad'
  | 'otros_gastos'
  | 'recibo_caja'
  | 'comprobante_caja'

export interface MobilityRowCoords {
  lat: number
  lng: number
}

export interface MobilityRow {
  fecha: string
  concepto: string
  total: number
  clienteProveedor: string
  origen: string
  origenCoords?: MobilityRowCoords
  destino: string
  destinoCoords?: MobilityRowCoords
  distanciaKm?: number
  gestion: string
}

export interface ExpenseReviewHistory {
  action: 'approved' | 'rejected'
  reviewerId?: string
  reviewedAt: Date
  reason?: string
}

export interface ExpenseDocument extends Document {
  proyectId: Types.ObjectId
  total: number
  description: string
  categoryId: Types.ObjectId
  file?: string
  data: string
  status?: ExpenseStatus
  statusDate?: Date
  approvedBy?: string
  rejectedBy?: string
  rejectionReason?: string
  clientId: string
  fechaEmision?: string
  observado?: boolean
  observacionPlazo?: string
  diasRetraso?: number
  categoryLimitPercent?: number
  categoryLimitWarning?: string
  expenseReportId?: Types.ObjectId
  expenseType?: ExpenseType
  mobilityRows?: MobilityRow[]
  declaracionJurada?: boolean
  declaracionJuradaFirmante?: string
  reviewHistory?: ExpenseReviewHistory[]
  internalCode?: string
}

export interface GetExpenseDocument extends Omit<ExpenseDocument, '_id'> {
  _id: string
}

@Schema({ timestamps: true })
export class Expense {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Project' })
  proyectId: Types.ObjectId

  @Prop()
  total: number

  @Prop()
  description: string

  @Prop({ required: true, type: Types.ObjectId, ref: 'Category' })
  categoryId: Types.ObjectId

  @Prop({ required: false })
  file?: string

  @Prop()
  data: string

  @Prop({ default: 'pending' })
  status: ExpenseStatus

  @Prop()
  statusDate: Date

  @Prop()
  approvedBy: string

  @Prop()
  rejectedBy: string

  @Prop()
  rejectionReason: string

  @Prop()
  createdBy: string

  @Prop({ type: 'ObjectId', ref: 'Client', required: true })
  clientId: string

  @Prop({ type: String, required: false })
  fechaEmision?: string

  @Prop({ type: Boolean, default: false })
  observado?: boolean

  @Prop({ type: String, required: false })
  observacionPlazo?: string

  @Prop({ type: Number, required: false })
  diasRetraso?: number

  @Prop({ type: Number, required: false })
  categoryLimitPercent?: number

  @Prop({ type: String, required: false })
  categoryLimitWarning?: string

  @Prop({
    type: [
      {
        action: { type: String, enum: ['approved', 'rejected'], required: true },
        reviewerId: { type: String, required: false },
        reviewedAt: { type: Date, required: true },
        reason: { type: String, required: false },
        _id: false,
      },
    ],
    default: [],
  })
  reviewHistory?: ExpenseReviewHistory[]

  @Prop({ type: String, required: false })
  internalCode?: string

  @Prop({ type: Types.ObjectId, ref: 'ExpenseReport', required: false })
  expenseReportId?: Types.ObjectId

  @Prop({
    type: String,
    default: 'factura',
    enum: [
      'factura',
      'planilla_movilidad',
      'otros_gastos',
      'recibo_caja',
      'comprobante_caja',
    ],
  })
  expenseType?: ExpenseType

  @Prop({
    type: [
      {
        fecha: { type: String },
        concepto: { type: String },
        total: { type: Number },
        clienteProveedor: { type: String },
        origen: { type: String },
        origenCoords: {
          lat: { type: Number },
          lng: { type: Number },
        },
        destino: { type: String },
        destinoCoords: {
          lat: { type: Number },
          lng: { type: Number },
        },
        distanciaKm: { type: Number },
        gestion: { type: String },
      },
    ],
    required: false,
    default: undefined,
  })
  mobilityRows?: MobilityRow[]

  @Prop({ type: Boolean, required: false })
  declaracionJurada?: boolean

  @Prop({ type: String, required: false })
  declaracionJuradaFirmante?: string
}

export const ExpenseSchema = SchemaFactory.createForClass(Expense)
