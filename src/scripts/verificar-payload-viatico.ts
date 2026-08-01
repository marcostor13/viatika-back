/**
 * Verifica que los endpoints que consume el detalle de una rendición entreguen
 * los campos de moneda que el front necesita. Usa los mismos métodos de
 * servicio que invocan los controladores (findOne y findExpensesPaginated), sin
 * pasar por HTTP.
 *
 * Uso: npx ts-node -r tsconfig-paths/register src/scripts/verificar-payload-viatico.ts <reportId>
 */
process.env.EMAILS_ENABLED = 'false'

import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { ExpenseReportService } from '../modules/expense-report/expense-report.service'

const REPORT_ID = process.argv[2]

async function main() {
  if (!REPORT_ID) throw new Error('Falta el id de la rendición')
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  })
  const reports = app.get(ExpenseReportService)

  try {
    const detalle = (await reports.findOne(REPORT_ID)) as any
    console.log('── GET /expense-report/:id ──────────────────────────────')
    console.log({
      moneda: detalle.moneda,
      tipoCambio: detalle.tipoCambio,
      viaticoAmount: detalle.viaticoAmount,
      viaticoAmountBase: detalle.viaticoAmountBase,
      viaticoPaidAmount: detalle.viaticoPaidAmount,
    })

    const faltantes: string[] = []
    console.log('\nexpenseIds poblados:')
    for (const e of detalle.expenseIds as any[]) {
      const fila = {
        total: e.total,
        moneda: e.moneda,
        montoBase: e.montoBase,
        monedaReporte: e.monedaReporte,
        tcReporte: e.tcReporte,
        montoReporte: e.montoReporte,
      }
      console.log(' ', fila)
      if (fila.montoReporte === undefined) faltantes.push(String(e._id))
    }

    const pagina = (await reports.findExpensesPaginated(REPORT_ID, {
      page: 1,
      limit: 10,
    })) as any
    console.log('\n── GET /expense-report/:id/expenses (paginado) ──────────')
    for (const e of pagina.data as any[]) {
      console.log(' ', {
        total: e.total,
        moneda: e.moneda,
        monedaReporte: e.monedaReporte,
        tcReporte: e.tcReporte,
        montoReporte: e.montoReporte,
      })
      if (e.montoReporte === undefined) faltantes.push(String(e._id))
    }

    // Suma tal como la hace el front (expenseAmountInReportCurrency).
    const tc = Number(detalle.tipoCambio) || 1
    const total = (detalle.expenseIds as any[]).reduce((sum, e) => {
      if (typeof e.montoReporte === 'number' && e.monedaReporte === detalle.moneda)
        return sum + e.montoReporte
      if ((e.moneda ?? 'PEN') === detalle.moneda) return sum + (Number(e.total) || 0)
      return sum + (Number(e.montoBase ?? e.total) || 0) / tc
    }, 0)
    const gastado = Math.round(total * 100) / 100
    const saldo =
      Math.round((Number(detalle.viaticoPaidAmount ?? 0) - gastado) * 100) / 100

    console.log('\n── Lo que pintaría el detalle ───────────────────────────')
    console.log(`Presupuesto      : ${detalle.moneda} ${detalle.viaticoAmount}`)
    console.log(`Total Gastado    : ${detalle.moneda} ${gastado.toFixed(2)}`)
    console.log(`Saldo Disponible : ${detalle.moneda} ${saldo.toFixed(2)}`)

    // En una rendición en moneda base el congelado no se escribe: no hay nada
    // que convertir. Solo es un aviso cuando la rendición es en otra moneda.
    const enMonedaBase = !detalle.moneda || detalle.moneda === 'PEN'
    if (enMonedaBase) {
      console.log(
        '\nOK: rendición en moneda base, los importes se usan tal cual (sin congelado por moneda de reporte).'
      )
    } else {
      console.log(
        faltantes.length === 0
          ? '\nOK: todos los comprobantes traen el congelado a la moneda de la rendición.'
          : `\nATENCIÓN: ${faltantes.length} comprobante(s) sin montoReporte; se usará el respaldo por TC del viático (gastos anteriores al campo).`
      )
    }
  } finally {
    await app.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
