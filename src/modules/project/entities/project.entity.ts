import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document, Types } from 'mongoose'
import { GetClientDocument } from '../../client/entities/client.entity'

export interface ProjectDocument extends Document {
  name: string
  clientId: Types.ObjectId
}

export interface GetProjectDocument {
  name: string
  client: GetClientDocument
  _id: string
  createdAt: Date
  updatedAt: Date
}

@Schema({ timestamps: true })
export class Project {
  @Prop({ required: true })
  name: string

  @Prop({ required: true, type: Types.ObjectId, ref: 'Client' })
  clientId: Types.ObjectId
}

export const ProjectSchema = SchemaFactory.createForClass(Project)
