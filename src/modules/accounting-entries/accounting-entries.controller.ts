import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { AccountingEntriesService } from './accounting-entries.service'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { ROLES } from '../auth/enums/roles.enum'
import { Roles } from '../auth/decorators/roles.decorador'
import { AuditLogService } from '../audit-log/audit-log.service'
import { AsientoTipo } from './entities/accounting-entries.types'

const ALL_TIPOS: AsientoTipo[] = [
  'solicitud',
  'compra',
  'aplicacion',
  'devolucion',
  'reembolso',
]

@Controller('accounting-entries')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(ROLES.CONTABILIDAD, ROLES.SUPER_ADMIN)
export class AccountingEntriesController {
  private readonly logger = new Logger(AccountingEntriesController.name)

  constructor(
    private readonly service: AccountingEntriesService,
    private readonly auditLogService: AuditLogService
  ) {}

  /**
   * Estado actual de los asientos de una rendición (con URL firmada de S3 si
   * ya hay un archivo listo). No dispara generación: solo lectura, se usa
   * tanto al entrar al detalle como para el polling mientras se genera.
   */
  @Get(':reportId')
  async status(
    @Param('reportId') reportId: string,
    @Query('tipos') tipos: string | undefined,
    @Request() req: any
  ) {
    try {
      const clientId = this.resolveClientId(req)
      const files = await this.service.getStatus(
        reportId,
        clientId,
        this.parseTipos(tipos)
      )
      return { files }
    } catch (error) {
      this.handleError(error, 'Error al consultar los asientos contables')
    }
  }

  /**
   * Dispara la generación en segundo plano de los tipos indicados (o de
   * todos los aplicables) y responde de inmediato con el estado resultante.
   * `force=true` fuerza la regeneración aunque el archivo ya esté al día.
   */
  @Post(':reportId/generate')
  async generate(
    @Param('reportId') reportId: string,
    @Query('tipos') tipos: string | undefined,
    @Query('force') force: string | undefined,
    @Request() req: any
  ) {
    try {
      const clientId = this.resolveClientId(req)
      const userId = req.user?._id || req.user?.sub
      const files = await this.service.triggerGeneration(
        reportId,
        clientId,
        this.parseTipos(tipos),
        userId,
        force === 'true'
      )

      this.auditLogService.log({
        userId,
        userName: req.user.name || req.user.email,
        action: 'generate_accounting_entries',
        module: 'facturas',
        entityId: reportId,
        details: `Asientos solicitados: ${files.map(f => f.tipo).join(', ')}`,
        clientId,
      })

      return { files }
    } catch (error) {
      this.handleError(error, 'Error al generar los asientos contables')
    }
  }

  private resolveClientId(req: any): string {
    const clientId = req.user?.clientId
    if (!clientId) {
      throw new HttpException(
        'No se pudo determinar la empresa del usuario',
        HttpStatus.BAD_REQUEST
      )
    }
    return clientId
  }

  private parseTipos(tipos: string | undefined): AsientoTipo[] {
    const tipoList = (
      tipos ? tipos.split(',').map(t => t.trim()) : ALL_TIPOS
    ).filter((t): t is AsientoTipo => (ALL_TIPOS as string[]).includes(t))
    return tipoList.length ? tipoList : ALL_TIPOS
  }

  private handleError(error: any, fallbackMessage: string): never {
    this.logger.error(`${fallbackMessage}: ${error.message}`, error.stack)
    throw new HttpException(
      error.message || fallbackMessage,
      error.status || HttpStatus.INTERNAL_SERVER_ERROR
    )
  }
}
