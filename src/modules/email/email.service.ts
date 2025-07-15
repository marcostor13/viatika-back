import { Injectable, Logger } from '@nestjs/common'
import { MailerService } from '@nestjs-modules/mailer'

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name)

  constructor(private readonly mailerService: MailerService) {}

  getCode() {
    const code = Math.floor(100000 + Math.random() * 900000).toString()
    return code
  }

  async sendCodeConfirmation(email: string) {
    try {
      this.logger.debug(`Enviando código de confirmación a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Confirma tu correo en Nuestra App',
        template: './confirmation', // se añade automáticamente la extensión (.hbs)
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          verificationCode: this.getCode(),
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(
        `Código de confirmación enviado exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar código de confirmación a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendInvoiceNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de factura a ${email}`, data)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Nueva Factura Subida',
        template: './invoice-notification',
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(
        `Notificación de factura enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de factura a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendPaymentScheduledNotification(
    email: string,
    invoiceNumber: string,
    paymentDate: string
  ) {
    await this.mailerService.sendMail({
      to: email,
      subject: 'Pago Programado',
      template: './payment-scheduled',
      context: {
        logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
        invoiceNumber,
        paymentDate,
        year: new Date().getFullYear(),
      },
    })
  }

  async sendAccountingDecisionNotification(
    email: string,
    invoiceNumber: string,
    decision: 'approved' | 'rejected',
    reason?: string
  ) {
    await this.mailerService.sendMail({
      to: email,
      subject: `Factura ${decision === 'approved' ? 'Aprobada' : 'Rechazada'}`,
      template: './accounting-decision',
      context: {
        logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
        invoiceNumber,
        decisionText: decision === 'approved' ? 'Aprobada' : 'Rechazada',
        reason,
        year: new Date().getFullYear(),
      },
    })
  }

  async sendActaNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de acta a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Acta de Aceptación Subida',
        template: './acta-notification',
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(`Notificación de acta enviada exitosamente a ${email}`)
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de acta a ${email}:`,
        error
      )
      throw error
    }
  }

  async sendInvoiceUploadedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: Date
      type: string
      createdBy?: string
      razonSocial?: string
      montoTotal?: number
      moneda?: string
      status?: string
      showAdditionalInfo?: boolean
      category?: string
      projectName?: string
      direccionEmisor?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de factura subida a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject:
          'Nueva factura subida por ' + (data.createdBy || data.providerName),
        template: './invoice-notification',
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date:
            data.date instanceof Date
              ? data.date.toLocaleDateString()
              : data.date,
          type: data.type,
          createdBy: data.createdBy || data.providerName,
          year: new Date().getFullYear(),
          razonSocial: data.razonSocial,
          montoTotal: data.montoTotal,
          moneda: data.moneda,
          status: data.status,
          showAdditionalInfo: data.showAdditionalInfo,
          category: data.category,
          projectName: data.projectName,
          direccionEmisor: data.direccionEmisor,
        },
      })
      this.logger.debug(
        `Notificación de factura enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(`Error al enviar notificación a ${email}:`, error)
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendActaUploadedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: Date
      type: string
      createdBy?: string
      razonSocial?: string
      montoTotal?: number
      moneda?: string
      status?: string
      showAdditionalInfo?: boolean
      category?: string
      projectName?: string
      direccionEmisor?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de acta subida a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject:
          'Acta de aprobación subida por ' +
          (data.createdBy || data.providerName),
        template: './acta-notification',
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date:
            data.date instanceof Date
              ? data.date.toLocaleDateString()
              : data.date,
          type: data.type,
          createdBy: data.createdBy || data.providerName,
          year: new Date().getFullYear(),
          razonSocial: data.razonSocial,
          montoTotal: data.montoTotal,
          moneda: data.moneda,
          status: data.status,
          showAdditionalInfo: data.showAdditionalInfo,
          category: data.category,
          projectName: data.projectName,
          direccionEmisor: data.direccionEmisor,
        },
      })
      this.logger.debug(`Notificación de acta enviada exitosamente a ${email}`)
    } catch (error) {
      this.logger.error(`Error al enviar notificación a ${email}:`, error)
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceUploadedExpenseNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      status: string
      montoTotal: number
      moneda: string
      createdBy?: string
      category?: string
      projectName?: string
      razonSocial?: string
      direccionEmisor?: string
    }
  ) {
    try {
      this.logger.debug(`Enviando notificación de factura de gastos a ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject:
          'Nueva factura de gastos subida por ' +
          (data.createdBy || data.providerName),
        template: './invoice-notification',
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          status: data.status,
          montoTotal: data.montoTotal,
          moneda: data.moneda,
          createdBy: data.createdBy || data.providerName,
          year: new Date().getFullYear(),
          category: data.category || 'No especificada',
          projectName: data.projectName || 'No especificado',
          razonSocial: data.razonSocial || 'No especificada',
          direccionEmisor: data.direccionEmisor,
          showAdditionalInfo: true,
        },
      })
      this.logger.debug(
        `Notificación de factura enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(`Error al enviar notificación a ${email}:`, error)
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceApprovedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      approvedBy?: string
    }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Factura Aprobada',
        template: 'invoice-approved',
        context: {
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          approvedBy: data.approvedBy || 'Administrador del sistema',
        },
      })
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de factura aprobada: ${error.message}`
      )
      throw error
    }
  }

  async sendInvoiceRejectedNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      rejectionReason: string
      rejectedBy?: string
    }
  ) {
    try {
      await this.mailerService.sendMail({
        to: email,
        subject: 'Factura Rechazada',
        template: 'invoice-rejected',
        context: {
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          rejectionReason: data.rejectionReason,
          rejectedBy: data.rejectedBy || 'Administrador del sistema',
        },
      })
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de factura rechazada: ${error.message}`
      )
      throw error
    }
  }

  async sendInvoiceDecisionNotification(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      status: 'APPROVED' | 'REJECTED'
      rejectionReason?: string
    }
  ) {
    try {
      this.logger.debug(
        `[DEBUG] Enviando notificación de decisión de factura a ${email}`,
        data
      )

      await this.mailerService.sendMail({
        to: email,
        subject: `Factura ${data.status === 'APPROVED' ? 'Aprobada para Pago' : 'Rechazada para Pago'}`,
        template: 'invoice-decision',
        context: {
          providerName: data.providerName,
          invoiceNumber: data.invoiceNumber,
          date: data.date,
          type: data.type,
          status: data.status,
          rejectionReason: data.rejectionReason,
          // Agregar helper para comparación de strings en el template
          eq: (a: string, b: string) => a === b,
        },
      })

      this.logger.debug(
        `[DEBUG] Notificación de decisión enviada exitosamente a ${email}`
      )
    } catch (error) {
      this.logger.error(
        `[DEBUG] Error al enviar notificación de decisión a ${email}: ${error.message}`,
        error.stack
      )
      throw error
    }
  }

  async sendProviderWelcomeEmail(
    email: string,
    data: {
      firstName: string
      lastName: string
      password: string
      loginUrl: string
    }
  ) {
    try {
      this.logger.debug(`Enviando correo de bienvenida a proveedor: ${email}`)
      await this.mailerService.sendMail({
        to: email,
        subject: 'Bienvenido a Nuestra Plataforma de Proveedores',
        template: './provider-welcome',
        context: {
          logoUrl: 'https://eventuz.com/assets/images/logo1.svg',
          firstName: data.firstName,
          lastName: data.lastName,
          email: email,
          password: data.password,
          loginUrl: data.loginUrl,
          year: new Date().getFullYear(),
        },
      })
      this.logger.debug(`Correo de bienvenida enviado exitosamente a ${email}`)
    } catch (error) {
      this.logger.error(
        `Error al enviar correo de bienvenida a ${email}:`,
        error
      )
      throw error
    }
  }

  // Métodos específicos para la notificación a roles ADMIN2 y COLABORADOR
  async sendInvoiceCreatedToAdmin2(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      status: string
      montoTotal: number
      moneda: string
      createdBy?: string
    }
  ) {
    try {
      this.logger.debug(
        `Enviando notificación de factura creada a admin2 ${email}`
      )
      await this.sendInvoiceUploadedExpenseNotification(email, data)
      this.logger.debug(
        `Notificación de factura creada enviada exitosamente a admin2 ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación a admin2 ${email}:`,
        error
      )
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceApprovedToColaborador(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      approvedBy?: string
    }
  ) {
    try {
      this.logger.debug(
        `Enviando notificación de factura aprobada a colaborador ${email}`
      )
      await this.sendInvoiceApprovedNotification(email, data)
      this.logger.debug(
        `Notificación de factura aprobada enviada exitosamente a colaborador ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de aprobación a colaborador ${email}:`,
        error
      )
      // No lanzamos el error para no interrumpir el flujo
    }
  }

  async sendInvoiceRejectedToColaborador(
    email: string,
    data: {
      providerName: string
      invoiceNumber: string
      date: string
      type: string
      rejectionReason: string
      rejectedBy?: string
    }
  ) {
    try {
      this.logger.debug(
        `Enviando notificación de factura rechazada a colaborador ${email}`
      )
      await this.sendInvoiceRejectedNotification(email, data)
      this.logger.debug(
        `Notificación de factura rechazada enviada exitosamente a colaborador ${email}`
      )
    } catch (error) {
      this.logger.error(
        `Error al enviar notificación de rechazo a colaborador ${email}:`,
        error
      )
      // No lanzamos el error para no interrumpir el flujo
    }
  }
}
