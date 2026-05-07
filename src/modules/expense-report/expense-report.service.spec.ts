import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { Types } from 'mongoose'
import { ExpenseReportService } from './expense-report.service'
import { ExpenseReport } from './entities/expense-report.entity'
import { EmailService } from '../email/email.service'
import { NotificationsService } from '../notifications/notifications.service'
import { UserService } from '../user/user.service'
import { AdvanceService } from '../advance/advance.service'
import { ROLES } from '../auth/enums/roles.enum'

const mockAdvanceService = {
  liquidateExpenseReport: jest.fn().mockResolvedValue(undefined),
  findPaymentReceiptsForCollaborator: jest.fn().mockResolvedValue([]),
}

const reportId = new Types.ObjectId().toString()
const expenseId1 = new Types.ObjectId().toString()
const expenseId2 = new Types.ObjectId().toString()
const clientId = new Types.ObjectId().toString()
const userId = new Types.ObjectId().toString()

const mockEmailService = {
  sendRendicionFullyApprovedEmail: jest.fn().mockResolvedValue(undefined),
  sendRendicionReembolsoPagado: jest.fn().mockResolvedValue(undefined),
}

const mockNotificationsService = {
  create: jest.fn().mockResolvedValue(undefined),
}

const mockUserService = {
  findAdminsByClient: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue({ name: 'Colaborador Test', email: 'c@test.com' }),
  findTransactionalProfile: jest.fn().mockResolvedValue(null),
  findEmailNameClient: jest.fn().mockResolvedValue(null),
}

