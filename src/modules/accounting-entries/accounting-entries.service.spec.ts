import { AccountingEntriesService } from './accounting-entries.service'
import { ContanetLine } from './entities/contanet-columns'
import {
  buildContanetAoa,
  generateContanetExcel,
  resolveTemplatePath,
} from './entities/contanet-export'
import * as XLSX from 'xlsx'

/**
 * Config de prueba que replica los valores del template `compras.xlsm`.
 */
function makeConfig(): any {
  return {
    cuenta42: '42.1.2.100',
    cuenta79: '79.1.1.100',
    cuenta14Raiz: '14.1.3.100',
    igvRates: [
      { tasa: 18, cuenta40: '40.1.1.100' },
      { tasa: 10.5, cuenta40: '40.1.1.100' },
    ],
    inafectoKeywords: [],
    codModulo: '03',
    modulo: 'CT',
    fuenteCompra: 'RC',
    fuenteAplicacion: 'LD',
    fuenteCajaBancos: 'CB',
    monedaOrigen: '01',
    monedaRegistro: '01',
    identificadorCtrMda: 'A',
    conceptoFec: '1',
    area: '010101',
    centroCosto: 'SC',
    subCentroCosto: '62747',
    tipoCambio: 1,
    cuentaReembolso: '14',
    bankAccounts: [
      {
        banco: 'BCP',
        nroCuenta: '123',
        cuentaContable: '10.4.1.100',
        activo: true,
      },
    ],
  }
}

const TC = 3.5 // tipo de cambio de prueba (PEN/USD)

function newService(): AccountingEntriesService {
  const stub: any = {}
  const exchangeStub: any = { getRate: async () => TC }
  const configStub: any = { get: () => 'test-api-key' }
  const uploadStub: any = {}
  // (reportModel, expenseModel, advanceModel, projectModel, userModel, categoryModel, fileModel, accountingConfigService, exchangeService, configService, uploadService)
  return new AccountingEntriesService(
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    exchangeStub,
    configStub,
    uploadStub
  )
}

function sum(lines: ContanetLine[], field: 'montoDebe' | 'montoHaber'): number {
  return (
    Math.round(lines.reduce((s, l) => s + (Number(l[field]) || 0), 0) * 100) /
    100
  )
}

