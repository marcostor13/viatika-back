import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

export type DirectReimbursementStatus =
  | 'open'
  | 'expenses_loaded'
  | 'coordinator_approved'
  | 'accounting_approved'
  | 'paid'
  | 'closed'
  | 'rejected'

export interface DirectReimbursementPaymentInfo {
  transferDate: Date
  amount: number
  operationNumber: string
  receiptUrl: string
  receiptFileName?: string
  paidBy: string
  paidAt: Date
}

export interface DirectReimbursementDocument extends Document {
  code: string
  collaboratorId: Types.ObjectId
  coordinatorId: Types.ObjectId
  clientId: Types.ObjectId
  status: DirectReimbursementStatus
  justification: string
  estimatedAmount: number
  overrunJustification?: string
  expenseIds: Types.ObjectId[]
  paymentInfo?: DirectReimbursementPaymentInfo
  rejectionReason?: string
  approvedBy?: string
  approvedAt?: Date
  paidAt?: Date
  closedAt?: Date
  closedBy?: string
}

@Schema({ timestamps: true })
export class DirectReimbursement {
  @Prop({ required: true, unique: true })
  code: string

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  collaboratorId: Types.ObjectId

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  coordinatorId: Types.ObjectId

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId

  @Prop({ default: 'open' })
  status: DirectReimbursementStatus

  @Prop({ required: true, minlength: 100 })
  justification: string

  @Prop({ required: true, default: 0 })
  estimatedAmount: number

  @Prop({ required: false })
  overrunJustification?: string

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Expense' }], default: [] })
  expenseIds: Types.ObjectId[]

  @Prop({ type: Object, required: false })
  paymentInfo?: DirectReimbursementPaymentInfo

  @Prop({ required: false })
  rejectionReason?: string

  @Prop({ required: false })
  approvedBy?: string

  @Prop({ type: Date, required: false })
  approvedAt?: Date

  @Prop({ type: Date, required: false })
  paidAt?: Date

  @Prop({ type: Date, required: false })
  closedAt?: Date

  @Prop({ required: false })
  closedBy?: string
}

export const DirectReimbursementSchema = SchemaFactory.createForClass(DirectReimbursement)
