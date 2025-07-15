import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export interface UserDocument extends Document {
    _id: Types.ObjectId;
    email: string;
    name: string;
    password: string;
    clientId: Types.ObjectId;
    roleId: Types.ObjectId;
    isActive: boolean;
}

@Schema({ timestamps: true })
export class User {
    @Prop({ required: true, unique: true })
    email: string;

    @Prop({ required: true })
    name: string;

    @Prop({ required: true })
    password: string;

    @Prop({ ref: 'Client', alias: 'client' })
    clientId: Types.ObjectId;

    @Prop({ required: true, ref: 'Role', alias: 'role' })
    roleId: Types.ObjectId;

    @Prop({ default: true })
    isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
