import { Injectable, Logger } from '@nestjs/common'
import { ExchangeRateService } from './exchange-rate.service'
import { AccountingConfigService } from '../accounting-config/accounting-config.service'
import { AccountingConfigDocument } from '../accounting-config/entities/accounting-config.entity'

/** Congelado de conversión a moneda base, calculado una sola vez al registrar el documento. */
export interface CurrencyConversion {
  montoBase: number
  tipoCambio: number
  tcFecha: string
}

/**
 * Resuelve el tipo de cambio de cualquier moneda soportada hacia la moneda
 * base del cliente (`accounting-config.monedaBase`, normalmente PEN):
 *
 *  - moneda === monedaBase → TC 1 (sin conversión).
 *  - moneda === 'USD' (con base PEN) → TC oficial SUNAT del día, vía
 *    `ExchangeRateService` (TC venta, exigido por el Reglamento del IGV
 *    para crédito fiscal de comprobantes en moneda extranjera).
 *  - cualquier otra moneda → TC manual configurado en
 *    `accounting-config.supportedCurrencies[].manualRate` (decisión de
 *    producto: sin integración a un proveedor FX externo).
 */
@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name)

  constructor(
    private readonly exchangeRateService: ExchangeRateService,
    private readonly accountingConfigService: AccountingConfigService
  ) {}

  private round2(n: number): number {
    return Math.round((Number(n) || 0) * 100) / 100
  }

  private toIsoDate(date: Date | string): string {
    if (typeof date === 'string') return date.slice(0, 10)
    return date.toISOString().slice(0, 10)
  }

  /** Config efectiva del cliente (con defaults si aún no configuró nada). */
  async getConfig(clientId: string): Promise<AccountingConfigDocument> {
    return this.accountingConfigService.getEffective(clientId)
  }

  /**
   * Umbral de aprobación L1 de anticipos, en la moneda indicada (ej. 500
   * para PEN, 150 para USD por defecto — configurable por cliente en
   * `accounting-config.supportedCurrencies`). Comparar el monto contra este
   * umbral EN SU MONEDA ORIGINAL evita que el TC del día distorsione el
   * nivel de aprobación requerido.
   */
  async resolveApprovalThresholdL1(
    clientId: string,
    moneda: string
  ): Promise<number> {
    const config = await this.getConfig(clientId)
    const supported = (config.supportedCurrencies || []).find(
      c => c.code === moneda
    )
    return supported?.approvalThresholdL1 ?? 500
  }

  /**
   * Tipo de cambio moneda→base a la fecha indicada. Devuelve `null` si la
   * moneda no está soportada o no tiene TC resoluble (manual sin configurar).
   */
  async resolveRate(
    moneda: string,
    date: Date | string,
    config: AccountingConfigDocument
  ): Promise<number | null> {
    const monedaBase = config.monedaBase || 'PEN'
    if (!moneda || moneda === monedaBase) return 1

    if (moneda === 'USD' && monedaBase === 'PEN') {
      const rate = await this.exchangeRateService.getRate(date)
      if (rate) return rate
      this.logger.warn(
        `Sin TC SUNAT para USD en ${this.toIsoDate(date)}; se intentará TC manual configurado.`
      )
    }

    const supported = (config.supportedCurrencies || []).find(c => c.code === moneda)
    if (supported?.manualRate && supported.manualRate > 0) return supported.manualRate

    this.logger.error(`No se pudo resolver TC para moneda '${moneda}' (base '${monedaBase}').`)
    return null
  }

  /**
   * Convierte un monto a la moneda base, congelando el TC usado. La fecha
   * debe ser la de emisión del comprobante (regla SUNAT: TC venta a esa
   * fecha). El resultado se persiste tal cual — no se recalcula después,
   * para no alterar liquidaciones ya cerradas si el TC cambia.
   */
  async toBase(
    monto: number,
    moneda: string,
    date: Date | string,
    config: AccountingConfigDocument
  ): Promise<CurrencyConversion> {
    const tcFecha = this.toIsoDate(date)
    const rate = (await this.resolveRate(moneda, date, config)) ?? 1
    return {
      montoBase: this.round2((Number(monto) || 0) * rate),
      tipoCambio: rate,
      tcFecha,
    }
  }
}
