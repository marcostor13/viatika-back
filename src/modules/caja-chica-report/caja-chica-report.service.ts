import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import {
  CajaChicaReport,
  CajaChicaReportDocument,
} from './entities/caja-chica-report.entity'
import {
  ExpenseReport,
  ExpenseReportDocument,
} from '../expense-report/entities/expense-report.entity'
import { CreateCajaChicaReportDto } from './dto/create-caja-chica-report.dto'

@Injectable()
export class CajaChicaReportService {
  constructor(
    @InjectModel(CajaChicaReport.name)
    private readonly model: Model<CajaChicaReportDocument>,
    @InjectModel(ExpenseReport.name)
    private readonly expenseReportModel: Model<ExpenseReportDocument>,
  ) {}

  private async generateCodigo(clientId: string): Promise<string> {
    const key = `caja-chica-report:${clientId}`
    const res: any = await this.model.db
      .collection('counters')
      .findOneAndUpdate(
        { _id: key as any },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      )
    const seq = (res && (res.seq ?? res.value?.seq)) ?? 1
    return `CC-${String(seq).padStart(4, '0')}`
  }

  async create(dto: CreateCajaChicaReportDto, createdBy: string, clientId: string) {
    const effectiveClientId = dto.clientId || clientId
    if (!effectiveClientId) {
      throw new BadRequestException('No se pudo determinar el cliente.')
    }
    const codigo = await this.generateCodigo(effectiveClientId)
    const report = new this.model({
      codigo,
      title: dto.title.trim(),
      clientId: new Types.ObjectId(effectiveClientId),
      createdBy: new Types.ObjectId(createdBy),
      status: 'draft',
      selectedReports: [],
      totalAmount: 0,
    })
    return report.save()
  }

  async findAllByClient(clientId: string) {
    return this.model
      .find({ clientId: new Types.ObjectId(clientId) })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .lean()
      .exec()
  }

  async findOne(id: string) {
    const report = await this.model
      .findById(id)
      .populate('createdBy', 'name email')
      .lean()
      .exec()
    if (!report) throw new NotFoundException(`Reporte CC ${id} no encontrado`)

    // Poblar cada rendición seleccionada con sus gastos
    const enriched = await Promise.all(
      (report.selectedReports ?? []).map(async (sr: any) => {
        const expReport = await this.expenseReportModel
          .findById(sr.expenseReportId)
          .populate('expenseIds')
          .lean()
          .exec()
        return {
          ...sr,
          expenseReport: expReport,
        }
      }),
    )

    return { ...report, selectedReports: enriched }
  }

  async addReports(id: string, reportIds: string[], clientId: string) {
    const cajaChicaReport = await this.model.findById(id).exec()
    if (!cajaChicaReport) throw new NotFoundException(`Reporte CC ${id} no encontrado`)
    if (cajaChicaReport.status === 'finalized') {
      throw new BadRequestException('No se puede modificar un reporte finalizado.')
    }

    const existingIds = new Set(
      cajaChicaReport.selectedReports.map((r) => String(r.expenseReportId)),
    )

    for (const reportId of reportIds) {
      if (existingIds.has(reportId)) continue

      const expReport = await this.expenseReportModel
        .findById(reportId)
        .populate('userId', 'name email')
        .populate('expenseIds', 'total')
        .lean()
        .exec()

      if (!expReport || !expReport.isCajaChica) {
        throw new BadRequestException(
          `La rendición ${reportId} no es de tipo caja chica o no existe.`,
        )
      }
      if (String(expReport.clientId) !== clientId) {
        throw new BadRequestException(
          `La rendición ${reportId} no pertenece a este cliente.`,
        )
      }

      const colaborador = expReport.userId as any
      cajaChicaReport.selectedReports.push({
        expenseReportId: new Types.ObjectId(reportId),
        colaboradorId: new Types.ObjectId(String(colaborador?._id || colaborador)),
        colaboradorName: colaborador?.name || 'Colaborador',
      })
    }

    cajaChicaReport.totalAmount = await this.recalculateTotal(cajaChicaReport)
    return cajaChicaReport.save()
  }

  async removeReport(id: string, expenseReportId: string) {
    const report = await this.model.findById(id).exec()
    if (!report) throw new NotFoundException(`Reporte CC ${id} no encontrado`)
    if (report.status === 'finalized') {
      throw new BadRequestException('No se puede modificar un reporte finalizado.')
    }

    report.selectedReports = report.selectedReports.filter(
      (r) => String(r.expenseReportId) !== expenseReportId,
    )
    report.totalAmount = await this.recalculateTotal(report)
    return report.save()
  }

  async finalize(id: string) {
    const report = await this.model.findById(id).exec()
    if (!report) throw new NotFoundException(`Reporte CC ${id} no encontrado`)
    if (report.status === 'finalized') {
      throw new BadRequestException('El reporte ya está finalizado.')
    }
    if (report.selectedReports.length === 0) {
      throw new BadRequestException(
        'Debe incluir al menos una rendición antes de finalizar.',
      )
    }
    report.status = 'finalized'
    return report.save()
  }

  private async recalculateTotal(report: CajaChicaReportDocument): Promise<number> {
    let total = 0
    for (const sr of report.selectedReports) {
      const expReport = await this.expenseReportModel
        .findById(sr.expenseReportId)
        .populate('expenseIds', 'total')
        .lean()
        .exec()
      if (!expReport) continue
      for (const exp of expReport.expenseIds as any[]) {
        total += Number(exp?.total ?? 0)
      }
    }
    return total
  }
}
