import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import {
  ExchangeRate,
  ExchangeRateDocument,
} from './entities/exchange-rate.entity'

/** Resultado de consultar el API de TC, distinguiendo fallo transitorio de "no hay dato". */
type ApiResult =
  | { status: 'ok'; tasa: number }
  | { status: 'no_data' } // el API respondió pero no hay TC para esa fecha (feriado/fin de semana)
  | { status: 'error' } // fallo transitorio (red/timeout/5xx/401/cuota) — reintentar luego

/**
 * Tipo de cambio OFICIAL SUNAT (PEN/USD) por fecha, con caché en base de datos.
 *
 * Proveedor: Decolecta (TC oficial SUNAT). Requiere token `API_DECOLECTA` en el
 * entorno y tiene un límite de 100 peticiones/mes, por lo que la caché en BD es
 * crítica: el objetivo es NO llamar al API más de una vez por cada fecha distinta.
 *
 *   GET https://api.decolecta.com/v1/tipo-cambio/sunat?date=YYYY-MM-DD
 *   Authorization: Bearer <API_DECOLECTA>
 *   → { "buy_price": "3.456", "sell_price": "3.461", "base_currency": "USD",
 *       "quote_currency": "PEN", "date": "YYYY-MM-DD" }   (precios como string)
 *
 * Se persiste `sell_price` (TC venta): es el que exige el reglamento del IGV para
 * provisiones de compra / crédito fiscal (TC venta publicado a la fecha de emisión).
 *
 * Estrategia de caché (ahorro de cuota):
 *  - Cache HIT (fila de origen confiable) → 0 llamadas al API.
 *  - `ok`      → se guarda la tasa bajo esa fecha.
 *  - `no_data` (feriado/fin de semana) → se usa el último TC previo de la BD y, si
 *    la fecha YA pasó, se congela bajo esa fecha para no volver a gastar cuota.
 *  - `error`   (transitorio o cuota agotada) → se devuelve fallback pero NO se
 *    persiste, para reintentar en la próxima consulta (no envenena la caché).
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name)

  /** Origen de las tasas obtenidas del API Decolecta. */
  private static readonly SOURCE_DECOLECTA = 'decolecta'

  /** Origen de tasas importadas a mano directo de SUNAT (autoritativas). */
  private static readonly SOURCE_SUNAT_OFICIAL = 'sunat-oficial'

  /**
   * Orígenes confiables por la caché. Las tasas importadas directo de SUNAT
   * ('sunat-oficial') tienen prioridad como ground truth y nunca gastan cuota.
   * Las de proveedores anteriores (mercado 'api', eApi 'sunat') NO se confían:
   * la primera vez que se use esa fecha se vuelven a pedir a Decolecta y la fila
   * se sobrescribe in-place (índice único por fecha).
   */
  private static readonly TRUSTED_SOURCES = ['sunat-oficial', 'decolecta']

  constructor(
    @InjectModel(ExchangeRate.name)
    private exchangeRateModel: Model<ExchangeRateDocument>,
    private configService: ConfigService
  ) {}

  /** Normaliza una fecha (Date o string) a 'YYYY-MM-DD'. */
  private toIsoDate(date: Date | string): string {
    if (typeof date === 'string') {
      // Acepta dd-mm-yyyy / dd/mm/yyyy y los normaliza.
      const m = date.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/)
      if (m) return `${m[3]}-${m[2]}-${m[1]}`
      const d = new Date(date)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
      return date.slice(0, 10)
    }
    return date.toISOString().slice(0, 10)
  }

  /**
   * Devuelve soles por dólar (PEN/USD) de la fecha indicada.
   * Cachea en BD. Devuelve `null` si no se pudo obtener de ninguna fuente.
   */
  async getRate(date: Date | string): Promise<number | null> {
    const fecha = this.toIsoDate(date)

    // 1) Caché en BD: si ya la consultamos antes, 0 llamadas al API.
    const cached = await this.exchangeRateModel
      .findOne({ fecha, source: { $in: ExchangeRateService.TRUSTED_SOURCES } })
      .lean()
      .exec()
    if (cached?.tasa) return cached.tasa

    // 2) API Decolecta (consume 1 de las 100 peticiones/mes).
    const result = await this.fetchFromApi(fecha)
    if (result.status === 'ok') {
      await this.persist(fecha, result.tasa)
      return result.tasa
    }

    // 3) Respaldo: el último TC previo cacheado (lectura gratis).
    //    Regla SUNAT: en días sin publicación se aplica el último TC publicado.
    const fallback = await this.exchangeRateModel
      .findOne({
        fecha: { $lte: fecha },
        source: { $in: ExchangeRateService.TRUSTED_SOURCES },
      })
      .sort({ fecha: -1 })
      .lean()
      .exec()
    const rate = fallback?.tasa ?? null

    // 4) Si el API CONFIRMÓ que no hay TC para esa fecha (feriado/fin de semana) y
    //    la fecha ya pasó, congelamos el fallback bajo esa fecha: nunca tendrá TC
    //    propio, así evitamos gastar cuota otra vez. En fallos transitorios (o
    //    cuota agotada) NO se persiste, para reintentar en la próxima consulta.
    if (result.status === 'no_data' && rate && this.isPastDate(fecha)) {
      await this.persist(fecha, rate)
    }
    return rate
  }

  /** Upsert de una tasa bajo su fecha (índice único), marcada como origen Decolecta. */
  private async persist(fecha: string, tasa: number): Promise<void> {
    await this.exchangeRateModel
      .findOneAndUpdate(
        { fecha },
        {
          $set: { fecha, tasa, source: ExchangeRateService.SOURCE_DECOLECTA },
        },
        { upsert: true, new: true }
      )
      .exec()
  }

  /** True si la fecha ISO es estrictamente anterior a hoy (UTC). */
  private isPastDate(iso: string): boolean {
    return iso < new Date().toISOString().slice(0, 10)
  }

  /**
   * Tipos de cambio de varias fechas de una sola vez. Hace UNA consulta a la BD
   * (`$in`) para todas las cacheadas y solo va a la API por las que faltan (en
   * paralelo). Reemplaza N `findOne` por 1 query, importante cuando una rendición
   * tiene decenas de comprobantes con fechas distintas.
   */
  async getRatesBatch(dates: Array<Date | string>): Promise<Map<string, number>> {
    const isoList = [...new Set(dates.map(d => this.toIsoDate(d)))]
    const map = new Map<string, number>()
    if (!isoList.length) return map

    const cached = await this.exchangeRateModel
      .find({
        fecha: { $in: isoList },
        source: { $in: ExchangeRateService.TRUSTED_SOURCES },
      })
      .lean()
      .exec()
    for (const c of cached) {
      if (c.tasa) map.set(c.fecha, c.tasa)
    }

    const missing = isoList.filter(iso => !map.has(iso))
    if (missing.length) {
      // getRate persiste en BD las que obtenga de la API; las futuras/uncached
      // que la API no tenga devuelven el fallback más reciente.
      const fetched = await Promise.all(missing.map(iso => this.getRate(iso)))
      missing.forEach((iso, i) => {
        if (fetched[i]) map.set(iso, fetched[i] as number)
      })
    }
    return map
  }

  /**
   * Importa tasas oficiales SUNAT (TC venta) directo, sin tocar el API. Marca cada
   * fila como `sunat-oficial` (origen confiable de máxima prioridad), así estas
   * fechas se usan tal cual y nunca consumen la cuota de Decolecta. Idempotente:
   * upsert por fecha (índice único), reejecutable sin duplicar. Descarta filas con
   * fecha mal formada o venta no positiva.
   */
  async importOfficialRates(
    rows: Array<{ fecha: string; venta: number }>
  ): Promise<{ upserted: number; skipped: number }> {
    const ops: any[] = []
    let skipped = 0
    for (const r of rows) {
      const fecha = this.toIsoDate(r.fecha)
      const tasa = Math.round(Number(r.venta) * 1000) / 1000
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(tasa) || tasa <= 0) {
        skipped++
        continue
      }
      ops.push({
        updateOne: {
          filter: { fecha },
          update: {
            $set: {
              fecha,
              tasa,
              source: ExchangeRateService.SOURCE_SUNAT_OFICIAL,
            },
          },
          upsert: true,
        },
      })
    }
    if (ops.length) {
      await this.exchangeRateModel.bulkWrite(ops, { ordered: false })
    }
    return { upserted: ops.length, skipped }
  }

  private async fetchFromApi(fecha: string): Promise<ApiResult> {
    const token = this.configService.get<string>('API_DECOLECTA')
    if (!token) {
      // Config faltante: error transitorio, NO se persiste nada (no envenena caché).
      this.logger.error('API_DECOLECTA no configurada; no se puede obtener el TC SUNAT.')
      return { status: 'error' }
    }

    // TC oficial SUNAT (Decolecta). Se usa `sell_price` (venta) que exige el
    // reglamento del IGV para provisiones de compra / crédito fiscal.
    const url = `https://api.decolecta.com/v1/tipo-cambio/sunat?date=${fecha}`
    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
    } catch (error) {
      // Red/timeout: transitorio.
      this.logger.warn(
        `TC SUNAT ${fecha}: fallo de red (${(error as Error)?.message}). Se reintentará.`
      )
      return { status: 'error' }
    }

    if (res.ok) {
      const json: any = await res.json().catch(() => null)
      // sell_price viene como string ("3.461"); parseamos y validamos.
      const venta = Number(json?.sell_price)
      if (Number.isFinite(venta) && venta > 0) {
        return { status: 'ok', tasa: Math.round(venta * 1000) / 1000 }
      }
      // Respuesta válida sin TC utilizable → feriado/no publicado.
      return { status: 'no_data' }
    }

    // 404/400/422: no hay TC para esa fecha (feriado/fin de semana). Es seguro
    // tratarlo como "sin dato" y congelar el fallback para fechas pasadas.
    if (res.status === 404 || res.status === 400 || res.status === 422) {
      return { status: 'no_data' }
    }

    // 401/403 (token), 429 (cuota agotada), 5xx: transitorio/configuración. NO se
    // congela nada para poder reintentar cuando se restablezca el acceso.
    this.logger.warn(`TC SUNAT ${fecha}: HTTP ${res.status}. Se reintentará (no se cachea).`)
    return { status: 'error' }
  }
}
