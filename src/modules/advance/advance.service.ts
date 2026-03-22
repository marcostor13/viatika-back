import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Advance, AdvanceDocument, ADVANCE_THRESHOLDS } from './entities/advance.entity'
import { CreateAdvanceDto } from './dto/create-advance.dto'
import { ApproveAdvanceDto, RejectAdvanceDto } from './dto/approve-advance.dto'
import { PayAdvanceDto } from './dto/pay-advance.dto'
import { ExpenseReportService } from '../expense-report/expense-report.service'
import { ROLES } from '../auth/enums/roles.enum'

@Injectable()
export class AdvanceService {
  private readonly logger = new Logger(AdvanceService.name)

  constructor(
    @InjectModel(Advance.name)
    private readonly advanceModel: Model<AdvanceDocument>,
    private readonly expenseReportService: ExpenseReportService,
  ) {}

  async create(dto: CreateAdvanceDto): Promise<Advance> {
    if (!dto.clientId) throw new BadRequestException('clientId es requerido')
    if (!dto.userId) throw new BadRequestException('userId es requerido')

    const requiredLevels = dto.amount > ADVANCE_THRESHOLDS.L1_MAX ? 2 : 1

    const advance = await this.advanceModel.create({
      userId: new Types.ObjectId(dto.userId),
      clientId: new Types.ObjectId(dto.clientId),
      expenseReportId: dto.expenseReportId ? new Types.ObjectId(dto.expenseReportId) : undefined,
      amount: dto.amount,
      description: dto.description,
      status: 'pending_l1',
      approvalLevel: 0,
      requiredLevels,
      approvalHistory: [],
    })

    if (dto.expenseReportId) {
      await this.expenseReportService.addAdvanceToReport(dto.expenseReportId, (advance as any)._id.toString())
    }

    return advance
  }

  async findAllByClient(clientId: string) {
    return this.advanceModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('userId', 'name email')
      .populate('expenseReportId', 'title status')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findMyAdvances(userId: string, clientId: string) {
    return this.advanceModel
      .find({
        userId: new Types.ObjectId(userId),
        clientId: new Types.ObjectId(clientId),
      })
      .populate('expenseReportId', 'title status')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findPending(clientId: string) {
    return this.advanceModel
      .find({
        clientId: new Types.ObjectId(clientId),
        status: { $in: ['pending_l1', 'pending_l2', 'approved'] },
      })
      .populate('userId', 'name email bankAccount')
      .populate('expenseReportId', 'title status')
      .sort({ createdAt: -1 })
      .exec()
  }

  async findOne(id: string) {
    const advance = await this.advanceModel
      .findById(id)
      .populate('userId', 'name email bankAccount')
      .populate('expenseReportId', 'title status budget')
      .exec()
    if (!advance) throw new NotFoundException(`Anticipo con ID ${id} no encontrado`)
    return advance
  }

  async approveL1(id: string, dto: ApproveAdvanceDto, userRole: string, userPermissions?: any): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'pending_l1') {
      throw new BadRequestException(`El anticipo no está en estado de aprobación nivel 1 (estado actual: ${advance.status})`)
    }

    const canApproveL1 = [ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(userRole as ROLES) || userPermissions?.canApproveL1 === true
    if (!canApproveL1) throw new ForbiddenException('No tienes permiso para aprobar en nivel 1')

    advance.approvalHistory.push({
      level: 1,
      approvedBy: dto.approvedBy || 'sistema',
      action: 'approved',
      notes: dto.notes,
      date: new Date(),
    })
    advance.approvalLevel = 1

    if (advance.requiredLevels === 1) {
      advance.status = 'approved'
    } else {
      advance.status = 'pending_l2'
    }

    return advance.save()
  }

  async approveL2(id: string, dto: ApproveAdvanceDto, userRole: string, userPermissions?: any): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'pending_l2') {
      throw new BadRequestException(`El anticipo no está en estado de aprobación nivel 2 (estado actual: ${advance.status})`)
    }

    const canApproveL2 = userRole === ROLES.SUPER_ADMIN || userPermissions?.canApproveL2 === true
    if (!canApproveL2) throw new ForbiddenException('No tienes permiso para aprobar en nivel 2')

    advance.approvalHistory.push({
      level: 2,
      approvedBy: dto.approvedBy || 'sistema',
      action: 'approved',
      notes: dto.notes,
      date: new Date(),
    })
    advance.approvalLevel = 2
    advance.status = 'approved'

