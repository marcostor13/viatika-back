import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { ExpenseReport } from '../expense-report/entities/expense-report.entity'
import { Expense } from '../expense/entities/expense.entity'
import { Advance } from '../advance/entities/advance.entity'
import { Project } from '../project/entities/project.entity'
import { User } from '../user/schemas/user.schema'
import { AccountingConfigService } from '../accounting-config/accounting-config.service'
import { AccountingConfigDocument } from '../accounting-config/entities/accounting-config.entity'
import {
  CONTANET_COLUMNS,
  ContanetLine,
  toExcelSerial,
} from './entities/contanet-columns'
import { buildContanetWorkbook } from './entities/contanet-export'
import {
  AsientoTipo,
  CuadreError,
  GeneratedFile,
} from './entities/accounting-entries.types'

/** Porción analítica resuelta para una línea de gasto. */
interface AnalyticPortion {
  proyectId?: string
  condicion: 'afecto' | 'inafecto'
  monto: number
}

@Injectable()
export class AccountingEntriesService {
  private readonly logger = new Logger(AccountingEntriesService.name)

  constructor(
    @InjectModel(ExpenseReport.name)
    private reportModel: Model<any>,
    @InjectModel(Expense.name)
    private expenseModel: Model<any>,
    @InjectModel(Advance.name)
    private advanceModel: Model<any>,
    @InjectModel(Project.name)
    private projectModel: Model<any>,
    @InjectModel(User.name)
    private userModel: Model<any>,
    private accountingConfigService: AccountingConfigService
  ) {}

  // ----------------------------------------------------------------------
  // Orquestación
  // ----------------------------------------------------------------------

  /**
   * Genera los archivos de asientos de una rendición para los tipos solicitados.
   * Disponible en cualquier estado de la rendición (decisión de negocio).
   */
  async generateForReport(
    reportId: string,
    clientId: string,
    tipos: AsientoTipo[]
  ): Promise<GeneratedFile[]> {
    const report = (await this.reportModel
      .findById(reportId)
      .lean()
      .exec()) as any
    if (!report) throw new NotFoundException('Rendición no encontrada')

    const config = await this.accountingConfigService.getEffective(clientId)

    const expenses = (await this.expenseModel
      .find({ expenseReportId: report._id, status: { $ne: 'rejected' } })
      .lean()
      .exec()) as any[]

    const advances = (
      report.advanceIds?.length
        ? await this.advanceModel
            .find({ _id: { $in: report.advanceIds } })
            .lean()
            .exec()
        : []
    ) as any[]

    const colaborador = (await this.userModel
      .findById(report.userId)
      .lean()
      .exec()) as any

    const projectMap = await this.buildProjectMap(expenses, report, clientId)

    const files: GeneratedFile[] = []
    for (const tipo of tipos) {
      const lines = this.buildLinesForTipo(tipo, {
        report,
        config,
        expenses,
        advances,
        colaborador,
        projectMap,
      })
      if (!lines.length) continue
      const cuadreErrors = this.validateCuadre(lines)
      const buffer = await buildContanetWorkbook(lines)
      files.push({
        tipo,
        filename: this.fileName(tipo, report),
        base64: buffer.toString('base64'),
        asientosCount: this.countAsientos(lines),
        cuadreErrors,
      })
    }
    return files
  }

  private fileName(tipo: AsientoTipo, report: any): string {
    const code = report.codigo || report._id?.toString()?.slice(-6) || 'rendicion'
    return `asientos_${tipo}_${code}.xlsx`
  }

  private buildLinesForTipo(
    tipo: AsientoTipo,
    ctx: {
      report: any
      config: AccountingConfigDocument
      expenses: any[]
      advances: any[]
      colaborador: any
      projectMap: Map<string, any>
    }
  ): ContanetLine[] {
    switch (tipo) {
      case 'compra':
        return this.buildCompraLines(ctx)
      case 'solicitud':
        return this.buildSolicitudLines(ctx)
      case 'aplicacion':
        return this.buildAplicacionLines(ctx)
      case 'devolucion':
        return this.buildDevolucionReembolsoLines(ctx, 'devolucion')
      case 'reembolso':
        return this.buildDevolucionReembolsoLines(ctx, 'reembolso')
      default:
        return []
    }
  }

  // ----------------------------------------------------------------------
  // Helpers de datos
  // ----------------------------------------------------------------------

