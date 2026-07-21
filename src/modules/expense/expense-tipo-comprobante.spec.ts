import { ExpenseService } from './expense.service'

/**
 * Resolución del tipo de comprobante: el código que se envía a SUNAT y la
 * sincronización del dato en los dos lugares donde vive.
 *
 * Se accede a los métodos privados por índice para no exponerlos solo por el
 * test: son detalle de implementación, pero su comportamiento tiene
 * consecuencia tributaria (solo el código 01 genera crédito fiscal).
 */
describe('ExpenseService — tipo de comprobante', () => {
  const service = Object.create(ExpenseService.prototype) as ExpenseService
  const determineCodComp = (tipo?: string, serie?: string): string =>
    (service as any)['determineCodComp'](tipo, serie)
  const normalize = (tipo?: string, serie?: string): string | undefined =>
    (service as any)['normalizeTipoComprobante'](tipo, serie)
  const sync = (updateDoc: Record<string, any>, existing: any): void =>
    (service as any)['syncTipoComprobanteOnWrite'](updateDoc, existing)

  describe('determineCodComp — la serie manda sobre la etiqueta', () => {
    it.each([
      ['F001', 'Factura', '01'],
      ['FF01', 'Factura Electronica', '01'],
      ['E001', 'Factura', '01'],
      ['B001', 'Boleta', '03'],
      ['EB01', 'Boleta de Venta Electrónica', '03'],
    ])('serie %s (%s) -> %s', (serie, tipo, esperado) => {
      expect(determineCodComp(tipo, serie)).toBe(esperado)
    })

    // El caso que rompía la validación: la IA etiqueta una factura como boleta.
    // Sin la serie se consultaría con codComp 03 y SUNAT la rechazaría.
    it.each([
      ['E001', 'Boleta de Venta Electrónica'],
      ['E002', 'Boleta de Venta Electronica'],
      ['F002', 'Boleta'],
      ['F076', 'Boleta de Venta Electronica'],
    ])(
      'serie %s con etiqueta errada "%s" se consulta como Factura',
      (serie, tipo) => {
        expect(determineCodComp(tipo, serie)).toBe('01')
      }
    )

    it('tolera espacios y minúsculas en la serie', () => {
      expect(determineCodComp('Boleta', ' fa02 ')).toBe('01')
    })

    it('sin serie legible cae a la etiqueta', () => {
      expect(determineCodComp('Boleta', '')).toBe('03')
      expect(determineCodComp('Ticket', '')).toBe('12')
      expect(determineCodComp('Factura', undefined)).toBe('01')
      expect(determineCodComp(undefined, undefined)).toBe('01')
    })
  })

  describe('normalizeTipoComprobante', () => {
    it.each([
      ['Factura', 'Factura'],
      ['FACTURA ELECTRONICA', 'Factura'],
      ['Factura Electrónica', 'Factura'],
      ['Boleta de Venta Electrónica', 'Boleta'],
      ['  boleta  ', 'Boleta'],
      ['Ticket', 'Ticket'],
    ])('%s -> %s', (entrada, esperado) => {
      expect(normalize(entrada)).toBe(esperado)
    })

    it('devuelve undefined cuando no hay valor reconocible', () => {
      expect(normalize('')).toBeUndefined()
      expect(normalize(undefined)).toBeUndefined()
      expect(normalize('cualquier cosa')).toBeUndefined()
    })

    // Desde que la consulta a SUNAT resuelve el código por la serie, una
    // etiqueta errada ya no hace fallar la validación: si no se corrigiera
    // aquí también, quedaría un error silencioso (SUNAT conforme, pero el
    // asiento contable tratando la factura como boleta).
    it('la serie corrige la etiqueta errada', () => {
      expect(normalize('Boleta de Venta Electrónica', 'E001')).toBe('Factura')
      expect(normalize('Boleta', 'F002')).toBe('Factura')
      expect(normalize('Factura', 'B880')).toBe('Boleta')
      expect(normalize('Factura Electronica', 'EB01')).toBe('Boleta')
    })

    it('sin serie que identifique el tipo, se respeta la etiqueta', () => {
      expect(normalize('Boleta de Venta', '001')).toBe('Boleta')
      expect(normalize('Ticket', '0001')).toBe('Ticket')
      expect(normalize('Factura', '')).toBe('Factura')
    })
  })

  describe('syncTipoComprobanteOnWrite', () => {
    it('propaga el tipo a comprobanteDetallado, que es el que manda en el asiento', () => {
      const updateDoc: Record<string, any> = {
        data: JSON.stringify({ serie: 'B001', tipoComprobante: 'Boleta' }),
      }
      sync(updateDoc, { comprobanteDetallado: { emisor: { ruc: '20503840121' } } })

      expect(updateDoc.comprobanteDetallado.comprobante.tipo).toBe('Boleta')
      // El resto del objeto se conserva.
      expect(updateDoc.comprobanteDetallado.emisor.ruc).toBe('20503840121')
    })

    it('normaliza la etiqueta al escribir para no acumular variantes', () => {
      const updateDoc: Record<string, any> = {
        data: JSON.stringify({ tipoComprobante: 'FACTURA ELECTRONICA' }),
      }
      sync(updateDoc, {})

      expect(JSON.parse(updateDoc.data).tipoComprobante).toBe('Factura')
      expect(updateDoc.comprobanteDetallado.comprobante.tipo).toBe('Factura')
    })

    it('corrige por la serie una etiqueta que la contradice', () => {
      const updateDoc: Record<string, any> = {
        data: JSON.stringify({
          serie: 'E001',
          tipoComprobante: 'Boleta de Venta Electrónica',
        }),
      }
      sync(updateDoc, {})

      expect(JSON.parse(updateDoc.data).tipoComprobante).toBe('Factura')
      expect(updateDoc.comprobanteDetallado.comprobante.tipo).toBe('Factura')
    })

    it('no toca nada si el data no trae tipo (planilla de movilidad)', () => {
      const updateDoc: Record<string, any> = {
        data: JSON.stringify({ type: 'planilla_movilidad', rows: [] }),
      }
      sync(updateDoc, {})

      expect(updateDoc.comprobanteDetallado).toBeUndefined()
    })

    it('ignora un data que no sea JSON', () => {
      const updateDoc: Record<string, any> = { data: 'texto libre' }
      sync(updateDoc, {})

      expect(updateDoc.comprobanteDetallado).toBeUndefined()
      expect(updateDoc.data).toBe('texto libre')
    })
  })
})
