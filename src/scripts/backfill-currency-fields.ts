/**
 * Migración multimoneda: congela `moneda='PEN'`, `tipoCambio=1` y el
 * equivalente en moneda base (`montoBase`/`budgetBase`/etc.) para todos los
 * documentos existentes (previos a la introducción del modelo de doble
 * monto). Sin esto, las agregaciones que pasen a leer `montoBase` verían
 * `undefined` en cualquier registro histórico.
 *
 * Idempotente: cada `updateMany` solo toca documentos donde `moneda` aún no
 * existe, así que reejecutarlo no vuelve a tocar nada.
 *
 * Uso: npx ts-node -r tsconfig-paths/register src/scripts/backfill-currency-fields.ts
 */
import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'

dotenv.config()

async function run() {
  const uri = process.env.MONGODB_URI ?? process.env.DB_URI
  if (!uri) throw new Error('Variable de entorno MONGODB_URI o DB_URI no definida')

  await mongoose.connect(uri)
  console.log('Conectado a MongoDB')

  const tcFechaFromCreatedAt = {
    $dateToString: { format: '%Y-%m-%d', date: { $ifNull: ['$createdAt', '$$NOW'] } },
  }

  // --- Expense: total → montoBase ---
  const expenses = await mongoose.connection.collection('expenses').updateMany(
    { moneda: { $exists: false } },
    [
      {
        $set: {
          moneda: 'PEN',
          tipoCambio: 1,
          tcFecha: { $ifNull: ['$fechaEmision', tcFechaFromCreatedAt] },
          montoBase: { $ifNull: ['$total', 0] },
        },
      },
    ]
  )
  console.log(`expenses: ${expenses.modifiedCount} documentos`)

  // --- Advance: amount → montoBase ---
  const advances = await mongoose.connection.collection('advances').updateMany(
    { moneda: { $exists: false } },
    [
      {
        $set: {
          moneda: 'PEN',
          tipoCambio: 1,
          tcFecha: tcFechaFromCreatedAt,
          montoBase: { $ifNull: ['$amount', 0] },
        },
      },
    ]
  )
  console.log(`advances: ${advances.modifiedCount} documentos`)

  // --- ExpenseReport: budget/viaticoAmount/viaticoPaidAmount/pendingBalanceAmount ---
  const reports = await mongoose.connection.collection('expensereports').updateMany(
    { moneda: { $exists: false } },
    [
      {
        $set: {
          moneda: 'PEN',
          tipoCambio: 1,
          tcFecha: tcFechaFromCreatedAt,
          budgetBase: { $ifNull: ['$budget', 0] },
          viaticoAmountBase: '$viaticoAmount',
          viaticoPaidAmountBase: '$viaticoPaidAmount',
          pendingBalanceAmountBase: '$pendingBalanceAmount',
        },
      },
    ]
  )
  console.log(`expensereports: ${reports.modifiedCount} documentos`)

  // --- Saldo: amount ya está en moneda base por construcción ---
  const saldos = await mongoose.connection
    .collection('saldos')
    .updateMany({ moneda: { $exists: false } }, { $set: { moneda: 'PEN' } })
  console.log(`saldos: ${saldos.modifiedCount} documentos`)

  // --- PettyCash: fondo declarado en una sola moneda ---
  const pettyCash = await mongoose.connection
    .collection('pettycashes')
    .updateMany({ moneda: { $exists: false } }, { $set: { moneda: 'PEN' } })
  console.log(`pettycashes: ${pettyCash.modifiedCount} documentos`)

  await mongoose.disconnect()
  console.log('Backfill completo.')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