  private async buildProjectMap(
    expenses: any[],
    report: any,
    clientId: string
  ): Promise<Map<string, any>> {
    const ids = new Set<string>()
    if (report.projectId) ids.add(report.projectId.toString())
    for (const e of expenses) {
      if (e.proyectId) ids.add(e.proyectId.toString())
      for (const d of e.detalleAnalitico ?? []) {
        if (d.proyectId) ids.add(d.proyectId.toString())
      }
    }
    const projects = (
      ids.size
        ? await this.projectModel
            .find({ _id: { $in: Array.from(ids) }, clientId })
            .lean()
            .exec()
        : []
    ) as any[]
    const map = new Map<string, any>()
    for (const p of projects) map.set(p._id.toString(), p)
    return map
  }

  /** Parsea el JSON `data` del comprobante de forma segura. */
  private parseData(expense: any): Record<string, any> {
    if (!expense?.data || typeof expense.data !== 'string') return {}
    try {
      return JSON.parse(expense.data)
    } catch {
      return {}
    }
  }

  /** Fecha del asiento: fechaEmision del comprobante o fecha del reporte. */
  private asientoDate(expense: any, report: any): Date {
    const raw =
      expense?.fechaEmision || report?.createdAt || report?.updatedAt
    const d = raw ? new Date(raw) : new Date()
    return Number.isNaN(d.getTime()) ? new Date() : d
  }

  /** Resuelve las porciones analíticas de un comprobante (multiproyecto/afecto-inafecto). */
  private resolvePortions(expense: any): AnalyticPortion[] {
    const detalle: AnalyticPortion[] = (expense.detalleAnalitico ?? []).map(
      (d: any) => ({
        proyectId: d.proyectId?.toString(),
        condicion: d.condicion === 'inafecto' ? 'inafecto' : 'afecto',
        monto: Number(d.monto) || 0,
      })
    )
    if (detalle.length) return detalle

    // Sin detalle explícito: derivar de base/inafecto/total.
    const total = Number(expense.total) || 0
    const igv = Number(expense.igv) || 0
    const inafecto = Number(expense.inafecto) || 0
    const base =
      Number(expense.baseAfecta) || Math.max(total - igv - inafecto, 0)
    const portions: AnalyticPortion[] = []
    const proyectId = expense.proyectId?.toString()
    if (base > 0) portions.push({ proyectId, condicion: 'afecto', monto: base })
    if (inafecto > 0)
      portions.push({ proyectId, condicion: 'inafecto', monto: inafecto })
    if (!portions.length && total > 0)
      portions.push({ proyectId, condicion: 'afecto', monto: total })
    return portions
  }

