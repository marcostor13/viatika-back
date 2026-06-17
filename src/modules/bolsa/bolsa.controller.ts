import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Request,
  UseGuards,
} from '@nestjs/common'
import { WalletEntryType } from './entities/wallet-entry.entity'
import { BolsaService } from './bolsa.service'
import { CreateWalletEntryDto } from './dto/create-wallet-entry.dto'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { AuditLogService } from '../audit-log/audit-log.service'

@Controller('bolsa')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BolsaController {
  constructor(
    private readonly service: BolsaService,
    private readonly auditLogService: AuditLogService
  ) {}

  /** Bolsa del colaborador autenticado. */
  @Get('my/client/:clientId')
  @Roles(
    ROLES.COLABORADOR,
    ROLES.COORDINADOR,
    ROLES.CONTABILIDAD,
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN
  )
  findMine(@Param('clientId') clientId: string, @Request() req: any) {
    const userId = req.user._id || req.user.sub
    return this.service.findByUser(String(userId), clientId)
  }

  /** Bolsa de un colaborador específico (Contabilidad / Admin / Coordinador). */
  @Get('user/:userId/client/:clientId')
  @Roles(ROLES.CONTABILIDAD, ROLES.COORDINADOR, ROLES.ADMIN, ROLES.SUPER_ADMIN)
  findByUser(
    @Param('userId') userId: string,
    @Param('clientId') clientId: string
  ) {
    return this.service.findByUser(userId, clientId)
  }

  /** Carga manual de un saldo previo (marcha blanca / BOLSA-11). */
  @Post('manual')
  @Roles(ROLES.CONTABILIDAD, ROLES.ADMIN, ROLES.SUPER_ADMIN)
  async createManual(@Body() dto: CreateWalletEntryDto, @Request() req: any) {
    const clientId = dto.clientId || req.user?.clientId
    const createdBy = req.user._id || req.user.sub
    const result = await this.service.createManual(
      dto,
      String(clientId),
      String(createdBy)
    )
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email,
      action: 'create_wallet_entry_manual',
      module: 'bolsa',
      entityId: String(result._id),
      clientId: req.user.clientId,
    })
    return result
  }

  /** Saldos consumibles del colaborador autenticado para un destino (BOLSA-3). */
  @Get('available/my/client/:clientId')
  @Roles(
    ROLES.COLABORADOR,
    ROLES.COORDINADOR,
    ROLES.CONTABILIDAD,
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN
  )
  getMyConsumable(
    @Param('clientId') clientId: string,
    @Query('targetType') targetType: WalletEntryType,
    @Query('projectId') projectId: string | undefined,
    @Request() req: any
  ) {
    const userId = req.user._id || req.user.sub
    return this.service.getConsumableEntries(String(userId), clientId, {
      targetType: targetType || 'directa',
      projectId,
    })
  }

  /** Detalle de un saldo de la Bolsa. */
  @Get(':id')
  @Roles(
    ROLES.COLABORADOR,
    ROLES.COORDINADOR,
    ROLES.CONTABILIDAD,
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN
  )
  findOne(@Param('id') id: string) {
    return this.service.findOne(id)
  }
}
