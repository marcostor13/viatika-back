import { AccountingEntriesService } from './accounting-entries.service'
import { ContanetLine } from './entities/contanet-columns'

/**
 * Config de prueba que replica los valores del template `compras.xlsm`.
 */
function makeConfig(): any {
  return {
    cuenta42: '42.1.2.100',
    cuenta79: '79.1.1.100',
    cuenta14Raiz: '14.1.3.100',
    igvRates: [{ tasa: 18, cuenta40: '40.1.1.100' }],
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
      { banco: 'BCP', nroCuenta: '123', cuentaContable: '10.4.1.100', activo: true },
    ],
  }
}

function newService(): AccountingEntriesService {
  // Los builders no usan los modelos; se pasan stubs.
  const stub: any = {}
  return new AccountingEntriesService(stub, stub, stub, stub, stub, stub)
}

function sum(lines: ContanetLine[], field: 'montoDebe' | 'montoHaber'): number {
  return Math.round(
    lines.reduce((s, l) => s + (Number(l[field]) || 0), 0) * 100
  ) / 100
}

describe('AccountingEntriesService — asiento de compra', () => {
  const service = newService()
  const config = makeConfig()

  const expense = {
    _id: 'e1',
    proyectId: 'p1',
    total: 128,
    igv: 18,
    tasaIgv: 18,
    inafecto: 10,
    baseAfecta: 100,
    comentario: 'Alimentacion',
    data: JSON.stringify({
      serie: 'F001',
      correlativo: '12345678',
      rucEmisor: '20492533891',
      razonSocial: 'INVERSIONES AQUATEC S.A.C.',
    }),
    detalleAnalitico: [
      { proyectId: 'p1', condicion: 'afecto', monto: 100 },
      { proyectId: 'p1', condicion: 'inafecto', monto: 10 },
    ],
  }

  const projectMap = new Map<string, any>([
    [
      'p1',
      {
        _id: 'p1',
        cuentaAnalitica9x: '91.3.1.410',
        cuentaDestino6x: '63.1.4.100',
        centroCosto: 'SC',
        subCentroCosto: '62747',
        area: '010101',
      },
    ],
  ])

  const lines: ContanetLine[] = (service as any).buildCompraLines({
    report: { createdAt: new Date('2026-04-15') },
    config,
    expenses: [expense],
    projectMap,
  })

  it('genera 8 líneas (42, 40, 2×9X, 2×(6X/79))', () => {
    expect(lines.length).toBe(8)
  })

  it('cuadra: Σ Debe = Σ Haber = 238', () => {
    expect(sum(lines, 'montoDebe')).toBe(238)
    expect(sum(lines, 'montoHaber')).toBe(238)
    expect(service.validateCuadre(lines)).toHaveLength(0)
  })

  it('la cuenta 42 lleva el total 128 al Haber con Es Provisión=1', () => {
    const l42 = lines.find((l) => l.nroCuenta === '42.1.2.100')!
    expect(l42.montoHaber).toBe(128)
    expect(l42.esProvision).toBe(1)
    expect(l42.nroDocProv).toBe('20492533891')
  })

  it('el IGV va a la 40 en el Debe', () => {
    const l40 = lines.find((l) => l.nroCuenta === '40.1.1.100')!
    expect(l40.montoDebe).toBe(18)
  })

  it('la analítica 9X se divide en afecto (S) e inafecto (N)', () => {
    const nines = lines.filter((l) => l.nroCuenta === '91.3.1.410')
    expect(nines).toHaveLength(2)
    expect(nines.find((l) => l.identTipAfecto === 'S')!.montoDebe).toBe(100)
    expect(nines.find((l) => l.identTipAfecto === 'N')!.montoDebe).toBe(10)
  })

  it('todas las líneas comparten el mismo Relacionado y correlativo continuo', () => {
    expect(new Set(lines.map((l) => l.relacionado)).size).toBe(1)
    expect(lines.map((l) => l.correlativo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})