describe('AccountingEntriesService — asiento de compra', () => {
  const service = newService()
  const config = makeConfig()

  // Categoría ALIMENTACION → 9X 91.3.1.410, destino 6X 63.1.4.100
  const categoryMap = new Map<string, any>([
    [
      'cat1',
      { _id: 'cat1', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' },
    ],
  ])
  // Centro de costo (proyecto) con código.
  const projectMap = new Map<string, any>([
    [
      'p1',
      {
        _id: 'p1',
        code: 'CC-01',
        centroCosto: 'SC',
        subCentroCosto: '62747',
        area: '010101',
      },
    ],
  ])

  // Imagen 3: base 46.28 + IGV 18% (8.33) + recargo 1.39 = 56.00
  const expense = {
    _id: 'e1',
    proyectId: 'p1',
    categoryId: 'cat1',
    total: 56,
    igv: 8.33,
    tasaIgv: 18,
    comentario: 'Alimentacion',
    data: JSON.stringify({
      serie: 'F219',
      correlativo: '00001362',
      rucEmisor: '20212261516',
    }),
    comprobanteDetallado: {
      emisor: { ruc: '20212261516', razonSocial: 'INVERSIONES FIRA S.A.' },
      comprobante: { serie: 'F219', correlativo: '00001362' },
      totales: {
        operacionGravada: 46.28,
        operacionExonerada: 0,
        operacionInafecta: 0,
        igv: 8.33,
        importeTotal: 56,
      },
      recargoConsumo: 1.39,
    },
  }

  const rateMap = new Map<string, number>([['2026-04-15', TC]])
  let lines: ContanetLine[]
  beforeAll(async () => {
    lines = await (service as any).buildCompraLines({
      report: { createdAt: new Date('2026-04-15') },
      config,
      expenses: [expense],
      projectMap,
      categoryMap,
      periodDate: new Date('2026-03-01'),
      rateMap,
      cargosMap: new Map(),
      warnings: [],
    })
  })

  it('genera 8 líneas (42, 40, 9X afecto, 9X recargo, 2×(6X/79))', () => {
    expect(lines.length).toBe(8)
  })

  it('cuadra: Σ Debe = Σ Haber', () => {
    expect(sum(lines, 'montoDebe')).toBe(sum(lines, 'montoHaber'))
    expect(service.validateCuadre(lines)).toHaveLength(0)
  })

  it('la cuenta 42 lleva el total 56 al Haber con Es Provisión=1 y proveedor', () => {
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.montoHaber).toBe(56)
    expect(l42.esProvision).toBe(1)
    expect(l42.nroDocProv).toBe('20212261516')
  })

  it('la analítica 9X viene de la CATEGORÍA (91.3.1.410), no del proyecto', () => {
    const nines = lines.filter(l => l.nroCuenta === '91.3.1.410')
    expect(nines.length).toBe(2) // afecto + recargo
    expect(nines.find(l => l.identTipAfecto === 'S')!.montoDebe).toBe(46.28)
    expect(nines.find(l => l.identTipAfecto === 'N')!.montoDebe).toBe(1.39)
  })

  it('el destino 6X viene de la categoría (63.1.4.100)', () => {
    const dest = lines.filter(l => l.nroCuenta === '63.1.4.100')
    expect(dest.length).toBe(2)
  })

  it('el centro de costo (proyecto) aparece en TODAS las líneas', () => {
    expect(lines.every(l => l.centroCosto === 'SC')).toBe(true)
    expect(lines.every(l => l.subCentroCosto === '62747')).toBe(true)
  })

  it('Monto ME = monto / tipo de cambio, y Cambio Moneda = tc', () => {
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.cambioMoneda).toBe(TC)
    expect(l42.montoHaberME).toBe(Math.round((56 / TC) * 100) / 100)
  })

  it('TODAS las líneas tienen tipo de cambio y un monto ME (no solo la primera)', () => {
    expect(lines.every(l => l.cambioMoneda === TC)).toBe(true)
    expect(
      lines.every(l => Number(l.montoDebeME) > 0 || Number(l.montoHaberME) > 0)
    ).toBe(true)
  })

  it('ejercicio/periodo vienen de la fecha de inicio de la solicitud (periodDate)', () => {
    // periodDate = 2026-03-01 → ejercicio 2026, periodo '03' (no del comprobante 04).
    expect(lines.every(l => l.ejercicio === 2026)).toBe(true)
    expect(lines.every(l => l.periodo === '03')).toBe(true)
  })

  it('ninguna cuenta 91 contiene un ObjectId (regresión)', () => {
    const bad = lines.filter(
      l =>
        typeof l.nroCuenta === 'string' &&
        /^91\.[0-9a-f]{12,}/.test(l.nroCuenta)
    )
    expect(bad).toHaveLength(0)
  })
})

