import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export interface BankAccount {
    bankName: string;
    accountNumber: string;
    cci: string;
    accountType: 'ahorros' | 'corriente';
}

export interface UserPermissions {
    modules: string[];
    canApproveL1: boolean;
    canApproveL2: boolean;
}

export interface UserDocument extends Document {
    _id: Types.ObjectId;
    email: string;
    name: string;
    password: string;
    clientId: Types.ObjectId;
    roleId: Types.ObjectId;
    isActive: boolean;
    dni?: string;
    employeeCode?: string;
    address?: string;
    phone?: string;
    bankAccount?: BankAccount;
    permissions?: UserPermissions;
    signature?: string;
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

    @Prop()
    dni?: string;

    @Prop()
    employeeCode?: string;

    @Prop()
    address?: string;

    @Prop()
    phone?: string;

    @Prop({
        type: {
            bankName: { type: String },
            accountNumber: { type: String },
            cci: { type: String },
            accountType: { type: String, enum: ['ahorros', 'corriente'] },
            _id: false,
        },
    })
    bankAccount?: BankAccount;

    @Prop({
        type: {
            modules: { type: [String], default: [] },
            canApproveL1: { type: Boolean, default: false },
            canApproveL2: { type: Boolean, default: false },
            _id: false,
        },
        default: () => ({ modules: [], canApproveL1: false, canApproveL2: false }),
    })
    permissions: UserPermissions;

    @Prop()
    signature?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