    return advance.save()
  }

  async reject(id: string, dto: RejectAdvanceDto, userRole: string, userPermissions?: any): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    const rejectableStatuses = ['pending_l1', 'pending_l2']
    if (!rejectableStatuses.includes(advance.status)) {
      throw new BadRequestException(`No se puede rechazar un anticipo en estado "${advance.status}"`)
    }

    const canReject = [ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(userRole as ROLES) || userPermissions?.canApproveL1 === true || userPermissions?.canApproveL2 === true
    if (!canReject) throw new ForbiddenException('No tienes permiso para rechazar anticipos')

    advance.approvalHistory.push({
      level: advance.status === 'pending_l2' ? 2 : 1,
      approvedBy: dto.rejectedBy || 'sistema',
      action: 'rejected',
      notes: dto.rejectionReason,
      date: new Date(),
    })
    advance.status = 'rejected'
    advance.rejectedBy = dto.rejectedBy
    advance.rejectionReason = dto.rejectionReason

    return advance.save()
  }

  async registerPayment(id: string, dto: PayAdvanceDto, userRole: string, userPermissions?: any): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'approved') {
      throw new BadRequestException(`Solo se puede registrar pago de anticipos aprobados (estado actual: ${advance.status})`)
    }

    const canPay = userRole === ROLES.SUPER_ADMIN || userPermissions?.canApproveL2 === true
    if (!canPay) throw new ForbiddenException('No tienes permiso para registrar pagos')

    advance.paymentInfo = {
      method: dto.method,
      bankName: dto.bankName,
      accountNumber: dto.accountNumber,
      cci: dto.cci,
      transferDate: new Date(dto.transferDate),
      reference: dto.reference,
    }
    advance.status = 'paid'

    return advance.save()
  }

  async settle(id: string): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'paid') {
      throw new BadRequestException(`Solo se puede liquidar anticipos pagados (estado actual: ${advance.status})`)
    }

    let expenseTotal = 0
    if (advance.expenseReportId) {
      try {
        const report = await this.expenseReportService.findOneWithAdvances(advance.expenseReportId.toString())
        expenseTotal = (report.expenseIds as any[]).reduce((sum, e) => sum + (e.total || 0), 0)
      } catch (err) {
        this.logger.warn('No se pudo obtener la rendición para calcular liquidación')
      }
    }

    const advanceAmount = advance.amount
    const difference = advanceAmount - expenseTotal
    let type: 'reembolso' | 'devolucion' | 'equilibrado'

    if (Math.abs(difference) < 0.01) {
      type = 'equilibrado'
    } else if (difference > 0) {
      type = 'devolucion' // employee must return excess
    } else {
      type = 'reembolso' // company must reimburse employee
    }

    const settlement = {
      expenseTotal,
      advanceAmount,
      difference,
      type,
      settledAt: new Date(),
    }

    advance.settlement = settlement
    advance.status = 'settled'

    if (advance.expenseReportId) {
      await this.expenseReportService.updateSettlement(
        advance.expenseReportId.toString(),
        { advanceTotal: advanceAmount, expenseTotal, difference, type, settledAt: new Date() }
      )
    }

    return advance.save()
  }

  async registerReturn(id: string, returnedAmount: number): Promise<Advance> {
    const advance = await this.advanceModel.findById(id)
    if (!advance) throw new NotFoundException(`Anticipo ${id} no encontrado`)

    if (advance.status !== 'settled' && advance.status !== 'paid') {
      throw new BadRequestException(`Solo se puede registrar devolución de anticipos pagados o liquidados`)
    }

    advance.returnedAmount = returnedAmount
    advance.status = 'returned'

    return advance.save()
  }

  async getStats(clientId: string) {
    const [pending_l1, pending_l2, approved, paid, settled] = await Promise.all([
      this.advanceModel.countDocuments({ clientId: new Types.ObjectId(clientId), status: 'pending_l1' }),
      this.advanceModel.countDocuments({ clientId: new Types.ObjectId(clientId), status: 'pending_l2' }),
      this.advanceModel.countDocuments({ clientId: new Types.ObjectId(clientId), status: 'approved' }),
      this.advanceModel.countDocuments({ clientId: new Types.ObjectId(clientId), status: 'paid' }),
      this.advanceModel.countDocuments({ clientId: new Types.ObjectId(clientId), status: 'settled' }),
    ])

    const totalAmountResult = await this.advanceModel.aggregate([
      { $match: { clientId: new Types.ObjectId(clientId), status: { $in: ['approved', 'paid', 'settled'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ])

    return {
      pending_l1,
      pending_l2,
      approved,
      paid,
      settled,
      totalApprovedAmount: totalAmountResult[0]?.total || 0,
    }
  }
}
