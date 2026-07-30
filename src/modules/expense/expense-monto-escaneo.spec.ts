import { ExpenseService } from './expense.service'

/**
 * Lectura del importe en los escaneos de comprobante (depósito/transferencia y
 * comprobante de caja).
 *
 * El caso que originó estas pruebas: una transferencia de S/ 597.60 se registró
 * como S/ 59,760.00 porque el importe llegaba con el punto decimal perdido y el
 * parseo anterior solo quitaba las comas. El monto escaneado se guarda como dato
 * de auditoría y prellena formularios de pago, así que un error aquí viaja.
 *
 * Se accede a los métodos privados por índice: son detalle de implementación,
 * pero su comportamiento tiene consecuencia sobre importes.
 */
describe('ExpenseService — importe escaneado', () => {
  const service = Object.create(ExpenseService.prototype) as ExpenseService
  const parseMoney = (
    v: unknown
  ): { value: number; hasCents: boolean } =>
    (ExpenseService as any)['parseMoney'](v)
  const parseDeposit = (raw: string) =>
    (service as any)['parseDepositScan'](raw)
  const parseCashVoucher = (raw: string) =>
    (service as any)['parseCashVoucherScan'](raw)

  describe('parseMoney — formatos de importe', () => {
    it.each([
      // Formato peruano: coma para miles, punto para decimales.
      ['S/ 597.60', 597.6],
      ['597.60', 597.6],
      ['S/597.60', 597.6],
      ['S/. 1,234.50', 1234.5],
      ['1,234.50', 1234.5],
      ['PEN 12,345,678.90', 12345678.9],
      // Formato europeo (algún comprobante o PDF traducido).
      ['1.234,50', 1234.5],
      ['S/ 597,60', 597.6],
      ['1.234.567,89', 1234567.89],
      // Sin decimales: el valor se respeta tal cual.
      ['59760', 59760],
      ['S/ 59,760.00', 59760],
      ['PEN 1,000', 1000],
      // Un único separador con 3 dígitos detrás son miles, no decimales.
      ['12.345', 12345],
      ['2,500', 2500],
      // Un único separador con otra cola son decimales.
      ['597.6', 597.6],
      ['0.50', 0.5],
      ['597.6000', 597.6],
      ['.60', 0.6],
      // Números ya normalizados.
      [597.6, 597.6],
      [0, 0],
      // Basura: 0, nunca NaN.
      ['', 0],
      ['   ', 0],
      ['abc', 0],
      ['S/', 0],
      ['.', 0],
      [',,', 0],
      [null, 0],
      [undefined, 0],
      [NaN, 0],
      [Infinity, 0],
      [{}, 0],
    ])('%p -> %p', (entrada, esperado) => {
      expect(parseMoney(entrada).value).toBe(esperado)
    })

    // Un literal con dos importes no debe concatenarse en uno gigante:
    // "597.60 (comisión 0.00)" no puede terminar en 597600.
    it('toma el primer importe cuando el texto trae varios', () => {
      expect(parseMoney('S/ 597.60 (comisión S/ 0.00)').value).toBe(597.6)
      expect(parseMoney('S/ 1,234.50 más ITF S/ 0.20').value).toBe(1234.5)
    })

    it('distingue si el importe trae céntimos explícitos', () => {
      expect(parseMoney('S/ 597.60').hasCents).toBe(true)
      expect(parseMoney(597.6).hasCents).toBe(true)
      expect(parseMoney('S/ 59760').hasCents).toBe(false)
      expect(parseMoney(59760).hasCents).toBe(false)
      // ".00" no aporta céntimos reales: el valor es entero.
      expect(parseMoney('S/ 59,760.00').hasCents).toBe(false)
    })
  })

  describe('parseDepositScan — respuesta del escaneo', () => {
    it('lee una respuesta correcta', () => {
      const r = parseDeposit(
        JSON.stringify({
          amount: 597.6,
          amountText: 'S/ 597.60',
          fecha: '27/07/2026',
          hora: '16:10',
          operationNumber: '00195445',
          titular: 'CARRASCO PERALTA CHRISTIAN WILMER',
        })
      )
      expect(r).toEqual({
        amount: 597.6,
        fecha: '27/07/2026',
        hora: '16:10',
        operationNumber: '00195445',
        titular: 'CARRASCO PERALTA CHRISTIAN WILMER',
      })
    })

    // El bug reportado: el número perdió el punto decimal, el literal no.
    it('rescata los céntimos del literal cuando el número los perdió', () => {
      const r = parseDeposit(
        JSON.stringify({ amount: 59760, amountText: 'S/ 597.60' })
      )
      expect(r.amount).toBe(597.6)
    })

    // A la inversa, un literal sin céntimos no puede pisar un número correcto.
    it('el literal no pisa al número cuando no aporta céntimos', () => {
      const r = parseDeposit(
        JSON.stringify({ amount: 597.6, amountText: 'S/ 59760' })
      )
      expect(r.amount).toBe(597.6)
    })

    it('usa el literal si el número no vino', () => {
      expect(parseDeposit(JSON.stringify({ amountText: 'S/ 1,234.50' })).amount).toBe(1234.5)
      expect(parseDeposit(JSON.stringify({ amount: 0, amountText: 'S/ 80.00' })).amount).toBe(80)
    })

    it('acepta el importe como cadena con formato', () => {
      expect(parseDeposit(JSON.stringify({ amount: '1,234.50' })).amount).toBe(1234.5)
      expect(parseDeposit(JSON.stringify({ amount: 'S/ 597.60' })).amount).toBe(597.6)
    })

    it('tolera el JSON envuelto en un bloque de código', () => {
      const r = parseDeposit('```json\n{"amount": 597.6, "titular": "JUAN PEREZ"}\n```')
      expect(r.amount).toBe(597.6)
      expect(r.titular).toBe('JUAN PEREZ')
    })

    // Sin JSON válido, el rescate por texto no debe confundir el n° de
    // operación (todo dígitos) con el importe.
    it('rescata el importe de un texto libre sin tomar el n° de operación', () => {
      const r = parseDeposit('Operación 00195445 por un monto de S/ 597.60')
      expect(r.amount).toBe(597.6)
    })

    it('nunca devuelve NaN ni negativos', () => {
      for (const raw of ['', 'no es json', '{}', '{"amount": "abc"}', '{"amount": -50}']) {
        const r = parseDeposit(raw)
        expect(Number.isFinite(r.amount)).toBe(true)
        expect(r.amount).toBeGreaterThanOrEqual(0)
      }
    })

    it('deja en undefined los campos de texto vacíos', () => {
      const r = parseDeposit(JSON.stringify({ amount: 10, fecha: '', titular: '  ' }))
      expect(r.fecha).toBeUndefined()
      expect(r.titular).toBeUndefined()
    })
  })

  // El escaneo de facturas ya recibe el total como número (el front manda el
  // que el colaborador revisó). La normalización es defensa en profundidad: no
  // puede alterar ese camino, solo cubre que el modelo devuelva texto.
  describe('invoiceTotal — total de factura', () => {
    const invoiceTotal = (v: unknown): number =>
      (ExpenseService as any)['invoiceTotal'](v)

    it.each([
      [1000, 1000],
      [597.6, 597.6],
      [7.2, 7.2],
      [0, 0],
      [0.01, 0.01],
      [-50, -50],
      [1234.5678, 1234.5678],
    ])('un número se devuelve intacto: %p', (entrada, esperado) => {
      expect(invoiceTotal(entrada)).toBe(esperado)
    })

    it('equivale al comportamiento anterior para ausentes', () => {
      // Antes: `Number(data.montoTotal ?? 0)` y `extraction.montoTotal ?? 0`.
      expect(invoiceTotal(undefined)).toBe(0)
      expect(invoiceTotal(null)).toBe(0)
    })

    it('rescata el importe si el modelo lo devuelve como texto', () => {
      // Antes daba NaN (Number('1,234.50')) o 0 en la vista previa.
      expect(invoiceTotal('1,234.50')).toBe(1234.5)
      expect(invoiceTotal('S/ 597.60')).toBe(597.6)
      expect(invoiceTotal('1000')).toBe(1000)
    })

    it('nunca devuelve NaN', () => {
      for (const v of ['abc', '', {}, NaN, Infinity]) {
        expect(Number.isFinite(invoiceTotal(v))).toBe(true)
      }
    })
  })

  describe('parseCashVoucherScan — comprobante de caja', () => {
    it('lee el monto con céntimos', () => {
      const r = parseCashVoucher(
        JSON.stringify({ entregadoA: 'JUAN PEREZ', monto: '1,234.50', concepto: 'Movilidad' })
      )
      expect(r.monto).toBe(1234.5)
      expect(r.entregadoA).toBe('JUAN PEREZ')
    })

    it('devuelve 0 ante un monto ilegible', () => {
      expect(parseCashVoucher('{"monto": "abc"}').monto).toBe(0)
      expect(parseCashVoucher('no es json').monto).toBe(0)
    })
  })
})
