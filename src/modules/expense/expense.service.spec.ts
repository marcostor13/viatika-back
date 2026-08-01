import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { Types } from 'mongoose'
import { ConfigService } from '@nestjs/config'
import { ExpenseService } from './expense.service'
import { Expense } from './entities/expense.entity'
import { EmailService } from '../email/email.service'
import { ProjectService } from '../project/project.service'
import { UserService } from '../user/user.service'
import { SunatConfigService } from '../sunat-config/sunat-config.service'
import { HttpService } from '@nestjs/axios'
import { UploadService } from '../upload/upload.service'
import { ExpenseReportService } from '../expense-report/expense-report.service'
import { NotificationsService } from '../notifications/notifications.service'
import { CategoryService } from '../category/category.service'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { Client } from '../client/entities/client.entity'
import { CurrencyService } from '../exchange-rate/currency.service'

describe('ExpenseService — email gating (isEmailEnabled)', () => {
  let service: ExpenseService

  const mockEmailServiceGating = {
    buildAppUrl: jest.fn().mockReturnValue('http://app'),
    sendInvoiceApprovedToColaborador: jest.fn().mockResolvedValue(undefined),
  }

  const mockUserServiceGating = {
    findOne: jest.fn(),
    findAll: jest.fn(),
    isEmailEnabled: jest.fn(),
  }

  const mockCategoryServiceGating = {
    findOne: jest.fn().mockResolvedValue(null),
  }

  beforeEach(async () => {
    jest.clearAllMocks()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('sk-test') },
        },
        {
          provide: getModelToken(Expense.name),
          useValue: { aggregate: jest.fn() },
        },
        { provide: getModelToken(Client.name), useValue: {} },
        { provide: EmailService, useValue: mockEmailServiceGating },
        { provide: ProjectService, useValue: {} },
        { provide: UserService, useValue: mockUserServiceGating },
        { provide: SunatConfigService, useValue: {} },
        { provide: HttpService, useValue: {} },
        { provide: UploadService, useValue: {} },
        { provide: ExpenseReportService, useValue: {} },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CategoryService, useValue: mockCategoryServiceGating },
        {
          provide: CurrencyService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue({ monedaBase: 'PEN', supportedCurrencies: [] }),
            toBase: jest.fn().mockResolvedValue({ montoBase: 0, tipoCambio: 1, tcFecha: '2026-01-01' }),
          },
        },
      ],
    }).compile()

    service = module.get<ExpenseService>(ExpenseService)
  })

  const clientId = new Types.ObjectId().toHexString()

  describe('sendApprovalEmails — collaborator email gating', () => {
    const createdBy = new Types.ObjectId().toHexString()
    const collab1Id = new Types.ObjectId()

    const expense = { data: null, createdBy, clientId }

    it('skips collaborator approval email when isEmailEnabled returns false', async () => {
      mockUserServiceGating.findOne.mockResolvedValue({
        email: 'creator@test.com',
        name: 'Creator',
      })
      mockUserServiceGating.findAll.mockResolvedValue([
        { _id: collab1Id, email: 'collab@test.com', name: 'Collab' },
      ])
      mockUserServiceGating.isEmailEnabled.mockResolvedValue(false)

      await (service as any).sendApprovalEmails(expense, null, 'Admin', 'User')

      expect(
        mockEmailServiceGating.sendInvoiceApprovedToColaborador
      ).not.toHaveBeenCalled()
    })

    it('sends collaborator approval email when isEmailEnabled returns true', async () => {
      mockUserServiceGating.findOne.mockResolvedValue({
        email: 'creator@test.com',
        name: 'Creator',
      })
      mockUserServiceGating.findAll.mockResolvedValue([
        { _id: collab1Id, email: 'collab@test.com', name: 'Collab' },
      ])
      mockUserServiceGating.isEmailEnabled.mockResolvedValue(true)

      await (service as any).sendApprovalEmails(expense, null, 'Admin', 'User')

      expect(
        mockEmailServiceGating.sendInvoiceApprovedToColaborador
      ).toHaveBeenCalledWith('collab@test.com', expect.any(Object))
    })
  })
})

