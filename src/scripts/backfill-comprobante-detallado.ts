import * as dns from 'node:dns'
import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { ExpenseService } from '../modules/expense/expense.service'

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
 * Backfill de `comprobanteDetallado` para facturas escaneadas antes de que ese
 * campo existiera. Re-escanea la imagen/PDF (guardado en S3, URL en `file`) con
 * el mismo motor de extracción y agrega el campo faltante. Idempotente y seguro:
 * solo toca facturas sin el campo y no pisa el desglose revisado a mano.
 *
 * Uso (desde viatika-back/):
 *   npm run backfill:comprobante -- --count             # solo cuenta, SIN llamar a OpenAI
 *   npm run backfill:comprobante -- --dry-run --limit=5 # re-escanea 5 pero NO escribe (valida)
 *   npm run backfill:comprobante -- --limit=10          # procesa y escribe solo 10 (prueba)
 *   npm run backfill:comprobante -- --client=<clientId> # solo una empresa
 *   npm run backfill:comprobante -- --concurrency=5     # workers en paralelo (1-8)
 *   npm run backfill:comprobante                        # corre todo
 *
 * Flags combinables. Recomendado: primero --dry-run, luego --limit=5 para validar,
 * y recién después la corrida completa.
 */
function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const pref = `--${name}=`
    const hit = argv.find(a => a.startsWith(pref))
    return hit ? hit.slice(pref.length) : undefined
  }
  return {
    dryRun: argv.includes('--dry-run'),
    countOnly: argv.includes('--count') || argv.includes('--count-only'),
    limit: get('limit') ? Number(get('limit')) : undefined,
    clientId: get('client') || get('clientId'),
    concurrency: get('concurrency') ? Number(get('concurrency')) : undefined,
  }
}

async function bootstrap() {
  applyOptionalNodeDnsServers()
  const opts = parseArgs(process.argv.slice(2))
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  })
  try {
    const expenseService = app.get(ExpenseService)
    console.log('--- Backfill comprobanteDetallado ---')
    console.log('Opciones:', JSON.stringify(opts))
    const result = await expenseService.backfillComprobanteDetallado(opts)
    console.log('--- Resultado ---')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await app.close()
  }
}

bootstrap().catch(err => {
  console.error('Backfill falló:', err)
  process.exit(1)
})
