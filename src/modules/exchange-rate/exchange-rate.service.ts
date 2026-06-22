import { Injectable, Logger } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import {
  ExchangeRate,
  ExchangeRateDocument,
} from './entities/exchange-rate.entity'

/**
 * Tipo de cambio PEN/USD por fecha, con caché en base de datos.
 * Flujo: primero consulta la BD; si no existe, llama a una API gratuita
 * (sin API key) y persiste el resultado para no volver a consultarla.
 *
 * API: fawazahmed0/exchange-api (jsDelivr) — soporta fechas históricas.
 *   https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{fecha}/v1/currencies/usd.json
 *   → { "date": "YYYY-MM-DD", "usd": { "pen": 3.75, ... } }
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name)

  constructor(
    @InjectModel(ExchangeRate.name)
    private exchangeRateModel: Model<ExchangeRateDocument>
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

    // 1) Caché en BD
    const cached = await this.exchangeRateModel.findOne({ fecha }).lean().exec()
    if (cached?.tasa) return cached.tasa

    // 2) API gratuita
    const tasa = await this.fetchFromApi(fecha)
    if (tasa && tasa > 0) {
      await this.exchangeRateModel
        .findOneAndUpdate(
          { fecha },
          { $set: { fecha, tasa, source: 'api' } },
          { upsert: true, new: true }
        )
        .exec()
      return tasa
    }

    // 3) Respaldo: la tasa cacheada más reciente anterior a la fecha
    const fallback = await this.exchangeRateModel
      .findOne({ fecha: { $lte: fecha } })
      .sort({ fecha: -1 })
      .lean()
      .exec()
    return fallback?.tasa ?? null
  }

  private async fetchFromApi(fecha: string): Promise<number | null> {
    // 1) URLs para la fecha exacta (histórica). El endpoint con fecha usa el tag
    //    de GitHub `exchange-api@{fecha}` (las versiones npm no son fechas).
    // 2) Si la fecha no existe (p. ej. fecha futura), se cae a la tasa más
    //    reciente disponible (`latest`) para que SIEMPRE haya un valor.
    const urls = [
      `https://cdn.jsdelivr.net/gh/fawazahmed0/exchange-api@${fecha}/v1/currencies/usd.json`,
      `https://${fecha}.currency-api.pages.dev/v1/currencies/usd.json`,
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`,
      `https://latest.currency-api.pages.dev/v1/currencies/usd.json`,
    ]
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) continue
        const json: any = await res.json()
        const pen = json?.usd?.pen
        if (typeof pen === 'number' && pen > 0) {
          return Math.round(pen * 1000) / 1000
        }
      } catch (e) {
        this.logger.warn(
          `Error obteniendo tipo de cambio (${url}): ${(e as Error).message}`
        )
      }
    }
    return null
  }
}
