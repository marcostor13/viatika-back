import { ExchangeRateService } from './exchange-rate.service'

/**
 * Modelo Mongoose falso, en memoria, para no depender de la BD. `rows` simula la
 * colección; `findOne`/`find`/`findOneAndUpdate` cubren solo lo que usa el servicio.
 */
function makeModel(rows: any[] = []) {
  const chain = (value: any) => ({ lean: () => ({ exec: async () => value }) })
  return {
    rows,
    findOne(filter: any) {
      const trusted: string[] | undefined = filter?.source?.$in
      const lte: string | undefined = filter?.fecha?.$lte
      let match: any
      if (lte) {
        match = rows
          .filter(r => r.fecha <= lte && (!trusted || trusted.includes(r.source)))
          .sort((a, b) => (a.fecha < b.fecha ? 1 : -1))[0]
      } else {
        match = rows.find(
          r => r.fecha === filter.fecha && (!trusted || trusted.includes(r.source))
        )
      }
      // Soporta el `.sort()` intermedio del respaldo (devuelve el mismo chain).
      const c: any = chain(match ?? null)
      c.sort = () => c
      return c
    },
    find(filter: any) {
      const trusted: string[] | undefined = filter?.source?.$in
      const isoIn: string[] = filter?.fecha?.$in ?? []
      const matches = rows.filter(
        r => isoIn.includes(r.fecha) && (!trusted || trusted.includes(r.source))
      )
      return chain(matches)
    },
    findOneAndUpdate(filter: any, update: any) {
      const set = update.$set
      const existing = rows.find(r => r.fecha === filter.fecha)
      if (existing) Object.assign(existing, set)
      else rows.push({ ...set })
      return { exec: async () => set }
    },
    async bulkWrite(ops: any[]) {
      for (const op of ops) {
        const { filter, update } = op.updateOne
        const set = update.$set
        const existing = rows.find(r => r.fecha === filter.fecha)
        if (existing) Object.assign(existing, set)
        else rows.push({ ...set })
      }
      return { ok: 1 }
    },
  }
}

function makeConfig(token: string | undefined = 'sk_test.token') {
  return { get: (k: string) => (k === 'API_DECOLECTA' ? token : undefined) } as any
}

/** Respuesta real de Decolecta para 2026-05-08 (sell_price como string). */
const DECOLECTA_2026_05_08 = {
  buy_price: '3.456',
  sell_price: '3.461',
  base_currency: 'USD',
  quote_currency: 'PEN',
  date: '2026-05-08',
}

function mockFetch(impl: (url: string) => { ok: boolean; status?: number; body?: any }) {
  return jest.fn(async (url: string) => {
    const r = impl(url)
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
    } as any
  })
}

