import { Test, TestingModule } from '@nestjs/testing'
import { getModelToken } from '@nestjs/mongoose'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { DirectReimbursementService, OVERRUN_TOLERANCE } from './direct-reimbursement.service'
import { DirectReimbursement } from './entities/direct-reimbursement.entity'
import { EmailService } from '../email/email.service'
import { UserService } from '../user/user.service'
import { NotificationsService } from '../notifications/notifications.service'

const mockEmailService = {
  sendReembolsoDirectoAbierto: jest.fn().mockResolvedValue(undefined),
  sendReembolsoDirectoPagado: jest.fn().mockResolvedValue(undefined),
}

const mockUserService = {
  findEmailNameClient: jest.fn().mockResolvedValue({ name: 'Test User', email: 't@test.com' }),
  findAccountingRecipientsWithIds: jest.fn().mockResolvedValue([]),
}

const mockNotificationsService = {
  create: jest.fn().mockResolvedValue(undefined),
}

const coordinatorId = new Types.ObjectId().toString()
const collaboratorId = new Types.ObjectId().toString()
const clientId = new Types.ObjectId().toString()
const docId = new Types.ObjectId().toString()

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(docId),
    code: 'RD-2026-0001',
    coordinatorId: new Types.ObjectId(coordinatorId),
    collaboratorId: new Types.ObjectId(collaboratorId),
    clientId: new Types.ObjectId(clientId),
    status: 'open',
    justification: 'x'.repeat(100),
    estimatedAmount: 1000,
    expenseIds: [],
    ...overrides,
  }
}

