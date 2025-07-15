import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { Document } from 'mongoose'
import { GetClientDocument } from '../../client/entities/client.entity'

export interface ProjectDocument extends Document {
    name: string
    clientId: string
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

    @Prop({ required: true })
    clientId: string

}

export const ProjectSchema = SchemaFactory.createForClass(Project)