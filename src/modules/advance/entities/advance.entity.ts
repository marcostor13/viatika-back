import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

export type AdvanceStatus =
  | 'draft'
  | 'pending_l1'
  | 'pending_l2'
  | 'approved'
  | 'paid'
  | 'settled'
  | 'rejected'
  | 'returned'

export interface ApprovalEntry {
  level: number
  approvedBy: string
  action: 'approved' | 'rejected'
  notes?: string
  date: Date
}

export interface PaymentInfo {
  method: 'transferencia_bancaria' | 'efectivo' | 'cheque'
  bankName?: string
  accountNumber?: string
  cci?: string
  transferDate: Date
  reference?: string
}

export interface AdvanceDocument extends Document {
  userId: Types.ObjectId
  clientId: Types.ObjectId
  expenseReportId?: Types.ObjectId
  amount: number
  description: string
  status: AdvanceStatus
  approvalLevel: number
  requiredLevels: number
  approvalHistory: ApprovalEntry[]
  paymentInfo?: PaymentInfo
  settlement?: {
    expenseTotal: number
    advanceAmount: number
    difference: number
    type: 'reembolso' | 'devolucion' | 'equilibrado'
    settledAt: Date
  }
  rejectedBy?: string
  rejectionReason?: string
  returnedAmount?: number
}

// Umbrales de aprobación multinivel
export const ADVANCE_THRESHOLDS = {
  L1_MAX: 500,   // Hasta S/. 500: solo nivel 1 (Admin)
  // Más de S/. 500: nivel 1 + nivel 2 (Tesorero/SuperAdmin)
}

@Schema({ timestamps: true })
export class Advance {
  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  userId: Types.ObjectId

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId

  @Prop({ type: Types.ObjectId, ref: 'ExpenseReport', required: false })
  expenseReportId?: Types.ObjectId

  @Prop({ required: true, min: 0 })
  amount: number

  @Prop({ required: true })
  description: string

  @Prop({ type: String, default: 'pending_l1', enum: ['draft', 'pending_l1', 'pending_l2', 'approved', 'paid', 'settled', 'rejected', 'returned'] })
  status: AdvanceStatus

  @Prop({ default: 1 })
  approvalLevel: number

  @Prop({ default: 1 })
  requiredLevels: number

  @Prop({
    type: [{
      level: { type: Number },
      approvedBy: { type: String },
      action: { type: String, enum: ['approved', 'rejected'] },
      notes: { type: String },
      date: { type: Date },
    }],
    default: [],
  })
  approvalHistory: ApprovalEntry[]

  @Prop({
    type: {
      method: { type: String, enum: ['transferencia_bancaria', 'efectivo', 'cheque'] },
      bankName: { type: String },
      accountNumber: { type: String },
      cci: { type: String },
      transferDate: { type: Date },
      reference: { type: String },
      _id: false,
    },
  })
  paymentInfo?: PaymentInfo

  @Prop({
    type: {
      expenseTotal: { type: Number },
      advanceAmount: { type: Number },
      difference: { type: Number },
      type: { type: String, enum: ['reembolso', 'devolucion', 'equilibrado'] },
      settledAt: { type: Date },
      _id: false,
    },
  })
  settlement?: {
    expenseTotal: number
    advanceAmount: number
    difference: number
    type: 'reembolso' | 'devolucion' | 'equilibrado'
    settledAt: Date
  }

  @Prop({ type: String, required: false })
  rejectedBy?: string

  @Prop({ type: String, required: false })
  rejectionReason?: string

  @Prop({ type: Number, required: false })
  returnedAmount?: number
}

export const AdvanceSchema = SchemaFactory.createForClass(Advance)
