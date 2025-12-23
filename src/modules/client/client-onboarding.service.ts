import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ClientService } from './client.service'
import { UserService } from '../user/user.service'
import { EmailService } from '../email/email.service'
import { RoleService } from '../role/role.service'
import { CreateClientWithUserDto } from './dto/create-client-with-user-sunat.dto'
import { InjectConnection } from '@nestjs/mongoose'
import { ClientSession, Connection } from 'mongoose'
import { ROLES } from '../auth/enums/roles.enum'

@Injectable()
export class ClientOnboardingService {
  private readonly logger = new Logger(ClientOnboardingService.name)

  constructor(
    private readonly clientService: ClientService,
    private readonly userService: UserService,
    private readonly emailService: EmailService,
    private readonly roleService: RoleService,
    @InjectConnection() private readonly connection: Connection
  ) {}

  private generateTemporaryPassword(length: number = 10): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let password = ''
    for (let i = 0; i < length; i++) {
      const index = Math.floor(Math.random() * chars.length)
      password += chars.charAt(index)
    }
    return password
  }

  private splitName(fullName: string): { firstName: string; lastName: string } {
    const parts = fullName.trim().split(' ')
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: '' }
    }
    const [firstName, ...rest] = parts
    return { firstName, lastName: rest.join(' ') }
  }

  async registerClientWithUser(payload: CreateClientWithUserDto) {
    const { client, adminUser } = payload

    this.logger.debug(
      `Iniciando registro de nuevo cliente con usuario: ${client.comercialName}`
    )

    let session: ClientSession | null = null
    let createdClient: any
    let user: any
    const temporaryPassword = this.generateTemporaryPassword()

    // Buscar el rol ADMIN automáticamente
    const adminRole = await this.roleService.getByName(ROLES.ADMIN)
    if (!adminRole) {
      throw new NotFoundException(
        `No se encontró el rol ${ROLES.ADMIN} en el sistema`
      )
    }

    try {
      session = await this.connection.startSession()
      session.startTransaction()

      // 1. Crear cliente
      createdClient = await this.clientService.create(client, session)

      // 2. Crear usuario administrador con password temporal y rol ADMIN
      user = await this.userService.create({
        name: adminUser.name,
        email: adminUser.email,
        password: temporaryPassword,
        roleId: adminRole._id.toString(),
        clientId: createdClient._id.toString(),
        isActive: false,
      })

      await session.commitTransaction()
    } catch (error) {
      if (session) {
        await session.abortTransaction()
      }
      this.logger.error(
        'Error durante la transacción de registro de cliente con usuario:',
        error
      )
      throw error
    } finally {
      if (session) {
        session.endSession()
      }
    }

    // 3. Enviar correo de bienvenida con credenciales temporales (fuera de la transacción)
    try {
      const { firstName, lastName } = this.splitName(adminUser.name)
      await this.emailService.sendProviderWelcomeEmail(adminUser.email, {
        firstName,
        lastName,
        password: temporaryPassword,
        loginUrl: 'http://app.viatika.tecdidata.com/login',
      })
    } catch (error) {
      this.logger.error(
        `Error al enviar correo de bienvenida al usuario administrador ${adminUser.email}:`,
        error
      )
      // No lanzamos el error para no afectar el flujo principal de creación
    }

    return {
      message: 'Cliente registrado correctamente con usuario',
      client: createdClient,
      adminUser: {
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
      },
    }
  }
}


