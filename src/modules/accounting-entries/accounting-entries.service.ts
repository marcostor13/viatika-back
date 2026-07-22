import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { createHash } from 'crypto'
import OpenAI from 'openai'
import { ExpenseReport } from '../expense-report/entities/expense-report.entity'
import { Expense } from '../expense/entities/expense.entity'
import { parseFechaEmisionInput } from '../expense/utils/fecha-emision.util'
import { Advance } from '../advance/entities/advance.entity'
import { Project } from '../project/entities/project.entity'
import { User } from '../user/schemas/user.schema'
import { Category } from '../category/entities/category.entity'
import { Client } from '../client/entities/client.entity'
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service'
import { AccountingConfigService } from '../accounting-config/accounting-config.service'
import { AccountingConfigDocument } from '../accounting-config/entities/accounting-config.entity'
import {
  CONTANET_COLUMNS,
  ContanetLine,
  toExcelSerial,
} from './entities/contanet-columns'
import {
  generateContanetExcel,
  resolveTemplatePath,
} from './entities/contanet-export'
import {
  AccountingEntryStatusDto,
  AsientoTipo,
  CuadreError,
} from './entities/accounting-entries.types'
import { AccountingEntriesFile } from './entities/accounting-entries-file.entity'
import { UploadService } from '../upload/upload.service'
import { resolveCodTipDoc, TIPO_DOCUMENTO } from './constants/tipo-documento'
import {
  buildDeducibilidadPrompt,
  CargoContext,
} from './constants/deducibilidad-prompt'
import {
  ExpenseCargoClasificado,
  ExpenseCargosClasificacion,
} from '../expense/entities/expense.entity'

/** Porción analítica resuelta para una línea de gasto. */
interface AnalyticPortion {
  proyectId?: string
  condicion: 'afecto' | 'inafecto'
  monto: number
  /** Etiqueta opcional (ej. "RECARGO DE CONSUMO") para la glosa de la línea. */
  etiqueta?: string
  /**
   * Serie de control interno (0001/0003/0008) cuando la porción es un gasto
   * NO deducible: va en "Numero Documento" con "Codigo Tipo Document" vacío.
   */
  serieNoDeducible?: string
}

/** Series de control interno de gastos no deducibles (nodeducible.md). */
const SERIES_NO_DEDUCIBLE = new Set(['0001', '0003', '0008'])

/**
 * Tope diario de movilidad (declaración jurada, S/ sin comprobante) cuando la
 * empresa no configuró `Client.limits.movilidadDiario`. En el asiento de
 * Aplicación, el total de cada planilla de movilidad se reexpresa en bloques
 * de este monto (más un resto) en vez de usar el desglose real por fecha.
 */
const MOVILIDAD_DAILY_CAP_DEFAULT = 40

/**
 * Tiempo tras el cual un job "processing" se considera huérfano (proceso
 * reiniciado a media generación). Holgado a propósito: con concurrencia=1 un job
 * puede esperar legítimamente en cola detrás de otras rendiciones; el umbral debe
 * superar cualquier espera de cola razonable para no matar trabajo válido. La
 * generación en sí ahora toma segundos (SheetJS), así que esto solo cubre crashes.
 */
const STALE_PROCESSING_MS = 20 * 60 * 1000

@Injectable()
export class AccountingEntriesService {
  private readonly logger = new Logger(AccountingEntriesService.name)
  private readonly openai: OpenAI
  private readonly aiModel = 'deepseek-chat'

  /**
   * Solo UNA rendición genera asientos a la vez; el resto se encola en memoria.
   * No hay cola/infra dedicada (Bull/Redis) en el repo y el trabajo pesado
   * (IA + ExcelJS por tipo) corre en el mismo proceso Node, así que serializar
   * las generaciones evita saturar CPU/RAM cuando varias rendiciones se disparan
   * casi al mismo tiempo. Cada llamada a `runGeneration` toma UN cupo para toda
   * la rendición (sus tipos ya se procesan secuencialmente adentro).
   */
  private static readonly MAX_CONCURRENT_GENERATIONS = 1
  private activeGenerations = 0
  private readonly generationQueue: Array<() => void> = []