describe('AccountingEntriesService — tipo de documento y no deducibles', () => {
  const service = newService()
  const config = makeConfig()
  const categoryMap = new Map<string, any>([
    [
      'cat1',
      { _id: 'cat1', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' },
    ],
  ])
  const projectMap = new Map<string, any>()
  const rateMap = new Map<string, number>([['2026-04-15', TC]])
  const report = { createdAt: new Date('2026-04-15') }
  const periodDate = new Date('2026-04-01')

  async function build(expenses: any[], cargosMap = new Map()) {
    return (service as any).buildCompraLines({
      report,
      config,
      expenses,
      projectMap,
      categoryMap,
      periodDate,
      rateMap,
      cargosMap,
      warnings: [],
    }) as Promise<ContanetLine[]>
  }

  it('factura con cargo NO deducible: serie de control en Numero Documento y Cod. Tip. Doc. vacío', async () => {
    // Gravada 100 + IGV 18 + interés moratorio (otrosCargos) 10 = 128
    const expense = {
      _id: 'e2',
      categoryId: 'cat1',
      total: 128,
      igv: 18,
      tasaIgv: 18,
      comentario: 'Servicio con mora',
      data: '{}',
      comprobanteDetallado: {
        emisor: { ruc: '20212261516', razonSocial: 'PROVEEDOR SA' },
        comprobante: { tipo: 'Factura', serie: 'F001', correlativo: '100' },
        totales: {
          operacionGravada: 100,
          igv: 18,
          otrosCargos: 10,
          importeTotal: 128,
        },
      },
    }
    const cargosMap = new Map([
      [
        'e2',
        [
          {
            concepto: 'otrosCargos',
            monto: 10,
            deducible: false,
            serieControlInterno: '0003',
          },
        ],
      ],
    ])
    const lines = await build([expense], cargosMap)

    expect(service.validateCuadre(lines)).toHaveLength(0)
    const noDeducible = lines.find(l => l.nroDoc === '0003')!
    expect(noDeducible).toBeDefined()
    expect(noDeducible.codTipDoc).toBe('')
    expect(noDeducible.nroSerie).toBe('')
    expect(noDeducible.nroCuenta).toBe('91.3.1.410') // misma cuenta de la categoría
    expect(noDeducible.montoDebe).toBe(10)
    expect(String(noDeducible.glosa)).toContain('NO DEDUCIBLE')
    // Las líneas normales del comprobante conservan su documento.
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.codTipDoc).toBe('01')
    expect(l42.montoHaber).toBe(128)
  })

  it('cargo clasificado deducible: línea normal con documento y cuenta de la categoría', async () => {
    const expense = {
      _id: 'e3',
      categoryId: 'cat1',
      total: 128,
      igv: 18,
      data: '{}',
      comprobanteDetallado: {
        comprobante: { tipo: 'Factura', serie: 'F001', correlativo: '101' },
        totales: {
          operacionGravada: 100,
          igv: 18,
          otrosCargos: 10,
          importeTotal: 128,
        },
      },
    }
    const cargosMap = new Map([
      ['e3', [{ concepto: 'otrosCargos', monto: 10, deducible: true }]],
    ])
    const lines = await build([expense], cargosMap)
    expect(service.validateCuadre(lines)).toHaveLength(0)
    const cargo = lines.find(l => String(l.glosa).includes('OTROS CARGOS'))!
    expect(cargo.codTipDoc).toBe('01')
    expect(cargo.nroSerie).toBe('F001')
    expect(cargo.identTipAfecto).toBe('N')
  })

  it('ICBPER se resuelve determinista (sin IA) como porción deducible', async () => {
    const expense = {
      _id: 'e4',
      categoryId: 'cat1',
      total: 118.5,
      igv: 18,
      data: '{}',
      comprobanteDetallado: {
        comprobante: { tipo: 'Factura', serie: 'F001', correlativo: '102' },
        totales: {
          operacionGravada: 100,
          igv: 18,
          icbper: 0.5,
          importeTotal: 118.5,
        },
      },
    }
    const lines = await build([expense])
    expect(service.validateCuadre(lines)).toHaveLength(0)
    const icbper = lines.find(l => String(l.glosa).includes('ICBPER'))!
    expect(icbper.montoDebe).toBe(0.5)
    expect(icbper.identTipAfecto).toBe('N')
  })

  it('boleta: código 03, sin línea 40 y todo el importe al gasto', async () => {
    const expense = {
      _id: 'e5',
      expenseType: 'factura',
      categoryId: 'cat1',
      total: 59,
      igv: 9, // aunque la boleta muestre IGV, no hay crédito fiscal
      data: '{}',
      comprobanteDetallado: {
        comprobante: { tipo: 'Boleta', serie: 'B001', correlativo: '55' },
        totales: { operacionGravada: 50, igv: 9, importeTotal: 59 },
      },
    }
    const lines = await build([expense])
    expect(service.validateCuadre(lines)).toHaveLength(0)
    expect(lines.some(l => l.nroCuenta === '40.1.1.100')).toBe(false)
    const nine = lines.find(l => l.nroCuenta === '91.3.1.410')!
    expect(nine.montoDebe).toBe(59)
    expect(nine.codTipDoc).toBe('03')
    expect(nine.identTipAfecto).toBe('N')
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.codTipDoc).toBe('03')
    expect(l42.montoHaber).toBe(59)
  })

  it('planilla de movilidad: código 94, sin IGV, total al gasto', async () => {
    const expense = {
      _id: 'e6',
      expenseType: 'planilla_movilidad',
      categoryId: 'cat1',
      total: 45,
      internalCode: 'PM-001',
      data: '{}',
    }
    const lines = await build([expense])
    expect(service.validateCuadre(lines)).toHaveLength(0)
    const nine = lines.find(l => l.nroCuenta === '91.3.1.410')!
    expect(nine.codTipDoc).toBe('94')
    expect(nine.montoDebe).toBe(45)
    expect(nine.nroDoc).toBe('PM-001')
    expect(lines.some(l => l.nroCuenta === '40.1.1.100')).toBe(false)
  })
})