describe('ExchangeRateService — TC oficial SUNAT (Decolecta) con caché', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
    jest.restoreAllMocks()
  })

  it('getRate(2026-05-08): toma sell_price (3.461), lo persiste con source=decolecta', async () => {
    const model = makeModel()
    const fetchMock = mockFetch(() => ({ ok: true, body: DECOLECTA_2026_05_08 }))
    global.fetch = fetchMock as any

    const service = new ExchangeRateService(model as any, makeConfig())
    const tasa = await service.getRate('2026-05-08')

    expect(tasa).toBe(3.461)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(model.rows).toEqual([
      { fecha: '2026-05-08', tasa: 3.461, source: 'decolecta' },
    ])
  })

  it('acepta dd/mm/yyyy y lo normaliza a ISO antes de consultar', async () => {
    const model = makeModel()
    const fetchMock = mockFetch(url => {
      expect(url).toContain('date=2026-05-08')
      return { ok: true, body: DECOLECTA_2026_05_08 }
    })
    global.fetch = fetchMock as any

    const service = new ExchangeRateService(model as any, makeConfig())
    expect(await service.getRate('08/05/2026')).toBe(3.461)
  })

  it('segunda consulta de la misma fecha: cache hit, NO llama al API (ahorra cuota)', async () => {
    const model = makeModel([
      { fecha: '2026-05-08', tasa: 3.461, source: 'decolecta' },
    ])
    const fetchMock = mockFetch(() => ({ ok: true, body: DECOLECTA_2026_05_08 }))
    global.fetch = fetchMock as any

    const service = new ExchangeRateService(model as any, makeConfig())
    const tasa = await service.getRate('2026-05-08')

    expect(tasa).toBe(3.461)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('filas de proveedores anteriores (source=sunat/api) NO se confían: se re-piden a Decolecta y se sobrescriben in-place', async () => {
    const model = makeModel([
      { fecha: '2026-05-08', tasa: 3.47, source: 'sunat' },
    ])
    const fetchMock = mockFetch(() => ({ ok: true, body: DECOLECTA_2026_05_08 }))
    global.fetch = fetchMock as any

    const service = new ExchangeRateService(model as any, makeConfig())
    // Devuelve el valor de Decolecta (3.461), no el viejo de e-api (3.47).
    expect(await service.getRate('2026-05-08')).toBe(3.461)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // La fila se sobrescribe in-place con el nuevo origen y valor.
    expect(model.rows).toEqual([
      { fecha: '2026-05-08', tasa: 3.461, source: 'decolecta' },
    ])
  })

  it('feriado pasado (404): congela el último TC previo bajo esa fecha para no gastar cuota otra vez', async () => {
    // 2026-05-08 (viernes) cacheado; se pide 2026-05-09 (sábado) → 404 no_data.
    const model = makeModel([
      { fecha: '2026-05-08', tasa: 3.461, source: 'decolecta' },
    ])
    const fetchMock = mockFetch(() => ({ ok: false, status: 404 }))
    global.fetch = fetchMock as any

    const service = new ExchangeRateService(model as any, makeConfig())
    const tasa = await service.getRate('2026-05-09')

    expect(tasa).toBe(3.461) // fallback al viernes
    // Se persiste bajo el sábado para que la próxima vez sea cache hit.
    expect(model.rows.find(r => r.fecha === '2026-05-09')).toEqual({
      fecha: '2026-05-09',
      tasa: 3.461,
      source: 'decolecta',
    })
  })

  it('fallo transitorio (500 o cuota 429): devuelve fallback pero NO lo persiste (reintenta luego)', async () => {
    const model = makeModel([
      { fecha: '2026-05-08', tasa: 3.461, source: 'decolecta' },
    ])
    const fetchMock = mockFetch(() => ({ ok: false, status: 429 }))
    global.fetch = fetchMock as any

    const service = new ExchangeRateService(model as any, makeConfig())
    const tasa = await service.getRate('2026-05-09')

    expect(tasa).toBe(3.461) // usa fallback para responder
    // Pero NO congela nada: la fecha sigue sin fila propia.
    expect(model.rows.find(r => r.fecha === '2026-05-09')).toBeUndefined()
  })

  it('importOfficialRates: siembra TC venta como sunat-oficial, descarta inválidos, y quedan confiables (cache hit sin API)', async () => {
    const model = makeModel()
    const service = new ExchangeRateService(model as any, makeConfig())

    const res = await service.importOfficialRates([
      { fecha: '2026-05-08', venta: 3.461 },
      { fecha: '2026-05-09', venta: 3.45 },
      { fecha: 'mala-fecha', venta: 3.4 }, // fecha inválida → skipped
      { fecha: '2026-05-10', venta: 0 }, // venta no positiva → skipped
    ])

    expect(res).toEqual({ upserted: 2, skipped: 2 })
    expect(model.rows).toEqual([
      { fecha: '2026-05-08', tasa: 3.461, source: 'sunat-oficial' },
      { fecha: '2026-05-09', tasa: 3.45, source: 'sunat-oficial' },
    ])

    // Las fechas sembradas son cache hit: getRate NO llama al API (0 cuota).
    const fetchMock = mockFetch(() => ({ ok: true, body: DECOLECTA_2026_05_08 }))
    global.fetch = fetchMock as any
    expect(await service.getRate('2026-05-08')).toBe(3.461)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sin token API_DECOLECTA: no llama al API y devuelve fallback sin persistir', async () => {
    const model = makeModel([
      { fecha: '2026-05-08', tasa: 3.461, source: 'decolecta' },
    ])
    const fetchMock = mockFetch(() => ({ ok: true, body: DECOLECTA_2026_05_08 }))
    global.fetch = fetchMock as any

    const noTokenConfig = { get: () => undefined } as any
    const service = new ExchangeRateService(model as any, noTokenConfig)
    const tasa = await service.getRate('2026-05-09')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(tasa).toBe(3.461)
    expect(model.rows.find(r => r.fecha === '2026-05-09')).toBeUndefined()
  })
})