describe('ExpenseService — createDeclaracionJurada', () => {
  let service: ExpenseService

  const mockExpenseModel = {
    create: jest.fn(),
  }
  const mockExpenseReportService = {
    assertReportNotLockedByCajaChica: jest.fn().mockResolvedValue(undefined),
    addExpenseToReport: jest.fn().mockResolvedValue(undefined),
    findCurrency: jest.fn().mockResolvedValue(null),
  }
  const mockUserService = {
    findEmailNameClient: jest.fn(),
  }
  const mockCategoryService = {
    findOne: jest.fn().mockResolvedValue(null),
  }
  const mockCurrencyService = {
    getConfig: jest
      .fn()
      .mockResolvedValue({ monedaBase: 'PEN', supportedCurrencies: [] }),
    // TC de juguete: USD → PEN a 3.5; el resto sin conversión.
    resolveRate: jest.fn(
      (moneda: string, _date: Date | string): Promise<number | null> =>
        Promise.resolve(moneda === 'USD' ? 3.5 : 1)
    ),
    toBase: jest.fn((monto: number, moneda: string) => {
      const rate = moneda === 'USD' ? 3.5 : 1
      return Promise.resolve({
        montoBase: Math.round(monto * rate * 100) / 100,
        tipoCambio: rate,
        tcFecha: '2026-02-23',
      })
    }),
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    mockUserService.findEmailNameClient.mockResolvedValue({
      email: 'user@test.com',
      name: 'Juan Perez',
      clientId: new Types.ObjectId(),
    })
    mockExpenseModel.create.mockImplementation((doc: any) =>
      Promise.resolve({ ...doc, _id: new Types.ObjectId() })
    )

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('sk-test') },
        },
        { provide: getModelToken(Expense.name), useValue: mockExpenseModel },
        { provide: getModelToken(Client.name), useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: ProjectService, useValue: {} },
        { provide: UserService, useValue: mockUserService },
        { provide: SunatConfigService, useValue: {} },
        { provide: HttpService, useValue: {} },
        { provide: UploadService, useValue: {} },
        { provide: ExpenseReportService, useValue: mockExpenseReportService },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CategoryService, useValue: mockCategoryService },
        { provide: CurrencyService, useValue: mockCurrencyService },
      ],
    }).compile()

    service = module.get<ExpenseService>(ExpenseService)
  })

  const clientId = new Types.ObjectId().toHexString()
  const proyectId = new Types.ObjectId().toHexString()
  const alimentacionCategoryId = new Types.ObjectId().toHexString()
  const movilidadCategoryId = new Types.ObjectId().toHexString()

  const basePayload = {
    proyectId,
    clientId,
    userId: new Types.ObjectId().toHexString(),
    moneda: 'USD',
    destino: 'Quito',
    pais: 'Ecuador',
    lugarFirma: 'Pucallpa',
    alimentacion: {
      categoryId: alimentacionCategoryId,
      rows: [
        { fecha: '23/02/2026', monto: 55 },
        { fecha: '24/02/2026', monto: 55 },
      ],
    },
    movilidad: {
      categoryId: movilidadCategoryId,
      rows: [{ fecha: '23/02/2026', monto: 35 }],
    },
  } as any

  it('crea un gasto por cada rubro presente, vinculados por el mismo groupId', async () => {
    const result = await service.createDeclaracionJurada(basePayload)

    expect(result.expenses).toHaveLength(2)
    expect(mockExpenseModel.create).toHaveBeenCalledTimes(2)
    expect(mockExpenseReportService.addExpenseToReport).not.toHaveBeenCalled()

    const [alimentacionExpense, movilidadExpense] = result.expenses as any[]
    expect(alimentacionExpense.declaracionJuradaGroupId).toBe(result.groupId)
    expect(movilidadExpense.declaracionJuradaGroupId).toBe(result.groupId)
    expect(alimentacionExpense.total).toBeCloseTo(110)
    expect(movilidadExpense.total).toBeCloseTo(35)
    expect(alimentacionExpense.subTipo).toBe('DJ')
    expect(alimentacionExpense.declaracionJurada).toBe(true)
    expect(alimentacionExpense.declaracionJuradaFirmante).toBe('Juan Perez')
    expect(alimentacionExpense.file).toBeUndefined()
  })

  it('permite un solo rubro (movilidad) sin exigir alimentación', async () => {
    const { alimentacion, ...payload } = basePayload
    void alimentacion
    const result = await service.createDeclaracionJurada(payload)

    expect(result.expenses).toHaveLength(1)
    expect((result.expenses[0] as any).declaracionJuradaMoneda).toBe('USD')
  })

  it('rechaza cuando no se envía ninguna fila en ningún rubro', async () => {
    const payload = { proyectId, clientId, moneda: 'USD' } as any
    await expect(service.createDeclaracionJurada(payload)).rejects.toThrow(
      'Debes ingresar al menos un gasto de Alimentación o Movilidad'
    )
  })

  it('el adjunto es opcional: sin imageUrl, file queda undefined', async () => {
    const result = await service.createDeclaracionJurada(basePayload)
    for (const expense of result.expenses as any[]) {
      expect(expense.file).toBeUndefined()
    }
  })

  it('vincula los gastos a la rendición cuando se envía expenseReportId', async () => {
    const expenseReportId = new Types.ObjectId().toHexString()
    await service.createDeclaracionJurada({ ...basePayload, expenseReportId })

    expect(mockExpenseReportService.addExpenseToReport).toHaveBeenCalledTimes(2)
  })

  it('registra los gastos en la moneda del viático y congela su equivalente en soles', async () => {
    const expenseReportId = new Types.ObjectId().toHexString()
    mockExpenseReportService.findCurrency.mockResolvedValue({ moneda: 'USD' })

    const result = await service.createDeclaracionJurada({
      ...basePayload,
      moneda: 'US$',
      expenseReportId,
    })

    const [alimentacion] = result.expenses as any[]
    expect(alimentacion.moneda).toBe('USD')
    expect(alimentacion.total).toBeCloseTo(110)
    expect(alimentacion.montoBase).toBeCloseTo(385) // 110 × 3.5
    expect(alimentacion.tipoCambio).toBeCloseTo(3.5)
    // Ya está en la moneda del viático: el importe en esa moneda es el nativo.
    expect(alimentacion.monedaReporte).toBe('USD')
    expect(alimentacion.montoReporte).toBeCloseTo(110)
    expect(alimentacion.tcReporte).toBeCloseTo(3.5)
    // El símbolo del formulario se conserva tal cual para el PDF de la DJ.
    expect(alimentacion.declaracionJuradaMoneda).toBe('US$')
  })

  it('una DJ dentro de una rendición en soles no se marca en dólares', async () => {
    const expenseReportId = new Types.ObjectId().toHexString()
    mockExpenseReportService.findCurrency.mockResolvedValue({ moneda: 'PEN' })

    const result = await service.createDeclaracionJurada({
      ...basePayload,
      moneda: 'US$',
      expenseReportId,
    })

    const [alimentacion] = result.expenses as any[]
    expect(alimentacion.moneda).toBe('PEN')
    expect(alimentacion.montoBase).toBeCloseTo(110)
  })

  describe('congelado a la moneda de la rendición (TC del día del gasto)', () => {
    const freeze = (
      moneda: string | undefined,
      total: number,
      fecha = '2026-07-06'
    ) =>
      (service as any).computeReportCurrencyFreeze(
        clientId,
        new Types.ObjectId().toHexString(),
        moneda,
        total,
        fecha
      )

    it('convierte a dólares un gasto hecho en soles dentro de un viático en dólares', async () => {
      mockExpenseReportService.findCurrency.mockResolvedValue({
        moneda: 'USD',
        tipoCambio: 3.6,
      })

      // S/ 54.45 al TC del día (3.5) = USD 15.56, no al TC del viático (3.6).
      await expect(freeze('PEN', 54.45)).resolves.toEqual({
        monedaReporte: 'USD',
        tcReporte: 3.5,
        montoReporte: 15.56,
      })
    })

    it('no toca los gastos de una rendición en moneda base', async () => {
      mockExpenseReportService.findCurrency.mockResolvedValue({ moneda: 'PEN' })
      await expect(freeze('PEN', 54.45)).resolves.toEqual({})
    })

    it('sin rendición no congela nada', async () => {
      await expect(
        (service as any).computeReportCurrencyFreeze(
          clientId,
          undefined,
          'PEN',
          54.45,
          '2026-07-06'
        )
      ).resolves.toEqual({})
    })

    it('lee la fecha dd/mm/yyyy con la que se persiste, no como mm/dd', async () => {
      mockExpenseReportService.findCurrency.mockResolvedValue({
        moneda: 'USD',
        tipoCambio: 3.556,
      })
      mockCurrencyService.resolveRate.mockClear()

      // Con `new Date('13/07/2026')` esto era Invalid Date → TC de hoy.
      await freeze('PEN', 100, '13/07/2026')

      // La fecha se ancla a medianoche UTC, que es como la lee `toIsoDate`.
      const fecha = mockCurrencyService.resolveRate.mock.calls[0][1] as Date
      expect(fecha.toISOString().slice(0, 10)).toBe('2026-07-13')
    })

    it('si no hay TC del día cae al TC del viático, nunca a 1', async () => {
      mockExpenseReportService.findCurrency.mockResolvedValue({
        moneda: 'USD',
        tipoCambio: 3.556,
      })
      mockCurrencyService.resolveRate.mockResolvedValueOnce(null)

      const result = await freeze('PEN', 54.45)
      expect(result.tcReporte).toBeCloseTo(3.556)
      expect(result.montoReporte).toBeCloseTo(15.31)
    })
  })

  it("normaliza el símbolo 'US$' del formulario cuando la DJ no está en una rendición", async () => {
    const result = await service.createDeclaracionJurada({
      ...basePayload,
      moneda: 'US$',
    })

    expect((result.expenses[0] as any).moneda).toBe('USD')
  })
})