describe('ExpenseReportService — Fase 5 (envío y aprobación final)', () => {
  let service: ExpenseReportService
  let mockExpenseReportModel: Record<string, jest.Mock>

  const fullReportDoc = () => ({
    _id: new Types.ObjectId(reportId),
    title: 'Rendición test',
    budget: 1000,
    clientId: new Types.ObjectId(clientId),
    userId: { _id: new Types.ObjectId(userId), name: 'Colaborador', email: 'u@test.com' },
    expenseIds: [],
    status: 'open',
  })

  beforeEach(async () => {
    jest.clearAllMocks()

    mockExpenseReportModel = {
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      }),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseReportService,
        { provide: getModelToken(ExpenseReport.name), useValue: mockExpenseReportModel },
        { provide: EmailService, useValue: mockEmailService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: UserService, useValue: mockUserService },
        { provide: AdvanceService, useValue: mockAdvanceService },
      ],
    }).compile()

    service = module.get<ExpenseReportService>(ExpenseReportService)
  })

  function mockFindByIdSequence(opts: {
    existingStatus: string
    submitPopulateResult?: { expenseIds: unknown[] }
  }) {
    let call = 0
    mockExpenseReportModel.findById.mockImplementation(() => {
      call++
      if (call === 1) {
        return {
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue({ status: opts.existingStatus }),
            }),
          }),
        }
      }
      if (call === 2 && opts.submitPopulateResult !== undefined) {
        return {
          populate: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(opts.submitPopulateResult),
              }),
            }),
          }),
        }
      }
      const chain: { populate: jest.Mock; exec: jest.Mock } = {
        populate: jest.fn(),
        exec: jest.fn(),
      }
      chain.populate.mockReturnValue(chain)
      chain.exec.mockResolvedValue(fullReportDoc())
      return chain
    })
  }

  it('update(submitted): rechaza si no hay gastos', async () => {
    mockFindByIdSequence({
      existingStatus: 'open',
      submitPopulateResult: { expenseIds: [] },
    })

    await expect(service.update(reportId, { status: 'submitted' })).rejects.toThrow(
      /al menos un gasto/
    )

    expect(mockExpenseReportModel.findByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('update(submitted): rechaza si hay gasto rechazado', async () => {
    mockFindByIdSequence({
      existingStatus: 'open',
      submitPopulateResult: {
        expenseIds: [{ _id: expenseId1, status: 'rejected', file: '/f.pdf' }],
      },
    })

    await expect(service.update(reportId, { status: 'submitted' })).rejects.toThrow(/rechazados/)
    expect(mockExpenseReportModel.findByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('update(submitted): rechaza si falta archivo en algún gasto', async () => {
    mockFindByIdSequence({
      existingStatus: 'open',
      submitPopulateResult: {
        expenseIds: [{ _id: expenseId1, status: 'approved', file: '' }],
      },
    })

    await expect(service.update(reportId, { status: 'submitted' })).rejects.toThrow(/comprobante adjunto/)
    expect(mockExpenseReportModel.findByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('update(submitted): persiste cuando los gastos cumplen validación', async () => {
    mockFindByIdSequence({
      existingStatus: 'open',
      submitPopulateResult: {
        expenseIds: [{ _id: expenseId1, status: 'approved', file: '/ok.pdf' }],
      },
    })

    const result = await service.update(reportId, { status: 'submitted' })

    expect(mockExpenseReportModel.findByIdAndUpdate).toHaveBeenCalled()
    expect(result).toBeDefined()
    expect(mockNotificationsService.create).not.toHaveBeenCalled()
    mockUserService.findAdminsByClient.mockResolvedValueOnce([
      { _id: new Types.ObjectId(), email: 'admin@test.com' },
    ])
    mockFindByIdSequence({
      existingStatus: 'open',
      submitPopulateResult: {
        expenseIds: [{ _id: expenseId1, status: 'approved', file: '/ok.pdf' }],
      },
    })
    await service.update(reportId, { status: 'submitted' })
    expect(mockNotificationsService.create).toHaveBeenCalled()
  })

  it('update(approved): rechaza si algún gasto no está aprobado', async () => {
    let call = 0
    mockExpenseReportModel.findById.mockImplementation(() => {
      call++
      if (call === 1) {
        return {
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue({ status: 'submitted' }),
            }),
          }),
        }
      }
      return {
        populate: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue({
                expenseIds: [
                  { _id: expenseId1, status: 'approved', file: '/a.pdf' },
                  { _id: expenseId2, status: 'pending', file: '/b.pdf' },
                ],
              }),
            }),
          }),
        }),
      }
    })

    await expect(service.update(reportId, { status: 'approved' })).rejects.toThrow(/Apruebe todos los gastos/)
    expect(mockExpenseReportModel.findByIdAndUpdate).not.toHaveBeenCalled()
  })

  it('update(approved): persiste cuando todos los gastos están aprobados', async () => {
    let call = 0
    mockExpenseReportModel.findById.mockImplementation(() => {
      call++
      if (call === 1) {
        return {
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue({ status: 'submitted' }),
            }),
          }),
        }
      }
      if (call === 2) {
        return {
          populate: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue({
                  expenseIds: [
                    { _id: expenseId1, status: 'approved', file: '/a.pdf' },
                    { _id: expenseId2, status: 'approved', file: '/b.pdf' },
                  ],
                }),
              }),
            }),
          }),
        }
      }
      const chain: { populate: jest.Mock; exec: jest.Mock } = {
        populate: jest.fn(),
        exec: jest.fn(),
      }
      chain.populate.mockReturnValue(chain)
      chain.exec.mockResolvedValue({
        ...fullReportDoc(),
        expenseIds: [],
        status: 'approved',
      })
      return chain
    })

    await service.update(reportId, { status: 'approved' })

    expect(mockExpenseReportModel.findByIdAndUpdate).toHaveBeenCalled()
    expect(mockEmailService.sendRendicionFullyApprovedEmail).toHaveBeenCalled()
  })

  describe('registerAffidavit — Fase 5 declaración jurada', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('rechaza si la rendición no está cerrada', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({
        ...fullReportDoc(),
        status: 'approved',
        expenseIds: [{ _id: expenseId1 }],
      } as never)

      await expect(
        service.registerAffidavit(
          reportId,
          { type: 'viaticos_nacionales', expenseIds: [expenseId1] },
          userId
        )
      ).rejects.toThrow(/cerrada/)
    })

    it('rechaza si un gasto no pertenece a la rendición', async () => {
      const foreignId = new Types.ObjectId().toString()
      jest.spyOn(service, 'findOne').mockResolvedValue({
        ...fullReportDoc(),
        status: 'closed',
        expenseIds: [{ _id: expenseId1 }],
      } as never)

      await expect(
        service.registerAffidavit(
          reportId,
          { type: 'viajes_exterior', expenseIds: [foreignId] },
          userId
        )
      ).rejects.toThrow(/no pertenecen/)
    })

    it('actualiza el reporte cuando es válido', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({
        ...fullReportDoc(),
        status: 'closed',
        expenseIds: [{ _id: expenseId1 }, { _id: expenseId2 }],
      } as never)

      const out = await service.registerAffidavit(
        reportId,
        { type: 'viaticos_nacionales', expenseIds: [expenseId1] },
        userId
      )

      expect(mockExpenseReportModel.findByIdAndUpdate).toHaveBeenCalledWith(
        reportId,
        expect.objectContaining({
          $push: expect.objectContaining({
            affidavits: expect.objectContaining({
              type: 'viaticos_nacionales',
            }),
          }),
        })
      )
      expect(out.reportId).toBe(reportId)
      expect(out.expenseIds).toEqual([expenseId1])
    })
  })
})

const validReimbursementDto = {
  method: 'transferencia_bancaria' as const,
  transferDate: '2025-01-15T00:00:00.000Z',
  paymentReceiptUrl: 'https://cdn.example.com/comprobante.pdf',
  paymentReceiptFileName: 'comprobante.pdf',
  paymentReceiptMimeType: 'application/pdf',
  paymentReceiptSizeBytes: 1024,
}

