/**
 * Simulación end-to-end de un viático en dólares, contra la BD que apunte
 * MONGO_URI (pensado para el clon local). Reproduce el caso reportado por el
 * cliente: viático de USD 450 a Buenos Aires, una Declaración Jurada del
 * exterior (alimentación + movilidad) y un comprobante pagado en soles en Perú.
 *
 * Levanta el AppModule real y usa los servicios reales (createViatico,
 * aprobaciones, registro de pago, createDeclaracionJurada, expense.create), así
 * que ejercita los congelados de moneda tal cual corren en producción.
 * Al final imprime lo que mostraría la pantalla de detalle.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register src/scripts/simular-viatico-usd.ts
 *   ... --keep     deja los documentos creados en la BD (por defecto los borra)
 */
// Interruptor de producto: `EmailService.send` corta cualquier envío cuando es
// 'false'. Se fija ANTES de levantar Nest para que ninguna ruta pueda enviar.
process.env.EMAILS_ENABLED = 'false'

import { NestFactory } from '@nestjs/core'
import { AppModule } from '../app.module'
import { ExpenseReportService } from '../modules/expense-report/expense-report.service'
import { ExpenseService } from '../modules/expense/expense.service'
import { getModelToken } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { ROLES } from '../modules/auth/enums/roles.enum'
import { MailerService } from '@nestjs-modules/mailer'
import { EmailService } from '../modules/email/email.service'
import { ExchangeRateService } from '../modules/exchange-rate/exchange-rate.service'

/**
 * TC SUNAT por fecha para la simulación. Este entorno no tiene token de
 * Decolecta y las filas cacheadas son de un proveedor no confiable, así que
 * `getRate` devolvería null y todo se congelaría a TC 1. Se fija una tabla con
 * un TC DISTINTO por día para poder comprobar que cada gasto usa el de su fecha.
 */
const TC_SIMULADO: Record<string, number> = {
  '2026-07-05': 3.560,
  '2026-07-06': 3.556,
  '2026-07-07': 3.540,
  '2026-07-08': 3.522,
  '2026-07-09': 3.505,
}