describe('DirectReimbursementService', () => {
  let service: DirectReimbursementService
  let mockModel: Record<string, jest.Mock>

  beforeEach(async () => {
    jest.clearAllMocks()

    mockModel = {
      create: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      find: jest.fn(),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DirectReimbursementService,
        { provide: getModelToken(DirectReimbursement.name), useValue: mockModel },
        { provide: EmailService, useValue: mockEmailService },
        { provide: UserService, useValue: mockUserService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile()

    service = module.get<DirectReimbursementService>(DirectReimbursementService)
  })

  describe('create', () => {
    it('lanza BadRequestException si la justificacion tiene menos de 100 caracteres', async () => {
      await expect(
        service.create(
          { collaboratorId, clientId, justification: 'corta', estimatedAmount: 500 },
          coordinatorId
        )
      ).rejects.toThrow(BadRequestException)
    })

    it('genera codigo y crea el expediente', async () => {
      mockModel.findOne.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }) }) })
      const doc = makeDoc()
      mockModel.create.mockResolvedValue(doc)

      const result = await service.create(
        { collaboratorId, clientId, justification: 'x'.repeat(100), estimatedAmount: 500 },
        coordinatorId
      )

      expect(mockModel.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', estimatedAmount: 500 }))
      expect(mockEmailService.sendReembolsoDirectoAbierto).toHaveBeenCalled()
      expect(result).toBeDefined()
    })
  })

  describe('addExpense', () => {
    it('lanza NotFoundException si el expediente no existe', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) })
      await expect(service.addExpense(docId, new Types.ObjectId().toString())).rejects.toThrow(NotFoundException)
    })

    it('lanza BadRequestException si el estado no permite agregar gastos', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'paid' })) })
      await expect(service.addExpense(docId, new Types.ObjectId().toString())).rejects.toThrow(BadRequestException)
    })

    it('agrega gasto y cambia estado a expenses_loaded', async () => {
      const expenseId = new Types.ObjectId().toString()
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc()) })
      const updated = makeDoc({ status: 'expenses_loaded' })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) })

      const result = await service.addExpense(docId, expenseId)
      expect(result.status).toBe('expenses_loaded')
    })
  })

  describe('coordinatorApprove', () => {
    it('lanza ForbiddenException si no es el coordinador responsable', async () => {
      const otherCoord = new Types.ObjectId().toString()
      mockModel.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'expenses_loaded' })) }),
      })
      await expect(service.coordinatorApprove(docId, otherCoord)).rejects.toThrow(ForbiddenException)
    })

    it('lanza BadRequestException si no hay gastos cargados', async () => {
      mockModel.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(makeDoc({ status: 'expenses_loaded', expenseIds: [] })),
        }),
      })
      await expect(service.coordinatorApprove(docId, coordinatorId)).rejects.toThrow(BadRequestException)
    })

    it('lanza BadRequestException si supera tolerancia sin justificacion de sobreejecucion', async () => {
      const total = 1000 * (1 + OVERRUN_TOLERANCE) + 1
      mockModel.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(makeDoc({
            status: 'expenses_loaded',
            expenseIds: [{ _id: new Types.ObjectId(), total }],
            estimatedAmount: 1000,
            overrunJustification: undefined,
          })),
        }),
      })
      await expect(service.coordinatorApprove(docId, coordinatorId)).rejects.toThrow(/tolerancia/)
    })

    it('aprueba cuando gastos son validos', async () => {
      mockModel.findById.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(makeDoc({
            status: 'expenses_loaded',
            expenseIds: [{ _id: new Types.ObjectId(), total: 500 }],
          })),
        }),
      })
      const updated = makeDoc({ status: 'coordinator_approved' })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) })

      const result = await service.coordinatorApprove(docId, coordinatorId)
      expect(result.status).toBe('coordinator_approved')
    })
  })

  describe('accountingApprove', () => {
    it('lanza BadRequestException si estado no es coordinator_approved', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'open' })) })
      await expect(service.accountingApprove(docId, coordinatorId)).rejects.toThrow(BadRequestException)
    })

    it('aprueba y cambia estado', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'coordinator_approved' })) })
      const updated = makeDoc({ status: 'accounting_approved' })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) })

      const result = await service.accountingApprove(docId, coordinatorId)
      expect(result.status).toBe('accounting_approved')
    })
  })

  describe('accountingReject', () => {
    it('lanza BadRequestException si motivo tiene menos de 50 caracteres', async () => {
      await expect(service.accountingReject(docId, coordinatorId, 'corto')).rejects.toThrow(BadRequestException)
    })

    it('rechaza y cambia estado a rejected', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'coordinator_approved' })) })
      const updated = makeDoc({ status: 'rejected' })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) })

      const reason = 'x'.repeat(50)
      const result = await service.accountingReject(docId, coordinatorId, reason)
      expect(result.status).toBe('rejected')
    })
  })

  describe('registerPayment', () => {
    const dto = {
      transferDate: '2026-05-07T00:00:00.000Z',
      amount: 800,
      operationNumber: 'OP-001',
      receiptUrl: 'https://cdn.example.com/receipt.pdf',
    }

    it('lanza BadRequestException si el estado no permite pago (ej: closed)', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'closed' })) })
      await expect(service.registerPayment(docId, dto, coordinatorId)).rejects.toThrow(BadRequestException)
    })

    it('registra el pago, cambia estado a paid, y notifica al colaborador', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'accounting_approved' })) })
      const updated = makeDoc({ status: 'paid' })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) })

      const result = await service.registerPayment(docId, dto, coordinatorId)
      expect(result.status).toBe('paid')
      expect(mockEmailService.sendReembolsoDirectoPagado).toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('lanza BadRequestException si el estado no es paid', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'accounting_approved' })) })
      await expect(service.close(docId, coordinatorId)).rejects.toThrow(BadRequestException)
    })

    it('cierra el expediente', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc({ status: 'paid' })) })
      const updated = makeDoc({ status: 'closed' })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(updated) })

      const result = await service.close(docId, coordinatorId)
      expect(result.status).toBe('closed')
    })
  })

  describe('addOverrunJustification', () => {
    it('lanza BadRequestException si justificacion tiene menos de 100 caracteres', async () => {
      await expect(service.addOverrunJustification(docId, 'corta', coordinatorId)).rejects.toThrow(BadRequestException)
    })

    it('lanza ForbiddenException si no es el coordinador responsable', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc()) })
      const other = new Types.ObjectId().toString()
      await expect(service.addOverrunJustification(docId, 'x'.repeat(100), other)).rejects.toThrow(ForbiddenException)
    })

    it('actualiza la justificacion de sobreejecucion', async () => {
      mockModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc()) })
      mockModel.findByIdAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeDoc()) })

      await service.addOverrunJustification(docId, 'x'.repeat(100), coordinatorId)

      expect(mockModel.findByIdAndUpdate).toHaveBeenCalledWith(
        docId,
        expect.objectContaining({ $set: expect.objectContaining({ overrunJustification: expect.any(String) }) }),
        { new: true }
      )
    })
  })
})
