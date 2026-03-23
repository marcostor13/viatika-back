import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateExpenseReportDto } from './dto/create-expense-report.dto';
import { UpdateExpenseReportDto } from './dto/update-expense-report.dto';
import { ExpenseReport, ExpenseReportDocument } from './entities/expense-report.entity';

@Injectable()
export class ExpenseReportService {
  constructor(
    @InjectModel(ExpenseReport.name)
    private readonly expenseReportModel: Model<ExpenseReportDocument>,
  ) {}

  async create(createExpenseReportDto: CreateExpenseReportDto, createdBy: string) {
    const report = new this.expenseReportModel({
      ...createExpenseReportDto,
      userId: new Types.ObjectId(createExpenseReportDto.userId),
      clientId: new Types.ObjectId(createExpenseReportDto.clientId),
      createdBy: new Types.ObjectId(createdBy),
      projectId: createExpenseReportDto.projectId ? new Types.ObjectId(createExpenseReportDto.projectId) : undefined,
      status: 'open',
      expenseIds: []
    });
    return await report.save();
  }

  async findAllByClient(clientId: string) {
    return await this.expenseReportModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('userId', 'name email')
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
      .populate('userId', 'name email')
      .populate('expenseIds')
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
    if (dto.status === 'rejected' && existing.status !== 'submitted') {
      throw new BadRequestException('Solo se pueden rechazar rendiciones ya enviadas.');
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

    if (dto.status === 'submitted') {
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
    return this.findOne(id);
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

  async findOneWithAdvances(id: string) {
    const report = await this.expenseReportModel
      .findById(id)
      .populate('userId', 'name email')
      .populate('expenseIds')
      .populate('advanceIds')
      .exec();
    if (!report) throw new NotFoundException(`Expense report with ID ${id} not found`);
    return report;
  }
}
