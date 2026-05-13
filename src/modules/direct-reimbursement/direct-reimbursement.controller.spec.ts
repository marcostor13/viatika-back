import { Test, TestingModule } from '@nestjs/testing'
import { Types } from 'mongoose'
import { DirectReimbursementController } from './direct-reimbursement.controller'
import { DirectReimbursementService } from './direct-reimbursement.service'
import { AuditLogService } from '../audit-log/audit-log.service'
import { ROLES } from '../auth/enums/roles.enum'

const docId = new Types.ObjectId().toHexString()
const clientId = new Types.ObjectId().toHexString()
const userId = new Types.ObjectId().toHexString()

const makeReq = () => ({
  user: {
    _id: userId,
    sub: userId,
    name: 'Coord',
    email: 'coord@test.com',
    clientId,
    roles: [ROLES.ADMIN],
  },
})

const mockService = {
  create: jest.fn().mockResolvedValue({ _id: docId, status: 'open' }),
  findAllByClient: jest.fn().mockResolvedValue([]),
  findPendingPayments: jest.fn().mockResolvedValue([]),
  findByCoordinator: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue({ _id: docId }),
  addExpense: jest.fn().mockResolvedValue({ _id: docId }),
  removeExpense: jest.fn().mockResolvedValue({ _id: docId }),
  coordinatorApprove: jest.fn().mockResolvedValue({ _id: docId, status: 'coordinator_approved' }),
  accountingApprove: jest.fn().mockResolvedValue({ _id: docId, status: 'accounting_approved' }),
  accountingReject: jest.fn().mockResolvedValue({ _id: docId, status: 'rejected' }),
  registerPayment: jest.fn().mockResolvedValue({ _id: docId, status: 'paid' }),
  close: jest.fn().mockResolvedValue({ _id: docId, status: 'closed' }),
  addOverrunJustification: jest.fn().mockResolvedValue({ _id: docId }),
}

const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) }

describe('DirectReimbursementController', () => {
  let controller: DirectReimbursementController

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DirectReimbursementController],
      providers: [
        { provide: DirectReimbursementService, useValue: mockService },
        { provide: AuditLogService, useValue: mockAuditLogService },
      ],
    }).compile()
    controller = module.get<DirectReimbursementController>(DirectReimbursementController)
  })

  describe('create', () => {
    it('crea el reembolso directo y registra auditoria', async () => {
      const req = makeReq()
      const dto: any = { clientId, justification: 'j', estimatedAmount: 500 }
      const result = await controller.create(dto, req as never)
      expect(mockService.create).toHaveBeenCalledWith(
        expect.objectContaining({ clientId, collaboratorId: userId }),
        userId
      )
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create_reembolso_directo' })
      )
      expect(result).toBeDefined()
    })
  })

  describe('findAllByClient', () => {
    it('delega al servicio con clientId', async () => {
      await controller.findAllByClient(clientId)
      expect(mockService.findAllByClient).toHaveBeenCalledWith(clientId)
    })
  })

  describe('findPendingPayments', () => {
    it('delega al servicio con clientId', async () => {
      await controller.findPendingPayments(clientId)
      expect(mockService.findPendingPayments).toHaveBeenCalledWith(clientId)
    })
  })

  describe('findMyExpedients', () => {
    it('extrae coordinatorId del JWT y delega al servicio', async () => {
      const req = makeReq()
      await controller.findMyExpedients(clientId, req as never)
      expect(mockService.findByCoordinator).toHaveBeenCalledWith(userId, clientId)
    })
  })

  describe('findOne', () => {
    it('delega al servicio con el id', async () => {
      await controller.findOne(docId)
      expect(mockService.findOne).toHaveBeenCalledWith(docId)
    })
  })

  describe('addExpense', () => {
    it('delega al servicio', async () => {
      await controller.addExpense(docId, { expenseId: 'exp1' })
      expect(mockService.addExpense).toHaveBeenCalledWith(docId, 'exp1')
    })
  })

  describe('removeExpense', () => {
    it('delega al servicio', async () => {
      await controller.removeExpense(docId, { expenseId: 'exp1' })
      expect(mockService.removeExpense).toHaveBeenCalledWith(docId, 'exp1')
    })
  })

  describe('coordinatorApprove', () => {
    it('aprueba como coordinador y registra auditoria', async () => {
      const req = makeReq()
      const result = await controller.coordinatorApprove(docId, req as never)
      expect(mockService.coordinatorApprove).toHaveBeenCalledWith(docId, userId)
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'coordinator_approve_reembolso_directo' })
      )
      expect(result).toBeDefined()
    })
  })

  describe('accountingApprove', () => {
    it('aprueba como contabilidad y registra auditoria', async () => {
      const req = makeReq()
      const result = await controller.accountingApprove(docId, req as never)
      expect(mockService.accountingApprove).toHaveBeenCalledWith(docId, userId)
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'accounting_approve_reembolso_directo' })
      )
      expect(result).toBeDefined()
    })
  })

  describe('accountingReject', () => {
    it('rechaza con razon y registra auditoria', async () => {
      const req = makeReq()
      const result = await controller.accountingReject(docId, { reason: 'No aprobado' }, req as never)
      expect(mockService.accountingReject).toHaveBeenCalledWith(docId, userId, 'No aprobado')
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'accounting_reject_reembolso_directo' })
      )
      expect(result).toBeDefined()
    })
  })

  describe('registerPayment', () => {
    it('registra el pago y registra auditoria', async () => {
      const req = makeReq()
      const dto: any = { amount: 500, transferDate: '2026-05-01', operationNumber: 'OP-1', receiptUrl: 'url' }
      const result = await controller.registerPayment(docId, dto, req as never)
      expect(mockService.registerPayment).toHaveBeenCalledWith(docId, dto, userId)
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'pay_reembolso_directo' })
      )
      expect(result).toBeDefined()
    })
  })

  describe('close', () => {
    it('cierra el expediente y registra auditoria', async () => {
      const req = makeReq()
      const result = await controller.close(docId, req as never)
      expect(mockService.close).toHaveBeenCalledWith(docId, userId)
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'close_reembolso_directo' })
      )
      expect(result).toBeDefined()
    })
  })

  describe('addOverrunJustification', () => {
    it('agrega la justificacion de sobreejecucion', async () => {
      const req = makeReq()
      await controller.addOverrunJustification(
        docId,
        { justification: 'Justificacion extensa y detallada' },
        req as never
      )
      expect(mockService.addOverrunJustification).toHaveBeenCalledWith(
        docId,
        'Justificacion extensa y detallada',
        userId
      )
    })
  })
})
