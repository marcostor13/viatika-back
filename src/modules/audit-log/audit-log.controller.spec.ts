import { Test, TestingModule } from '@nestjs/testing'
import { Types } from 'mongoose'
import { AuditLogController } from './audit-log.controller'
import { AuditLogService } from './audit-log.service'

const clientId = new Types.ObjectId().toHexString()

const mockAuditLogService = {
  findAll: jest
    .fn()
    .mockResolvedValue({ data: [], total: 0, page: 1, pages: 0, limit: 20 }),
  log: jest.fn().mockResolvedValue(undefined),
}

describe('AuditLogController', () => {
  let controller: AuditLogController

  beforeEach(async () => {
    jest.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditLogController],
      providers: [{ provide: AuditLogService, useValue: mockAuditLogService }],
    }).compile()
    controller = module.get<AuditLogController>(AuditLogController)
  })

  describe('findAll', () => {
    it('delega al servicio con el clientId del JWT', async () => {
      const req = { user: { clientId } }
      const result = await controller.findAll(
        req as never,
        '1',
        '20',
        'usuarios',
        undefined
      )
      expect(mockAuditLogService.findAll).toHaveBeenCalledWith(clientId, {
        page: 1,
        limit: 20,
        module: 'usuarios',
        search: undefined,
      })
      expect(result).toBeDefined()
    })

    it('usa valores por defecto si no se pasan parametros', async () => {
      const req = { user: { clientId } }
      await controller.findAll(
        req as never,
        undefined,
        undefined,
        undefined,
        undefined
      )
      expect(mockAuditLogService.findAll).toHaveBeenCalledWith(clientId, {
        page: 1,
        limit: 20,
        module: undefined,
        search: undefined,
      })
    })

    it('pasa el parametro de busqueda al servicio', async () => {
      const req = { user: { clientId } }
      await controller.findAll(req as never, '2', '10', undefined, 'juan')
      expect(mockAuditLogService.findAll).toHaveBeenCalledWith(clientId, {
        page: 2,
        limit: 10,
        module: undefined,
        search: 'juan',
      })
    })
  })

  describe('reportExportFailure', () => {
    const req = {
      user: {
        _id: 'user-1',
        name: 'Christian Carrasco',
        email: 'cc@tema.com',
        clientId,
      },
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; Safari/605.1)' },
      ip: '190.1.2.3',
    }

    it('registra el fallo con la accion y el modulo fijados por el servidor', async () => {
      const result = await controller.reportExportFailure(req as never, {
        reportId: '6a638a92cac6e5e0c3699221',
        reportCode: 'RD-0046',
        attachments: [
          {
            label: 'FT',
            url: 'https://tema-images.s3.us-east-2.amazonaws.com/foto.jpeg',
            reason: 'descarga: TypeError: Failed to fetch',
          },
        ],
      })

      expect(result).toEqual({ registered: 1 })
      const logged = mockAuditLogService.log.mock.calls[0][0]
      expect(logged.action).toBe('export_pdf_attachment_failed')
      expect(logged.module).toBe('rendiciones')
      expect(logged.userId).toBe('user-1')
      expect(logged.userName).toBe('Christian Carrasco')
      expect(logged.clientId).toBe(clientId)
      expect(logged.entityId).toBe('6a638a92cac6e5e0c3699221')
      // El detalle debe bastar para diagnosticar sin pedirle nada al usuario.
      expect(logged.details).toContain('RD-0046')
      expect(logged.details).toContain('Failed to fetch')
      expect(logged.details).toContain('foto.jpeg')
      expect(logged.details).toContain('Safari')
    })

    it('resume varios adjuntos fallidos en un solo registro', async () => {
      const attachments = ['a.jpeg', 'b.jpeg', 'c.jpeg'].map(f => ({
        label: 'FT',
        url: `https://tema-images.s3.us-east-2.amazonaws.com/${f}`,
        reason: 'descarga bloqueada o sin respuesta',
      }))
      const result = await controller.reportExportFailure(req as never, {
        reportId: '6a638a92cac6e5e0c3699221',
        attachments,
      })
      expect(result).toEqual({ registered: 3 })
      expect(mockAuditLogService.log).toHaveBeenCalledTimes(1)
      expect(mockAuditLogService.log.mock.calls[0][0].details).toContain(
        '3 adjunto(s)'
      )
    })
  })
})
