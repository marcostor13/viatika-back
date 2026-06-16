import { AccountingEntriesService } from './accounting-entries.service'
import { ContanetLine } from './entities/contanet-columns'
import { buildContanetAoa } from './entities/contanet-export'

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
  // (reportModel, expenseModel, advanceModel, projectModel, userModel, categoryModel, accountingConfigService, exchangeService, configService)
  return new AccountingEntriesService(
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    exchangeStub,
    configStub
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
