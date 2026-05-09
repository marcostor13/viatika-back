import { Test, TestingModule } from '@nestjs/testing'
import { MailerService } from '@nestjs-modules/mailer'
import { EmailService } from './email.service'

describe('EmailService', () => {
  let service: EmailService
  let mailerService: { sendMail: jest.Mock }

  beforeEach(async () => {
    mailerService = { sendMail: jest.fn().mockResolvedValue(undefined) }
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: MailerService, useValue: mailerService },
      ],
    }).compile()
    service = module.get<EmailService>(EmailService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  it('generates a 6-digit code', () => {
    const code = service.getCode()
    expect(code).toMatch(/^\d{6}$/)
  })

  it('sends viatico payment email with receipt attachment', async () => {
    await service.sendViaticoPagoRealizado('colab@test.com', {
      recipientName: 'Colaborador',
      collaboratorName: 'Colaborador',
      coordinatorName: 'Coordinador',
      projectLabel: '[CC-001 - Proyecto Demo]',
      amountFormatted: '120.50',
      transferDate: '2026-05-06',
      reference: 'REF001',
      paymentMethod: 'transferencia_bancaria',
      paymentReceiptUrl: 'https://files.example.com/receipts/viatico-001.pdf',
      paymentReceiptFileName: 'viatico-001.pdf',
      platformUrl: 'https://app.viatica.tecdidata.com',
    })

    expect(mailerService.sendMail).toHaveBeenCalledTimes(1)
    expect(mailerService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'colab@test.com',
        template: './viatico-pago-realizado',
        attachments: [
          expect.objectContaining({
            filename: 'viatico-001.pdf',
            path: 'https://files.example.com/receipts/viatico-001.pdf',
          }),
        ],
      })
    )
  })
})