/** Por defecto la rendición QUEDA en la BD para poder abrirla en la app local. */
const LIMPIAR = process.argv.includes('--limpiar')
const EMAIL_COLABORADOR =
  process.argv.find(a => a.startsWith('--email='))?.split('=')[1] ??
  'ivantorres22_8@hotmail.com'

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2)

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  })

  const reportService = app.get(ExpenseReportService)
  const expenseService = app.get(ExpenseService)
  const userModel = app.get<Model<any>>(getModelToken('User'))
  const projectModel = app.get<Model<any>>(getModelToken('Project'))
  const categoryModel = app.get<Model<any>>(getModelToken('Category'))
  const reportModel = app.get<Model<any>>(getModelToken('ExpenseReport'))
  const expenseModel = app.get<Model<any>>(getModelToken('Expense'))

  const created: { reports: string[]; expenses: string[] } = {
    reports: [],
    expenses: [],
  }

  // ── Efectos externos apagados ────────────────────────────────────────────
  // Sin esto la simulación manda correos reales a los destinatarios que tenga
  // configurados la BD y deja notificaciones colgadas.
  // Triple candado sobre el correo:
  //  1. EMAILS_ENABLED=false (arriba) — el corte que ya trae el producto.
  //  2. `EmailService.send`, embudo único por el que pasa TODO envío: se
  //     reemplaza por un contador, así queda evidencia de qué se habría enviado.
  //  3. el transporte (`MailerService.sendMail`), por si alguna ruta lo llamara
  //     sin pasar por el embudo.
  let correosBloqueados = 0
  const bloquear = (etapa: string) => async (opts: any) => {
    correosBloqueados++
    console.log(`  [CORREO BLOQUEADO en ${etapa}] ${opts?.to} — ${opts?.subject}`)
    return undefined
  }
  const emailProto = Object.getPrototypeOf(app.get(EmailService)) as Record<
    string,
    unknown
  >
  emailProto['send'] = bloquear('EmailService.send')
  const mailer = app.get(MailerService) as unknown as Record<string, unknown>
  mailer['sendMail'] = bloquear('MailerService.sendMail')
  // Las notificaciones in-app se dejan activas: son parte de la rendición y no
  // salen de la plataforma.

  // TC determinista por fecha (ver TC_SIMULADO).
  const exchangeRate = app.get(ExchangeRateService) as unknown as Record<string, unknown>
  exchangeRate['getRate'] = async (date: Date | string) => {
    const iso =
      typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10)
    return TC_SIMULADO[iso] ?? 3.5
  }

  try {
    // ── 1. Actores: un colaborador con firma, su proyecto y dos categorías ──
    const user: any = await userModel.findOne({ email: EMAIL_COLABORADOR }).lean()
    if (!user) throw new Error(`No existe el usuario ${EMAIL_COLABORADOR}`)
    if (!user.signature?.trim()) {
      throw new Error(
        `${EMAIL_COLABORADOR} no tiene firma digital registrada; el viático la exige.`
      )
    }
    const clientId = String(user.clientId?._id ?? user.clientId)
    const project: any = await projectModel
      .findOne({ clientId: new Types.ObjectId(clientId), isActive: { $ne: false } })
      .lean()
    if (!project) throw new Error(`El cliente ${clientId} no tiene proyectos activos`)
    const categories: any[] = await categoryModel
      .find({ clientId: new Types.ObjectId(clientId), isActive: { $ne: false } })
      .limit(2)
      .lean()
    if (categories.length < 2) throw new Error('Se necesitan 2 categorías activas')

    console.log('── Actores ──────────────────────────────────────────────')
    console.log(`Colaborador : ${user.name} (${user.email})`)
    console.log(`Proyecto    : ${project.name}`)
    console.log(`Categorías  : ${categories.map((c: any) => c.name).join(' / ')}`)

    // ── 2. Solicitud del viático en USD ──────────────────────────────────
    const viatico = await reportService.createViatico(
      {
        place: 'Buenos Aires, Argentina',
        startDate: '2026-07-06',
        endDate: '2026-07-09',
        projectId: String(project._id),
        moneda: 'USD',
        amount: 450,
        lines: [
          {
            categoryId: String(categories[0]._id),
            detalle: 'Viáticos por 3 días en el exterior',
            importe: 150,
            peopleCount: 1,
            glpPerDay: 0,
            days: 3,
            lineTotal: 450,
          },
        ],
      } as any,
      String(user._id),
      clientId,
      true, // allowBackdate: el viaje ya ocurrió
      ROLES.COLABORADOR
    )
    const viaticoId = String((viatico as any)._id)
    created.reports.push(viaticoId)

    console.log('\n── Solicitud creada ─────────────────────────────────────')
    console.log(`Código      : ${(viatico as any).codigo ?? '—'}`)
    console.log(`Moneda      : ${viatico.moneda}`)
    console.log(
      `Monto       : ${viatico.moneda} ${money(viatico.viaticoAmount ?? 0)} ` +
        `(base S/ ${money(viatico.viaticoAmountBase ?? 0)} · TC ${viatico.tipoCambio} del ${viatico.tcFecha})`
    )

    // ── 3. Aprobaciones y depósito de Contabilidad, en dólares ───────────
    const approver = { approvedBy: String(user._id), notes: 'simulación' }
    let current: any = await reportModel.findById(viaticoId).lean()
    if (current.status === 'pending_l1') {
      await reportService.approveViaticoL1(viaticoId, approver, ROLES.SUPER_ADMIN)
      current = (await reportModel.findById(viaticoId).lean()) as any
    }
    if (current.status === 'pending_l2') {
      await reportService.approveViaticoL2(viaticoId, approver, ROLES.SUPER_ADMIN)
    }
    await reportService.registerViaticoPayment(
      viaticoId,
      {
        method: 'efectivo',
        amount: 450,
        transferDate: '2026-07-05',
        reference: 'simulación',
      } as any,
      ROLES.CONTABILIDAD
    )
    current = (await reportModel.findById(viaticoId).lean()) as any
    console.log(
      `Depositado  : ${current.moneda} ${money(current.viaticoPaidAmount ?? 0)} · estado ${current.status}`
    )

    // ── 4. Gastos del viaje ──────────────────────────────────────────────
    // 4a. Declaración Jurada del exterior (sin comprobante, montos en dólares)
    const dj = await expenseService.createDeclaracionJurada({
      proyectId: String(project._id),
      clientId,
      userId: String(user._id),
      expenseReportId: viaticoId,
      moneda: 'US$',
      destino: 'Buenos Aires',
      pais: 'Argentina',
      lugarFirma: 'Lima',
      alimentacion: {
        categoryId: String(categories[0]._id),
        rows: [
          { fecha: '08/07/2026', monto: 44 },
          { fecha: '09/07/2026', monto: 44 },
        ],
      },
      movilidad: {
        categoryId: String(categories[1]._id),
        rows: [{ fecha: '07/07/2026', monto: 219 }],
      },
    } as any)
    created.expenses.push(...dj.expenses.map((e: any) => String(e._id)))

    // 4b. Comprobante pagado en soles, en Perú, antes de viajar
    const enSoles = await expenseService.create({
      categoryId: String(categories[0]._id),
      proyectId: String(project._id),
      clientId,
      expenseReportId: viaticoId,
      userId: String(user._id),
      total: 54.45,
      moneda: 'PEN',
      fechaEmision: '2026-07-06',
      expenseType: 'otros_gastos',
      status: 'pending',
      data: JSON.stringify({ type: 'otros_gastos', concepto: 'Alimentación en Lima' }),
    } as any)
    // `expenseService.create` ya lo vincula a la rendición; no hay que volver a
    // llamar a `addExpenseToReport`.
    created.expenses.push(String((enSoles as any)._id))

    // ── 5. Lo que ve la pantalla de detalle ──────────────────────────────
    const final: any = await reportModel.findById(viaticoId).lean()
    const expenses: any[] = await expenseModel
      .find({ _id: { $in: final.expenseIds } })
      .lean()

    const tcViatico = Number(final.tipoCambio) || 1
    const enMonedaReporte = (e: any): number => {
      if (typeof e.montoReporte === 'number' && e.monedaReporte === final.moneda)
        return e.montoReporte
      if ((e.moneda ?? 'PEN') === final.moneda) return Number(e.total) || 0
      return (Number(e.montoBase ?? e.total) || 0) / tcViatico
    }

    console.log('\n── Comprobantes ─────────────────────────────────────────')
    console.log(
      'concepto'.padEnd(26) +
        'nativo'.padStart(12) +
        'base (S/)'.padStart(12) +
        'TC día'.padStart(9) +
        `en ${final.moneda}`.padStart(11)
    )
    let gastadoReporte = 0
    let gastadoBase = 0
    for (const e of expenses) {
      const enReporte = enMonedaReporte(e)
      gastadoReporte += enReporte
      gastadoBase += Number(e.montoBase ?? e.total) || 0
      const etiqueta = e.declaracionJurada
        ? `DJ ${e.declaracionJuradaRows?.length ?? 0} fila(s)`
        : 'Comprobante en soles'
      console.log(
        etiqueta.padEnd(26) +
          `${e.moneda ?? 'PEN'} ${money(e.total)}`.padStart(12) +
          money(Number(e.montoBase ?? e.total)).padStart(12) +
          String(e.tcReporte ?? e.tipoCambio ?? '—').padStart(9) +
          money(enReporte).padStart(11)
      )
    }

    gastadoReporte = Math.round(gastadoReporte * 100) / 100
    gastadoBase = Math.round(gastadoBase * 100) / 100
    const financiado = Number(final.viaticoPaidAmount ?? 0)
    const saldo = Math.round((financiado - gastadoReporte) * 100) / 100

    console.log('\n── Tarjetas del detalle ─────────────────────────────────')
    console.log(
      `Presupuesto      : ${final.moneda} ${money(final.viaticoAmount ?? 0)}   ` +
        `≈ S/ ${money(final.viaticoAmountBase ?? 0)} (TC ${final.tipoCambio})`
    )
    console.log(
      `Total Gastado    : ${final.moneda} ${money(gastadoReporte)}   ≈ S/ ${money(gastadoBase)}`
    )
    console.log(
      `Saldo Disponible : ${final.moneda} ${money(saldo)}   ≈ S/ ${money(saldo * tcViatico)}`
    )
  } finally {
    if (!LIMPIAR) {
      console.log('\n── Documentos creados (quedan en la BD local) ───────────')
      console.log(`Rendición: ${created.reports.join(', ')}`)
      console.log(`Gastos   : ${created.expenses.join(', ')}`)
      console.log('Para borrarlos: repetir el script con --limpiar')
    } else {
      if (created.expenses.length) {
        await expenseModel.deleteMany({
          _id: { $in: created.expenses.map(id => new Types.ObjectId(id)) },
        })
      }
      if (created.reports.length) {
        await reportModel.deleteMany({
          _id: { $in: created.reports.map(id => new Types.ObjectId(id)) },
        })
      }
      console.log(
        `\nLimpieza: ${created.reports.length} rendición(es) y ${created.expenses.length} gasto(s) eliminados.`
      )
    }
    console.log(
      `Correos bloqueados: ${correosBloqueados} (EMAILS_ENABLED=false + transporte interceptado)`
    )
    await app.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
