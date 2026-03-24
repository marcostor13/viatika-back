import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

export type AuditAction =
  | 'login'
  | 'create_invoice'
  | 'approve_invoice'
  | 'reject_invoice'
  | 'delete_invoice'
  | 'create_mobility_sheet'
  | 'create_other_expense'
  | 'create_rendicion'
  | 'delete_rendicion'
  | 'update_rendicion_status'
  | 'approve_advance_l1'
  | 'approve_advance_l2'
  | 'reject_advance'
  | 'pay_advance'
  | 'settle_advance'
  | 'create_user'
  | 'update_user'
  | 'update_permissions'
  | 'update_signature';

@Schema({ timestamps: true })
export class AuditLog {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  userName: string;

  @Prop({ required: true })
  action: AuditAction;

  @Prop({ required: true })
  module: string;

  @Prop()
  entityId?: string;

  @Prop()
  details?: string;

  @Prop()
  clientId?: string;

  @Prop()
  ip?: string;

  createdAt: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
