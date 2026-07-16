/**
 * Backfill: crea el `Saldo` (bolsa) faltante para rendiciones que ya se
 * liquidaron con `settlement.type = 'devolucion'` y remanente a favor del
 * colaborador, pero cuya creación de saldo nunca se disparó porque el
 * documento se liquidó antes de que `SaldoService.createFromRemnant` se
 * integrara en los flujos de liquidación (`AdvanceService.liquidateExpenseReport`,
 * `ExpenseReportService.settleDirectaFinanciadaConBolsa`,
 * `ExpenseReportService.liquidateViaticoReport`).
 *
 * Reproduce exactamente la misma forma de documento que esos flujos generan
 * hoy: { clientId, userId, type: isDirecta ? 'rendicion_directa' : 'rendicion',
 * amount: settlement.difference, status: 'available', projectId, sourceReportId,
 * createdBy: userId }.
 *
 * Excluye rendiciones cuyo remanente ya tuvo otro destino (evita duplicar el
 * dinero disponible):
 * - `returnVoucher` presente: el sobrante ya se devolvió físicamente a la empresa.
 * - `pendingBalanceUsedInRendicionId` / `pendingBalanceUsedInAdvanceId`: el
 *   sobrante ya se trasladó manualmente a otra rendición/anticipo.
 *
 * Idempotente: usa `sourceReportId` (índice único parcial en `saldos`) para no
 * duplicar si ya existe un saldo para esa rendición; re-ejecutar es seguro.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-saldo-remnants.ts
 *   DRY_RUN=true npx ts-node -r tsconfig-paths/register src/scripts/backfill-saldo-remnants.ts
 */
import * as dns from 'node:dns'
import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'

dotenv.config()

// Mismo fix que main.ts: en algunos entornos Node resuelve mal el SRV de
// mongodb+srv://; NODE_DNS_SERVERS=8.8.8.8,1.1.1.1 lo corrige.
function applyOptionalNodeDnsServers(): void {
  const raw = process.env.NODE_DNS_SERVERS?.trim()
  if (!raw) return
  const servers = raw.split(/[\s,]+/).filter(Boolean)
  if (servers.length) dns.setServers(servers)
}

async function run() {
  applyOptionalNodeDnsServers()
  const uri = process.env.MONGO_URI ?? process.env.MONGODB_URI ?? process.env.DB_URI
  if (!uri) throw new Error('Variable de entorno MONGO_URI, MONGODB_URI o DB_URI no definida')
  const dryRun = process.env.DRY_RUN === 'true'

  await mongoose.connect(uri)
  console.log(`Conectado a MongoDB${dryRun ? ' (DRY_RUN — no se escribirá nada)' : ''}`)

  const reports = mongoose.connection.collection('expensereports')
  const saldos = mongoose.connection.collection('saldos')

  const candidates = await reports
    .find({
      'settlement.type': 'devolucion',
      'settlement.difference': { $gt: 0.01 },
      returnVoucher: { $exists: false },
      pendingBalanceUsedInRendicionId: { $exists: false },
      pendingBalanceUsedInAdvanceId: { $exists: false },
    })
    .toArray()

  console.log(`Candidatos encontrados: ${candidates.length}`)

  let created = 0
  let skippedExisting = 0
  let skippedDuplicateRace = 0
  let errors = 0

  for (const report of candidates) {
    const existing = await saldos.findOne({ sourceReportId: report._id })
    if (existing) {
      skippedExisting++
      continue
    }

    const amount = Number(report.settlement?.difference) || 0
    if (amount <= 0.01) continue

    const doc = {
      clientId: report.clientId,
      userId: report.userId,
      type: report.isDirecta ? 'rendicion_directa' : 'rendicion',
      amount,
      moneda: report.moneda || 'PEN',
      status: 'available',
      projectId: report.projectId ?? undefined,
      sourceReportId: report._id,
      createdBy: report.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    console.log(
      `${dryRun ? '[DRY_RUN] Crearía' : 'Creando'} saldo: reporte=${report._id} ` +
        `codigo=${report.codigo ?? '-'} tipo=${doc.type} monto=${amount.toFixed(2)}`
    )

    if (dryRun) {
      created++
      continue
    }

    try {
      await saldos.insertOne(doc)
      created++
    } catch (err: any) {
      if (err?.code === 11000) {
        skippedDuplicateRace++
      } else {
        errors++
        console.error(`Error creando saldo para reporte ${report._id}:`, err)
      }
    }
  }

  console.log('--- Resumen ---')
  console.log(`Creados: ${created}`)
  console.log(`Ya tenían saldo: ${skippedExisting}`)
  console.log(`Duplicado detectado al insertar: ${skippedDuplicateRace}`)
  console.log(`Errores: ${errors}`)

  await mongoose.disconnect()
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