describe('ExpenseService — Fase 5 (plazos y límites de categoría)', () => {
  let service: ExpenseService

  const mockExpenseRepository = {
    aggregate: jest.fn(),
  }

  const mockCategoryService = {
    findOne: jest.fn(),
  }

  const noopDeps = {
    emailService: {},
    projectService: {},
    userService: {},
    sunatConfigService: {},
    httpService: {},
    uploadService: {},
    expenseReportService: {},
    notificationsService: {},
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-05-15T15:00:00.000Z'))

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('sk-test-openai-key') },
        },
        {
          provide: getModelToken(Expense.name),
          useValue: mockExpenseRepository,
        },
        { provide: getModelToken(Client.name), useValue: {} },
        { provide: EmailService, useValue: noopDeps.emailService },
        { provide: ProjectService, useValue: noopDeps.projectService },
        { provide: UserService, useValue: noopDeps.userService },
        { provide: SunatConfigService, useValue: noopDeps.sunatConfigService },
        { provide: HttpService, useValue: noopDeps.httpService },
        { provide: UploadService, useValue: noopDeps.uploadService },
        {
          provide: ExpenseReportService,
          useValue: noopDeps.expenseReportService,
        },
        {
          provide: NotificationsService,
          useValue: noopDeps.notificationsService,
        },
        { provide: CategoryService, useValue: mockCategoryService },
        {
          provide: CurrencyService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue({ monedaBase: 'PEN', supportedCurrencies: [] }),
            toBase: jest.fn().mockResolvedValue({ montoBase: 0, tipoCambio: 1, tcFecha: '2026-01-01' }),
          },
        },
      ],
    }).compile()

    service = module.get<ExpenseService>(ExpenseService)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('evaluateDeadline', () => {
    it('sin fecha no marca observación', () => {
      const out = (
        service as unknown as {
          evaluateDeadline: (d?: string | null) => unknown
        }
      ).evaluateDeadline(null)
      expect(out).toEqual({ observado: false })
    })

    it('emisión reciente no observa', () => {
      const out = (
        service as unknown as { evaluateDeadline: (d: string) => unknown }
      ).evaluateDeadline('2026-05-14')
      expect(out).toEqual({ observado: false })
    })

    it('emisión con varios días de antigüedad no observa', () => {
      const out = (
        service as unknown as { evaluateDeadline: (d: string) => unknown }
      ).evaluateDeadline('2026-05-10')
      expect(out).toEqual({ observado: false })
    })

    it('emisión de mes anterior tampoco rechaza', () => {
      const out = (
        service as unknown as { evaluateDeadline: (d: string) => unknown }
      ).evaluateDeadline('2026-04-20')
      expect(out).toEqual({ observado: false })
    })
  })

  describe('evaluateCategoryLimit', () => {
    const bodyBase = (): CreateExpenseDto =>
      ({
        expenseReportId: new Types.ObjectId().toString(),
        categoryId: new Types.ObjectId().toString(),
        clientId: new Types.ObjectId().toString(),
      }) as CreateExpenseDto

    it('sin datos de categoría no evalúa', async () => {
      const b = bodyBase()
      delete (b as { expenseReportId?: string }).expenseReportId
      const out = await (
        service as unknown as {
          evaluateCategoryLimit: (
            dto: CreateExpenseDto,
            n: number
          ) => Promise<unknown>
        }
      ).evaluateCategoryLimit(b, 100)
      expect(out).toEqual({})
      expect(mockCategoryService.findOne).not.toHaveBeenCalled()
    })

    it('bloquea al llegar o superar el 100% del límite', async () => {
      mockCategoryService.findOne.mockResolvedValue({ limit: 100 })
      mockExpenseRepository.aggregate.mockResolvedValue([{ total: 92 }])
      await expect(
        (
          service as unknown as {
            evaluateCategoryLimit: (
              dto: CreateExpenseDto,
              n: number
            ) => Promise<unknown>
          }
        ).evaluateCategoryLimit(bodyBase(), 10)
      ).rejects.toThrow(/Límite de categoría/)
    })

    it('alerta al alcanzar al menos el 90%', async () => {
      mockCategoryService.findOne.mockResolvedValue({ limit: 100 })
      mockExpenseRepository.aggregate.mockResolvedValue([{ total: 85 }])
      const out = await (
        service as unknown as {
          evaluateCategoryLimit: (
            dto: CreateExpenseDto,
            n: number
          ) => Promise<unknown>
        }
      ).evaluateCategoryLimit(bodyBase(), 10)
      expect(out).toMatchObject({
        warning: expect.stringContaining('90%'),
      })
    })

    it('por debajo del 90% devuelve solo porcentaje', async () => {
      mockCategoryService.findOne.mockResolvedValue({ limit: 100 })
      mockExpenseRepository.aggregate.mockResolvedValue([{ total: 10 }])
      const out = await (
        service as unknown as {
          evaluateCategoryLimit: (
            dto: CreateExpenseDto,
            n: number
          ) => Promise<unknown>
        }
      ).evaluateCategoryLimit(bodyBase(), 50)
      expect(out).toEqual({ percent: 60 })
      expect((out as { warning?: string }).warning).toBeUndefined()
    })
  })
})
