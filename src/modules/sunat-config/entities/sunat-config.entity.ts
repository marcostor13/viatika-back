import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'

export interface SunatConfigDocument extends Document {
  clientId: Types.ObjectId
  clientIdSunat: string
  clientSecret: string
  isActive: boolean
}

@Schema({ timestamps: true })
export class SunatConfig {
  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, unique: true })
  clientId: Types.ObjectId

  @Prop({ required: true })
  clientIdSunat: string

  @Prop({ required: true })
  clientSecret: string

  @Prop({ default: true })
  isActive: boolean
}

export const SunatConfigSchema = SchemaFactory.createForClass(SunatConfig)