describe('ExpenseReportService — Fase 6 (reembolso: tenant y registro)', () => {
  let service: ExpenseReportService
  let mockExpenseReportModel: Record<string, jest.Mock>
  const clientA = new Types.ObjectId()
  const clientB = new Types.ObjectId()

  function reimbursementReportDoc(overrides: {
    clientId?: Types.ObjectId
    save?: jest.Mock
  }) {
    const save =
      overrides.save ?? jest.fn().mockImplementation(function mockSave(this: unknown) {
        return Promise.resolve(this)
      })
    return {
      _id: new Types.ObjectId(reportId),
      title: 'Rendición reembolso',
      clientId: overrides.clientId ?? clientA,
      userId: {
        _id: new Types.ObjectId(userId),
        name: 'Colaborador',
        email: 'col@test.com',
      },
      status: 'approved',
      settlement: { type: 'reembolso' as const, difference: 120.5 },
      reimbursementPaymentInfo: undefined,
      save,
    }
  }

  function populateChainExecResult() {
    return {
      _id: new Types.ObjectId(reportId),
      title: 'Rendición reembolso',
      clientId: clientA,
      userId: {
        _id: new Types.ObjectId(userId),
        name: 'Colaborador',
        email: 'col@test.com',
      },
      status: 'reimbursed',
      settlement: { type: 'reembolso', difference: 120.5 },
      reimbursementPaymentInfo: {
        method: 'transferencia_bancaria',
        paymentReceiptUrl: validReimbursementDto.paymentReceiptUrl,
        paymentReceiptFileName: validReimbursementDto.paymentReceiptFileName,
        paymentReceiptMimeType: validReimbursementDto.paymentReceiptMimeType,
        transferDate: new Date(validReimbursementDto.transferDate),
        reference: 'REF-1',
      },
      expenseIds: [],
    }
  }

  beforeEach(async () => {
    jest.clearAllMocks()

    mockExpenseReportModel = {
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      }),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseReportService,
        { provide: getModelToken(ExpenseReport.name), useValue: mockExpenseReportModel },
        { provide: EmailService, useValue: mockEmailService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: UserService, useValue: mockUserService },
        { provide: AdvanceService, useValue: mockAdvanceService },
      ],
    }).compile()

    service = module.get<ExpenseReportService>(ExpenseReportService)
  })

  it('registerReimbursementPayment: Forbidden si tenant distinto al cliente de la rendición', async () => {
    const doc = reimbursementReportDoc({ clientId: clientA })
    mockExpenseReportModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(doc),
    })

    await expect(
      service.registerReimbursementPayment(
        reportId,
        validReimbursementDto,
        ROLES.ADMIN,
        { canApproveL2: true },
        { requestClientId: clientB.toHexString(), isSuperAdmin: false }
      )
    ).rejects.toThrow(ForbiddenException)

    expect(doc.save).not.toHaveBeenCalled()
  })

  it('registerReimbursementPayment: Forbidden si requestClientId vacío', async () => {
    const doc = reimbursementReportDoc({ clientId: clientA })
    mockExpenseReportModel.findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(doc),
    })

    await expect(
      service.registerReimbursementPayment(
        reportId,
        validReimbursementDto,
        ROLES.ADMIN,
        { canApproveL2: true },
        { requestClientId: '', isSuperAdmin: false }
      )
    ).rejects.toThrow(ForbiddenException)

    expect(doc.save).not.toHaveBeenCalled()
  })

  it('registerReimbursementPayment: superadmin omite chequeo de tenant aunque clientId no coincida', async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const doc = reimbursementReportDoc({ clientId: clientA, save })
    let findByIdCall = 0
    mockExpenseReportModel.findById.mockImplementation(() => {
      findByIdCall++
      if (findByIdCall === 1) {
        return { exec: jest.fn().mockResolvedValue(doc) }
      }
      const chain: { populate: jest.Mock; exec: jest.Mock } = {
        populate: jest.fn(),
        exec: jest.fn(),
      }
      chain.populate.mockReturnValue(chain)
      chain.exec.mockResolvedValue(populateChainExecResult())
      return chain
    })

    await service.registerReimbursementPayment(
      reportId,
      validReimbursementDto,
      ROLES.SUPER_ADMIN,
      {},
      { requestClientId: clientB.toHexString(), isSuperAdmin: true }
    )

    expect(save).toHaveBeenCalled()
    expect(mockEmailService.sendRendicionReembolsoPagado).toHaveBeenCalled()
  })

  it('registerReimbursementPayment: persiste con tenant coincidente', async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const doc = reimbursementReportDoc({ clientId: clientA, save })
    let findByIdCall = 0
    mockExpenseReportModel.findById.mockImplementation(() => {
      findByIdCall++
      if (findByIdCall === 1) {
        return { exec: jest.fn().mockResolvedValue(doc) }
      }
      const chain: { populate: jest.Mock; exec: jest.Mock } = {
        populate: jest.fn(),
        exec: jest.fn(),
      }
      chain.populate.mockReturnValue(chain)
      chain.exec.mockResolvedValue(populateChainExecResult())
      return chain
    })

    const out = await service.registerReimbursementPayment(
      reportId,
      validReimbursementDto,
      ROLES.ADMIN,
      { canApproveL2: true },
      { requestClientId: clientA.toHexString(), isSuperAdmin: false }
    )

    expect(save).toHaveBeenCalled()
    expect(out.status).toBe('reimbursed')
    expect(mockEmailService.sendRendicionReembolsoPagado).toHaveBeenCalled()
  })
})
