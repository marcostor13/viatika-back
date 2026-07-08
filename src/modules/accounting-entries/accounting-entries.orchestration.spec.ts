import { Types } from 'mongoose'
import { AccountingEntriesService } from './accounting-entries.service'
import * as ContanetExport from './entities/contanet-export'

/**
 * Emula el encadenado `.find(...).lean().exec()` / `.findById(...).lean().exec()`
 * de Mongoose, incluyendo `.populate(...)` como no-op encadenable (buildProjectMap).
 */
function mockQuery(result: any) {
  const query: any = {
    lean: () => ({ exec: async () => result }),
  }
  query.populate = () => query
  return query
}

/** Emula `.findOneAndUpdate(...).exec()` / `.updateMany(...).exec()`. */
function mockExec(result: any = undefined) {
  return { exec: async () => result }
}

describe('AccountingEntriesService — orquestación async (status, trigger, S3)', () => {
  const CLIENT_ID = 'c1'
  const REPORT_ID = 'r1'

  const report = {
    _id: REPORT_ID,
    clientId: CLIENT_ID,
    userId: 'u1',
    status: 'approved',
    updatedAt: new Date('2026-01-10T00:00:00Z'),
    advanceIds: [],
  }
  const config = { updatedAt: new Date('2026-01-01T00:00:00Z') }
  const colaborador = { _id: 'u1', name: 'Juan Perez', dni: '12345678' }

  let reportModel: any
  let expenseModel: any
  let advanceModel: any
  let userModel: any
  let fileModel: any
  let accountingConfigService: any
  let exchangeRateService: any
  let uploadService: any
  let service: AccountingEntriesService

  beforeEach(() => {
    reportModel = { findById: jest.fn().mockReturnValue(mockQuery(report)) }
    expenseModel = { find: jest.fn().mockReturnValue(mockQuery([])) }
    advanceModel = { find: jest.fn().mockReturnValue(mockQuery([])) }
    userModel = { findById: jest.fn().mockReturnValue(mockQuery(colaborador)) }
    fileModel = {
      find: jest.fn().mockReturnValue(mockQuery([])),
      findOneAndUpdate: jest.fn().mockReturnValue(mockExec(undefined)),
      updateMany: jest.fn().mockReturnValue(mockExec({ modifiedCount: 0 })),
    }
    accountingConfigService = { getEffective: jest.fn().mockResolvedValue(config) }
    exchangeRateService = { getRate: jest.fn().mockResolvedValue(3.5) }
    uploadService = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
      getPresignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example/file.xlsx'),
    }
    const configService: any = { get: () => 'test-api-key' }

    service = new AccountingEntriesService(
      reportModel,
      expenseModel,
      advanceModel,
      {} as any, // projectModel — no usado en estos tests
      userModel,
      {} as any, // categoryModel — no usado en estos tests
      fileModel,
      accountingConfigService,
      exchangeRateService,
      configService,
      uploadService
    )
  })

  function fingerprint(): string {
    return (service as any).computeFingerprint(report, [], [], config)
  }

  describe('getStatus', () => {
    it('devuelve "none" cuando no existe documento para el tipo', async () => {
      const result = await service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])
      expect(result).toEqual([
        { tipo: 'solicitud', status: 'none', blocked: false, blockedReason: undefined },
      ])
    })

    it('devuelve "ready" con URL firmada cuando el fingerprint coincide', async () => {
      const fp = fingerprint()
      fileModel.find.mockReturnValue(
        mockQuery([
          {
            tipo: 'solicitud',
            status: 'ready',
            s3Key: 'key1',
            filename: 'asientos.xlsx',
            fingerprint: fp,
            asientosCount: 3,
            cuadreErrors: [],
          },
        ])
      )
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])
      expect(status.status).toBe('ready')
      expect(status.url).toBe('https://signed.example/file.xlsx')
      expect(status.stale).toBe(false)
      expect(uploadService.getPresignedDownloadUrl).toHaveBeenCalledWith('key1', 'asientos.xlsx')
    })

    it('marca "stale" cuando el fingerprint ya no coincide (la rendición cambió)', async () => {
      fileModel.find.mockReturnValue(
        mockQuery([
          {
            tipo: 'solicitud',
            status: 'ready',
            s3Key: 'key1',
            filename: 'asientos.xlsx',
            fingerprint: 'fingerprint-viejo',
            asientosCount: 3,
            cuadreErrors: [],
          },
        ])
      )
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])
      expect(status.status).toBe('ready')
      expect(status.stale).toBe(true)
    })

    it('mientras regenera (processing) conserva la URL del archivo anterior', async () => {
      fileModel.find.mockReturnValue(
        mockQuery([
          {
            tipo: 'solicitud',
            status: 'processing',
            s3Key: 'old-key',
            filename: 'old.xlsx',
            fingerprint: 'fingerprint-viejo',
            asientosCount: 1,
            cuadreErrors: [],
          },
        ])
      )
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])
      expect(status.status).toBe('processing')
      expect(status.url).toBe('https://signed.example/file.xlsx')
    })

    it('no ofrece URL cuando "processing" nunca tuvo un archivo previo', async () => {
      fileModel.find.mockReturnValue(
        mockQuery([{ tipo: 'solicitud', status: 'processing', asientosCount: 0, cuadreErrors: [] }])
      )
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])
      expect(status.status).toBe('processing')
      expect(status.url).toBeUndefined()
    })
  })

  describe('triggerGeneration', () => {
    it('dispara runGeneration y marca "processing" para un tipo sin documento previo', async () => {
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud'], 'user1')

      expect(fileModel.findOneAndUpdate).toHaveBeenCalledWith(
        { reportId: report._id, tipo: 'solicitud' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'processing', requestedBy: 'user1' }),
        }),
        { upsert: true }
      )
      expect(runGenSpy).toHaveBeenCalledWith(REPORT_ID, CLIENT_ID, ['solicitud'], expect.anything())
    })

    it('no reintenta un tipo "ready" y al día si no se fuerza', async () => {
      const fp = fingerprint()
      fileModel.find.mockReturnValue(
        mockQuery([
          {
            tipo: 'solicitud',
            status: 'ready',
            s3Key: 'k',
            filename: 'f.xlsx',
            fingerprint: fp,
            asientosCount: 1,
            cuadreErrors: [],
          },
        ])
      )
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud'], 'user1')

      expect(runGenSpy).not.toHaveBeenCalled()
      expect(fileModel.findOneAndUpdate).not.toHaveBeenCalled()
    })

    it('fuerza la regeneración de un tipo "ready" al día cuando force=true', async () => {
      const fp = fingerprint()
      fileModel.find.mockReturnValue(
        mockQuery([
          {
            tipo: 'solicitud',
            status: 'ready',
            s3Key: 'k',
            filename: 'f.xlsx',
            fingerprint: fp,
            asientosCount: 1,
            cuadreErrors: [],
          },
        ])
      )
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud'], 'user1', true)

      expect(runGenSpy).toHaveBeenCalled()
    })

    it('no duplica un job "processing" reciente (evita doble trabajo)', async () => {
      fileModel.find.mockReturnValue(
        mockQuery([
          { tipo: 'solicitud', status: 'processing', startedAt: new Date(), asientosCount: 0, cuadreErrors: [] },
        ])
      )
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud'], 'user1')

      expect(runGenSpy).not.toHaveBeenCalled()
    })

    it('retoma un job "processing" huérfano (más del umbral activo, ej. reinicio del proceso)', async () => {
      const staleStart = new Date(Date.now() - 21 * 60 * 1000)
      fileModel.find.mockReturnValue(
        mockQuery([
          { tipo: 'solicitud', status: 'processing', startedAt: staleStart, asientosCount: 0, cuadreErrors: [] },
        ])
      )
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud'], 'user1')

      expect(runGenSpy).toHaveBeenCalled()
    })
  })

  describe('reconcileStuckJobs', () => {
    it('marca como error los jobs "processing" con más de 10 minutos activos', async () => {
      fileModel.updateMany.mockReturnValue(mockExec({ modifiedCount: 2 }))
      await (service as any).reconcileStuckJobs()

      expect(fileModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'processing',
          startedAt: expect.objectContaining({ $lt: expect.any(Date) }),
        }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'error' }) })
      )
    })
  })

  describe('runGeneration', () => {
    it('aísla fallos por tipo: un error en un tipo no impide que otro se genere y suba a S3', async () => {
      jest.spyOn(service as any, 'buildProjectMap').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'buildCategoryMap').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'prefetchRates').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'resolveCargosClasificacion').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'buildLinesForTipo').mockImplementation(async (...args: any[]) => {
        const tipo = args[0]
        if (tipo === 'compra') throw new Error('fallo simulado en compra')
        return [{ relacionado: 1, montoDebe: 10, montoHaber: 10 }]
      })
      jest.spyOn(ContanetExport, 'generateContanetExcel').mockResolvedValue({ buffer: Buffer.from('xlsx'), ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

      const ctx = {
        report,
        config,
        expenses: [],
        advances: [],
        colaborador,
        fingerprint: 'fp-test',
      }
      await (service as any).runGeneration(REPORT_ID, CLIENT_ID, ['compra', 'solicitud'], ctx)

      // "compra" falló: se marca error y NO se sube nada a S3 para ese tipo.
      expect(fileModel.findOneAndUpdate).toHaveBeenCalledWith(
        { reportId: report._id, tipo: 'compra' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'error', errorMessage: 'fallo simulado en compra' }),
        })
      )
      // "solicitud" tuvo éxito: sube a S3 con la key determinística y queda "ready".
      const expectedKey = `accounting-entries/${CLIENT_ID}/${REPORT_ID}/solicitud.xlsx`
      expect(uploadService.uploadBuffer).toHaveBeenCalledWith(
        expect.any(Buffer),
        expectedKey,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      expect(fileModel.findOneAndUpdate).toHaveBeenCalledWith(
        { reportId: report._id, tipo: 'solicitud' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'ready', s3Key: expectedKey, fingerprint: 'fp-test' }),
        })
      )
    })

    it('serializa: solo UNA rendición genera a la vez, el resto se encola', async () => {
      let current = 0
      let maxObserved = 0
      const resolvers: Array<() => void> = []

      jest.spyOn(service as any, 'buildProjectMap').mockImplementation(async () => {
        current++
        maxObserved = Math.max(maxObserved, current)
        await new Promise<void>(resolve => resolvers.push(resolve))
        current--
        return new Map()
      })
      jest.spyOn(service as any, 'buildCategoryMap').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'prefetchRates').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'resolveCargosClasificacion').mockResolvedValue(new Map())
      jest.spyOn(service as any, 'buildLinesForTipo').mockResolvedValue([])
      jest.spyOn(ContanetExport, 'generateContanetExcel').mockResolvedValue({ buffer: Buffer.from('xlsx'), ext: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

      const ctx = { report, config, expenses: [], advances: [], colaborador, fingerprint: 'fp' }
      const runs = [1, 2, 3].map(i =>
        (service as any).runGeneration(`r${i}`, CLIENT_ID, ['solicitud'], ctx)
      )

      // Solo la 1ra entra; las otras 2 quedan en cola esperando el cupo.
      await new Promise(resolve => setImmediate(resolve))
      expect(current).toBe(1)
      expect(resolvers).toHaveLength(1)

      // Al liberar cada una, entra exactamente la siguiente — nunca más de 1 a la vez.
      resolvers.shift()!()
      await new Promise(resolve => setImmediate(resolve))
      expect(current).toBe(1)
      resolvers.shift()!()
      await new Promise(resolve => setImmediate(resolve))
      expect(current).toBe(1)

      while (resolvers.length) resolvers.shift()!()
      await Promise.all(runs)

      expect(maxObserved).toBe(1)
    })
  })

  describe('bloqueo por estado de la rendición (solo cerrada; solicitud siempre)', () => {
    // La rendición del fixture está en 'approved' (no cerrada). Regla: los asientos
    // de compra/aplicación/devolución/reembolso solo se generan con la rendición
    // cerrada; 'solicitud' se puede generar siempre.
    it('getStatus marca blocked=true para "compra" si la rendición no está cerrada', async () => {
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['compra'])
      expect(status.blocked).toBe(true)
      expect(status.blockedReason).toContain('cerrada')
    })

    it('getStatus marca blocked=false para "solicitud" aunque la rendición no esté cerrada', async () => {
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])
      expect(status.blocked).toBe(false)
    })

    it('getStatus marca blocked=false para "compra" cuando la rendición está cerrada', async () => {
      reportModel.findById.mockReturnValue(mockQuery({ ...report, status: 'closed' }))
      const [status] = await service.getStatus(REPORT_ID, CLIENT_ID, ['compra'])
      expect(status.blocked).toBe(false)
    })

    it('triggerGeneration NO genera "compra" si la rendición no está cerrada', async () => {
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['compra'], 'user1')
      expect(runGenSpy).not.toHaveBeenCalled()
      expect(fileModel.findOneAndUpdate).not.toHaveBeenCalled()
    })

    it('triggerGeneration SÍ genera "compra" cuando la rendición está cerrada', async () => {
      reportModel.findById.mockReturnValue(mockQuery({ ...report, status: 'closed' }))
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['compra'], 'user1')
      expect(runGenSpy).toHaveBeenCalledWith(REPORT_ID, CLIENT_ID, ['compra'], expect.anything())
    })

    it('triggerGeneration genera "solicitud" aunque la rendición no esté cerrada', async () => {
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud'], 'user1')
      expect(runGenSpy).toHaveBeenCalledWith(REPORT_ID, CLIENT_ID, ['solicitud'], expect.anything())
    })

    it('mezcla: con rendición no cerrada, genera solo "solicitud" y descarta "compra"', async () => {
      const runGenSpy = jest.spyOn(service as any, 'runGeneration').mockResolvedValue(undefined)
      await service.triggerGeneration(REPORT_ID, CLIENT_ID, ['solicitud', 'compra'], 'user1')
      expect(runGenSpy).toHaveBeenCalledWith(REPORT_ID, CLIENT_ID, ['solicitud'], expect.anything())
    })
  })

  describe('aislamiento multi-tenant', () => {
    // Bug real: la rendición pertenece a "c1" pero el caller pasa el clientId de
    // OTRA empresa ("c2", ej. un usuario Contabilidad de otra compañía). Antes de
    // este fix, `loadContext` no comparaba ambos: la rendición se procesaba igual,
    // pero las categorías (filtradas por clientId del caller) nunca resolvían,
    // produciendo un "descuadre" confuso en vez de un error de permisos claro.
    it('getStatus rechaza si la rendición no pertenece al clientId del caller', async () => {
      await expect(service.getStatus(REPORT_ID, 'c2', ['solicitud'])).rejects.toThrow(
        'Esta rendición no pertenece a tu empresa'
      )
    })

    it('triggerGeneration rechaza si la rendición no pertenece al clientId del caller', async () => {
      await expect(
        service.triggerGeneration(REPORT_ID, 'c2', ['solicitud'], 'user1')
      ).rejects.toThrow('Esta rendición no pertenece a tu empresa')
      // Nunca debió llegar a tocar categorías/proyectos ni a marcar nada "processing".
      expect(fileModel.findOneAndUpdate).not.toHaveBeenCalled()
    })

    it('no rechaza cuando el clientId coincide (caso normal)', async () => {
      await expect(service.getStatus(REPORT_ID, CLIENT_ID, ['solicitud'])).resolves.toBeDefined()
    })

    it('no rechaza si la rendición no tiene clientId propio (dato legacy) — usa el del caller', async () => {
      reportModel.findById.mockReturnValue(mockQuery({ ...report, clientId: undefined }))
      await expect(service.getStatus(REPORT_ID, 'cualquier-cliente', ['solicitud'])).resolves.toBeDefined()
    })
  })

  describe('cast a ObjectId en queries por clientId (paths Mixed no castean)', () => {
    // Bug real de producción: los paths @Prop({type: Types.ObjectId}) quedan como
    // SchemaType Mixed en runtime y Mongoose NO castea strings en el filtro; un
    // clientId string jamás matchea el ObjectId almacenado y la query devuelve
    // vacío en silencio (las categorías existían pero el motor no las veía).
    const CLIENT_HEX = '6a0741202ec087bd832c0364'
    const CAT_HEX = '6a0759d066e05e452fba84bc'

    it('buildCategoryMap filtra con ObjectId (clientId y _id), no con strings', async () => {
      let captured: any
      const categoryModel = {
        find: jest.fn().mockImplementation((filter: any) => {
          captured = filter
          return mockQuery([])
        }),
      }
      ;(service as any).categoryModel = categoryModel

      const expenses = [{ _id: 'e1', categoryId: CAT_HEX }]
      await (service as any).buildCategoryMap(expenses, CLIENT_HEX)

      expect(captured.clientId).toBeInstanceOf(Types.ObjectId)
      expect(captured.clientId.toString()).toBe(CLIENT_HEX)
      expect(captured._id.$in).toHaveLength(1)
      expect(captured._id.$in[0]).toBeInstanceOf(Types.ObjectId)
      expect(captured._id.$in[0].toString()).toBe(CAT_HEX)
    })

    it('buildProjectMap filtra con ObjectId (clientId y _id), no con strings', async () => {
      let captured: any
      const projectModel = {
        find: jest.fn().mockImplementation((filter: any) => {
          captured = filter
          return mockQuery([])
        }),
      }
      ;(service as any).projectModel = projectModel

      const expenses = [{ _id: 'e1', proyectId: CAT_HEX }]
      await (service as any).buildProjectMap(expenses, { }, CLIENT_HEX)

      expect(captured.clientId).toBeInstanceOf(Types.ObjectId)
      expect(captured._id.$in[0]).toBeInstanceOf(Types.ObjectId)
    })

    it('ids inválidos (no-hex) se descartan del $in en vez de romper la query', async () => {
      let captured: any
      const categoryModel = {
        find: jest.fn().mockImplementation((filter: any) => {
          captured = filter
          return mockQuery([])
        }),
      }
      ;(service as any).categoryModel = categoryModel

      const expenses = [
        { _id: 'e1', categoryId: CAT_HEX },
        { _id: 'e2', categoryId: 'no-es-un-objectid' },
      ]
      await (service as any).buildCategoryMap(expenses, CLIENT_HEX)

      expect(captured._id.$in).toHaveLength(1)
      expect(captured._id.$in[0].toString()).toBe(CAT_HEX)
    })
  })
})
