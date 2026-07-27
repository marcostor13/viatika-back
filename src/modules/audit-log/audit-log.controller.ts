import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard } from '../auth/guards/roles.guard'
import { Roles } from '../auth/decorators/roles.decorador'
import { ROLES } from '../auth/enums/roles.enum'
import { AuditLogService } from './audit-log.service'
import { ReportExportFailureDto } from './dto/report-export-failure.dto'

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.CONTABILIDAD)
  findAll(
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('module') module?: string,
    @Query('search') search?: string
  ) {
    const clientId = req.user.clientId
    return this.auditLogService.findAll(clientId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      module,
      search,
    })
  }

  /**
   * Registra que el "PDF completo" no pudo incrustar el archivo de uno o más
   * comprobantes. Lo llama el propio colaborador desde su navegador, así que no
   * lleva restricción de rol: la acción y el módulo los fija el servidor y del
   * cuerpo solo se toman los datos del diagnóstico.
   */
  @Post('export-failure')
  // La app no tiene ValidationPipe global: se aplica aquí para que un cuerpo
  // malformado devuelva 400 y no reviente con un 500.
  @UsePipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })
  )
  async reportExportFailure(
    @Request() req: any,
    @Body() dto: ReportExportFailureDto
  ) {
    const detalle = dto.attachments
      .map(a => `${a.label}: ${a.reason} [${a.url}]`)
      .join(' | ')
    const userAgent = String(req.headers?.['user-agent'] ?? '').slice(0, 300)
    await this.auditLogService.log({
      userId: String(req.user._id ?? req.user.sub ?? ''),
      userName: String(req.user.name ?? req.user.email ?? 'Desconocido'),
      action: 'export_pdf_attachment_failed',
      module: 'rendiciones',
      entityId: dto.reportId,
      details:
        `PDF completo de ${dto.reportCode || dto.reportId}: ` +
        `${dto.attachments.length} adjunto(s) no se pudieron descargar. ` +
        `${detalle} || Navegador: ${userAgent}`,
      clientId: req.user.clientId,
      ip: req.ip,
    })
    return { registered: dto.attachments.length }
  }
}
