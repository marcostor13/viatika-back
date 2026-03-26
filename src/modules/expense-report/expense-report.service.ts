import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateExpenseReportDto } from './dto/create-expense-report.dto';
import { UpdateExpenseReportDto } from './dto/update-expense-report.dto';
import { ExpenseReport, ExpenseReportDocument } from './entities/expense-report.entity';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UserService } from '../user/user.service';

@Injectable()
export class ExpenseReportService {
  constructor(
    @InjectModel(ExpenseReport.name)
    private readonly expenseReportModel: Model<ExpenseReportDocument>,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
    private readonly userService: UserService
  ) {}

  async create(createExpenseReportDto: CreateExpenseReportDto, createdBy: string, isCollaborator = false) {
    const report = new this.expenseReportModel({
      ...createExpenseReportDto,
      userId: new Types.ObjectId(createExpenseReportDto.userId),
      clientId: new Types.ObjectId(createExpenseReportDto.clientId),
      createdBy: new Types.ObjectId(createdBy),
      projectId: createExpenseReportDto.projectId ? new Types.ObjectId(createExpenseReportDto.projectId) : undefined,
      status: isCollaborator ? 'solicited' : 'open',
      expenseIds: []
    });
    const savedReport = await report.save();

    console.log(`[ExpenseReportService] Created report: ${savedReport._id}. isCollaborator: ${isCollaborator}`);
    
    // Notificar a administradores si un colaborador crea una rendición
    if (isCollaborator) {
      try {
        const admins = await this.userService.findAdminsByClient(String(savedReport.clientId));
        console.log(`[ExpenseReportService] Admins found: ${admins.length} for client ${savedReport.clientId}`);
        
        const user = await this.userService.findOne(createdBy);
        const creatorName = user.name || 'Un colaborador';
        
        for (const admin of admins) {
          console.log(`[ExpenseReportService] Notifying admin: ${admin.email}`);
          await this.notificationsService.create({
            userId: String(admin._id),
            title: 'Nueva Rendición Solicitada',
            message: `${creatorName} ha creado una nueva solicitud de rendición: "${savedReport.title}"`,
            type: 'info',
            actionUrl: `/mis-rendiciones/${savedReport._id}/detalle` 
          });
        }
      } catch (error) {
        console.error('Error enviando notificaciones a administradores (create)', error);
      }
    }

    return savedReport;
  }

