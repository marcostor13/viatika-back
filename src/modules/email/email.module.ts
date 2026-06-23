import { Module, Logger } from '@nestjs/common'
import { EmailService } from './email.service'
import { EmailController } from './email.controller'
import { MailerModule } from '@nestjs-modules/mailer'
import { MongooseModule } from '@nestjs/mongoose'
import { join } from 'path'
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter'
import { Client, ClientSchema } from '../client/entities/client.entity'

const SMTP_PROVIDERS: Record<string, object> = {
  gmail: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.USER_EMAIL,
      pass: process.env.PASSWORD_EMAIL,
    },
  },
  outlook: {
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.USER_EMAIL,
      pass: process.env.PASSWORD_EMAIL,
    },
    tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
  },
}

@Module({
  imports: [
    MailerModule.forRootAsync({
      useFactory: () => {
        const provider = (process.env.EMAIL_PROVIDER ?? 'gmail').toLowerCase()
        const transport = SMTP_PROVIDERS[provider] ?? SMTP_PROVIDERS['gmail']
        const logger = new Logger('EmailModule')
        logger.log(`Proveedor SMTP: ${provider}`)
        return {
          transport,
          defaults: {
            from: process.env.USER_EMAIL,
          },
          template: {
            dir: join(process.cwd(), 'src/modules/email/templates'),
            adapter: new HandlebarsAdapter(),
            options: {
              strict: true,
            },
          },
        }
      },
    }),
    MongooseModule.forFeature([{ name: Client.name, schema: ClientSchema }]),
  ],
  controllers: [EmailController],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