  private async acquireGenerationSlot(): Promise<() => void> {
    // `while` (no `if`): si al despertar el cupo ya fue tomado por otro, se
    // vuelve a esperar. Garantiza el límite aunque haya varios en cola.
    while (
      this.activeGenerations >=
      AccountingEntriesService.MAX_CONCURRENT_GENERATIONS
    ) {
      await new Promise<void>(resolve => this.generationQueue.push(resolve))
    }
    this.activeGenerations++
    return () => {
      this.activeGenerations--
      const next = this.generationQueue.shift()
      if (next) next()
    }
  }

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
    @InjectModel(Category.name)
    private categoryModel: Model<any>,
    @InjectModel(Client.name)
    private clientModel: Model<any>,
    @InjectModel(AccountingEntriesFile.name)
    private fileModel: Model<any>,
    private accountingConfigService: AccountingConfigService,
    private exchangeRateService: ExchangeRateService,
    private configService: ConfigService,
    private uploadService: UploadService
  ) {
    const apiKey = this.configService.get<string>('DEEPSEEK_API_KEY')
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY no configurada')
    this.openai = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' })

    // Todo tipo de asiento se genera exclusivamente desde el template .xlsm
    // (sin ruta alterna en .xlsx). Se valida su presencia al arranque para
    // avisar si falta en el despliegue.
    for (const tipo of [
      'compra',
      'aplicacion',
      'solicitud',
      'devolucion',
      'reembolso',
    ] as AsientoTipo[]) {
      const p = resolveTemplatePath(tipo)
      if (p) this.logger.log(`[asientos] template OK: ${p}`)
      else
        this.logger.warn(
          `[asientos] template NO encontrado para tipo="${tipo}"`
        )
    }
  }

  // ----------------------------------------------------------------------
  // Orquestación — generación asíncrona con persistencia en S3
  // ----------------------------------------------------------------------

  /** Lecturas comunes a `getStatus` y `triggerGeneration` (baratas, sin IA/ExcelJS). */
  private async loadContext(reportId: string, clientId: string) {
    const report = (await this.reportModel
      .findById(reportId)
      .lean()
      .exec()) as any
    if (!report) throw new NotFoundException('Rendición no encontrada')

    // Aislamiento multi-tenant: sin este chequeo, cualquier Contabilidad autenticado
    // podía generar/leer los asientos de una rendición de OTRA empresa con solo
    // conocer su reportId (el find de arriba no filtraba por clientId). Además, un
    // reportId cuya empresa no coincide con la del caller produce categorías/proyectos
    // "invisibles" más abajo (se filtran por clientId) y eso se manifestaba como un
    // descuadre confuso en vez de un error de permisos claro.
    const reportClientId = report.clientId?.toString()
    if (reportClientId && reportClientId !== clientId) {
      throw new ForbiddenException(
        'Esta rendición no pertenece a tu empresa; no puedes generar sus asientos contables.'
      )
    }

    const [config, expenses, advances, colaborador, client] = await Promise.all(
      [
        this.accountingConfigService.getEffective(reportClientId ?? clientId),
        this.expenseModel
          .find({ expenseReportId: report._id, status: { $ne: 'rejected' } })
          .lean()
          .exec() as Promise<any[]>,
        (report.advanceIds?.length
          ? this.advanceModel
            .find({ _id: { $in: report.advanceIds } })
            .lean()
            .exec()
          : Promise.resolve([])) as Promise<any[]>,
        this.userModel.findById(report.userId).lean().exec(),
        this.clientModel
          .findById(this.toObjectId(reportClientId ?? clientId))
          .lean()
          .exec() as Promise<any>,
      ]
    )
    const movilidadDiario =
      Number(client?.limits?.movilidadDiario) || MOVILIDAD_DAILY_CAP_DEFAULT

    const fingerprint = this.computeFingerprint(
      report,
      expenses,
      advances,
      config
    )
    return {
      report,
      config,
      expenses,
      advances,
      colaborador,
      movilidadDiario,
      fingerprint,
    }
  }

  /** Estado actual (para pintar la UI) de los tipos solicitados, con URL firmada si hay archivo listo. */
  async getStatus(
    reportId: string,
    clientId: string,
    tipos: AsientoTipo[]
  ): Promise<AccountingEntryStatusDto[]> {
    const { report, fingerprint } = await this.loadContext(reportId, clientId)
    const docs = (await this.fileModel
      .find({ reportId: report._id, tipo: { $in: tipos } })
      .lean()
      .exec()) as any[]
    const byTipo = new Map<string, any>(docs.map(d => [d.tipo, d]))
    return Promise.all(
      tipos.map(tipo => this.toStatusDto(tipo, byTipo.get(tipo), fingerprint))
    )
  }

  /** Dispara la generación en segundo plano de los tipos que lo necesiten y devuelve el estado inmediato. */
  async triggerGeneration(
    reportId: string,
    clientId: string,
    tipos: AsientoTipo[],
    requestedBy: string,
    force = false
  ): Promise<AccountingEntryStatusDto[]> {
    const ctx = await this.loadContext(reportId, clientId)
    const { report, fingerprint } = ctx
    const docs = (await this.fileModel
      .find({ reportId: report._id, tipo: { $in: tipos } })
      .lean()
      .exec()) as any[]
    const byTipo = new Map<string, any>(docs.map(d => [d.tipo, d]))

    const now = new Date()
    const tiposToRun: AsientoTipo[] = []
    for (const tipo of tipos) {
      const doc = byTipo.get(tipo)
      const isStuck =
        doc?.status === 'processing' &&
        doc?.startedAt &&
        now.getTime() - new Date(doc.startedAt).getTime() > STALE_PROCESSING_MS
      const alreadyRunning = doc?.status === 'processing' && !isStuck
      if (alreadyRunning && !force) continue
      const isStale = !doc || doc.fingerprint !== fingerprint
      if (!force && doc?.status === 'ready' && !isStale) continue
      tiposToRun.push(tipo)
    }

    if (tiposToRun.length) {
      await Promise.all(
        tiposToRun.map(tipo =>
          this.fileModel
            .findOneAndUpdate(
              { reportId: report._id, tipo },
              {
                $set: {
                  clientId: report.clientId ?? clientId,
                  status: 'processing',
                  requestedBy,
                  startedAt: now,
                  errorMessage: null,
                },
                $setOnInsert: { asientosCount: 0, cuadreErrors: [] },
              },
              { upsert: true }
            )
            .exec()
        )
      )
      // Fire-and-forget: el request responde de inmediato, el trabajo pesado
      // corre en segundo plano dentro del mismo proceso Node.
      void this.runGeneration(reportId, clientId, tiposToRun, ctx).catch(
        error =>
          this.logger.error(
            `[asientos] fallo no controlado generando reportId=${reportId}: ${error?.message}`,
            error?.stack
          )
      )
    }

    return this.getStatus(reportId, clientId, tipos)
  }

  /** Convierte un documento (o su ausencia) en el DTO que consume el frontend. */
  private async toStatusDto(
    tipo: AsientoTipo,
    doc: any | undefined,
    currentFingerprint: string
  ): Promise<AccountingEntryStatusDto> {
    // Todos los tipos son generables en cualquier estado de la rendición: ya
    // no hay bloqueo por "rendición no cerrada" (antes solo `solicitud`
    // escapaba a esa restricción). El campo se conserva en el DTO (siempre
    // `false`) para no romper el contrato con el frontend.
    const blocked = false
    if (!doc) return { tipo, status: 'none', blocked, blockedReason: undefined }
    const hasFile = doc.status === 'ready' && !!doc.s3Key
    const url = doc.s3Key
      ? await this.uploadService.getPresignedDownloadUrl(
        doc.s3Key,
        doc.filename
      )
      : undefined
    return {
      tipo,
      status: doc.status,
      filename: doc.filename,
      url,
      asientosCount: doc.asientosCount,
      cuadreErrors: doc.cuadreErrors,
      warnings: doc.warnings,
      errorMessage: doc.errorMessage ?? undefined,
      stale: hasFile ? doc.fingerprint !== currentFingerprint : undefined,
      completedAt: doc.completedAt,
      blocked,
      blockedReason: undefined,
    }
  }

  /**
   * Trabajo pesado (IA + tipo de cambio + ExcelJS + subida a S3). Corre
   * desacoplado del request HTTP que lo disparó (ver `triggerGeneration`).
   * Cada tipo se persiste de forma independiente: si uno falla, no impide
   * que los demás terminen con éxito.
   */
  private async runGeneration(
    reportId: string,
    clientId: string,
    tipos: AsientoTipo[],
    ctx: {
      report: any
      config: AccountingConfigDocument
      expenses: any[]
      advances: any[]
      colaborador: any
      movilidadDiario: number
      fingerprint: string
    }
  ): Promise<void> {
    const release = await this.acquireGenerationSlot()
    try {
      await this.runGenerationLocked(reportId, clientId, tipos, ctx)
    } finally {
      release()
    }
  }

  private async runGenerationLocked(
    reportId: string,
    clientId: string,
    tipos: AsientoTipo[],
    ctx: {
      report: any
      config: AccountingConfigDocument
      expenses: any[]
      advances: any[]
      colaborador: any
      movilidadDiario: number
      fingerprint: string
    }
  ): Promise<void> {
    const {
      report,
      config,
      expenses: rawExpenses,
      advances,
      colaborador,
      movilidadDiario,
      fingerprint,
    } = ctx
    // Orden pedido por Contabilidad para revisar el Excel: agrupado por tipo de
    // documento y, dentro de un mismo tipo, por fecha de emisión ascendente.
    const expenses = this.sortExpensesForAsiento(rawExpenses, report)
    // Alcance de datos = la empresa DUEÑA de la rendición, no la del caller (ya
    // verificadas iguales en `loadContext`, pero se usa report.clientId explícitamente
    // para que categorías/proyectos jamás se resuelvan contra el clientId equivocado).
    const dataClientId = report.clientId?.toString() ?? clientId

    const [projectMap, categoryMap] = await Promise.all([
      this.buildProjectMap(expenses, advances, report, dataClientId),
      this.buildCategoryMap(expenses, dataClientId),
    ])

    const periodDate = this.resolvePeriodDate(report, advances)
    const [rateMap, cargosMap] = await Promise.all([
      this.prefetchRates(report, expenses, advances, config, movilidadDiario),
      tipos.includes('compra') && expenses.length > 0
        ? this.resolveCargosClasificacion(expenses)
        : Promise.resolve(new Map<string, ExpenseCargoClasificado[]>()),
    ])

    // Los tipos se generan en paralelo: con SheetJS cada workbook es liviano
    // (ya no hay riesgo de OOM que antes obligaba a ir secuencial con ExcelJS),
    // así se solapan las subidas a S3 y escrituras en Mongo. Cada tipo maneja su
    // propio try/catch: un fallo en uno no aborta los demás.
    await Promise.all(
      tipos.map(tipo =>
        this.generateOneTipo(tipo, reportId, clientId, fingerprint, {
          report,
          config,
          expenses,
          advances,
          colaborador,
          movilidadDiario,
          projectMap,
          categoryMap,
          periodDate,
          rateMap,
          cargosMap,
        })
      )
    )
  }

  /** Genera, sube a S3 y persiste UN tipo de asiento. Aísla su error del resto. */
  private async generateOneTipo(
    tipo: AsientoTipo,
    reportId: string,
    clientId: string,
    fingerprint: string,
    ctx: {
      report: any
      config: AccountingConfigDocument
      expenses: any[]
      advances: any[]
      colaborador: any
      movilidadDiario: number
      projectMap: Map<string, any>
      categoryMap: Map<string, any>
      periodDate: Date
      rateMap: Map<string, number>
      cargosMap: Map<string, ExpenseCargoClasificado[]>
    }
  ): Promise<void> {
    const { report } = ctx
    try {
      const warnings: string[] = []
      const lines = await this.buildLinesForTipo(tipo, { ...ctx, warnings })
      const cuadreErrors = this.validateCuadre(lines)
      if (cuadreErrors.length) {
        this.logger.warn(
          `[asientos] cuadre incorrecto en tipo="${tipo}" reportId=${reportId}: ` +
          cuadreErrors
            .map(
              e =>
                `rel=${e.relacionado} filas=${e.filaInicio}-${e.filaFin} doc="${e.documento}" diff=${e.diferencia}`
            )
            .join(', ')
        )
      }
      // Siempre el .xlsm idéntico al template de Contanet (macros, estilos y
      // hojas TABLAS/ImportCONTABILIDAD intactas). Si el template no está
      // disponible en el servidor, `generateContanetExcel` lanza y el catch
      // de este método deja el tipo en estado 'error' con el motivo exacto.
      const { buffer, ext, contentType } = await generateContanetExcel(
        lines,
        tipo
      )
      const filename = this.fileName(tipo, report, ext)
      const asientosCount = this.countAsientos(lines)
      const s3Key = this.s3Key(report.clientId ?? clientId, reportId, tipo, ext)
      await this.uploadService.uploadBuffer(buffer, s3Key, contentType)
      await this.fileModel
        .findOneAndUpdate(
          { reportId: report._id, tipo },
          {
            $set: {
              status: 'ready',
              fingerprint,
              filename,
              s3Key,
              asientosCount,
              cuadreErrors,
              warnings,
              completedAt: new Date(),
              errorMessage: null,
            },
          }
        )
        .exec()
    } catch (error) {
      this.logger.error(
        `[asientos] error generando tipo="${tipo}" reportId=${reportId}: ${(error as Error)?.message}`,
        (error as Error)?.stack
      )
      await this.fileModel
        .findOneAndUpdate(
          { reportId: report._id, tipo },
          {
            $set: {
              status: 'error',
              errorMessage: (error as Error)?.message || 'Error desconocido',
            },
          }
        )
        .exec()
        .catch(() => undefined)
    }
  }

  private s3Key(
    clientId: string,
    reportId: string,
    tipo: AsientoTipo,
    ext: 'xlsm'
  ): string {
    return `accounting-entries/${clientId}/${reportId}/${tipo}.${ext}`
  }

  /**
   * Hash de invalidación. Cualquier cambio en la rendición, sus gastos,
   * los anticipos o la configuración contable produce un fingerprint distinto.
   */
  private computeFingerprint(
    report: any,
    expenses: any[],
    advances: any[],
    config: any
  ): string {
    const ts = (x: any): number => {
      const raw = x?.updatedAt || x?.createdAt
      const t = raw ? new Date(raw).getTime() : 0
      return Number.isNaN(t) ? 0 : t
    }
    const maxTs = (arr: any[]): number =>
      arr.reduce((m, x) => Math.max(m, ts(x)), 0)
    const parts = [
      ts(report),
      report?.status ?? '',
      expenses.length,
      maxTs(expenses),
      advances.length,
      maxTs(advances),
      ts(config),
    ]
    return createHash('sha1').update(parts.join('|')).digest('hex')
  }

  /**
   * Reconciliación de jobs huérfanos: si el proceso se reinició a mitad de
   * una generación, el documento queda en `processing` para siempre. Cada
   * 10 minutos se marcan como error los que llevan más de ese tiempo activos
   * (el usuario puede volver a generar desde el frontend).
   */
  @Cron('*/10 * * * *')
  async reconcileStuckJobs(): Promise<void> {
    const threshold = new Date(Date.now() - STALE_PROCESSING_MS)
    const result = await this.fileModel
      .updateMany(
        { status: 'processing', startedAt: { $lt: threshold } },
        {
          $set: {
            status: 'error',
            errorMessage:
              'Generación interrumpida. Vuelve a generar el archivo.',
          },
        }
      )
      .exec()
    if (result.modifiedCount) {
      this.logger.warn(
        `[asientos] ${result.modifiedCount} job(s) huérfano(s) marcados como error`
      )
    }
  }

  private fileName(tipo: AsientoTipo, report: any, ext: 'xlsm'): string {
    const code =
      report.codigo || report._id?.toString()?.slice(-6) || 'rendicion'
    return `asientos_${tipo}_${code}.${ext}`
  }

  /** Fecha de referencia para ejercicio/periodo: inicio de la solicitud. */
  private resolvePeriodDate(report: any, advances: any[]): Date {
    const advStarts = (advances ?? [])
      .map(a => a?.startDate || a?.createdAt)
      .filter(Boolean)
      .map(d => new Date(d))
      .filter(d => !Number.isNaN(d.getTime()))
    if (advStarts.length) {
      return advStarts.sort((a, b) => a.getTime() - b.getTime())[0]
    }
    const raw = report?.startDate || report?.createdAt
    const d = raw ? new Date(raw) : new Date()
    return Number.isNaN(d.getTime()) ? new Date() : d
  }

  /** Prefetch del tipo de cambio (PEN/USD) de todas las fechas del lote. */
  private async prefetchRates(
    report: any,
    expenses: any[],
    advances: any[],
    config: AccountingConfigDocument,
    movilidadDiario: number
  ): Promise<Map<string, number>> {
    const dates = new Set<string>()
    const add = (d: Date) => dates.add(d.toISOString().slice(0, 10))
    for (const e of expenses) add(this.asientoDate(e, report))
    for (const a of advances) {
      const d = a?.payment?.transferDate || a?.startDate || a?.createdAt
      if (d) add(new Date(d))
    }
    if (report?.updatedAt) add(new Date(report.updatedAt))
    add(this.resolvePeriodDate(report, advances))

    // Los bloques de Aplicación de planilla de movilidad usan fechas
    // SINTÉTICAS (buildMovilidadBlocks: startDate+1, +2, ... — no las de
    // `mobilityRows`). Sin esto, esos días no se prefetchean y `tcFor` cae
    // al fallback `config.tipoCambio` (a veces 1) en vez del tipo de cambio
    // real de esa fecha.
    const movilidadExpenses = expenses.filter(
      e => e.expenseType === 'planilla_movilidad'
    )
    if (movilidadExpenses.length) {
      for (const block of this.buildMovilidadBlocks(
        movilidadExpenses,
        report,
        movilidadDiario
      )) {
        add(block.date)
      }
    }

    const fallback = Number(config.tipoCambio) || 1
    const isoList = Array.from(dates)
    // Una sola consulta a BD para las cacheadas + API solo para las faltantes.
    const rates = await this.exchangeRateService.getRatesBatch(isoList)
    const map = new Map<string, number>()
    for (const iso of isoList) map.set(iso, rates.get(iso) ?? fallback)
    return map
  }

  /** Tipo de cambio (PEN/USD) de una fecha, desde el mapa prefetcheado. */
  private tcFor(
    date: Date,
    rateMap: Map<string, number>,
    config: AccountingConfigDocument
  ): number {
    const iso = date.toISOString().slice(0, 10)
    return rateMap.get(iso) ?? (Number(config.tipoCambio) || 1)
  }

  private async buildLinesForTipo(
    tipo: AsientoTipo,
    ctx: {
      report: any
      config: AccountingConfigDocument
      expenses: any[]
      advances: any[]
      colaborador: any
      movilidadDiario: number
      projectMap: Map<string, any>
      categoryMap: Map<string, any>
      periodDate: Date
      rateMap: Map<string, number>
      cargosMap: Map<string, ExpenseCargoClasificado[]>
      /** Se llena con avisos de configuración (ej. categoría sin cuenta 9X). */
      warnings: string[]
    }
  ): Promise<ContanetLine[]> {
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

  /**
   * Cast explícito string → ObjectId para filtros de query. IMPRESCINDIBLE en este
   * proyecto: los paths declarados con `@Prop({ type: Types.ObjectId })` quedan como
   * SchemaType **Mixed** en runtime (verificado con `schema.path('clientId').instance`),
   * y los paths Mixed NO castean — un filtro string jamás matchea el ObjectId
   * almacenado y la query devuelve vacío en silencio. Es la misma razón por la que
   * CategoryService/ProjectService castean con `new Types.ObjectId(...)` en cada query.
   */
  private toObjectId(value: string): Types.ObjectId | string {
    return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : value
  }

  /** Ids válidos casteados a ObjectId (los inválidos se descartan: no resolverían). */
  private toObjectIds(values: Iterable<string>): Types.ObjectId[] {
    return [...values]
      .filter(v => Types.ObjectId.isValid(v))
      .map(v => new Types.ObjectId(v))
  }

  /** Mapa categoryId → categoría (para resolver cuentas 9X/6X). */
  private async buildCategoryMap(
    expenses: any[],
    clientId: string
  ): Promise<Map<string, any>> {
    const ids = new Set<string>()
    for (const e of expenses) {
      if (e.categoryId) ids.add(e.categoryId.toString())
    }
    const categories = (
      ids.size
        ? await this.categoryModel
          .find({
            _id: { $in: this.toObjectIds(ids) },
            clientId: this.toObjectId(clientId),
          })
          .lean()
          .exec()
        : []
    ) as any[]
    const map = new Map<string, any>()
    for (const c of categories) map.set(c._id.toString(), c)
    return map
  }

  // ----------------------------------------------------------------------
  // Helpers de datos
  // ----------------------------------------------------------------------

  private async buildProjectMap(
    expenses: any[],
    advances: any[],
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
    for (const a of advances) {
      if (a.projectId) ids.add(a.projectId.toString())
    }
    const projects = (
      ids.size
        ? await this.projectModel
          .find({
            _id: { $in: this.toObjectIds(ids) },
            clientId: this.toObjectId(clientId),
          })
          .populate('lineaNegocioId', 'name code')
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

  /**
   * Fecha del asiento: fechaEmision del comprobante o fecha del reporte.
   * `expense.fechaEmision` se persiste como texto dd/MM/yyyy (ver
   * fecha-emision.util.ts); `new Date(raw)` nativo la interpreta como
   * MM/DD/YYYY y produce fechas incorrectas o inválidas, por eso se parsea
   * con `parseFechaEmisionInput` en vez de pasarla directo al constructor.
   *
   * Planilla de movilidad NUNCA trae `fechaEmision` propio (solo
   * `mobilityRows[].fecha` por trayecto; ver `createMobilityExpense` en
   * expense.service.ts) — sin este caso especial caía siempre al fallback
   * `report.createdAt`, igual para TODAS las planillas de la rendición, y el
   * orden por fecha (`sortExpensesForAsiento`) no tenía nada que ordenar. Se
   * usa la fecha MÁS ANTIGUA de `mobilityRows`, igual que el frontend
   * (`getExpenseDate` en rendicion-detail.component.ts) para que ambos
   * documentos (PDF completo y Excel de asientos) muestren la misma fecha.
   */
  private asientoDate(expense: any, report: any): Date {
    if (
      expense?.expenseType === 'planilla_movilidad' &&
      Array.isArray(expense.mobilityRows)
    ) {
      const rowDates = (expense.mobilityRows as Array<{ fecha?: string }>)
        .map(r => parseFechaEmisionInput(r?.fecha))
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())
      if (rowDates.length) return rowDates[0]
    }
    const fromComprobante = parseFechaEmisionInput(expense?.fechaEmision)
    if (fromComprobante) return fromComprobante
    const raw = report?.createdAt || report?.updatedAt
    const d = raw ? new Date(raw) : new Date()
    return Number.isNaN(d.getTime()) ? new Date() : d
  }

  /**
   * Orden de los comprobantes para los builders que listan un bloque por
   * documento (compra/aplicación): agrupados por "Codigo Tipo Document"
   * (resolveCodTipDoc) y, dentro de un mismo tipo, por fecha de emisión
   * ascendente. No muta `expenses` (se usa también para prefetch/mapas).
   */
  private sortExpensesForAsiento(expenses: any[], report: any): any[] {
    return [...expenses].sort((a, b) => {
      const codA = resolveCodTipDoc(a, this.parseData(a).tipoComprobante)
      const codB = resolveCodTipDoc(b, this.parseData(b).tipoComprobante)
      if (codA !== codB) return codA.localeCompare(codB)
      return (
        this.asientoDate(a, report).getTime() -
        this.asientoDate(b, report).getTime()
      )
    })
  }

  /**
   * Planillas de movilidad ordenadas para el asiento: por su fecha real
   * (mobilityRows, vía asientoDate) ascendente y, a igualdad, por createdAt.
   * Cada planilla es un documento INDEPENDIENTE con su propio internalCode
   * (correlativo AML012, AML013, ...); el asiento ya no las consolida.
   */
  private orderMovilidadForAsiento(
    movilidadExpenses: any[],
    report: any
  ): any[] {
    return [...movilidadExpenses].sort((a, b) => {
      const da = this.asientoDate(a, report).getTime()
      const db = this.asientoDate(b, report).getTime()
      if (da !== db) return da - db
      const ca = new Date(a.createdAt || 0).getTime()
      const cb = new Date(b.createdAt || 0).getTime()
      return ca - cb
    })
  }

  private toDateOrNull(value: unknown): Date | null {
    if (!value) return null
    const d = new Date(value as string | number | Date)
    return Number.isNaN(d.getTime()) ? null : d
  }

  /**
   * Bloques (fecha, monto, expense) de las planillas de movilidad de la
   * rendición. Cada planilla es un documento INDEPENDIENTE: su total se
   * reparte en tramos de `movilidadDiario` (p.ej. S/40) y cada bloque queda
   * asociado a SU expense — el asiento emite luego cada tramo con el
   * internalCode (Numero Documento) de la planilla a la que pertenece.
   *
   * Fechas SINTÉTICAS: una secuencia de días consecutivos empezando el día
   * siguiente a report.startDate/viaticoStartDate, con un cursor CORRIDO
   * entre planillas para que no colisionen en las mismas fechas (el PDF NO
   * usa las fechas reales de `mobilityRows` para esto). Si no hay suficientes
   * días de viaje para cubrir todos los bloques, arranca en startDate. Sin
   * startDate/endDate, cae a un único bloque por planilla en la fecha de su
   * comprobante más antiguo.
   */
  private buildMovilidadBlocks(
    movilidadExpenses: any[],
    report: any,
    movilidadDiario: number
  ): Array<{ date: Date; monto: number; expense: any }> {
    const ordered = this.orderMovilidadForAsiento(movilidadExpenses, report)
    const totalOf = (e: any): number => {
      const rowsTotal = Array.isArray(e.mobilityRows)
        ? (e.mobilityRows as Array<{ total?: number }>).reduce(
          (s, r) => s + (Number(r?.total) || 0),
          0
        )
        : 0
      return this.round2(Number(e.total) || rowsTotal || 0)
    }

    const blocks: Array<{ date: Date; monto: number; expense: any }> = []
    const startDate = this.toDateOrNull(
      report?.startDate ?? report?.viaticoStartDate
    )
    const endDate = this.toDateOrNull(report?.endDate ?? report?.viaticoEndDate)

    if (startDate && endDate) {
      const day2 = new Date(startDate)
      day2.setDate(day2.getDate() + 1)
      const msPerDay = 24 * 60 * 60 * 1000
      const daysFromDay2 = Math.max(
        0,
        Math.round((endDate.getTime() - day2.getTime()) / msPerDay) + 1
      )
      const grandTotal = this.round2(
        ordered.reduce((s, e) => s + totalOf(e), 0)
      )
      const rowsNeeded = Math.ceil(grandTotal / movilidadDiario)
      const cur =
        rowsNeeded <= daysFromDay2 ? new Date(day2) : new Date(startDate)
      for (const e of ordered) {
        let remaining = totalOf(e)
        while (remaining > 0.005) {
          const monto = this.round2(Math.min(movilidadDiario, remaining))
          blocks.push({ date: new Date(cur), monto, expense: e })
          remaining = this.round2(remaining - monto)
          cur.setDate(cur.getDate() + 1)
        }
      }
    } else {
      for (const e of ordered) {
        const monto = totalOf(e)
        if (monto > 0.005) {
          blocks.push({ date: this.asientoDate(e, report), monto, expense: e })
        }
      }
    }
    return blocks
  }

  /**
   * Resuelve las porciones analíticas de un comprobante (factura).
   * Prioridad: (1) detalleAnalitico explícito, (2) totales de `comprobanteDetallado`
   * (gravada/exonerada/inafecta + recargo al consumo + ISC/ICBPER deterministas
   * + otros cargos clasificados), (3) base/IGV/inafecto sueltos.
   */
  private resolvePortions(
    expense: any,
    cargosClasificados: ExpenseCargoClasificado[] = []
  ): AnalyticPortion[] {
    const proyectId = expense.proyectId?.toString()

    // (1) Detalle explícito (corregido por Contabilidad)
    const detalle: AnalyticPortion[] = (expense.detalleAnalitico ?? []).map(
      (d: any) => ({
        proyectId: d.proyectId?.toString() || proyectId,
        condicion: d.condicion === 'inafecto' ? 'inafecto' : 'afecto',
        monto: this.round2(Number(d.monto) || 0),
        etiqueta: undefined,
      })
    )
    if (detalle.length) return detalle

    // (2) Totales del objeto detallado de la factura
    const tot = expense.comprobanteDetallado?.totales ?? {}
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
    const gravada = num(tot.operacionGravada)
    const exonerada = num(tot.operacionExonerada)
    const inafectaOp = num(tot.operacionInafecta)
    const gratuita = num(tot.operacionGratuita)
    const recargo =
      num(expense.comprobanteDetallado?.recargoConsumo) || num(expense.inafecto)

    const portions: AnalyticPortion[] = []
    if (gravada > 0)
      portions.push({
        proyectId,
        condicion: 'afecto',
        monto: this.round2(gravada),
      })
    if (exonerada > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(exonerada),
      })
    if (inafectaOp > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(inafectaOp),
      })
    if (gratuita > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(gratuita),
      })
    if (recargo > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(recargo),
        etiqueta: 'RECARGO DE CONSUMO',
      })

    // Cargos ≠ IGV deterministas (sin IA): ISC e ICBPER son deducibles y van
    // con la misma cuenta de la categoría, como porciones inafectas.
    const isc = num(tot.isc)
    const icbper = num(tot.icbper)
    if (isc > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(isc),
        etiqueta: 'ISC',
      })
    if (icbper > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(icbper),
        etiqueta: 'ICBPER',
      })

    // Otros cargos (otrosTributos/otrosCargos) según su clasificación:
    // deducible → porción normal; no deducible → serie de control interno.
    for (const cargo of cargosClasificados) {
      if (cargo.monto <= 0) continue
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(cargo.monto),
        etiqueta: cargo.deducible
          ? cargo.concepto === 'otrosTributos'
            ? 'OTROS TRIBUTOS'
            : 'OTROS CARGOS'
          : 'NO DEDUCIBLE',
        ...(cargo.deducible
          ? {}
          : { serieNoDeducible: cargo.serieControlInterno || '0001' }),
      })
    }
    if (portions.length) return portions

    // (3) Respaldo: base/IGV/inafecto sueltos o solo el total
    const total = Number(expense.total) || 0
    const igv = Number(expense.igv) || 0
    const inafecto = Number(expense.inafecto) || 0
    const base =
      Number(expense.baseAfecta) || Math.max(total - igv - inafecto, 0)
    if (base > 0)
      portions.push({
        proyectId,
        condicion: 'afecto',
        monto: this.round2(base),
      })
    if (inafecto > 0)
      portions.push({
        proyectId,
        condicion: 'inafecto',
        monto: this.round2(inafecto),
      })
    if (!portions.length && total > 0)
      portions.push({
        proyectId,
        condicion: 'afecto',
        monto: this.round2(total),
      })
    return portions
  }

  /**
   * Porciones de un documento SIN derecho a crédito fiscal (boleta, ticket,
   * planilla de movilidad, recibos, DJ, otros): todo el importe es gasto.
   * El detalleAnalitico explícito (corregido por Contabilidad) sigue mandando.
   */
  private resolveNonFacturaPortions(expense: any): AnalyticPortion[] {
    const proyectId = expense.proyectId?.toString()
    const detalle: AnalyticPortion[] = (expense.detalleAnalitico ?? []).map(
      (d: any) => ({
        proyectId: d.proyectId?.toString() || proyectId,
        condicion: d.condicion === 'inafecto' ? 'inafecto' : 'afecto',
        monto: this.round2(Number(d.monto) || 0),
      })
    )
    if (detalle.length) return detalle

    const det = expense.comprobanteDetallado ?? {}
    const total = this.round2(
      Number(expense.total) || Number(det?.totales?.importeTotal) || 0
    )
    if (total <= 0) return []
    return [{ proyectId, condicion: 'inafecto', monto: total }]
  }

  private round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100
  }

  /**
   * Línea base con los campos comunes a todo asiento.
   * `date` = fecha del comprobante (para las columnas de fechas y el tipo de cambio).
   * `periodDate` = fecha de inicio de la solicitud (para ejercicio/periodo).
   * `tc` = tipo de cambio PEN/USD del día.
   */
  private baseLine(
    config: AccountingConfigDocument,
    date: Date,
    fuente: string,
    glosa: string,
    tc: number,
    periodDate: Date,
    extra: ContanetLine = {}
  ): ContanetLine {
    const serial = toExcelSerial(date)
    return {
      ejercicio: periodDate.getUTCFullYear(),
      periodo: String(periodDate.getUTCMonth() + 1).padStart(2, '0'),
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
      cambioMoneda: tc,
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

  /**
   * Aplica el centro de costo del proyecto a una línea. El "Codigo Centro Costo"
   * recibe el código de la línea de negocio del proyecto (ej. SC), no el del
   * proyecto/centro de costo en sí; si el proyecto no tiene línea de negocio
   * asignada, cae a `project.centroCosto`/`project.code`. El "Codigo Sub Centro
   * Costo" sigue identificando al centro de costo (proyecto) en sí.
   */
  private applyProjectCostCenter(
    line: ContanetLine,
    project: any | undefined
  ): void {
    if (!project) return
    const cc =
      project.lineaNegocioId?.code || project.centroCosto || project.code || ''
    const sub =
      project.subCentroCosto || project.centroCosto || project.code || ''
    if (cc) line.centroCosto = cc
    if (sub) {
      line.subCentroCosto = sub
      line.subSubCentroCosto = sub
    }
    if (project.area) line.area = project.area
  }

  /**
   * Resuelve el proyecto de una línea probando IDs candidatos en orden de
   * prioridad (ej. el proyecto propio del gasto/anticipo, luego el de la
   * rendición); el primero que resuelva en `projectMap` gana. Si ninguno
   * resuelve, `applyProjectCostCenter` cae al centro de costo global de la
   * config (comportamiento previo).
   */
  private resolveLineProject(
    projectMap: Map<string, any>,
    ...ids: Array<{ toString(): string } | undefined | null>
  ): any | undefined {
    for (const id of ids) {
      if (!id) continue
      const project = projectMap.get(id.toString())
      if (project) return project
    }
    return undefined
  }

  /** Subcuenta 14 del colaborador (parametrizada o construida con la raíz). */
  private cuenta14(config: AccountingConfigDocument, colaborador: any): string {
    if (colaborador?.subcuenta14) return colaborador.subcuenta14
    return config.cuenta14Raiz
  }

  // ----------------------------------------------------------------------
  // Cargos ≠ IGV — clasificación de deducibilidad (IA solo si es necesario)
  // ----------------------------------------------------------------------

  /**
   * Cargos del comprobante que requieren clasificación de deducibilidad.
   * `recargoConsumo`, `isc` e `icbper` NO pasan por aquí: son deducibles por
   * regla determinista y se resuelven directo en `resolvePortions`.
   */
  private extractCargosDesconocidos(
    expense: any
  ): Array<{ concepto: string; monto: number }> {
    const tot = expense?.comprobanteDetallado?.totales ?? {}
    const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
    const out: Array<{ concepto: string; monto: number }> = []
    const otrosTributos = this.round2(num(tot.otrosTributos))
    const otrosCargos = this.round2(num(tot.otrosCargos))
    if (otrosTributos > 0)
      out.push({ concepto: 'otrosTributos', monto: otrosTributos })
    if (otrosCargos > 0)
      out.push({ concepto: 'otrosCargos', monto: otrosCargos })
    return out
  }

  /** Hash de los cargos: si no cambian, la clasificación persistida sigue válida. */
  private cargosHash(
    cargos: Array<{ concepto: string; monto: number }>
  ): string {
    return createHash('sha1').update(JSON.stringify(cargos)).digest('hex')
  }

  /**
   * Clasifica los cargos ≠ IGV de las facturas de la rendición.
   * Orden de resolución (para minimizar IA):
   *  1. Sin cargos desconocidos → nada que hacer (caso común, 0 IA).
   *  2. Clasificación ya persistida en el expense con el mismo hash → reuso.
   *  3. Restantes → UN solo request batcheado a DeepSeek; el veredicto se
   *     persiste en el expense (sin tocar updatedAt, no invalida la caché).
   * Si la IA falla, los cargos se tratan como deducibles (revisión manual).
   *
   * NOTA: excluir un cargo aquí (por palabra clave u otro criterio) sin
   * ajustar también el total que recibe la cuenta 42 (Haber) desincuadra el
   * asiento — el Debe (9X/6X) queda corto en exactamente ese monto frente al
   * Haber (42), que sigue reflejando el importeTotal íntegro del comprobante.
   * Ver descuadres reportados en documentos REPSOL (2026-07-08): la exclusión
   * por `inafectoKeywords` se revirtió por esta razón.
   */
  private async resolveCargosClasificacion(
    expenses: any[]
  ): Promise<Map<string, ExpenseCargoClasificado[]>> {
    const map = new Map<string, ExpenseCargoClasificado[]>()
    const pendientes: Array<{
      expense: any
      cargos: Array<{ concepto: string; monto: number }>
      hash: string
    }> = []

    for (const expense of expenses) {
      if (expense.expenseType && expense.expenseType !== 'factura') continue
      const cargos = this.extractCargosDesconocidos(expense)
      if (!cargos.length) continue
      const hash = this.cargosHash(cargos)
      const stored: ExpenseCargosClasificacion | undefined =
        expense.otrosCargosClasificacion
      if (stored?.hash === hash && Array.isArray(stored.cargos)) {
        map.set(expense._id.toString(), stored.cargos)
      } else {
        pendientes.push({ expense, cargos, hash })
      }
    }
    if (!pendientes.length) return map

    // Contexto por cargo para el prompt (idx global sobre todos los pendientes).
    // Se recorta el texto para no gastar tokens de más: la deducibilidad se
    // decide con el proveedor/concepto y unas pocas líneas de ítems; enviar 50
    // ítems completos o descripciones largas no aporta y encarece cada request.
    const trunc = (s: string, max: number) =>
      s.length > max ? s.slice(0, max) + '…' : s
    const contexts: CargoContext[] = []
    const owners: Array<{
      pendiente: (typeof pendientes)[0]
      cargoIdx: number
    }> = []
    for (const pendiente of pendientes) {
      const det = pendiente.expense.comprobanteDetallado ?? {}
      const items: string[] = (det.items ?? [])
        .map((it: any) => String(it?.descripcion || '').trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((d: string) => trunc(d, 60))
      pendiente.cargos.forEach((cargo, cargoIdx) => {
        contexts.push({
          idx: contexts.length + 1,
          concepto: cargo.concepto,
          monto: cargo.monto,
          proveedor: trunc(det?.emisor?.razonSocial || '', 80),
          descripcion: trunc(pendiente.expense.comentario || '', 120),
          items,
          leyendas: trunc(det?.leyendas || '', 120),
          observaciones: trunc(det?.observaciones || '', 120),
        })
        owners.push({ pendiente, cargoIdx })
      })
    }

    // Por defecto (o si la IA falla): deducible, sin serie de control.
    const verdicts: Array<{ deducible: boolean; serie?: string }> =
      contexts.map(() => ({ deducible: true }))

    try {
      const completion = await this.openai.chat.completions.create(
        {
          model: this.aiModel,
          messages: [
            { role: 'user', content: buildDeducibilidadPrompt(contexts) },
          ],
          temperature: 0,
          // La respuesta es un JSON array diminuto (idx/deducible/serie por
          // cargo); 512 sobra y evita que el modelo se extienda de más.
          max_tokens: 512,
        },
        { timeout: 60000 }
      )
      const rawContent = (completion.choices[0]?.message?.content || '').trim()
      const raw = rawContent
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim()
      const parsed: Array<{
        idx: number
        deducible?: boolean
        serie?: string
      }> = JSON.parse(raw)
      for (const entry of parsed) {
        const verdict = verdicts[entry.idx - 1]
        if (!verdict) continue
        if (entry.deducible === false) {
          const serie = String(entry.serie || '')
          verdict.deducible = false
          verdict.serie = SERIES_NO_DEDUCIBLE.has(serie) ? serie : '0001'
        }
      }
      this.logger.log(
        `[asientos] IA clasificó deducibilidad de ${contexts.length} cargos`
      )
    } catch (error) {
      this.logger.warn(
        `[asientos] IA no pudo clasificar cargos: ${(error as Error)?.message}. ` +
        'Se tratan como deducibles.'
      )
    }

    // Agrupa por expense, alimenta el mapa y persiste (best-effort).
    const byExpense = new Map<string, ExpenseCargoClasificado[]>()
    owners.forEach(({ pendiente, cargoIdx }, i) => {
      const id = pendiente.expense._id.toString()
      const list = byExpense.get(id) ?? []
      const cargo = pendiente.cargos[cargoIdx]
      const verdict = verdicts[i]
      list.push({
        concepto: cargo.concepto,
        monto: cargo.monto,
        deducible: verdict.deducible,
        ...(verdict.serie ? { serieControlInterno: verdict.serie } : {}),
      })
      byExpense.set(id, list)
    })
    for (const pendiente of pendientes) {
      const id = pendiente.expense._id.toString()
      const cargos = byExpense.get(id) ?? []
      map.set(id, cargos)
      // timestamps:false — no altera updatedAt, así el fingerprint de la caché
      // de asientos no se invalida por esta escritura interna.
      void this.expenseModel
        .updateOne(
          { _id: pendiente.expense._id },
          {
            $set: {
              otrosCargosClasificacion: { hash: pendiente.hash, cargos },
            },
          },
          { timestamps: false }
        )
        .exec()
        .catch((error: Error) =>
          this.logger.warn(
            `[asientos] no se pudo persistir clasificación de cargos: ${error.message}`
          )
        )
    }
    return map
  }

  // ----------------------------------------------------------------------
  // C2 — Builder COMPRA (registro de la compra, por comprobante)
  // ----------------------------------------------------------------------

  private async buildCompraLines(ctx: {
    report: any
    config: AccountingConfigDocument
    expenses: any[]
    projectMap: Map<string, any>
    categoryMap: Map<string, any>
    periodDate: Date
    rateMap: Map<string, number>
    cargosMap: Map<string, ExpenseCargoClasificado[]>
    warnings: string[]
  }): Promise<ContanetLine[]> {
    const {
      config,
      expenses,
      report,
      projectMap,
      categoryMap,
      periodDate,
      rateMap,
      cargosMap,
      warnings,
    } = ctx
    const lines: ContanetLine[] = []
    // Dedup: una advertencia por categoría (o "sin categoría"), no por comprobante.
    const warnedCategoryKeys = new Set<string>()
    let relacionado = 1
    let correlativo = 1

    for (const expense of expenses) {
      const data = this.parseData(expense)
      const det = expense.comprobanteDetallado ?? {}
      const date = this.asientoDate(expense, report)
      const tc = this.tcFor(date, rateMap, config)
      const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

      // Tipo de documento Contanet (codigos.md). Solo la factura (01) entra al
      // registro de compra: es la única que otorga crédito fiscal y requiere
      // provisión formal de proveedor. Boleta/ticket/planilla/recibo/otros
      // (código != 01) no generan asiento de compra — solo cancelan la cuenta
      // 14 en el asiento de Aplicación (`buildAplicacionLines`, que sí procesa
      // todos los comprobantes sin filtrar por tipo de documento).
      const codTipDoc = resolveCodTipDoc(expense, data.tipoComprobante)
      const esFactura = codTipDoc === TIPO_DOCUMENTO.FT
      if (!esFactura) continue

      // Cuenta principal: SIEMPRE de la categoría seleccionada en el documento.
      // Destino 6X: category.cuentaDestino6x → config.cuenta79 (fallback).
      const category = expense.categoryId
        ? categoryMap.get(expense.categoryId.toString())
        : undefined
      const cuenta9x = category?.cuenta || ''
      const cuenta6xCat = category?.cuentaDestino6x || config.cuenta79

      // Sin cuenta 9X no se puede emitir esa línea (VIATIKA no inventa cuentas
      // contables); el comprobante queda descuadrado por el monto de sus
      // porciones. Avisar la causa exacta en vez de dejar que Contabilidad
      // adivine a partir de un "descuadre" genérico.
      if (!cuenta9x) {
        const categoryKey =
          category?._id?.toString() ||
          expense.categoryId?.toString() ||
          'sin-categoria'
        if (!warnedCategoryKeys.has(categoryKey)) {
          warnedCategoryKeys.add(categoryKey)
          // Tres causas distintas, cada una con acción distinta:
          //  1. La categoría existe pero no tiene 9X configurada → falta configuración.
          //  2. El comprobante tiene un categoryId que NO resuelve a ninguna categoría
          //     (borrada, o de otra empresa) → dato roto, no un simple "falta configurar".
          //  3. El comprobante nunca tuvo categoría asignada.
          const msg = category
            ? `La categoría "${category.name}" no tiene la Cuenta Analítica 9X configurada (Categorías → editar categoría). Sus comprobantes quedarán descuadrados hasta configurarla.`
            : expense.categoryId
              ? `Un comprobante tiene asignada una categoría (id ${categoryKey}) que ya no existe o no pertenece a esta empresa. Reasígnale una categoría válida desde el detalle del gasto.`
              : 'Hay comprobantes sin categoría asignada: no se puede generar su línea analítica 9X. Asígnales una categoría desde el detalle del gasto.'
          warnings.push(msg)
          this.logger.warn(`[asientos] ${msg} (categoryId=${categoryKey})`)
        }
      }

      // Falta la Cuenta Destino 6X (gasto por naturaleza, clase 6): el par destino
      // cae al fallback `config.cuenta79` y sale como 79/79 (mismo cargo/abono, se
      // cancela solo y NO registra el gasto por naturaleza). No descuadra, pero el
      // asiento queda contablemente incompleto. Se avisa aparte de la 9X.
      if (category && !category.cuentaDestino6x) {
        const dest6xKey = `${category._id?.toString()}:6x`
        if (!warnedCategoryKeys.has(dest6xKey)) {
          warnedCategoryKeys.add(dest6xKey)
          const msg = `La categoría "${category.name}" no tiene la Cuenta Destino 6X configurada (Categorías → editar categoría). El asiento de destino saldrá como 79/79 en vez de 6X/79, sin registrar el gasto por naturaleza.`
          warnings.push(msg)
          this.logger.warn(
            `[asientos] ${msg} (categoryId=${category._id?.toString()})`
          )
        }
      }

      // Centro de costo del proyecto del gasto (aplica a todas las líneas).
      const expenseProject = expense.proyectId
        ? projectMap.get(expense.proyectId.toString())
        : undefined

      // IGV: solo la factura da derecho a crédito fiscal (línea 40). Si
      // Contabilidad revisó el desglose manualmente, sus valores ganan; si no,
      // manda `comprobanteDetallado`. (Este builder solo procesa facturas,
      // ver `if (!esFactura) continue` arriba.)
      const igv = this.round2(
        expense.desgloseRevisado
          ? Number(expense.igv) || 0
          : num(det?.totales?.igv) || Number(expense.igv) || 0
      )
      const cargos = cargosMap.get(expense._id.toString()) ?? []
      const portions = this.resolvePortions(expense, cargos)
      const baseTotal = this.round2(portions.reduce((s, p) => s + p.monto, 0))
      const total = this.round2(
        num(det?.totales?.importeTotal) ||
        Number(expense.total) ||
        baseTotal + igv
      )
      const cur = this.resolveComprobanteCurrency(config, expense, total, tc)

      // Absorción del residuo de redondeo. La analítica (Debe) se reconstruye
      // redondeando cada porción y el IGV por separado, mientras el Haber
      // (cuenta 42) usa el importeTotal impreso del comprobante. Como
      // round-cada-parte-y-sumar != round-del-total, aparece una deriva de
      // ±0.01 que descuadra el asiento sin que haya error contable. Si el
      // desfase es un residuo de centavos (no un descuadre real por falta de
      // cuenta 9X u otro dato), se suma a la porción de mayor monto para que
      // Debe iguale exactamente al importeTotal del Haber. El par destino
      // 6X/79 se recalcula desde la misma porción, así que sigue cuadrando.
      const RESIDUO_MAX = 0.05
      if (cuenta9x && portions.length) {
        const residuo = this.round2(total - baseTotal - igv)
        if (residuo !== 0 && Math.abs(residuo) <= RESIDUO_MAX) {
          let maxIdx = 0
          for (let i = 1; i < portions.length; i++) {
            if (portions[i].monto > portions[maxIdx].monto) maxIdx = i
          }
          portions[maxIdx].monto = this.round2(portions[maxIdx].monto + residuo)
        }
      }

      const serie = det?.comprobante?.serie || data.serie || ''
      const nroDoc =
        det?.comprobante?.correlativo ||
        data.correlativo ||
        expense.internalCode ||
        ''
      const ruc = det?.emisor?.ruc || data.rucEmisor || ''
      const razonSocial =
        det?.emisor?.razonSocial ||
        data.razonSocial ||
        expense.providerName ||
        ''
      const glosaBase = (expense.comentario || data.comentario || 'GASTO')
        .toString()
        .slice(0, 100)
        .toUpperCase()

      const push = (line: ContanetLine) => {
        // Centro de costo en todas las líneas del comprobante.
        this.applyProjectCostCenter(line, expenseProject)
        line.relacionado = relacionado
        line.correlativo = correlativo++
        lines.push(line)
      }

      // (1) Cuentas 9X — analítica por porción (Debe); omitir si no hay cuenta configurada.
      // Porción NO deducible: "Codigo Tipo Document" vacío y la serie de control
      // interno (0001/0003/0008) en "Numero Documento" (nodeducible.md).
      if (cuenta9x) {
        for (const p of portions) {
          const glosa = p.etiqueta ? `${glosaBase} (${p.etiqueta})` : glosaBase
          const docFields = p.serieNoDeducible
            ? { codTipDoc: '', nroSerie: '', nroDoc: p.serieNoDeducible }
            : { codTipDoc, nroSerie: serie, nroDoc }
          push(
            this.baseLine(
              config,
              date,
              config.fuenteCompra,
              glosa,
              cur.cambioMoneda,
              periodDate,
              {
                nroCuenta: cuenta9x,
                ...docFields,
                mdaOrigen: cur.mdaOrigen,
                identTipAfecto: p.condicion === 'afecto' ? 'S' : 'N',
                montoDebe: this.round2(p.monto * cur.fxFactor),
                montoDebeME: this.toMEForComprobante(
                  p.monto,
                  cur.isForeign,
                  tc
                ),
              }
            )
          )
        }
      }

      // (2) Cuenta 40 — IGV (Debe), solo facturas con IGV.
      // Las cuentas 40x son tributos por pagar, no llevan Numero Serie /
      // Numero Documento (esos campos identifican al proveedor en la 42/9X).
      if (igv > 0) {
        const cuenta40 = this.resolveCuenta40(config, expense.tasaIgv)
        push(
          this.baseLine(
            config,
            date,
            config.fuenteCompra,
            glosaBase,
            cur.cambioMoneda,
            periodDate,
            {
              nroCuenta: cuenta40,
              mdaOrigen: cur.mdaOrigen,
              montoDebe: this.round2(igv * cur.fxFactor),
              montoDebeME: this.toMEForComprobante(igv, cur.isForeign, tc),
            }
          )
        )
      }

      // (3) Cuenta 42 — total del comprobante (Haber), provisión + proveedor
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCompra,
          glosaBase,
          cur.cambioMoneda,
          periodDate,
          {
            nroCuenta: config.cuenta42,
            codTipDoc,
            nroSerie: serie,
            nroDoc,
            mdaOrigen: cur.mdaOrigen,
            montoHaber: this.round2(total * cur.fxFactor),
            montoHaberME: this.toMEForComprobante(total, cur.isForeign, tc),
            esProvision: 1,
            codTipDocIdentProv: ruc ? '06' : '',
            nroDocProv: ruc,
            razonSocialProv: razonSocial,
          }
        )
      )

      // (4) Destino — par 6X (Debe) / 79 (Haber) por porción
      for (const p of portions) {
        const glosa = p.etiqueta ? `${glosaBase} (${p.etiqueta})` : glosaBase
        push(
          this.baseLine(
            config,
            date,
            config.fuenteCompra,
            glosa,
            cur.cambioMoneda,
            periodDate,
            {
              nroCuenta: cuenta6xCat,
              mdaOrigen: cur.mdaOrigen,
              montoDebe: this.round2(p.monto * cur.fxFactor),
              montoDebeME: this.toMEForComprobante(p.monto, cur.isForeign, tc),
              esDestino: 1,
            }
          )
        )
        push(
          this.baseLine(
            config,
            date,
            config.fuenteCompra,
            glosa,
            cur.cambioMoneda,
            periodDate,
            {
              nroCuenta: config.cuenta79,
              mdaOrigen: cur.mdaOrigen,
              montoHaber: this.round2(p.monto * cur.fxFactor),
              montoHaberME: this.toMEForComprobante(p.monto, cur.isForeign, tc),
              esDestino: 1,
            }
          )
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
      const match = rates.find(r => Number(r.tasa) === Number(tasaIgv))
      if (match) return match.cuenta40
    }
    return rates[0]?.cuenta40 || '40.1.1.100'
  }

  /** Equivalente en USD: monto en soles / tipo de cambio del día. */
  private toME(amount: number, tc: number): number {
    const rate = Number(tc) || 0
    if (rate <= 0) return 0
    return this.round2(amount / rate)
  }

  /**
   * Resuelve, para un comprobante con moneda propia (Expense/Advance), el
   * código de moneda Contanet y el factor para convertir sus montos
   * ORIGINALES (calculados en moneda del comprobante) a moneda de registro
   * (PEN): `montoDebe/montoHaber = original * fxFactor`. Si el comprobante ya
   * está en la moneda base, `fxFactor=1` (no-op) y se preserva el
   * comportamiento previo a la migración multimoneda.
   */
  private resolveComprobanteCurrency(
    config: AccountingConfigDocument,
    doc: { moneda?: string; montoBase?: number; tipoCambio?: number },
    originalTotal: number,
    dayTc: number
  ): {
    isForeign: boolean
    fxFactor: number
    mdaOrigen: string
    cambioMoneda: number
  } {
    const monedaBase = config.monedaBase || 'PEN'
    const moneda = doc.moneda || monedaBase
    const isForeign = moneda !== monedaBase
    const fxFactor =
      isForeign && originalTotal > 0 && doc.montoBase != null
        ? doc.montoBase / originalTotal
        : 1
    const contanetCode = (config.supportedCurrencies || []).find(
      c => c.code === moneda
    )?.contanetCode
    return {
      isForeign,
      fxFactor,
      mdaOrigen: contanetCode || config.monedaOrigen,
      cambioMoneda: isForeign ? Number(doc.tipoCambio) || dayTc : dayTc,
    }
  }

  /**
   * ME de una línea de comprobante con moneda propia: si es extranjera, el
   * "monto en moneda extranjera" ES el monto original (sin re-dividir); si
   * es la moneda base, se conserva el cálculo nocional actual (soles/TC del
   * día) vía `toME`.
   */
  private toMEForComprobante(
    originalAmount: number,
    isForeign: boolean,
    dayTc: number
  ): number {
    if (isForeign) return this.round2(originalAmount)
    return this.toME(originalAmount, dayTc)
  }

  // ----------------------------------------------------------------------
  // C3 — Builders SOLICITUD / APLICACIÓN / DEVOLUCIÓN-REEMBOLSO
  // ----------------------------------------------------------------------

  private async buildSolicitudLines(ctx: {
    report: any
    config: AccountingConfigDocument
    advances: any[]
    colaborador: any
    projectMap: Map<string, any>
    periodDate: Date
    rateMap: Map<string, number>
    warnings: string[]
  }): Promise<ContanetLine[]> {
    const {
      config,
      advances,
      colaborador,
      report,
      projectMap,
      periodDate,
      rateMap,
      warnings,
    } = ctx
    const lines: ContanetLine[] = []
    let relacionado = 1
    let correlativo = 1
    const trabDni = colaborador?.dni || ''
    const trabNombre = colaborador?.name || ''
    const cuenta14 = this.cuenta14(config, colaborador)

    for (const adv of advances) {
      const amount = this.round2(Number(adv.amount) || 0)
      if (amount <= 0) {
        warnings.push(
          `El anticipo "${adv.description || adv._id}" tiene monto ${amount} y no genera asiento de solicitud (revisa el monto del anticipo).`
        )
        continue
      }
      const rawDate =
        adv.payment?.transferDate || adv.startDate || adv.createdAt
      const date = rawDate ? new Date(rawDate) : new Date()
      const tc = this.tcFor(date, rateMap, config)
      const cur = this.resolveComprobanteCurrency(config, adv, amount, tc)
      const banco = this.resolveBankAccount(config, adv.payment?.accountNumber)
      const glosa = (adv.description || 'SOLICITUD VIATICO')
        .toString()
        .slice(0, 100)
        .toUpperCase()

      // Centro de costo: proyecto del anticipo, o el de la rendición si el
      // anticipo no tiene uno propio asignado.
      const advProject = this.resolveLineProject(
        projectMap,
        adv.projectId,
        report?.projectId
      )
      const push = (line: ContanetLine) => {
        this.applyProjectCostCenter(line, advProject)
        line.relacionado = relacionado
        line.correlativo = correlativo++
        lines.push(line)
      }

      // 14 (Debe) — nace la obligación del colaborador
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCajaBancos,
          glosa,
          cur.cambioMoneda,
          periodDate,
          {
            nroCuenta: cuenta14,
            mdaOrigen: cur.mdaOrigen,
            montoDebe: this.round2(amount * cur.fxFactor),
            montoDebeME: this.toMEForComprobante(amount, cur.isForeign, tc),
            codTipDocIdentTrab: trabDni ? '01' : '',
            nroDocTrab: trabDni,
            razonSocialTrab: trabNombre,
          }
        )
      )

      // 104 (Haber) — sale el dinero del banco
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCajaBancos,
          glosa,
          cur.cambioMoneda,
          periodDate,
          {
            nroCuenta: banco,
            mdaOrigen: cur.mdaOrigen,
            montoHaber: this.round2(amount * cur.fxFactor),
            montoHaberME: this.toMEForComprobante(amount, cur.isForeign, tc),
          }
        )
      )

      relacionado++
    }

    return lines
  }

  private async buildAplicacionLines(ctx: {
    report: any
    config: AccountingConfigDocument
    expenses: any[]
    colaborador: any
    movilidadDiario: number
    projectMap: Map<string, any>
    categoryMap: Map<string, any>
    periodDate: Date
    rateMap: Map<string, number>
    warnings: string[]
  }): Promise<ContanetLine[]> {
    const {
      config,
      expenses,
      colaborador,
      report,
      movilidadDiario,
      projectMap,
      categoryMap,
      periodDate,
      rateMap,
      warnings,
    } = ctx
    const lines: ContanetLine[] = []
    const warnedCategoryKeys = new Set<string>()
    let relacionado = 1
    let correlativo = 1
    const trabDni = colaborador?.dni || ''
    const trabNombre = colaborador?.name || ''
    const cuenta14 = this.cuenta14(config, colaborador)
    // Consolidación de la cuenta 14 de TODOS los comprobantes de la rendición:
    // en vez de una línea 14 por comprobante (o por corrida de facturas), la
    // rendición completa comparte UN solo asiento de CRUCE con una única línea
    // 14 (Haber) por el TOTAL RENDIDO. Cada comprobante — factura, boleta /
    // ticket / recibo / otros y cada bloque de movilidad — aporta una línea 42
    // (Debe) con su detalle de proveedor/documento a ese mismo asiento. La 14
    // solo refleja la cancelación total de la entrega a rendir (1413) del
    // colaborador, igual que la Solicitud la entrega en un único monto.
    // Para los no-factura y la movilidad, esta 42 (Debe) cancela la 42 (Haber)
    // de provisión que crea su propio bloque de gasto 9X/42/6X/79 (asientos
    // independientes que cuadran por sí solos). Cuadre del cruce:
    // Σ(42 Debe) = 14 Haber. Fecha / tipo de cambio / centro de costo de la
    // línea 14 = los del comprobante MÁS RECIENTE por fecha.
    let crossingRelacionado: number | null = null
    let crossingTotalPEN = 0
    let crossingTotalME = 0
    let crossingLatestDate: Date | null = null
    let crossingLatestCur: { mdaOrigen: string; cambioMoneda: number } | null =
      null
    let crossingLatestProject: any = undefined
    // Reserva (una sola vez) el número de asiento del cruce, consumiéndolo con
    // `++` para que los bloques de gasto de los no-factura/movilidad usen
    // números posteriores y no colisionen con el asiento de cruce.
    const reserveCrossing = (): number => {
      if (crossingRelacionado == null) crossingRelacionado = relacionado++
      return crossingRelacionado
    }
    // Emite la línea 42 (Debe) de un comprobante contra la 14: acumula su total
    // y recuerda la fecha/moneda/proyecto más recientes (para la línea 14).
    const addCrossing42 = (args: {
      date: Date
      montoDebePEN: number
      montoDebeME: number
      cur: { mdaOrigen: string; cambioMoneda: number }
      project: any
      docFields: { codTipDoc?: string; nroSerie?: string; nroDoc?: string }
      prov?: { ruc?: string; razonSocial?: string }
    }) => {
      const rel = reserveCrossing()
      const line = this.baseLine(
        config,
        args.date,
        config.fuenteAplicacion,
        'APLICACION',
        args.cur.cambioMoneda,
        periodDate,
        {
          nroCuenta: config.cuenta42,
          codTipDoc: args.docFields.codTipDoc,
          nroSerie: args.docFields.nroSerie,
          nroDoc: args.docFields.nroDoc,
          mdaOrigen: args.cur.mdaOrigen,
          montoDebe: args.montoDebePEN,
          montoDebeME: args.montoDebeME,
          codTipDocIdentProv: args.prov?.ruc ? '06' : '',
          nroDocProv: args.prov?.ruc || '',
          razonSocialProv: args.prov?.razonSocial || '',
        }
      )
      this.applyProjectCostCenter(line, args.project)
      line.relacionado = rel
      line.correlativo = correlativo++
      lines.push(line)
      crossingTotalPEN = this.round2(crossingTotalPEN + args.montoDebePEN)
      crossingTotalME = this.round2(crossingTotalME + args.montoDebeME)
      if (
        !crossingLatestDate ||
        args.date.getTime() >= crossingLatestDate.getTime()
      ) {
        crossingLatestDate = args.date
        crossingLatestCur = {
          mdaOrigen: args.cur.mdaOrigen,
          cambioMoneda: args.cur.cambioMoneda,
        }
        crossingLatestProject = args.project
      }
    }
    // Vuelca la única línea 14 (Haber) del cruce por el total rendido.
    const flushCrossing = () => {
      if (crossingRelacionado == null || !crossingLatestCur) return
      const line = this.baseLine(
        config,
        crossingLatestDate as Date,
        config.fuenteAplicacion,
        'APLICACION',
        crossingLatestCur.cambioMoneda,
        periodDate,
        {
          nroCuenta: cuenta14,
          mdaOrigen: crossingLatestCur.mdaOrigen,
          montoHaber: this.round2(crossingTotalPEN),
          montoHaberME: this.round2(crossingTotalME),
          codTipDocIdentTrab: trabDni ? '01' : '',
          nroDocTrab: trabDni,
          razonSocialTrab: trabNombre,
        }
      )
      this.applyProjectCostCenter(line, crossingLatestProject)
      line.relacionado = crossingRelacionado
      line.correlativo = correlativo++
      lines.push(line)
    }
    // Cada `expense` de tipo planilla_movilidad es un documento independiente
    // con su propio internalCode (correlativo AML012, AML013, ...). El asiento
    // de Aplicación ya NO consolida: cada bloque de S/40 se emite con el
    // "Numero Documento" de la planilla a la que pertenece (ver el bloque de
    // movilidad al final de esta función).
    const movilidadExpenses = expenses.filter(
      e => e.expenseType === 'planilla_movilidad'
    )

    for (const expense of expenses) {
      // Toda la planilla de movilidad de la rendición se procesa UNA sola
      // vez, después de este loop (ver bloque al final de la función) — así
      // se puede consolidar el total de TODOS los `expense` de tipo
      // planilla_movilidad antes de repartirlo en bloques de
      // `movilidadDiario`, igual que hace el PDF completo.
      if (expense.expenseType === 'planilla_movilidad') continue
      const data = this.parseData(expense)
      const det = expense.comprobanteDetallado ?? {}
      const ruc = det?.emisor?.ruc || data.rucEmisor || ''
      const razonSocial =
        det?.emisor?.razonSocial ||
        data.razonSocial ||
        expense.providerName ||
        ''
      const codTipDoc = resolveCodTipDoc(expense, data.tipoComprobante)
      const esFactura = codTipDoc === TIPO_DOCUMENTO.FT
      // Numero Serie: solo la factura (01) lleva la serie real del comprobante;
      // el resto de tipos de documento va con la serie de control fija 0001.
      const serie = esFactura
        ? det?.comprobante?.serie || data.serie || ''
        : '0001'
      // Planilla de movilidad / comprobante de caja no traen `comprobante.correlativo`
      // (no son comprobantes SUNAT): su número es el internalCode generado al crearlos
      // (expense.service.ts `generateInternalCode`, ej. "MT001"). Sin este fallback
      // "Numero Documento" queda vacío para código 94/66 en el asiento de Aplicación.
      const nroDoc =
        det?.comprobante?.correlativo ||
        data.correlativo ||
        expense.internalCode ||
        ''

      // FACTURA: su gasto (9X/40/42/6X/79) ya se registró en `buildCompraLines`.
      // Aquí solo se cruza el total rendido (42) contra el anticipo del
      // colaborador (14) — par 42(Debe)/14(Haber).
      if (esFactura) {
        const total = this.round2(
          Number(det?.totales?.importeTotal) || Number(expense.total) || 0
        )
        if (total <= 0) {
          const label = razonSocial || expense.comentario || expense._id
          warnings.push(
            `El comprobante "${label}" tiene total 0 y no genera asiento de aplicación (revisa el desglose del comprobante).`
          )
          continue
        }
        const date = this.asientoDate(expense, report)
        const tc = this.tcFor(date, rateMap, config)
        const cur = this.resolveComprobanteCurrency(config, expense, total, tc)
        // Centro de costo: proyecto del comprobante, o el de la rendición si
        // el comprobante no tiene uno propio asignado.
        const expProject = this.resolveLineProject(
          projectMap,
          expense.proyectId,
          report?.projectId
        )
        // Cruce contra la entrega a rendir: la 42 (Debe) de la factura entra al
        // asiento consolidado; la única línea 14 (Haber) se vuelca al final.
        addCrossing42({
          date,
          montoDebePEN: this.round2(total * cur.fxFactor),
          montoDebeME: this.toMEForComprobante(total, cur.isForeign, tc),
          cur,
          project: expProject,
          docFields: { codTipDoc, nroSerie: serie, nroDoc },
          prov: { ruc, razonSocial },
        })
        continue
      }

      // NO-FACTURA (boleta/ticket/planilla/recibo/otros, código ≠ 01): no dan
      // crédito fiscal y ya no pasan por `buildCompraLines`. Su gasto se
      // reconoce aquí con la misma estructura que antes tenía Compra, sin la
      // línea 40: 9X(Debe)/42(Haber) — bloque (a) — y 6X(Debe)/79(Haber) —
      // bloque (b). Además, el total del comprobante se cruza contra la entrega
      // a rendir (14) sumando una 42(Debe) al asiento de cruce (`addCrossing42`,
      // tras `pushBloque`): esa 42(Debe) cancela la 42(Haber) de provisión de
      // este bloque, de modo que la 14 liquida el TOTAL rendido, no solo las
      // facturas.
      const category = expense.categoryId
        ? categoryMap.get(expense.categoryId.toString())
        : undefined
      const cuenta9x = category?.cuenta || ''
      const cuenta6xCat = category?.cuentaDestino6x || config.cuenta79

      if (!cuenta9x) {
        const categoryKey =
          category?._id?.toString() ||
          expense.categoryId?.toString() ||
          'sin-categoria'
        if (!warnedCategoryKeys.has(categoryKey)) {
          warnedCategoryKeys.add(categoryKey)
          const msg = category
            ? `La categoría "${category.name}" no tiene la Cuenta Analítica 9X configurada (Categorías → editar categoría). Sus comprobantes quedarán descuadrados hasta configurarla.`
            : expense.categoryId
              ? `Un comprobante tiene asignada una categoría (id ${categoryKey}) que ya no existe o no pertenece a esta empresa. Reasígnale una categoría válida desde el detalle del gasto.`
              : 'Hay comprobantes sin categoría asignada: no se puede generar su línea analítica 9X. Asígnales una categoría desde el detalle del gasto.'
          warnings.push(msg)
          this.logger.warn(`[asientos] ${msg} (categoryId=${categoryKey})`)
        }
      }
      if (category && !category.cuentaDestino6x) {
        const dest6xKey = `${category._id?.toString()}:6x`
        if (!warnedCategoryKeys.has(dest6xKey)) {
          warnedCategoryKeys.add(dest6xKey)
          const msg = `La categoría "${category.name}" no tiene la Cuenta Destino 6X configurada (Categorías → editar categoría). El asiento de destino saldrá como 79/79 en vez de 6X/79, sin registrar el gasto por naturaleza.`
          warnings.push(msg)
          this.logger.warn(
            `[asientos] ${msg} (categoryId=${category._id?.toString()})`
          )
        }
      }

      const expenseProject = expense.proyectId
        ? projectMap.get(expense.proyectId.toString())
        : undefined

      // Bloque 9X/42/6X/79 para un conjunto de porciones (una factura puede
      // dividirse en varias 9X; una planilla se llama una vez por fila).
      const pushBloque = (
        date: Date,
        portions: AnalyticPortion[],
        glosaBase: string,
        docFields: { codTipDoc: string; nroSerie: string; nroDoc: string }
      ) => {
        const total = this.round2(portions.reduce((s, p) => s + p.monto, 0))
        if (total <= 0) return
        const tc = this.tcFor(date, rateMap, config)
        const cur = this.resolveComprobanteCurrency(config, expense, total, tc)
        const push = (line: ContanetLine) => {
          this.applyProjectCostCenter(line, expenseProject)
          line.relacionado = relacionado
          line.correlativo = correlativo++
          lines.push(line)
        }

        if (cuenta9x) {
          for (const p of portions) {
            const glosa = p.etiqueta
              ? `${glosaBase} (${p.etiqueta})`
              : glosaBase
            const pFields = p.serieNoDeducible
              ? { codTipDoc: '', nroSerie: '', nroDoc: p.serieNoDeducible }
              : docFields
            push(
              this.baseLine(
                config,
                date,
                config.fuenteAplicacion,
                glosa,
                cur.cambioMoneda,
                periodDate,
                {
                  nroCuenta: cuenta9x,
                  ...pFields,
                  mdaOrigen: cur.mdaOrigen,
                  identTipAfecto: p.condicion === 'afecto' ? 'S' : 'N',
                  montoDebe: this.round2(p.monto * cur.fxFactor),
                  montoDebeME: this.toMEForComprobante(
                    p.monto,
                    cur.isForeign,
                    tc
                  ),
                }
              )
            )
          }
        }

        push(
          this.baseLine(
            config,
            date,
            config.fuenteAplicacion,
            glosaBase,
            cur.cambioMoneda,
            periodDate,
            {
              nroCuenta: config.cuenta42,
              ...docFields,
              mdaOrigen: cur.mdaOrigen,
              montoHaber: this.round2(total * cur.fxFactor),
              montoHaberME: this.toMEForComprobante(total, cur.isForeign, tc),
              esProvision: 1,
              codTipDocIdentProv: ruc ? '06' : '',
              nroDocProv: ruc,
              razonSocialProv: razonSocial,
            }
          )
        )

        for (const p of portions) {
          const glosa = p.etiqueta ? `${glosaBase} (${p.etiqueta})` : glosaBase
          push(
            this.baseLine(
              config,
              date,
              config.fuenteAplicacion,
              glosa,
              cur.cambioMoneda,
              periodDate,
              {
                nroCuenta: cuenta6xCat,
                mdaOrigen: cur.mdaOrigen,
                montoDebe: this.round2(p.monto * cur.fxFactor),
                montoDebeME: this.toMEForComprobante(
                  p.monto,
                  cur.isForeign,
                  tc
                ),
                esDestino: 1,
              }
            )
          )
          push(
            this.baseLine(
              config,
              date,
              config.fuenteAplicacion,
              glosa,
              cur.cambioMoneda,
              periodDate,
              {
                nroCuenta: config.cuenta79,
                mdaOrigen: cur.mdaOrigen,
                montoHaber: this.round2(p.monto * cur.fxFactor),
                montoHaberME: this.toMEForComprobante(
                  p.monto,
                  cur.isForeign,
                  tc
                ),
                esDestino: 1,
              }
            )
          )
        }

        relacionado++
      }

      // Resto de documentos no-factura: respeta `detalleAnalitico` si
      // Contabilidad lo corrigió manualmente; si no, todo el importe es una
      // sola porción inafecta (`resolveNonFacturaPortions`).
      const portions = this.resolveNonFacturaPortions(expense)
      if (!portions.length) {
        const label = razonSocial || expense.comentario || expense._id
        warnings.push(
          `El comprobante "${label}" tiene total 0 y no genera asiento de aplicación (revisa el desglose del comprobante).`
        )
        continue
      }
      pushBloque(this.asientoDate(expense, report), portions, 'APLICACION', {
        codTipDoc,
        nroSerie: serie,
        nroDoc,
      })

      // Cruce del no-factura contra la 14: una 42(Debe) por el total del
      // comprobante que cancela la 42(Haber) de provisión del bloque anterior.
      const nfTotal = this.round2(portions.reduce((s, p) => s + p.monto, 0))
      if (nfTotal > 0) {
        const nfDate = this.asientoDate(expense, report)
        const nfTc = this.tcFor(nfDate, rateMap, config)
        const nfCur = this.resolveComprobanteCurrency(
          config,
          expense,
          nfTotal,
          nfTc
        )
        addCrossing42({
          date: nfDate,
          montoDebePEN: this.round2(nfTotal * nfCur.fxFactor),
          montoDebeME: this.toMEForComprobante(nfTotal, nfCur.isForeign, nfTc),
          cur: nfCur,
          project: expenseProject,
          docFields: { codTipDoc, nroSerie: serie, nroDoc },
          prov: { ruc, razonSocial },
        })
      }
    }

    // Planilla de movilidad: cada `expense` es un documento INDEPENDIENTE con
    // su propio internalCode (correlativo AML012, AML013, ...). Su total se
    // reparte en bloques de `movilidadDiario` con fechas SINTÉTICAS (día
    // siguiente a report.startDate/viaticoStartDate, avanzando un día por
    // bloque con cursor corrido entre planillas — nunca las fechas reales de
    // `mobilityRows`). Cada bloque se emite con el "Numero Documento",
    // categoría (cuentas 9X/6X) y centro de costo de SU planilla. Se procesa
    // acá, fuera del loop de arriba, porque las fechas sintéticas se asignan
    // de forma corrida sobre el conjunto de planillas de la rendición.
    if (movilidadExpenses.length) {
      const blocks = this.buildMovilidadBlocks(
        movilidadExpenses,
        report,
        movilidadDiario
      )
      if (!blocks.length) {
        const label = movilidadExpenses
          .map(e => e.internalCode || e.comentario || e._id)
          .join(', ')
        warnings.push(
          `La planilla de movilidad "${label}" no tiene monto y no genera asiento de aplicación.`
        )
      } else {
        // Metadatos contables por planilla (categoría/cuentas/proyecto), con
        // avisos deduplicados por categoría vía `warnedCategoryKeys`.
        const metaCache = new Map<
          string,
          {
            cuenta9x: string
            cuenta6xCat: string
            project: any
            nroDoc: string
          }
        >()
        const resolveMovMeta = (expense: any) => {
          const cacheKey = expense?._id?.toString() || ''
          const cached = metaCache.get(cacheKey)
          if (cached) return cached

          const category = expense?.categoryId
            ? categoryMap.get(expense.categoryId.toString())
            : undefined
          const cuenta9x = category?.cuenta || ''
          const cuenta6xCat = category?.cuentaDestino6x || config.cuenta79

          if (!cuenta9x) {
            const categoryKey =
              category?._id?.toString() ||
              expense?.categoryId?.toString() ||
              'sin-categoria'
            if (!warnedCategoryKeys.has(categoryKey)) {
              warnedCategoryKeys.add(categoryKey)
              const msg = category
                ? `La categoría "${category.name}" no tiene la Cuenta Analítica 9X configurada (Categorías → editar categoría). Sus comprobantes quedarán descuadrados hasta configurarla.`
                : expense?.categoryId
                  ? `Un comprobante tiene asignada una categoría (id ${categoryKey}) que ya no existe o no pertenece a esta empresa. Reasígnale una categoría válida desde el detalle del gasto.`
                  : 'Hay comprobantes sin categoría asignada: no se puede generar su línea analítica 9X. Asígnales una categoría desde el detalle del gasto.'
              warnings.push(msg)
              this.logger.warn(`[asientos] ${msg} (categoryId=${categoryKey})`)
            }
          }
          if (category && !category.cuentaDestino6x) {
            const dest6xKey = `${category._id?.toString()}:6x`
            if (!warnedCategoryKeys.has(dest6xKey)) {
              warnedCategoryKeys.add(dest6xKey)
              const msg = `La categoría "${category.name}" no tiene la Cuenta Destino 6X configurada (Categorías → editar categoría). El asiento de destino saldrá como 79/79 en vez de 6X/79, sin registrar el gasto por naturaleza.`
              warnings.push(msg)
              this.logger.warn(
                `[asientos] ${msg} (categoryId=${category._id?.toString()})`
              )
            }
          }

          const projectId =
            report?.projectId?.toString() || expense?.proyectId?.toString()
          const project = projectId ? projectMap.get(projectId) : undefined
          const meta = {
            cuenta9x,
            cuenta6xCat,
            project,
            nroDoc: expense?.internalCode || '',
          }
          metaCache.set(cacheKey, meta)
          return meta
        }

        for (const block of blocks) {
          const meta = resolveMovMeta(block.expense)
          const tc = this.tcFor(block.date, rateMap, config)
          const glosaBase = `APLICACION ${block.date.toISOString().slice(0, 10)}`
          const push = (line: ContanetLine) => {
            this.applyProjectCostCenter(line, meta.project)
            line.relacionado = relacionado
            line.correlativo = correlativo++
            lines.push(line)
          }
          if (meta.cuenta9x) {
            push(
              this.baseLine(
                config,
                block.date,
                config.fuenteAplicacion,
                glosaBase,
                tc,
                periodDate,
                {
                  nroCuenta: meta.cuenta9x,
                  codTipDoc: TIPO_DOCUMENTO.PM,
                  nroSerie: '0001',
                  nroDoc: meta.nroDoc,
                  identTipAfecto: 'N',
                  montoDebe: block.monto,
                  montoDebeME: this.toME(block.monto, tc),
                }
              )
            )
          }
          push(
            this.baseLine(
              config,
              block.date,
              config.fuenteAplicacion,
              glosaBase,
              tc,
              periodDate,
              {
                nroCuenta: config.cuenta42,
                codTipDoc: TIPO_DOCUMENTO.PM,
                nroSerie: '0001',
                nroDoc: meta.nroDoc,
                montoHaber: block.monto,
                montoHaberME: this.toME(block.monto, tc),
                esProvision: 1,
              }
            )
          )
          push(
            this.baseLine(
              config,
              block.date,
              config.fuenteAplicacion,
              glosaBase,
              tc,
              periodDate,
              {
                nroCuenta: meta.cuenta6xCat,
                montoDebe: block.monto,
                montoDebeME: this.toME(block.monto, tc),
                esDestino: 1,
              }
            )
          )
          push(
            this.baseLine(
              config,
              block.date,
              config.fuenteAplicacion,
              glosaBase,
              tc,
              periodDate,
              {
                nroCuenta: config.cuenta79,
                montoHaber: block.monto,
                montoHaberME: this.toME(block.monto, tc),
                esDestino: 1,
              }
            )
          )
          relacionado++
          // Cruce del bloque de movilidad contra la 14: una 42(Debe) que
          // cancela la 42(Haber) de provisión de este mismo bloque.
          const movCur = this.resolveComprobanteCurrency(
            config,
            block.expense,
            block.monto,
            tc
          )
          addCrossing42({
            date: block.date,
            montoDebePEN: this.round2(block.monto * movCur.fxFactor),
            montoDebeME: this.toMEForComprobante(
              block.monto,
              movCur.isForeign,
              tc
            ),
            cur: movCur,
            project: meta.project,
            docFields: {
              codTipDoc: TIPO_DOCUMENTO.PM,
              nroSerie: '0001',
              nroDoc: meta.nroDoc,
            },
          })
        }
      }
    }

    // Única línea 14 (Haber) del cruce: liquida la entrega a rendir por el
    // TOTAL rendido (facturas + no-factura + movilidad).
    flushCrossing()

    return lines
  }

  private async buildDevolucionReembolsoLines(
    ctx: {
      report: any
      config: AccountingConfigDocument
      advances: any[]
      colaborador: any
      projectMap: Map<string, any>
      periodDate: Date
      rateMap: Map<string, number>
    },
    modo: 'devolucion' | 'reembolso'
  ): Promise<ContanetLine[]> {
    const {
      config,
      colaborador,
      report,
      advances,
      projectMap,
      periodDate,
      rateMap,
    } = ctx
    const settlement = report.settlement
    const diff = this.round2(Math.abs(Number(settlement?.difference) || 0))
    if (diff <= 0) return []

    // Coherencia: solo emitir si el tipo de liquidación corresponde al modo.
    if (settlement?.type && settlement.type !== modo) return []

    const date = new Date(report.updatedAt || Date.now())
    const tc = this.tcFor(date, rateMap, config)
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

    // Centro de costo: proyecto de la rendición, o el del primer anticipo si
    // la rendición no tiene uno propio asignado.
    const project = this.resolveLineProject(
      projectMap,
      report?.projectId,
      advances?.[0]?.projectId
    )

    const lines: ContanetLine[] = []
    let correlativo = 1
    const push = (line: ContanetLine) => {
      this.applyProjectCostCenter(line, project)
      line.relacionado = 1
      line.correlativo = correlativo++
      lines.push(line)
    }

    if (modo === 'devolucion') {
      // 104 (Debe) entra al banco / 14 (Haber) reduce la CxC
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCajaBancos,
          glosa,
          tc,
          periodDate,
          {
            nroCuenta: banco,
            montoDebe: diff,
            montoDebeME: this.toME(diff, tc),
          }
        )
      )
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCajaBancos,
          glosa,
          tc,
          periodDate,
          {
            nroCuenta: cuenta14,
            montoHaber: diff,
            montoHaberME: this.toME(diff, tc),
            codTipDocIdentTrab: trabDni ? '01' : '',
            nroDocTrab: trabDni,
            razonSocialTrab: trabNombre,
          }
        )
      )
    } else {
      // Reembolso: 14/46 (Debe) / 104 (Haber) sale del banco
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCajaBancos,
          glosa,
          tc,
          periodDate,
          {
            nroCuenta: cuentaColab,
            montoDebe: diff,
            montoDebeME: this.toME(diff, tc),
            codTipDocIdentTrab: trabDni ? '01' : '',
            nroDocTrab: trabDni,
            razonSocialTrab: trabNombre,
          }
        )
      )
      push(
        this.baseLine(
          config,
          date,
          config.fuenteCajaBancos,
          glosa,
          tc,
          periodDate,
          {
            nroCuenta: banco,
            montoHaber: diff,
            montoHaberME: this.toME(diff, tc),
          }
        )
      )
    }

    return lines
  }

  private resolveBankAccount(
    config: AccountingConfigDocument,
    nroCuenta?: string
  ): string {
    const accounts = config.bankAccounts ?? []
    if (nroCuenta) {
      const match = accounts.find(b => b.nroCuenta === nroCuenta)
      if (match) return match.cuentaContable
    }
    const active = accounts.find(b => b.activo !== false)
    return active?.cuentaContable || accounts[0]?.cuentaContable || '10.4.1.100'
  }

  // ----------------------------------------------------------------------
  // C4 — Validación de cuadre (partida doble)
  // ----------------------------------------------------------------------

  /**
   * Valida la partida doble por `relacionado` (un grupo = un comprobante/anticipo).
   * Cada error incluye la fila de Excel exacta (misma fórmula que `buildContanetWorkbook`:
   * fila = 9 + índice) y una descripción legible del documento, para que Contabilidad
   * no tenga que adivinar cuál comprobante originó el descuadre.
   */
  validateCuadre(lines: ContanetLine[]): CuadreError[] {
    const groups = new Map<
      number,
      { debe: number; haber: number; firstIdx: number; lastIdx: number }
    >()
    lines.forEach((line, idx) => {
      const rel = Number(line.relacionado)
      if (!groups.has(rel))
        groups.set(rel, { debe: 0, haber: 0, firstIdx: idx, lastIdx: idx })
      const g = groups.get(rel)!
      g.debe += Number(line.montoDebe) || 0
      g.haber += Number(line.montoHaber) || 0
      g.lastIdx = idx
    })
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
          filaInicio: this.toExcelRow(g.firstIdx),
          filaFin: this.toExcelRow(g.lastIdx),
          documento: this.describeRelacionado(lines, g.firstIdx, g.lastIdx),
        })
      }
    }
    return errors
  }

  /** Fila de Excel (1-indexed) para el índice de línea dado. Debe calzar con `buildContanetWorkbook`. */
  private toExcelRow(lineIdx: number): number {
    return 9 + lineIdx
  }

  /** Descripción legible del documento (comprobante o anticipo) al que pertenece un grupo de líneas. */
  private describeRelacionado(
    lines: ContanetLine[],
    firstIdx: number,
    lastIdx: number
  ): string {
    for (let i = firstIdx; i <= lastIdx; i++) {
      const l = lines[i]
      if (l.razonSocialProv) {
        const doc = [l.nroSerie, l.nroDoc].filter(Boolean).join('-')
        return doc ? `${l.razonSocialProv} (${doc})` : String(l.razonSocialProv)
      }
    }
    for (let i = firstIdx; i <= lastIdx; i++) {
      if (lines[i].razonSocialTrab) return String(lines[i].razonSocialTrab)
    }
    for (let i = firstIdx; i <= lastIdx; i++) {
      if (lines[i].glosa) return String(lines[i].glosa)
    }
    return `asiento #${lines[firstIdx]?.relacionado}`
  }

  private countAsientos(lines: ContanetLine[]): number {
    return new Set(lines.map(l => Number(l.relacionado))).size
  }

  /** Expuesto para tests: columnas del template. */
  get columns() {
    return CONTANET_COLUMNS
  }
}
