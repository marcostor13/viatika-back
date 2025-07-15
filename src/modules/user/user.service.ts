import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { User, UserDocument } from './schemas/user.schema';
import { Model, Types } from 'mongoose';
import { UpdateUserDto } from './dto/update-user.dto';
import { ClientDocument } from '../client/entities/client.entity';
import { RoleDocument } from '../role/entities/role.entity';
import * as bcrypt from 'bcryptjs';
import { CreateUserDto } from './dto/create-user.dto';

export interface IUser {
    email: string;
    name: string;
    password: string;
    roleId: Types.ObjectId;
    clientId?: Types.ObjectId;
    isActive?: boolean;
}


export interface IUserResponse {
    _id: Types.ObjectId;
    email: string;
    name: string;
    role: RoleDocument;
    client: ClientDocument;
    password?: string;
    isActive: boolean;
}

@Injectable()
export class UserService {

    constructor(
        @InjectModel(User.name) private userModel: Model<UserDocument>
    ) { }
    async findByEmail(email: string): Promise<IUserResponse | null> {
        const user = await this.userModel.findOne({ email }).populate('roleId').populate('clientId').exec();
        if (!user) {
            return null;
        }
        return {
            _id: user._id,
            email: user.email,
            name: user.name,
            role: user.roleId as unknown as RoleDocument,
            client: user.clientId as unknown as ClientDocument,
            password: user.password,
            isActive: user.isActive,
        }
    }

    async findOne(id: string): Promise<IUserResponse> {
        const user = await this.userModel.findById(id).populate('roleId').populate('clientId').exec();
        if (!user) {
            return {} as IUserResponse;
        }
        return {
            _id: user._id,
            email: user.email,
            name: user.name,
            role: user.roleId as unknown as RoleDocument,
            client: user.clientId as unknown as ClientDocument,
            isActive: user.isActive,
        }
    }

    async create(userData: CreateUserDto): Promise<IUserResponse> {
        const clientId = new Types.ObjectId(userData.clientId);
        const roleId = new Types.ObjectId(userData.roleId);

        const issetUser = await this.userModel.findOne({ email: userData.email });
        if (issetUser) {
            throw new BadRequestException('El correo ya se encuentra registrado');
        }
        const hashedPassword = await bcrypt.hash(userData.password, 10);
        const savedUser = await this.userModel.create({ ...userData, roleId, clientId, password: hashedPassword });
        const populatedUser = await this.userModel.findById(savedUser._id).populate('roleId').populate('clientId').exec();
        if (!populatedUser) {
            return {} as IUserResponse;
        }
        return {
            _id: populatedUser._id,
            email: populatedUser.email,
            name: populatedUser.name,
            role: populatedUser.roleId as unknown as RoleDocument,
            client: populatedUser.clientId as unknown as ClientDocument,
            isActive: populatedUser.isActive,
        }
    }

    async findAll(clientId: Types.ObjectId) {
        const users = await this.userModel.find({ clientId }).populate('roleId').populate('clientId').exec();
        return users.map(user =>
        ({
            _id: user._id,
            email: user.email,
            name: user.name,
            role: user.roleId,
            client: user.clientId,
            isActive: user.isActive,
        })
        );
    }

    update(id: string, updateUserDto: UpdateUserDto) {
        return this.userModel.findByIdAndUpdate(id, updateUserDto, { new: true }).populate('roleId').populate('clientId').exec();
    }

    delete(id: string) {
        return this.userModel.findByIdAndDelete(id).exec();
    }

}
