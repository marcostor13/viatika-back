import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorador';
import { ROLES } from '../auth/enums/roles.enum';
import { AuditLogService } from './audit-log.service';

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
@Controller('audit-log')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  findAll(@Request() req: any, @Query('limit') limit?: string) {
    const clientId = req.user.clientId;
    const parsedLimit = limit ? parseInt(limit, 10) : 200;
    return this.auditLogService.findAll(clientId, parsedLimit);
  }
}
