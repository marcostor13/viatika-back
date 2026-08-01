/**
 * Corrige las Declaraciones Juradas registradas ANTES del fix de moneda: se
 * guardaban siempre como soles (`moneda: 'PEN'`, `montoBase = total`) aunque
 * pertenecieran a un viático en moneda extranjera, con lo que el "Total
 * gastado" del viático salía en soles contra un presupuesto en dólares.
 *
 * Qué hace: para cada gasto con `declaracionJurada: true` que cuelga de una
 * rendición con `moneda !== 'PEN'`, reescribe la moneda del gasto con la del
 * viático y recongela `montoBase` con el TC del propio viático.
 *
 * NO toca los demás comprobantes (una boleta en soles emitida en Perú dentro
 * de un viático en dólares es correcta tal como está: se convierte al mostrar).
 *
 * Uso:
 *   # 1) auditoría (no escribe nada)
 *   npx ts-node -r tsconfig-paths/register src/scripts/fix-dj-moneda-extranjera.ts
 *   # 2) aplicar (respalda antes en ../backups/)
 *   npx ts-node -r tsconfig-paths/register src/scripts/fix-dj-moneda-extranjera.ts --apply
 *
 * Opcional: --report=<expenseReportId> para acotarlo a una sola rendición.
 */
import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

dotenv.config()

const APPLY = process.argv.includes('--apply')
const REPORT_ARG = process.argv
  .find(a => a.startsWith('--report='))
  ?.split('=')[1]

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

async function run() {
  const uri = process.env.MONGODB_URI ?? process.env.DB_URI
  if (!uri) throw new Error('Variable de entorno MONGODB_URI o DB_URI no definida')

  await mongoose.connect(uri)
  console.log(`Conectado a MongoDB — modo ${APPLY ? 'APLICAR' : 'AUDITORÍA (dry-run)'}`)

  const reportsCol = mongoose.connection.collection('expensereports')
  const expensesCol = mongoose.connection.collection('expenses')

  const reportFilter: Record<string, unknown> = {
    moneda: { $exists: true, $nin: [null, '', 'PEN'] },
    tipoCambio: { $gt: 0 },
  }
  if (REPORT_ARG) reportFilter._id = new mongoose.Types.ObjectId(REPORT_ARG)

  const reports = await reportsCol.find(reportFilter).toArray()
  console.log(`Rendiciones en moneda extranjera: ${reports.length}`)

  const pending: Array<Record<string, unknown>> = []

  for (const report of reports) {
    const tc = Number(report.tipoCambio)
    const moneda = String(report.moneda)
    const djs = await expensesCol
      .find({
        expenseReportId: report._id,
        declaracionJurada: true,
        $or: [{ moneda: { $exists: false } }, { moneda: 'PEN' }],
      })
      .toArray()

    for (const dj of djs) {
      const total = Number(dj.total) || 0
      pending.push({
        expenseId: dj._id,
        reportId: report._id,
        reportCodigo: report.codigo,
        total,
        antes: {
          moneda: dj.moneda ?? null,
          montoBase: dj.montoBase ?? null,
          tipoCambio: dj.tipoCambio ?? null,
          tcFecha: dj.tcFecha ?? null,
        },
        despues: {
          moneda,
          montoBase: round2(total * tc),
          tipoCambio: tc,
          tcFecha: dj.tcFecha ?? report.tcFecha ?? dj.fechaEmision ?? null,
        },
      })
    }
  }

  if (pending.length === 0) {
    console.log('No hay declaraciones juradas por corregir.')
    await mongoose.disconnect()
    return
  }

  console.table(
    pending.map(p => ({
      rendicion: p.reportCodigo,
      gasto: String(p.expenseId),
      total: p.total,
      moneda: `${(p.antes as any).moneda} → ${(p.despues as any).moneda}`,
      montoBase: `${(p.antes as any).montoBase} → ${(p.despues as any).montoBase}`,
    }))
  )
  console.log(`Total a corregir: ${pending.length} gasto(s)`)

  if (!APPLY) {
    console.log('Dry-run: no se escribió nada. Repite con --apply para aplicar.')
    await mongoose.disconnect()
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = path.resolve(__dirname, '../../../backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const backupPath = path.join(backupDir, `dj-moneda-extranjera-${stamp}.json`)
  fs.writeFileSync(backupPath, JSON.stringify(pending, null, 2), 'utf8')
  console.log(`Respaldo escrito en ${backupPath}`)

  let updated = 0
  for (const p of pending) {
    const after = p.despues as Record<string, unknown>
    const res = await expensesCol.updateOne(
      { _id: p.expenseId as mongoose.Types.ObjectId },
      {
        $set: {
          moneda: after.moneda,
          montoBase: after.montoBase,
          tipoCambio: after.tipoCambio,
          ...(after.tcFecha ? { tcFecha: after.tcFecha } : {}),
        },
      }
    )
    updated += res.modifiedCount
  }
  console.log(`Actualizados: ${updated} gasto(s)`)
  console.log(
    'Recuerda recalcular la liquidación del viático si ya estaba liquidado ' +
      '(el settlement guardado se calculó con los montos anteriores).'
  )

  await mongoose.disconnect()
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
