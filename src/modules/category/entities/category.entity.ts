import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'
import { ClientDocument } from '../../client/entities/client.entity'

export interface CategoryDocument extends Document {
  name: string
  description?: string
  isActive: boolean
  clientId: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface GetCategoryDocument extends CategoryDocument {
  _id: string
  client: ClientDocument
}

@Schema({ timestamps: true })
export class Category {
  @Prop({ required: true })
  name: string

  @Prop({ required: true, unique: true })
  key: string

  @Prop()
  description?: string

  @Prop({ default: true })
  isActive: boolean

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId
}

export const CategorySchema = SchemaFactory.createForClass(Category)

CategorySchema.index({ key: 1, companyId: 1 }, { unique: true })
