import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Request, Query } from '@nestjs/common';
import { ExpenseReportService } from './expense-report.service';
import { CreateExpenseReportDto } from './dto/create-expense-report.dto';
import { UpdateExpenseReportDto } from './dto/update-expense-report.dto';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorador';
import { ROLES } from '../auth/enums/roles.enum';
import { AuditLogService } from '../audit-log/audit-log.service';

@Controller('expense-report')
export class ExpenseReportController {
  constructor(
    private readonly expenseReportService: ExpenseReportService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  @Post()
  async create(@Body() createExpenseReportDto: CreateExpenseReportDto, @Request() req: any) {
    const createdBy = req.user._id;
    const isCollaborator = req.user.roles?.includes(ROLES.COLABORADOR);
    const result = await this.expenseReportService.create(createExpenseReportDto, createdBy, isCollaborator);
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email || 'Usuario',
      action: 'create_rendicion',
      module: 'rendiciones',
      entityId: result?._id?.toString(),
      details: createExpenseReportDto.title,
      clientId: req.user.clientId,
    });
    return result;
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('client/:clientId')
  findAllByClient(@Param('clientId') clientId: string, @Request() req: any) {
    // If admin/superadmin, get all for client. 
    // If user, get only theirs.
    const isUser = req.user.roles[0] === ROLES.COLABORADOR;
    if (isUser) {
      return this.expenseReportService.findAllByUser(req.user._id, clientId);
    }
    return this.expenseReportService.findAllByClient(clientId);
  }
  
  @UseGuards(AuthGuard('jwt'))
  @Get('user/:userId/client/:clientId')
  findAllByUser(@Param('userId') userId: string, @Param('clientId') clientId: string) {
     return this.expenseReportService.findAllByUser(userId, clientId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.expenseReportService.findOne(id);
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN, ROLES.COLABORADOR)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() updateExpenseReportDto: UpdateExpenseReportDto, @Request() req: any) {
    // Si se aprueba la solicitud o la rendición, guardar quién aprobó
    if (updateExpenseReportDto.status === 'open' || updateExpenseReportDto.status === 'approved') {
      await this.expenseReportService.setApprovedBy(id, req.user._id);
    }
    const result = await this.expenseReportService.update(id, updateExpenseReportDto);
    if (updateExpenseReportDto.status) {
      this.auditLogService.log({
        userId: req.user._id || req.user.sub,
        userName: req.user.name || req.user.email || 'Usuario',
        action: 'update_rendicion_status',
        module: 'rendiciones',
        entityId: id,
        details: updateExpenseReportDto.status,
        clientId: req.user.clientId,
      });
    }
    return result;
  }

  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(ROLES.ADMIN, ROLES.SUPER_ADMIN)
  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req: any) {
    const result = await this.expenseReportService.remove(id);
    this.auditLogService.log({
      userId: req.user._id || req.user.sub,
      userName: req.user.name || req.user.email || 'Usuario',
      action: 'delete_rendicion',
      module: 'rendiciones',
      entityId: id,
      clientId: req.user.clientId,
    });
    return result;
  }
}
