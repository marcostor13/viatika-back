import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

export type ExpenseReportStatus =
  | 'solicited'
  | 'open'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'closed'
export type SettlementType = 'reembolso' | 'devolucion' | 'equilibrado'

export interface Settlement {
  advanceTotal: number
  expenseTotal: number
  difference: number
  type: SettlementType
  settledAt: Date
}

export interface ExpenseReportBudgetItem {
  description: string
  amount: number
  peopleCount: number
  fuelAmount: number
  daysCount: number
  total: number
}

export interface ExpenseReportAffidavit {
  type: 'viaticos_nacionales' | 'viajes_exterior'
  expenseIds: Types.ObjectId[]
  generatedBy: Types.ObjectId
  generatedAt: Date
}

export interface ExpenseReportDocument extends Document {
  title: string
  description: string
  budget: number
  userId: Types.ObjectId
  clientId: Types.ObjectId
  status: ExpenseReportStatus
  rejectionReason?: string
  expenseIds: Types.ObjectId[]
  advanceIds?: Types.ObjectId[]
  settlement?: Settlement
  createdBy: Types.ObjectId
  approvedBy?: Types.ObjectId
  projectId?: Types.ObjectId
  // New fields
  accountNumber?: string
  idDocument?: string
  peopleNames?: string[]
  location?: string
  startDate?: Date
  endDate?: Date
  items?: ExpenseReportBudgetItem[]
  affidavits?: ExpenseReportAffidavit[]
}

@Schema({ timestamps: true })
export class ExpenseReport {
  @Prop({ required: true })
  title: string

  @Prop()
  description: string

  @Prop({ required: true, default: 0 })
  budget: number

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  userId: Types.ObjectId

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId

  @Prop({ default: 'open' })
  status: ExpenseReportStatus

  /** Motivo cuando el administrador rechaza la rendición (visible para el colaborador) */
  @Prop({ required: false })
  rejectionReason?: string

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Expense' }], default: [] })
  expenseIds: Types.ObjectId[]

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: 'User', required: false })
  approvedBy?: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: 'Project', required: false })
  projectId?: Types.ObjectId

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Advance' }], default: [] })
  advanceIds?: Types.ObjectId[]

  @Prop({
    type: {
      advanceTotal: { type: Number },
      expenseTotal: { type: Number },
      difference: { type: Number },
      type: { type: String, enum: ['reembolso', 'devolucion', 'equilibrado'] },
      settledAt: { type: Date },
      _id: false,
    },
  })
  settlement?: Settlement

  @Prop()
  accountNumber?: string

  @Prop()
  idDocument?: string

  @Prop({ type: [String], default: [] })
  peopleNames?: string[]

  @Prop()
  location?: string

  @Prop()
  startDate?: Date

  @Prop()
  endDate?: Date

  @Prop({
    type: [
      {
        description: { type: String },
        amount: { type: Number },
        peopleCount: { type: Number },
        fuelAmount: { type: Number },
        daysCount: { type: Number },
        total: { type: Number },
        _id: false,
      },
    ],
    default: [],
  })
  items?: ExpenseReportBudgetItem[]

  @Prop({
    type: [
      {
        type: {
          type: String,
          enum: ['viaticos_nacionales', 'viajes_exterior'],
          required: true,
        },
        expenseIds: [{ type: Types.ObjectId, ref: 'Expense', required: true }],
        generatedBy: { type: Types.ObjectId, ref: 'User', required: true },
        generatedAt: { type: Date, required: true },
        _id: false,
      },
    ],
    default: [],
  })
  affidavits?: ExpenseReportAffidavit[]
}

export const ExpenseReportSchema = SchemaFactory.createForClass(ExpenseReport)
