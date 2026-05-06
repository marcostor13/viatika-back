import { Test, TestingModule } from '@nestjs/testing'
import { MailerService } from '@nestjs-modules/mailer'
import { EmailService } from './email.service'

describe('EmailService', () => {
  let service: EmailService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: MailerService, useValue: { sendMail: jest.fn() } },
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
})
