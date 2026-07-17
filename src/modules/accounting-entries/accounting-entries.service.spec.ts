import { AccountingEntriesService } from './accounting-entries.service'
import { ContanetLine, toExcelSerial } from './entities/contanet-columns'
import { generateContanetExcel, resolveTemplatePath } from './entities/contanet-export'
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
  // (reportModel, expenseModel, advanceModel, projectModel, userModel, categoryModel, clientModel, fileModel, accountingConfigService, exchangeService, configService, uploadService)
  return new AccountingEntriesService(
    stub,
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

  it('boleta: código 03, no genera asiento de compra (solo factura entra al registro de compra)', async () => {
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
    expect(lines).toHaveLength(0)
  })

  it('planilla de movilidad: código 94, no genera asiento de compra', async () => {
    const expense = {
      _id: 'e6',
      expenseType: 'planilla_movilidad',
      categoryId: 'cat1',
      total: 45,
      internalCode: 'PM-001',
      data: '{}',
    }
    const lines = await build([expense])
    expect(lines).toHaveLength(0)
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

describe('AccountingEntriesService — absorción de residuo de redondeo', () => {
  const service = newService()
  const config = makeConfig()
  const categoryMap = new Map<string, any>([
    ['cat1', { _id: 'cat1', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' }],
  ])
  const projectMap = new Map<string, any>()
  const rateMap = new Map<string, number>([['2026-04-15', TC]])
  const report = { createdAt: new Date('2026-04-15') }
  const periodDate = new Date('2026-04-01')

  async function build(expenses: any[]) {
    return (service as any).buildCompraLines({
      report,
      config,
      expenses,
      projectMap,
      categoryMap,
      periodDate,
      rateMap,
      cargosMap: new Map(),
      warnings: [],
    }) as Promise<ContanetLine[]>
  }

  it('residuo de -0.01 (base+IGV suman 1 centavo menos que importeTotal): cuadra absorbiendo en la porción 9X', async () => {
    // Debe reconstruido = 205.10 (gravada) + 36.92 (IGV) = 242.02;
    // Haber = importeTotal 242.03. Sin absorción, descuadre de -0.01.
    const expense = {
      _id: 'e-538',
      categoryId: 'cat1',
      igv: 36.92,
      tasaIgv: 18,
      comprobanteDetallado: {
        emisor: { ruc: '10123456789', razonSocial: 'APONTE JARA MERCEDES VIOLETA' },
        comprobante: { serie: 'E001', correlativo: '538' },
        totales: { operacionGravada: 205.1, igv: 36.92, importeTotal: 242.03 },
      },
      data: '{}',
    }
    const lines = await build([expense])

    expect(service.validateCuadre(lines)).toHaveLength(0)
    // El centavo se absorbe en la porción 9X afecta: 205.10 → 205.11.
    const nine = lines.find(l => l.nroCuenta === '91.3.1.410')!
    expect(nine.montoDebe).toBe(205.11)
    // La cuenta 42 conserva el importeTotal íntegro del comprobante.
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.montoHaber).toBe(242.03)
  })

  it('el residuo se absorbe en la porción de MAYOR monto', async () => {
    // Gravada 200 (afecta) + inafecta 40.01 + IGV 36 = 276.01; total 276.02.
    // El centavo debe ir a la porción de 200, no a la de 40.01.
    const expense = {
      _id: 'e-mix',
      categoryId: 'cat1',
      igv: 36,
      tasaIgv: 18,
      comprobanteDetallado: {
        emisor: { ruc: '10123456789', razonSocial: 'PROVEEDOR MIXTO' },
        comprobante: { serie: 'E001', correlativo: '900' },
        totales: {
          operacionGravada: 200,
          operacionInafecta: 40.01,
          igv: 36,
          importeTotal: 276.02,
        },
      },
      data: '{}',
    }
    const lines = await build([expense])

    expect(service.validateCuadre(lines)).toHaveLength(0)
    const afecta = lines.find(
      l => l.nroCuenta === '91.3.1.410' && l.identTipAfecto === 'S'
    )!
    const inafecta = lines.find(
      l => l.nroCuenta === '91.3.1.410' && l.identTipAfecto === 'N'
    )!
    expect(afecta.montoDebe).toBe(200.01)
    expect(inafecta.montoDebe).toBe(40.01)
  })

  it('un desfase mayor al umbral (> 0.05) NO se absorbe: se sigue reportando el descuadre', async () => {
    // Gravada 200 + IGV 36 = 236; importeTotal 236.50 → desfase 0.50, no es
    // residuo de redondeo (probablemente falta un cargo). No debe enmascararse.
    const expense = {
      _id: 'e-big',
      categoryId: 'cat1',
      igv: 36,
      tasaIgv: 18,
      comprobanteDetallado: {
        emisor: { ruc: '10123456789', razonSocial: 'PROVEEDOR DESCUADRADO' },
        comprobante: { serie: 'E001', correlativo: '901' },
        totales: { operacionGravada: 200, igv: 36, importeTotal: 236.5 },
      },
      data: '{}',
    }
    const lines = await build([expense])

    expect(service.validateCuadre(lines).length).toBeGreaterThan(0)
  })
})

describe('AccountingEntriesService — centro de costo en solicitud/aplicación/devolución-reembolso', () => {
  const service = newService()
  const config = makeConfig()
  const periodDate = new Date('2026-04-01')
  const rateMap = new Map<string, number>([['2026-04-15', TC]])
  const projectMap = new Map<string, any>([
    [
      'p-adv',
      { _id: 'p-adv', code: 'CC-ADV', centroCosto: 'SC-ADV', subCentroCosto: '111' },
    ],
    [
      'p-exp',
      { _id: 'p-exp', code: 'CC-EXP', centroCosto: 'SC-EXP', subCentroCosto: '222' },
    ],
    [
      'p-report',
      { _id: 'p-report', code: 'CC-REP', centroCosto: 'SC-REP', subCentroCosto: '333' },
    ],
  ])

  it('solicitud: toma el centro de costo del proyecto del anticipo', async () => {
    const report = { createdAt: new Date('2026-04-15') }
    const advance = {
      _id: 'a1',
      amount: 500,
      projectId: 'p-adv',
      startDate: new Date('2026-04-15'),
    }
    const lines = (await (service as any).buildSolicitudLines({
      report,
      config,
      advances: [advance],
      colaborador: { dni: '12345678', name: 'Colaborador' },
      projectMap,
      periodDate,
      rateMap,
      warnings: [],
    })) as ContanetLine[]

    expect(lines.length).toBe(2)
    expect(lines.every(l => l.centroCosto === 'SC-ADV')).toBe(true)
    expect(lines.every(l => l.subCentroCosto === '111')).toBe(true)
  })

  it('solicitud: si el anticipo no tiene proyecto, cae al proyecto de la rendición', async () => {
    const report = { createdAt: new Date('2026-04-15'), projectId: 'p-report' }
    const advance = { _id: 'a2', amount: 500, startDate: new Date('2026-04-15') }
    const lines = (await (service as any).buildSolicitudLines({
      report,
      config,
      advances: [advance],
      colaborador: {},
      projectMap,
      periodDate,
      rateMap,
      warnings: [],
    })) as ContanetLine[]

    expect(lines.every(l => l.centroCosto === 'SC-REP')).toBe(true)
  })

  it('solicitud: sin proyecto propio ni de la rendición, cae al centro de costo global de la config', async () => {
    const report = { createdAt: new Date('2026-04-15') }
    const advance = { _id: 'a3', amount: 500, startDate: new Date('2026-04-15') }
    const lines = (await (service as any).buildSolicitudLines({
      report,
      config,
      advances: [advance],
      colaborador: {},
      projectMap,
      periodDate,
      rateMap,
      warnings: [],
    })) as ContanetLine[]

    expect(lines.every(l => l.centroCosto === config.centroCosto)).toBe(true)
  })

  it('aplicación: toma el centro de costo del proyecto del comprobante', async () => {
    const report = { createdAt: new Date('2026-04-15') }
    const expense = {
      _id: 'e1',
      proyectId: 'p-exp',
      total: 100,
      data: '{}',
      comprobanteDetallado: { totales: { importeTotal: 100 } },
    }
    const lines = (await (service as any).buildAplicacionLines({
      report,
      config,
      expenses: [expense],
      colaborador: { dni: '12345678', name: 'Colaborador' },
      movilidadDiario: 40,
      projectMap,
      categoryMap: new Map(),
      periodDate,
      rateMap,
      warnings: [],
    })) as ContanetLine[]

    expect(lines.length).toBe(2)
    expect(lines.every(l => l.centroCosto === 'SC-EXP')).toBe(true)
    expect(lines.every(l => l.subCentroCosto === '222')).toBe(true)
  })

  it('devolución: toma el centro de costo del proyecto de la rendición', async () => {
    const report = {
      updatedAt: new Date('2026-04-15'),
      projectId: 'p-report',
      settlement: { type: 'devolucion', difference: -50 },
    }
    const lines = (await (service as any).buildDevolucionReembolsoLines(
      {
        report,
        config,
        advances: [],
        colaborador: {},
        projectMap,
        periodDate,
        rateMap,
      },
      'devolucion'
    )) as ContanetLine[]

    expect(lines.length).toBe(2)
    expect(lines.every(l => l.centroCosto === 'SC-REP')).toBe(true)
  })

  it('reembolso: si la rendición no tiene proyecto, cae al proyecto del primer anticipo', async () => {
    const report = {
      updatedAt: new Date('2026-04-15'),
      settlement: { type: 'reembolso', difference: 50 },
    }
    const advance = { _id: 'a4', projectId: 'p-adv' }
    const lines = (await (service as any).buildDevolucionReembolsoLines(
      {
        report,
        config,
        advances: [advance],
        colaborador: {},
        projectMap,
        periodDate,
        rateMap,
      },
      'reembolso'
    )) as ContanetLine[]

    expect(lines.length).toBe(2)
    expect(lines.every(l => l.centroCosto === 'SC-ADV')).toBe(true)
  })
})

describe('AccountingEntriesService — asiento de aplicación', () => {
  const service = newService()
  const config = makeConfig()
  const rateMap = new Map<string, number>([
    ['2026-04-15', TC],
    ['2026-05-02', TC],
    ['2026-05-03', TC],
    ['2026-05-05', TC],
  ])
  const report = { createdAt: new Date('2026-04-15') }
  const periodDate = new Date('2026-04-01')
  const colaborador = { dni: '12345678', name: 'JUAN PEREZ' }
  // Categoría ALIMENTACION → 9X 91.3.1.410, destino 6X 63.1.4.100 (misma que
  // usan los tests de Compra) — los no-factura en Aplicación ya generan su
  // propio bloque 9X/42/6X/79, así que necesitan una categoría resuelta.
  const categoryMap = new Map<string, any>([
    ['cat1', { _id: 'cat1', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' }],
  ])

  async function build(expenses: any[], warnings: string[] = []) {
    return (service as any).buildAplicacionLines({
      report,
      config,
      expenses,
      colaborador,
      movilidadDiario: 40,
      projectMap: new Map(),
      categoryMap,
      periodDate,
      rateMap,
      warnings,
    }) as Promise<ContanetLine[]>
  }

  it('boleta (código 03) genera su asiento 9X/42/6X/79 en Aplicación aunque no entre a Compra', async () => {
    const expense = {
      _id: 'e10',
      expenseType: 'factura',
      categoryId: 'cat1',
      total: 59,
      data: '{}',
      comprobanteDetallado: {
        comprobante: { tipo: 'Boleta', serie: 'B001', correlativo: '55' },
        totales: { importeTotal: 59 },
      },
    }
    const lines = await build([expense])
    // No cancela la cuenta 14 (decisión 2026-07-10): solo 9X(Debe)/42(Haber)/6X(Debe)/79(Haber).
    expect(lines).toHaveLength(4)
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.codTipDoc).toBe('03')
    expect(l42.montoHaber).toBe(59)
    const l9x = lines.find(l => l.nroCuenta === '91.3.1.410')!
    expect(l9x.montoDebe).toBe(59)
    expect(service.validateCuadre(lines)).toHaveLength(0)
  })

  it('planilla de movilidad sin startDate/endDate en la rendición: cae a un único bloque con el total consolidado', async () => {
    const expense = {
      _id: 'e11',
      expenseType: 'planilla_movilidad',
      internalCode: 'PM-002',
      categoryId: 'cat1',
      total: 120,
      data: '{}',
      mobilityRows: [
        { fecha: '2026-05-02', total: 40 },
        { fecha: '2026-05-03', total: 40 },
        { fecha: '2026-05-05', total: 40 },
      ],
    }
    const lines = await build([expense])
    // Sin report.startDate/endDate, buildMovilidadBlocks cae a UN bloque por
    // planilla con su total (120) en vez de repartir por fecha — ver el test
    // "cada una con su propio Numero Documento" para el caso con fechas de viaje.
    expect(lines).toHaveLength(4)
    const l42s = lines.filter(l => l.nroCuenta === '42.1.2.100')
    expect(l42s).toHaveLength(1)
    expect(l42s[0].montoHaber).toBe(120)
    expect(l42s.every(l => l.codTipDoc === '94')).toBe(true)
    const l9xs = lines.filter(l => l.nroCuenta === '91.3.1.410')
    expect(l9xs).toHaveLength(1)
    expect(l9xs[0].montoDebe).toBe(120)
    expect(service.validateCuadre(lines)).toHaveLength(0)
  })

  it('planilla sin filas con monto: no genera líneas y avisa', async () => {
    const expense = {
      _id: 'e12',
      expenseType: 'planilla_movilidad',
      total: 0,
      data: '{}',
      mobilityRows: [{ fecha: '2026-05-02', total: 0 }],
    }
    const warnings: string[] = []
    const lines = await build([expense], warnings)
    expect(lines).toHaveLength(0)
    expect(warnings.some(w => w.includes('no genera asiento de aplicación'))).toBe(true)
  })

  it('varias planillas de movilidad de la misma rendición: cada una con su propio Numero Documento y fechas sintéticas corridas desde startDate+1', async () => {
    // Cada expense es un documento independiente: su total se reparte en
    // bloques de movilidadDiario (40) con un cursor de fechas SINTÉTICAS
    // corrido entre planillas (2026-05-02, 2026-05-03), ordenadas por su
    // fecha real (mobilityRows). El bloque de cada planilla lleva SU propio
    // internalCode como Numero Documento, no uno compartido.
    const movilidadReport = {
      ...report,
      startDate: new Date('2026-05-01'),
      endDate: new Date('2026-05-10'),
    }
    const expenses = [
      {
        _id: 'e20',
        expenseType: 'planilla_movilidad',
        internalCode: 'MT002',
        createdAt: new Date('2026-05-05'),
        total: 40,
        data: '{}',
        mobilityRows: [{ fecha: '2026-05-05', total: 40 }],
      },
      {
        _id: 'e21',
        expenseType: 'planilla_movilidad',
        internalCode: 'MT001',
        createdAt: new Date('2026-05-01'),
        total: 40,
        data: '{}',
        mobilityRows: [{ fecha: '2026-05-02', total: 40 }],
      },
    ]
    const lines = await (service as any).buildAplicacionLines({
      report: movilidadReport,
      config,
      expenses,
      colaborador,
      movilidadDiario: 40,
      projectMap: new Map(),
      categoryMap: new Map(),
      periodDate,
      rateMap,
      warnings: [],
    })
    const l42s = lines.filter((l: ContanetLine) => l.nroCuenta === '42.1.2.100')
    expect(l42s).toHaveLength(2)
    // MT001 (fecha real 2026-05-02) va primero en 2026-05-02; MT002 sigue en
    // 2026-05-03. Cada bloque conserva el internalCode de SU planilla.
    const byDoc = new Map(
      l42s.map((l: ContanetLine) => [l.nroDoc, l.fechaEmision])
    )
    expect(byDoc.get('MT001')).toBe(toExcelSerial(new Date('2026-05-02')))
    expect(byDoc.get('MT002')).toBe(toExcelSerial(new Date('2026-05-03')))
  })

  it('sortExpensesForAsiento ordena planillas de movilidad por su fecha real (mobilityRows), no por report.createdAt', () => {
    // Ninguna trae `fechaEmision` propio (nunca se persiste para
    // planilla_movilidad) — antes caían todas al mismo fallback
    // report.createdAt y el orden por fecha no hacía nada.
    const late = {
      _id: 'late',
      expenseType: 'planilla_movilidad',
      mobilityRows: [{ fecha: '2026-05-20', total: 40 }],
    }
    const early = {
      _id: 'early',
      expenseType: 'planilla_movilidad',
      mobilityRows: [{ fecha: '2026-05-02', total: 40 }],
    }
    const mid = {
      _id: 'mid',
      expenseType: 'planilla_movilidad',
      mobilityRows: [{ fecha: '2026-05-10', total: 40 }],
    }
    const sorted = (service as any).sortExpensesForAsiento([late, early, mid], report)
    expect(sorted.map((e: any) => e._id)).toEqual(['early', 'mid', 'late'])
  })
})

describe('AccountingEntriesService — prefetchRates cubre las fechas sintéticas de movilidad', () => {
  it('agrega los días de los bloques de Aplicación (startDate+1, +2, ...), no solo la fecha del expense', async () => {
    // Sin esto, tcFor() no encuentra el tipo de cambio de esos días y cae
    // al fallback config.tipoCambio (columna "Cambio Moneda" saliendo en 1).
    const service = newService()
    const config = makeConfig()
    const report = {
      createdAt: new Date('2026-05-01'),
      startDate: new Date('2026-05-01'),
      endDate: new Date('2026-05-10'),
    }
    const expenses = [
      {
        _id: 'e1',
        expenseType: 'planilla_movilidad',
        total: 80,
        mobilityRows: [{ fecha: '2026-05-01', total: 80 }],
      },
    ]
    const requestedIsoLists: string[][] = []
    ;(service as any).exchangeRateService = {
      getRatesBatch: async (isoList: string[]) => {
        requestedIsoLists.push(isoList)
        return new Map<string, number>()
      },
    }
    await (service as any).prefetchRates(report, expenses, [], config, 40)
    const requested = requestedIsoLists[0]
    // Bloques sintéticos: día siguiente a startDate (05-02) y el que sigue (05-03).
    expect(requested).toContain('2026-05-02')
    expect(requested).toContain('2026-05-03')
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

describe('generateContanetExcel — siempre .xlsm desde el template (sin ruta .xlsx)', () => {
  const lines: ContanetLine[] = [
    { correlativo: 1, relacionado: 1, nroCuenta: '91.3.1.513', glosa: 'PEAJE & <CIA>', montoDebe: 5.34 },
    { correlativo: 2, relacionado: 1, nroCuenta: '42.1.2.100', glosa: 'PEAJE', montoHaber: 5.34 },
  ]

  // El .xlsm idéntico depende de que la plantilla esté en dist/ (nest build).
  const hasTemplate = !!resolveTemplatePath('compra')
  ;(hasTemplate ? it : it.skip)(
    '.xlsm con macros, hojas intactas, datos correctos y escapado XML',
    async () => {
      const res = await generateContanetExcel(lines, 'compra')
      expect(res.ext).toBe('xlsm')
      expect(res.contentType).toContain('macroEnabled')
      const wb = XLSX.read(res.buffer, { bookVBA: true })
      expect(wb.SheetNames).toEqual(['CONTABILIDAD', 'ImportCONTABILIDAD', 'TABLAS'])
      expect(wb.vbaraw).toBeTruthy() // macros preservadas
      const ws = wb.Sheets['CONTABILIDAD']
      expect(ws['D9'].v).toBe(1)
      // El & y los <> de la glosa deben haber round-tripeado correctamente.
      expect(ws['Q9'].v).toBe('PEAJE & <CIA>')
    }
  )

  it('sin plantilla para el tipo: lanza en vez de degradar a .xlsx', async () => {
    // `undefined` tipo → no hay template → ya no existe ruta estilizada de fallback.
    await expect(generateContanetExcel(lines, undefined)).rejects.toThrow(
      'No se encontró la plantilla Contanet'
    )
  })
})

describe('AccountingEntriesService — multimoneda (comprobante en USD)', () => {
  const service = newService()
  const config = {
    ...makeConfig(),
    monedaBase: 'PEN',
    supportedCurrencies: [
      { code: 'PEN', symbol: 'S/', contanetCode: '01', decimals: 2, approvalThresholdL1: 500 },
      { code: 'USD', symbol: '$', contanetCode: '02', decimals: 2, approvalThresholdL1: 150 },
    ],
  }
  const categoryMap = new Map<string, any>([
    ['cat1', { _id: 'cat1', cuenta: '91.3.1.410', cuentaDestino6x: '63.1.4.100' }],
  ])
  const projectMap = new Map<string, any>()
  // Factura de USD 100, congelada con TC 3.8 al registrar (fecha de emisión) →
  // montoBase = 380 soles. El TC "del día" en rateMap es distinto (3.5) para
  // comprobar que se usa el TC CONGELADO del comprobante, no el del día.
  const FROZEN_TC = 3.8
  const expense = {
    _id: 'eUSD',
    proyectId: 'p1',
    categoryId: 'cat1',
    total: 100,
    moneda: 'USD',
    montoBase: 380,
    tipoCambio: FROZEN_TC,
    igv: 0,
    tasaIgv: 18,
    comentario: 'Software',
    data: JSON.stringify({ serie: 'F001', correlativo: '00000099' }),
    comprobanteDetallado: {
      emisor: { ruc: '20999999999', razonSocial: 'ACME INC' },
      comprobante: { serie: 'F001', correlativo: '00000099' },
      totales: { operacionGravada: 100, igv: 0, importeTotal: 100 },
    },
  }
  const rateMap = new Map<string, number>([['2026-04-15', TC]]) // TC del día = 3.5 (≠ FROZEN_TC)

  let lines: ContanetLine[]
  beforeAll(async () => {
    lines = await (service as any).buildCompraLines({
      report: { createdAt: new Date('2026-04-15') },
      config,
      expenses: [expense],
      projectMap,
      categoryMap,
      periodDate: new Date('2026-04-01'),
      rateMap,
      cargosMap: new Map(),
      warnings: [],
    })
  })

  it('mdaOrigen resuelve al código Contanet de USD (02), no al de la config (01)', () => {
    expect(lines.every(l => l.mdaOrigen === '02')).toBe(true)
  })

  it('cambioMoneda usa el TC CONGELADO del comprobante, no el TC del día', () => {
    expect(lines.every(l => l.cambioMoneda === FROZEN_TC)).toBe(true)
  })

  it('montoDebe/montoHaber (moneda registro = soles) usan montoBase, no el total original en USD', () => {
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.montoHaber).toBe(380) // 100 USD * 3.8, NO 100
  })

  it('montoDebeME/montoHaberME llevan el monto ORIGINAL en USD (sin re-dividir)', () => {
    const l42 = lines.find(l => l.nroCuenta === '42.1.2.100')!
    expect(l42.montoHaberME).toBe(100)
    const l9x = lines.find(l => l.nroCuenta === '91.3.1.410')!
    expect(l9x.montoDebeME).toBe(100)
  })

  it('cuadra: Σ Debe = Σ Haber en soles', () => {
    expect(sum(lines, 'montoDebe')).toBe(sum(lines, 'montoHaber'))
    expect(service.validateCuadre(lines)).toHaveLength(0)
  })
})