  async findAllByClient(clientId: string) {
    return await this.expenseReportModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('userId', 'name email signature')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findAllByUser(userId: string, clientId: string) {
    return await this.expenseReportModel
      .find({ 
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId)
      })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(id: string) {
    const report = await this.expenseReportModel
      .findById(id)
      .populate('userId', 'name email signature')
      .populate('expenseIds')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('projectId', 'name')
      .exec();
      
    if (!report) {
      throw new NotFoundException(`Expense report with ID ${id} not found`);
    }
    return report;
  }

  async update(id: string, updateExpenseReportDto: UpdateExpenseReportDto) {
    const dto = updateExpenseReportDto;
    const existing = await this.expenseReportModel.findById(id).select('status').lean().exec();
    if (!existing) {
      throw new NotFoundException(`Expense report with ID ${id} not found`);
    }

    if (dto.status === 'submitted' && existing.status !== 'open' && existing.status !== 'rejected') {
      throw new BadRequestException(
        'Solo se puede enviar una rendición en estado abierta o rechazada.',
      );
    }
    if (dto.status === 'solicited' && existing.status !== 'rejected') {
      throw new BadRequestException('Solo se puede re-enviar una solicitud en estado rechazada.');
    }
    if (dto.status === 'open' && existing.status !== 'solicited') {
      throw new BadRequestException('Solo se puede aprobar una solicitud en estado solicitada.');
    }
    if (dto.status === 'rejected' && existing.status !== 'submitted' && existing.status !== 'solicited') {
      throw new BadRequestException('Solo se pueden rechazar rendiciones enviadas o solicitadas.');
    }
    if (dto.status === 'approved' && existing.status !== 'submitted') {
      throw new BadRequestException('Solo se pueden aprobar rendiciones enviadas.');
    }

    const $set: Record<string, unknown> = {};
    const $unset: Record<string, ''> = {};

    // Solo campos definidos: evita $set con undefined y no pisa expenseIds por error
    if (dto.title !== undefined) $set.title = dto.title;
    if (dto.description !== undefined) $set.description = dto.description;
    if (dto.budget !== undefined) $set.budget = dto.budget;
    if (dto.status !== undefined) $set.status = dto.status;
    if (dto.userId !== undefined) $set.userId = new Types.ObjectId(dto.userId);
    if (dto.clientId !== undefined) $set.clientId = new Types.ObjectId(dto.clientId);
    if (dto.projectId !== undefined) {
      $set.projectId = dto.projectId
        ? new Types.ObjectId(dto.projectId)
        : null;
    }
    if (dto.expenseIds !== undefined && Array.isArray(dto.expenseIds)) {
      $set.expenseIds = dto.expenseIds.map((eId) => new Types.ObjectId(eId));
    }

    if (dto.status === 'rejected') {
      const reason =
        typeof dto.rejectionReason === 'string' ? dto.rejectionReason.trim() : '';
      if (!reason) {
        throw new BadRequestException(
          'El motivo de rechazo es obligatorio para rechazar una rendición.',
        );
      }
      $set.rejectionReason = reason;
    } else if (
      dto.rejectionReason !== undefined &&
      dto.status !== 'submitted'
    ) {
      $set.rejectionReason = dto.rejectionReason?.trim() || '';
    }

    if (dto.status === 'submitted' || dto.status === 'solicited') {
      $unset.rejectionReason = '';
    }

    const updatePayload: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) updatePayload.$set = $set;
    if (Object.keys($unset).length > 0) updatePayload.$unset = $unset;

    if (Object.keys(updatePayload).length > 0) {
      const updated = await this.expenseReportModel
        .findByIdAndUpdate(id, updatePayload, { new: true })
        .exec();
      if (!updated) {
        throw new NotFoundException(`Expense report with ID ${id} not found`);
      }
    }

    // findByIdAndUpdate no hace populate: la UI necesita expenseIds como documentos
    const fullyUpdatedReport = await this.findOne(id);

    // Si la rendición fue aprobada, enviar email y notificación
    if (dto.status === 'approved') {
      const owner = fullyUpdatedReport.userId as any;
      if (owner && owner.email) {
        try {
          await this.emailService.sendRendicionFullyApprovedEmail(owner.email, {
            userName: owner.name || 'Colaborador',
            title: fullyUpdatedReport.title,
            budget: fullyUpdatedReport.budget,
            platformUrl: `https://app.viatica.tecdidata.com/mis-rendiciones/${id}/detalle` 
          });

          await this.notificationsService.create({
            userId: String(owner._id),
            title: 'Rendición Aprobada',
            message: `Tu rendición "${fullyUpdatedReport.title}" ha sido aprobada exitosamente y pasará a contabilidad.`,
            type: 'success',
            actionUrl: `/mis-rendiciones/${id}/detalle`
          });
        } catch (error) {
          // Log pero no fallar el request de actualización
          console.error('Error enviando notificaciones de rendición aprobada', error);
        }
      }
    }

    // Si la rendición fue enviada a aprobación (submitted), notificar a los administradores
    if (dto.status === 'submitted') {
      try {
        const admins = await this.userService.findAdminsByClient(String(fullyUpdatedReport.clientId));
        const user = await this.userService.findOne(String(fullyUpdatedReport.userId));
        const creatorName = user.name || 'Un colaborador';

        console.log(`[ExpenseReportService] Status changed to submitted. Notifying ${admins.length} admins.`);

        for (const admin of admins) {
          await this.notificationsService.create({
            userId: String(admin._id),
            title: 'Rendición Enviada',
            message: `${creatorName} ha enviado la rendición "${fullyUpdatedReport.title}" para tu revisión.`,
            type: 'warning',
            actionUrl: `/mis-rendiciones/${id}/detalle`
          });
        }
      } catch (error) {
        console.error('Error enviando notificaciones a administradores (update/submitted)', error);
      }
    }

    return fullyUpdatedReport;
  }

  async remove(id: string) {
    const deleted = await this.expenseReportModel.findByIdAndDelete(id).exec();
    if (!deleted) {
      throw new NotFoundException(`Expense report with ID ${id} not found`);
    }
    return deleted;
  }

  async addExpenseToReport(reportId: string, expenseId: string) {
    return await this.expenseReportModel.findByIdAndUpdate(
      reportId,
      { $push: { expenseIds: new Types.ObjectId(expenseId) } },
      { new: true }
    ).exec();
  }

  async removeExpenseFromReport(reportId: string, expenseId: string): Promise<void> {
    await this.expenseReportModel
      .findByIdAndUpdate(reportId, {
        $pull: { expenseIds: new Types.ObjectId(expenseId) },
      })
      .exec();
  }

  async addAdvanceToReport(reportId: string, advanceId: string) {
    return await this.expenseReportModel.findByIdAndUpdate(
      reportId,
      { $addToSet: { advanceIds: new Types.ObjectId(advanceId) } },
      { new: true }
    ).exec();
  }

  async updateSettlement(reportId: string, settlement: any) {
    return await this.expenseReportModel.findByIdAndUpdate(
      reportId,
      { $set: { settlement } },
      { new: true }
    ).exec();
  }

  async setApprovedBy(reportId: string, userId: string) {
    await this.expenseReportModel.findByIdAndUpdate(
      reportId,
      { $set: { approvedBy: new Types.ObjectId(userId) } },
    ).exec();
  }

  async findOneWithAdvances(id: string) {
    const report = await this.expenseReportModel
      .findById(id)
      .populate('userId', 'name email signature')
      .populate('expenseIds')
      .populate('advanceIds')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email')
      .populate('projectId', 'name')
      .exec();
    if (!report) throw new NotFoundException(`Expense report with ID ${id} not found`);
    return report;
  }
}