  private round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
  }

  /** Línea base con los campos comunes a todo asiento. */
  private baseLine(
    config: AccountingConfigDocument,
    date: Date,
    fuente: string,
    glosa: string,
    extra: ContanetLine = {}
  ): ContanetLine {
    const serial = toExcelSerial(date)
    return {
      ejercicio: date.getFullYear(),
      periodo: String(date.getMonth() + 1).padStart(2, '0'),
      codModulo: config.codModulo,
      modulo: config.modulo,
      fuente,
      conceptoFec: config.conceptoFec,
      glosa,
      mdaOrigen: config.monedaOrigen,
      mdaRegistro: config.monedaRegistro,
      centroCosto: config.centroCosto || '',
      subCentroCosto: config.subCentroCosto || '',
      subSubCentroCosto: config.subCentroCosto || '',
      area: config.area || '',
      identCtrMda: config.identificadorCtrMda,
      fechaEmision: serial,
      fechaVencimiento: serial,
      fechaMovimiento: serial,
      fechaRegistro: serial,
      cambioMoneda: config.tipoCambio ?? 1,
      esCancelado: 0,
      esConciliado: 0,
      esProvision: 0,
      esAnulado: 0,
      esDestino: 0,
      montoDebe: 0,
      montoHaber: 0,
      montoDebeME: 0,
      montoHaberME: 0,
      ...extra,
    }
  }

  /** Aplica centro de costo/área del proyecto a una línea (si está parametrizado). */
  private applyProjectCostCenter(
    line: ContanetLine,
    project: any | undefined
  ): void {
    if (!project) return
    if (project.centroCosto) line.centroCosto = project.centroCosto
    if (project.subCentroCosto) {
      line.subCentroCosto = project.subCentroCosto
      line.subSubCentroCosto = project.subCentroCosto
    }
    if (project.area) line.area = project.area
  }

  /** Subcuenta 14 del colaborador (parametrizada o construida con la raíz). */
  private cuenta14(config: AccountingConfigDocument, colaborador: any): string {
    if (colaborador?.subcuenta14) return colaborador.subcuenta14
    return config.cuenta14Raiz
  }

  // ----------------------------------------------------------------------
  // C2 — Builder COMPRA (registro de la compra, por comprobante)
  // ----------------------------------------------------------------------

  private buildCompraLines(ctx: {
    report: any
    config: AccountingConfigDocument
    expenses: any[]
    projectMap: Map<string, any>
  }): ContanetLine[] {
    const { config, expenses, report, projectMap } = ctx
    const lines: ContanetLine[] = []
    let relacionado = 1
    let correlativo = 1

    for (const expense of expenses) {
      const data = this.parseData(expense)
      const date = this.asientoDate(expense, report)
      const igv = this.round2(Number(expense.igv) || 0)
      const inafecto = this.round2(Number(expense.inafecto) || 0)
      const portions = this.resolvePortions(expense)
      const baseTotal = this.round2(
        portions.reduce((s, p) => s + p.monto, 0)
      )
      const total = this.round2(
        Number(expense.total) || baseTotal + igv
      )
      const serie = data.serie || ''
      const nroDoc = data.correlativo || expense.internalCode || ''
      const ruc = data.rucEmisor || ''
      const razonSocial = data.razonSocial || expense.providerName || ''
      const glosa = (expense.comentario || data.comentario || 'GASTO')
        .toString()
        .slice(0, 100)
        .toUpperCase()

      const push = (line: ContanetLine) => {
        line.relacionado = relacionado
        line.correlativo = correlativo++
        lines.push(line)
      }

      // (1) Cuenta 42 — total del comprobante (Haber), provisión + proveedor
      push(
        this.baseLine(config, date, config.fuenteCompra, glosa, {
          nroCuenta: config.cuenta42,
          codTipDoc: '01',
          nroSerie: serie,
          nroDoc,
          montoHaber: total,
          montoHaberME: this.toME(total, config),
          esProvision: 1,
          codTipDocIdentProv: ruc ? '06' : '',
          nroDocProv: ruc,
          razonSocialProv: razonSocial,
        })
      )

      // (2) Cuenta 40 — IGV (Debe), si aplica
      if (igv > 0) {
        const cuenta40 = this.resolveCuenta40(config, expense.tasaIgv)
        push(
          this.baseLine(config, date, config.fuenteCompra, glosa, {
            nroCuenta: cuenta40,
            montoDebe: igv,
            montoDebeME: this.toME(igv, config),
          })
        )
      }

      // (3) Cuentas 9X — analítica por porción (Debe)
      for (const p of portions) {
        const project = p.proyectId ? projectMap.get(p.proyectId) : undefined
        const cuenta9x =
          project?.cuentaAnalitica9x || `91.${expense.proyectId ?? ''}`
        const line = this.baseLine(config, date, config.fuenteCompra, glosa, {
          nroCuenta: cuenta9x,
          identTipAfecto: p.condicion === 'afecto' ? 'S' : 'N',
          montoDebe: this.round2(p.monto),
          montoDebeME: this.toME(p.monto, config),
        })
        this.applyProjectCostCenter(line, project)
        push(line)
      }

      // (4) Destino — par 6X (Debe) / 79 (Haber) por porción
      for (const p of portions) {
        const project = p.proyectId ? projectMap.get(p.proyectId) : undefined
        const cuenta6x = project?.cuentaDestino6x || config.cuenta79
        const line6 = this.baseLine(config, date, config.fuenteCompra, glosa, {
          nroCuenta: cuenta6x,
          montoDebe: this.round2(p.monto),
          montoDebeME: this.toME(p.monto, config),
          esDestino: 1,
        })
        this.applyProjectCostCenter(line6, project)
        push(line6)

        push(
          this.baseLine(config, date, config.fuenteCompra, glosa, {
            nroCuenta: config.cuenta79,
            montoHaber: this.round2(p.monto),
            montoHaberME: this.toME(p.monto, config),
            esDestino: 1,
          })
        )
      }

      relacionado++
    }

    return lines
  }

  private resolveCuenta40(
    config: AccountingConfigDocument,
    tasaIgv?: number
  ): string {
    const rates = config.igvRates ?? []
    if (tasaIgv != null) {
      const match = rates.find((r) => Number(r.tasa) === Number(tasaIgv))
      if (match) return match.cuenta40
    }
    return rates[0]?.cuenta40 || '40.1.1.100'
  }

  private toME(amount: number, config: AccountingConfigDocument): number {
    const tc = Number(config.tipoCambio) || 1
    if (tc === 1) return 0
    return this.round2(amount / tc)
  }

  // ----------------------------------------------------------------------
  // C3 — Builders SOLICITUD / APLICACIÓN / DEVOLUCIÓN-REEMBOLSO
  // ----------------------------------------------------------------------

  private buildSolicitudLines(ctx: {
    report: any
    config: AccountingConfigDocument
    advances: any[]
    colaborador: any
  }): ContanetLine[] {
    const { config, advances, colaborador, report } = ctx
    const lines: ContanetLine[] = []
    let relacionado = 1
    let correlativo = 1
    const trabDni = colaborador?.dni || ''
    const trabNombre = colaborador?.name || ''
    const cuenta14 = this.cuenta14(config, colaborador)

    for (const adv of advances) {
      const amount = this.round2(Number(adv.amount) || 0)
      if (amount <= 0) continue
      const date = adv.payment?.transferDate
        ? new Date(adv.payment.transferDate)
        : new Date(adv.createdAt || Date.now())
      const banco = this.resolveBankAccount(config, adv.payment?.accountNumber)
      const glosa = (adv.description || 'SOLICITUD VIATICO')
        .toString()
        .slice(0, 100)
        .toUpperCase()

      // 14 (Debe) — nace la obligación del colaborador
      lines.push({
        ...this.baseLine(config, date, config.fuenteCajaBancos, glosa, {
          nroCuenta: cuenta14,
          montoDebe: amount,
          montoDebeME: this.toME(amount, config),
          codTipDocIdentTrab: trabDni ? '01' : '',
          nroDocTrab: trabDni,
          razonSocialTrab: trabNombre,
        }),
        relacionado,
        correlativo: correlativo++,
      })

      // 104 (Haber) — sale el dinero del banco
      lines.push({
        ...this.baseLine(config, date, config.fuenteCajaBancos, glosa, {
          nroCuenta: banco,
          montoHaber: amount,
          montoHaberME: this.toME(amount, config),
        }),
        relacionado,
        correlativo: correlativo++,
      })

      relacionado++
    }

    void report
    return lines
  }

  private buildAplicacionLines(ctx: {
    report: any
    config: AccountingConfigDocument
    expenses: any[]
    colaborador: any
  }): ContanetLine[] {
    const { config, expenses, colaborador, report } = ctx
    const lines: ContanetLine[] = []
    let relacionado = 1
    let correlativo = 1
    const trabDni = colaborador?.dni || ''
    const trabNombre = colaborador?.name || ''
    const cuenta14 = this.cuenta14(config, colaborador)

    for (const expense of expenses) {
      const data = this.parseData(expense)
      const date = this.asientoDate(expense, report)
      const total = this.round2(Number(expense.total) || 0)
      if (total <= 0) continue
      const ruc = data.rucEmisor || ''
      const razonSocial = data.razonSocial || expense.providerName || ''
      const glosa = 'APLICACION'

      // 42 (Debe) — cancela la provisión del proveedor
      lines.push({
        ...this.baseLine(config, date, config.fuenteAplicacion, glosa, {
          nroCuenta: config.cuenta42,
          codTipDoc: '01',
          nroSerie: data.serie || '',
          nroDoc: data.correlativo || '',
          montoDebe: total,
          montoDebeME: this.toME(total, config),
          codTipDocIdentProv: ruc ? '06' : '',
          nroDocProv: ruc,
          razonSocialProv: razonSocial,
        }),
        relacionado,
        correlativo: correlativo++,
      })

      // 14 (Haber) — reduce la cuenta por cobrar del colaborador
      lines.push({
        ...this.baseLine(config, date, config.fuenteAplicacion, glosa, {
          nroCuenta: cuenta14,
          montoHaber: total,
          montoHaberME: this.toME(total, config),
          codTipDocIdentTrab: trabDni ? '01' : '',
          nroDocTrab: trabDni,
          razonSocialTrab: trabNombre,
        }),
        relacionado,
        correlativo: correlativo++,
      })

      relacionado++
    }

    return lines
  }

  private buildDevolucionReembolsoLines(
    ctx: {
      report: any
      config: AccountingConfigDocument
      advances: any[]
      colaborador: any
    },
    modo: 'devolucion' | 'reembolso'
  ): ContanetLine[] {
    const { config, colaborador, report, advances } = ctx
    const settlement = report.settlement
    const diff = this.round2(Math.abs(Number(settlement?.difference) || 0))
    if (diff <= 0) return []

    // Coherencia: solo emitir si el tipo de liquidación corresponde al modo.
    if (settlement?.type && settlement.type !== modo) return []

    const date = new Date(report.updatedAt || Date.now())
    const trabDni = colaborador?.dni || ''
    const trabNombre = colaborador?.name || ''
    const cuenta14 = this.cuenta14(config, colaborador)
    const banco = this.resolveBankAccount(
      config,
      advances?.[0]?.payment?.accountNumber
    )
    const glosa = modo === 'devolucion' ? 'DEVOLUCION' : 'REEMBOLSO'
    const cuentaColab =
      modo === 'reembolso' && config.cuentaReembolso === '46'
        ? config.cuenta46 || cuenta14
        : cuenta14

    const lines: ContanetLine[] = []

    if (modo === 'devolucion') {
      // 104 (Debe) entra al banco / 14 (Haber) reduce la CxC
      lines.push({
        ...this.baseLine(config, date, config.fuenteCajaBancos, glosa, {
          nroCuenta: banco,
          montoDebe: diff,
          montoDebeME: this.toME(diff, config),
        }),
        relacionado: 1,
        correlativo: 1,
      })
      lines.push({
        ...this.baseLine(config, date, config.fuenteCajaBancos, glosa, {
          nroCuenta: cuenta14,
          montoHaber: diff,
          montoHaberME: this.toME(diff, config),
          codTipDocIdentTrab: trabDni ? '01' : '',
          nroDocTrab: trabDni,
          razonSocialTrab: trabNombre,
        }),
        relacionado: 1,
        correlativo: 2,
      })
    } else {
      // Reembolso: 14/46 (Debe) / 104 (Haber) sale del banco
      lines.push({
        ...this.baseLine(config, date, config.fuenteCajaBancos, glosa, {
          nroCuenta: cuentaColab,
          montoDebe: diff,
          montoDebeME: this.toME(diff, config),
          codTipDocIdentTrab: trabDni ? '01' : '',
          nroDocTrab: trabDni,
          razonSocialTrab: trabNombre,
        }),
        relacionado: 1,
        correlativo: 1,
      })
      lines.push({
        ...this.baseLine(config, date, config.fuenteCajaBancos, glosa, {
          nroCuenta: banco,
          montoHaber: diff,
          montoHaberME: this.toME(diff, config),
        }),
        relacionado: 1,
        correlativo: 2,
      })
    }

    return lines
  }

  private resolveBankAccount(
    config: AccountingConfigDocument,
    nroCuenta?: string
  ): string {
    const accounts = config.bankAccounts ?? []
    if (nroCuenta) {
      const match = accounts.find((b) => b.nroCuenta === nroCuenta)
      if (match) return match.cuentaContable
    }
    const active = accounts.find((b) => b.activo !== false)
    return active?.cuentaContable || accounts[0]?.cuentaContable || '10.4.1.100'
  }

  // ----------------------------------------------------------------------
  // C4 — Validación de cuadre (partida doble)
  // ----------------------------------------------------------------------

  validateCuadre(lines: ContanetLine[]): CuadreError[] {
    const groups = new Map<number, { debe: number; haber: number }>()
    for (const line of lines) {
      const rel = Number(line.relacionado)
      if (!groups.has(rel)) groups.set(rel, { debe: 0, haber: 0 })
      const g = groups.get(rel)!
      g.debe += Number(line.montoDebe) || 0
      g.haber += Number(line.montoHaber) || 0
    }
    const errors: CuadreError[] = []
    for (const [rel, g] of groups) {
      const debe = this.round2(g.debe)
      const haber = this.round2(g.haber)
      if (Math.abs(debe - haber) > 0.001) {
        errors.push({
          relacionado: rel,
          totalDebe: debe,
          totalHaber: haber,
          diferencia: this.round2(debe - haber),
        })
      }
    }
    return errors
  }

  private countAsientos(lines: ContanetLine[]): number {
    return new Set(lines.map((l) => Number(l.relacionado))).size
  }

  /** Expuesto para tests: columnas del template. */
  get columns() {
    return CONTANET_COLUMNS
  }
}