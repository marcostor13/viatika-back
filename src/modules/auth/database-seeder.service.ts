import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { RoleService } from '../role/role.service';
import { UserService } from '../user/user.service';
import { ROLES } from './enums/roles.enum';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class DatabaseSeederService implements OnApplicationBootstrap {
    private readonly logger = new Logger(DatabaseSeederService.name);

    constructor(
        private readonly roleService: RoleService,
        private readonly userService: UserService,
    ) { }

    async onApplicationBootstrap() {
        await this.seedRoles();
        await this.seedSuperAdmin();
    }

    private async seedRoles() {
        const existingRoles = await this.roleService.findAll();
        if (existingRoles.length === 0) {
            this.logger.log('Seeding roles...');
            const rolesToCreate = Object.values(ROLES);
            for (const roleName of rolesToCreate) {
                await this.roleService.create({ name: roleName });
            }
            this.logger.log('Roles seeded successfully.');
        }
    }

    private async seedSuperAdmin() {
        const superAdminRole = await this.roleService.getByName(ROLES.SUPER_ADMIN);
        if (!superAdminRole) {
            this.logger.error('SuperAdmin role not found. Skipping SuperAdmin seeding.');
            return;
        }

        const users = await this.userService.findAllWithClient();
        const hasSuperAdmin = users.some(u => u.role.name === ROLES.SUPER_ADMIN);

        if (!hasSuperAdmin) {
            this.logger.log('Seeding default SuperAdmin...');
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await this.userService.create({
                email: 'admin@viatika.com',
                password: 'admin123', // userService.create hashes it again, but wait, looking at user.service:88 it hashes it.
                // Let's check user.service.ts:88
                name: 'Super Administrator',
                roleId: (superAdminRole as any)._id.toString(),
                clientId: '', // No client for SuperAdmin
            });
            this.logger.log('Default SuperAdmin seeded: admin@viatika.com / admin123');
        }
    }
}