describe('AccountingEntriesService — palabras clave de conceptos inafectos', () => {
  const service = newService()

  it('matchesInafectoKeyword: detecta la palabra clave en comentario/ítems/leyendas/observaciones', () => {
    const match = (service as any).matchesInafectoKeyword.bind(service)
    expect(
      match({ comentario: 'Factura con DESCUENTO comercial' }, ['descuento'])
    ).toBe(true)
    expect(
      match(
        { comprobanteDetallado: { items: [{ descripcion: 'Descuento por pronto pago' }] } },
        ['descuento']
      )
    ).toBe(true)
    expect(
      match({ comprobanteDetallado: { leyendas: 'Incluye descuento' } }, ['descuento'])
    ).toBe(true)
    expect(match({ comentario: 'Servicio de transporte' }, ['descuento'])).toBe(
      false
    )
    expect(match({ comentario: 'Con descuento' }, [])).toBe(false)
  })

  it('resolveCargosClasificacion: excluye los cargos del comprobante cuyo concepto matchea una palabra clave (no genera 9X/6X extra)', async () => {
    const expense = {
      _id: 'e-descuento',
      expenseType: 'factura',
      comentario: 'Factura con descuento por volumen',
      comprobanteDetallado: {
        totales: { operacionGravada: 90, otrosCargos: 10, importeTotal: 100 },
      },
    }
    const map = await (service as any).resolveCargosClasificacion(
      [expense],
      ['descuento']
    )
    expect(map.has('e-descuento')).toBe(false)
  })
})

