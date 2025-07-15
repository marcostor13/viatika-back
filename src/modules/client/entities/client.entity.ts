import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export interface ClientDocument extends Document {
    comercialName: string;
    businessName: string;
    businessId: string; //ruc
    address: string;
    phone: string;
    email: string;
    logo: string;
}

export interface GetClientDocument extends ClientDocument {
    _id: Types.ObjectId;
}

@Schema({ timestamps: true })
export class Client {
    @Prop({ required: true })
    comercialName: string;

    @Prop({ required: true })
    businessName: string;

    @Prop({ required: true })
    businessId: string; //ruc

    @Prop({ required: true })
    address: string;

    @Prop({ required: true })
    phone: string;

    @Prop({ required: true })
    email: string;

    @Prop()
    logo: string;
}

export const ClientSchema = SchemaFactory.createForClass(Client);
