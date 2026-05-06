import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { Types } from 'mongoose'
import { AdvanceService } from './advance.service'
import { Advance, ADVANCE_THRESHOLDS } from './entities/advance.entity'
import { ExpenseReportService } from '../expense-report/expense-report.service'
import { ProjectService } from '../project/project.service'
import { CategoryService } from '../category/category.service'
import { UserService } from '../user/user.service'
import { EmailService } from '../email/email.service'
import { ROLES } from '../auth/enums/roles.enum'

const advanceId = new Types.ObjectId().toString()
const userId = new Types.ObjectId().toString()
const clientId = new Types.ObjectId().toString()
const reportId = new Types.ObjectId().toString()

// Creates a mock advance document with a save() spy
const makeMockAdvance = (overrides: Record<string, any> = {}) => {
  const doc: any = {
    _id: new Types.ObjectId(advanceId),
    userId: new Types.ObjectId(userId),
    clientId: new Types.ObjectId(clientId),
    amount: 300,
    description: 'Test advance',
    status: 'pending_l1',
    approvalLevel: 0,
    requiredLevels: 1,
    approvalHistory: [],
    ...overrides,
  }
  doc.save = jest.fn().mockResolvedValue(doc)
  return doc
}

// Chainable query mock (for find/populate/sort/exec patterns)
const makeQuery = (resolvedValue: any) => {
  const q: any = {
    populate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
    then: (res: any, rej: any) => Promise.resolve(resolvedValue).then(res, rej),
    catch: (rej: any) => Promise.resolve(resolvedValue).catch(rej),
  }
  return q
}

const mockAdvanceModel = {
  create: jest.fn(),
  find: jest.fn(),
  findById: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}

const mockExpenseReportService = {
  addAdvanceToReport: jest.fn().mockResolvedValue(undefined),
  findOneWithAdvances: jest.fn(),
  updateSettlement: jest.fn().mockResolvedValue(undefined),
}

const mockProjectService = {
  findOne: jest.fn(),
  adjustCommittedAdvanceTotal: jest.fn().mockResolvedValue(undefined),
}

const mockCategoryService = {
  findOne: jest.fn(),
}

const mockUserService = {
  findTransactionalProfile: jest.fn(),
  findEmailNameClient: jest.fn(),
  findCollaboratorViaticoNotifyProfile: jest.fn().mockResolvedValue({
    name: 'Colaborador',
    dni: '12345678',
    employeeCode: 'EMP01',
  }),
  findViaticoAccountingNotifyRecipients: jest.fn().mockResolvedValue([]),
}

const mockEmailService = {
  sendViaticoSolicitudToCoordinator: jest.fn(),
  sendViaticoRechazoColaborador: jest.fn().mockResolvedValue(undefined),
  sendViaticoAprobacionContabilidad: jest.fn().mockResolvedValue(undefined),
  sendViaticoPagoRealizado: jest.fn().mockResolvedValue(undefined),
}