describe('AccountingEntriesService — avisos cuando falta la cuenta 9X', () => {
  const service = newService()
  const config = makeConfig()
  const projectMap = new Map<string, any>()
  const rateMap = new Map<string, number>([['2026-04-15', TC]])
  const report = { createdAt: new Date('2026-04-15') }
  const periodDate = new Date('2026-04-01')

  async function build(expenses: any[], categoryMap: Map<string, any>) {
    const warnings: string[] = []
    const lines = (await (service as any).buildCompraLines({
      report,
      config,
      expenses,
      projectMap,
      categoryMap,
      periodDate,
      rateMap,
      cargosMap: new Map(),
      warnings,
    })) as ContanetLine[]
    return { lines, warnings }
  }

  it('categoría sin cuenta 9X: no emite la línea 9X, avisa la causa exacta, y el resto queda descuadrado (no lo oculta)', async () => {
    const categoryMap = new Map<string, any>([
      ['cat-sin-9x', { _id: 'cat-sin-9x', name: 'Movilidad', cuentaDestino6x: '63.1.1.200' }],
    ])
    const expense = {
      _id: 'e1',
      categoryId: 'cat-sin-9x',
      total: 100,
      igv: 0,
      comentario: 'Taxi',
      data: '{}',
    }
    const { lines, warnings } = await build([expense], categoryMap)

    expect(lines.some(l => l.nroCuenta === '91.3.1.410')).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Movilidad')
    expect(warnings[0]).toContain('Cuenta Analítica 9X')
    // El descuadre resultante debe seguir siendo detectado (no se enmascara).
    expect(service.validateCuadre(lines).length).toBeGreaterThan(0)
  })

  it('comprobante sin categoría asignada: avisa sin asumir un nombre de categoría', async () => {
    const expense = { _id: 'e2', total: 50, igv: 0, comentario: 'Sin categoria', data: '{}' }
    const { warnings } = await build([expense], new Map())

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('sin categoría')
  })

  it('comprobante con categoryId que NO resuelve a ninguna categoría (borrada/otra empresa): aviso distinto a "sin categoría"', async () => {
    // categoryMap vacío pero el expense SÍ tiene categoryId — simula una
    // categoría borrada o que pertenece a otra empresa (clientId distinto).
    const expense = { _id: 'e-huerfano', categoryId: 'cat-borrada', total: 40, igv: 0, data: '{}' }
    const { warnings } = await build([expense], new Map())

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).not.toContain('sin categoría asignada')
    expect(warnings[0]).toContain('ya no existe o no pertenece a esta empresa')
    expect(warnings[0]).toContain('cat-borrada')
  })

  it('dos comprobantes con categoryId DISTINTOS que no resuelven: dos avisos separados (no se confunden con "sin categoría")', async () => {
    const expenses = [
      { _id: 'e-a', categoryId: 'cat-x', total: 10, igv: 0, data: '{}' },
      { _id: 'e-b', categoryId: 'cat-y', total: 20, igv: 0, data: '{}' },
    ]
    const { warnings } = await build(expenses, new Map())

    expect(warnings).toHaveLength(2)
    expect(warnings.some(w => w.includes('cat-x'))).toBe(true)
    expect(warnings.some(w => w.includes('cat-y'))).toBe(true)
  })

  it('dos comprobantes de la MISMA categoría sin cuenta 9X: un solo aviso (no uno por comprobante)', async () => {
    // cuentaDestino6x presente para aislar el test al aviso de 9X (si no, la 6X
    // faltante sumaría su propio aviso y no estaríamos midiendo el dedup de 9X).
    const categoryMap = new Map<string, any>([
      ['cat-sin-9x', { _id: 'cat-sin-9x', name: 'Movilidad', cuentaDestino6x: '63.1.1.200' }],
    ])
    const expenses = [
      { _id: 'e3', categoryId: 'cat-sin-9x', total: 10, igv: 0, data: '{}' },
      { _id: 'e4', categoryId: 'cat-sin-9x', total: 20, igv: 0, data: '{}' },
    ]
    const { warnings } = await build(expenses, categoryMap)
    expect(warnings).toHaveLength(1)
  })

  it('categoría CON cuenta 9X configurada: sin avisos, cuadra', async () => {
    const categoryMap = new Map<string, any>([
      ['cat-ok', { _id: 'cat-ok', name: 'Alimentación', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' }],
    ])
    const expense = { _id: 'e5', categoryId: 'cat-ok', total: 30, igv: 0, data: '{}' }
    const { lines, warnings } = await build([expense], categoryMap)

    expect(warnings).toHaveLength(0)
    expect(service.validateCuadre(lines)).toHaveLength(0)
  })

  it('categoría con 9X pero SIN Cuenta Destino 6X: avisa (par destino sale 79/79) pero cuadra', async () => {
    const categoryMap = new Map<string, any>([
      ['cat-sin-6x', { _id: 'cat-sin-6x', name: 'Movilidad', cuenta: '91.3.1.140' }], // sin cuentaDestino6x
    ])
    const expense = { _id: 'e6', categoryId: 'cat-sin-6x', total: 30, igv: 0, data: '{}' }
    const { lines, warnings } = await build([expense], categoryMap)

    // No descuadra (el par 79/79 se cancela solo).
    expect(service.validateCuadre(lines)).toHaveLength(0)
    // Avisa la 6X faltante, sin avisar de la 9X (que sí está).
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Cuenta Destino 6X')
    expect(warnings[0]).toContain('Movilidad')
    // El par destino usa la cuenta 79 en ambos lados (fallback config.cuenta79).
    const destino = lines.filter(l => l.esDestino === 1)
    expect(destino.length).toBe(2)
    expect(destino.every(l => l.nroCuenta === '79.1.1.100')).toBe(true)
  })

  it('categoría sin 9X ni 6X: avisa ambas cosas por separado (2 avisos)', async () => {
    const categoryMap = new Map<string, any>([
      ['cat-vacia', { _id: 'cat-vacia', name: 'Sin cuentas' }], // ni cuenta ni cuentaDestino6x
    ])
    const expense = { _id: 'e7', categoryId: 'cat-vacia', total: 30, igv: 0, data: '{}' }
    const { warnings } = await build([expense], categoryMap)

    expect(warnings).toHaveLength(2)
    expect(warnings.some(w => w.includes('Cuenta Analítica 9X'))).toBe(true)
    expect(warnings.some(w => w.includes('Cuenta Destino 6X'))).toBe(true)
  })

  it('el descuadre reporta la fila exacta de Excel y el documento afectado', async () => {
    // Primer comprobante SIN problema (ocupa filas 9+), segundo con categoría sin 9X.
    const categoryMap = new Map<string, any>([
      ['cat-ok', { _id: 'cat-ok', name: 'Alimentación', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' }],
      ['cat-sin-9x', { _id: 'cat-sin-9x', name: 'Movilidad' }],
    ])
    const okExpense = { _id: 'e-ok', categoryId: 'cat-ok', total: 30, igv: 0, data: '{}' }
    const badExpense = {
      _id: 'e-bad',
      categoryId: 'cat-sin-9x',
      total: 100,
      igv: 0,
      comprobanteDetallado: {
        emisor: { razonSocial: 'TRANSPORTES ACME SAC' },
        comprobante: { serie: 'F001', correlativo: '000123' },
      },
      data: '{}',
    }
    const { lines } = await build([okExpense, badExpense], categoryMap)
    const errors = service.validateCuadre(lines)

    expect(errors).toHaveLength(1)
    const [error] = errors
    // El comprobante conflictivo es el 2do (relacionado=2); sus filas empiezan
    // después de las líneas del 1ro (9 + cantidad de líneas de okExpense).
    const okLineCount = lines.filter(l => l.relacionado === 1).length
    expect(error.filaInicio).toBe(9 + okLineCount)
    expect(error.filaFin).toBeGreaterThanOrEqual(error.filaInicio!)
    expect(error.documento).toContain('TRANSPORTES ACME SAC')
    expect(error.documento).toContain('F001-000123')
  })
})

describe('resolveCodTipDoc — catálogo codigos.md', () => {
  const { resolveCodTipDoc } = require('./constants/tipo-documento')

  it.each([
    [{ expenseType: 'factura' }, undefined, '01'],
    [
      { expenseType: 'factura', comprobanteDetallado: { comprobante: { tipo: 'Boleta de Venta' } } },
      undefined,
      '03',
    ],
    [{ expenseType: 'factura' }, 'Ticket', '12'],
    [{ expenseType: 'planilla_movilidad' }, undefined, '94'],
    [{ expenseType: 'comprobante_caja' }, undefined, '66'],
    [{ expenseType: 'recibo_caja' }, undefined, '00'],
    [{ expenseType: 'otros_gastos', subTipo: 'TK' }, undefined, '12'],
    [{ expenseType: 'otros_gastos', subTipo: 'DJ' }, undefined, '00'],
    [{ expenseType: 'otros_gastos', subTipo: 'OT' }, undefined, '00'],
  ])('%o + %s → %s', (expense, dataTipo, expected) => {
    expect(resolveCodTipDoc(expense as any, dataTipo as any)).toBe(expected)
  })
})

describe('Export Contanet — cabeceras (replica sheet1)', () => {
  // Datos en fila 9 (índice 8): fila1..fila8 son cabeceras.
  const aoa = buildContanetAoa([{ correlativo: 1, relacionado: 1 }])
  const D = 3 // índice columna D

  it('fila 2: zona a importar', () => {
    expect(aoa[1][1]).toBe('Zona Límite a  Importar')
    expect(aoa[1][2]).toBe('CONTABILIDAD')
  })

  it('fila 3: obligatorio (*) en columnas clave', () => {
    expect(aoa[2][D]).toBe('(*)') // Correlativo
    expect(aoa[2][D + 1]).toBe('(*)') // Relacionado
  })

  it('fila 4: tipo de dato (Correlativo=Entero, Monto Debe=Decimal)', () => {
    expect(aoa[3][D]).toBe('Entero')
    expect(aoa[3][D + 42]).toBe('Decimal') // montoDebe (col AT)
  })

  it('fila 5: cantidad de caracteres (Nro Cuenta=50)', () => {
    expect(aoa[4][D + 8]).toBe('50') // nroCuenta (col L)
  })

  it('fila 6: grupos', () => {
    expect(aoa[5][D]).toBe('Codigo Correlativo cabecera')
    expect(aoa[5][D + 1]).toBe('INFORMACIÓN GENERAL')
  })

  it('fila 7 y 8: encabezados', () => {
    expect(aoa[6][D]).toBe('Correlativo')
    expect(aoa[6][D + 1]).toBe('Relacionado')
    expect(aoa[7][D + 5]).toBe('Cod_MR') // h8 de codModulo (col I)
  })

  it('los datos empiezan en la fila 9 (índice 8)', () => {
    expect(aoa[8][D]).toBe(1)
    expect(aoa[8][D + 1]).toBe(1)
  })
})

describe('generateContanetExcel — formato según el modo de la empresa', () => {
  const lines: ContanetLine[] = [
    { correlativo: 1, relacionado: 1, nroCuenta: '91.3.1.513', glosa: 'PEAJE & <CIA>', montoDebe: 5.34 },
    { correlativo: 2, relacionado: 1, nroCuenta: '42.1.2.100', glosa: 'PEAJE', montoHaber: 5.34 },
  ]

  it('modo "styled": .xlsx con content-type xlsx y datos legibles en fila 9', async () => {
    const res = await generateContanetExcel(lines, 'compra', 'styled')
    expect(res.ext).toBe('xlsx')
    expect(res.contentType).toContain('spreadsheetml.sheet')
    const wb = XLSX.read(res.buffer)
    const ws = wb.Sheets['CONTABILIDAD']
    expect(ws['D9'].v).toBe(1)
    expect(ws['L9'].v).toBe('91.3.1.513')
  })

  it('modo "template" sin plantilla para el tipo: cae a .xlsx (no rompe)', async () => {
    // `undefined` tipo → no hay template → fallback a la ruta estilizada.
    const res = await generateContanetExcel(lines, undefined, 'template')
    expect(res.ext).toBe('xlsx')
  })

  // El .xlsm idéntico depende de que la plantilla esté en dist/ (nest build).
  const hasTemplate = !!resolveTemplatePath('compra')
  ;(hasTemplate ? it : it.skip)(
    'modo "template" con plantilla: .xlsm con macros y datos correctos + escapado XML',
    async () => {
      const res = await generateContanetExcel(lines, 'compra', 'template')
      expect(res.ext).toBe('xlsm')
      expect(res.contentType).toContain('macroEnabled')
      const wb = XLSX.read(res.buffer, { bookVBA: true })
      expect(wb.vbaraw).toBeTruthy() // macros preservadas
      const ws = wb.Sheets['CONTABILIDAD']
      expect(ws['D9'].v).toBe(1)
      // El & y los <> de la glosa deben haber round-tripeado correctamente.
      expect(ws['Q9'].v).toBe('PEAJE & <CIA>')
    }
  )
})
