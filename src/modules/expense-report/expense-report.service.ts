import { Injectable, NotFoundException } from '@nestjs/common';
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
    const defaultUpdate: any = { ...updateExpenseReportDto };
    
    // Convert string arrays to ObjectIds if present
    if (updateExpenseReportDto.expenseIds) {
      defaultUpdate.expenseIds = updateExpenseReportDto.expenseIds.map(eId => new Types.ObjectId(eId));
    }

    const updated = await this.expenseReportModel.findByIdAndUpdate(
      id,
      { $set: defaultUpdate },
      { new: true }
    ).exec();

    if (!updated) {
      throw new NotFoundException(`Expense report with ID ${id} not found`);
    }
    return updated;
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
