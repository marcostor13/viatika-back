import * as dns from 'node:dns'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { ExchangeRateService } from '../modules/exchange-rate/exchange-rate.service'

// Mismo fix que main.ts: en algunos entornos Node resuelve mal el SRV de
// mongodb+srv://; NODE_DNS_SERVERS=8.8.8.8,1.1.1.1 lo corrige. Se aplica aquí
// porque createApplicationContext NO ejecuta el bootstrap de main.ts.
function applyOptionalNodeDnsServers(): void {
  const raw = process.env.NODE_DNS_SERVERS?.trim()
  if (!raw) return
  const servers = raw.split(/[\s,]+/).filter(Boolean)
  if (servers.length) dns.setServers(servers)
}

/**
 * Siembra tipos de cambio oficiales SUNAT desde un JSON export directo de SUNAT
 * (campos "Fecha"/"Compra"/"Venta"). Persiste el TC "Venta" con origen
 * `sunat-oficial` (confiable, prioritario), de modo que esas fechas se usen tal
 * cual y jamás gasten cuota de Decolecta. Idempotente (upsert por fecha).
 *
 * Uso (desde viatika-back/):
 *   npm run seed:tc                              # usa docs/tipos_de_cambio.json
 *   npm run seed:tc -- --file=/ruta/al/tc.json   # otro archivo
 */
type SunatRow = { Fecha: string; Compra: number; Venta: number }

async function bootstrap() {
  applyOptionalNodeDnsServers()
  const fileArg = process.argv.slice(2).find(a => a.startsWith('--file='))
  const file = fileArg
    ? fileArg.slice('--file='.length)
    : resolve(__dirname, '../../../docs/tipos_de_cambio.json')

  const raw = JSON.parse(readFileSync(file, 'utf8')) as SunatRow[]
  if (!Array.isArray(raw)) throw new Error('El JSON debe ser un arreglo de tasas.')
  const rows = raw.map(r => ({ fecha: r.Fecha, venta: r.Venta }))

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  })
  try {
    const svc = app.get(ExchangeRateService)
    console.log(`--- Seed TC oficial SUNAT ---`)
    console.log(`Archivo: ${file}`)
    console.log(`Registros leídos: ${rows.length}`)
    const result = await svc.importOfficialRates(rows)
    console.log('--- Resultado ---')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await app.close()
  }
}

bootstrap().catch(err => {
  console.error('Seed de TC falló:', err)
  process.exit(1)
})
