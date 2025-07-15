import { BadRequestException, Injectable } from '@nestjs/common';
import { IUser, UserService } from '../user/user.service';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
@Injectable()
export class AuthService {
    constructor(
        private userService: UserService,
        private jwtService: JwtService,
    ) { }

    async register(registerDto: RegisterDto): Promise<any> {
        const { email, password, name, roleId, clientId } = registerDto;
        const userExists = await this.userService.findByEmail(email);
        if (userExists) {
            throw new BadRequestException('El usuario ya existe');
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        if (clientId) {
            await this.userService.create({ email, password: hashedPassword, name, roleId, clientId });

        } else {
            await this.userService.create({ email, password: hashedPassword, name, roleId, clientId: '' });
        }
        return {
            message: 'Usuario creado correctamente',
        };
    }

    async validateUser(email: string, password: string): Promise<any> {
        const user = await this.userService.findByEmail(email);
        if (user && await bcrypt.compare(password, user.password as string)) {
            const { password, ...result } = user;
            return result;
        }
        return null;
    }

    async login(userData: IUser) {
        const user = await this.validateUser(userData.email, userData.password as string);
        if (!user) {
            throw new BadRequestException('Credenciales inválidas');
        }
        const payload = {
            email: user.email,
            userId: user._id.toString(),
            roles: [user.role.name]
        }
        console.log(payload);
        return {
            access_token: this.jwtService.sign(payload),
            ...user,
        };
    }
}