describe('AdvanceService', () => {
  let service: AdvanceService

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdvanceService,
        { provide: getModelToken(Advance.name), useValue: mockAdvanceModel },
        { provide: ExpenseReportService, useValue: mockExpenseReportService },
        { provide: ProjectService, useValue: mockProjectService },
        { provide: CategoryService, useValue: mockCategoryService },
        { provide: UserService, useValue: mockUserService },
        { provide: EmailService, useValue: mockEmailService },
      ],
    }).compile()
    service = module.get<AdvanceService>(AdvanceService)
  })

  // ── create ────────────────────────────────────────────────────────────
  describe('create', () => {
    it('creates an advance and sets requiredLevels=1 for amount <= threshold', async () => {
      const advance = makeMockAdvance({ amount: ADVANCE_THRESHOLDS.L1_MAX })
      mockAdvanceModel.create.mockResolvedValue(advance)
      const result = await service.create({
        userId,
        clientId,
        amount: ADVANCE_THRESHOLDS.L1_MAX,
        description: 'Test',
      })
      expect(result.requiredLevels).toBe(1)
    })

    it('sets requiredLevels=2 for amount > threshold', async () => {
      const advance = makeMockAdvance({ amount: 501, requiredLevels: 2 })
      mockAdvanceModel.create.mockResolvedValue(advance)
      const result = await service.create({
        userId,
        clientId,
        amount: 501,
        description: 'Test',
      })
      expect(result.requiredLevels).toBe(2)
    })

    it('links to expense report when expenseReportId is provided', async () => {
      const advance = makeMockAdvance()
      mockAdvanceModel.create.mockResolvedValue(advance)
      await service.create({
        userId,
        clientId,
        amount: 100,
        description: 'Test',
        expenseReportId: reportId,
      })
      expect(mockExpenseReportService.addAdvanceToReport).toHaveBeenCalledWith(
        reportId,
        advanceId
      )
    })

    it('throws BadRequestException when clientId is missing', async () => {
      await expect(
        service.create({
          userId,
          clientId: '',
          amount: 100,
          description: 'Test',
        })
      ).rejects.toThrow(BadRequestException)
    })

    it('throws BadRequestException when userId is missing', async () => {
      await expect(
        service.create({
          userId: '',
          clientId,
          amount: 100,
          description: 'Test',
        })
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ── findOne ───────────────────────────────────────────────────────────
  describe('findOne', () => {
    it('returns the advance when found', async () => {
      const advance = makeMockAdvance()
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      const result = await service.findOne(advanceId)
      expect(result).toEqual(advance)
    })

    it('throws NotFoundException when advance not found', async () => {
      mockAdvanceModel.findById.mockReturnValue(makeQuery(null))
      await expect(service.findOne(advanceId)).rejects.toThrow(
        NotFoundException
      )
    })
  })

  // ── approveL1 ─────────────────────────────────────────────────────────
  describe('approveL1', () => {
    const dto = { approvedBy: 'admin@test.com', notes: 'OK' }

    it('approves at L1 and sets status=approved when requiredLevels=1', async () => {
      const advance = makeMockAdvance({ requiredLevels: 1 })
      advance.save.mockResolvedValue(advance)
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      const result = await service.approveL1(advanceId, dto, ROLES.ADMIN)
      expect(advance.status).toBe('approved')
      expect(advance.approvalHistory).toHaveLength(1)
      expect(advance.approvalHistory[0].action).toBe('approved')
      expect(advance.save).toHaveBeenCalled()
    })

    it('sets status=pending_l2 when requiredLevels=2', async () => {
      const advance = makeMockAdvance({ requiredLevels: 2 })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.approveL1(advanceId, dto, ROLES.ADMIN)
      expect(advance.status).toBe('pending_l2')
    })

    it('throws ForbiddenException for Colaborador without canApproveL1', async () => {
      const advance = makeMockAdvance()
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.approveL1(advanceId, dto, ROLES.COLABORADOR)
      ).rejects.toThrow(ForbiddenException)
    })

    it('allows approval via canApproveL1 permission', async () => {
      const advance = makeMockAdvance({ requiredLevels: 1 })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.approveL1(advanceId, dto, ROLES.COLABORADOR, {
        canApproveL1: true,
      })
      expect(advance.status).toBe('approved')
    })

    it('throws BadRequestException when status is not pending_l1', async () => {
      const advance = makeMockAdvance({ status: 'approved' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.approveL1(advanceId, dto, ROLES.ADMIN)
      ).rejects.toThrow(BadRequestException)
    })

    it('throws NotFoundException when advance not found', async () => {
      mockAdvanceModel.findById.mockReturnValue(makeQuery(null))
      await expect(
        service.approveL1(advanceId, dto, ROLES.ADMIN)
      ).rejects.toThrow(NotFoundException)
    })
  })

  // ── approveL2 ─────────────────────────────────────────────────────────
  describe('approveL2', () => {
    const dto = { approvedBy: 'super@test.com', notes: 'Approved L2' }

    it('approves at L2 and sets status=approved', async () => {
      const advance = makeMockAdvance({
        status: 'pending_l2',
        requiredLevels: 2,
      })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.approveL2(advanceId, dto, ROLES.SUPER_ADMIN)
      expect(advance.status).toBe('approved')
      expect(advance.approvalLevel).toBe(2)
    })

    it('throws ForbiddenException for Admin without canApproveL2', async () => {
      const advance = makeMockAdvance({ status: 'pending_l2' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.approveL2(advanceId, dto, ROLES.ADMIN)
      ).rejects.toThrow(ForbiddenException)
    })

    it('allows approval via canApproveL2 permission', async () => {
      const advance = makeMockAdvance({ status: 'pending_l2' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.approveL2(advanceId, dto, ROLES.COLABORADOR, {
        canApproveL2: true,
      })
      expect(advance.status).toBe('approved')
    })

    it('throws BadRequestException when status is not pending_l2', async () => {
      const advance = makeMockAdvance({ status: 'pending_l1' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.approveL2(advanceId, dto, ROLES.SUPER_ADMIN)
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ── reject ────────────────────────────────────────────────────────────
  describe('reject', () => {
    const dto = {
      rejectedBy: 'admin@test.com',
      rejectionReason:
        'El monto solicitado no está justificado según la política interna.',
    }

    it('rejects a pending_l1 advance', async () => {
      const advance = makeMockAdvance({ status: 'pending_l1' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.reject(advanceId, dto, ROLES.ADMIN)
      expect(advance.status).toBe('rejected')
      expect(advance.rejectionReason).toBe(dto.rejectionReason)
    })

    it('rejects a pending_l2 advance', async () => {
      const advance = makeMockAdvance({ status: 'pending_l2' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.reject(advanceId, dto, ROLES.ADMIN)
      expect(advance.status).toBe('rejected')
    })

    it('throws BadRequestException for non-rejectable status', async () => {
      const advance = makeMockAdvance({ status: 'approved' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(service.reject(advanceId, dto, ROLES.ADMIN)).rejects.toThrow(
        BadRequestException
      )
    })

    it('throws ForbiddenException for Colaborador without reject permissions', async () => {
      const advance = makeMockAdvance({ status: 'pending_l1' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.reject(advanceId, dto, ROLES.COLABORADOR)
      ).rejects.toThrow(ForbiddenException)
    })
  })

  // ── registerPayment ───────────────────────────────────────────────────
  describe('registerPayment', () => {
    const dto = {
      method: 'transferencia_bancaria' as const,
      bankName: 'BCP',
      accountNumber: '1234',
      cci: '00212341234',
      transferDate: new Date().toISOString(),
      reference: 'REF001',
      paymentReceiptUrl: 'https://files.example.com/receipts/viatico-001.pdf',
      paymentReceiptFileName: 'viatico-001.pdf',
      paymentReceiptMimeType: 'application/pdf',
      paymentReceiptSizeBytes: 1024,
    }

    it('registers payment with receipt, sets status=paid and notifies collaborator/coordinator', async () => {
      const advance = makeMockAdvance({
        status: 'approved',
        projectId: new Types.ObjectId().toString(),
      })
      mockUserService.findEmailNameClient
        .mockResolvedValueOnce({
          name: 'Colaborador Test',
          email: 'colab@test.com',
          clientId: new Types.ObjectId(clientId),
        })
        .mockResolvedValueOnce({
          name: 'Coordinador Test',
          email: 'coord@test.com',
          clientId: new Types.ObjectId(clientId),
        })
      mockUserService.findTransactionalProfile.mockResolvedValue({
        coordinatorId: new Types.ObjectId(),
      })
      mockProjectService.findOne.mockResolvedValue({
        code: 'CC-001',
        name: 'Proyecto Demo',
      })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.registerPayment(advanceId, dto, ROLES.SUPER_ADMIN)
      await new Promise(resolve => setImmediate(resolve))
      expect(advance.status).toBe('paid')
      expect(advance.paymentInfo).toMatchObject({
        method: 'transferencia_bancaria',
        bankName: 'BCP',
        paymentReceiptUrl: dto.paymentReceiptUrl,
      })
      expect(mockEmailService.sendViaticoPagoRealizado).toHaveBeenCalledTimes(2)
    })

    it('throws BadRequestException when advance is not approved', async () => {
      const advance = makeMockAdvance({ status: 'pending_l1' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.registerPayment(advanceId, dto, ROLES.SUPER_ADMIN)
      ).rejects.toThrow(BadRequestException)
    })

    it('throws ForbiddenException for Admin without canApproveL2', async () => {
      const advance = makeMockAdvance({ status: 'approved' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.registerPayment(advanceId, dto, ROLES.ADMIN)
      ).rejects.toThrow(ForbiddenException)
    })

    it('throws BadRequestException when receipt format is invalid', async () => {
      const advance = makeMockAdvance({ status: 'approved' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(
        service.registerPayment(
          advanceId,
          {
            ...dto,
            paymentReceiptUrl: 'https://files.example.com/receipts/viatico-001.exe',
            paymentReceiptFileName: 'viatico-001.exe',
            paymentReceiptMimeType: 'application/x-msdownload',
          },
          ROLES.SUPER_ADMIN
        )
      ).rejects.toThrow(BadRequestException)
    })
  })

  // ── settle ────────────────────────────────────────────────────────────
  describe('settle', () => {
    it('determines type=devolucion when advance > expenses', async () => {
      const advance = makeMockAdvance({
        status: 'paid',
        amount: 500,
        expenseReportId: new Types.ObjectId(reportId),
      })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      mockExpenseReportService.findOneWithAdvances.mockResolvedValue({
        expenseIds: [{ total: 300 }],
      })
      await service.settle(advanceId)
      expect(advance.settlement?.type).toBe('devolucion')
      expect(advance.settlement?.difference).toBe(200)
      expect(advance.status).toBe('settled')
    })

    it('determines type=reembolso when expenses > advance', async () => {
      const advance = makeMockAdvance({
        status: 'paid',
        amount: 200,
        expenseReportId: new Types.ObjectId(reportId),
      })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      mockExpenseReportService.findOneWithAdvances.mockResolvedValue({
        expenseIds: [{ total: 500 }],
      })
      await service.settle(advanceId)
      expect(advance.settlement?.type).toBe('reembolso')
      expect(advance.settlement?.difference).toBe(-300)
    })

    it('determines type=equilibrado when advance equals expenses', async () => {
      const advance = makeMockAdvance({
        status: 'paid',
        amount: 300,
        expenseReportId: new Types.ObjectId(reportId),
      })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      mockExpenseReportService.findOneWithAdvances.mockResolvedValue({
        expenseIds: [{ total: 300 }],
      })
      await service.settle(advanceId)
      expect(advance.settlement?.type).toBe('equilibrado')
    })

    it('throws BadRequestException when advance is not paid', async () => {
      const advance = makeMockAdvance({ status: 'approved' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(service.settle(advanceId)).rejects.toThrow(
        BadRequestException
      )
    })
  })

  // ── registerReturn ────────────────────────────────────────────────────
  describe('registerReturn', () => {
    it('sets status=returned and records returned amount', async () => {
      const advance = makeMockAdvance({ status: 'settled' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.registerReturn(advanceId, 100)
      expect(advance.status).toBe('returned')
      expect(advance.returnedAmount).toBe(100)
    })

    it('allows return from paid status', async () => {
      const advance = makeMockAdvance({ status: 'paid' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await service.registerReturn(advanceId, 50)
      expect(advance.status).toBe('returned')
    })

    it('throws BadRequestException for invalid status', async () => {
      const advance = makeMockAdvance({ status: 'pending_l1' })
      mockAdvanceModel.findById.mockReturnValue(makeQuery(advance))
      await expect(service.registerReturn(advanceId, 100)).rejects.toThrow(
        BadRequestException
      )
    })
  })

  // ── getStats ──────────────────────────────────────────────────────────
  describe('getStats', () => {
    it('returns counts and total amount', async () => {
      mockAdvanceModel.countDocuments
        .mockResolvedValueOnce(2) // pending_l1
        .mockResolvedValueOnce(1) // pending_l2
        .mockResolvedValueOnce(3) // approved
        .mockResolvedValueOnce(4) // paid
        .mockResolvedValueOnce(5) // settled
      mockAdvanceModel.aggregate.mockResolvedValue([{ total: 10000 }])
      const result = await service.getStats(clientId)
      expect(result).toMatchObject({
        pending_l1: 2,
        pending_l2: 1,
        approved: 3,
        paid: 4,
        settled: 5,
      })
    })
  })
})
